# DRAY.md — Adding Drayage as a Second Service

**Status:** Design spec. **Not implemented.** Created June 24, 2026.
**Relates to:** `MEMORY.md` (schema/RLS), `ONBOARDING.md` (onboarding), `ALERTS.md` (notifications).
**Decisions (locked):** split tables per service · **no rename — keep existing ocean table names,
add `drayage_*` alongside** · `forwarder_services` join table · two per-service opt-in booleans on
`profiles` · keep `internal | forwarder` roles · **drayage rates are open-ended** (no expiry —
staleness, not a clock) · **request-less proactive submission** (blank template, no request needed) ·
**fuel surcharge %/$ + total resolved by Postgres generated columns** · **per-analyst notification
directory** (pick recipients per service; recipients ≠ access — no within-company RLS by service) ·
**analyst tags** (`Ocean`/`Drayage`/`All` chips derived from the per-service flags; onboarding-set,
no in-app editor yet) · **recipient prefill derived from the send audit** (each service's modal
re-checks the last set actually emailed — no new state, §7e) · **stacked per-service sidebar panels**
(static sections, no in-panel service switcher; §3a) · **neutral shell branding** (tagline/footer no
longer ocean-specific; §3a).

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
-- (receives_rate_requests = the ocean opt-in.) NOTE: these two flags are the analyst's TAG
-- (Ocean/Drayage/All chip, §7a) and the FALLBACK pre-selection in the Send modal (§7b) — never hard
-- filters. Once a service has been sent at least once, the prefill comes from the send audit instead
-- (§7e); the sender can always override per analyst on any given send.
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
-- record the exact analyst emailed, not just the company (§7d)
alter table notification_recipients add column analyst_id uuid references profiles(id);

-- DIRECTORY (for the Send modal): every analyst of each company that OFFERS the service,
-- with opted_in = that service's default flag. opted_in drives the default checkbox state — it is
-- NOT a filter; all analysts are listed so the sender can pick any of them (§7b).
create or replace function get_service_directory(p_forwarder_ids uuid[], p_service text)
returns table (forwarder_id uuid, forwarder_name text, analyst_id uuid, analyst_name text,
               email text, opted_in boolean)
language sql stable security definer set search_path = public, auth as $$
  select f.id, f.name, p.id, coalesce(p.full_name, split_part(u.email, '@', 1)), u.email,
         case p_service when 'drayage' then p.receives_drayage_requests else p.receives_rate_requests end
  from forwarders f
  join forwarder_services fs on fs.forwarder_id = f.id and fs.service = p_service and fs.active
  join profiles   p on p.forwarder_id = f.id
  join auth.users u on u.id = p.id
  where f.id = any(p_forwarder_ids) and f.active and u.email is not null;
$$;

-- SEND: resolve emails for EXACTLY the analysts the internal user checked in the modal (§7b).
create or replace function get_recipients_by_analyst(p_analyst_ids uuid[])
returns table (forwarder_id uuid, forwarder_name text, analyst_id uuid, email text)
language sql stable security definer set search_path = public, auth as $$
  select p.forwarder_id, f.name, p.id, u.email
  from profiles   p
  join forwarders f on f.id = p.forwarder_id and f.active
  join auth.users u on u.id = p.id
  where p.id = any(p_analyst_ids) and u.email is not null;
