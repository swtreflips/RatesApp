# SAILINGS.md — Sailing schedules on the Bookings ocean card

**Status:** **Planned, not implemented** (August 2026). Design settled — the five open questions
were resolved and are recorded in §8; nothing here has been built yet. One live dependency on the
Schedules project is tracked in §9.
**Purpose:** let an internal user click the ocean card in the Bookings itinerary panel and see the
**real sailings** that could carry that booking — pulled live from the Schedules project's
`schedules_latest` materialized view — then pick one, so the panel reports transit time and route
quality alongside landed cost.
**Created:** August 2026. **Relates to:** `BOOKINGS.md` §4 (the three-state grid → OFR → itinerary
panel this attaches to), `BOOKINGS.md` §2c (the landed-cost number this sits beside), the Schedules
project's `SUPA.md` §1/§5 (the `schedules` warehouse and the MV read surface), `BIDDING.md` §6
(carrier codes as part of ocean rate identity),
`features/internal/bookings/rateValidity.js` (the derive-expiry-on-render rule reused by §4c).

---

## 1. The core idea

Bookings answers **what will this cost**. It breaks an OFQ into its applied ocean rates, merges a
real drayage rate, and lands on a total.

It says nothing about **when the box arrives**. So on screen, the cheapest option and the option
that misses the season look identical — and cost is only half of a booking decision.

The Schedules project already holds the other half. Its `schedules_latest` materialized view is
keyed on `(carrier_code, port_of_loading, last_cy)` — **precisely the three facts a Bookings ocean
rate already carries**. The two datasets have been one join apart the whole time; nothing needs to
be built on the Schedules side to make it work.

This feature is deliberately an **add-on**. The OFQ grid, the cards, the menus, the snapshot model
and the cost math are all untouched. One existing card gains a click.

---

## 2. The join

| Bookings has | Schedules has | Match |
|---|---|---|
| `ofr.carrier` (`ONE`) | `carrier_code` | exact |
| `ofr.pol` (falls back to `ofq.pol`) | `port_of_loading` | **case-insensitive** |
| `ofr.lastCy` | `last_cy` | **case-insensitive** |
| `ofq.cargoReadyDate` | `etd` | `etd > cargoReady` |

### 2a. Carrier codes already agree

Schedules ships 12 codes — `HPL ONE WHL HMM MSC MSK CMA COS EMC ZIM YML OOCL`. RatesApp whitelists
those same 12 plus `MATS` and `SML`. Every carrier present in the current OFR seed (CMA, COS, HMM,
HPL, MSC, MSK, ONE, WHL) exists on both sides.

Matson and Sinokor simply have no schedule coverage. That is **a gap to display, not an error**.

### 2b. Case-insensitivity is mandatory, not defensive

The scraped schedule data genuinely contains both spellings of the same port:

```
Houston, TX      and   Houston, Tx
Los Angeles, CA  and   Los Angeles, Ca
Charleston, SC   and   Charleston, Sc
Miami, FL        and   Miami, Fl
Mobile, AL       and   Mobile, Al
New Orleans, LA  and   New Orleans, La
```

A case-sensitive `.eq()` would return roughly half the sailings for those lanes — the worst class
of bug, because a short list looks like an answer rather than a failure. Both port columns must be
matched with `ilike`.

Normalised, the two projects use an identical `City, Region` convention, so nothing else is needed:
`Nhava Sheva, India` on one side is `nhava sheva, india` on the other.

### 2c. Coverage is partial, and "no sailings" is a correct outcome

Measured against the current OFR seed and the current schedules data:

| | Rates has | Schedules has | Overlap |
|---|---|---|---|
| Port of Loading | 5 | 10 | **3** — no **Hai Phong**, no **Ho Chi Minh** (no Vietnam coverage at all) |
| Last CY | 4 | 17 | **3** — no **Baltimore, MD** |

So an empty result will be common and legitimate. The empty state must name the lane and say the
**schedule feed does not cover it** — never imply that nothing sails, and never look like an error.

### 2d. Why the match is POL + Last CY + carrier, and never POD

