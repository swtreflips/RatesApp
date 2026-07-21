# DRAYAGE_ANALYTICS.md — Drayage Rate Benchmarking & Negotiation Insight (Internal-Only)

**Status:** **Layer 1 implemented** (July 2026) — `features/internal/pages/DrayageAnalytics.jsx` +
`analytics/{compute,routeLanes}.js` + `services/benchmarksService.js`, under an **Analytics hub**
(`/internal/analytics` → Drayage/Ocean cards; Ocean deferred). On page load: current rates + existing
benchmarks are read, un-benchmarked rates are routed in **one batched `routeBatch` call** and their
`$/mile`/`$/hour` **written through** to `drayage_rate_benchmarks` (§5), then shown as the per-lane
spread (§4). **Layer 2 (trend) not built** — the write-through is its groundwork. Batch cadence (§8)
resolved for L1: **on-demand at page load, persisted cache** (only new/superseding rates hit geo).
**Purpose:** benchmark drayage rates against their real HERE-routed distance/time, producing
`$/mile` / `$/hour` figures — primarily so an internal user can compare **every forwarder currently
quoting a lane, today**, and negotiate from real numbers instead of a hunch. Trend-over-time is a
genuine second layer built **on top** of this, not a prerequisite for it (§2).
**Created:** July 2026. **Split out of `BOOKINGS.md` §7** (July 2026) — see §7 there for the sibling
feature: a thin, live, per-selection distance/cost *hint* shown during OFQ decision-making. This doc
is the deep version: batch, persisted, historical, cross-forwarder.
**Relates to:** `DRAY.md` §6b (`current`/`superseded` rate history — Layer 1 reads only `current`
rows; superseded rows accumulate in `drayage_rate_benchmarks` as Layer 2's future input, §5),
`BIDDING.md` (negotiation groundwork — this
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

## 2. The core idea — two layers, built in order

**Layer 1 (primary, buildable now): cross-sectional — how do today's quotes compare?** Every
`drayage_rates` row implies a real physical route the moment you know its `(last_cy_cfs,
final_destination)` pair. Benchmarked against a real HERE truck route (distance + time), a rate
stops being just "a number a forwarder sent us" and becomes "$3.37/mile — the other two forwarders
quoting this lane today are at $2.80–$2.95." That comparison needs only `status='current'` rates
across forwarders sharing a lane — **no history, no waiting.**

**Value is immediate, not something to wait on.** There's a real, multi-forwarder rate set ready
today: an ERP export covering ~4 forwarders, with several lanes already carrying 2–3 overlapping
quotes. The moment that's uploaded through the existing on-behalf pipeline
(`features/drayage/pages/DrayageUploadRates.jsx` → `submitDrayageRatesOnBehalf`), Layer 1 has real
comparisons to show — this isn't gated on slow organic onboarding growth.

**Layer 2 (later, additive): trend — how has a price moved over time?** "Is this forwarder's price
climbing faster than the lane average" is a genuinely different, valuable question — but it's a
layer **on top of** Layer 1, not a rival design. It needs superseded-row history, which only exists
once Layer 1 has been running (and persisting, §5) for a while. **Layer 2 is not designed here in
detail** — it's named so Layer 1 is built in a way that doesn't foreclose it (§5), not built.

Everything below (§2a–§6) describes Layer 1. Layer 2 gets one short mention (§4) and nothing else —
building it is a separate, later effort once Layer 1's own persistence has quietly accumulated
enough history to make it worthwhile.

### 2a. Flow — data → processing → insight (as built)

```
 DATA SOURCES                    PROCESSING (on page load)                     INSIGHT
════════════                    ══════════════════════════                    ═══════

┌───────────────────┐
│ Supabase          │  read current rates ─────┐
│ drayage_rates     │  fetchDrayageRates        │
│ (status='current')│  {scope:'current'}        │
│  forwarder,       │                           ▼
│  last_cy_cfs,     │                    ┌──────────────┐
│  final_destination│                    │  DIFF        │  which current rates
│  total_rate       │                    │  rates that  │  don't have a
└───────────────────┘                    │  lack a      │  benchmark yet?
                                          │  benchmark   │
┌───────────────────┐  read cache ──────▶│              │
│ Supabase          │  fetchBenchmarks    └──────┬───────┘
│ drayage_rate_     │                            │ gaps only
│ benchmarks (cache)│                            ▼
│  rate_id →        │                    ┌──────────────┐
│  distance_m,      │                    │ dedupeLanes  │  N rates → M unique
│  duration_s,      │                    │ norm(lastCy, │  (lastCy → fd) lanes
│  $/mile, $/hour   │◀─── write-through ─┐│  fd) key     │
└───────────────────┘   insertBenchmarks ││└──────┬───────┘
        ▲               (immutable,      ││       │ M unique lanes
        │                compute-once)   ││       ▼
        │                                ││┌──────────────┐   ONE batched POST
        │                                │││ routeLanes   │──────────────┐
        │                                │││ routeBatch   │              ▼
        │                                │││              │      ┌─────────────────┐
        │                                │││              │◀─────│  THE BRAIN      │
        │                                ││└──────┬───────┘ dist,│  geoapi-next    │
        │                                ││       │ route │ time │  /api/route-    │
        │                                ││       ▼       └──────│   batch         │
        │                                ││┌──────────────┐      │   ↓ HERE truck  │
        └── benchmarks now in memory ────┘││ benchmarkOf  │      │     routing     │
                                          ││ total_rate ÷ │      │   ↓ lane cache  │
                                          ││   miles →$/mi│      │     (server)    │
                                          ││ total_rate ÷ │      └─────────────────┘
                                          ││   hours →$/hr│
                                          │└──────┬───────┘
                                          │       │ per-rate benchmark
                                          │       ▼
                                          │┌──────────────┐        ┌────────────────────────┐
                                          └│ groupByLane  │───────▶│  PER-LANE SPREAD        │
                                           │ merge rates  │        │                         │
                                           │ + benchmarks │        │ Louisville → Seymour    │
                                           │ min/max/avg  │        │  ≈ 62 mi · 1h05m        │
                                           │ sort $/mi ↑  │        │  Fwd C $826  $13.29/mi ★│
                                           └──────────────┘        │  Fwd A $901  $14.50 +9%│
                                                                   │  Fwd B $910  $14.65 +10%│
                                                                   │  spread $13.29–14.65/mi │
                                                                   └────────────────────────┘
                                                                   multi-forwarder lanes first
                                                                   (spread = the signal);
                                                                   single-quote lanes muted
```

What the shape encodes:
- **Two caches in series** — the app's `drayage_rate_benchmarks` (only *new* rates reach processing)
  and the brain's server-side lane cache (only *never-routed* lanes reach HERE). A lane realistically
  hits HERE **once, ever**, across Apply Rates + Analytics combined.
- **The write-through loop** (the arrow back into the benchmarks table) does double duty: Layer 1's
  cache *and* silently banking immutable history Layer 2 will read for free (§5).
- **The join key is `norm(lastCy, fd)` everywhere** — the single point where a spelling drift between
  a DB rate and what HERE can geocode splits one real lane in two or drops it into the error box.
  The whole pipeline's honesty hinges on that one normalization (§3a).

---

## 3. Scope: a batch problem, not a one-off lookup (Layer 1)

This is the load-bearing difference from `BOOKINGS.md` §7's inline hint. Bookings looks at one
ocean-selection's worth of drayage rates at a time (all sharing one lane) — one `getRoute()` call is
enough. Layer 1 looks at **every `status='current'` drayage rate at once** — every forwarder, every
lane, all live simultaneously — so its geo need looks like Apply Rates' batch job, not Bookings'
single call, even though it's scoped to current rates only (no superseded rows — that's Layer 2):

- **Dedupe to unique `(last_cy_cfs, final_destination)` pairs** across every current rate (several
  forwarders quoting `Louisville, KY → Seymour, IN` all resolve to the **same one** route lookup).
- **Reuse `applyRates/geoBatch.js`'s `createBatchGeo`/`routeBatch` pattern** (or a near-identical
  adapter scoped to this feature) rather than one-at-a-time `getRoute()` calls — the same
  chunking/cache-hit/error-tally discipline already proven there, not reinvented.
