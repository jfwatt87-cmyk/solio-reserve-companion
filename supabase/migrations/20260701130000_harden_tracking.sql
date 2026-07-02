-- =============================================================================
-- Solio Reserve — Tracking hardening (peer-review backlog, 2026-07-01)
--
-- Addresses: #1 position insert hardening (timestamp/rate/bounds),
--            #2 server-side geofence (PostGIS), #4 immutable consent events,
--            #5 retention finalised, #3 guest-safe rhino access (server-side).
--
-- NOTE: authored, NOT yet run. Requires a live project with PostGIS available
-- (Supabase: `postgis` in the `extensions` schema) and pg_cron enabled for the
-- retention schedule. Verify with `get_advisors` after applying.
-- =============================================================================

create extension if not exists postgis;   -- geofence geometry / geography

-- ---------------------------------------------------------------------------
-- 1. positions: bounds + a server-clock receipt column
-- ---------------------------------------------------------------------------
alter table public.positions
  add column if not exists inserted_at timestamptz not null default now();  -- server clock (tamper-proof)

create index if not exists positions_user_inserted_idx on public.positions (user_id, inserted_at desc);

-- Coordinate sanity as immutable CHECKs.
alter table public.positions
  drop constraint if exists positions_lat_range,
  drop constraint if exists positions_lng_range,
  drop constraint if exists positions_accuracy_nonneg;
alter table public.positions
  add constraint positions_lat_range      check (lat between -90 and 90),
  add constraint positions_lng_range      check (lng between -180 and 180),
  add constraint positions_accuracy_nonneg check (accuracy_m is null or accuracy_m >= 0);

-- ---------------------------------------------------------------------------
-- 2. Geofence — guests are tracked only inside the reserve (+ modest buffer)
--    The boundary polygon is loaded later from Callan's GIS data. Until an
--    ACTIVE row exists the trigger is a no-op (documented gap in the backlog).
-- ---------------------------------------------------------------------------
create table if not exists public.reserve_geofence (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  geom     geometry(MultiPolygon, 4326) not null,
  buffer_m integer not null default 250,   -- D8: very modest
  active   boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.reserve_geofence enable row level security;

create policy "geofence_staff_read"
on public.reserve_geofence for select to authenticated
using ( (select private.current_role()) in ('guide', 'ranger', 'manager') );

create policy "geofence_manager_manage"
on public.reserve_geofence for all to authenticated
using      ( (select private.current_role()) = 'manager' )
with check ( (select private.current_role()) = 'manager' );

grant select, insert, update, delete on public.reserve_geofence to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Position validation trigger — timestamp sanity, rate limit, geofence,
--    and forcing the server-clock column. Runs BEFORE INSERT.
--    search_path locked to the schemas we own; all refs fully qualified.
-- ---------------------------------------------------------------------------
create or replace function private.validate_position()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Server clock is authoritative and not client-settable.
  new.inserted_at := now();

  -- Device timestamp: default to now, reject future/very-stale (offline sync ok).
  if new.recorded_at is null then new.recorded_at := now(); end if;
  if new.recorded_at > now() + interval '5 minutes' then
    raise exception 'recorded_at is in the future';
  end if;
  if new.recorded_at < now() - interval '14 days' then
    raise exception 'recorded_at is older than the retention window';
  end if;

  -- Gentle rate limit: at most one fix per user per second (spam guard; live
  -- tracking cadence is several seconds so this does not impede real use).
  if exists (
    select 1 from public.positions p
    where p.user_id = new.user_id
      and p.inserted_at > now() - interval '1 second'
  ) then
    raise exception 'rate limit: position updates too frequent';
  end if;

  -- Geofence: if an active boundary is configured, the point must be inside it
  -- (or within buffer_m outside). No active boundary => not yet enforced.
  if exists (select 1 from public.reserve_geofence g where g.active) then
    if not exists (
      select 1 from public.reserve_geofence g
      where g.active
        and extensions.st_dwithin(
              (g.geom)::extensions.geography,
              (extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326))::extensions.geography,
              g.buffer_m
            )
    ) then
      raise exception 'position is outside the reserve geofence';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists positions_validate on public.positions;
create trigger positions_validate
  before insert on public.positions
  for each row execute function private.validate_position();

-- ---------------------------------------------------------------------------
-- 4. Consent as an immutable, append-only event log (not just a boolean)
-- ---------------------------------------------------------------------------
create table if not exists public.consent_events (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  action         text not null check (action in ('grant', 'withdraw')),
  policy_version text not null,
  created_at     timestamptz not null default now()
);
create index if not exists consent_events_user_idx on public.consent_events (user_id, created_at desc);
alter table public.consent_events enable row level security;

