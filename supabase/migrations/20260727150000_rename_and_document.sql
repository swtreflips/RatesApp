-- Table naming and ownership. HUB2.md "Organizing tables in one database".
--
-- Three apps share this database. They are kept apart by NAMING and OWNERSHIP, not by
-- Postgres schemas -- decision 7. A schema would buy visible separation at the cost of
-- .schema('x') on every supabase-js call, explicit API exposure, and awkward PostgREST
-- embedding across every cross-app join. The prefix IS the namespace.
--
-- THE RULE FOR A NEW TABLE: its name must be globally unique and self-evidently
-- app-scoped. `schedules`, `schedules_latest`, `sea_routes`, `drayage_rates` pass.
-- `ports`, `vessels`, `routes`, `items` do not.
--
-- Two tables arrived in Phase 2 failing that rule. Renamed now because nothing reads them
-- yet and both are empty -- after Phase 4 repoints the scrapers, a rename means
-- coordinating a migration with three scripts and a React app.
--
--   ports   → world_ports    sat beside us_ports with no way to tell them apart. They are
--                            different things: global with rich metadata, versus US-only
--                            for the brain's proximity checks. SHARED REFERENCE data, so
--                            it takes no app prefix -- it pairs with us_ports.
--   vessels → sched_vessels  a MarineTraffic identity map used only by the schedules
--                            pipeline. App-private, so it takes the prefix.

alter table public.ports   rename to world_ports;
alter table public.vessels rename to sched_vessels;

-- Renaming a table does NOT rename its indexes, constraints or policies. Left alone they
-- keep the old name and become the next person's puzzle.
alter table public.world_ports   rename constraint ports_pkey            to world_ports_pkey;
alter table public.world_ports   rename constraint unique_canonical_name to world_ports_canonical_name_key;
alter table public.sched_vessels rename constraint vessels_pkey          to sched_vessels_pkey;

alter index public.ports_canonical_name_lower_idx rename to world_ports_canonical_name_lower_idx;
alter index public.ports_geom_idx                 rename to world_ports_geom_idx;

alter policy ports_internal_read   on public.world_ports   rename to world_ports_internal_read;
alter policy vessels_internal_read on public.sched_vessels rename to sched_vessels_internal_read;

-- A LANGUAGE sql function body is stored as TEXT and resolved at execution, so a table
-- rename silently breaks every function that names it -- at runtime, not at rename time.
-- These three read the old `ports`.
create or replace function public.set_schedule_geoms()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select p.geom into new.pol_geom from world_ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.port_of_loading)) limit 1;

  select p.geom into new.pod_geom from world_ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.port_of_discharge)) limit 1;

  select p.geom into new.last_cy_geom from world_ports p
   where lower(trim(p.canonical_name)) = lower(trim(new.last_cy)) limit 1;

  return new;
end;
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
    from world_ports p
   where p.geom is not null
     and (in_types is null or p.type = any (in_types))
   order by distance_km
   limit in_limit;
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
                    in_threshold_miles * 1609.344)
    from world_ports p
   where p.canonical_name = in_port
   limit 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ownership, recorded where people actually look.
--
-- These render in the Supabase dashboard's table editor, so every table says what it
-- belongs to at the moment you are looking at it. They also make HUB2's shared-tables
-- registry a QUERY rather than a document that drifts:
--
--   select relname, obj_description(oid) from pg_class
--    where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
--
-- Convention: OWNER writes it, READ BY consumes it. Before creating any table, check
-- whether an owner already exists for that data.
-- ─────────────────────────────────────────────────────────────────────────────