- The brain already caches per-lane server-side, so a full recompute after the first pass is cheap —
  only genuinely new lanes cost real HERE quota. And because this is current-rates-only, the batch
  stays bounded to "however many lanes are actively quoted right now," not the whole history of the
  table — meaningfully smaller than benchmarking everything ever written.

### 3a. Data-quality risk: this is now urgent, not theoretical

Layer 1's entire premise — "these forwarders are competing on the *same* lane" — depends on
`last_cy_cfs`/`final_destination` matching exactly (normalized) across rows. That risk stops being
abstract the moment real multi-source data lands: an ERP export covering 4 forwarders almost
certainly wasn't typed against one shared vocabulary — different capitalization, spacing, or even
different conventions for the same real place across forwarders. If two forwarders' rows for the
identical physical lane don't normalize to the same key, they silently split into two separate
one-forwarder "lanes" — the exact case Layer 1 exists to surface (real competition on a lane) becomes
invisible, with no error or warning to say so.

**Before trusting any Layer 1 output on the ERP import:** pull the distinct `last_cy_cfs` /
`final_destination` values the export actually contains and manually check whether the same real
places are spelled consistently across the 4 forwarders' rows. A 10-minute pass on the real file, not
a hypothetical concern to defer — do this check *before* building Layer 1's comparison logic, since
it determines whether that logic's grouping can be trusted at all once shipped.

