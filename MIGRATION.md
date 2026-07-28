# MIGRATION — schedules into rates, and the end of Render

Moving the schedules tables into the rates Supabase project, repointing the Python scrapers,
and retiring the Render FastAPI geocoder in favour of the geo brain.

Companion to [HUB2.md](HUB2.md), which holds the reasoning. This file is the execution order.

---

## What this is

```
BEFORE                                    AFTER
──────                                    ─────
jnui…  schedules, ports, vessels          sfoz…  everything, one project
       schedules_latest (MV), RPCs
                                          geoapi-next   the only geocoder
geoapi-1cu6.onrender.com  FastAPI
       geocode for the React app          (Render deleted)

ocean-routing ──writes──▶ jnui…           ocean-routing ──writes──▶ sfoz…
Schedules/React ──▶ jnui… + Render        Schedules/React ──login──▶ sfoz… + brain
```

**The decisive fact: the data is disposable.** Schedules re-scrape. Vessels re-push. Ports
re-seed from `portdbCanonical.json` / `seattle.json` through `add_port.py`. Nothing needs to
survive the move.

So this is **structure replication, not a data migration**, and most of HUB2's
[folding procedure](HUB2.md#folding-a-supabase-project-into-the-target) collapses:

| HUB2 Phase B step | Here |
|---|---|
| `db dump --data-only`, FK ordering, `COPY` | **dropped** |
| Row-count reconciliation per table | **dropped** |
| 500 MB free-tier sizing | **dropped** — the target starts empty |
| Replicate schema, triggers, indexes, geo columns | **kept — this is the whole job** |
| Re-derive RLS for the new blast radius | **kept — and it is the risky part** |
| Repoint every consumer | **kept** |

What is left is one hard problem and a lot of careful copying. The hard problem is **security**:
a warehouse that was safe in a single-tenant project is readable by every partner in a shared
one.

---

## Decisions (settled)

| # | Decision | Reason |
|---|---|---|
| 1 | **The Schedules React app gets a Supabase login (Google OAuth)** | The only option where the guarantee is enforced by the database rather than maintained by discipline. See below |
| 2 | **`ports` and `us_ports` stay separate** | HUB2 says they share a structure. **They do not.** See below |
| 3 | **Scope is whatever introspection finds** | A code grep already found objects the docs omit. The database is the only authority |

### On decision 1 — why a login, and why not Zero Trust

**Two independent forces demand it.** The table move is only one: even if schedules stayed in
its own project forever, the React app still could not call the geo brain without a credential.
Retiring Render requires solving this regardless of consolidation.

Identity reaches Postgres, so "internal only" is expressible as RLS rather than as a rule the
application code has to keep remembering:

```
browser ──Google, one click──▶ sfoz… session
        ──JWT──▶ nearby_schedules    (RLS: my_org_type() = 'internal')
        ──JWT──▶ brain /api/geocode  (already accepts sfoz… tokens, unchanged)
```

> **Cloudflare Access is not an alternative here.** It protects a *hostname*, not the database.
> Anyone holding the rates anon key — which ships in every RatesApp bundle — can hit
> `sfoz….supabase.co` directly and call the RPCs without ever touching the app, so Access never
> sees them. Zero Trust remains worth having later as a second gate on the *hostname*; it
> cannot be the data boundary.

**The trap in this decision, and it is a real one:** Google OAuth with signups open means
**anyone with a Google account can create a session.** They would get no schedules data — the
`profiles` gate fails closed — but their token still carries `role = 'authenticated'`, which is
exactly what the geo brain accepts. **A stranger could spend your HERE quota by signing in.**

- [ ] **Disable new user signups** in Supabase Auth settings, or restrict to your email domain
      via an auth hook. Internal users are created deliberately — the same rule HUB2 Phase E
      states for partners ("no self-registration"), applied to internal accounts too
- [ ] Verify: sign in with a personal Gmail → must be refused, not merely data-less

### On decision 2 — HUB2 is wrong about this

HUB2 states schedules' `ports` "has the same structure" as rates' `us_ports` and therefore
"does not migrate." Checked against the source:

| | schedules `ports` | rates `us_ports` |
|---|---|---|
| Scope | **global**, 592 rows | US only |
| Columns | `canonical_name`, `country_code`, `country_name`, `state_code`, `unlocode`, `type`, `size`, `relations`, `metadata`, `timezone`, lat/lon | lat/lon, `geom`, name |
| Read by | schedules ingest, alerts, `nearest_ports` | the brain only — **no RatesApp source references it** |

Merging would either drop nine columns or force a US-named table to hold global rows. They come
across as **two tables**, and HUB2's claim gets corrected when this lands.

---

## Verified facts this plan rests on

Established by reading the source, not by assumption:

- `ocean-routing` connects via `supabase-py` `create_client` to `jnui…`. Touches `ports`,
  `schedules`, `schedules_latest`, `vessels`; calls `refresh_schedules_latest` and
  `nearest_ports`.
- **`Schedules/ingest_schedules.py` and `add_port.py` hold a `service_role` key hardcoded in
  source**, valid to 2036. `Schedules` is not a git repository, so it has never been pushed —
  this plan is what would publish it.
- **The React app has no auth of any kind.** `React/src/lib/supabase.ts` uses the anon key
  directly, and the app queries exactly two RPCs: `distinct_pols`, `nearby_schedules`.
- `React/src/lib/geoapi.ts` calls `VITE_GEOAPI_URL` + `/geocode` — the Render service. No
  `/api` prefix, no `Authorization` header.
- **`supabase db reset` fails today.** The six migrations in `supabase/migrations/` do
  `alter table rates …` and `create policy … on drayage_rates`, assuming tables no baseline
  creates. **Nothing below can be verified locally until the baseline exists.**
- Objects the docs never mention, found by grep: a **`vessels`** table, and RPCs
  **`nearest_ports`**, **`nearby_schedules`**, **`distinct_pols`**, **`is_near`**. Assume this
  list is also incomplete — that is what Phase 1 is for.

---

## Phase 0 — Prerequisites (~1.5 hrs)

Blocking. Neither item is optional, and the second is why.

- [ ] **`npx supabase login`** — stores a personal access token. Enables introspection of *both*
      projects via `POST https://api.supabase.com/v1/projects/{ref}/database/query`.
      One token reaches every project you own; this is **not** `link` and creates no second
      migration history — see [link vs login](HUB2.md#what-has-to-be-set-up-first--the-access-prerequisites)
- [ ] **`npx supabase db pull`** → commit the generated baseline. Needs the **database
      password**, a different credential from the access token: Dashboard → Settings → Database
- [ ] **`supabase db reset` succeeds** — proves the target reproduces from migrations alone
      *before* anything is added to it
- [ ] Docker Desktop running (`db reset` requires it)

> Without the baseline, every later phase is untestable. A migration you cannot replay locally
> is a migration you are pushing to production unverified.

---

## Phase 1 — Introspect both projects (~1 hr)

Produces **`MIGRATION_INVENTORY.md`** — the checklist every later phase is verified against, and
HUB2's [step 0a](HUB2.md#0a--inventory-first) for the rates project at the same time.

Run the same query set against **`jnui…`** (source) and **`sfoz…`** (target).

### The query set

```sql
-- 1. extensions (postgis above all — it does not travel in a schema dump)
select extname, extversion from pg_extension order by 1;

-- 2. tables + columns, with the REAL type. geography(Point,4326) vs geometry vs text is
--    the distinction that already cost a day (SUPA.md).
select c.relname as table, a.attname as column,
       format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
       a.attgenerated <> '' as generated, pg_get_expr(d.adbin, d.adrelid) as default
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1, a.attnum;

-- 3. constraints — especially the UNIQUE ones backing every upsert.
--    on_conflict fails without them: schedules.schedule_hash, vessels.vessel_id.
select conrelid::regclass as table, conname, contype,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
order by 1, 2;

-- 4. indexes (GiST spatial ones matter most; so does the MV's unique index)
select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' order by 1, 2;

-- 5. functions — signature, SECURITY DEFINER, search_path, body
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as returns,
       p.prosecdef as security_definer, p.proconfig as config,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 1;

-- 6. triggers and the function each fires
select c.relname as table, t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal order by 1, 2;

-- 7. RLS state + every policy verbatim
select relname as table, relrowsecurity as rls_enabled, relforcerowsecurity as forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;

select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by 1, 2;

-- 8. grants to anon / authenticated — in the target, anon ships in every bundle
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;

-- 9. views and MATERIALIZED views (an MV cannot hold RLS)
select schemaname, matviewname as name, 'materialized' as kind, definition
from pg_matviews where schemaname = 'public'
union all
select schemaname, viewname, 'view', definition
from pg_views where schemaname = 'public' order by 3, 2;

-- 10. row counts (source only — informational; the data is not migrating)
select relname, n_live_tup from pg_stat_user_tables
where schemaname = 'public' order by n_live_tup desc;
```

### What to do with the output

- [ ] Write `MIGRATION_INVENTORY.md` — source and target side by side
- [ ] **Name-collision check**: does rates already hold `ports`, `vessels`, `schedules`, or any
      incoming function name? **Rename in the migration, never afterwards**
- [ ] Flag every object the docs and the grep missed. Expect some
- [ ] Confirm which functions are `SECURITY DEFINER` — those bypass RLS and are Phase 3's
      real problem

---

## Phase 2 — Replicate the structure (~2 hrs)

One migration in `supabase/migrations/`, written **from the inventory**, not from `SUPA.md`.

- [ ] **`create extension if not exists postgis` first**, in the same migration. The geom-filling
      trigger depends on it, and extensions do not travel reliably in a schema dump — import
      first and the trigger creation fails, or the geom columns arrive as a type the project
      does not recognise
- [ ] Tables: `schedules`, `ports`, `vessels`, and **`routes`** — the last found only by
      introspection, absent from every doc and every grep. Preserve its
      `geometry(LineString,4326)`: it is the only **geometry** and the only **LineString** in
      the estate, and declaring it geography or Point would break it silently
- [ ] **Rename `routes` on arrival** — `sea_routes`. Beside `drayage_routes`, a bare `routes` is
      neither globally unique nor self-evidently app-scoped, which is HUB2's naming rule
- [ ] `geocode_cache` from the source **does not migrate** — the brain owns the geocode cache
- [ ] **Geo columns declared `geography(Point,4326)`, never `text`.** A trigger writing a
      geometry into a `text` column *looks* spatial, silently stores hex EWKB, and the GiST
      index fails with `data type text has no default operator class`. This already happened
      once — `SUPA.md` §1 is the record of it
- [ ] GiST index on every geography column
- [ ] The BEFORE trigger filling `pol_geom` / `pod_geom` / `last_cy_geom`, reading **`ports`**,
      not `us_ports` (decision 2). Note `ST_MakePoint(lon, lat)` — longitude first
- [ ] Every unique constraint the upserts depend on — `schedule_hash`, `vessel_id`, the ports key
- [ ] Functions: `refresh_schedules_latest`, `nearest_ports`, `nearby_schedules`,
      `distinct_pols`, `is_near`, and whatever else Phase 1 found. **Preserve `security definer`
      and `set search_path` exactly** — dropping `search_path` on a definer function is a
      privilege-escalation hole
- [ ] **`schedules_latest` recreated, never dumped.** An MV's query cannot be altered in place.
      Recreate its **unique index** too — that index is what makes `REFRESH … CONCURRENTLY`
      possible, and without it every ingest locks the view the React app is reading
- [ ] `supabase db reset` — the whole database rebuilds from migrations alone
- [ ] **Re-run Phase 1's query set against the local rebuild and diff it against the source
      inventory.** A clean diff is the proof. "The migration ran without error" only says the
      SQL parsed

---

## Phase 3 — Re-derive security (~1 hr)

**The step most likely to go wrong, and the one with the worst failure mode.**

Today `schedules` sits alone in a project only internal people hold keys to, so RLS disabled
costs nothing — *the project is the boundary*. In the target that boundary moves down to the
**table**, because `authenticated` now includes forwarders and the anon key ships in every
RatesApp bundle. Carried across unchanged, **every partner could read the entire schedules
warehouse, and so could anyone who pulled the anon key out of a bundle.**

> **"Internal" is not a Postgres role.** Supabase has `anon`, `authenticated`, `service_role` —
> and no "internal". `GRANT … TO authenticated` hands it to partners too. The gate is always a
> predicate over `profiles`, never a role.

- [ ] Enable RLS on `schedules`, `ports`, `vessels`
- [ ] Internal-only read policy. Use `my_org_type() = 'internal'` if the
      [helper facade](HUB2.md#4-the-helper-facade-three-functions) exists by then; otherwise an
      inline predicate over `profiles`, written so it swaps to the helper in one edit
- [ ] **`schedules_latest` cannot hold RLS** — Postgres refuses a policy on a materialized view,
      so its grants are the *only* thing guarding it. `revoke all … from anon, authenticated`,
      then expose a guarded plain view:

```sql
revoke all on schedules_latest from anon, authenticated;

create view schedules_latest_secure as
  select * from schedules_latest where my_org_type() = 'internal';

grant select on schedules_latest_secure to authenticated;
```

  A plain view runs with its owner's rights so it can read the locked MV, while the `where`
  evaluates the **caller's** identity. The app keeps every PostgREST `.eq()` and sort — which
  an RPC would cost.

- [ ] ~~Audit the `SECURITY DEFINER` RPCs~~ — **corrected by introspection.** `nearby_schedules`,
      `distinct_pols`, `nearest_ports` and `is_near` are all `SECURITY INVOKER`, so they respect
      RLS and need no changes to their bodies. Only `refresh_schedules_latest` is `DEFINER`, and
      it is called by ingest holding the service key. See
      [MIGRATION_INVENTORY.md](MIGRATION_INVENTORY.md)
- [ ] **Repoint `nearby_schedules` at `schedules_latest_secure`.** It returns
      `SETOF schedules_latest`; once the MV is locked, an INVOKER function reading it raises
      *permission denied* rather than returning zero rows
- [ ] **Revoke the write grants, not only the reads.** In the source, `anon` and `authenticated`
      hold `INSERT, UPDATE, DELETE, TRUNCATE` on every table, with **no RLS at all**. Read
      exposure is the smaller half — carried across unchanged, any partner could truncate the
      warehouse
- [ ] Ingest keeps working because **`service_role` bypasses RLS** — confirm the scripts hold
      the service key, not an anon key. That is the one thing that would break the pipeline
- [ ] **Prove it from a partner session, not an internal one.** From a forwarder login, query
      `schedules`, `vessels`, `schedules_latest`, `schedules_latest_secure` → all four must
      return **zero rows**. Then pull the anon key out of the built bundle and repeat with
      `curl`. That second check is the real one; the anon key is public by design

---

## Phase 4 — Repoint the writers (~1 hr)

Files: `ocean-routing/.env`, `Schedules/ingest_schedules.py`, `Schedules/add_port.py`.

- [ ] **Secrets to environment variables first, before touching anything else.** Both Schedules
      scripts carry a hardcoded `service_role` key that bypasses RLS on the project about to
      hold partner data. That repo has no git history yet; this plan gives it one. Minutes now,
      unfixable-in-history later
- [ ] `ocean-routing/.env` → rates `SUPABASE_URL` + rates service key
- [ ] Re-seed **in order**: `add_port.py` (ports) → `ingest_schedules.py` (schedules) →
      `push_vessels.py` (vessels)
- [ ] Confirm `refresh_schedules_latest()` runs and the MV populates
- [ ] Exercise `alerts/run.py` — it reads `schedules_latest`, `vessels`, and `ports`, and is the
      consumer most likely to be forgotten
- [ ] **Verify the rows landed in `sfoz…`, not `jnui…`.** Scripts fail *silently*; a repointed
      pipeline still writing the old project looks fine for a week, until someone asks why the
      grid stopped updating

---

## Phase 5 — The React app (~half day)

Files: `Schedules/React/src/lib/supabase.ts`, `src/lib/geoapi.ts`, `src/state/searchSchedules.ts`,
`React/.env`, plus new auth components.

- [ ] Point `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at the rates project
- [ ] **Enable Google OAuth** in Supabase Auth → Providers. Needs an OAuth client in Google
      Cloud Console with Supabase's callback URL as an authorized redirect
- [ ] **Disable new user signups** *before* the provider goes live — see
      [decision 1](#on-decision-1--why-a-login-and-why-not-zero-trust). An open Google provider
      hands a brain-accepted token to anyone with a Gmail address
- [ ] **Add the login.** Mirror RatesApp's post-Phase-A `AuthProvider`: `profiles` as the
      only source of identity, `undefined` = loading, `null` = no access, fail closed, never
      `user_metadata`. Two apps behaving differently at the auth boundary is how one ends up wrong
- [ ] Create `profiles` rows for the internal users who need this tool. No row, no access
- [ ] `geoapi.ts`: `${base}/geocode` → `${base}/api/geocode`, and attach
      `Authorization: Bearer <session.access_token>` — read **per request** via `getSession()`,
      not once at module load. Same expiry trap already fixed in RatesApp's
      [src/lib/geo.js](src/lib/geo.js)
- [ ] `VITE_GEOAPI_URL` → the brain
- [ ] Add the app's origin to the brain's `ALLOWED_ORIGINS` in Vercel — **and redeploy.** An env
      change never applies to a deployment created before it
- [ ] If the app reads the MV directly, switch to `schedules_latest_secure`

---

## Phase 6 — Retire (~30 min)

- [ ] Delete the Render service and the nested `Schedules/api/` directory. No Render in the
      estate at all
- [ ] **Do not migrate `api/geocode_cache`** — the brain owns the geocode cache
- [ ] Retire `jnui…`: unreachable first, deleted on a dated schedule after one full ingest cycle
      has run clean against rates
- [ ] Update [HUB2.md](HUB2.md) — Phase B done, the `ports`/`us_ports` claim corrected, the
      Render retirement checked off

---

## Verification

In order. Each gates the next.

1. `supabase db reset` rebuilds the entire database from migrations alone
2. Phase 1's query set re-run against the rebuild **diffs clean** against the source inventory
3. One full scraper run writes to rates; `schedules_latest` refreshes concurrently
4. `alerts/run.py` completes against the new project
5. From a forwarder session **and** from a raw anon key: `schedules`, `vessels`,
   `schedules_latest`, `schedules_latest_secure` all return zero rows
5b. A personal Gmail cannot create an account at all — signups disabled, not merely data-less
6. The React app logs in, searches a typed destination, returns results — proving
   login → `sfoz…` JWT → brain `/api/geocode` → `nearby_schedules`
7. `geoapi-next/lock_test.ipynb` still passes 27/27 — the brain was not weakened
8. RatesApp's Apply Rates still runs — same brain, unchanged

---

## Keep this file honest

Phases 0 and 1 produce facts that will revise phases 2 and 3. **Update this document as they
land.** HUB2's "three gaps" table asserted a false state for weeks because nothing re-checked
it — a plan that describes the world as it was is worse than no plan, because it reads as
authoritative.

Every state claim here should end up with either a date and a method, or a command that proves
it.
