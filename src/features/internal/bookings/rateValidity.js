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
export function applyValidity(ofqs, asOf = startOfToday()) {
  let expiredTotal = 0
  const out = (ofqs ?? []).map((ofq) => {
    const live = []
    let expiredCount = 0
    for (const o of ofq.oceanOptions ?? []) {
      if (isExpired(o.validUntil, asOf)) expiredCount += 1
      else live.push(o)
    }
    expiredTotal += expiredCount
    return { ...ofq, oceanOptions: live, expiredCount }
  })
  return { ofqs: out, expiredTotal }
}