$$;
-- both SECURITY DEFINER + granted to service_role only, exactly like the original resolver.
```
> Replaces the single per-company `get_forwarder_recipients(ids, service)` with a **directory**
> resolver + a **by-analyst** send resolver (§7b). Ocean adopts the same two step: its modal simply
> defaults every opted-in analyst checked, reproducing today's "email all recipients" behavior.
> The Edge Function's `preview` mode also reads `notifications` + `notification_recipients` (service
> role; no new SQL objects) to return each company's **last-sent analyst set** for the service — the
> memory that drives the modal's prefill (§7e).

## 3. App changes

| Area | Change |
|---|---|
| **`AuthProvider`** | Load the user's services: forwarder → `select service from forwarder_services` for their company; internal → `['ocean','drayage']`. Expose `services` in context. |
| **`serviceConfig.js`** (new, in `features/rates/`) | One object per service: `{ label, slug, icon, tables:{lanes,subs,rates}, columns, options, templateId, validityDays }`. **Ocean's `tables` point at the existing names** (`rates`/`rate_request_lanes`/`rate_submissions`); drayage at `drayage_*`. This one file absorbs the naming asymmetry; everything else reads `serviceConfig[service].tables.*` uniformly. |
| **`Sidebar`** | Render stacked **sections** from `services` — a labeled group per service (design locked in **§3a**; see Diagram A). One service → one panel; both → two panels; internal always both. Shell branding goes service-neutral (§3a). |
| **Routing** | Add a `:service` segment: internal `/internal/:service/{new,requests,rates,upload}`, forwarder `/forwarder/:service/{lanes,submissions}`. Roots guard access (redirect if the company lacks `:service`). Dashboards stay at `/internal` `/forwarder`. |
| **Feature pages** | Existing pages (SubmitRates, ActiveRates, NewRateRequest, OpenRequests, ReceivedRates, UploadRates) read `useParams().service` → pull columns/options/table-fns from `serviceConfig`. Shared `rateGrid` primitives already support per-column config + `AutocompleteEditCell`. |
| **Data services** | Parameterize by service — `fetchActiveLanes(service)`, `submitRates(service, rows)`, etc. pick the table name from `serviceConfig.tables`; logic is identical. |
| **`notify-forwarders`** | Payload gains `service` + **`analystIds`** (the checked recipients, §7b). `preview` returns the directory via `get_service_directory(ids, service)` **plus each company's last-sent analyst set for that service (the prefill memory, §7e)**; `request`/`reminder` resolve emails via `get_recipients_by_analyst(analystIds)`, compute outstanding from that service's lanes/subs, fill that service's template, write `notifications.service` + one `notification_recipients` row per analyst emailed. Send modal is service-scoped (`:service` route) and now analyst-level (company → analysts with tag chips, §7b). |
| **Templates** | Ocean = existing `templateBytes.ts`. Drayage = new `drayageTemplateBytes.ts` + its own fill column map; `fillTemplate` parameterized by the service's column map. |

### 3a. Sidebar & shell design (decision)

**Locked: stacked per-service panels — NOT one panel with an ocean/drayage switcher.** Ocean group on
top (the current menu, unchanged), Drayage group below with its own options. Rationale: no hidden
state (both services visible at a glance; a switcher forces the user to remember which service they're
looking at); capability rendering is a trivial map over `services` (two groups / one group — no
switcher UI, no empty states); stacking scales fine at N=2 (~11 rows + headers fits the `w-60` rail,
and the nav area already scrolls).

Structure rules:
- **Shared items live OUTSIDE the groups.** Dashboard stays at the top (routes stay `/internal` ·
  `/forwarder`, Diagram C).
- **Ocean group (internal)** = the current menu unchanged: New Rate Request · Open Requests · Rates ·
  Upload Rates · **Apply Rates** (ocean-specific — it applies *ocean* rates to OFQs — so it stays in
  the Ocean group).
- **Drayage group (internal)** = the parallel set: New Rate Request · Open Drayage Requests · Rates ·
  Upload Rates.
- **Forwarder** = one group per `forwarder_services` row, each with Open Requests · Active Rates.
  Both services → two panels; one service → exactly one panel.
- **Static sections** — always expanded, no accordions. Group header = uppercase mono microcopy
  (`OCEAN` / `DRAYAGE`) + hairline divider, same style family as the existing role badge and footer.
- **Collapsed rail (w-16):** icons only — headers hide, a hairline divider still separates the
  groups; icon tooltips carry the service prefix ("Drayage · Open Requests").
- **Neutral shell branding.** The two ocean-specific hardcoded strings in `Sidebar.jsx` change: logo
  tagline "Ocean Freight" → **"Freight Rates"**; footer "Ocean Rate Platform" → **"Rate Platform"**.
  One brand for the whole app — the groups carry the service identity. (Required the moment a
  drayage-only forwarder logs in.)

```
internal                      forwarder (both)              forwarder (drayage only)
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│ ⚓ RatesApp          │      │ ⚓ RatesApp          │      │ ⚓ RatesApp          │
│   FREIGHT RATES     │      │   FREIGHT RATES     │      │   FREIGHT RATES     │
│ • INTERNAL          │      │ • FORWARDER         │      │ • FORWARDER         │
│ ▦ Dashboard         │      │ ▦ Dashboard         │      │ ▦ Dashboard         │
│                     │      │                     │      │                     │
│ OCEAN ────────────  │      │ OCEAN ────────────  │      │ DRAYAGE ──────────  │
│ ▸ New Rate Request  │      │ ▸ Open Requests     │      │ ▸ Open Requests     │
│ ▸ Open Requests     │      │ ▸ Active Rates      │      │ ▸ Active Rates      │
│ ▸ Rates             │      │                     │      │                     │
│ ▸ Upload Rates      │      │ DRAYAGE ──────────  │      │                     │
│ ▸ Apply Rates       │      │ ▸ Open Requests     │      │                     │
│                     │      │ ▸ Active Rates      │      │                     │
│ DRAYAGE ──────────  │      │                     │      │                     │
│ ▸ New Rate Request  │      │                     │      │                     │
│ ▸ Open Drayage Req. │      │                     │      │                     │
│ ▸ Rates             │      │                     │      │                     │
│ ▸ Upload Rates      │      │                     │      │                     │
│                     │      │                     │      │                     │
│   RATE PLATFORM     │      │   RATE PLATFORM     │      │   RATE PLATFORM     │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
```

## 4. Diagrams

**A — Capability → sidebar** (stacked static sections, §3a; Dashboard is shared, outside the groups)
```
login → role?
 ├─ internal  → always:  Dashboard
 │                       OCEAN ──── New · Open · Rates · Upload · Apply   ← current menu, unchanged
 │                       DRAYAGE ── New · Open* · Rates · Upload          ← parallel group; *"Open
 │                                                                           Drayage Requests"; each
 │                                                                           Open hosts its own Send
 │                                                                           button/modal
 └─ forwarder → services = forwarder_services(my company)
        both        →  Dashboard · OCEAN ── Open · Active · DRAYAGE ── Open · Active
        ocean only  →  Dashboard · OCEAN ── Open · Active
        drayage only→  Dashboard · DRAYAGE ── Open · Active
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

