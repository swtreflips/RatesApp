# Coverage Model — per-forwarder lane masking

**Status:** Design spec for a deferred feature. **Not implemented.** Build this when
onboarding real forwarders, not during the mock rehearsal.
**Created:** June 12, 2026
**Relates to:** `PROVIDER_VIEW_MODEL.md` (View 1 "Lanes to fill"), `CLAUDE.md`
("Coverage / filtering concept"), and the canonical-normalization dependency in
`PROVIDER_VIEW_MODEL.md` §7a.

---

## 0. The problem

Lanes are **shared demand** — when the requester posts a lane, *every* forwarder sees
the same row (one `rate_request_lanes` row, exposed to all providers by the
`providers read lanes` RLS policy). That fan-out is intentional.

But some forwarders don't quote some origins. Example: **we don't want India rates from
Topocean**, even though we *do* post India lanes (other forwarders quote them). We need
Topocean's "Lanes to fill" to **hide** India lanes, while everyone else still sees them.

This is a **per-forwarder mask over the shared lane list.**

---

## 1. The most important framing: relevance mask, not security

There are two different "who sees what" mechanisms in this app. Do not confuse them —
they live in different layers:

| Mechanism | Protects | Lives in | If bypassed |
|---|---|---|---|
| **Rate isolation** (Forwarder A can't see B's pricing) | sensitive data | **RLS** (hard, enforced) | a real breach — competitor pricing leaks |
| **Coverage mask** (Topocean doesn't see India lanes) | relevance / noise | **a query** (soft) | Topocean sees a lane they'd ignore — annoying, not a breach |

Lanes are **non-sensitive shared demand** — every forwarder is *allowed* to see them.
Hiding India from Topocean is about keeping their list clean, **not** secrecy. So:

> **Coverage is a filter applied in a query, NOT an RLS policy.** Keep
> `providers read lanes` permissive. Do the masking when building View 1.

(Only move coverage into RLS if you ever have a *contractual* "this forwarder must never
be able to see these lanes" requirement. That is not the current need.)

---

## 2. Where the filtering runs — frontend vs. database (the common confusion)

Separate two things that are easy to conflate:

- **Where the rules are STORED** → always the **database**, in a `forwarder_coverage`
  table. This is *data* (like `profiles`). It is **not** a frontend concept.
- **Where the filter RUNS** → a **query** that reads that table. "Query" here means
  *a normal SELECT, as opposed to an RLS policy* — it does **not** mean "frontend."

That filter query can execute in two places, both reading the same DB table:

### Option A — client-side (in `fetchActiveLanes()`)
The frontend fetches lanes + the forwarder's coverage rows, then drops matches in JS —
the same shape as the existing *acted-on* anti-join.

```js
// in submissionService.js (illustrative)
const { data: lanes }    = await supabase.from('rate_request_lanes').select(...).gt('expires_at', now)
const { data: coverage } = await supabase.from('forwarder_coverage').select('*')  // RLS-scoped to my forwarder
const excluded = (lane) => coverage.some(c => c.mode === 'exclude' && originMatches(lane, c))
return lanes.filter(l => !excluded(l) /* && not acted-on */)
```

- ✅ simplest; mirrors what's already there.
- ⚠️ excluded lanes still travel to the browser (acceptable — lanes aren't secret).
- ⚠️ the matching logic (`originMatches`) lives in JS, duplicated if other queries need it.

### Option B — server-side (a Postgres VIEW or RPC) — **recommended**
A DB view does the join/filter; the frontend just selects from it.

```sql
create view lanes_to_fill as
select l.*
from rate_request_lanes l
where l.expires_at > now()
  -- coverage mask: hide lanes an 'exclude' rule of the caller's forwarder matches
  and not exists (
    select 1 from forwarder_coverage c
    where c.forwarder_id = my_forwarder()
      and c.mode = 'exclude'
      and lane_origin_matches(l, c)        -- helper; see §4
  );
-- the acted-on anti-join can live here too, or stay client-side
```
```js
const { data } = await supabase.from('lanes_to_fill').select('*')  // filtering already done
```

- ✅ excluded lanes never reach the browser.
- ✅ rule logic in one place; reusable by other queries (roster, dashboards).
- ✅ `my_forwarder()` already exists, so the view is self-scoping per caller.
- ⚠️ slightly more upfront SQL.

> **Recommendation:** use **Option B (a view / RPC)** for coverage. Keep the table as the
> single source of rules; let the database apply them. `fetchActiveLanes()` then just
> reads `lanes_to_fill` instead of `rate_request_lanes`.

Either way: **`forwarder_coverage` is a DB table; the frontend (or a view) reads it.**

---

## 3. The rule store: `forwarder_coverage`

Rules are **data**, one row per rule — so adding "Topocean excludes India" is an INSERT,
consistent with the data-only onboarding philosophy.

```sql
create table forwarder_coverage (
  id            uuid primary key default gen_random_uuid(),
  forwarder_id  uuid not null references forwarders(id),   -- whose rule (company-level)
  mode          text not null check (mode in ('exclude','include')),
  dimension     text not null,        -- 'origin_country' | 'origin_region' | 'origin_port' | 'dest_country' ...
  match_value   text not null,        -- 'India' / 'IN' / a locode prefix
  created_at    timestamptz not null default now()
);
create index idx_coverage_forwarder on forwarder_coverage(forwarder_id);

-- RLS: a forwarder may read its own coverage rules (so Option A can fetch them);
-- writes are admin-only (seeded like profiles), so no insert policy from the app.
alter table forwarder_coverage enable row level security;
create policy "own coverage" on forwarder_coverage
  for select using (forwarder_id = my_forwarder());
```

Semantics:

- **Default = see everything.** A forwarder with **no** rows behaves exactly as today
  (sees all lanes). You only add rows to carve out exceptions. This keeps the rollout safe.
- **`exclude` (blocklist)** — the common case. "Topocean, exclude, origin_country, India"
  → show all lanes *except* India origins.
- **`include` (allowlist)** — the inverse, for a forwarder who *only* quotes certain
  regions → show *only* matching lanes. **Pick one mode per forwarder** so the rule set
  stays legible; don't mix exclude + include for the same company.
- **`dimension`** keeps it general: today it's `origin_country`, but the same table later
  handles "exclude a specific port" or "only US-East-Coast destinations."

Example seed (Topocean excludes India):
```sql
insert into forwarder_coverage (forwarder_id, mode, dimension, match_value)
values (
  (select id from forwarders where name = 'Topocean Consolidation Service (Los Angeles)'),
  'exclude', 'origin_country', 'India'
);
```

---

## 4. How the mask composes into View 1

Coverage is one more predicate stacked onto the existing "Lanes to fill" logic:

```
lane shows for forwarder F  ⇔
      active (TTL not expired)                         -- already built
  AND F has not acted on it this period (anti-join)    -- already built
  AND NOT ( an 'exclude' rule of F matches the lane )  -- NEW (coverage)
  [ AND ( some 'include' rule of F matches ) ]         -- NEW, only if F is allowlist-mode
```

`lane_origin_matches(lane, rule)` is the piece that compares a lane's origin against a
rule's `match_value` for the rule's `dimension`. **This is where §5 bites** — what
"origin country = India" *means* depends on how the lane stores its origin.

---

## 5. The hard dependency: location normalization

To say "India," the system must know a lane's **country** — and today it does **not**.
A lane stores `pol` as free text (`"Nhava Sheva, India"`). So coverage matching rides on
the **same canonical normalization** deferred in `PROVIDER_VIEW_MODEL.md` §7a.

| Path | `lane_origin_matches` | Quality |
|---|---|---|
| **Mock / free-text** | `lane.pol ILIKE '%' || rule.match_value || '%'` | Fragile: `"Nhava Sheva"` without "India" slips through; `"Indiana"` false-matches. OK to *prototype*, not to trust. |
| **Real / structured** | lane carries `pol_id` → `locations(country)`; match `locations.country = rule.match_value` (e.g. `'IN'`) | Exact, immune to spelling. The target. |

> **Sequencing insight:** coverage filtering should come **after** location normalization
> (the `locations` reference table + `pol_id` on lanes). Build coverage on free text and
> you'll rebuild the matching once normalization lands. If you build `locations` first,
> coverage rules get a clean `country`/`region` to match on almost for free.

---

## 6. Knock-on effects to remember

1. **Submit follows visibility, for free.** If a forwarder never sees the lane, they never
   submit on it — so a **soft** query mask is enough; you do **not** need to also block the
   `rates` insert. (Add an RLS/trigger guard only if you want *hard* enforcement.)
2. **"No response" vs "not asked."** The requester roster (`PROVIDER_VIEW_MODEL.md` §6)
   shows a forwarder as "no response yet" when no ack row exists. But a coverage-masked
   forwarder **never saw** the lane — calling that "no response" is misleading. Add a third
   roster state: **"out of coverage."** (PVM §6 already flags this thread as deferred.)
3. **Coverage vs the 7-day auto-skip are different filters.** Coverage = *never shown*
   (no rate ever expected for that origin). Auto-skip = *shown-but-cleared* because the
   forwarder already holds a valid rate. They compose in View 1 in that order — coverage
   hides first, then auto-skip clears what's left. Keep them as separate, stackable
   predicates, not one tangled rule.

---

## 7. Implementation sequence (when real forwarders onboard)

1. **(Prereq, ideally)** Build canonical locations (`locations` table, `pol_id` on lanes)
   so matching is on `country`/`region`, per §5. *Or* accept free-text `ILIKE` as interim.
2. Create the `forwarder_coverage` table + its `own coverage` RLS policy (§3).
3. Add `lane_origin_matches(...)` and the `lanes_to_fill` view (Option B, §2/§4).
4. Point `fetchActiveLanes()` at `lanes_to_fill` instead of `rate_request_lanes`.
5. Seed rules per forwarder as data (e.g. Topocean → exclude India). Adding/removing a
   rule is an INSERT/DELETE — **no code change**, consistent with data-only onboarding.
6. Add the **"out of coverage"** state to the requester roster (§6.2).

---

## 8. Summary

- Coverage is a **per-forwarder relevance mask on View 1**, applied in a **query**, not RLS.
- Rules are **DB data** in a `forwarder_coverage` table (`mode` + `dimension` +
  `match_value`); **default with no rows = see everything.**
- Apply the mask **server-side in a `lanes_to_fill` view/RPC** (recommended) or client-side
  in `fetchActiveLanes()`. Either way the frontend just *reads* the rules — it doesn't own them.
- It is **gated on location normalization** (PVM §7a): do it cleanly on structured
  `country`/`region`, or a throwaway free-text `ILIKE` for the rehearsal.
- It introduces the requester's **"out of coverage"** roster state, distinct from "no response."
- Adding a forwarder's rule is **data-only** — an INSERT, no redeploy.
