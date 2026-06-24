# DRAY.md — Adding Drayage as a Second Service

**Status:** Design spec. **Not implemented.** Created June 24, 2026.
**Relates to:** `MEMORY.md` (schema/RLS), `ONBOARDING.md` (onboarding), `ALERTS.md` (notifications).
**Decisions (locked):** split tables per service · `forwarder_services` join table · two per-service
opt-in booleans on `profiles` · keep `internal | forwarder` roles.

## 1. The core idea
The app was built ocean-only. Drayage is the *same shape* of workflow (request lanes → forwarder
fills a template → rates, with notifications) but **different columns and longer validity**. Model it
as a **second service that runs in parallel**, not a fork of the app:

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

-- per-service notification opt-in (replaces the single receives_rate_requests)
alter table profiles rename column receives_rate_requests to receives_ocean_requests;
alter table profiles add column receives_drayage_requests boolean not null default true;
```

### 2b. Per-service pipelines (rename ocean, add drayage)
```sql
-- rename the ocean pipeline for clarity
alter table rate_request_lanes rename to ocean_request_lanes;
alter table rate_submissions   rename to ocean_submissions;
alter table rates              rename to ocean_rates;

-- batches stay shared but tagged
alter table rate_request_batches add column service text not null default 'ocean'
  check (service in ('ocean','drayage'));

-- drayage mirrors (COLUMNS = TBD — see §6; longer validity by default)
create table drayage_request_lanes ( id uuid pk …, batch_id uuid → rate_request_batches,
  /* drayage demand columns */ posted_at, period,
  expires_at timestamptz not null default (now() + interval '30 days') );   -- longer TTL
create table drayage_submissions   ( … lane_id → drayage_request_lanes, forwarder_id, provider_id,
  period, status … );  -- mirror ocean_submissions
create table drayage_rates         ( … submission_id → drayage_submissions, lane_id → drayage_request_lanes,
  forwarder_id, provider_id, /* drayage rate columns */ valid_until … );   -- longer validity
```

### 2c. RLS + helpers (no new helpers needed)
`my_forwarder()` / `current_role_is()` are reused. Replicate the existing ocean policies onto each
new table verbatim (the isolation predicate `forwarder_id = my_forwarder()` is identical):
`ocean_rates`/`drayage_rates`, `ocean_submissions`/`drayage_submissions`, lanes, etc. Add:
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
    and case p_service when 'drayage' then p.receives_drayage_requests else p.receives_ocean_requests end
  join auth.users u on u.id = p.id
  where f.id = any(p_forwarder_ids) and f.active and u.email is not null;
$$;
```

## 3. App changes

| Area | Change |
|---|---|
| **`AuthProvider`** | Load the user's services: forwarder → `select service from forwarder_services` for their company; internal → `['ocean','drayage']`. Expose `services` in context. |
| **`serviceConfig.js`** (new, in `features/rates/`) | One object per service: `{ label, slug, icon, tables:{lanes,subs,rates}, columns, options, templateId, validityDays }`. Single source that parameterizes grids + data calls. |
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
     │             receives_ocean_requests, receives_drayage_requests)   ← per-service directory
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

## 5. Migration sequence
1. **DB:** `forwarder_services` (+ backfill ocean) · profiles opt-in rename/add · rename ocean tables ·
   `notifications.service` · service-aware `get_forwarder_recipients`. (Ocean keeps working.)
2. **App refactor (ocean → service-parameterized):** `serviceConfig`, `:service` routes, AuthProvider
   `services`, sidebar sections, parameterized pages/services. Ocean now lives under `/…/ocean/…` with
   **no behavior change**. Coordinate with the table rename in one deploy (or add temporary DB views
   `rates`→`ocean_rates` as aliases to de-risk).
3. **notify-forwarders** service-aware + redeploy.
4. **Add drayage:** define drayage columns + template, create `drayage_*` tables, add `drayage` to
   `serviceConfig`, onboard a company into drayage (insert `forwarder_services` row).

## 6. Open items (define before building drayage)
- **Drayage lane + rate columns** (the actual fields — e.g. origin ramp/port, delivery zip/city,
  container size, chassis, fuel/accessorials, free time, rate, valid_until). Provide a `drayage.csv`
  or column list like the ocean template.
- **Drayage validity length** (30 / 60 / 90 days?) → `expires_at` + `valid_until` defaults.
- **Drayage Excel template** (the fill-out sheet) → new `drayageTemplateBytes.ts` + column map.
- Optional later: rename `forwarders`→`providers` for semantic clarity (deferred — bigger migration).

## 7. Verification (once built)
- Onboard a company as ocean-only / drayage-only / both → sidebar shows exactly the right section(s).
- Forwarder isolation holds per service (a company sees only its own ocean *and* drayage rates).
- Internal Send on each service emails only that service's opted-in directory; `notifications.service`
  recorded correctly.
- Ocean behaves identically to today after the refactor (regression check).
