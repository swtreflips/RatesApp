# SKATE.md — three layouts for the Bookings OFQ table

**Status:** **1 and 2 are both built, behind a toggle** in the table toolbar — *By shipment* and
*All rates*. They share one header and one row component (`OfrHeader` / `OfrRow` in
`Bookings.jsx`), so the columns cannot drift between them. Option 3 is not built.

Keeping both was not the original plan — §6 anticipated it, and it turned out to be the honest
way to choose: the two answer different questions, and reading them side by side settles it faster
than describing them does. Dropping the loser later is deleting one branch and one constant.
**Scope:** The **initial table only** — the grid where every OFQ is listed. The right-hand
itinerary panel (sailings, drayage options, landed total) is explicitly out of scope and does not
change in any of these.
**Relates to:** `BOOKINGS.md` §4 (the three-state grid → OFR → panel model this refines),
`SAILINGS.md` §5 (where the Transit values come from).

---

## 1. The problem

The table shows the same kind of information two different ways.

An **OFQ** is a grid row: aligned columns, fixed widths, everything lines up.
Its **rates** are cards inside the expanded area: a flex row, so each value sits wherever the
content before it pushed it.

That is not only an inconsistency, it has a cost. The rate is the number being compared, and in a
card it does not line up between two rates on the same quote — let alone between two quotes. You
end up reading prices by scanning rather than by looking down a column, which is the one thing a
table is for.

The question this document answers: **what should the initial table look like instead?**

---

## 2. What the data says

Measured against the live snapshot — 128 rates across 13 OFQs — rather than assumed.

| Finding | What it means for the layout |
|---|---|
| **A rate's POL is never different from its OFQ's POL.** 0 of 128. | `POL → POD → Last CY` would repeat a value that is already an OFQ column, 128 times. What actually varies is **POD → Last CY** |
| 6 discharge ports · 5 Last CYs · 6 forwarders · 8 carriers | There is real variety to compare — a table earns its keep |
| ~10 rates per OFQ | Flat layout ≈ 128 rows; grouped ≈ 13 rows until expanded |
| Sailing data exists **only where somebody picked one** | A Transit column starts mostly empty, and has to read as *not chosen yet* rather than *missing* |

> **On the routing column.** The request was `POL → POD → Last CY`. Since POL never diverges from
> the OFQ's, options 1 and 3 show **`POD → Last CY`** and let the OFQ's own POL column carry the
> origin. Option 2 spells the full chain out, because there the OFQ header is a band rather than a
> set of columns. If POL ever does start diverging, it should appear in the chain — that is a data
> change, not a design one.

---

## 3. Alternative 1 — Aligned sub-table

**Recommended.** Structure is unchanged: collapsed OFQ rows, click to expand. The rates stop being
cards and become a real table with their own header, indented under the OFQ.

```
     OFQID     PORT OF LOADING      FINAL DESTINATION   CARGO READY   OCEAN RATES
 ▸   OFQ1789   Laem Chabang, TH     Commerce, CA        13 Aug        5 rates · 4 covered
 ▾   OFQ1787   Nhava Sheva, India   Seymour, IN         17 Aug        9 rates · 3 covered

       ROUTING                     FORWARDER        CARRIER  TRANSIT  DRAYAGE  RATE
     ◆ Los Angeles → Los Angeles   Forwarder A      ONE      28d      3        $3,200
       Los Angeles → Los Angeles   Forwarder B      MSC      —        1        $3,340
       Norfolk → Chicago           Forwarder C      HPL      —        none     $3,410

 ▸   OFQ1796   Nhava Sheva, India   Atlanta, GA         27 Jul        9 rates · 9 covered
```

`◆` marks the cheapest.

**Why this one.** It matches the thought process directly: *"I have a shipment from Nhava Sheva to
Seymour — what came back for it?"* That is not a comparison across shipments. It is one shipment,
then its offers. The OFQ stays the thing you navigate; the rates become the thing you compare, in
aligned columns.

It is also the smallest change — same grid, same expand behaviour, same chips. Only the card
markup is replaced.

**Trade-off.** Comparing rates between two OFQs still means opening both.

---

## 4. Alternative 2 — Flat offer table

Every row is a **rate**. The OFQ becomes a full-width band that groups them.

