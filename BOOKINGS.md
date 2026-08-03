# BOOKINGS.md — Landed-Cost Scenario Planner (Ocean + Drayage)

**Status:** **v1.1 implemented** (July 2026) — `features/internal/pages/Bookings.jsx` +
`features/internal/bookings/{inputCsv,matching}.js`, flat route `/internal/bookings`, ungrouped
sidebar item below Dashboard. **v1's picker+cards layout was superseded after first real use** (it
read as unintuitive); v1.1 is the grid-first three-state model in §4: OFQ grid → row expands to its
OFRs → clicking an OFR opens the Booking Itinerary panel on the right. Shipped scope vs. this doc:
**geo hint (§7) deferred**; no-coverage OFRs are **shown + badged** "no drayage on file"; drayage
coverage is fetched **once** and indexed client-side by normalized lane key (refinement over §2b's
per-selection query — reuses `drayageService.fetchDrayageRates({ scope:'current' })`).
Internal-only and single-selection per the doc; **the uploaded sheet is now a shared snapshot**
while the selection remains ephemeral — see §5.
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

### 2a. Ocean side — read from the OFR universe search, never the DB

**Locked: ocean data comes ONLY from the "OFR universe" input** — the `rates` table is never queried
here; drayage (§2b) is the only DB side. Bookings is deliberately a **join across two systems of
record**: NetSuite owns the ocean/OFQ side, Supabase owns the drayage side. Mirroring NetSuite data
into Supabase would create a second, staler copy of something that already has an owner.

**Provenance (matters for risk + roadmap):** the input is a **NetSuite saved search built
specifically for this app** — not a generic export. The schema is **owner-controlled**: columns only
change if we change the saved search, so header-drift is a deliberate act, not an external risk.
`OFRUniverseExample.csv` is the committed structural reference of that search's output.

- **MVP transport:** download the saved search result manually → drag-drop upload.
- **Future transport:** the app fetches the *same saved search* via the NetSuite API. A saved search
  can't be called from the browser (auth + CORS), so this goes through a small server-side
  intermediary holding the NetSuite credentials — either a Supabase Edge Function (the
  `notify-forwarders` pattern) or the geoapi-brain proxy pattern; the app receives clean JSON.
  This also removes file-staleness entirely (every fetch is current).
- **The parser is the designated swap point.** The pipeline is
  `transport (CSV parse) → group (groupByOfqWithOptions) → match/display`; the API future replaces
  only the transport step — structured rows feed the same grouping, and everything downstream
  (matching, itinerary, totals) is untouched. The upload button becomes "Refresh from NetSuite."

One row per **OFR**, grouped by `OFQID`; rows carrying an **`OFRID`** are the applied ocean rates.

```js
Ofq = {
  ofqId, pol, fd, cargoReadyDate,    // from the OFQ's own columns
  containerType, containerCount,     // informational (not in the total)
  oceanOptions: OceanOption[],       // one per OFRID row
}

OceanOption = {
  ofrId, forwarder, pol, pod, lastCy, carrier, rate, validUntil,
  // = the ocean "rate identity" fields, BIDDING.md §1
}
```