-- schedules pipeline ─ written by ocean-routing scrapers holding the service key
comment on table public.schedules      is 'SCHEDULES | OWNER: ocean-routing ingest_schedules.py | READ BY: Schedules React, alerts engine | carrier sailing snapshots, every one ever taken';
-- A materialized view is not a table to COMMENT ON, and neither is a view.
comment on materialized view public.schedules_latest is 'SCHEDULES | OWNER: refresh_schedules_latest() | READ BY: via schedules_latest_secure ONLY | cannot hold RLS -- kept locked, grants revoked';
comment on view public.schedules_latest_secure is 'SCHEDULES | OWNER: this migration | READ BY: Schedules React, nearby_schedules, distinct_pols | the guarded door to schedules_latest -- owner-rights view, caller-evaluated WHERE';
comment on table public.world_ports    is 'SHARED REFERENCE | OWNER: Schedules add_port.py | READ BY: schedules triggers, nearest_ports, is_near | GLOBAL port list. Not us_ports, which is US-only and owned by the brain';
comment on table public.sched_vessels  is 'SCHEDULES | OWNER: ocean-routing push_vessels.py | READ BY: alerts engine | MarineTraffic vessel identity map';
comment on table public.sea_routes     is 'SCHEDULES | OWNER: polylines push_routes.py | READ BY: alerts engine, maps | sea-route polylines. The only geometry(LineString) here';

-- geo brain ─ written server-side by geoapi-next holding the service-role key
comment on table public.geocode_cache  is 'SHARED REFERENCE | OWNER: geoapi-next (the brain) | READ BY: brain only | Nominatim geocode cache. One cache for the whole estate -- do not create a second';
comment on table public.drayage_routes is 'SHARED REFERENCE | OWNER: geoapi-next (the brain) | READ BY: brain only | HERE truck-route cache, keyed on the directional city pair';
comment on table public.us_ports       is 'SHARED REFERENCE | OWNER: manual/curated | READ BY: geoapi-next | US ports for proximity checks. See world_ports for the global list';

-- shared identity ─ the only tables every app depends on
comment on table public.profiles       is 'SHARED IDENTITY | OWNER: onboarding | READ BY: EVERY APP + all RLS policies via my_org()/my_org_type() | one row per person. The single source of identity -- never user_metadata';
comment on table public.forwarders     is 'SHARED IDENTITY | OWNER: onboarding | READ BY: RatesApp | becomes organizations(type=forwarder) in the HUB2 expand migration';
comment on table public.forwarder_services is 'SHARED IDENTITY | OWNER: onboarding | READ BY: RatesApp | which services a forwarder quotes';

-- RatesApp ─ ocean freight
comment on table public.rates                 is 'RATES | OWNER: RatesApp | READ BY: RatesApp | submitted ocean rates';
comment on table public.rate_request_batches  is 'RATES | OWNER: RatesApp | READ BY: RatesApp | an RFQ batch';
comment on table public.rate_request_lanes    is 'RATES | OWNER: RatesApp | READ BY: RatesApp | lanes open for quoting';
comment on table public.rate_submissions      is 'RATES | OWNER: RatesApp | READ BY: RatesApp | a forwarder submission event';

-- RatesApp ─ drayage
comment on table public.drayage_rates            is 'DRAYAGE | OWNER: RatesApp | READ BY: RatesApp | submitted drayage rates';
comment on table public.drayage_request_lanes    is 'DRAYAGE | OWNER: RatesApp | READ BY: RatesApp | drayage lanes open for quoting';
comment on table public.drayage_submissions      is 'DRAYAGE | OWNER: RatesApp | READ BY: RatesApp | a drayage submission event';
comment on table public.drayage_rate_benchmarks  is 'DRAYAGE | OWNER: RatesApp | READ BY: RatesApp | benchmark analytics per lane';

-- platform
comment on table public.notifications           is 'PLATFORM | OWNER: notify-forwarders Edge Function | READ BY: RatesApp | outbound notification log';
comment on table public.notification_recipients is 'PLATFORM | OWNER: notify-forwarders Edge Function | READ BY: RatesApp | per-recipient delivery status';
comment on table public.graph_credentials       is 'PLATFORM | OWNER: graph.py | READ BY: graph.py | Microsoft Graph token store';