---

## 4. Data model (Layer 1)

**Input:** `drayage_rates` where `status='current'` — `(forwarder_id, last_cy_cfs,
final_destination, rate, fuel_surcharge_amount, total_rate, provided_at, confirmed_at)`.

**Derived per rate** (via the batch geo call, joined by normalized lane key):
```
distance_m, duration_s              → from the batch route lookup (§3)
cost_per_mile = total_rate / (distance_m / 1609.344)
cost_per_hour = total_rate / (duration_s / 3600)
```

**The Layer 1 view:** **per-lane spread** — every forwarder currently quoting one lane, `$/mile`
side by side, cheapest/most-expensive called out, maybe a rough lane-wide average. That's the whole
MVP: today's competitive picture for a lane, nothing more.

**Layer 2 (named, not designed):** once superseded rows have accumulated real history (via §5's
persistence), a *per-forwarder trend* view — one forwarder's `$/mile` on a lane over its
supersession history — becomes possible on the same table, as a separate later effort.

---

## 5. Persistence — Layer 1 doesn't need it to ship; write it anyway, as Layer 2's groundwork

**Layer 1's own value doesn't require a table at all.** "Compare today's forwarders on this lane" can
be answered by computing live each time the view loads (same pattern as Bookings' hint, just batched
across many lanes instead of one) — a page view is not blocked on history existing.

**But write the computation through to a table anyway**, purely as a byproduct, because that's what
makes Layer 2 possible later **for free**. If Layer 1 only ever computes-and-discards, there is no
history to trend over once you eventually want it — you'd have to start accumulating from that day
forward. If Layer 1 quietly persists every benchmark it computes from day one, Layer 2 is mostly
already-collected data by the time anyone gets around to building it. This is the concrete
"groundwork so implementing it's easy" the whole feature was asked for.

```sql
-- AS DEPLOYED (Layer 1): + RLS (internal read/insert; no update/delete = immutable; forwarders none)
create table drayage_rate_benchmarks (
  rate_id        uuid primary key references drayage_rates(id),
  distance_m     numeric not null,
  duration_s     numeric not null,
  cost_per_mile  numeric not null,
  cost_per_hour  numeric not null,
  computed_at    timestamptz not null default now()
);
```

