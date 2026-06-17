# Plan: internal/requester can record rates on behalf of a forwarder

> Saved to continue execution tomorrow. Status: approved approach, not yet implemented.

## Context

Today only **forwarders** enter rates (provider Submit Rates page). The forwarder's company is
**implicit** from their identity (`forwarder_id = my_forwarder()`). We want **internal/requester**
users to record rates a forwarder sent (e.g. emailed the filled template back) — same grid + CSV
upload + manual entry — with **one extra required field: the forwarder** (who the rate belongs to).
Recorded rates must look **identical to a forwarder's own app submission** in the requester's
views (decided: *attach to open lanes*), so it doesn't matter whether a forwarder used the app or
emailed back. Write path: a **requester-write RLS policy** (client-direct, requesters trusted).

Key facts found:
- **RLS blocks it today:** `rates`/`rate_submissions` policies require `forwarder_id = my_forwarder()`
  (null for requesters), so a requester cannot write either table (`MEMORY.md` §3).
- **RoleRouter already cross-gates** routes, so this is a clean new requester route + nav item.
- The provider grid [SubmitRates.jsx](src/features/forwarder/pages/SubmitRates.jsx) already has the
  CSV parser, carrier fan-out, copy/add/delete, and styled DataGrid to reuse.
- Requester reads of recorded rates work via the existing `requester reads rates`
  (lane-linked) + [`fetchReceivedRates`](src/features/internal/services/rateRequestService.js) which
  already joins `forwarder:forwarders(name)`.

---

## 1. Database — Supabase SQL editor (run by user)

Add **insert** (and minimal update/read) policies so a requester can record on behalf of any
forwarder. Trusted-internal, and it does **not** breach forwarder↔forwarder isolation (the actor
is a requester, who already sees all lane-linked rates).

```sql
-- requester records rates on behalf of any forwarder; stamps themselves as the enterer
create policy "requester writes rates" on rates
  for insert with check (current_role_is('internal') and provider_id = auth.uid());

create policy "requester writes submissions" on rate_submissions
  for insert with check (current_role_is('internal') and provider_id = auth.uid());

-- find-or-create may flip an existing ack (e.g. skipped → submitted) / refresh it
create policy "requester updates submissions" on rate_submissions
  for update using (current_role_is('internal')) with check (current_role_is('internal'));

-- so unmatched (standalone, lane_id NULL) rates a requester recorded stay visible to them
create policy "requester reads own-recorded rates" on rates
  for select using (current_role_is('internal') and provider_id = auth.uid());
```

**Semantics:** a recorded rate = `forwarder_id` (chosen forwarder), `provider_id` = the requester's
uid (= "entered by"). No new column needed — "recorded by us vs forwarder-submitted" is derivable
by joining `provider_id → profiles.role`. Sync `MEMORY.md` §3 + `MOCKDEPLOY.md` §5.

## 2. Shared rate-entry logic (extract, don't duplicate)

Per `CLAUDE.md` (share parameterized components). Extract the **non-trivial, role-agnostic** pieces
from `SubmitRates.jsx` into a shared module (e.g. `src/features/rates/rateGrid.js` + a styled
`RateGrid` wrapper):
- carrier vocab + `normalizeCarrier` / `splitCarriers` / `carriersOf`,
- CSV header-alias map, `buildHeaderIndex`, `makeRowFromCsv` (the ghost-column carrier scan),
- `isBlankRow`, base `makeEmptyRow` / `makeCopyRow`, and the DataGrid `sx`.

Provider `SubmitRates` and the new requester page both consume these. **Keep each page's columns +
handlers local** (provider keeps skip-on-delete + lane preload; requester adds the Forwarder column,
on-behalf submit, lane matching) — lowest-risk DRY, no rewrite of the working provider flow.

## 3. New requester page — `RecordRates.jsx` + `recordRatesService.js`

**Page** `src/features/internal/pages/RecordRates.jsx` — mirrors `SubmitRates` via the shared grid, with:
- **Forwarder column (required):** a `singleSelect` of forwarders (fetch `id, name` from `forwarders`),
  value stored as `forwarderId`. Plus a **"set forwarder for all rows"** quick action (one upload is
  usually one forwarder).
- **Preloads the open request lanes** (reuse the active-lanes fetch) as guide rows so the requester
  fills rates *against* known lanes; **copy-row** adds another forwarder's quote for the same lane.
- **CSV/template upload:** reuse the shared parser; additionally read the template's **Forwarder
  column (L)** → resolve name → `forwarderId` against the forwarders list (**fail-safe:** unknown →
  leave blank + flag the row, never guess/auto-create); then **match each row to an open lane by
  normalized (POL, FD)** → set `laneId`/`period` when matched, else standalone (`lane_id` null,
  still visible in the grid for review).
- **Delete** = plain row removal (no skip concept here).

**Service** `src/features/internal/services/recordRatesService.js` — `submitRatesOnBehalf(rows)`,
adapted from [`submitRates`](src/features/forwarder/services/submissionService.js): identity =
`provider_id = requester uid`; **`forwarder_id` comes from each row's chosen forwarder**; group
lane-linked rows by **`(laneId, forwarderId)`** (different forwarders on one lane = different acks);
find-or-create the `(lane, forwarder, period)` ack, then append carrier-fanned rate rows; independent
rows insert directly. Reuse `carriersOf` / `buildRate` shape (share from a common helper).

## 4. Nav + route
- `INTERNAL_NAV` ([Sidebar.jsx](src/components/shell/Sidebar.jsx)): add **"Record Rates"**
  (e.g. `Upload`/`ClipboardPen` icon) → `/internal/record`.
- `InternalRoot` ([InternalRoot.jsx](src/features/internal/pages/InternalRoot.jsx)): add a lazy
  `record` route, same `Suspense` pattern as `new`.

## 5. Where recorded rates surface (no change needed)
Lane-linked recorded rates already appear in **Active/Received Rates**
([ReceivedRates.jsx](src/features/internal/pages/ReceivedRates.jsx)) with the forwarder name — exactly
like forwarder-submitted rates. That's the goal.

## Consequences to note (deliberate)
- Recording forwarder X's rate creates the `(lane, X, period)` ack → that lane **drops out of X's own
  "Lanes to fill"** (the company anti-join). Correct (it's been answered), but means X won't be asked
  again for it. Acceptable; flag in UI copy.
- If X later submits in-app for the same lane, find-or-create reuses the ack and **appends** (no
  collision; append-only history preserved).

## Verification
1. Run the RLS SQL; confirm the four policies exist.
2. `npm run build` green.
3. As a **requester**, open Record Rates: open lanes preload; pick a forwarder + enter a rate on one,
   copy-row for a second forwarder; submit → rows land in `rates` with the right `forwarder_id` and
   `provider_id` = your uid, and a `rate_submissions` ack per `(lane, forwarder)`.
4. CSV/template upload: rows load, Forwarder column resolves from the sheet (unknown name flagged),
   rows match open lanes by POL+FD; submit writes them.
5. Open **Active/Received Rates** → recorded rates appear with the forwarder's name, indistinguishable
   from a forwarder's own submission.
6. **Isolation still holds:** as a *forwarder*, `select * from rates` returns only their own rows
   (the new policies are requester-only; re-run the §4 isolation check from NEXTSTEPSV2).
