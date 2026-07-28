-- Schedules schema, replicated from the `jnui…` project into rates.
-- MIGRATION.md Phase 2. Written from MIGRATION_INVENTORY.md — introspected from the live
-- source database, not from documentation, which omitted three of these objects.
--
-- STRUCTURE ONLY. No data comes across: schedules re-scrape, vessels re-push, ports re-seed
-- from portdbCanonical.json. See MIGRATION.md.
--
-- Two deliberate differences from the source, both recorded in MIGRATION_INVENTORY.md:
--   * `routes` arrives as `sea_routes`. A bare `routes` beside the existing `drayage_routes`
--     is neither globally unique nor self-evidently app-scoped (HUB2's naming rule).
--     polylines/push_routes.py must be updated: TABLE = "sea_routes".
--   * `ports` gains a geom trigger and a GiST index. The source has neither, so ports.geom
--     depends on whatever last wrote it — and nearest_ports/is_near/set_schedule_geoms all
--     read it. Reuses the target's existing set_geom().
--
-- NOT replicated: the source's own `geocode_cache`. The brain owns the geocode cache and it
-- already exists here.

create extension if not exists postgis;

-- ─────────────────────────────────────────────────────────────────────────────
-- ports — global port reference, 592 rows at source.
-- Kept SEPARATE from us_ports: HUB2 claims they share a structure, they do not.
-- This is global with nine columns us_ports lacks; us_ports is US-only and read
-- only by the brain. See MIGRATION_INVENTORY.md.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ports (
  id             uuid primary key default gen_random_uuid(),
  source_id      bigint,
  canonical_name text,
  name           text,
  unlocode       text,
  type           text,
  size           text,
  latitude       double precision,
  longitude      double precision,
  timezone       integer,                    -- integer, not text
  country_code   text,
  country_name   text,
  state_code     text,
  geom           geography(Point, 4326),     -- set by trigger (see below)
  metadata       jsonb,
  constraint unique_canonical_name unique (canonical_name)
);

-- set_schedule_geoms matches on LOWER(TRIM(canonical_name)); this index backs it.
create index if not exists ports_canonical_name_lower_idx
  on public.ports using btree (lower(trim(both from canonical_name)));

-- Absent at source, yet nearest_ports and is_near both run distance queries here.
-- 598 rows, so it has never mattered — it will.
create index if not exists ports_geom_idx on public.ports using gist (geom);

-- Reuses the target's existing set_geom(): NEW.geom from NEW.longitude/latitude.
-- The source has no such trigger, so a re-seed there would leave geom null.
drop trigger if exists trg_set_geom on public.ports;
create trigger trg_set_geom before insert or update on public.ports
  for each row execute function public.set_geom();

-- ─────────────────────────────────────────────────────────────────────────────
-- vessels — MarineTraffic identity map. push_vessels.py upserts on vessel_id.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.vessels (
  vessel_id          bigint primary key,     -- on_conflict target
  carrier_name       text not null,
  marinetraffic_name text not null,
  marinetraffic_url  text,
  aliases            jsonb default '[]'::jsonb,
  created_at         timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- sea_routes — was `routes` at source. Sea-route polylines, 180 rows.
--
-- The ONLY geometry (not geography) and the ONLY LineString in this database.
-- Declaring it geography or Point would appear to work and silently corrupt the
-- geometry — the same class of bug SUPA.md §1 documents.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.sea_routes (
  origin_port      text not null,
  destination_port text not null,
  route_geom       geometry(LineString, 4326),
  geojson          jsonb not null,
  distance_km      numeric,
  duration_hours   numeric,
  generated_at     timestamptz default now(),
  primary key (origin_port, destination_port)   -- push_routes.py's on_conflict target
);

-- ─────────────────────────────────────────────────────────────────────────────
-- schedules — the warehouse. Every snapshot ever; hybrid relational + JSONB.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.schedules (
  id                uuid primary key default gen_random_uuid(),
  schedule_hash     text unique,              -- ingest_schedules.py's on_conflict target
  schema_version    integer default 1,
  carrier_code      text,
  carrier_name      text,
  query_date        timestamptz,
  snapshot_date     date,
  port_of_loading   text,
  port_of_discharge text,
  last_cy           text,
  cutoff_date       date,
  etd               date,
  eta               date,
  pod_eta           date,
  transit_time_days integer,
  transport_type    text,
  mother_vessel     text,
  ts_ports          jsonb,
  ts_vessels        jsonb,
  route_ports       jsonb,
  vessel_sequence   jsonb,
  route_metadata    jsonb,
  raw_schedule      jsonb,
  pol_geom          geography(Point, 4326),   -- all three set by trigger
  pod_geom          geography(Point, 4326),
  last_cy_geom      geography(Point, 4326)
);

create index if not exists idx_schedules_carrier      on public.schedules using btree (carrier_code);
create index if not exists idx_schedules_eta          on public.schedules using btree (eta);
create index if not exists idx_schedules_etd          on public.schedules using btree (etd);
create index if not exists idx_schedules_last_cy      on public.schedules using btree (last_cy);
create index if not exists idx_schedules_pol          on public.schedules using btree (port_of_loading);
create index if not exists idx_schedules_pol_geom     on public.schedules using gist (pol_geom);
create index if not exists idx_schedules_pod_geom     on public.schedules using gist (pod_geom);
create index if not exists idx_schedules_last_cy_geom on public.schedules using gist (last_cy_geom);

-- Backs the materialized view's latest-per-lane grouping.
create index if not exists schedules_lane_recency_idx
  on public.schedules using btree (carrier_code, port_of_loading, last_cy, query_date desc);

-- Fills the three geography columns by matching port names against `ports`.
-- Note ST_MakePoint(lon, lat) inside set_geom — longitude first. This function reads
-- `ports`, never us_ports.
create or replace function public.set_schedule_geoms()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select p.geom into new.pol_geom from ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.port_of_loading)) limit 1;

  select p.geom into new.pod_geom from ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.port_of_discharge)) limit 1;

  select p.geom into new.last_cy_geom from ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.last_cy)) limit 1;

  return new;