- **Written whenever Layer 1 benchmarks a rate** — current rows get written (and read back) for
  Layer 1's own display; **when a rate is later superseded, its row simply stays in the table
  unchanged** — no separate step, no re-compute, no extra work. It's already sitting there as history
  the moment Layer 2 wants it.
- **Immutable once written** — a rate's benchmark doesn't change after the fact (`DRAY.md` §6b: rates
  are append-only via supersession, never edited in place), so `computed_at` is set once and never
  revisited.
- Layer 1's UI reads this table as a **cache it happens to also be building history in** — not as a
  historical ledger it depends on. That framing is what keeps Layer 1 shippable without waiting for
  Layer 2 to make sense.

---

## 6. UI placement — DECIDED: dedicated page under an Analytics hub

**Chosen (user, July 2026):** a single cross-service **Analytics** sidebar item (ungrouped, like
Bookings/Dashboard — belongs to neither service group) landing on a **hub** (`/internal/analytics`)
with a card per service — **Drayage** (live) and **Ocean** (coming-soon). Drayage opens
`/internal/analytics/drayage`, the Layer 1 per-lane spread. This **supersedes the doc's earlier lean
toward option (a)** (extend `DrayageReceivedRates`): the app already established the "ungrouped
cross-service page" pattern with Bookings, one Analytics menu that fans out per service scales to
Ocean cleanly, and a dedicated page gives Layer 2's eventual trend chart a home without recrowding
the rates list. The rejected alternative (a) — a `$/mile` column bolted onto the Drayage Rates page —
would have mixed a benchmarking surface into an operational list and had nowhere to grow.

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
- **Optional Layer-2 jumpstart** — Layer 1 only needs to benchmark `current` rates, so there's no
  backfill *requirement* at launch. But since any already-`superseded` rows at that point are free
  history sitting right there, is it worth a one-time pass benchmarking them too, so Layer 2 (if/when
  built) starts with whatever history already existed rather than only what accumulates from launch
  day forward? Purely an optional head start, not something Layer 1 needs to ship.

---

## 9. Simple next additions (closing insight → action)

Layer 1 today is descriptive and relative — it shows *who is cheapest per lane, by what %*. It stops
one step short of an **ask** ("drop $75") or an **action** ("this lane has no second quote"). These
four are deliberately small, additive, and use **only data already on the page** — no new
tables, no new dependencies, no external index. Ranked by value-per-effort; start at the top.

1. **Dollar-to-best, not just percent** *(negotiation — highest payoff, do first)*. Each
   above-cheapest row already knows its own `total_rate` and the lane's cheapest `total_rate` —
   show the **dollar gap** (`+$75 vs best`) beside the existing `+9%`. Turns a stat into a sentence
   you say on a call. Trivial (subtraction on data in hand).
2. **Single-source lanes as a "get a second quote" list** *(awareness + future leverage)*. The page
   already splits `single` vs `multi` forwarder lanes; reframe the single group as what it *is* —
   lanes where you have **zero negotiating leverage** — with a count StatCard ("6 lanes
   single-sourced") and treat it as a standing sourcing to-do. Nearly free (the grouping exists).
3. **One portfolio glance** *(market awareness)*. A single headline the page lacks:
   **network-wide average `$/mile`**, plus cheapest / priciest lane. One StatCard or a one-line
   summary — answers "are we broadly competitive?" and gives the per-lane numbers a reference point.
   Cheap (per-lane averages already computed).
4. **Copy a lane's spread for the negotiation email** *(negotiation)*. A small "copy" on each lane
   that puts the spread as plain text on the clipboard (forwarders · `$/mile` · gap), ready to paste
   into an email. Makes the screen *sendable* — the natural bridge before any real export/persistence.

**Deliberately NOT yet** (keep it simple, grow later): an **external market index** (DAT/FreightWaves —
real value someday, but an integration + cost + normalization headache; the internal relative
baseline is enough to negotiate with now); **Layer 2 trend** (needs the history only now
accumulating — let it fill); **charts** (the tables already carry the signal; polish, not value, at
this stage).
