# SUPABASE.md — Database Reference (Tables · Joins · Functions · RLS)

**Purpose:** one place that documents every SQL object in the live Supabase project — what it is,
how it joins, and which policies/functions guard it. Supersedes the schema sections of `MEMORY.md`
(June 12) by adding the service-capability layer (DRAY.md §9b step 1, run July 17, 2026) and the
drayage pipeline (step 4).
**Convention:** schema changes are run by hand in the SQL editor (service role, bypasses RLS);
`supabase/migrations/` holds the files that were also saved as migrations. When in doubt, the live
project + this doc are the source of truth.

---

## 0. The one-screen mental model

```
                          ┌─ CAPABILITY ────────────────────────────────┐
forwarders ──────────<────│ forwarder_services (service, active)        │  which services a company offers
    │                     └─────────────────────────────────────────────┘
    │  1 company : N analysts
    ├──<  profiles (role, forwarder_id, full_name,
    │              receives_rate_requests [ocean tag], receives_drayage_requests [drayage tag])
    │         │ 1:1
    │      auth.users (email — only reachable through SECURITY DEFINER functions)
    │
    │                 OCEAN PIPELINE (original names — no renames)
    │   rate_request_batches (service) ──< rate_request_lanes ──< rate_submissions ──< rates
    │                                                                    │ forwarder_id = isolation line
    │                 DRAYAGE PIPELINE (parallel, §9b step 4)
    │   rate_request_batches (service) ──< drayage_request_lanes ──< drayage_submissions ──< drayage_rates
    │
    └── NOTIFICATIONS   notifications (kind, service) ──< notification_recipients (forwarder_id, analyst_id)
                        └ audit log; latest rows per (service, company) = the Send modal's prefill memory
```

