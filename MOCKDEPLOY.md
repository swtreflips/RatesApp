# MOCKDEPLOY — Internal Production Dress Rehearsal

**Status:** runbook for the first real deployment of RatesApp, used internally
before onboarding actual freight forwarders.
**Created:** June 11, 2026

This is a **mock deployment only in who uses it** — the infrastructure, schema,
and security are the real, final production setup. Three internal people exercise
the full workflow first to surface gaps and performance issues. When the app meets
expectations, onboarding real forwarders is **data-only** (see §8).

> This document supersedes the DigitalOcean-droplet + Cloudflare-Tunnel assumption
> in `TESTING_AND_ACCESS_PLAN.txt`. The rehearsal runs on **Vercel**, gated by
> **Cloudflare Zero Trust** on a custom domain.

---

## 1. Purpose & the data-only principle

**Goal:** run a production-grade deployment where Jordan acts as the requester and
Silvia + Luis act as forwarders — uploading the same Excel rate sheets suppliers
send today — so we can spot gaps before real forwarders are involved.

**The principle that shapes everything below:** flipping to a real forwarder later
must be **data-only**:

1. `insert` a `suppliers` row,
2. create a Supabase auth user + `insert` a `profiles` row,
3. add their email to the Cloudflare Access policy.

**No schema migration. No redeploy. No code change.** For that to hold, three
things must be true from day one — and the build order in §6 proves each *early*,
before any polish work that a late surprise could invalidate:

- **Auth** identifies the user and carries their role.
- **RLS** isolates each forwarder's rates by `provider_id = auth.uid()` — so the
  same policy that protects Silvia from Luis automatically protects every real
  forwarder added later, with zero new code.
- **Schema** already has `suppliers` + `profiles`, so onboarding is an `insert`.

---

## 2. Target architecture (final shape, not throwaway)

```
   Browser
     │
     ▼
   Cloudflare  ── DNS proxied (orange cloud) + Zero Trust Access gate
     │            "Is this email allowed to reach the app at all?"
     ▼
   Vercel      ── static React SPA (Vite build), Deployment Protection ON
     │            serves files only; no server-side code
     ▼
   Supabase    ── Postgres + Auth + RLS, called DIRECTLY from the browser
                  "Who are you / what role / which rows may you touch?"
```

Three **independent** access layers (same mental model as
`TESTING_AND_ACCESS_PLAN.txt` §2 — keep them distinct):

| Layer | Controls | In this rehearsal |
|-------|----------|-------------------|
| Cloudflare Zero Trust | who can *reach* the app | allowlist the 3 emails |
| Supabase Auth | *who you are* + your role | magic-link (passwordless) login |
| Supabase RLS | *what data* you can read/write | per-forwarder isolation |

Why each is needed even with only 3 trusted users: the Supabase anon key ships in
the browser, so without RLS anyone who reaches the app could query any row from
the dev console. Cloudflare keeps strangers out; RLS keeps forwarders out of each
other's pricing.

### Auth method & the two-gate model

App identity is **Supabase magic link** (passwordless): the user enters their email,
Supabase emails a one-time link, clicking it returns to the app and establishes the
session. Code is `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })`;
`AuthProvider` already reacts to the resulting `onAuthStateChange`, and **RLS, schema,
roles, and `profiles` are unaffected by the auth *method*** — they key on `auth.uid()`
either way.

The user passes **two independent gates**: Cloudflare ZT (reachability) then Supabase
magic link (identity + role). That redundancy is intentional and robust.

> ⚠️ **Do not collapse them.** Cloudflare's `Cf-Access-Jwt-Assertion` header is *not* a
> Supabase session — if the app "trusted" Cloudflare's identity and skipped Supabase
> login, `auth.uid()` would be null and **RLS would stop protecting the data**. Keep the
> two gates separate; RLS stays the real data boundary.

