# RatesApp — Session Handoff (Database & Functionality)

**Updated:** June 12, 2026
**Purpose:** Continuity doc for picking the project up on another machine. Captures the
**as-deployed** Supabase schema, RLS, and the design decisions + features built this session.

> ⚠️ **Schema source of truth = this file + the live Supabase project.** There are **no
> migration files** in the repo (schema was run by hand in the Supabase SQL editor).
> `MOCKDEPLOY.md §4/§5` and `PROVIDER_VIEW_MODEL.md` are now **partially stale** — see
> "Divergences" below. When in doubt, trust this doc.

> 🔁 **Role rename (June 17, 2026):** roles are now **`internal`** (was `requester`) and
> **`forwarder`** (was `provider`). Frontend is migrated (with a `normalizeRole` back-compat
> shim in `src/lib/roles.js`). **The live DB migration SQL must still be run** — see the
> role-rename plan / the migration script that updates `profiles.role`, the CHECK constraint,
> the 5 role-referencing RLS policies, and `auth.users` `user_metadata.role`. The DDL/RLS
> below already reflect the **new** values.

---

## 1. Divergences from the planning docs (important)

The deployed schema differs from `MOCKDEPLOY.md §4/§5` in these ways:

| Planning docs say | Actually deployed |
|---|---|
| table `suppliers`, FK `profiles.supplier_id` | **`forwarders`**, FK **`profiles.forwarder_id`** |
| isolation keyed on `provider_id` (the user) | isolation keyed on **`forwarder_id`** (the company); `provider_id` kept only for attribution |
| `rate_submissions`/`rates` have no `forwarder_id` | both have **`forwarder_id uuid not null`** |
| `UNIQUE(lane_id, provider_id, period)` | **`UNIQUE(lane_id, forwarder_id, period)`** |
| `rates.pol`/`rates.fd` are `NOT NULL` | **both nullable** (to allow FD-less independent rates) |
| requester RLS scoped to own batches | requester RLS is **team-wide** (`current_role_is('internal')`) |

Why: **forwarders are companies with multiple analysts who share visibility**, and
**requesters are one internal team who all see the shared demand pool.** See §4.

---

## 2. As-deployed schema (full DDL)

```sql
-- ── reference: forwarder companies ────────────────────────────────────────
create table forwarders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ── identity bridge: auth user → role + forwarder ─────────────────────────
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('internal','forwarder')),
  forwarder_id uuid references forwarders(id),          -- null for internal
  full_name    text,
  company      text,
  created_at   timestamptz not null default now()
);

-- ── demand: a posting action ──────────────────────────────────────────────
create table rate_request_batches (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);

-- ── demand: the lane templates (10-day TTL, periods) ──────────────────────
create table rate_request_lanes (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references rate_request_batches(id),
  pol             text not null,
  fd              text not null,
  container_type  text,
  container_count integer,
  posted_at       timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '10 days'),
  period          integer not null default 1,
  created_at      timestamptz not null default now()
);
create index idx_lanes_expires on rate_request_lanes(expires_at);
create index idx_lanes_pol_fd  on rate_request_lanes(pol, fd);

-- ── supply: the acknowledgement (submitted | skipped) ─────────────────────
create table rate_submissions (
  id            uuid primary key default gen_random_uuid(),
  lane_id       uuid references rate_request_lanes(id),    -- nullable (independent)
  forwarder_id  uuid not null references forwarders(id),   -- company: isolation + ack identity
  provider_id   uuid not null references auth.users(id),   -- analyst: attribution only
  period        integer,                                   -- nullable (independent)
  status        text not null default 'submitted' check (status in ('submitted','skipped')),
  skip_reason   text,                                      -- null for now (capture deferred)
  submitted_at  timestamptz not null default now()
);
-- ONE acknowledgement per (lane, forwarder, period)
create unique index idx_submissions_unique_linked
  on rate_submissions(lane_id, forwarder_id, period) where lane_id is not null;
create index idx_submissions_forwarder on rate_submissions(forwarder_id);
create index idx_submissions_lane      on rate_submissions(lane_id);

-- ── supply: append-only, self-contained rate rows ─────────────────────────
create table rates (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid references rate_submissions(id),      -- nullable (independent)
  lane_id       uuid references rate_request_lanes(id),    -- nullable (independent)
  forwarder_id  uuid not null references forwarders(id),   -- company: isolation + bid identity
  provider_id   uuid not null references auth.users(id),   -- analyst: attribution
  period        integer,
  pol           text,            -- NULLABLE (independent rates may lack it)
  pod           text,
  last_cy       text,
  fd            text,            -- NULLABLE (FD is a request guide, not part of a rate)
  carrier       text,
  rate_amount   numeric,
  free_days     integer,
  currency      text not null default 'USD',
  transit_days  integer,
  valid_from    date,
  valid_until   date,
  notes         text,
  created_at    timestamptz not null default now()
);
create index idx_rates_forwarder on rates(forwarder_id);
create index idx_rates_lane      on rates(lane_id);
create index idx_rates_pol_fd    on rates(pol, fd);
```

