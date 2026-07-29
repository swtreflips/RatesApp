-- Local development fixtures. Loaded automatically by `supabase db reset`; never runs
-- against production.
--
-- The point of this file is the SECOND organization. An isolation test with one tenant is
-- vacuous -- "the forwarder sees their own rows" passes trivially when there are no other
-- rows to leak. Two forwarders plus an internal user is the smallest fixture that can
-- actually fail, and HUB2's Phase D isolation tests depend on it.
--
-- Deterministic UUIDs so tests can reference them directly.

-- ── organizations ────────────────────────────────────────────────────────────
-- NOTE: the expand migration's backfill cannot help here. Migrations run BEFORE seed.sql,
-- so at that point these rows do not exist yet. In production the backfill works, because
-- the forwarders are already there. Locally the fixture has to be written post-expand.
--
-- forwarders rows are kept alongside with IDENTICAL ids: RatesApp still reads forwarder_id
-- until HUB2's contract phase drops it.
insert into public.organizations (id, name, type, code, active) values
  ('00000000-0000-0000-0000-000000000001', 'Prime Time Packaging', 'internal',  'PT', true),
  ('11111111-1111-1111-1111-111111111111', 'Acme Forwarding',      'forwarder', 'AF', true),
  ('22222222-2222-2222-2222-222222222222', 'Beta Logistics',       'forwarder', 'BL', true),
  -- three factories for the planner. Two would do for isolation; three matches the
  -- intended mock onboarding.
  ('33333333-3333-3333-3333-333333333333', 'Ditar S.A',            'supplier',  'DT', true),
  ('44444444-4444-4444-4444-444444444444', 'Tejaswi Papers',       'supplier',  'TP', true),
  ('55555555-5555-5555-5555-555555555555', 'Manchester Paper Bags','supplier',  'MP', true)
on conflict do nothing;

insert into public.forwarders (id, name, active) values
  ('11111111-1111-1111-1111-111111111111', 'Acme Forwarding',   true),
  ('22222222-2222-2222-2222-222222222222', 'Beta Logistics',    true)
on conflict do nothing;

insert into public.forwarder_services (forwarder_id, service, active) values
  ('11111111-1111-1111-1111-111111111111', 'ocean',   true),
  ('11111111-1111-1111-1111-111111111111', 'drayage', true),
  ('22222222-2222-2222-2222-222222222222', 'drayage', true)
on conflict do nothing;

-- ── auth users ───────────────────────────────────────────────────────────────
-- profiles.id references auth.users(id), so the users must exist first. Password for
-- all three is 'password123' -- local only, and this file never reaches production.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin
) values
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'authenticated', 'authenticated', 'internal@ptp.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'authenticated', 'authenticated', 'acme@forwarder.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'authenticated', 'authenticated', 'beta@forwarder.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false),
  -- the three factory logins for the planner
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'authenticated', 'authenticated', 'ditar@factory.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'authenticated', 'authenticated', 'tejaswi@factory.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
   'authenticated', 'authenticated', 'manchester@factory.test',
   crypt('password123', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}', false)
on conflict do nothing;

-- ── profiles — the only source of identity ───────────────────────────────────
-- Note the internal user has NO forwarder_id, so my_org() returns NULL for them. Every
-- isolation policy must fail closed on that null rather than treating it as a wildcard.
insert into public.profiles (id, role, forwarder_id, organization_id, full_name, org_role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'internal',  null,
   '00000000-0000-0000-0000-000000000001', 'Internal Planner', 'admin'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'forwarder', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', 'Acme Analyst', 'member'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'forwarder', '22222222-2222-2222-2222-222222222222',
   '22222222-2222-2222-2222-222222222222', 'Beta Analyst', 'member'),
  -- factory users for the planner. role stays 'forwarder' only because profiles.role's
  -- check has not been widened; organizations.type is what actually classifies them, and
  -- my_org_type() reads that.
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'forwarder', null,
   '33333333-3333-3333-3333-333333333333', 'Ditar Merchandiser', 'admin'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'forwarder', null,
   '44444444-4444-4444-4444-444444444444', 'Tejaswi Merchandiser', 'member'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'forwarder', null,
   '55555555-5555-5555-5555-555555555555', 'Manchester Merchandiser', 'member')
on conflict do nothing;

-- ── ports + schedules fixtures ───────────────────────────────────────────────
-- geom is filled by trg_set_geom from lat/lon; the schedules trigger then resolves port
-- NAMES into geography, so this exercises both triggers on every reset.
insert into public.world_ports (canonical_name, name, latitude, longitude, type, country_code) values
  ('long beach', 'Long Beach', 33.7690, -118.1916, 'port',   'US'),
  ('phoenix',    'Phoenix',    33.4484, -112.0740, 'inland', 'US'),
  ('shanghai',   'Shanghai',   31.2304,  121.4737, 'port',   'CN')
on conflict (canonical_name) do nothing;

insert into public.schedules
  (schedule_hash, carrier_code, carrier_name, port_of_loading, port_of_discharge,
   last_cy, query_date, etd, eta, transit_time_days)
values
  ('seed-hash-001', 'TEST', 'Test Carrier', 'shanghai', 'long beach',
   'phoenix', now(), current_date + 2, current_date + 20, 18),
  ('seed-hash-002', 'TEST', 'Test Carrier', 'shanghai', 'long beach',
   'long beach', now(), current_date + 5, current_date + 24, 19)
on conflict (schedule_hash) do nothing;

-- vessels and sea_routes exist so the isolation test can actually FAIL on them. With these
-- tables empty, "a forwarder sees 0 rows" is indistinguishable from "there was nothing to
-- see" -- a column that always reads zero proves nothing.
insert into public.sched_vessels (vessel_id, carrier_name, marinetraffic_name, marinetraffic_url) values
  (100001, 'Test Carrier', 'TEST VESSEL ONE', 'https://example.test/v/100001'),
  (100002, 'Test Carrier', 'TEST VESSEL TWO', 'https://example.test/v/100002')
on conflict (vessel_id) do nothing;

insert into public.sea_routes (origin_port, destination_port, route_geom, geojson, distance_km, duration_hours) values
  ('shanghai', 'long beach',
   st_geomfromtext('LINESTRING(121.4737 31.2304, -118.1916 33.7690)', 4326),
   '{"type":"LineString"}'::jsonb, 10500, 480)
on conflict (origin_port, destination_port) do nothing;

refresh materialized view public.schedules_latest;