**Optional end state (later):** point both layers at one IdP (e.g. Google Workspace) —
Cloudflare gates by Google, Supabase uses `signInWithOAuth({ provider: 'google' })`. With
a shared browser session both prompts become click-throughs (true SSO feel), same RLS
underneath. Not needed for the rehearsal.

**Magic-link requirements:** in Supabase → Auth → URL Configuration, set the **Site URL**
and add **Redirect URLs** for `http://localhost:5173` (dev) and the production domain;
links silently fail if the return URL isn't allowlisted. The built-in email is
rate-limited (a handful/hour) — fine for 3 users; add custom SMTP for real onboarding.
Note the magic-link return lands on the Cloudflare-gated domain, so the user must already
have passed the CF gate (they did, to request the link) for the callback to complete.

---

## 3. Users, roles & companies (provisioning data)

| Name | Company | Email | Role |
|------|---------|-------|------|
| Jordan | Prime Time Packaging | `jordan@ptpbags.com` | requester / internal |
| Silvia | Tanera Transport | `silvian@primetimepackaging.com` | freight forwarder |
| Luis | Constellation Logistics | `luismht@primetimepackaing.com` | freight forwarder |

> ⚠️ **Verify these strings before provisioning — they are load-bearing** (used
> verbatim in Supabase auth users *and* the Cloudflare Access policy; a typo locks
> someone out):
> - Two different domains are in play: `ptpbags.com` (requester) vs
>   `primetimepackaging.com` (forwarders). Confirm that's intentional.
> - `luismht@primetimepackaing.com` looks like it may be missing a "g"
>   (`primetimepacka**g**ing.com`). Confirm the exact spelling.

Roles: the app currently reads the role from `user_metadata.role`
([AuthProvider.jsx](src/app/providers/AuthProvider.jsx)). Set it there **and**
store it in `profiles.role` (RLS reads `profiles`). Keep the two in sync.

---

## 4. Schema (full SQL — onboarding-safe)

Run this in the Supabase SQL editor. Tables follow `dataDesign.txt` Part 2 (with
the June 10 updates: 10-day TTL, `status`/`skip_reason`, nullable `lane_id`/
`period` for independent rates) **plus** `suppliers` + `profiles`.

```sql
-- ── reference: forwarder companies ────────────────────────────────────────
create table suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ── identity bridge: auth user → role + supplier ──────────────────────────
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('internal','forwarder')),
  supplier_id uuid references suppliers(id),          -- null for internal
  full_name   text,
  company     text,
  created_at  timestamptz not null default now()
);

-- ── demand: a posting action ──────────────────────────────────────────────
create table rate_request_batches (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);

-- ── demand: the lane templates (10-day TTL, periods) ──────────────────────
create table rate_request_lanes (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references rate_request_batches(id),
  pol             text not null,
  pod             text,                                      -- optional: requester-specified discharge port
  last_cy         text,                                      -- optional: requester-specified last container yard
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
  lane_id       uuid references rate_request_lanes(id),   -- nullable (independent)
  provider_id   uuid not null references auth.users(id),
  period        integer,                                  -- nullable (independent)
  status        text not null default 'submitted' check (status in ('submitted','skipped')),
  skip_reason   text,
  submitted_at  timestamptz not null default now()
);
create unique index idx_submissions_unique_linked
  on rate_submissions(lane_id, provider_id, period)
  where lane_id is not null;
create index idx_submissions_provider on rate_submissions(provider_id);
create index idx_submissions_lane     on rate_submissions(lane_id);

-- ── supply: normalized rate rows (append-only, self-contained) ────────────
create table rates (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid references rate_submissions(id),     -- nullable (independent)
  lane_id         uuid references rate_request_lanes(id),   -- nullable (independent)
  provider_id     uuid not null references auth.users(id),
  period          integer,
  pol             text not null,
  pod             text,
  last_cy         text,
  fd              text not null,
  carrier         text,
  rate_amount     numeric,
  free_days       integer,        -- "# of Free Days" from the provider grid
  currency        text not null default 'USD',
  transit_days    integer,
  valid_from      date,
  valid_until     date,
  notes           text,           -- "Remarks"
  created_at      timestamptz not null default now()
);
create index idx_rates_lane     on rates(lane_id);
create index idx_rates_provider on rates(provider_id);
create index idx_rates_pol_fd   on rates(pol, fd);
```

