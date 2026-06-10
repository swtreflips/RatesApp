# Provider View Model

**Status:** Authoritative spec for the provider side of the requester↔provider relationship.
**Created:** June 10, 2026
**Supersedes:** the "Pending Rate Requests" / "Submitted Rates (30 days)" provider views described in `dataDesign.txt` Parts 5–6 and the original brief in `dataArchitecture.md`.

This document defines exactly what a provider (freight forwarder) sees and how their actions relate back to the requester's demand. It is the source of truth for the provider experience; other design docs defer to it where they conflict.

---

## 1. The provider sees exactly two things

| # | View | Driven by | Question it answers |
|---|------|-----------|---------------------|
| 1 | **Lanes to fill** | lane TTL (active lanes) | "What demand still needs my attention?" |
| 2 | **Active rates** | rate validity (`valid_until >= today`) | "What rates do I currently have live?" |

View 1 is **requester-originated demand**. View 2 is **provider-originated supply**. They are different groupings of the system, not two slices of the same list.

A small **"Skipped"** sub-filter hangs off View 1 (see §3). It is not a third top-level view — it's a holding area for lanes the provider dismissed and may want back.

> The previous design had View 2 as "Submitted Rates," visible for 30 days from lane posting. **That 30-day window is removed.** Provider visibility of their own work is now governed entirely by each rate's `valid_until`.

---

## 2. View 1 — Lanes to fill (the clearable demand list)

The forwarder's goal is to **clear this view** — when it's empty, they know they are up to date with our demand for the current period.

A lane appears here when it is **active** and the provider **has not yet acted on it** this period. There are two ways to act (both clear the lane):

| Action | What it writes | Clears View 1? | Shows in View 2? |
|--------|----------------|----------------|------------------|
| **Submit rates** | a `submitted` acknowledgement + rate rows | yes | yes (as current rate) |
| **Skip** | a `skipped` acknowledgement, 0 rates, a reason | yes (→ Skipped tab) | no |
| **Do nothing** | nothing | no — stays as open demand | no |

"Do nothing" is deliberate: if a provider expects to have rates later, they leave the lane and fill it in before the TTL expires.

```sql
-- VIEW 1: Lanes to fill
SELECT
  l.id, l.pol, l.fd, l.container_type, l.container_count,
  l.posted_at, l.expires_at,
  EXTRACT(DAY FROM l.expires_at - now())::int AS days_left
FROM rate_request_lanes l
LEFT JOIN rate_submissions s
  ON s.lane_id = l.id
  AND s.provider_id = :provider_id
  AND s.period = l.period
WHERE l.expires_at > now()     -- active lanes only (10-day TTL)
  AND s.id IS NULL             -- not yet acted on (neither submitted nor skipped)
ORDER BY l.expires_at ASC;     -- soonest-to-expire first
```

**Bidding / rate updates do NOT happen here.** Once a lane is quoted it leaves View 1, so lowering or revising a bid happens on **View 2 (Active Rates)**, by adding a new rate for the same routing. View 1 stays purely "untouched demand."

---

## 3. Skip — clearing a lane without rates

A provider skips a lane when they can't quote it right now (no coverage for that origin, no space this period, etc.). Skipping keeps View 1 clean without pretending they responded with rates.

- A skip writes one `rate_submissions` row with `status = 'skipped'`, `skip_reason` set, and **zero** rate rows.
- The lane leaves "To fill" and moves to the **Skipped** sub-filter of View 1.
- Skip is **per `(lane, provider, period)`** — it does not affect other providers and does not carry across periods.

### Skipped tab (recoverable)

```sql
-- VIEW 1b: Skipped lanes (still active, dismissed by this provider this period)
SELECT
  l.id, l.pol, l.fd, l.container_type, l.container_count,
  l.posted_at, l.expires_at,
  s.skip_reason, s.submitted_at AS skipped_at
FROM rate_request_lanes l
JOIN rate_submissions s
  ON s.lane_id = l.id
  AND s.provider_id = :provider_id
  AND s.period = l.period
WHERE l.expires_at > now()
  AND s.status = 'skipped'
ORDER BY l.expires_at ASC;
```

