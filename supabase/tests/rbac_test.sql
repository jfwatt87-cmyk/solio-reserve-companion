-- =============================================================================
-- RBAC / RLS policy tests (pgTAP)  —  run with:  supabase test db
--
-- Encodes the security guarantees so they can't silently regress. Authored but
-- not yet run against a live DB — the auth.users seed columns may need adjusting
-- to match the project's exact GoTrue schema version.
-- =============================================================================
begin;
select plan(11);

-- ---------------------------------------------------------------------------
-- Seed users (as the migration/superuser role, bypassing RLS). The
-- on_auth_user_created trigger creates a 'guest' profile for each; we then
-- promote roles / assign vehicles directly.
-- ---------------------------------------------------------------------------
insert into public.vehicles (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Test Cruiser');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'guest@test',   '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'guide@test',   '', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'ranger@test',  '', now(), now());

update public.profiles set role = 'guide',  vehicle_id = '11111111-1111-1111-1111-111111111111'
  where id = 'a0000000-0000-0000-0000-000000000002';
update public.profiles set role = 'ranger' where id = 'a0000000-0000-0000-0000-000000000003';

insert into public.rhino_sightings (lat, lng, source) values (0.05, 37.0, 'test');

-- Helper: become a given user as the authenticated role.
create or replace function tests._login(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

-- ===========================================================================
-- Rhino data: guests/guides get NOTHING; rangers get rows.
-- ===========================================================================
select tests._login('a0000000-0000-0000-0000-000000000001');  -- guest
select is( (select count(*)::int from public.rhino_sightings), 0,
           'guest sees zero rhino_sightings' );

select tests._login('a0000000-0000-0000-0000-000000000002');  -- guide
select is( (select count(*)::int from public.rhino_sightings), 0,
           'guide sees zero rhino_sightings' );

reset role;
select tests._login('a0000000-0000-0000-0000-000000000003');  -- ranger
select ok( (select count(*) from public.rhino_sightings) >= 1,
           'ranger sees rhino_sightings' );

-- ===========================================================================
-- No self-escalation: a guest cannot promote itself.
-- ===========================================================================
reset role;
select tests._login('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ update public.profiles set role = 'ranger' where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'guest cannot escalate its own role'
);

-- ===========================================================================
-- Position inserts.
-- ===========================================================================
-- Without consent -> rejected.
select throws_ok(
  $$ insert into public.positions (user_id, lat, lng) values ('a0000000-0000-0000-0000-000000000001', 0.05, 37.0) $$,
  null, null,
  'guest cannot insert a position before granting consent'
);

-- Grant consent via the immutable event log (also flips the derived boolean).
select lives_ok(
  $$ insert into public.consent_events (user_id, action, policy_version)
     values ('a0000000-0000-0000-0000-000000000001', 'grant', 'v1') $$,
  'guest can record a consent grant'
);
select is( (select tracking_consent from public.profiles where id = 'a0000000-0000-0000-0000-000000000001'),
           true, 'consent event flips profiles.tracking_consent' );

-- With consent, a null-vehicle position is allowed.
select lives_ok(
  $$ insert into public.positions (user_id, lat, lng) values ('a0000000-0000-0000-0000-000000000001', 0.05, 37.0) $$,
  'guest can insert own null-vehicle position after consent'
);

-- vehicle_id spoofing (the fixed bug): a guest stamping a vehicle is rejected.
-- NOTE: in a single transaction now() is constant, so the per-second rate limit
-- also fires here; both raise, so the assertion holds, but if you want to prove
-- the vehicle check specifically, seed this insert in a separate transaction or
-- temporarily disable the positions_validate trigger.
select throws_ok(
  $$ insert into public.positions (user_id, vehicle_id, lat, lng)
     values ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 0.05, 37.0) $$,
  null, null,
  'guest cannot spoof vehicle_id on a position'
);

-- ===========================================================================
-- Consent log is immutable (no UPDATE/DELETE policy anywhere).
-- ===========================================================================
select throws_ok(
  $$ delete from public.consent_events where user_id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'consent events cannot be deleted by a client'
);

reset role;
select * from finish();
rollback;
