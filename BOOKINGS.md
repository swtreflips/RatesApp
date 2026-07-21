# BOOKINGS.md — Landed-Cost Scenario Planner (Ocean + Drayage)

**Status:** **v1 implemented** (July 2026) — `features/internal/pages/Bookings.jsx` +
`features/internal/bookings/{inputCsv,matching}.js`, flat route `/internal/bookings`, ungrouped
sidebar item below Dashboard. Shipped scope vs. this doc: **geo hint (§7) deferred**; ocean options
with no drayage coverage are **shown + badged** "no drayage on file"; drayage coverage is fetched
**once** and indexed client-side by normalized lane key (refinement over §2b's per-selection query —
reuses `drayageService.fetchDrayageRates({ scope:'current' })`). No persistence, internal-only,
single-selection — all per the doc.
**Purpose:** given an OFQ (a real customer quote tracked in AIS) and the ocean rate(s) already
applied to it, let an internal user explore which **real drayage rate** completes the door delivery
for each ocean option, and compare the combined landed cost across combinations.
**Created:** July 2026. **Relates to:** `DRAY.md` §6b (supersession/current rates) and §6d (fuel
math / `total_rate`), `BIDDING.md` §1 (ocean vs. drayage rate identity — reused verbatim here),
`BRAIN.md` §6 (`src/lib/geo.js`, the geo/routing brain client — reused directly by §7's live hint),
`features/internal/applyRates/*` (the sibling tool this one deliberately does *less* than),
`DRAYAGE_ANALYTICS.md` (the deep benchmarking/negotiation feature split out of §7 — separate doc,
separate lifecycle).

---

## 1. The core idea

Apply Rates decides **what ocean rates are applied** to an OFQ (qualification + import). Bookings
starts **after** that decision is made and asks a different question: *for an OFQ that already has
ocean rate(s) applied, what's the cheapest (or best) way to finish the move from the Last CY to the
door* — using **real drayage rates already on file**, not a distance heuristic.

```
Apply Rates:  OFQ + candidate rates  →  qualify (geo distance)  →  decide what's APPLIED
Bookings:     OFQ + APPLIED rates    →  explore REAL drayage options →  compare LANDED COST
```

**Bookings does not re-run geo qualification.** It has no `matcher.js`/`config.js`/`geoBatch.js`
equivalent. Its ocean side is simply *whatever the file says is already applied*; its drayage side is
a direct lookup against our own `drayage_rates` table — no distance math, because a real forwarder
quote for that exact Last CY → Final Destination either exists or it doesn't.

### The stress-test example (Seymour, IN)

Seymour, IN sits between three inland yards (Louisville, KY · Cincinnati, OH · Indianapolis, IN),
each reachable from different ports (Los Angeles, CA · New York, NY · Norfolk, VA). One OFQ
(`Nhava Sheva, India → Seymour, IN`) can carry several already-applied ocean options simultaneously:

| Ocean option | POD | Last CY | Carrier | Rate |
|---|---|---|---|---|
| A | Los Angeles, CA | Louisville, KY | CMA | $2,000 |
| B | Seattle, WA | Indianapolis, IN | — | — |
| C | New York, NY | Cincinnati, OH | — | — |

Selecting **option A** pulls up every real drayage rate on file from `Louisville, KY → Seymour, IN`
(potentially several forwarders' quotes). Selecting **option B** instead pulls up
`Indianapolis, IN → Seymour, IN`. The drayage panel is entirely **driven by whichever ocean option
is currently selected** — that's the dynamic behavior the feature is built around.

---

## 2. Data model

### 2a. Ocean side — read from the OFQ file, no DB query

Reuses the exact AIS "rates input" file shape Apply Rates already parses (`ratesInput.csv` — headers
confirmed identical across the working scratch files in the repo). One row per OFQ (`OFQID`); rows
carrying an **`OFRID`** mark a rate *already applied* to that OFQ.

```js
Ofq = {
  ofqId, pol, fd,                    // from the OFQ's own columns
  containerType, containerCount,     // present in the file, unused by Apply Rates — surfaced here
  oceanOptions: OceanOption[],       // one per OFRID row
}

OceanOption = {
  ofrId, forwarder, pol, pod, lastCy, carrier, rate, validUntil,
  // = the ocean "rate identity" fields, BIDDING.md §1
}
```

Apply Rates' `groupByOfq()` only keeps a **hashed dedup key** per OFRID row (`appliedKeys`, a
`Set<string>`) — enough to skip re-applying duplicates, not enough to *display* the option. Bookings
needs the full row. Rather than change `applyRates/inputCsv.js` (used by a shipping tool, keep it
alone), Bookings gets its **own** grouping function that keeps every field, reusing only the header
detection:

```js
import { buildApplyHeaderIndex } from '../applyRates/inputCsv'   // reused, unchanged
// new: groupByOfqWithOptions(dataRows, index) → Ofq[]           // keeps full OceanOption objects
```

### 2b. Drayage side — a direct, real lookup

Once an `OceanOption` is selected, query the live `drayage_rates` table:

```sql
select * from drayage_rates
where status = 'current'
  and last_cy_cfs        ≈ :selectedOption.lastCy
  and final_destination  ≈ :ofq.fd
```

`≈` = normalized match (trim/lowercase/collapse-whitespace) — both columns are free text, same
normalization pattern already used by `applyRates/matcher.js`'s `norm()` (and duplicated locally in
`applyRates/config.js` to avoid a circular import — Bookings' own module should do the same rather
than reach across features for a one-line helper). Prefer an `ilike` prefilter server-side, then an
exact `norm()` comparison client-side to rule out false positives from punctuation drift.