> Note vs current code: [rateRequestService.js](src/features/requester/services/rateRequestService.js)
> only inserts `batch_id, pol, fd, container_type, container_count`. The TTL/period
> columns above default themselves, so existing inserts keep working — but gap
> **G6** aligns the service when read pages are built. The `rates` table adds
> `free_days` to match the provider grid's "# of Free Days" column.

---

## 5. RLS policies (each forwarder sees only their own rates)

```sql
-- Helper: current user's role (avoids repeating the subquery)
create or replace function current_role_is(target text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = target);
$$;

alter table suppliers            enable row level security;
alter table profiles             enable row level security;
alter table rate_request_batches enable row level security;
alter table rate_request_lanes   enable row level security;
alter table rate_submissions     enable row level security;
alter table rates                enable row level security;

-- profiles: a user can read their own profile
create policy "own profile" on profiles
  for select using (id = auth.uid());

-- suppliers: any authenticated user may read company names (labels)
create policy "read suppliers" on suppliers
  for select using (auth.role() = 'authenticated');

-- batches: requester manages their own
create policy "requester batches" on rate_request_batches
  for all using (requester_id = auth.uid()) with check (requester_id = auth.uid());

-- lanes: requester manages own; providers read ALL lanes (demand is shared)
create policy "requester lanes" on rate_request_lanes
  for all using (
    batch_id in (select id from rate_request_batches where requester_id = auth.uid())
  ) with check (
    batch_id in (select id from rate_request_batches where requester_id = auth.uid())
  );
create policy "providers read lanes" on rate_request_lanes
  for select using (current_role_is('forwarder'));

-- submissions: a provider sees/writes ONLY their own; requester reads those on their lanes
create policy "provider own submissions" on rate_submissions
  for all using (provider_id = auth.uid()) with check (provider_id = auth.uid());
create policy "requester reads submissions" on rate_submissions
  for select using (
    lane_id in (
      select l.id from rate_request_lanes l
      join rate_request_batches b on b.id = l.batch_id
      where b.requester_id = auth.uid()
    )
  );

-- rates: THE isolation line — a provider sees/writes ONLY their own rows
create policy "provider own rates" on rates
  for all using (provider_id = auth.uid()) with check (provider_id = auth.uid());
create policy "requester reads rates" on rates
  for select using (
    lane_id in (
      select l.id from rate_request_lanes l
      join rate_request_batches b on b.id = l.batch_id
      where b.requester_id = auth.uid()
    )
  );
```

The two `provider own ...` policies are what stop Silvia from ever querying Luis's
pricing — even from the browser console. This same policy covers every real
forwarder added later, which is what makes onboarding code-free.

---

## 6. Readiness gaps — code to build before the deploy works

The current app **cannot** complete the loop yet (no login, no DB writes, mock
provider grid). Build these in order; the ordering proves the risky integration
first so finished UI never has to be redone.

