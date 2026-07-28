# MIGRATION_INVENTORY — what is actually in both databases

Introspected **2026-07-27** via the Supabase Management API
(`POST /v1/projects/{ref}/database/query`), against the live databases — not from documentation
and not from a code grep, both of which proved incomplete.

Source: **`jnuigkggmynerrbxvkzy`** (Schedules) · Target: **`sfozxpibfpqsdlxoheyl`** (Rates)

This is the checklist [MIGRATION.md](MIGRATION.md) Phase 2 and Phase 3 are written against.
Re-run the same queries after the rebuild and diff — that is the proof, not "the migration ran".

---

## Headlines

Four things the planning documents got wrong or missed entirely.

| # | Finding | Consequence |
|---|---|---|
| 1 | **A `routes` table exists** — 180 rows, `geometry(LineString,4326)` | In no doc, found by no grep. It is the only **geometry** (not geography) and the only **LineString** in the estate. Declaring it geography or Point would silently break it |
| 2 | **`nearby_schedules`, `distinct_pols`, `nearest_ports`, `is_near` are SECURITY INVOKER**, not DEFINER | MIGRATION.md Phase 3 said they bypass RLS and need internal checks in their bodies. **They do not.** Enabling RLS is sufficient — this makes Phase 3 simpler |
| 3 | **`anon` holds DELETE / TRUNCATE / UPDATE on every schedules table**, and RLS is off everywhere | HUB2 described a read leak. It is worse: with RLS off, the grants permit **destructive writes**. Harmless today (internal-only project) — catastrophic the moment these tables sit beside partner accounts |
| 4 | **Only one name collides**: `geocode_cache` | And it is already excluded — the brain owns the geocode cache. `schedules`, `ports`, `vessels`, `routes`, `schedules_latest` are all free in the target |

> On #3, for calibration: **rates grants the same broad privileges to `anon` on all 18 of its
> tables.** That is Supabase's default posture — grants are wide, RLS is the gate. The finding is
> not that the grants are unusual; it is that **schedules has no RLS at all**, so nothing is
> holding the gate once the project boundary disappears.

---

## Source — `jnui…` (Schedules)

### Tables

| Table | Rows | Notes |
|---|---:|---|
| `schedules` | 40,218 | warehouse, 26 cols, 6 JSONB, 3 geography |
| `schedules_latest` | 6,059 | **materialized view** |
| `vessels` | 1,491 | |
| `ports` | 598 | global, 15 cols |
| **`routes`** | **180** | **undocumented** |
| `geocode_cache` | 93 | Render service's cache — **does not migrate** |
| `spatial_ref_sys` | 8,500 | PostGIS internal |

### Column detail

```
schedules (26)
  id uuid NOT NULL · schedule_hash text · schema_version integer
  carrier_code text · carrier_name text
  query_date timestamptz · snapshot_date date
  port_of_loading text · port_of_discharge text · last_cy text
  cutoff_date date · etd date · eta date · pod_eta date
  transit_time_days integer · transport_type text · mother_vessel text
  ts_ports jsonb · ts_vessels jsonb · route_ports jsonb
  vessel_sequence jsonb · route_metadata jsonb · raw_schedule jsonb
  pol_geom     geography(Point,4326)
  pod_geom     geography(Point,4326)
  last_cy_geom geography(Point,4326)

ports (15)
  id uuid NOT NULL · source_id bigint · canonical_name text · name text
  unlocode text · type text · size text
  latitude double precision · longitude double precision
  timezone integer          ← integer, not text
  country_code text · country_name text · state_code text
  geom geography(Point,4326)
  metadata jsonb            ← add_port.py's `relations` lands here; there is no
                              `relations` column, contrary to an earlier claim

vessels (6)
  vessel_id bigint NOT NULL · carrier_name text NOT NULL
  marinetraffic_name text NOT NULL · marinetraffic_url text
  aliases jsonb · created_at timestamptz

routes (7)                  ← UNDOCUMENTED
  origin_port text NOT NULL · destination_port text NOT NULL
  route_geom  geometry(LineString,4326)   ← geometry, NOT geography. LineString, NOT Point
  geojson jsonb NOT NULL
  distance_km numeric · duration_hours numeric · generated_at timestamptz
```

### Constraints — the upsert keys

```
schedules      PRIMARY KEY (id)              UNIQUE (schedule_hash)     ← on_conflict target
ports          PRIMARY KEY (id)              UNIQUE (canonical_name)
vessels        PRIMARY KEY (vessel_id)                                  ← on_conflict target
routes         PRIMARY KEY (origin_port, destination_port)
geocode_cache  PRIMARY KEY (query)
```