-- Users log their own consent; staff can read for audit. No UPDATE/DELETE
-- policies anywhere => the log is immutable to every client.
create policy "consent_insert_own"
on public.consent_events for insert to authenticated
with check ( user_id = (select auth.uid()) );

create policy "consent_select_own_or_staff"
on public.consent_events for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.current_role()) in ('ranger', 'manager')
);

grant select, insert on public.consent_events to authenticated;  -- no update/delete

-- Keep profiles.tracking_consent in sync from the log (the boolean becomes a
-- derived cache; the events are the record of truth).
create or replace function private.apply_consent_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles
     set tracking_consent = (new.action = 'grant'),
         consent_at       = case when new.action = 'grant' then new.created_at else null end
   where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists consent_apply on public.consent_events;
create trigger consent_apply
  after insert on public.consent_events
  for each row execute function private.apply_consent_event();

-- Lock direct edits of the consent fields on profiles: they may now change ONLY
-- via the consent_events flow (the trigger above, which bypasses RLS). Replace
-- the self-update policy to pin consent columns to their committed values.
create or replace function private.current_consent()    returns boolean
  language sql stable security definer set search_path = ''
  as $$ select tracking_consent from public.profiles where id = (select auth.uid()) $$;
create or replace function private.current_consent_at() returns timestamptz
  language sql stable security definer set search_path = ''
  as $$ select consent_at from public.profiles where id = (select auth.uid()) $$;
revoke all on function private.current_consent()    from public, anon, authenticated;
revoke all on function private.current_consent_at() from public, anon, authenticated;
grant execute on function private.current_consent()    to authenticated;
grant execute on function private.current_consent_at() to authenticated;

drop policy if exists "profiles_update_own_no_escalation" on public.profiles;
create policy "profiles_update_own_no_escalation"
on public.profiles for update to authenticated
using ( id = (select auth.uid()) )
with check (
  id = (select auth.uid())
  and role       =            (select private.current_role())      -- no self-escalation
  and vehicle_id is not distinct from (select private.current_vehicle())
  and tracking_consent =      (select private.current_consent())    -- consent only via events
  and consent_at is not distinct from (select private.current_consent_at())
);

-- ---------------------------------------------------------------------------
-- 5. Retention — finalise on the server clock and schedule if pg_cron is on
-- ---------------------------------------------------------------------------
create or replace function private.purge_old_positions(retention interval default interval '14 days')
returns integer
language plpgsql security definer set search_path = ''
as $$
declare deleted integer;
begin
  delete from public.positions where inserted_at < now() - retention;  -- server clock
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
revoke all on function private.purge_old_positions(interval) from public, anon, authenticated;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and not exists (select 1 from cron.job where jobname = 'purge-old-positions') then
    perform cron.schedule(
      'purge-old-positions', '0 3 * * *',
      $cron$ select private.purge_old_positions(interval '14 days'); $cron$
    );
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 6. #3 — guest-safe rhino access, computed SERVER-SIDE
--    Precise data (rhino_sightings) stays ranger/manager-only. Everyone else
--    may call this function, which returns only COARSE, DELAYED, de-identified
--    presence — never a precise point or per-animal identity.
--
--    Grid-quantisation (not random jitter) is deliberate: a fixed grid is stable
--    across samples, so it cannot be averaged out. Delay avoids "live". This is a
--    STARTING POINT aligned with the security memo and still needs a dedicated
--    security review before it faces the public (distance-oracle risk, zone size,
--    delay length, per-session salt). See Rhino Location Security.md.
-- ---------------------------------------------------------------------------
create or replace function public.rhino_presence_safe(
  grid_deg double precision default 0.02,      -- ~2 km cells at this latitude
  delay    interval         default interval '6 hours'
)
returns table (zone_lat double precision, zone_lng double precision, last_seen_bucket timestamptz)
language sql stable security definer set search_path = ''
as $$
  select
    round((lat / grid_deg))::double precision * grid_deg as zone_lat,
    round((lng / grid_deg))::double precision * grid_deg as zone_lng,
    date_trunc('hour', max(recorded_at))                 as last_seen_bucket
  from public.rhino_sightings
  where recorded_at < now() - delay        -- never live
  group by 1, 2                            -- aggregate to zone; drop rhino_ref (de-identify)
$$;
comment on function public.rhino_presence_safe is
  'Guest-safe, coarse+delayed+de-identified rhino presence. NOT precise. Needs security review before public use.';
-- Callable by authenticated (the safe endpoint); precise table stays locked.
revoke all on function public.rhino_presence_safe(double precision, interval) from public, anon;
grant execute on function public.rhino_presence_safe(double precision, interval) to authenticated;