**A sailing is identified by where the box is handed over, not where the ship docks.** Two shapes
of move are both normal:

```
Nhava Sheva, India → Los Angeles, CA → rail → Salt Lake City, UT     Last CY ≠ POD
Nhava Sheva, India → Los Angeles, CA                                 Last CY = POD
```

In the first, the ocean carrier's responsibility runs past the port to an inland ramp; in the
second it ends at the port. **Either way `last_cy` is where the ocean leg stops and drayage
begins** — which is exactly why Bookings already keys drayage on `lastCy → fd`. Matching sailings
on the same field keeps one definition of the handover point across the whole panel.

Matching on POD would break the first case entirely: two sailings that both discharge at Los
Angeles are different products if one continues to Salt Lake City and the other does not.

Two further reasons POD cannot be a key:

- `final_destination` **was dropped** from the `schedules` table (Schedules `SUPA.md` §1) — the
  scraper resolves nearby warehouses to the same `last_cy`, and keeping the column made identical
  rows look distinct. `last_cy` is the destination identity there.
- `port_of_discharge` carries inconsistent casing (`NORFOLK, VA` against `Norfolk, Va`).

POD is therefore **display-only** — useful to read on the card, never part of the lookup.

---

## 3. Reading across projects

Rates and Schedules are **separate Supabase projects** (`sfozxpibfpqsdlxoheyl` and
`jnuigkggmynerrbxvkzy`). A RatesApp user has no session on Schedules and never will.

That turns out not to matter. Schedules' `SUPA.md` §5 already ends with:

```sql
GRANT SELECT ON schedules_latest TO anon, authenticated;
```

RLS is off on `schedules` (internal-only app, every user sees every row), and the Schedules React
app itself reads the MV straight from the browser with its anon key. **A second read-only client in
RatesApp adds no exposure that isn't already public** — it is the same key against the same grant.

So: no Edge Function, no service-role key, no proxy, and no SQL on the Schedules side. This also
keeps faith with the project rule against inventing backend layers.

### 3a. `persistSession: false` is load-bearing

```js
createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
```

Two supabase-js clients on one origin share the same localStorage keys by default and will fight
over the stored session. Without this flag, adding the Schedules client can **log users out of
Rates** — a failure that would look completely unrelated to sailings. This client never
authenticates; it only reads a view granted to `anon`.

### 3b. Environment

`VITE_SCHEDULES_SUPABASE_URL` and `VITE_SCHEDULES_SUPABASE_ANON_KEY`, in `.env.local` **and**
Vercel. When unset, the feature hides itself and the ocean card behaves exactly as it does today —
the same degradation pattern `ApplyRates.jsx` already uses for `VITE_GEO_API_URL`.

---

## 4. New files

| Path | Role |
|---|---|
| `src/lib/schedulesSupabase.js` | the second read-only client (~12 lines) |
| `src/features/internal/bookings/schedulesService.js` | `findSailings()` — the query and its date handling |
| `supabase/migrations/<ts>_booking_schedule_picks.sql` | where a chosen sailing is recorded |

### 4a. The query

```js
findSailings({ carrier, pol, lastCy, notBefore })   // → { sailings, error }
```

```
.from('schedules_latest')
.select('carrier_code, port_of_loading, last_cy, port_of_discharge,
         etd, pod_eta, eta, transit_time_days, transport_type, mother_vessel')
.eq('carrier_code', carrier)
.ilike('port_of_loading', pol)
.ilike('last_cy', lastCy)
.gt('etd', notBeforeISO)
.order('etd', { ascending: true })
.limit(25)
```

**Date formats differ and must be reconciled.** `etd` is stored ISO (`2026-05-20`);
`cargoReadyDate` arrives from the seed as `M/D/YYYY`. Reuse **`dateVal()` from
`bookings/rateValidity.js`** — it already parses both forms — then emit ISO for the filter. A blank
or unparseable cargo ready date falls back to **today**, so the list is never accidentally
unbounded backwards.