```
   ROUTING                        FORWARDER      CARRIER  TRANSIT  DRAY  READY   RATE
  ─────────────────────────────────────────────────────────────────────────────────────
  ▾ OFQ1787 · Nhava Sheva, India → Seymour, IN · 3 × 40' HC                    9 rates
     Nhava Sheva → LA → Los Angeles   Forwarder A    ONE     28d     3    17 Aug  $3,200
     Nhava Sheva → LA → Los Angeles   Forwarder B    MSC     —       1    17 Aug  $3,340
     Nhava Sheva → Norfolk → Chicago  Forwarder C    HPL     —       0    17 Aug  $3,410
  ▾ OFQ1789 · Laem Chabang, TH → Commerce, CA · 1 × 40' HC                     5 rates
     Laem Chabang → LA → Los Angeles  Forwarder D    MSK     31d     2    13 Aug  $2,980
```

**Why you might want it.** Nothing is hidden and nothing needs clicking. One sort by Rate ranks
every offer you currently hold, which answers *"who is cheapest out of Nhava Sheva right now, on
any quote"* — a question the other two cannot answer without opening everything.

**Trade-off.** About 128 rows, so it becomes a scrolling exercise. The OFQ context has to be
carried by the band rather than by columns. And it optimises for a question that was not the one
described.

---

## 5. Alternative 3 — Shipment sections

No chevrons. Each OFQ is a heading block with its rate table always visible beneath it.

```
┌─ OFQ1787 ──────────────────────────────────────────────────────────────────┐
│  Nhava Sheva, India  →  Seymour, IN                                        │
│  ready 17 Aug · 3 × 40' HC · 9 rates · 3 with drayage                      │
├────────────────────────────────────────────────────────────────────────────┤
│   ROUTING                     FORWARDER      CARRIER  TRANSIT  DRAY   RATE │
│ ◆ Los Angeles → Los Angeles   Forwarder A    ONE      28d      3    $3,200 │
│   Los Angeles → Los Angeles   Forwarder B    MSC      —        1    $3,340 │
│   Norfolk → Chicago           Forwarder C    HPL      —        0    $3,410 │
└────────────────────────────────────────────────────────────────────────────┘

┌─ OFQ1789 ──────────────────────────────────────────────────────────────────┐
│  Laem Chabang, Thailand  →  Commerce, CA                                   │
│  ready 13 Aug · 1 × 40' HC · 5 rates · 4 with drayage                      │
├────────────────────────────────────────────────────────────────────────────┤
```

**Why you might want it.** It reads exactly like the sentence used to describe the job. The OFQ is
a *heading*, which is what it actually is, rather than a row pretending to be data. Nothing is
collapsed, so nothing is forgotten.

**Trade-off.** 13 sections of ~10 rates is a long page, so search becomes the primary way in rather
than a convenience. Worst of the three for "show me everything at a glance".

---

## 6. Which to pick

| If you mostly… | Pick |
|---|---|
| Open one shipment and study its offers | **1 — Aligned sub-table** |
| Compare prices across every quote at once | **2 — Flat offer table** |
| Work through a short list end to end | **3 — Shipment sections** |

They are not mutually exclusive forever — 1 and 2 are the same columns with a different grouping,
so 1 can become a view toggle later if the flat view turns out to be wanted.

---

## 7. Details that apply whichever is chosen

**The Transit column starts mostly empty.** Sailing data only exists where somebody has picked one
(`SAILINGS.md` §5), so most rows read `—`. That em dash is doing real work: it marks the rates
whose timing is still unknown, which makes the empty column a prompt rather than a gap. If it stays
empty in practice, the column is not paying for its width and should be reconsidered.

**Rate is the anchor.** Right-aligned, tabular figures, heaviest weight in its row. It is the value
being compared, so its alignment matters more than any other column's.

**Cheapest is marked, not merely sorted.** Rates already sort cheapest-first on expand. A marker on
the cheapest row means the answer is readable without trusting the sort.

**Reuse what is already there.** `CarrierChip` and `CoverageChip` in `Bookings.jsx` are already the
right density for a table cell. `money()` and the `fmtDate` helpers stay as they are.

**Selection does not change.** Clicking a rate row drives the right-hand panel exactly as clicking a
card does today. Only the row's markup differs.

**Nothing new is fetched.** Every column above is already on screen or already in `picks`.

---

## 8. Verification, when it is built

1. The rate column lines up — two rates in different OFQs, both expanded, share an x position.
2. Clicking a rate row still opens the itinerary panel with that rate, visibly selected.
3. The right panel is untouched — sailings, drayage and landed total behave identically.
4. Empty and lapsed states still read differently: `none applied` vs `no valid rates`.
5. Search still filters on OFQID, POL and destination.
6. No horizontal page scroll at 1280 and 1440; the table scrolls inside its own container.
7. `npm run build` clean.