### Un-skip

Circumstances change (space frees up). The provider reopens a skipped lane from the Skipped tab:

```sql
-- UN-SKIP: remove the skip acknowledgement so the lane returns to "To fill"
DELETE FROM rate_submissions
WHERE lane_id = :lane_id
  AND provider_id = :provider_id
  AND period = :period
  AND status = 'skipped';
```

Deleting the skip row makes the `LEFT JOIN ... IS NULL` in View 1 match again, so the lane reappears in "To fill," ready to quote. Because the `UNIQUE(lane_id, provider_id, period)` constraint allowed only that one skip row, the slot is now free for a future `submitted` acknowledgement.

---

## 4. View 2 — Active rates (the live rate catalog)

What the provider currently has on offer. **Validity-driven**, and **independent of rate requests** — it includes independent rates (`lane_id IS NULL`, see `dataDesign.txt` Part 9), not just rates tied to a requester lane.

When a provider has bid several times on the same routing+carrier and more than one bid is still date-valid, **only the current rate per routing is shown** — the latest valid bid. Superseded-but-still-valid bids are history (visible only in a per-routing drill-down, per `dataDesign.txt` Part 10).

```sql
-- VIEW 2: Active rates (current rate per routing, validity in the future)
SELECT DISTINCT ON (provider_id, pol, pod, last_cy, fd, carrier)
  id, lane_id, pol, pod, last_cy, fd, carrier,
  rate_amount, currency, transit_days, valid_from, valid_until, notes, created_at
FROM rates
WHERE provider_id = :provider_id
  AND valid_until >= CURRENT_DATE
ORDER BY provider_id, pol, pod, last_cy, fd, carrier, created_at DESC;
```

One row per `(provider, pol, pod, last_cy, fd, carrier)`. A rate drops out of this view the day its `valid_until` passes — no manual cleanup, no 30-day rule.

### Re-submission — append storage, latest-only display

When a provider re-submits to lower or revise a rate within the period, **storage and display are decided separately**:

- **Storage = append.** The old rate row is **never deleted**. The new bid is inserted as an additional row. The single `rate_submissions` acknowledgement is kept (one per `lane+provider+period`) and its `submitted_at` refreshed.
- **Display = latest only.** The provider sees just their latest active bid per routing (the `DISTINCT ON ... created_at DESC` query above). Older bids are hidden from them, not deleted.

```
Provider drops MSC LA→LA from $2,000 to $1,850:

  rates table          $1,850  created Apr 10   ← provider sees this
                       $2,000  created Apr 8    ← kept (requester can see)
```

> **Why not delete (the old "Option A — replace")?** Deleting on re-submit was explicitly **rejected**: it destroys the history the requester needs (see §6a) and the rate-evolution display in `dataDesign.txt` Parts 10–13. The provider *experiences* a replace (one number per routing); the database *keeps* everything.

---

## 5. A "submission" is now an acknowledgement

This change reframes the `rate_submissions` table. It no longer means *"I responded with rates"* — it means **"I acted on this lane,"** and the `status` says how:

```sql
-- rate_submissions (delta from dataDesign.txt Part 2, Table 3)
rate_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_id       uuid REFERENCES rate_request_lanes(id),   -- NULLABLE (independent rates)
  provider_id   uuid NOT NULL,
  period        integer,                                  -- NULLABLE (independent rates)
  status        text NOT NULL DEFAULT 'submitted',        -- 'submitted' | 'skipped'   ← NEW
  skip_reason   text,                                     -- 'no_coverage' | 'no_space' | free text  ← NEW
  submitted_at  timestamptz NOT NULL DEFAULT now()
);

-- one acknowledgement per provider per lane per period (submit OR skip, never both)
CREATE UNIQUE INDEX idx_submissions_unique_linked
  ON rate_submissions(lane_id, provider_id, period)
  WHERE lane_id IS NOT NULL;
```