### Helpers (SECURITY DEFINER)
```sql
create or replace function current_role_is(target text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = target);
$$;

create or replace function my_forwarder()
returns uuid language sql stable security definer set search_path = public as $$
  select forwarder_id from profiles where id = auth.uid();
$$;
```

---

## 3. RLS policies (as deployed)

RLS is **enabled on all 6 tables**. Policies:

```sql
-- profiles: read your own
create policy "own profile" on profiles
  for select using (id = auth.uid());

-- forwarders: any authenticated user reads company names (labels)
create policy "read forwarders" on forwarders
  for select using (auth.role() = 'authenticated');

-- batches: requester TEAM manages all; insert/update stamps the creator
create policy "requester batches" on rate_request_batches
  for all using (current_role_is('internal'))
  with check (requester_id = auth.uid() and current_role_is('internal'));

-- lanes: requester TEAM manages all; providers read ALL lanes (shared demand)
create policy "requester lanes" on rate_request_lanes
  for all using (current_role_is('internal'))
  with check (current_role_is('internal'));
create policy "providers read lanes" on rate_request_lanes
  for select using (current_role_is('forwarder'));

-- submissions: the COMPANY sees/manages its acks; insert stamps the acting analyst
create policy "forwarder submissions" on rate_submissions
  for all using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder() and provider_id = auth.uid());
create policy "requester reads submissions" on rate_submissions
  for select using (current_role_is('internal') and lane_id is not null);

-- rates: THE isolation line is the COMPANY; requester team reads lane-linked rates only
create policy "forwarder rates" on rates
  for all using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder() and provider_id = auth.uid());
create policy "requester reads rates" on rates
  for select using (current_role_is('internal') and lane_id is not null);
```

**Net effect:** forwarder A's analysts share everything and can't see forwarder B; the
requester team sees all lanes + all lane-linked rates/skips; independent rates
(`lane_id IS NULL`) stay private to the forwarder.

---

## 4. Key design decisions

1. **Company-level provider sharing.** Supply identity is the **forwarder** (`forwarder_id`),
   not the analyst. Multiple analysts per forwarder share visibility (View 1 anti-join,
   acks, rates, bid identity all key on `forwarder_id`). `provider_id` = which analyst acted.
2. **Requester team pool.** Multiple internal requesters all see + manage the shared demand
   (team writes). A re-post of an already-active lane is intended to **update it in place**
   (reset `posted_at`/`expires_at`, bump `period`) — app logic NOT yet built.
3. **Two clocks.** Lane TTL = **10 days** (`expires_at`, drives "Lanes to fill"); rate
   validity = `valid_until` (drives "Active Rates"). No third clock.
4. **Acknowledgement model.** `rate_submissions` = "this forwarder acted on this lane."
   `status='submitted'` (1+ rates) or `status='skipped'` (0 rates). One per
   `(lane, forwarder, period)`.
5. **Independent rates.** Rates can exist with no request (`lane_id/submission_id/period`
   all null). Requesters do NOT see them (RLS `lane_id is not null`); the forwarder does
   (Active Rates). A rate = POL, POD, Last CY, Rate, Free Days, Carrier, Valid Until, Remarks.
   FD/container type/count are **request guides only**, not part of a rate.
6. **Append-only storage.** Rates are never deleted on re-submit (history preserved);
   display is "latest" (dedup not yet built).
7. **Naming:** workspace label = `PTP` for requesters, forwarder name for providers.

---

## 5. Functionality built this session (frontend)

- **Auth:** `LoginPage` (email/password `signInWithPassword`); session gate in `App.jsx`;
  wired Sign-out in `TopNav`. (Production target is magic link — not yet swapped.)