**D — Notify per service, per analyst (directories + memory)**
```
internal on /internal/ocean/requests    → Send → preview: directory('ocean') + last-send memory
internal on /internal/drayage/requests  → Send → preview: directory('drayage') + last-send memory
   modal prefill per company:  memory (who got the LAST send of this service, §7e)
                               └─ none ever? → tags (analysts whose flag covers this service, §7a)
   user adjusts checkboxes → Send
        → invoke(notify-forwarders,{ service, kind, analystIds })
        → get_recipients_by_analyst(analystIds) → emails
        → fill THAT service's template → /me/sendMail
        → notifications(service) + notification_recipients(analyst_id) per analyst
             └── these audit rows ARE next time's prefill (the loop closes itself)
   NOTE: A and B still BOTH see BOTH panels — recipients ≠ access (§7c).
```

**E — One app, two pipelines (what's shared vs per-service)**
```
┌────────────────────────────── ONE APP · ONE DEPLOYMENT ──────────────────────────────┐
│                                                                                      │
│  SHARED (one of each)                                                                │
│  ├─ Shell & UI ........... Shell / Sidebar / RoleRouter · grid primitives · Send     │
│  │                         modal — service groups are just rendered sections (§3a)   │
│  ├─ Identity & capability  forwarders · profiles (analyst directory, tags §7a)       │
│  │                         · roles internal|forwarder · forwarder_services = the     │
│  │                         ONLY thing that says who's in which pipeline              │
│  ├─ Notifications ........ one notify-forwarders fn · notifications +                │
│  │                         notification_recipients audit (= prefill memory §7e)      │
│  ├─ Batches .............. rate_request_batches, tagged by `service`                 │
│  └─ Access model ......... company-level RLS, same predicate both sides (§7c)        │
│                                                                                      │
│                     serviceConfig  ← THE single seam (§3): maps                      │
│                     service → tables · columns · options · template                  │
│                        │                              │                              │
│         ┌──────────────┴────────────┐   ┌─────────────┴─────────────┐                │
│         ▼  OCEAN pipeline           │   ▼  DRAYAGE pipeline         │                │
│  ├─ rates                           │  ├─ drayage_rates             │                │
│  ├─ rate_request_lanes              │  ├─ drayage_request_lanes     │                │
│  ├─ rate_submissions                │  ├─ drayage_submissions       │                │
│  ├─ ocean Excel template            │  ├─ drayage template (§6a)    │                │
│  └─ rules: fixed TTL / valid_until  │  └─ rules: open-ended (§6b) · │                │
│                                     │     fuel %/$ math (§6d) ·     │                │
│                                     │     supersession + refresh    │                │
│         └───────────────────────────┴───────────────────────────────┘                │
│                                                                                      │
│  Adding a 3rd service later = new tables + one serviceConfig entry + a               │
│  forwarder_services value — shell, notifications, directory, UI already generic.     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Migration sequence (all additive — ocean untouched)
> §9b expands this into commit-sized implementation steps against the current codebase.
1. **DB (additive only):** create `forwarder_services` (+ backfill every forwarder with `ocean`) ·
   add `profiles.receives_drayage_requests` (+ optional `profiles.full_name`) · add
   `rate_request_batches.service` · add `notifications.service` + `notification_recipients.analyst_id` ·
   add the `get_service_directory` + `get_recipients_by_analyst` resolvers (§2d/§7). **No renames.**
2. **App refactor (ocean → service-parameterized):** `serviceConfig` (ocean tables = existing names),
   `:service` routes, AuthProvider `services`, sidebar sections, parameterized pages/services. Ocean
   now lives under `/…/ocean/…` with **no behavior change** — it still reads the same tables, so this
   is a pure frontend refactor with nothing to coordinate at the DB level.
3. **notify-forwarders** service-aware + per-analyst (`service` + `analystIds` in payload; directory
   preview + by-analyst send, §7) + redeploy.
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
| Notes | `notes` | text null | free-form context the forwarder may add about the rate |

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

## 7. Notification directories & per-analyst recipients

Onboarding put **multiple analysts under one forwarder company**. Notifications must therefore target
**people, not just companies**, and independently per service (the ocean contact may differ from the
drayage contact). This section defines the contact directory and how recipients are chosen. It applies
to **both services** — it's the piece that makes "ocean → Analyst A, drayage → Analyst B" work.

### 7a. The directory = the company's analysts, with service tags
No new contact table. A company's directory is simply its **`profiles` rows** (`forwarder_id` = company,
role `forwarder`) — each already a login with an email. Per analyst we surface: **display name**
(`profiles.full_name`, falling back to the email local-part), **email** (`auth.users.email`, resolved
server-side only), and a **service tag** shown as a chip next to the person.

**Tags are derived, never stored separately** — they're just a readable rendering of the two §2a flags:

| `receives_rate_requests` | `receives_drayage_requests` | Tag chip |
|---|---|---|
| ✓ | ✗ | `OCEAN` |
| ✗ | ✓ | `DRAYAGE` |
| ✓ | ✓ | `ALL` |
| ✗ | ✗ | *(untagged — listed, never pre-checked)* |

Tags are set at **onboarding only** (data-only insert/update, same philosophy as `ONBOARDING.md`); an
in-app tag editor is deliberately deferred (§6e-style). Chip styling follows the maritime system:
`OCEAN` in sea/harbor tones, `DRAYAGE` in signal amber, `ALL` neutral fog ring — mono uppercase
microcopy like the existing role badge.
> If `profiles` has no display-name column, add `profiles.full_name text` — nice-to-have, not a blocker.

### 7b. Selection is per-send and per-analyst (memory → tags pre-check)
The Send modal (service-scoped — each service's Open Requests page has its own Send button) **keeps
today's layout** (company row + emails, per `SendModal.jsx`), extended one level: each analyst becomes
a selectable sub-row — checkbox + name + email + tag chip (§7a). Lane counts stay per company.

```
┌─ Send Drayage Rate Request ────────────────────────────────┐
│ ☑ Pacific Star Logistics                          4 lanes  │
│     ☑ Maria Chen      maria@pacstar.com      [DRAYAGE]     │
│     ☐ John Alvarez    john@pacstar.com       [OCEAN]       │
│     ☑ Priya Nair      priya@pacstar.com      [ALL]         │
│ ☑ Harbor Bridge Freight                           2 lanes  │
│     ☑ Tom Okafor      tom@hbfreight.com      [ALL]         │
└────────────────────────────────────────────────────────────┘
```

**Pre-check precedence, per company:**
1. **Memory** — the analysts emailed in the *most recent* send of **this service** to this company
   (§7e). The common case becomes zero-click: reopen → same people → Send.
2. **Tags (fallback)** — if this service was never sent to this company, pre-check the analysts whose
   tag covers the service (`OCEAN`/`ALL` for ocean; `DRAYAGE`/`ALL` for drayage).

Either way the sender can check/uncheck **individual analysts for this specific send** — that's how one
company routes ocean to A and drayage to B with no standing-config gymnastics: memory gives the
default, the modal gives the override.

- **Directory / preview** (for the modal): `get_service_directory(ids, service)` → one row per analyst
  of each service-offering company (`opted_in` = the tag covers this service), **plus** the last-send
  memory per company (§7e), both returned by the Edge Function's `preview` mode.
- **Send** resolver: the modal posts the **explicit analyst ids** checked; the Edge Function resolves
  their emails via `get_recipients_by_analyst(analyst_ids)` and emails exactly those.

The company gates *which services appear* (via `forwarder_services`); tags and memory only shape
default selection, never visibility.

### 7c. Recipients ≠ access (no within-company RLS by service) — decision
**Locked:** notification targeting does **not** restrict what an analyst sees. Every analyst at a company
can open **both** the ocean and drayage panels for **every service the company offers**, regardless of
who was emailed for what. Sending ocean to A and drayage to B is purely a *delivery* choice; both A and
B still see both panels. Rationale: it matches the onboarding model ("any analyst can provide rates for
the company"), keeps RLS simple (isolation stays **company-level** per §2c — `forwarder_id =
my_forwarder()`), and avoids brittle per-person row rules we don't want yet. Access is governed only by
(1) role and (2) the company's `forwarder_services` capability — never by who received a notification.

### 7d. Audit trail (per analyst)
Extend the existing log so "who did we email, for which service" is answerable:
- `notifications.service` (§2d) tags each send ocean|drayage.
- `notification_recipients.analyst_id` (§2d, new) records the exact person emailed (keep `forwarder_id`
  for company grouping and `email` as the sent-to snapshot). One row per analyst actually emailed.

### 7e. Recipient memory — derived from the audit log (decision)
Each service's Send modal **remembers the last set of people selected for that rate type**, so the
sender isn't reselecting every time. **Locked: no new storage** — the §7d audit rows *are* the memory:

- **Definition.** For each `(service, company)`, the prefill set = the `analyst_id`s of the
  `notification_recipients` rows belonging to the **latest** `notifications` row of that service that
  included that company.
- **Where.** Computed inside `notify-forwarders` **preview** (the service role already reads these
  tables); the preview response gains each company's last-sent analyst set (e.g. `lastSelected` per
  analyst). No new table, no new writes, no new SQL objects — every send already produces the audit
  rows that become the next send's default. The loop closes itself (Diagram D).
- **Edge behavior.** An analyst onboarded after the last send appears **unchecked but tagged** (the
  sender consciously adds them once; memory then keeps them). Unchecking someone in a send means
  they're unchecked next time — memory reflects what actually happened; tags remain the stable
  fallback and are never mutated by sends.
- **Scope.** Memory is per **service** and per **company**, shared by the whole internal team (it
  derives from the team's sends, not per-user preferences). Ocean and drayage memories are fully
  independent.

## 8. Verification (once built)
- Onboard a company as ocean-only / drayage-only / both → sidebar shows exactly the right panel(s):
  both → two stacked groups, one service → exactly one group (§3a).
- Internal sidebar: Dashboard on top, then OCEAN (current items incl. Apply Rates), then DRAYAGE.
- Collapsed rail: group headers hidden but the divider still separates the groups; tooltips carry the
  service prefix.
- No ocean-specific shell branding for a drayage-only forwarder — tagline "Freight Rates", footer
  "Rate Platform" (§3a).
- Forwarder isolation holds per service (a company sees only its own ocean *and* drayage rates).
- Internal Send on each service emails exactly the analysts checked in that service's modal;
  `notifications.service` recorded correctly.
- Ocean behaves identically to today after the refactor (regression check).
- **Fuel math (§6d):** upload `{rate 388, pct 0.34}` → amount 131.92, total 519.92; `{rate 800, no
  fuel}` → amount 0, total 800; `{rate, $ only}` → pct back-computed; both-given mismatch warns.
- **Open-ended validity (§6b):** a drayage rate never auto-expires; age/staleness is shown but not
  enforced; a new rate for the same `(forwarder, lane)` supersedes the old one (history kept).
- **Request-less (§6c):** a forwarder uploads the blank drayage template with no prior request → rates
  appear as `current`. A `refresh` request re-confirms or supersedes the existing rate.
- **Directory (§7b):** the Send modal lists a company's analysts for the chosen service with tag chips
  (`OCEAN`/`DRAYAGE`/`ALL` derived from the two flags); checking/unchecking changes exactly who is
  emailed.
- **Memory (§7e):** first-ever drayage send pre-checks tag-covered analysts; send to a custom set →
  reopen the modal → exactly that set is pre-checked (memory beats tags). Ocean and drayage memories
  are independent — changing drayage recipients never alters the ocean prefill.
- **Per-service routing (§7b):** send ocean to Analyst A and drayage to Analyst B in the same company →
  each email reaches only the intended analyst; `notification_recipients.analyst_id` records who.
- **Recipients ≠ access (§7c):** afterward, Analyst B can still open the ocean panel and Analyst A the
  drayage panel — both services visible to both, no RLS block.

## 9. Next steps

### 9a. Current implemented state (checked July 15, 2026)
Nothing from this spec is in code yet — the app is **ocean-only end to end**:
- **Routes are flat, no `:service` segment**: internal `/internal/{new,requests,rates,upload,apply}`,
  forwarder `/forwarder/{lanes,submissions}` (`RoleRouter.jsx`, `InternalRoot.jsx`, `ForwarderRoot.jsx`).
- **Sidebar** = flat per-role lists (`INTERNAL_NAV` / `FORWARDER_NAV`) with hardcoded "Ocean Freight" /
  "Ocean Rate Platform" branding (`Sidebar.jsx`).
- **AuthProvider** exposes `session/user/role/forwarderName` only — no `services` (`AuthProvider.jsx`).
- **notify-forwarders** resolves recipients **per company** via `get_forwarder_recipients(uuid[])`
  (no service arg, no analyst selection); `notifications` / `notification_recipients` lack
  `service` / `analyst_id` (migration `20260621120000_notify_forwarders.sql`).
- **No** `forwarder_services`, no `drayage_*` tables, no `serviceConfig.js`, no
  `receives_drayage_requests`, no tags/memory/prefill.
- `drayTemplate.csv` is committed and is the §6a source of truth. That's the only artifact built.

### 9b. Implementation steps (each = one coherent commit; ocean regression-checked)
Ordering rationale: DB first because every change is additive and invisible to the running app; the
frontend service-parameterization is the riskiest step, so it lands alone with ocean behavior frozen.

1. **DB migration 1 — capability + notification groundwork (additive, zero app impact).**
   `forwarder_services` (+ backfill `ocean` for every forwarder) · `profiles.receives_drayage_requests`
   (+ `profiles.full_name` if missing) · `rate_request_batches.service` · `notifications.service` ·
   `notification_recipients.analyst_id` · `get_service_directory` + `get_recipients_by_analyst`
   (SECURITY DEFINER, service_role-only, §2d) · RLS on `forwarder_services` (§2c). Deployable any time.
2. **Frontend refactor — service-parameterized shell (ocean unchanged).**
   `serviceConfig.js` (ocean tables = existing names, §3) · `AuthProvider.services` · `:service`
   routes + redirects from the legacy flat paths · sidebar groups + neutral branding (§3a) ·
   pages/data services read `serviceConfig[service]`. **Regression gate: ocean behaves identically.**
3. **notify-forwarders v2 — service-aware, per-analyst, with memory.**
   Payload `{service, kind, analystIds}` · `preview` returns directory + tags + last-send memory
   (§7b/§7e) · send resolves via `get_recipients_by_analyst` · writes `service` + one recipient row
   per analyst. SendModal gains analyst sub-rows + tag chips + memory→tags prefill. Ocean's default
   prefill reproduces today's "all opted-in" behavior.
4. **DB migration 2 — drayage pipeline.**
   `drayage_request_lanes` / `drayage_submissions` / `drayage_rates` with §6a columns, §6d generated
   columns, `kind/refresh_of`, nullable lane/submission ids, the `current` partial unique index, and
   RLS copied from ocean (§2b/§2c).
5. **Drayage app wiring.**
   Add `drayage` to `serviceConfig` (columns/options/labels) · drayage Excel template bytes + fill
   column map (from `drayTemplate.csv`) · Upload pipeline parameterized for request-less submission +
   supersession (§6c) · staleness cues fresh/aging/stale (§6b) · refresh-request flow.
6. **Onboard + verify.**
   Insert a `forwarder_services` drayage row for a pilot company → run the full §8 checklist
   (capability panels, isolation, fuel math, memory, recipients ≠ access).
