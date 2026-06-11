# NEXTSTEPS — Implementation Backlog (pre-deploy)

**Status:** the pending-features list to take RatesApp from its current mock state to the
MOCKDEPLOY dress rehearsal. Planning only — nothing here is implemented yet.
**Created:** June 11, 2026
**Source of truth:** data model in `dataDesign.txt` + `PROVIDER_VIEW_MODEL.md` + `LANE_LIFECYCLE_AND_BIDDING_MODEL.txt`; deployment in `MOCKDEPLOY.md` (full SQL/RLS in §4–§5, runbook in §7).

This refines MOCKDEPLOY §6: that gap list predates the finalized **skip flow**, the
provider **Active-Rates view**, and **append-on-resubmit**, all of which are required here.

Legend: ✅ built · 🟡 partial / mock · ⬜ missing.

---

## Development stages (macro map)

Build in **vertical slices, not horizontal layers** — each feature travels
UI → service → database → RLS as one unit, starting from the thinnest end-to-end
slice (STEP 0) and widening.

| Stage | Goal | Done when | Status |
|-------|------|-----------|--------|
| **0 · Model** | Domain + data model + the two role workflows | The 4-table model and both views are settled | ✅ done |
| **1 · UI skeleton (mock)** | Every key screen exists with fake data | You can click the whole app; you know what data each screen needs | ✅ done |
| **2 · Prove the vertical slice** | Live DB + 4 tables + RLS + minimal auth + one real write + one real read + **isolation check** | STEP 0 (S0.1–S0.7) is green | ⏭️ **next** |
| **3 · Build features for real (breadth)** | Replace each mock/placeholder with real service + query, one slice at a time | Provider submit/skip/active-rates + requester read pages + dashboards run on real data | ⬜ (§A2/§A3) |
| **4 · Deploy & gate** | Vercel + domain + Cloudflare ZT + magic link, validated in prod | MOCKDEPLOY smoke test passes on the real domain | ⬜ (MOCKDEPLOY) |
| **5 · Security hardening** | Everything beyond RLS | Route guards, dev-toggle gated, input/normalization validation, error handling, monitoring, backups | ⬜ (§A1/§A0/§C) |
| **6 · Polish & scale** | The deferred value features | Canonical normalization, bid-evolution display, full-history, realtime, perf | ⬜ (§C) |

> **Two things do NOT run last.** (1) *Foundational* security — RLS data-isolation — is
> proven **early**, in Stage 2 (the S0.7 check), not at the end; only security *hardening*
> is a late stage. (2) *Deployment* is **continuous** from Stage 2 on (Vercel + Supabase
> make it ~free); Stage 4 only formalizes the production gating (domain + Cloudflare + magic
> link). So the real order is: model → UI skeleton → **prove slice (incl. RLS)** → build
> slices (deploying continuously) → formalize gating → harden → polish.

## Operating rhythm — one vertical slice per feature

Once the Stage 2 slice is proven, run **Stage 3 as repeated vertical slices** — never batch
all-UI-then-all-data again. Per feature:

1. **Pick one feature** (e.g. "provider skip").
2. **Build its slice:** UI control → service function → query → **confirm RLS still isolates**.
3. **Verify against real data** with two accounts (a provider and the requester, or two providers).
4. **Push** (auto-deploys to the preview/prod environment).
5. **Next feature.**

This keeps **security and deployment touched on every slice** instead of deferred to stages
you might run out of runway for. A feature isn't "done" until step 3 passes on real data.

---

## STEP 0 — Prove the core loop FIRST (smallest slice)

**Do this before anything in sections A/B/C below.** The whole system rests on one
unproven fact: *a provider write lands in Supabase and RLS keeps providers isolated.*
Prove that with the thinnest possible vertical slice — no skip, no Active-Rates view,
no .xlsx, no polish, no React Query. When this loop is green, the rest is execution
against a foundation you *know* works.

**Definition of done:** logged in as a requester you post a lane; logged in as a
provider you submit a rate against it; logged in as the requester you see that rate;
logged in as a *second* provider you canNOT see the first provider's rate.