### Indexes

```
schedules         idx_schedules_carrier · idx_schedules_eta · idx_schedules_etd
                  idx_schedules_last_cy · idx_schedules_pol
                  idx_schedules_last_cy_geom · idx_schedules_pod_geom · idx_schedules_pol_geom
                  schedules_lane_recency_idx
schedules_latest  schedules_latest_hash_idx   ← the unique index REFRESH CONCURRENTLY needs
ports             ports_canonical_name_lower_idx · unique_canonical_name
routes            (primary key only — no spatial index on route_geom)
geocode_cache     geocode_cache_geom_idx (GiST)
```

> **`ports` has no GiST index on `geom`**, yet `nearest_ports` runs a distance query against it.
> 598 rows, so it has never mattered. Worth adding while replicating.

### Functions — app-level

| Function | Returns | `SECURITY DEFINER` | `search_path` |
|---|---|---|---|
| `refresh_schedules_latest()` | void | **yes** | *not set* |
| `nearby_schedules(p_pol, p_lat, p_lon, …)` | `SETOF schedules_latest` | no | — |
| `nearest_ports(in_lat, in_lon, …)` | `TABLE(canonical_name, unlocode, …)` | no | — |
| `distinct_pols()` | `SETOF text` | no | — |
| `is_near(in_lat, in_lon, …)` | boolean | no | — |
| `geocode_cache_set_geom()` | trigger | no | — |
| `set_schedule_geoms()` | trigger | no | — |

> `refresh_schedules_latest` is `SECURITY DEFINER` **with no `search_path` set**. That is a
> privilege-escalation shape; set `search_path = public` when replicating it.

### Triggers

```
schedules       trg_set_schedule_geoms       → set_schedule_geoms
geocode_cache   trg_geocode_cache_set_geom   → geocode_cache_set_geom
```

**No trigger on `ports`** — `ports.geom` is not maintained automatically. Replicating as-is
means `geom` stays null on insert unless `add_port.py` writes it or a trigger is added.

### Security posture

```
RLS enabled:  NONE   (schedules, ports, vessels, routes, geocode_cache — all false)
Policies:     0
Grants:       anon AND authenticated hold
              SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
              on every table
```

### Extensions

`postgis 3.3.7` · `uuid-ossp 1.1` · `pgcrypto 1.3` · `supabase_vault 0.3.1` ·
`pg_stat_statements 1.11` · `plpgsql 1.0`

---

## Target — `sfoz…` (Rates)

18 tables: `rates`, `rate_request_batches`, `rate_request_lanes`, `rate_submissions`,
`drayage_rates`, `drayage_rate_benchmarks`, `drayage_request_lanes`, `drayage_submissions`,
`drayage_routes`, `forwarders`, `forwarder_services`, `profiles`, `notifications`,
`notification_recipients`, `graph_credentials`, `geocode_cache`, `us_ports`, `spatial_ref_sys`.

**39 policies · RLS enabled on all 18 · 3 triggers · PostGIS 3.3.7 — same version as source.**

App-level functions, all `SECURITY DEFINER` with `search_path` set (the correct shape):

```
cache_within_miles(a, b, miles)        my_forwarder()
current_role_is(target)                get_forwarder_recipients(uuid[])
get_service_directory(uuid[], text)    get_recipients_by_analyst(uuid[])
set_geom() / set_route_geom()          [triggers, INVOKER — correct for triggers]
```

> `is_near_port` is documented in `SUPA.md` as a companion function. **It does not exist in the
> database.** It was written down but never created.

---

## What this changes in the plan

- [ ] **Replicate `routes`** — absent from every plan. Preserve `geometry(LineString,4326)` exactly
- [ ] **Rename `routes`** on arrival. HUB2's rule is that a table name must be globally unique and
      self-evidently app-scoped; `routes` beside `drayage_routes` is neither. `sea_routes` fits
- [ ] **Drop the SECURITY DEFINER audit from Phase 3** — the RPCs are INVOKER, so RLS covers them
- [ ] **`nearby_schedules` returns `SETOF schedules_latest`.** Once the MV is locked and wrapped in
      `schedules_latest_secure`, this function must be repointed at the view or it will raise
      *permission denied* instead of returning zero rows
- [ ] **Revoke the write grants**, not just gate reads. `INSERT/UPDATE/DELETE/TRUNCATE` to `anon`
      on schedules tables must not survive the move
- [ ] Add `search_path = public` to `refresh_schedules_latest`
- [ ] Add a GiST index on `ports.geom`; decide whether `ports` gets a geom trigger
- [ ] `geocode_cache` from schedules **does not migrate** — the brain owns it (93 rows, disposable)