**`transport_type` is an opaque string.** The Schedules `Schedule` TypeScript type declares it as
`"Direct" | "1 TS" | "2 TS"`, but the real data also holds `3 TS` and `4 TS` — and that same type
still lists the dropped `final_destination`. Treat the type as stale; do not copy it across.

### 4b. Recording the pick

```sql
create table public.booking_schedule_picks (
  id uuid primary key default gen_random_uuid(),
  ofq_id text not null,
  ofr_id text not null,
  -- a COPY of the sailing, not a reference
  carrier_code text, port_of_loading text, last_cy text, port_of_discharge text,
  etd date, pod_eta date, eta date,
  transit_time_days integer, transport_type text, mother_vessel text,
  picked_by uuid references public.profiles(id),
  picked_at timestamptz not null default now(),
  unique (ofq_id, ofr_id)
);
```

**The sailing is copied, not referenced.** `schedules_latest` is a materialized view rebuilt from
scratch on every ingest; the exact row picked today may not exist tomorrow, and it lives in a
different database besides. A copy is what "we chose this sailing" actually means — the decision
has to outlive the feed.

**Keyed on `(ofq_id, ofr_id)`, with no snapshot foreign key.** Those are stable business
identifiers, so a pick survives the next seed upload. Re-uploading the sheet must not erase
decisions people have already made.

RLS mirrors `booking_snapshots` — internal-only via `my_org_type() = 'internal'`, forwarders get no
policy at all, because this is internal planning data. **One deliberate difference:** this table
gets update/delete policies. A snapshot is a photograph and must not be retouched; a pick is a
decision, and changing your mind is the normal case. Writes are an upsert on the unique key.

### 4c. A pick expires when its ETD passes

A sailing that has already left cannot carry the booking, so once `etd` is in the past the pick
stops counting as the current answer.

**Expiry is derived on render, never stored and never written back.** No status column, no
scheduled job, no mutation of the row:

```js
const expired = dateVal(pick.etd) < startOfToday()
```

This is the same rule and the same helpers as expired ocean rates in
`bookings/rateValidity.js` — evaluated fresh against today, every time the panel draws. A pick made
in August is simply expired in September without anything having run in between, and if the whole
concept changes later there is no stored state to migrate. It also keeps one definition of
"expired" on a screen that now has two things that can lapse.

The row is **kept, not deleted**. What was chosen and by whom stays legible, and the pick can be
replaced by choosing again — the same upsert path as any other change.

---

## 5. UI

Inside `ItineraryPanel`, the existing ocean card — the `sea-200` box in the Port of Loading stop —
becomes clickable and toggles a sailings section **beneath it, inside the same `TimelineStop`**.
Nothing above or below it moves.

```
Port of Loading · Nhava Sheva, India
┌───────────────────────────────────────┐
│ 🚢 Topocean          [ONE]     $3,200 │  ← click to open sailings
│    valid until 8/30/2026              │
├───────────────────────────────────────┤
│ SAILINGS  etd after 15 Aug            │
│ ○ 18 Aug → 12 Sep   25d · Direct      │
│      ONE OLYMPUS                      │
│ ● 21 Aug → 19 Sep   29d · 1 TS        │  ← selected
│      NYK VESTA                        │
└───────────────────────────────────────┘
```

Six fields per sailing, no more: **ETD · POD ETA · ETA · transport type · transit time · mother
vessel**. Deliberately thinner than the Schedules grid — this is a booking decision aid, not a
schedules browser. Anyone needing the full routing has the Schedules app.

Once picked, those fields render as a compact block on the card, so the panel now carries cost
**and** time. Scope stays **panel-only**: the OFQ grid rows and the stat cards are not touched.

**One pick per ocean rate, not per OFQ.** An OFQ's rates are different products — a Los Angeles
discharge that rails on to Salt Lake City is not interchangeable with one that stops at the port
(§2d) — so each carries its own sailing, keyed on `ofr_id`.

### 5a. An expired pick

Per §4c a pick lapses once its ETD passes. The card says so plainly and offers the current list
again:

```
├───────────────────────────────────────┤
│ SAILING  ⚠ sailed 21 Aug — expired    │
│    NYK VESTA · 29d · 1 TS             │
│    [ pick another sailing ]           │
└───────────────────────────────────────┘
```

