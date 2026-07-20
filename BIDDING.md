# BIDDING.md — Groundwork for Rate Negotiation (Ocean · Drayage)

**Status:** Groundwork / design rationale. **Not implemented, not scheduled.**
**Purpose:** capture *why* ocean and drayage need different bidding shapes, and what must be true
before either is built — so the eventual implementation is additive instead of a retrofit.
**Created:** July 2026. **Relates to:** `SUPABASE.md` (schema), `DRAY.md` (§6b supersession),
`PROVIDER_VIEW_MODEL.md` (§2/§4 provider views), `ALERTS.md` (outbound notifications).

---

## 1. The two rate models, side by side

Everything about bidding follows from one structural fact: **in ocean a lane is not a routing; in
drayage the lane *is* the routing.**

| | **Ocean** | **Drayage** |
|---|---|---|
| Lane identity (request) | `pol` + `fd` (POD / Last CY optional) | `last_cy_cfs` + `final_destination` |
| Rate identity (offer) | `pol` + `pod` + `last_cy` + `carrier` | `last_cy_cfs` + `final_destination` |
| Lane ↔ rate | **1 : many** — fans out across POD × Last CY × Carrier | **1 : 1** per forwarder |
| Rates per lane per forwarder | **many, all valid at once** | **exactly one** (`status='current'`, partial unique index) |
| Retirement | `valid_until` **expiry** | explicit **supersession** |
| Freshness signal | the validity window itself | `provided_at` / `confirmed_at` + staleness badge |
| "Still good?" action | *(none — silence = expired)* | **Confirm** (attestation) |
| Pricing axes beyond the lane | POD, Last CY, carrier | none |
| Ack table | one per (lane, forwarder, **period**) | one per (lane, forwarder) — no period |

### Why the axes differ
The ocean rate **terminates at the Last CY**; drayage takes the container from that yard to the door.
They compose:

```
OCEAN :  POL ──► POD ──► Last CY
                            └──► DRAYAGE :  Last CY ──► Final Destination
```

That's why `rates.fd` is annotated *"NULLABLE — FD is a request guide, not part of a rate"*: the ocean
price doesn't cover the final leg. And it's why `drayage_rates` keys on `(last_cy_cfs,
final_destination)` — that pair *is* the entire move, with no carrier or discharge port left to vary.

---

## 2. How a rate REQUEST relates to a raw RATE

**In both services the request is a guide, not a gate.** `lane_id` is nullable on both rate tables —
forwarders can supply rates with no request behind them (ocean: independent rates,
`PROVIDER_VIEW_MODEL` §4; drayage: proactive rates, `DRAY.md` §6c). Internal's Upload page matches
uploads to a lane when it can, else stores them standalone.

The rate row is **self-contained** — it carries its own routing columns rather than inheriting the
lane's. A rate is not "the answer to a lane"; it is an offer that may *reference* a lane.

### Ocean — one ask, many legitimate answers
Request: `Nhava Sheva → Seymour, IN`. Valid simultaneous answers from **one** forwarder:

| POD | Last CY | Carrier | why it's a distinct offer |
|---|---|---|---|
| Los Angeles | Louisville | MSC | west coast + rail to Louisville |
| Los Angeles | Cincinnati | MSC | different inland ramp |
| Houston | New Orleans | ONE | Gulf routing |
| New York | Cincinnati | HPL | east coast |

These are **not** duplicates — different water legs, ramps, carriers, transit times and costs. The
point of asking is to get them all and compare. Multiply by N forwarders and one lane yields a
comparison matrix.

### Drayage — one ask, one answer per forwarder
Request: `Long Beach → Seymour, IN`. Each forwarder has **one standing price**, enforced by the
partial unique index. A second price for that pair is a *replacement*, not an alternative.

### 2c. Request grain is a dial — but it never collapses ocean to 1:1
The request can be made more specific. Pinning the Last CY (asking `POL → Last CY` instead of
`POL → FD`) narrows the fan-out, but never removes it:

| Request specifies | Residual fan-out | Comparison you get |
|---|---|---|
| `POL + FD` (today's default) | POD × Last CY × Carrier | widest — alternative routings *and* carriers |
| `POL + Last CY` | **POD × Carrier** | same inland ramp, different water legs |
| `POL + POD + Last CY` | **Carrier only** | true apples-to-apples |

**Invariant: ocean never reaches 1:1 at any request grain** — `rate_request_lanes` has no carrier
column, so carrier can't be pinned even in principle. The floor is one rate per carrier quoted.

**Specificity encodes intent:**
- `POL + FD` = *"get it there — you tell me the best way."* You're buying routing expertise; the
  forwarder knows whether Louisville, Cincinnati or New Orleans is the cheaper ramp. Over-specifying
  throws that optionality away.
- `POL + Last CY` = *"price this specific leg."* Note this is literally the **handoff point to
  drayage** — `POL → Last CY` is the pure ocean leg, `Last CY → FD` is priced by the drayage system.
  Requesting this way makes the two services compose explicitly.

### 2d. Bids target RATES, never requests
This is the load-bearing decision. A **request is ambiguous** — `POL → Seymour, IN` could be answered
four different ways, so "bid on this request" has no well-defined subject. A **rate is a concrete
offer**: a fully-specified routing with its own row id (and in drayage, uniqueness-enforced).

> **You can only bid on something that exists.** Once a rate is received, the bid's target is
> unambiguous. Before that, there is nothing to negotiate.

Consequence: **the lane is how you *find* the rates; the rate is what you *bid on*.** A competitive
round is "bid on these 5 rates (which happen to answer lane X)" — the lane is a selector/grouping,
not the target. This makes the grain **identical across both services**: a negotiation always points
at a rate row.

### Consequence for bidding
- **Ocean bidding is selection** — many offers exist; you're choosing among them and pushing them down.
- **Drayage bidding is movement** — one number exists; you're moving it.

---

## 3. What "a bid" means in each service

### 3a. Ocean — competitive, routing-scoped, naturally time-boxed
- **Target grain:** always a **specific rate row** (§2d). A round may *select* many rates via their
  lane, but every bid points at one concrete offer. Targeting a lane directly is meaningless for a
  single forwarder — they may hold four offers on it.
- **Mode:** genuinely **multi-party**. Ocean is already a comparison surface, so the natural artifact
  is a *round*: "here are the offers on this lane, sharpen your pencil by Friday."
- **Rounds work best on pinned requests (§2c).** On a `POL + Last CY` request you're ranking one
  variable — price across carriers. On an open `POL + FD` request you're comparing **bundles, not
  numbers**: LA/Louisville/MSC at $4,200 vs HOU/New Orleans/ONE at $3,950 differ in transit time and
  inland risk, so the cheaper one isn't automatically better. An open-request round must surface
  `transit_days` / `free_days` alongside price or it will drive bad decisions.
- **Deadline:** comes for free — lanes have a 10-day TTL and rates have `valid_until`. A round
  inherits a natural clock.
- **Outcome:** an improved offer is just **another appended rate row**. No supersession needed today
  (see §5 prerequisite on latest-per-routing).

### 3b. Drayage — bilateral, lane-scoped, needs an explicit clock
- **Target grain:** the **rate row** — which here coincides with the lane (1:1) and is
  uniqueness-enforced, so it is maximally unambiguous.
- **Mode:** primarily **1:1** ("your $850 → we need $780"), though a lane-level round across
  forwarders is possible since each holds their own current price on that lane.
- **Deadline:** there is **none naturally** — drayage rates never expire. A bid round must carry its
  own explicit expiry, or it hangs open forever.
- **Outcome:** exactly two terminal answers, both of which already exist:
  - improved → **supersession** (new `current` row, old flipped to `superseded`)
  - unchanged → **Confirm** (bumps `confirmed_at`; a legitimate outcome, not a failure)
- **Existing seed:** the refresh request (`kind='refresh'`, `refresh_of → drayage_rates.id`) is the
  primitive ancestor. Bidding = the same skeleton **plus intent and outcome state**.

```
refresh request :  "re-quote this"
bid request     :  "re-quote this — we need under $X"   + accepted / declined / expired
```

---

## 4. Diagrams

**A — The three layers (each builds on the one below)**
```
attestation    Confirm            no price change            (drayage only)
      ▲
supersession   new rate row       price changed, unilateral  (drayage; ocean = append)
      ▲
negotiation    BIDDING            price change SOLICITED, with state + outcome
                                  └ terminates in supersession / new rate, or in Confirm
```
Bidding is **additive** — it wraps a process around mechanisms that already exist and calls them.

**B — Grain of a bid (the lane selects; the rate is the target)**
```
OCEAN     lane ──┬── rate (LA / Louisville / MSC)   ◄── bid targets THIS row
   (selector)    ├── rate (LA / Cincinnati / MSC)   ◄── ...or this one
                 ├── rate (HOU / New Orleans / ONE)     a ROUND = bids on several rows
                 └── rate (NY / Cincinnati / HPL)       that share a lane

DRAYAGE   lane ───── rate (the one current price)   ◄── same grain; lane and rate coincide
```
Never `bid → lane`. A request is an ask with ambiguous grain; only a rate is a concrete offer.

**C — Where bidding state lives (never on the rate)**
```
rate_negotiations (the PROCESS: who asked, target, deadline, status, rounds)
        │ references
        ▼
rates / drayage_rates (the LEDGER: what the price is)     ← stays pure
```

---

## 5. Groundwork — decisions to lock before implementing

1. **A negotiation is a process, not a column.** Never add bid state (`target_price`, `bid_status`,
   `requested_by`) to `rates` / `drayage_rates`. Those tables are the **price ledger**; a negotiation
   has its own lifecycle (open → responded → accepted/declined/expired), participants, deadline and
   possibly multiple rounds. It gets its **own table**.
2. **One table or two?** Recommended: **one `rate_negotiations` table** with a `service` discriminator
   plus two nullable FKs (`ocean_rate_id`, `drayage_rate_id`) and a check that exactly one is set —
   keeps referential integrity across the split pipelines while giving one lifecycle and one UI.
   (Same fork already resolved this way for `notifications.service`.)
3. **A bid always targets a rate row — never a request/lane (§2d).** This keeps the grain identical
   across both services and removes the ambiguity that a lane-level target would introduce. A round
   groups several rate-targeted bids (optionally selected *via* a lane); store that grouping on the
   round, not as the bid's subject. Record both `target_rate_id` and the `resulting_rate_id` so each
   negotiation leaves an explicit lineage from the old offer to the new one.
4. **Terminal states must map onto existing mechanisms** — no new price paths:
   | Outcome | Ocean | Drayage |
   |---|---|---|
   | improved | new appended rate row | supersession (new `current`) |
   | unchanged | nothing (or explicit decline) | **Confirm** |
   | no answer | expires with the lane/round | round expiry (explicit) |
5. **Reuse the notification pipeline.** A bid request is an outbound ask — extend
   `notify-forwarders` with a new `kind` rather than building a parallel mailer. Note
   `notifications.kind` is currently `check (kind in ('request','reminder'))` — that constraint will
   need widening.
6. **Bidding needs a round log anyway** — which also happens to fix the fact that drayage's
   `confirmed_at` is overwritten in place and keeps no attestation history.

---

## 6. Prerequisites (fix these first, or bidding inherits the mess)

**Drayage**
- **Settle the Confirm / Update-price UX.** Bidding's terminal states *are* Confirm and Update. Today
  Confirm shows on day-old rates and there is no "price changed" action on Active Rates, so
  "unchanged" and "changed" aren't cleanly expressible. Fix that first.
- Decide the staleness threshold that actually matches how fast drayage prices move (6 months may be
  too slow).

**Ocean**
- **Latest-per-routing dedup (read-side) — useful, not blocking.** Because bids target a **row id**,
  targeting itself is unambiguous even with duplicates, and the negotiation's
  `target_rate_id → resulting_rate_id` lineage tells you which row a bid produced. The residual
  problem is *unsolicited* re-quotes of the same routing: you may bid against a row that's already
  been quietly re-priced. Dedup (or the read-side "latest per routing" view) is what stops you
  negotiating a stale offer — worth having before rounds, not a hard prerequisite.
- **Resolve container size.** `rates` has **no `container_type`** (it lives on the lane). If pricing
  differs by 20'GP vs 40'HC, the routing identity is incomplete — which breaks both dedup and bid
  targeting. Decide this before either.

**Both**
- **Location string normalization.** Routing/lane keys are free text. The POL/POD/Last CY/FD
  autocomplete (`locationOptions.js`) pushes toward canonical values; trimming/case-folding on write
  is the remaining gap. Bid targeting matches on these keys.

---

## 7. Open questions
- Ocean rounds: sealed (forwarders can't see each other) or informed ("you're 8% above best")?
  Affects trust and what the payload may contain.
- Does internal ever bid **without** an existing rate (a pure tender), or only against a standing one?
- Is a drayage bid allowed to target accessorials (chassis, pre-pull) or only `rate` / `total_rate`?
- Who may open a negotiation — any internal user, or a restricted role?
