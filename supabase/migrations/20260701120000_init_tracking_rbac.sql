-- =============================================================================
-- Solio Reserve — Live Tracking & RBAC — initial schema
-- Backend: Supabase (Postgres + Realtime + Row-Level Security)
--
-- Design: Solio Vault/Design/Live Tracking & RBAC.md, Roles & Permissions.md,
--         Tracking Lifecycle.md, Rhino Location Security.md
--
-- Security posture:
--   * RLS enabled on every table.
--   * Role is read from public.profiles via a SECURITY DEFINER helper in a
--     PRIVATE (non-exposed) schema — never from user-editable user_metadata.
--   * The hard rule (Rhino Location Security): guests/guides get NO policy on
--     rhino_sightings, so their queries return nothing — the data is unreachable,
--     not merely hidden in the UI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Private schema for authorization helpers (NOT exposed via the Data API)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Role enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('guest', 'guide', 'ranger', 'manager');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------

-- 3.1 vehicles ---------------------------------------------------------------
create table if not exists public.vehicles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3.2 profiles (extends auth.users) -----------------------------------------
create table if not exists public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  role             public.user_role not null default 'guest',   -- least-privilege default
  display_name     text,
  vehicle_id       uuid references public.vehicles (id) on delete set null,
  tracking_consent boolean not null default false,              -- guest must opt in
  consent_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists profiles_vehicle_id_idx on public.profiles (vehicle_id);

-- 3.3 positions (live stream + retained history) ----------------------------
--     vehicle_id is set ONLY for per-vehicle staff/guide devices. Guest phones
--     report with vehicle_id = null; their vehicle assignment lives on profiles.
create table if not exists public.positions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  vehicle_id  uuid references public.vehicles (id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  real,
  heading     real,
  recorded_at timestamptz not null default now()
);
create index if not exists positions_user_recorded_idx on public.positions (user_id, recorded_at desc);
create index if not exists positions_vehicle_idx        on public.positions (vehicle_id) where vehicle_id is not null;
create index if not exists positions_recorded_idx       on public.positions (recorded_at);

-- 3.4 rhino_sightings (SENSITIVE — ranger/manager only) ---------------------
create table if not exists public.rhino_sightings (
  id          bigint generated always as identity primary key,
  rhino_ref   text,
  lat         double precision not null,
  lng         double precision not null,
  source      text,
  recorded_at timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null
);
create index if not exists rhino_sightings_recorded_idx on public.rhino_sightings (recorded_at);
comment on table public.rhino_sightings is
  'SENSITIVE: precise rhino positions. Ranger/manager only. Never expose to guest/guide roles or the public.';

-- 3.5 alerts (safety / SOS) --------------------------------------------------
create table if not exists public.alerts (
  id         bigint generated always as identity primary key,
  raised_by  uuid not null references public.profiles (id) on delete cascade,
  lat        double precision,
  lng        double precision,
  type       text not null default 'sos',      -- 'sos' | 'breakdown' | ...
  status     text not null default 'open',     -- 'open' | 'ack' | 'resolved'
  created_at timestamptz not null default now()
);
create index if not exists alerts_status_idx    on public.alerts (status);
create index if not exists alerts_raised_by_idx on public.alerts (raised_by);

-- ---------------------------------------------------------------------------
-- 4. Authorization helpers
--    SECURITY DEFINER so they read role/vehicle bypassing RLS (no recursion),
--    but they only ever return the CALLER's own role/vehicle. Locked search_path.
--    Kept in the private schema and un-granted to anon so they are not a public API.
-- ---------------------------------------------------------------------------
create or replace function private.current_role()
returns public.user_role
language sql stable security definer set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid());
$$;

create or replace function private.current_vehicle()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select vehicle_id from public.profiles where id = (select auth.uid());
$$;

revoke all on function private.current_role()    from public, anon, authenticated;
revoke all on function private.current_vehicle() from public, anon, authenticated;
grant execute on function private.current_role()    to authenticated;  -- needed inside RLS
grant execute on function private.current_vehicle() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Auto-create a profile when a new auth user signs up (incl. anonymous)
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
  on conflict (id) do nothing;   -- role defaults to 'guest'
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- 6. Enable Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.vehicles        enable row level security;
alter table public.profiles        enable row level security;
alter table public.positions       enable row level security;
alter table public.rhino_sightings enable row level security;
alter table public.alerts          enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Policies
--    (Helper calls are wrapped in (select ...) so Postgres caches them once
--     per statement instead of per row.)
-- ---------------------------------------------------------------------------

-- 7.1 profiles ---------------------------------------------------------------
create policy "profiles_select_own_staff_or_guide_guests"
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or (select private.current_role()) in ('ranger', 'manager')
  or ((select private.current_role()) = 'guide' and vehicle_id = (select private.current_vehicle()))
);

