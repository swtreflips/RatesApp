# DRAYAGE_ANALYTICS.md — Drayage Rate Benchmarking & Negotiation Insight (Internal-Only)

**Status:** Design doc. **Not implemented, not scheduled.**
**Purpose:** benchmark every drayage rate on file (current *and* historical) against its real
HERE-routed distance/time, producing `$/mile` / `$/hour` figures per forwarder and per lane — for
internal market-rate awareness and negotiation, not for a single in-the-moment decision.
**Created:** July 2026. **Split out of `BOOKINGS.md` §7** (July 2026) — see §7 there for the sibling
feature: a thin, live, per-selection distance/cost *hint* shown during OFQ decision-making. This doc
is the deep version: batch, persisted, historical, cross-forwarder.
**Relates to:** `DRAY.md` §6b (`current`/`superseded` rate history — this feature is a primary
consumer of superseded rows, not just current ones), `BIDDING.md` (negotiation groundwork — this
feature is the market-awareness input a future bid decision would draw on), `BRAIN.md` §6 /
`src/lib/geo.js` (the geo client), `features/internal/applyRates/geoBatch.js` (the batch-routing
adapter this reuses), `BOOKINGS.md` §7 (sibling — the live inline hint).

---

## 1. Locked constraint: internal-only, never forwarder-facing

**This benchmark must never reach a forwarder**, under any current or future forwarder-facing
surface. `$/mile` and `$/hour` are the buyer's should-cost model — the exact yardstick a forwarder's
rate is judged against. Exposing them would let forwarders price *to* the benchmark instead of to
their real cost, collapsing the price dispersion that makes cross-forwarder comparison valuable in
the first place, and handing away negotiating leverage for a marginal UX gain. The only
forwarder-safe slice, if ever needed, is neutral lane confirmation (distance only, no cost framing)
— never the `$/mile`/`$/hour` figures themselves. Since this feature is internal-only end to end,
this costs nothing today — it becomes a real decision the moment anyone proposes exposing *any*
part of drayage rate data to forwarders, at which point this feature must be explicitly excluded
from that surface, not just visually hidden.

---

## 2. The core idea

Every `drayage_rates` row — **current or superseded** — implies a real physical route the moment you
know its `(last_cy_cfs, final_destination)` pair. Benchmarked against a real HERE truck route
(distance + time), a rate stops being just "a number a forwarder sent us" and becomes "$3.37/mile on
a lane where two other forwarders charge $2.80–$2.95" — a fact you can bring to a negotiation, not a
hunch. Because history matters here (a forwarder's price *trend* on a lane is the interesting
signal, not just today's snapshot), this feature deliberately reads `superseded` rows too — the
opposite of Bookings, which only ever cares about `status='current'`.

---

## 3. Scope: a batch problem, not a one-off lookup

This is the load-bearing difference from `BOOKINGS.md` §7's inline hint. Bookings looks at one
ocean-selection's worth of drayage rates at a time (all sharing one lane) — one `getRoute()` call is
enough. This feature looks at the **whole `drayage_rates` table** — potentially hundreds of rows
across many forwarders, many lanes, many historical supersessions — so its geo need looks like Apply
Rates' batch job, not Bookings' single call:

- **Dedupe to unique `(last_cy_cfs, final_destination)` pairs** across every row in scope (many
  historical rates share one lane — three forwarders' prices on `Louisville, KY → Seymour, IN`, plus
  two years of that lane's supersession history, all resolve to the **same one** route lookup).
- **Reuse `applyRates/geoBatch.js`'s `createBatchGeo`/`routeBatch` pattern** (or a near-identical
  adapter scoped to this feature) rather than one-at-a-time `getRoute()` calls — the same
  chunking/cache-hit/error-tally discipline already proven there, not reinvented.
- The brain already caches per-lane server-side, so a full recompute after the first pass is cheap —
  only genuinely new lanes cost real HERE quota.

---

## 4. Data model

**Input:** `drayage_rates`, **both** `status='current'` and `status='superseded'` — `(forwarder_id,
last_cy_cfs, final_destination, rate, fuel_surcharge_amount, total_rate, provided_at, confirmed_at,
status)`.

**Derived per rate** (via the batch geo call, joined by normalized lane key):
```
distance_m, duration_s              → from the batch route lookup (§3)
cost_per_mile = total_rate / (distance_m / 1609.344)
cost_per_hour = total_rate / (duration_s / 3600)
```

**Aggregation views worth surfacing** (not all required for a first cut):
- **Per-lane spread** — every forwarder's `$/mile` on one lane, side by side, cheapest/most-expensive
  called out.
- **Per-forwarder trend** — one forwarder's `$/mile` on a lane across its supersession history (did
  their price move with fuel, or ahead of it?).
