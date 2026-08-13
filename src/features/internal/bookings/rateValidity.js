/*
  Which ocean rates are still bookable today.

  Bookings is a DECISION screen: every rate on it is something someone could pick up the phone
  and book. A rate whose `Valid Until` has passed is not that — it is a number the forwarder is
  no longer standing behind, and leaving it in the list means the cheapest row on screen can be
  the one row nobody can actually buy.

  ── Why this is evaluated on render, not at upload ──────────────────────────────────────────
  Snapshots PERSIST. A snapshot published on Monday is still the shared view on Friday, so if
  expiry were baked in at parse time the screen would keep showing whatever was live the day
  somebody happened to upload. Validity has to be asked fresh, against today, every time the
  page is drawn. The stored payload therefore stays complete — every rate the file contained —
  and this module decides what of it is live right now.

  That also means nothing is lost: change the rule, or look at the same snapshot tomorrow, and
  the answer moves on its own.
*/

/** 'M/D/YYYY' or 'YYYY-MM-DD' → sortable ms; blank/unparseable → Infinity (sorts LAST).
    Explicit formats only — string `Date.parse` on non-ISO dates is engine-defined. */
export const dateVal = (s) => {
  const str = String(s ?? '').trim()
  if (!str) return Infinity
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3]
    return new Date(Number(year), Number(m[1]) - 1, Number(m[2])).getTime()
  }
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Infinity
}

/** Local midnight today — the cutoff, so a rate is live for the WHOLE of its last valid day. */
export const startOfToday = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

/**
 * Is this rate past its validity?
 *
 * Expired means STRICTLY BEFORE today: "valid until 14 Aug" is bookable all through the 14th
 * and gone on the 15th. Comparing day-to-day rather than instant-to-instant is what makes that
 * true — an upload at 09:00 must not expire a rate that lasts until the end of the day.
 *
 * A BLANK `Valid Until` is NOT expired. Five of the rows in the current seed have no date, and
 * an empty field is a missing statement of expiry, not a statement that the rate is dead —
 * dropping a quoted rate because someone left a cell blank removes a real option on the
 * strength of an absence. `dateVal` returns Infinity for those, so they never trip the test.
 */
export const isExpired = (validUntil, asOf = startOfToday()) => dateVal(validUntil) < asOf

/**
 * Strip expired rates from a snapshot's OFQs, remembering how many went.
 *
 * OFQs are KEPT even when every one of their rates has expired. A quote with nothing bookable
 * against it is not noise to be tidied away — it is the row that most needs attention, because
 * it is real demand with no live price. Hiding it would make the problem invisible exactly
 * when someone should be going out for fresh rates. It reads "no valid rates" instead of a
 * count, which distinguishes it from an OFQ that never had any applied.
 *
 * @returns {{ ofqs: Array, expiredTotal: number }} same shape, plus `expiredCount` per OFQ.
 */
/**
 * Days of validity left. null for a rate with no stated expiry — infinite runway, not zero.
 *
 * Calendar days via `Date.UTC`, not elapsed milliseconds: a rate expiring tomorrow has one day
 * left whether it is 9am or 11pm, and a raw ms difference across a DST change is 23 or 25 hours
 * and rounds to the wrong day twice a year.
 */
export function runwayDays(validUntil, asOf = startOfToday()) {
  const ms = dateVal(validUntil)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const a = new Date(asOf)
  return Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
     Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000,
  )
}

/**
 * Strip rates that cannot carry this booking, and say what was stripped and why.
 *
 * TWO SEPARATE REASONS, COUNTED SEPARATELY, because they call for different actions:
 *
 *   expired        past its Valid Until. Gone. Nothing to do but ask for a fresh one.
 *   below runway   still live, but with less time left than the threshold. You COULD use it if
 *                  you were desperate; you have chosen not to look at it.
 *
 * Collapsing them into one "hidden" number would tell someone a lane has nothing when in fact it
 * has something they set a control to hide — which is a decision they can reverse, and only if
 * they know it happened.
 *
 * `minRunwayDays <= 0` disables the runway rule entirely; expiry always applies, because an
 * expired rate is not a preference.
 */
export function applyValidity(ofqs, asOf = startOfToday(), minRunwayDays = 0) {
  let expiredTotal = 0
  let belowRunwayTotal = 0
  const out = (ofqs ?? []).map((ofq) => {
    const live = []
    let expiredCount = 0
    let belowRunwayCount = 0
    for (const o of ofq.oceanOptions ?? []) {
      if (isExpired(o.validUntil, asOf)) {
        expiredCount += 1
        continue
      }
      if (minRunwayDays > 0) {
        const left = runwayDays(o.validUntil, asOf)
        // left === null is an open-ended rate: no stated expiry, so it always survives.
        if (left !== null && left < minRunwayDays) {
          belowRunwayCount += 1
          continue
        }
      }
      live.push(o)
    }
    expiredTotal += expiredCount
    belowRunwayTotal += belowRunwayCount
    return { ...ofq, oceanOptions: live, expiredCount, belowRunwayCount }
  })
  return { ofqs: out, expiredTotal, belowRunwayTotal }
}