- **Requester:**
  - `NewRateRequest` posts batch + lanes (real `requester_id`); CSV upload; dedup.
  - **Open Requests** page (`OpenRequests.jsx` + `fetchOpenRequests`) — active lanes, days-left, rate count.
  - **Active Rates** page (`ReceivedRates.jsx` + `fetchReceivedRates`) — rates received on team lanes.
- **Provider:**
  - `SubmitRates` unified grid — preloads active lanes (View 1) OR a blank row; Add Row + CSV
    for **independent** rates; POL editable, FD/container read-only guides.
  - `submissionService`: `fetchActiveLanes` (anti-join excludes acted lanes, forwarder-keyed),
    `submitRates` (lane-linked + independent), `fetchActiveRates`, `skipLane`, `unskipLane`.
  - **Active Rates** page (`ActiveRates.jsx`) — the forwarder's live rates.
  - **Skip:** the per-row trash icon persists a `skipped` ack (lane-linked rows) with an
    **Undo** toast; free rows just drop locally.
- **Layout/UI:** full-width grids/tables, centered dashboards; copy cleanups (kickers,
  "Final Destination", "# of Free Days", container types `20' GP / 40' GP / 40' HC / 45' HC`).

---

## 6. Deferred / not yet built (next steps)

- **Dashboard stat cards** still hardcoded `—` (fetches exist; wire them).
- **Requester roster** (PVM §6): per-lane "submitted / skipped+reason / no-response" view.
- **Skip reason capture** + a **"Skipped" tab** to browse/un-skip after the toast window
  (`unskipLane` already exists).
- **7-day auto-skip rule** (user spec): on re-post, auto-skip forwarders whose existing rate
  has >7 days validity; reopen for those ≤7 days. App-layer; no schema change needed.
- **Re-post / lane extension** in-place update logic (period bump).
- **Coverage filtering** (per-forwarder lane masking) — designed in **`COVERAGE_MODEL.md`**;
  needs a `forwarder_coverage` table + location normalization. Not built.
- **Canonical normalization** (UN/LOCODE / SCAC, `locations`/`carriers` tables) — PVM §7a.
- **Latest-per-routing dedup** on Active Rates; **magic-link auth**; **Cloudflare ZT** gating;
  route guards; env-gating the dev role toggle.

---

## 7. Onboarding / seeding notes

- A user works only if: (a) a Supabase **auth user** exists with `user_metadata.role`
  (`internal`|`forwarder`), AND (b) a matching **`profiles`** row (`id` = auth uid, same
  `role`, `forwarder_id` set for forwarders). Keep `user_metadata.role` ↔ `profiles.role` in sync.
- Seed forwarders, then profiles. The SQL editor bypasses RLS (service role), which is why
  there are no insert policies on `forwarders`/`profiles`.
- Adding a forwarder/analyst later = data-only (insert forwarder + auth user + profile),
  no code/schema change.

---

## 8. Env / deploy

- Local: `.env.local` (gitignored) with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
  **On the other machine you must recreate `.env.local`** (it does NOT sync via git).
- Vercel: same two vars in Project → Settings → Env Vars; they're **inlined at build time**,
  so set them BEFORE building and redeploy after any change.
- Anon key is public (RLS protects). Never put `service_role` in a `VITE_` var.
- Deploys: push to `main` → Vercel auto-builds. Repo: `github.com/swtreflips/RatesApp`.

---

## 9. Key files

```
src/lib/supabase.js                                  supabase client
src/app/providers/AuthProvider.jsx                   session + role + forwarderName
src/app/App.jsx / LoginPage.jsx / Shell.jsx          gate + login + layout
src/features/requester/services/rateRequestService.js  postRateRequestBatch, fetchReceivedRates, fetchOpenRequests
src/features/requester/pages/                         NewRateRequest, OpenRequests, ReceivedRates
src/features/provider/services/submissionService.js  fetchActiveLanes, submitRates, fetchActiveRates, skipLane, unskipLane
src/features/provider/pages/                          SubmitRates, ActiveRates
```

Design docs in repo: `PROVIDER_VIEW_MODEL.md` (provider model; note user-keyed parts are
superseded by company-keyed — see §1/§4), `COVERAGE_MODEL.md`, `MOCKDEPLOY.md`,
`NEXTSTEPS.md`, `dataArchitecture.md`.