**Parsing quirk that shaped the code** (`bookings/inputCsv.js`): the saved search's output header has
**two column blocks** — an OFQ-side block that *also* contains `Rate/Unit` / `Port of Discharge` /
`Last CY/CFS` / `Carrier` (all blank in the export — an artifact of how the search joins OFQ and OFR
fields), then the OFR block with the real values. A
first-occurrence `headers.indexOf(...)` (Apply Rates' approach — fine for its simpler input shape)
binds to the empty first block, which surfaced in v1.1 as "OFRs with no rate." Bookings therefore
has its **own block-aware header index**: every OFR-block column is resolved **at/after the OFRID
column's position** (`idxFrom(headers, name, ofrIdIdx)`); OFQ-side columns stay first-occurrence.
The simpler `ratesInput.csv` shape parses identically under the same rule (its OFRID precedes those
columns anyway). Verified against both real files (22-check parse test on the committed examples).

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

*(v1.1 — the original picker+cards master-detail shipped first and was replaced after real use;
the grid-first model below matches how the user actually thinks about the data.)*

**Three states, progressive disclosure, everything on one page:**

1. **OFQ grid** — the landing state is a familiar grid, one row per OFQ:
   `OFQID · Port of Loading · Final Destination · Cargo Ready Date · ocean-rate summary`
   (summary = `3 rates · 2 covered`, or `none applied`). Searchable (OFQID/POL/FD).
2. **Row expansion** — clicking an OFQ row expands it in place (chevron rotates, one OFQ open at a
   time); its applied OFRs render as indented sub-rows: Ship icon, routing chain `POL → POD → Last
   CY` (Last CY tinted sea — it's the segment drayage keys on), forwarder/carrier/valid-until meta,
   ocean rate right-aligned, and a coverage chip (`n drayage` / `no drayage on file`).
3. **Booking Itinerary panel** — clicking an OFR opens the sticky right panel: the door-to-door
   route as a **vertical timeline**, with the drayage leg holding the selectable options.

```
┌─ OFQ GRID ──────────────────────────────────┐  ┌─ BOOKING ITINERARY ────────────┐
│  OFQID   POL          FD         Ready  Rates│  │ OFQ-4821 · 1×40'HC · ready 8/2 │
│ ▸ 4818   Ningbo       Dallas,TX  7/25   1·1  │  │                                │
│ ▾ 4821   Nhava Sheva  Seymour,IN 8/02   3·2  │  │ ● Port of Loading              │
│    ├ ◉ NS → LA → Louisville,KY  CMA  $2,000  │  │ │  Nhava Sheva, India          │
│    ├ ○ NS → Seattle → Indy,IN   —    $2,150  │  │ │  ⛴ ocean · CMA      $2,000  │
│    └ ○ NS → NY → Cincy,OH  [no drayage] $1,9…│  │ ● Port of Discharge            │
│ ▸ 4830   Qingdao      Boise,ID   8/10   0    │  │ │  Los Angeles, CA             │
└──────────────────────────────────────────────┘  │ ● Last CY / ramp               │
                                                  │ │  Louisville, KY              │
                                                  │ │  🚚 pick the drayage leg:    │
                                                  │ │   ◉ Fwd C  $826  ★ best      │
                                                  │ │   ○ Fwd A  $901              │
                                                  │ │   ○ Fwd B  $910              │
                                                  │ ● Final Destination            │
                                                  │    Seymour, IN                 │
                                                  │ ───────────────────────────────│
                                                  │ LANDED TOTAL          $2,826   │
                                                  └────────────────────────────────┘
```

- **The panel reads as assembling a booking** — which is the feature's name. Ocean leg is locked to
  the clicked OFR; the drayage leg is the choice point: options sorted cheapest-first by grand
  total, **cheapest preselected** with an Award "best" badge, radio-select to switch; the footer's
  **landed total is the hero numeral** (largest, boldest mono number on the page) and updates
  instantly on switch. Sticky on wide screens (grid scrolls, itinerary stays); stacks below on
  narrow.
- **Grid mechanics**: custom rows, not MUI DataGrid — the free tier has no master-detail, and the
  expansion + selection states are trivial with plain rows styled in the app's ScrollTable header
  idiom. One OFQ expanded at a time keeps state legible; expanding another collapses the first and
  clears the selection.
- **Color/icon continuity**: Ship + sea tones for the ocean leg, Truck + signal for the drayage leg
  — the sidebar's existing service-color grammar, no new dialect.
- **Motion**: the panel and expansion reuse the existing `.stagger` reveal.
- **Empty states, all calm, none error-styled**: OFQ with no OFRs → inline note in the expansion;
  OFR with no coverage → badged in the sub-row AND a PackageX block inside the itinerary's drayage
  leg; no OFR selected → dashed "No booking assembled yet" placeholder panel. *Future enhancement
  (not built):* deep-link the no-coverage state into a prefilled drayage request
  (`drayageService.postDrayageRequestBatch` already does this shape of insert).
- **Reuse, don't rebuild chrome**: `PageHeader` + `StatCard` summary row (`OFQs loaded · Ocean rates
  in file · Best landed total`) from `DashboardPrimitives.jsx`; `money` from `drayageGrid.jsx`;
  upload/drag-drop via `parseRateFile`.

---

## 5. Explicitly out of scope for v1

- **No persistence of a SELECTION.** Choosing an ocean rate and a drayage option is pure
  exploration — nothing is written. No "saved scenario" concept, no `bookings` table.

  > ### ✅ Superseded in part — the SHEET is now persisted
  >
  > This bullet originally read *"No persistence"* and covered two different things at once. The
  > half about selections still stands and always will: one person's what-if has no business
  > becoming another's.
  >
  > The other half was wrong. The uploaded FILE was browser state too, so a reload emptied the
  > page and the export one person happened to have was invisible to every other internal user.
  > That is not exploration being ephemeral — that is the shared input being trapped in one tab.
  >
  > **`booking_snapshots`** (migration `20260803120000`) now holds it.
  >
  > | | |
  > |---|---|
  > | **Stored** | the OFQ universe and the ocean rates applied to it, as parsed |
  > | **NOT stored** | the drayage options, the selection, the expanded row, any total |
  > | **Shape** | one immutable JSONB document per upload — a photograph of a file |
  > | **Who** | any internal user may publish; forwarders read nothing |
  > | **History** | every upload kept, latest is what the page shows, ~3 KB each |
  > | **Staleness** | the stamp turns amber after 7 days — a cue, never a gate |
  >
  > **Drayage is still read live from `drayage_rates` on every load**, and freezing it into a
  > snapshot would be a bug: a two-week-old sheet must not quote two-week-old trucking. A
  > snapshot ages in one dimension only — which OFQs and ocean rates existed when it was taken.
  >
  > **There is no UPDATE policy on the table**, deliberately. A snapshot is a photograph; you do
  > not retouch a photograph, you take a new one. Correcting a bad upload means uploading the
  > right file, and the wrong one stays in history where it can be seen for what it was.
  >
  > Publishing takes a deliberate click rather than following from the drag, because it changes
  > what every internal user sees. The confirm step names the delta against the current snapshot
  > — `+2 OFQs, +2 rates`, and which OFQIDs are new — which is the only honest answer to *"did I
  > need to re-upload?"*. Age says the sheet is old; the delta says whether anything moved.
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