Only **two columns** are added (`status`, `skip_reason`). No new table. The model already accepted that a submission with 0 rates is valid (`dataDesign.txt` line 177) — a skip is exactly that, with intent attached.

---

## 6. The requester sees skips

Skip is a signal that flows back across the relationship. On the requester's per-lane response roster there are now **three** provider states:

```
Nhava Sheva, India → Commerce, CA   (period 1)
  FF-A   3 rates                     ← submitted
  FF-B   Skipped — no space          ← status = 'skipped', skip_reason
  FF-C   — no response yet           ← no acknowledgement row
```

```sql
-- Requester: response roster for a lane
SELECT
  s.provider_id,
  s.status,
  s.skip_reason,
  COUNT(r.id) AS rate_count
FROM rate_submissions s
LEFT JOIN rates r ON r.submission_id = s.id
WHERE s.lane_id = :lane_id
  AND s.period = :period
GROUP BY s.provider_id, s.status, s.skip_reason;
```

"No response yet" is simply the absence of a row (distinguishing it from a skip requires knowing the provider universe — a coverage concept deferred to a later phase).

## 6a. The requester sees rates — default vs full history

Because storage is append-only (§4), the requester has access to **every** bid ever submitted. But the two needs are different:

| Mode | What it shows | Status |
|------|---------------|--------|
| **Default (booking)** | Latest active bid per routing per provider (`valid_until >= today`, newest `created_at`). One number to decide on. | The everyday view. |
| **Full history** | All bids ever submitted for a lane/routing. Powers bid-evolution ($2,200 → $2,000 → $1,850). | **Capability, not yet designed.** The data is preserved; the where/how UI is TBD. |

This is the asymmetry between the roles: the **provider** only ever sees their latest active bid (no history access). The **requester** defaults to latest for booking but **must retain the ability** to expand into the complete bid history. Append storage is what makes that future capability possible — see `dataDesign.txt` Part 6 (Requester Views) for the queries.

---

## 7. Periods and the two clocks

- **Lane TTL = 10 days** (reduced from 14). Drives View 1. `expires_at = posted_at + interval '10 days'`.
- **Rate validity** (`valid_until`, set per rate by the provider). Drives View 2. Independent of the lane TTL.
- **Extension = new period.** When a requester extends a lane, `posted_at = now()`, `expires_at = now() + 10 days`, `period = period + 1`. Old-period acknowledgements (submitted *and* skipped) do **not** carry forward, so the lane reopens in "To fill" for every provider as fresh demand.

There is no longer a third "30-day submission visibility" clock. Only these two.

---

## 8. Navigation impact

| Old provider nav | New provider nav |
|------------------|------------------|
| Dashboard | Dashboard |
| Open Lanes | **Lanes to fill** (with To-fill / Skipped tabs) |
| My Submissions | **Active Rates** |

---

## 9. Summary

- **Two views:** *Lanes to fill* (demand, TTL-driven) and *Active rates* (supply, validity-driven).
- **Clear a lane two ways:** submit rates, or skip with a reason. Doing nothing leaves it open.
- **Skip** is recoverable (Skipped tab → un-skip), per period, and **visible to the requester** with its reason.
- **`rate_submissions` becomes an acknowledgement** via `status` + `skip_reason` — two new columns, no new table.
- **Removed:** the 30-day "Submitted Rates" window. View 2 is `valid_until`-driven only.
- **Storage is append-only; display is latest-only.** Re-submitting appends a new rate row (never deletes). Providers see only their latest active bid; the requester defaults to latest for booking but retains a (not-yet-built) full-history capability.
- **TTL is now 10 days.**