### S0.1 — Stand up Supabase (≈20 min, no code)
- [ ] Create a Supabase project (free tier). Copy **Project URL** + **anon key** (Settings → API).
- [ ] SQL editor → paste and run **MOCKDEPLOY §4** (schema: suppliers, profiles, batches, lanes, submissions, rates + indexes).
- [ ] SQL editor → paste and run **MOCKDEPLOY §5** (RLS + `current_role_is()`).
- [ ] Authentication → Users → **Add user** ×3: one requester, **two** providers (the 2nd is only to prove isolation). Set each user's `user_metadata.role` = `'requester'` / `'provider'`.
- [ ] Seed identity so RLS works (it reads `profiles`):
  ```sql
  insert into suppliers (name) values ('Forwarder A'), ('Forwarder B');
  insert into profiles (id, role, supplier_id, full_name) values
    ('<requester-uuid>', 'requester', null, 'Requester'),
    ('<providerA-uuid>', 'provider', (select id from suppliers where name='Forwarder A'), 'Provider A'),
    ('<providerB-uuid>', 'provider', (select id from suppliers where name='Forwarder B'), 'Provider B');
  ```
- [ ] Verify in Table editor that all 6 tables exist and the 3 profiles are seeded.

### S0.2 — Wire the app to the live DB (≈5 min)
- [ ] Create `.env.local` (gitignored): `VITE_SUPABASE_URL=...`, `VITE_SUPABASE_ANON_KEY=...` (see `.env.example`).
- [ ] Restart `npm run dev`. The `[supabase] Missing env vars` warning should be gone.

### S0.3 — Minimal real login (replace the dev toggle) (≈30 min code)
- [ ] Add a bare `LoginPage` (two inputs) calling `supabase.auth.signInWithPassword`. Ugly is fine.
- [ ] In `AppInner` ([App.jsx](src/app/App.jsx)): if `!session`, render `LoginPage` instead of `Shell`. Role already flows from the session in [AuthProvider.jsx](src/app/providers/AuthProvider.jsx).
- [ ] This is what makes `auth.uid()` real, which is what RLS keys on. The dev role toggle is now bypassed for the slice.

> **Auth: dev vs production.** Password here is **deliberate for the slice** — local,
> throwaway, and fast when you log in/out repeatedly to test isolation (no email round-trip).
> **Production auth is Supabase magic link behind Cloudflare ZT**, not password. The swap is
> small and localized — `signInWithPassword` → `signInWithOtp({ email, options: { emailRedirectTo } }`)
> plus a "check your email" state and Supabase redirect-URL config; RLS/schema/roles don't change.
> Full model (the two-gate coexistence + the "don't bridge CF→Supabase" trap) is in **MOCKDEPLOY §2 "Auth method & the two-gate model"**; migration sequence is A1 in this doc.

### S0.4 — One real requester write (mostly already done)
- [ ] Log in as the **requester**, open New Rate Request, add one lane, Send Request.
- [ ] [rateRequestService.js](src/features/requester/services/rateRequestService.js) already inserts batch + lane; with a real session `requester_id` is now a real UUID. `posted_at`/`expires_at`/`period` default in the DB.
- [ ] Verify in Supabase Table editor: one `rate_request_batches` row + one `rate_request_lanes` row.

### S0.5 — One real provider submit (the core risk) (≈45 min code)
- [ ] New `src/features/provider/services/submissionService.js` with a minimal `submitRates(rows, lane, providerId)`:
  - insert **1** `rate_submissions` (`lane_id`, `provider_id`, `period = lane.period`, `status = 'submitted'`) → get its `id`;
  - insert **N** `rates` (one per filled row — skip multi-carrier explode for now), stamping `submission_id`, `lane_id`, `provider_id`, and the routing/rate fields.
- [ ] In [SubmitRates.jsx](src/features/provider/pages/SubmitRates.jsx): replace `SAMPLE_LANES` with a one-shot fetch of active lanes (`select * from rate_request_lanes where expires_at > now()`), and replace the `setTimeout` mock submit with the real `submissionService` call.
- [ ] Log in as **Provider A**, fill the rate columns on the requester's lane, Submit. Verify a `rate_submissions` row + `rates` rows appear with `provider_id = Provider A`.