end;
$$;

drop trigger if exists trg_set_schedule_geoms on public.schedules;
create trigger trg_set_schedule_geoms before insert or update on public.schedules
  for each row execute function public.set_schedule_geoms();

-- ─────────────────────────────────────────────────────────────────────────────
-- schedules_latest — latest snapshot per (carrier, POL, last CY) within 5 days.
-- Recreated from its definition, never dumped: an MV's query cannot be altered in place.
-- ─────────────────────────────────────────────────────────────────────────────
drop materialized view if exists public.schedules_latest;

create materialized view public.schedules_latest as
  with latest as (
    select carrier_code, port_of_loading, last_cy, max(query_date) as latest_query_date
      from schedules
     where query_date >= (now() - '5 days'::interval)
     group by carrier_code, port_of_loading, last_cy
  )
  select s.id, s.schedule_hash, s.schema_version, s.carrier_code, s.carrier_name,
         s.query_date, s.snapshot_date, s.port_of_loading, s.port_of_discharge, s.last_cy,
         s.cutoff_date, s.etd, s.eta, s.pod_eta, s.transit_time_days, s.transport_type,
         s.mother_vessel, s.ts_ports, s.ts_vessels, s.route_ports, s.vessel_sequence,
         s.route_metadata, s.raw_schedule, s.pol_geom, s.pod_geom, s.last_cy_geom
    from schedules s
    join latest l
      on s.carrier_code    = l.carrier_code
     and s.port_of_loading = l.port_of_loading
     and s.last_cy         = l.last_cy
     and s.query_date      = l.latest_query_date;

-- REQUIRED for REFRESH ... CONCURRENTLY. Without it every ingest takes an exclusive
-- lock on the view the React app is reading.
create unique index if not exists schedules_latest_hash_idx
  on public.schedules_latest using btree (schedule_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- Functions. All SECURITY INVOKER except refresh_schedules_latest, matching the
-- source — so RLS applies to them and no in-body identity check is needed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Called by ingest over RPC, holding the service key. DEFINER at source but with NO
-- search_path set, which is a privilege-escalation shape; pinned here.
create or replace function public.refresh_schedules_latest()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently schedules_latest;
end;
$$;

create or replace function public.nearby_schedules(
  p_pol text, p_lat double precision, p_lon double precision, p_radius_meters double precision)
returns setof public.schedules_latest
language sql
stable
set search_path = public
as $$
  select s.*
    from schedules_latest s
   where s.port_of_loading = p_pol
     and s.last_cy_geom is not null
     and st_dwithin(s.last_cy_geom,
                    st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
                    p_radius_meters)
   order by s.eta asc;
$$;

create or replace function public.nearest_ports(
  in_lat double precision, in_lon double precision,
  in_limit integer default 1, in_types text[] default null)
returns table(canonical_name text, unlocode text, type text,
              latitude double precision, longitude double precision,
              distance_km double precision, distance_miles double precision)
language sql
stable
set search_path = public
as $$
  select p.canonical_name, p.unlocode, p.type, p.latitude, p.longitude,
         st_distance(p.geom::geography,
                     st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography) / 1000.0   as distance_km,
         st_distance(p.geom::geography,
                     st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography) / 1609.344 as distance_miles
    from ports p
   where p.geom is not null
     and (in_types is null or p.type = any (in_types))
   order by distance_km
   limit in_limit;
$$;

create or replace function public.distinct_pols()
returns setof text
language sql
stable
set search_path = public
as $$
  select distinct port_of_loading
    from schedules_latest
   where port_of_loading is not null
   order by 1;
$$;

create or replace function public.is_near(
  in_lat double precision, in_lon double precision,
  in_port text, in_threshold_miles double precision default 50)
returns boolean
language sql
stable
set search_path = public
as $$
  select st_dwithin(p.geom::geography,
                    st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
                    in_threshold_miles * 1609.344)   -- miles → meters
    from ports p
   where p.canonical_name = in_port
   limit 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Security. Enabled here, not in Phase 3, so these tables are never readable in
-- this project even briefly. RLS with no policies denies everything; service_role
-- bypasses it, so ingest keeps working. Policies land in Phase 3.
--
-- The grants matter independently: RLS governs SELECT/INSERT/UPDATE/DELETE but
-- NOT TRUNCATE, so a table left with the default broad grant is truncatable by any
-- role holding it regardless of policy. Revoked rather than inherited.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ports      enable row level security;
alter table public.vessels    enable row level security;
alter table public.sea_routes enable row level security;
alter table public.schedules  enable row level security;

revoke all on public.ports      from anon, authenticated;
revoke all on public.vessels    from anon, authenticated;
revoke all on public.sea_routes from anon, authenticated;
revoke all on public.schedules  from anon, authenticated;

-- The materialized view cannot hold RLS at all — Postgres refuses a policy on one.
-- Locked here; Phase 3 exposes it through a guarded view.
revoke all on public.schedules_latest from anon, authenticated;