| # | Gap | Why first / notes |
|---|-----|-------------------|
| **G1** | **Supabase live + RLS verified.** Create project, run §4 + §5 SQL, wire `.env`, then manually create 2 forwarder rows and confirm in the SQL console / two browser sessions that each sees only their own `rates`. | Proves the whole isolation premise before any UI is built on top of it. If RLS is wrong, everything else is at risk. |
| **G2** | **Real auth.** Login page calling `supabase.auth.signInWithOtp` (magic link — passwordless; see §2 "Auth method"); a "check your email" + "completing sign-in…" state; wire the dead sign-out button in [TopNav.jsx](src/components/shell/TopNav.jsx); gate the dev role toggle behind an env flag (`VITE_ENABLE_DEV_ROLE`); redirect unauthenticated users to login. Role already flows from the session in [AuthProvider.jsx](src/app/providers/AuthProvider.jsx). | No real users without it; RLS keys off `auth.uid()`. *(STEP 0 may use password locally for fast loop iteration; production is magic link.)* |
| **G3** | **Provider grid saves.** Replace the mock submit in [SubmitRates.jsx](src/features/provider/pages/SubmitRates.jsx) with a `submissionService` that writes one `rate_submissions` + N `rates` (dataDesign Step 4), stamping `provider_id` from the session. Load real active lanes (PROVIDER_VIEW_MODEL §2 query) instead of the seeded mock rows. | First real end-to-end write — the core risk. |
| **G4** | **.xlsx upload.** Add SheetJS (`npm i xlsx`) to the provider grid so the forwarder files drop in directly; map sheet columns → rate fields; reuse the dedup pattern from [NewRateRequest.jsx](src/features/requester/pages/NewRateRequest.jsx). | This is the actual day-one workflow (Silvia/Luis paste supplier Excel). |
| **G5** | **Requester read pages.** Open Requests list (active lanes + counts), Active Rates received (per-lane rates, cheapest-first), dashboard counts — replacing the placeholders in [RequesterRoot.jsx](src/features/requester/pages/RequesterRoot.jsx). | Closes the loop so Jordan can see what came back. |
| **G6** | Align `rateRequestService` with TTL/period/container columns; add a data-fetching pattern (React Query or hooks per the assessment docs). | Cleanup once reads exist. |

**Explicitly deferred (known limitation):** canonical port/carrier normalization
(UN/LOCODE, SCAC — see the data-model notes). The mock tolerates free text, so
two spellings of the same routing read as two different rates and bid-evolution
won't group. Acceptable for the rehearsal; flag it when reviewing results.

---

## 7. Deployment runbook (ordered checklist)

### Step 0 — Confirm inputs
- [ ] Exact emails verified (§3 ⚠️).
- [ ] Custom domain chosen and already on Cloudflare (DNS managed there).

### Step 1 — Supabase
- [ ] Create a Supabase project (free tier); note Project URL + anon key
      (Settings → API).
- [ ] SQL editor → run §4 (schema), then §5 (RLS).
- [ ] Authentication → Users → **Add user** ×3 (the §3 emails). Magic link is
      passwordless, so a password is optional — leave unset or use a throwaway.
- [ ] Authentication → URL Configuration → set **Site URL** and add **Redirect URLs**:
      `http://localhost:5173` and the production domain (add the domain once chosen in
      Step 4). Magic links fail silently if the return URL isn't listed.
- [ ] For each user, set `user_metadata`:
      `{ "role": "internal", "full_name": "Jordan" }` /
      `{ "role": "forwarder", "full_name": "Silvia" }` etc.
- [ ] SQL: insert the two `suppliers`, then a `profiles` row per user linking
      `id` (from auth.users), `role`, and `supplier_id` (forwarders only):
      ```sql
      insert into suppliers (name) values ('Tanera Transport'), ('Constellation Logistics');
      insert into profiles (id, role, supplier_id, full_name, company) values
        ('<jordan-uuid>', 'requester', null, 'Jordan', 'Prime Time Packaging'),
        ('<silvia-uuid>', 'provider', (select id from suppliers where name='Tanera Transport'),       'Silvia', 'Tanera Transport'),
        ('<luis-uuid>',   'provider', (select id from suppliers where name='Constellation Logistics'), 'Luis',   'Constellation Logistics');
      ```

### Step 2 — App environment
- [ ] Local `.env.local` (gitignored): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
      (see [.env.example](.env.example)).
