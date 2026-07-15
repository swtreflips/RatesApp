# DRAY.md — Adding Drayage as a Second Service

**Status:** Design spec. **Not implemented.** Created June 24, 2026.
**Relates to:** `MEMORY.md` (schema/RLS), `ONBOARDING.md` (onboarding), `ALERTS.md` (notifications).
**Decisions (locked):** split tables per service · **no rename — keep existing ocean table names,
add `drayage_*` alongside** · `forwarder_services` join table · two per-service opt-in booleans on
`profiles` · keep `internal | forwarder` roles · **drayage rates are open-ended** (no expiry —
staleness, not a clock) · **request-less proactive submission** (blank template, no request needed) ·
**fuel surcharge %/$ + total resolved by Postgres generated columns**.

> **No-rename approach (chosen).** Every DB change is **additive** — existing ocean tables, their RLS
> policies, and their data are untouched; we only `create` new drayage tables + `add` new policies/
> columns. The naming asymmetry (`rates` vs `drayage_rates`) is hidden inside one place,
> `serviceConfig` (§3), so the rest of the code stays uniform. This removes the riskiest step (the
> rename + retrofitting every existing reference) and keeps everything on one codebase.

## 1. The core idea
The app was built ocean-only. Drayage is the *same shape* of workflow (request lanes → forwarder
fills a template → rates, with notifications) but **different columns and an open-ended validity
model** (drayage rates don't expire — see §6b). Model it
as a **second service that runs in parallel**, not a fork of the app:

- **Ocean tables keep their current names** (`rates`, `rate_request_lanes`, `rate_submissions`,
  `rate_request_batches`) — ocean is the implied default. Drayage gets new `drayage_*` tables. No
  renames anywhere, so existing ocean code/RLS/data are untouched.
- **One company, N services.** A `forwarders` row (provider company) gains capability rows in a new
  `forwarder_services` table: `ocean`, `drayage`, or both. Onboard/remove a service = insert/delete
  one row (data-only — same philosophy as `ONBOARDING.md`).
- **Access is unified, requests are per-service.** Any onboarded analyst at a company can log in and
  see every service that company offers. But *notification recipients* are chosen **per service**
  (the drayage contact may differ from ocean) via per-analyst opt-in flags.
- **Per-service data pipelines.** Because columns/validity differ, ocean and drayage get their own
  tables (`ocean_*` / `drayage_*`) — clean schemas, no sparse nullable columns.
- **Roles unchanged.** `internal | forwarder`. "forwarder" is the generic external-provider role;
  a drayage-only company's users are still `forwarder`. Capabilities (services) decide what shows.

## 2. Database changes

### 2a. Capability + recipient model
```sql
-- which services a company offers (presence = offered; active = currently soliciting)
create table forwarder_services (
  forwarder_id uuid not null references forwarders(id) on delete cascade,
  service      text not null check (service in ('ocean','drayage')),
  active       boolean not null default true,
  primary key (forwarder_id, service)
);
-- backfill: every existing forwarder currently offers ocean
insert into forwarder_services (forwarder_id, service)
  select id, 'ocean' from forwarders;

-- per-service notification opt-in.
-- KEEP the existing receives_rate_requests as the OCEAN flag (no rename); just add drayage.
alter table profiles add column receives_drayage_requests boolean not null default true;
-- (receives_rate_requests = the ocean opt-in; referenced as such in get_forwarder_recipients below)
```

### 2b. Per-service pipelines (keep ocean as-is, add drayage)
```sql
-- NO RENAMES. Ocean stays: rates / rate_request_lanes / rate_submissions / rate_request_batches.

-- batches stay shared but tagged (additive column; existing rows default to 'ocean')
alter table rate_request_batches add column service text not null default 'ocean'
  check (service in ('ocean','drayage'));

-- drayage mirrors (NEW tables only — COLUMNS now defined in §6a; NO expiry, see §6b)
-- request lanes are OPTIONAL: they solicit or refresh a lane, but a rate can exist without one (§6c).
create table drayage_request_lanes ( id uuid pk …, batch_id uuid → rate_request_batches,
  /* drayage demand columns, §6a */ posted_at,
  kind text not null default 'new' check (kind in ('new','refresh')),   -- refresh = re-quote a lane you already have
  refresh_of uuid null → drayage_rates );                               -- the rate being refreshed, if any
create table drayage_submissions   ( … lane_id uuid null → drayage_request_lanes, forwarder_id, provider_id,
  status … );  -- mirror ocean_submissions; nullable lane_id for request-less fills
create table drayage_rates         ( … submission_id uuid null → drayage_submissions,
  lane_id uuid null → drayage_request_lanes,           -- both nullable: proactive rates stand alone (§6c)
  forwarder_id, provider_id, /* drayage rate + fee columns, §6a */
  provided_at date not null default current_date,      -- Date Received; staleness anchor (§6b)
  confirmed_at date not null default current_date,      -- last re-validation; bumped on re-confirm
  status text not null default 'current' check (status in ('current','superseded')) );  -- NO valid_until
-- one live rate per (forwarder, lane):
create unique index drayage_rates_current_uq on drayage_rates (forwarder_id, last_cy_cfs, final_destination)
  where status = 'current';
```

### 2c. RLS + helpers (no new helpers needed)
`my_forwarder()` / `current_role_is()` are reused. **Existing ocean policies stay untouched.** Just
**add** policies on the new `drayage_*` tables, copied verbatim from the ocean ones (the isolation
predicate `forwarder_id = my_forwarder()` is identical). Also add:
```sql
alter table forwarder_services enable row level security;
create policy "read services" on forwarder_services
  for select using (forwarder_id = my_forwarder() or current_role_is('internal'));
```

### 2d. Service-aware notifications
```sql
alter table notifications add column service text not null default 'ocean'
  check (service in ('ocean','drayage'));

-- recipients resolved per service: company must offer it + the analyst opted in for THAT service
create or replace function get_forwarder_recipients(p_forwarder_ids uuid[], p_service text)
returns table (forwarder_id uuid, forwarder_name text, email text)
language sql stable security definer set search_path = public, auth as $$
  select f.id, f.name, u.email
  from forwarders f
  join forwarder_services fs on fs.forwarder_id = f.id and fs.service = p_service and fs.active
  join profiles p on p.forwarder_id = f.id
    and case p_service when 'drayage' then p.receives_drayage_requests else p.receives_rate_requests end
  join auth.users u on u.id = p.id
  where f.id = any(p_forwarder_ids) and f.active and u.email is not null;
$$;
```

## 3. App changes

| Area | Change |
|---|---|
| **`AuthProvider`** | Load the user's services: forwarder → `select service from forwarder_services` for their company; internal → `['ocean','drayage']`. Expose `services` in context. |
| **`serviceConfig.js`** (new, in `features/rates/`) | One object per service: `{ label, slug, icon, tables:{lanes,subs,rates}, columns, options, templateId, validityDays }`. **Ocean's `tables` point at the existing names** (`rates`/`rate_request_lanes`/`rate_submissions`); drayage at `drayage_*`. This one file absorbs the naming asymmetry; everything else reads `serviceConfig[service].tables.*` uniformly. |
| **`Sidebar`** | Render **sections** from `services` (see Diagram A): a labeled group per service. One service → just that group; both → two groups. Internal always shows both. |
| **Routing** | Add a `:service` segment: internal `/internal/:service/{new,requests,rates,upload}`, forwarder `/forwarder/:service/{lanes,submissions}`. Roots guard access (redirect if the company lacks `:service`). Dashboards stay at `/internal` `/forwarder`. |
| **Feature pages** | Existing pages (SubmitRates, ActiveRates, NewRateRequest, OpenRequests, ReceivedRates, UploadRates) read `useParams().service` → pull columns/options/table-fns from `serviceConfig`. Shared `rateGrid` primitives already support per-column config + `AutocompleteEditCell`. |
| **Data services** | Parameterize by service — `fetchActiveLanes(service)`, `submitRates(service, rows)`, etc. pick the table name from `serviceConfig.tables`; logic is identical. |
| **`notify-forwarders`** | Payload gains `service`; resolve recipients via `get_forwarder_recipients(ids, service)`, compute outstanding from that service's lanes/subs, fill that service's template, write `notifications.service`. Send modal is already service-scoped (it lives on a `:service` route). |
| **Templates** | Ocean = existing `templateBytes.ts`. Drayage = new `drayageTemplateBytes.ts` + its own fill column map; `fillTemplate` parameterized by the service's column map. |

## 4. Diagrams

**A — Capability → sidebar**
```
login → role?
 ├─ internal  → always: [Ocean ▸ New · Open · Active · Upload]
 │                       [Drayage ▸ New · Open · Active · Upload]
 └─ forwarder → services = forwarder_services(my company)
        both        → [Ocean ▸ Open · Active]   [Drayage ▸ Open · Active]
        ocean only  → [Ocean ▸ Open · Active]
        drayage only→ [Drayage ▸ Open · Active]
```

**B — Data model**
```
forwarders ──<  forwarder_services (service, active)        ← capability
     │
     ├──<  profiles (role, forwarder_id,
     │             receives_rate_requests [ocean], receives_drayage_requests)   ← per-service directory
     │
rate_request_batches (service) ──< ocean_request_lanes  ──< ocean_submissions  ──< ocean_rates
                                └─< drayage_request_lanes──< drayage_submissions──< drayage_rates
notifications (service) ──< notification_recipients
```

**C — Routing (service-parameterized)**
```
RoleRouter
 ├─ internal  → InternalRoot
 │     /internal               Dashboard (both services)
 │     /internal/:service/new|requests|rates|upload   (service ∈ ocean|drayage)
 └─ forwarder → ForwarderRoot
       /forwarder              Dashboard (company's services)
       /forwarder/:service/lanes|submissions          (guarded by forwarder_services)
```

**D — Notify per service (separate directories)**
```
internal clicks Send on /internal/ocean/requests   →  invoke(notify-forwarders,{service:'ocean', ids})
                         /internal/drayage/requests →  invoke(notify-forwarders,{service:'drayage', ids})
   Edge fn → get_forwarder_recipients(ids, service)
              → ocean   → analysts with receives_ocean_requests   (ocean directory)
              → drayage → analysts with receives_drayage_requests (drayage directory)
   → fill THAT service's template → /me/sendMail → notifications(service)
```

## 5. Migration sequence (all additive — ocean untouched)
1. **DB (additive only):** create `forwarder_services` (+ backfill every forwarder with `ocean`) ·
   add `profiles.receives_drayage_requests` · add `rate_request_batches.service` ·
   add `notifications.service` · update `get_forwarder_recipients` to take `service`. **No renames.**
2. **App refactor (ocean → service-parameterized):** `serviceConfig` (ocean tables = existing names),
   `:service` routes, AuthProvider `services`, sidebar sections, parameterized pages/services. Ocean
   now lives under `/…/ocean/…` with **no behavior change** — it still reads the same tables, so this
   is a pure frontend refactor with nothing to coordinate at the DB level.
3. **notify-forwarders** service-aware (`service` in payload) + redeploy.
4. **Add drayage:** define drayage columns + template, create `drayage_*` tables (+ their RLS),
   add `drayage` to `serviceConfig`, onboard a company into drayage (insert a `forwarder_services` row).

## 6. Drayage service definition (resolved)

The demand template and rate shape are fixed by **`drayTemplate.csv`**. Four things differ from ocean
and are specified here: **(a)** columns, **(b)** an open-ended validity model (no expiry), **(c)**
request-less proactive submission, **(d)** dynamic fuel-surcharge / total math done in the database.

### 6a. Lane + rate columns (from `drayTemplate.csv`)

| CSV column | DB column | Type | Notes |
|---|---|---|---|
| Last CY/CFS | `last_cy_cfs` | text | Origin (port / CY area). Lane key part 1. |
| Final Destination | `final_destination` | text | Delivery city. Lane key part 2. |
| Drayage Lane | `drayage_lane` | text *(generated)* | `last_cy_cfs \|\| ' - ' \|\| final_destination` |
| Zip Code | `dest_zip` | text | Destination ZIP — **text** to preserve leading zeros |
| Rate | `rate` | numeric(12,2) | Base linehaul. **Required.** |
| Fuel Surcharge % | `fuel_surcharge_pct` | numeric(6,4) null | Fraction (`0.34` = 34%). One of pct / nominal. |
| Fuel Surcharge | `fuel_surcharge` | numeric(12,2) null | Nominal $. The other of pct / nominal. |
| — | `fuel_surcharge_amount` | numeric *(generated)* | resolved $ (see §6d) |
| — | `fuel_surcharge_pct_eff` | numeric *(generated)* | resolved % (see §6d) |
| — | `total_rate` | numeric *(generated)* | `rate` + resolved surcharge (see §6d) |
| Toll Fee | `toll_fee` | numeric null | accessorial — **not** in total |
| Pre-pull Fee | `pre_pull_fee` | numeric null | accessorial |
| Pier Pass Fee | `pier_pass_fee` | numeric null | accessorial |
| Clean Truck Fee | `clean_truck_fee` | numeric null | accessorial |
| Drop Fee | `drop_fee` | numeric null | accessorial |
| Chassis Fee | `chassis_fee` | numeric null | accessorial |
| Min Chassis Days | `min_chassis_days` | int null | |
| Chassis Days Included | `chassis_days_included` | int null | |
| Storage Fee (/Day) | `storage_fee_per_day` | numeric(12,2) null | per-day storage rate (the `"/Day"` lives in the label, value is a plain amount) |
| Date Received | `provided_at` | date | staleness anchor (§6b); default `current_date` |

Accessorials (toll → storage) are situational and **excluded from `total_rate`**, which is deliberately
just `rate + fuel_surcharge` per the product rule. `drayage_lane` and the three resolved fuel/total
columns are computed, never entered.

### 6b. Validity — open-ended (staleness, not expiry)

Drayage prices move with fuel / the broader economy / each carrier's competitive strategy, not on a
fixed clock — so a hard `valid_until` would be wrong. Instead:

- **No `valid_until` / `expires_at`.** A rate stays the current known price **indefinitely** until it's
  superseded or explicitly refreshed.
- Each rate carries **`provided_at`** (Date Received) and **`confirmed_at`** (last re-validation; =
  `provided_at` initially). The app derives **age** and shows soft staleness cues — e.g. fresh < 6 mo,
  aging 6–12 mo, stale > 12 mo. Thresholds are display-only, configurable, **never enforced**.
- **Supersession, not deletion.** A new rate for the same `(forwarder, lane)` flips the previous one to
  `superseded` and becomes `current` (unique partial index in §2b). History is retained → audit +
  negotiation trail.
- **Refresh request** = a request tied to a lane you *already* have a rate for (`kind='refresh'`,
  `refresh_of` → that rate). Covers the three real triggers:
  - **renegotiate** — you've run the rate ~3 months and want to push for better;
  - **market shock** — war / fuel spike → "is this rate still valid / reinstated?";
  - **staleness** — it's ~1 year old, you just want an "OK, still good" confirmation.
  The forwarder responds either by **re-confirming** (bumps `confirmed_at`, same numbers) or
  **submitting a new rate** (supersedes).

### 6c. Request-less (proactive) submission — mirror ocean

Exactly like ocean's Upload Rates: a forwarder fills the **blank drayage template** and submits rates
with **no prior request**. The demand-side request lane is *optional context*, not a prerequisite —
this is the core "a template of demand; a request is not necessary to provide rates" idea.

- `drayage_rates.lane_id` and `submission_id` are **nullable** — a proactively uploaded rate stands on
  its own, keyed by `(forwarder, last_cy_cfs, final_destination)`.
- Requests exist only to **solicit** new lanes or **refresh** existing ones; the primary artifact is
  always the rate itself.
- Reuse the ocean Upload pipeline (`recordRatesService`), parameterized by service per §3: parse
  `drayTemplate.csv` → run the §6d math (in-DB) → upsert as `current`, superseding any prior current
  rate for that `(forwarder, lane)`.

### 6d. Dynamic fuel surcharge & total — computed in Postgres

Forwarders give **`rate` + exactly one of {`fuel_surcharge_pct`, `fuel_surcharge`}**; the system fills
the other and the total. Some shops think in %, some in $ — accept either, to lower adoption friction.
Do it with **STORED generated columns** so it's always consistent, needs no trigger, and works
identically for upload *and* manual entry ("dynamic on Supabase"):

```sql
-- STORED only what the forwarder typed:  rate (required),
--   fuel_surcharge_pct (fraction, nullable), fuel_surcharge (nominal $, nullable)

-- resolved nominal surcharge: nominal wins if given; else derive from %; else 0
fuel_surcharge_amount numeric(12,2) generated always as (
  coalesce(fuel_surcharge, round(rate * fuel_surcharge_pct, 2), 0)
) stored,

-- resolved percentage (fraction): % wins if given; else derive from nominal; guard rate>0
fuel_surcharge_pct_eff numeric(6,4) generated always as (
  case
    when fuel_surcharge_pct is not null then fuel_surcharge_pct
    when fuel_surcharge is not null and rate > 0 then round(fuel_surcharge / rate, 4)
    else 0
  end
) stored,

-- total = base + resolved surcharge.  NB: the base expression is REPEATED here because a
-- generated column may not reference another generated column in Postgres.
total_rate numeric(12,2) generated always as (
  rate + coalesce(fuel_surcharge, round(rate * fuel_surcharge_pct, 2), 0)
) stored,
```

Rules encoded above (verified against `drayTemplate.csv`):
- **% only** → `amount = round(rate × pct, 2)`.  *(row 2: 388 × 0.34 = 131.92 ✓, total 519.92)*
- **$ only** → `pct_eff = round($ / rate, 4)`.
- **neither** → surcharge 0, `total = rate`.  *(row 3: 800 → total 800 ✓)*
- **both given** → keep both as typed; **nominal $ is the source of truth** for money. Add a soft
  check that **warns** when `abs(rate*pct − $) > 1.00` (likely a typo) — app-side warning or a
  `NOT VALID` constraint, so a legit rounding gap never blocks a save.
- Guard: deriving pct requires `rate > 0` (avoids div-by-zero); `rate` is required anyway.

The app reads `fuel_surcharge_amount`, `fuel_surcharge_pct_eff`, `total_rate` and does **no client
math** — one source of truth for both display and export.

### 6e. Still deferred
- Rename `forwarders` → `providers` for semantics — bigger migration, not needed for drayage.
- Whether accessorials ever roll into an optional "all-in" total view (today they're reference-only,
  excluded from `total_rate`).

## 7. Verification (once built)
- Onboard a company as ocean-only / drayage-only / both → sidebar shows exactly the right section(s).
- Forwarder isolation holds per service (a company sees only its own ocean *and* drayage rates).
- Internal Send on each service emails only that service's opted-in directory; `notifications.service`
  recorded correctly.
- Ocean behaves identically to today after the refactor (regression check).
- **Fuel math (§6d):** upload `{rate 388, pct 0.34}` → amount 131.92, total 519.92; `{rate 800, no
  fuel}` → amount 0, total 800; `{rate, $ only}` → pct back-computed; both-given mismatch warns.
- **Open-ended validity (§6b):** a drayage rate never auto-expires; age/staleness is shown but not
  enforced; a new rate for the same `(forwarder, lane)` supersedes the old one (history kept).
- **Request-less (§6c):** a forwarder uploads the blank drayage template with no prior request → rates
  appear as `current`. A `refresh` request re-confirms or supersedes the existing rate.