```js
DrayageOption = {
  id, forwarder: { name }, last_cy_cfs, final_destination,
  rate, fuel_surcharge_amount, fuel_surcharge_pct_eff, total_rate,   // §6d generated columns
  toll_fee, pre_pull_fee, pier_pass_fee, clean_truck_fee, drop_fee,
  chassis_fee, storage_fee_per_day,                                  // reference-only accessorials
  provided_at, confirmed_at,
}
```

### 2c. The number that matters

```
grandTotal = oceanOption.rate + drayageOption.total_rate
```

Accessorials are **never added** — this carries DRAY.md §6d's decision forward unchanged (they're
situational and already excluded from `total_rate` itself). They stay visible as reference detail so
a chassis or storage fee never surprises anyone, but the headline number both services agree is
"the price" is `rate + total_rate`, full stop.

---

## 3. New files (when this becomes an implementation task)

| File | Purpose |
|---|---|
| `features/internal/bookings/inputCsv.js` | OFQ parsing that keeps full `OceanOption` rows; imports `buildApplyHeaderIndex` from `applyRates/inputCsv.js` |
| `features/internal/services/bookingsService.js` | `fetchDrayageOptionsForLane(lastCy, fd)` — the §2b lookup |
| `features/internal/pages/Bookings.jsx` | the page |
| `InternalRoot.jsx` | new flat route `/internal/bookings` (mirrors the existing flat `/internal/apply` — see §4 on why it's ungrouped) |
| `Sidebar.jsx` | new nav item, placed like `Dashboard` — outside both service groups |

**Reuse candidate worth taking while touching this area:** `money()` / `pct()` / `fmtDate()` are
currently copy-pasted in both `DrayageActiveRates.jsx` and `DrayageReceivedRates.jsx`. Bookings will
need the same three formatters — a good moment to hoist them into `drayage/drayageGrid.jsx`
(which already exports `StalenessBadge`, the same kind of shared display helper) instead of adding a
fourth copy.

---

## 4. UI/UX layout

*(Skill check: the only project-installed skill is `frontend-design`. Its guidance — commit to a
bold aesthetic direction, avoid generic tables — is written for greenfield artifacts. This app
already has a **locked** maritime design system: harbor/signal/sea/fog palette, Bricolage
Grotesque/Hanken Grotesk/JetBrains Mono, the `DashboardPrimitives.jsx` card/table primitives, and an
existing `.stagger` reveal utility. So the mandate here is to apply the skill's *craft principles* —
typographic hierarchy, spatial composition, motion, a clear visual "hero" — **inside** that existing
system, not invent a new one. A new theme here would read as inconsistent, not bold.)*

**Master-detail, not a wizard.** Everything lives on one page and updates in place — no modal, no
second navigation — because the entire value of the feature is *fast comparison*:

```
┌─ OFQ picker ───────────────────────────────────────────────────┐
│ [search]  OFQ-4821  Nhava Sheva, India → Seymour, IN  (1×40'HC) │  ← from the parsed file
└──────────────────────────────────────────────────────────────────┘

┌─ Ocean options (selectable route-cards, Apply Rates' RouteCell lineage) ─┐
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────┐  │
│ │ ●  LA → Louisville,KY│ │ ○  Seattle → Indy,IN │ │ ○  NY → Cincy,OH│  │
│ │    CMA · $2,000      │ │    — · —             │ │    — · —        │  │
│ └──────────────────────┘ └──────────────────────┘ └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
        │ selecting a card reveals (stagger-in) the drayage panel below,
        │ scoped to THAT option's Last CY → the OFQ's FD
        ▼
┌─ Drayage options for Louisville, KY → Seymour, IN ─────────────────────┐
│  ★ Forwarder C   $780 + $46 fuel = $826         Grand total: $2,826    │ ← best, sea accent
│    Forwarder A   $850 + $51 fuel = $901         Grand total: $2,901    │
│    Forwarder B   $910 + $0 fuel  = $910         Grand total: $2,910    │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Ocean options as route-cards**, not a grid — few rows, rich content, visually descended from
  Apply Rates' `RouteCell` (routing-chain text + a compact meta line), so the routing reads as a
  chain (`POL → POD → Last CY`) exactly as it already does elsewhere in the app.
- **Drayage options ranked cheapest-first by grand total**, recomputed live as the ocean selection
  changes — switching ocean cards re-queries and re-ranks without leaving the page. The top (cheapest)
  row gets a **sea-accent "best total" badge** — reusing the existing accent-token system in
  `DashboardPrimitives.jsx`, not a new color.
- **Hero number.** Each row shows its own subtotal quietly (mono, standard weight) but the **grand
  total is the largest, boldest numeral on the page** — comparing that one number across rows and
  across ocean options is the entire point of the screen, so it should dominate the eye, not compete
  with ten equally-weighted columns.
- **Motion**: the drayage panel's appearance reuses the app's existing `.stagger` reveal (the same
  utility the dashboards already animate stat cards with) — consistent motion language, no bespoke
  transition invented for this one page.
- **Color/icon continuity**: ocean cards carry ocean's already-established tone (`Ship` icon,
  sea/harbor accents from `serviceConfig.js`); drayage rows carry drayage's (`Truck` icon, signal
  accent). A user who already reads the sidebar's two service colors recognizes them immediately here
  — no new visual dialect to learn.
- **Empty state**: no drayage rate on file for the selected Last CY → FD is a calm, informative box
  (same tone as `DrayageActiveRates`' "No drayage rates yet" empty state) — not styled as an error,
  since it's a normal, expected gap in coverage. *Documented future enhancement, not v1:* deep-link
  that empty state into a prefilled drayage request (`drayageService.postDrayageRequestBatch` already
  exists and does exactly this shape of insert) so the gap can be closed in one click.
- **Reuse, don't rebuild chrome**: `PageHeader`, `StatCard` (optional summary row — e.g. "OFQs
  loaded," "Ocean options," "Best total found"), and `ScrollTable` all come from
  `DashboardPrimitives.jsx` unchanged.

---

## 5. Explicitly out of scope for v1

- **No persistence.** Selecting a combo is pure exploration — nothing is written to the database.
  No new `bookings` table, no "saved scenario" concept yet.
- **No CSV export** (a natural follow-on mirroring `outputCsv.js`'s pattern, but not required to
  ship v1).
- **No geo-QUALIFICATION reuse.** Bookings never calls `matcher.js`/`config.js`/`geoBatch.js`'s
  batch within/route engine — that stays Apply Rates' alone. (§7 below adds a *direct*, single-pair
  brain call for a thin live hint — a different, much smaller use of the same underlying service.
  The deep, batch, persisted version of that idea is its own feature — see `DRAYAGE_ANALYTICS.md`.)
- **No forwarder-facing view.** Internal-only, exactly like Apply Rates.

---

## 7. Live distance/cost hint (thin — the deep version lives in `DRAYAGE_ANALYTICS.md`)

**This is deliberately small.** The full benchmarking/negotiation-history feature — batch geo across
the whole `drayage_rates` table, persisted `$/mile`/`$/hour`, trend over time, per-forwarder
comparison — is its **own** doc: `DRAYAGE_ANALYTICS.md`. It was split out of this section because its
scope, data shape, and lifecycle are fundamentally different from the rest of Bookings: cross-rate
and cross-time rather than per-OFQ, and eventually persisted rather than ephemeral. It also has **no
dependency on Bookings or an OFQ file at all** — it can be built independently, in either order.

What stays *inside* Bookings is a much smaller thing: a live, throwaway distance/cost readout next to
each drayage option, useful as an in-the-moment sanity check while deciding — not a negotiation tool.

- **No new API work.** `src/lib/geo.js`'s `getRoute(a, b)` already returns `distance_m` and
  `duration_s` from one call — a real HERE truck route, not a straight-line estimate. (Apply Rates'
  `geoBatch.js` adapter already threads `duration_s` through today; `matcher.js` just never reads it.)
- **One call per ocean selection, never per drayage row.** Every drayage option listed under one
  ocean selection prices the **identical** `(last_cy_cfs, final_destination)` pair (§2b's filter
  guarantees this) — so fetch the route once when an ocean card is selected, and derive every
  drayage row's figure from that same `distance_m`/`duration_s`. Switching ocean options fires one
  new call; switching drayage rows under the same option fires none.
- **The figure, per row:** `costPerMile = drayageOption.total_rate / (distance_m / 1609.344)`,
  `costPerHour = drayageOption.total_rate / (duration_s / 3600)` — shown as a quiet annotation under
  the rate (e.g. `≈ 245 mi · 4h10m · $3.37/mi`), not a headline, not a separate view.
- **Ephemeral, matching §5** — fetched on selection, shown, discarded on navigation away. Nothing
  persisted; that's `DRAYAGE_ANALYTICS.md`'s job if/when it's built.
- **Internal-only, same constraint as the deep feature** (see `DRAYAGE_ANALYTICS.md` §1 for the full
  rationale) — this hint must never reach a forwarder either, for the identical should-cost-leakage
  reason. Costs nothing today since Bookings is already internal-only end to end (§5).
- **Reuse the existing "geo not configured" pattern** — `ApplyRates.jsx` already gates on
  `VITE_GEO_API_URL` (`geoConfigured`) with a plain banner; reuse that exact check rather than
  inventing a second way of saying the same thing.

---

## 8. Open questions

- Should an OFQ's ocean options be limited to ones that have **at least one** matching drayage rate
  on file, or should options with zero drayage coverage still show (to make coverage gaps visible)?
- Is a **multi-pin comparison** worth it — letting the user hold two or three (ocean option, drayage
  option) pairs side by side, rather than one ocean selection at a time? The single-selection model
  above may already be sufficient given drayage re-ranks instantly per ocean choice.
  **Decision: ship single-selection for v1 regardless.** Cognitive load on a Seymour-style 3-way
  split is a known risk (§4), but it's cheap to observe and expensive to design blind — real usage
  will show within days whether clicking through ocean options feels fine or feels like busywork.
  Revisit multi-pin / an auto-computed "best overall combination" banner only if that friction
  actually shows up, not preemptively.
- Should `containerType`/`containerCount` (already parsed from the file, unused by Apply Rates)
  factor into the grand total or stay purely informational in the OFQ picker?