### S0.6 — One real requester read (≈30 min code)
- [ ] Add a minimal read in `rateRequestService`: `fetchReceivedRates(requesterId)` → rates joined to the requester's lanes. No grouping, no cheapest-first.
- [ ] Replace the `/requester/rates` placeholder in [RequesterRoot.jsx](src/features/requester/pages/RequesterRoot.jsx) with a bare `<ul>`/table of the returned rates.
- [ ] Log back in as the **requester** → see Provider A's rate. **The loop is closed.**

### S0.7 — Prove isolation (the most important check) (≈5 min, no code)
- [ ] Log in as **Provider B**. In the browser console run `await supabase.from('rates').select('*')`.
- [ ] It must return **only Provider B's** rows (i.e. nothing, since only A submitted). If Provider B can see Provider A's rate — **stop and fix RLS (MOCKDEPLOY §5)** before building anything else.

> **Deliberately NOT in this slice:** skip/un-skip, the "Skipped" tab, provider Active-Rates
> view, latest-per-routing/append logic, .xlsx upload, React Query, loading/empty states,
> route guards, canonical normalization, dashboards. They're all in A/B/C below — but none of
> them matter until S0.7 passes.

When S0.1–S0.7 are green, proceed to the backlog in priority order.

---

## Where the code stands now

| Area | State |
|------|-------|
| Shell, routing, role nav, design system | ✅ |
| Auth | 🟡 dev-mock role only; no login, dead sign-out, no guards |
| Supabase | 🟡 client exists; placeholder env, no project, no tables |
| Requester write (`NewRateRequest` → `rateRequestService`) | 🟡 real insert of batch+lanes; rest placeholder |
| Requester reads (Open Requests, Active Rates, dashboard) | ⬜ PlaceholderPages, stat cards hardcoded `—` |
| Provider grid (`SubmitRates`) | 🟡 mock: seeded `SAMPLE_LANES`, submit is a `setTimeout`, no skip, no upload |
| Provider Active Rates, dashboard | ⬜ placeholder / `—` |

---

## A. JavaScript / frontend

### A0 — Infra & patterns (do first; everything rides on these)
- [ ] **Pick a data-fetching pattern** — React Query (`@tanstack/react-query`) or custom hooks per feature. None exists today. *(SIP §3.1; MOCKDEPLOY G6)*
- [ ] **Loading / empty / populated** states standardized for data pages. *(SIP §3.8)*
- [ ] **`src/lib/constants.js`** — roles, container types, skip reasons, `TTL_DAYS = 10`. *(assessment.txt §3)*
- [ ] **Supabase failure handling** + visible "dev-mock / not configured" banner. *(SIP §3.4)*
- [ ] **Temp-id vs real UUID** handling in both grids once rows come from the DB. *(SIP §3.6)*

### A1 — Auth & access *(MOCKDEPLOY G2)*
- [ ] **Login page** → `supabase.auth.signInWithOtp` (**magic link**, passwordless) + a "check your email" / "completing sign-in…" state. Set Supabase **Site URL + Redirect URLs** (localhost + prod domain). Two-gate model & the CF-bridge trap: MOCKDEPLOY §2.
- [ ] *(optional later)* shared Google IdP → `signInWithOAuth({ provider: 'google' })` so Cloudflare ZT and Supabase share one sign-on.
- [ ] **Wire the sign-out button** in `src/components/shell/TopNav.jsx` (currently dead).
- [ ] **Unauthenticated redirect** → login (guard at `App`/`Shell`).
- [ ] **Cross-role route guards** — a provider can still type `/requester/new` today. *(SIP §3.11)*
- [ ] **Gate the dev role toggle** behind `VITE_ENABLE_DEV_ROLE`.
- [ ] **Use the session UID** for `requester_id`/`provider_id` — drop the `'dev-user'` fallback in `NewRateRequest.jsx`.

### A2 — Provider supply side *(MOCKDEPLOY G3/G4 + finalized model)*
- [ ] **`src/features/provider/services/submissionService.js`** (new):
  - [ ] `submitRates()` — write **1 `rate_submissions` (status `submitted`) + N `rates`**, explode multi-carrier rows, stamp `provider_id` from session, **APPEND on re-submit (never delete)**.
  - [ ] `skipLane(laneId, period, reason)` — write a `skipped` acknowledgement (0 rates).
  - [ ] `unskipLane(...)` — **delete** the skip row.
  - [ ] `fetchLanesToFill()` / `fetchSkippedLanes()` / `fetchActiveRates()` — `PROVIDER_VIEW_MODEL.md` §2, §3, §4.