- [ ] Add the same two vars in Vercel → Project → Settings → Environment Variables
      (they're inlined at build time — set before the production build).

### Step 3 — Build the readiness gaps
- [ ] G1 → G5 from §6 (G6 optional for first cut). Do **not** deploy publicly
      until G1's isolation check passes.

### Step 4 — Vercel
- [ ] `vercel link --repo` (links this GitHub repo; reliable matching). *(per the
      `deploy-to-vercel` skill: linked + git remote → git-push deploys.)*
- [ ] Push to `main` → preview build; verify the deep-link refresh works
      (`vercel.json` rewrite already handles SPA routing).
- [ ] Promote to production.
- [ ] Settings → Deployment Protection → **enable** so the raw `*.vercel.app` URL
      requires auth (see §9 caveat about plan tier).

### Step 5 — Cloudflare Zero Trust
- [ ] Add the custom domain in Vercel → Domains; create the CNAME in Cloudflare
      (proxied / orange cloud) pointing at Vercel.
- [ ] Zero Trust → Access → Applications → add a self-hosted app for the domain.
- [ ] Policy: **Allow**, Include → Emails → the 3 addresses from §3.
- [ ] Test: the domain shows the Cloudflare login first; a non-listed email is
      rejected; confirm the bare `*.vercel.app` URL does **not** bypass the gate.

### Step 6 — Smoke test
Run the §10 checklist.

---

## 8. The data-only flip to real forwarders

When the rehearsal passes, onboard a real forwarder with **only** these actions —
no code, no schema change, no redeploy:

1. **Supabase:** `insert into suppliers (name) values ('Real Forwarder Co');`
2. **Supabase:** Authentication → Add user (their email; magic link needs no
   password); set `user_metadata.role = 'forwarder'`.
3. **Supabase:** `insert into profiles (id, role, supplier_id, full_name, company)
   values ('<their-uuid>', 'provider', '<supplier-uuid>', '...', 'Real Forwarder Co');`
4. **Cloudflare:** add their email to the Access policy.

The existing RLS policies (§5) immediately isolate their rates. Widening access
later (e.g. a whole company domain) is a Cloudflare policy edit, also code-free.

---

## 9. Costs & caveats

- **Supabase** free tier is enough for the rehearsal.
- **Cloudflare Zero Trust (Access)** is free up to 50 users.
- **Vercel** Hobby is free, but ⚠️ **Deployment Protection that blocks the raw
  `*.vercel.app` URL is a Pro feature.** Options:
  - **Pro (recommended for a true gate):** enable Deployment Protection so only
    the Cloudflare-fronted domain is the way in.
  - **Stay on Hobby:** the custom domain is gated by Cloudflare, but the
    `*.vercel.app` URL stays publicly reachable (and RLS still protects the data —
    a logged-out visitor sees only the login screen). Acceptable risk for an
    internal rehearsal if you don't share the raw URL; decide explicitly.
- The Supabase **anon key is public by design** — never put the `service_role`
  key in a `VITE_` variable. RLS is the real protection.

---

## 10. Smoke test — proves the two core promises

Run after Step 5. This is the gate before trusting the app with competing parties.

**A. End-to-end loop** *(each login is a magic link: enter email → click the emailed link)*
1. Log in as **Jordan** → New Rate Request → add a couple of lanes → Send Request.
2. Log in as **Silvia** → Open Requests → those lanes appear → upload her `.xlsx`
   of rates → Submit.
3. Log in as **Luis** → upload his own `.xlsx` for the same lanes → Submit.
4. Back as **Jordan** → the received rates show **both** Silvia's and Luis's.

**B. Isolation (the most important check)**
5. As **Silvia**, confirm Luis's rates are **not** visible anywhere (UI *and* a
   `select * from rates` in the browser console returns only her rows).
6. Repeat as **Luis**. If either can see the other's pricing, **stop** — RLS is
   misconfigured (§5).

**C. Edge**
7. Visiting the custom domain prompts the Cloudflare Access login.
8. A non-allowlisted email is rejected by Cloudflare.
9. The raw `*.vercel.app` URL does not bypass the gate (or, on Hobby, at least
   shows only the login screen with no data — per §9).

When A, B, and C pass, the rehearsal infrastructure is trustworthy and onboarding
real forwarders is the §8 data-only flip.