- **Lane-wide market average** — a rough "what does this lane typically cost" figure, useful context
  before a `DRAY.md` §6b refresh request or (later) a `BIDDING.md`-style negotiation opens.

---

## 5. Persistence — this feature needs it (unlike Bookings)

Unlike `BOOKINGS.md` §7's ephemeral hint, trending requires history to be retained, so this feature
needs a real table (not created yet):

```sql
create table drayage_rate_benchmarks (
  rate_id        uuid primary key references drayage_rates(id),
  distance_m     numeric not null,
  duration_s     numeric not null,
  cost_per_mile  numeric not null,
  cost_per_hour  numeric not null,
  computed_at    timestamptz not null default now()
);
```

- **One row per rate, including superseded ones** — history is the entire point.
- **Superseded rows never need recomputation** — they're immutable once superseded (`DRAY.md` §6b),
  so their benchmark is written once and never touched again.
- **Current rows** could in principle be recomputed if the geo data source improves, but the common
  case is compute-once-on-first-sight, same as superseded rows.
- Written by a batch job (§3), not by the request/response cycle of any page view — the Analytics
  surface should always be reading `drayage_rate_benchmarks`, never blocking on a live brain call.

---

## 6. UI placement — open, not decided

Two candidate homes:

- **(a) Extend the existing internal Drayage Rates page** (`DrayageReceivedRates.jsx`) with a
  `$/mile`/`$/hour` column and a per-lane spread indicator, reusing its existing current/history
  toggle. Cheaper — no new menu item, and the page already has the right current/history framing.
- **(b) A dedicated "Drayage Analytics" internal page/menu item** — lane-level and forwarder-level
  views, sortable/filterable, room for an actual trend chart per lane. More build, but doesn't cram
  reporting into a page whose primary job today is just listing rates.

Recommend deciding once real benchmark data exists and it's clear what questions people actually ask
of it — a column addition (a) can always graduate into (b) later if the reporting need grows past
what a table column can express.

---

## 7. Relationship to Bookings

`BOOKINGS.md` §7 keeps a thin, **live**, per-selection hint — one `getRoute()` call, ephemeral, shown
inline next to a drayage option while deciding on one OFQ. This doc is the deep version: batch,
persisted, historical, cross-forwarder. They share the same underlying formulas (`cost_per_mile`/
`cost_per_hour`) but not a code path or a table — Bookings' hint must keep working even if this
feature (and its table) never gets built, and this feature's batch job has no dependency on Bookings
or any OFQ file at all. Independent build order, independent priority.

---

## 8. Open questions

- **Batch cadence** — on-demand (computed when the Analytics view loads, reading + filling gaps in
  `drayage_rate_benchmarks`) or a scheduled/nightly job that keeps the table warm ahead of time so
  the page itself never waits on the brain?
- **Market-rate baseline** — is "cheapest forwarder currently on this lane" a good enough baseline,
  or does real negotiation eventually want an external benchmark (e.g. a DAT/FreightWaves-style
  index) blended in?
- **Confirm vs. new rate** — a `Confirm` action (`DRAY.md` §6b) bumps `confirmed_at` without changing
  the price or creating a new row. Does that event deserve a fresh `computed_at` (re-affirming the
  benchmark is still relevant) even though nothing about the geo math changed, or is the original
  `computed_at` still correct since the rate row itself never changed?
- **Historical backfill** — when this ships, does it benchmark the *entire* existing
  `drayage_rates` history in one pass (immediately useful trend data) or only rates from that point
  forward (cheaper first cut, no trend value until enough time passes)?