- [ ] **Rewrite `SubmitRates.jsx`** — load **real active lanes** instead of `SAMPLE_LANES`; wire the real submit.
- [ ] **Skip UX** — per-row Skip + reason; **"To fill / Skipped" tabs**; un-skip. *(new)*
- [ ] **Provider "Active Rates" page** (replace `/provider/submissions` placeholder) — latest active bid per routing. *(new)*
- [ ] **.xlsx upload** (SheetJS / `npm i xlsx`) in the provider grid — the day-one workflow. Provider grid has no upload yet, only "Add Row". *(G4)*
- [ ] **Provider dashboard counts** (Open Requests / Active Rates).

### A3 — Requester demand + read side *(MOCKDEPLOY G5)*
- [ ] **`rateRequestService.js`** — keep the insert (already carries container cols); **add reads**: active lanes + submission/rate counts, received rates (latest active per routing), per-lane **skip roster** (submitted / skipped+reason / no-response, PVM §6), dashboard stat counts.
- [ ] **"Open Requests" page** (replace placeholder) — active lanes, days-left, counts, status.
- [ ] **"Active Rates" page** (replace placeholder) — received rates cheapest-first + skip roster.
- [ ] **Wire dashboard stat cards** to real counts.
- [ ] **Navigate to a confirmation** after "Send Request". *(SIP §3.7)*

### A4 — Cosmetic alignment
- [ ] Nav labels say **"Open Requests"** but `PROVIDER_VIEW_MODEL.md` calls it **"Lanes to fill."** Pick one term; reconcile doc ↔ UI.

---

## B. Database / Supabase
*(All SQL already drafted in MOCKDEPLOY §4–§5 — this is the checklist.)*

### B1 — Schema *(MOCKDEPLOY §4)*
- [ ] `suppliers`, `profiles` (role + `supplier_id`) — onboarding-safe identity bridge.
- [ ] `rate_request_batches`, `rate_request_lanes` (**with `posted_at` / `expires_at` / `period`**; defaults cover the existing insert).
- [ ] `rate_submissions` — **`status` + `skip_reason`**, nullable `lane_id`/`period`.
- [ ] `rates` — append-only, self-contained text fields, `free_days`, nullable `lane_id`/`submission_id`/`period`.
- [ ] Indexes (expires, pol/fd, provider, lane, submission).

### B2 — RLS *(MOCKDEPLOY §5) — the isolation premise*
- [ ] Enable RLS on all tables; `current_role_is()` helper.
- [ ] Policies: requester owns batches/lanes; **providers read all lanes**; **provider owns their `rates`/`rate_submissions`** (stops one forwarder seeing another); requester reads rates/skips on their own lanes.

### B3 — Provisioning *(MOCKDEPLOY §3/§7)*
- [ ] Create Supabase project; wire `.env.local` + Vercel env vars.
- [ ] 3 auth users with `user_metadata.role`; seed `suppliers` + `profiles`; keep `user_metadata.role` ↔ `profiles.role` in sync.

---

## C. Explicitly deferred (mock-acceptable — flag at review)
- [ ] **Canonical normalization** (PVM §7a): `locations`/`carriers` reference tables, `*_id` columns, typeahead/resolver. Mock tolerates free text → two spellings split a bid lineage.
- [ ] **Requester full-history view** — data preserved (append-only); UI intentionally unbuilt.
- [ ] **Realtime subscriptions** *(SIP §3.9)*, **provider coverage filtering**, **Edge Functions / notifications**.

---

## Critical-path order
`B1 + B2 (live + RLS verified)` → `A1 (auth)` → `A2 (provider writes — the core risk)` →
`A3 (requester reads)` → `A4 / A0 (polish)`. Do **not** deploy publicly until the MOCKDEPLOY
G1 isolation check passes (two forwarders cannot see each other's rates).