-- A user may edit their own profile but NOT change their role or vehicle
-- (both would be privilege changes). WITH CHECK compares the NEW row to the
-- committed OLD values returned by the helpers.
create policy "profiles_update_own_no_escalation"
on public.profiles for update to authenticated
using ( id = (select auth.uid()) )
with check (
  id = (select auth.uid())
  and role       =            (select private.current_role())
  and vehicle_id is not distinct from (select private.current_vehicle())
);

-- Managers can do anything to any profile (incl. assigning roles/vehicles).
create policy "profiles_manager_all"
on public.profiles for all to authenticated
using      ( (select private.current_role()) = 'manager' )
with check ( (select private.current_role()) = 'manager' );

-- 7.2 positions --------------------------------------------------------------
create policy "positions_insert_own_with_consent"
on public.positions for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.tracking_consent
  )
  -- Prevent vehicle_id spoofing (peer review, 2026-07-01): a guest can only
  -- report vehicle_id = null; a staff/guide device may only stamp the vehicle
  -- it is actually assigned to. Closes the guide-visibility leak path.
  and (
    vehicle_id is null
    or (
      (select private.current_role()) in ('guide', 'ranger', 'manager')
      and vehicle_id = (select private.current_vehicle())
    )
  )
);

create policy "positions_select_role_scoped"
on public.positions for select to authenticated
using (
  user_id = (select auth.uid())                                       -- always see self
  or (select private.current_role()) in ('ranger', 'manager')         -- staff see all
  or (
    (select private.current_role()) = 'guide'
    and (
      vehicle_id is not null                                          -- other vehicles (spacing)
      or user_id in (                                                 -- own guests
        select p.id from public.profiles p
        where p.vehicle_id = (select private.current_vehicle())
      )
    )
  )
);
-- No UPDATE/DELETE policies: history is immutable to clients. Purge runs via
-- the SECURITY DEFINER job in section 9.

-- 7.3 rhino_sightings (the hard line) ---------------------------------------
-- Single FOR ALL policy: ranger/manager get full access; everyone else gets
-- NO policy at all, so guests/guides cannot select, insert, update or delete.
create policy "rhino_ranger_manager_only"
on public.rhino_sightings for all to authenticated
using      ( (select private.current_role()) in ('ranger', 'manager') )
with check ( (select private.current_role()) in ('ranger', 'manager') );

-- 7.4 alerts -----------------------------------------------------------------
create policy "alerts_insert_own"
on public.alerts for insert to authenticated
with check ( raised_by = (select auth.uid()) );

create policy "alerts_select_own_guide_guests_or_staff"
on public.alerts for select to authenticated
using (
  raised_by = (select auth.uid())
  or (select private.current_role()) in ('ranger', 'manager')
  or (
    (select private.current_role()) = 'guide'
    and raised_by in (
      select p.id from public.profiles p
      where p.vehicle_id = (select private.current_vehicle())
    )
  )
);

create policy "alerts_update_staff"
on public.alerts for update to authenticated
using      ( (select private.current_role()) in ('ranger', 'manager') )
with check ( (select private.current_role()) in ('ranger', 'manager') );

-- 7.5 vehicles ---------------------------------------------------------------
create policy "vehicles_staff_read"
on public.vehicles for select to authenticated
using ( (select private.current_role()) in ('guide', 'ranger', 'manager') );

create policy "vehicles_manager_manage"
on public.vehicles for all to authenticated
using      ( (select private.current_role()) = 'manager' )
with check ( (select private.current_role()) = 'manager' );

-- ---------------------------------------------------------------------------
-- 8. Table privileges + Realtime
--    RLS filters rows; these GRANTs are what make the tables reachable at all.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.vehicles, public.positions,
  public.rhino_sightings, public.alerts
to authenticated;
-- (No grants to anon: every user must be authenticated, anonymous sign-in included.)

-- Broadcast live rows. Realtime honours RLS for postgres_changes, so subscribers
-- only receive rows their role is allowed to SELECT.
alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.alerts;

-- ---------------------------------------------------------------------------
-- 9. Retention (D9: ~2 weeks, exact number TBD) — Tracking Lifecycle.md
--    Purge guest position history beyond the retention window. Requires pg_cron.
-- ---------------------------------------------------------------------------
create or replace function private.purge_old_positions(retention interval default interval '14 days')
returns integer
language plpgsql security definer set search_path = ''
as $$
declare deleted integer;
begin
  delete from public.positions where recorded_at < now() - retention;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
revoke all on function private.purge_old_positions(interval) from public, anon, authenticated;

-- Enable pg_cron in the dashboard, then schedule daily at 03:00:
-- select cron.schedule('purge-old-positions', '0 3 * * *',
--   $$ select private.purge_old_positions(interval '14 days'); $$);

-- ---------------------------------------------------------------------------
-- 10. Geofence (Tracking Lifecycle.md) — DEFERRED
--     Guests are tracked only within a modest geofence of the reserve. Primary
--     enforcement is client-side (the device reports only while inside). Once
--     Callan supplies the reserve boundary we can add a server-side CHECK that
--     rejects positions outside the fence (needs PostGIS + the boundary polygon).
-- ---------------------------------------------------------------------------
