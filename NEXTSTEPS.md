# NEXTSTEPS — Implementation Backlog (pre-deploy)

**Status:** the pending-features list to take RatesApp from its current mock state to the
MOCKDEPLOY dress rehearsal. Planning only — nothing here is implemented yet.
**Created:** June 11, 2026
**Source of truth:** data model in `dataDesign.txt` + `PROVIDER_VIEW_MODEL.md` + `LANE_LIFECYCLE_AND_BIDDING_MODEL.txt`; deployment in `MOCKDEPLOY.md` (full SQL/RLS in §4–§5, runbook in §7).

This refines MOCKDEPLOY §6: that gap list predates the finalized **skip flow**, the
provider **Active-Rates view**, and **append-on-resubmit**, all of which are required here.

Legend: ✅ built · 🟡 partial / mock · ⬜ missing.

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
- [ ] **Login page** → `supabase.auth.signInWithPassword`.
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