Two roles: `internal` (the team; sees everything) and `forwarder` (analyst at a company; sees only
their company's rows). Isolation is **company-level** (`forwarder_id = my_forwarder()`), never
per-analyst and never per-service (DRAY.md §7c).

---

## 1. Helper functions (used inside RLS policies)

| Function | Returns | What it does |
|---|---|---|
| `current_role_is(target text)` | boolean | `profiles.role = target` for the logged-in user (`auth.uid()`) |
| `my_forwarder()` | uuid | the logged-in user's `profiles.forwarder_id` (null for internal → forwarder policies fail closed) |

Both `SECURITY DEFINER`, `stable`, `search_path = public`. Defined once; every policy evaluates them
per request, so onboarding never touches RLS (see `ONBOARDING.md`).

---

## 2. Core identity & capability tables

### `forwarders` — provider companies
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| active | boolean default true | inactive company = excluded from notifications |
| created_at | timestamptz | |

### `profiles` — auth user → role, company, tags
| column | type | notes |
|---|---|---|
| id | uuid PK → auth.users(id) | on delete cascade |
| role | text check internal\|forwarder | keep in sync with `user_metadata.role` |
| forwarder_id | uuid → forwarders(id) | null for internal users |
| full_name | text | directory display name; falls back to email local-part |
| company | text | legacy label |
| receives_rate_requests | boolean default true | **ocean tag** — chip display only, never a filter (DRAY.md §7a) |
| receives_drayage_requests | boolean default true | **drayage tag** — same; added step 1 |
| created_at | timestamptz | |

Tag chip = the two flags **∩ the company's services**: ocean-only company ⇒ analysts can only show
`OCEAN` (or untagged). Both flags = `ALL`.

### `forwarder_services` — which services a company offers (step 1)
| column | type | notes |
|---|---|---|
| forwarder_id | uuid → forwarders(id) on delete cascade | |
| service | text check ocean\|drayage | |
| active | boolean default true | |
| PK | (forwarder_id, service) | |

Presence of a row = the company offers that service → its sidebar panel + directory materialize.
Backfilled with `ocean` for every pre-existing forwarder. Onboard/remove a service = insert/delete
one row (`ONBOARDING.md §C`).

**Joins:** `forwarder_services.forwarder_id → forwarders.id` · `profiles.forwarder_id → forwarders.id`
· `profiles.id → auth.users.id`.

---

## 3. Ocean pipeline (original table names — the no-rename decision)

### `rate_request_batches` — one posting action
id PK · requester_id → auth.users · **service** text default `'ocean'` check ocean|drayage (step 1;
shared by both pipelines) · created_at.

### `rate_request_lanes` — demand lanes (10-day TTL, periods)
id PK · batch_id → rate_request_batches · pol (not null) · pod · last_cy · fd (not null) ·
container_type · container_count · posted_at · **expires_at** default now()+10 days · period ·
created_at. Indexes: expires_at, (pol, fd).

### `rate_submissions` — acknowledgement: one per (lane, forwarder, period)
id PK · lane_id → rate_request_lanes (nullable = independent) · forwarder_id → forwarders (not null,
isolation) · provider_id → auth.users (attribution) · period · status submitted|skipped ·
skip_reason · submitted_at. Partial unique (lane_id, forwarder_id, period) where lane_id not null.

### `rates` — append-only rate rows
id PK · submission_id → rate_submissions (nullable) · lane_id → rate_request_lanes (nullable) ·
forwarder_id (not null, isolation) · provider_id · period · pol · pod · last_cy · fd · carrier ·
rate_amount numeric · free_days int · currency default 'USD' · transit_days · valid_from ·
**valid_until** (ocean's validity clock) · contract (internal Upload only) · notes · created_at.
Indexes: forwarder_id, lane_id, (pol, fd).

**Ocean's two clocks:** lane TTL (`expires_at`, 10 days — drives "Lanes to fill") and rate validity
(`valid_until` — drives "Active Rates"). Drayage deliberately has neither (see §4).

---

## 4. Drayage pipeline (DRAY.md §6, §9b step 4)

Mirrors ocean's lanes → submissions → rates shape with drayage columns, **no expiry anywhere**
(open-ended validity, staleness + supersession instead — DRAY.md §6b), and the fuel-surcharge /
total math done by **STORED generated columns** (§6d).

### `drayage_request_lanes` — drayage demand
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| batch_id | uuid not null → rate_request_batches(id) | batch is shared, tagged service='drayage' |
| last_cy_cfs | text not null | origin (port / CY area) — lane key part 1 |
| final_destination | text not null | delivery city — lane key part 2 |
| dest_zip | text | text to preserve leading zeros |
| notes | text | request context |
| kind | text default 'new' check new\|refresh | refresh = re-quote a lane we already have (§6b) |
| refresh_of | uuid → drayage_rates(id) | the rate being refreshed (FK added after drayage_rates exists) |
| posted_at | timestamptz default now() | |
| expires_at | timestamptz default now()+10 days | **request TTL** — bounds the ask→answer loop; expired lanes roll off "lanes to fill". Index: expires_at |
| created_at | timestamptz default now() | |

> Two clocks, one removed: the **request** keeps a TTL (flow control, mirrors ocean); the **rate**
> has none — it lives until superseded, with `provided_at`/`confirmed_at` showing age (§6b).

### `drayage_submissions` — acknowledgement (no period dimension)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| lane_id | uuid → drayage_request_lanes(id) | **nullable** — request-less submissions (§6c) |
| forwarder_id | uuid not null → forwarders(id) | isolation |
| provider_id | uuid not null → auth.users(id) | attribution |
| status | text default 'submitted' check submitted\|skipped | |
| skip_reason | text | |
| submitted_at | timestamptz default now() | |

Partial unique (lane_id, forwarder_id) where lane_id not null — one ack per lane per company.
No `period`: a refresh request is a **new lane row**, so uniqueness stays per-lane.

### `drayage_rates` — the rate records (open-ended; generated math)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| submission_id | uuid → drayage_submissions(id) | nullable (proactive rates stand alone, §6c) |
| lane_id | uuid → drayage_request_lanes(id) | nullable |
| forwarder_id | uuid not null → forwarders(id) | isolation |
| provider_id | uuid not null → auth.users(id) | attribution |
| last_cy_cfs | text not null | lane key part 1 |
| final_destination | text not null | lane key part 2 |
| **drayage_lane** | text *generated* | `last_cy_cfs \|\| ' - ' \|\| final_destination` |
| dest_zip | text | |
| rate | numeric(12,2) not null | base linehaul — required |
| fuel_surcharge_pct | numeric(6,4) | as-typed fraction (0.34 = 34%) |
| fuel_surcharge | numeric(12,2) | as-typed nominal $ |
| **fuel_surcharge_amount** | numeric(12,2) *generated* | nominal wins, else rate×pct, else 0 |
| **fuel_surcharge_pct_eff** | numeric(6,4) *generated* | pct wins, else $/rate (guard rate>0), else 0 |
| **total_rate** | numeric(12,2) *generated* | rate + resolved surcharge (accessorials excluded) |
| toll_fee · pre_pull_fee · pier_pass_fee · port_congestion_fee · clean_truck_fee · drop_fee · chassis_fee · chassis_split_fee · demurrage_fee | numeric(12,2) | accessorials — reference only, not in total (step: added port_congestion_fee/chassis_split_fee/demurrage_fee, Jul 2026) |
| min_chassis_days · chassis_days_included | integer | |
| storage_fee_per_day | numeric(12,2) | per-day storage (label "Storage Fee (/Day)") |
| provided_at | date default current_date | Date Received — staleness anchor (§6b) |
| confirmed_at | date default current_date | bumped on re-confirm |
| notes | text | free-form context |
| status | text default 'current' check current\|superseded | supersession, not deletion (§6b) |
| created_at | timestamptz default now() | |

**`drayage_rates_current_uq`** — partial unique (forwarder_id, last_cy_cfs, final_destination)
where status='current': one live rate per company per lane; a new rate first flips the old one to
`superseded`. Indexes: forwarder_id, lane_id.

**Joins (drayage):** lanes.batch_id → rate_request_batches · subs.lane_id → lanes ·
rates.{submission_id → subs, lane_id → lanes} · lanes.refresh_of → rates (circular with lanes ↔
rates, so the FK is added after both tables exist) · both forwarder_id → forwarders,
provider_id → auth.users.

---

## 5. Notifications (audit = prefill memory)

### `notifications` — one row per send action
id PK · kind request|reminder · triggered_by → auth.users · period · **service** text default
'ocean' check ocean|drayage (step 1) · created_at.

### `notification_recipients` — one row per company per send → per analyst (v2)
id PK · notification_id → notifications (cascade) · forwarder_id → forwarders · email (snapshot) ·
lane_count · status queued|sent|failed · error · sent_at · **analyst_id** → profiles(id) (step 1;
written per-analyst from notify v2 on). Indexes: forwarder_id, analyst_id.

**Memory rule (DRAY.md §7e):** the Send modal's prefill for (service, company) = the `analyst_id`s
on the **latest** notification of that service that included that company. No memory → blank; tags
are guidance only.

---

## 6. API functions (SECURITY DEFINER, service_role-only)

All four read `auth.users` (emails) — which browsers can never touch — so they are `SECURITY
DEFINER` with `search_path = public, auth`, `revoke`d from public/anon/authenticated and granted
**only to `service_role`** (the Edge Function). See DRAY.md §2d/§7b.

| Function | In | Out | Used by |
|---|---|---|---|
| `get_forwarder_recipients(uuid[])` | company ids | (forwarder_id, name, email) — flag-filtered | **live ocean Send** (notify v1). Kept until notify v2 is verified; then a cleanup migration may drop it |
| `get_service_directory(uuid[], text)` | company ids + service | one row per analyst of each company offering the service: id, name, analyst id/name, email, **tag_ocean, tag_drayage** | notify v2 `preview` — the modal's directory + chips. Tags are data, not filters |
| `get_recipients_by_analyst(uuid[])` | checked analyst ids | (forwarder_id, name, analyst_id, email) | notify v2 send — resolves exactly the humans the sender checked |
| `current_role_is` / `my_forwarder` | — | boolean / uuid | RLS (see §1; these two ARE callable by clients via policies) |

### `graph_credentials`
Microsoft Graph mail credentials for the `notify-forwarders` Edge Function (`ALERTS.md`). Service
role only; no client policies.

---

## 7. RLS summary (who sees what)

| Table | forwarder (analyst) | internal |
|---|---|---|
| forwarders | read (names/labels) | read |
| profiles | own row | own row (+ SQL editor for admin) |
| forwarder_services | own company's rows | all |
| rate_request_lanes / drayage_request_lanes | read all (shared demand pool) | full manage |
| rate_submissions / drayage_submissions | full manage, own company only | read lane-linked; insert/update (Upload on behalf) |
| rates / drayage_rates | full manage, own company only | read all; insert (Upload on behalf); update (drayage supersession) |
| notifications / notification_recipients | none | read |
| graph_credentials | none | none (service role only) |

The isolation predicate is everywhere the same: `forwarder_id = my_forwarder()` — company-level,
service-agnostic (DRAY.md §7c: notification targeting never restricts access).

---

## 8. Change log

| Date | Change |
|---|---|
| Jun 12, 2026 | Ocean schema + RLS as documented in `MEMORY.md` §2–§3 |
| Jun 17–22, 2026 | Role rename internal/forwarder · Upload-on-behalf policies · internal reads ALL rates |
| Jun 21, 2026 | notify-forwarders: notifications/notification_recipients, forwarders.active, receives_rate_requests, get_forwarder_recipients (migration `20260621120000`) |
| Jul 10, 2026 | rates.contract (migration `20260710120000`) |
| Jul 17, 2026 | **Step 1:** forwarder_services (+ocean backfill, RLS) · profiles.receives_drayage_requests · batches/notifications.service · notification_recipients.analyst_id · get_service_directory + get_recipients_by_analyst |
| Jul 17, 2026 | **Step 4:** drayage_request_lanes / drayage_submissions / drayage_rates (+ generated columns, current-rate unique index, RLS) — SQL in DRAY.md §9b step 4 walkthrough |
| Jul 21, 2026 | drayage_rates: + port_congestion_fee, chassis_split_fee, demurrage_fee (accessorials, reference-only) |