It is shown rather than hidden: the reason this booking is now unplanned is that the sailing it
depended on has gone, and that is the thing someone needs to see. Consistent with how expired ocean
rates surface — the fact is stated, the row is not silently dropped.

---

## 6. Verification

1. **The join returns rows** — on a lane present in both (ONE · Nhava Sheva · Los Angeles), and
   every ETD is after the OFQ's cargo ready date.
2. **Case-insensitivity specifically** — query `Houston, TX` and confirm rows stored as
   `Houston, Tx` are included. This is the one that would silently half-work.
3. **Coverage gaps read correctly** — a Hai Phong or Baltimore OFQ says the feed doesn't cover the
   lane; not an error, not a spinner.
4. **The Rates session survives** — load Bookings, hard-reload, navigate away and back, stay logged
   in. This is what §3a protects and the most likely way this breaks something unrelated.
5. **A pick persists and is shared** — choose, reload, confirm; confirm a second internal user sees
   it; change it and confirm upsert replaces rather than duplicates.
6. **Re-upload doesn't wipe picks** — publish a new OFR seed and confirm picks still attach.
7. **Expiry is derived, not stored** — pick a sailing, then confirm the card reports it expired
   once its ETD is in the past **without anything having written to the row**. Testable without
   waiting: pick a sailing and check the same row renders as current or expired purely on the date
   it is evaluated against.
8. **Both routing shapes match** — a lane where Last CY = POD (box stays at Los Angeles) and one
   where Last CY ≠ POD (rails on to Salt Lake City) each return their own sailings, and neither
   picks up the other's.
9. **Missing env degrades quietly** — unset the URL, confirm the ocean card behaves as today.
10. `npm run build` clean; ocean and drayage cost math unchanged.

---

## 7. Explicitly out of scope

- **No changes to the Schedules project.** No new SQL, no new grants, no redeploy.
- **No changes** to the OFQ grid, stat cards, snapshot model, or drayage/cost logic.
- **No ranking by transit.** The panel reports time; it does not re-order options by it.
- **No alternatives/transshipment detail.** `ts_ports`, `ts_vessels`, `route_ports` and
  `vessel_sequence` stay in the Schedules app.

---

## 8. Settled decisions

Resolved August 2026, recorded here because each one closed a real fork in the design.

1. **A pick expires when its ETD passes** — derived on render, row kept, card says so and offers
   the list again. See §4c and §5a.
2. **Feed age is not shown.** `schedules_latest` refreshes on scraper cadence with no freshness
   window, so a lane's "latest" snapshot can be weeks old — but the panel will not surface that
   for now. Deliberately deferred, not overlooked; §9 keeps it visible.
3. **A pick belongs to the ocean rate, not the OFQ** — keyed on `(ofq_id, ofr_id)`. Two rates on
   one quote can be genuinely different products (§2d), so they get their own sailings.
4. **`MATS` and `SML` get no special treatment.** They have no schedule coverage, but the generic
   empty state is enough — no per-carrier messaging.

---

## 9. Known gaps — to be fixed

**The schedule feed does not cover every lane Rates quotes.** Measured against the current data
(§2c):

| Missing | Side | Effect |
|---|---|---|
| **Hai Phong, Vietnam** | Port of Loading | no sailings for any OFQ on that origin |
| **Ho Chi Minh, Vietnam** | Port of Loading | as above — Vietnam has no coverage at all |
| **Baltimore, MD** | Last CY | no sailings for that discharge/ramp |

Cause not yet established — scraper backlog, carrier coverage, or a port-naming mismatch upstream
have not been ruled apart. **This needs fixing on the Schedules side**, not worked around here: the
feature is correct to show nothing when the feed knows nothing, and papering over it in RatesApp
would hide the real problem.

Until then the empty state must read as a **coverage gap, not an error** (§2c), so the difference
between "we have no data for this lane" and "something broke" stays visible.

Also parked, from §8.2: whether the panel should eventually show how old a lane's snapshot is, the
way `SnapshotStamp` does for the OFR seed.
