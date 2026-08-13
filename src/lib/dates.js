/*
  Dates that survive the trip to the database and back.

  Two bugs lived here, both from the same root: JavaScript treats a DATE and a TIMESTAMP as the
  same type, and Postgres does not.

  ── The one people saw ────────────────────────────────────────────────────────
  `new Date('2026-08-08')` is parsed as **UTC midnight** — the spec says a date-only ISO string is
  UTC, while a date-TIME string without a zone is local. Rendering that with
  `toLocaleDateString()` then converts to local time, so anywhere west of UTC it shows the
  PREVIOUS day. In UTC-5 a rate valid until the 8th displayed as the 7th.

  Nothing about that was a decision. Validity here is INCLUSIVE — a rate valid until the 8th can
  still be used on the 8th, and the expiry rule (`valid_until < today`) has always agreed. Only the
  rendering disagreed.

  ── The one nobody saw yet ────────────────────────────────────────────────────
  The mirror image, on the way in. A date picker yields local midnight; `toISOString().slice(0,10)`
  converts to UTC. West of UTC that is harmless — local midnight is still the same UTC day. EAST of
  UTC it is not: in India (UTC+5:30) local midnight on the 8th is 18:30 on the **7th** in UTC, so
  picking the 8th stored the 7th.

  That never showed up locally because this office is UTC-5. It would have shown up for the
  forwarders in India, Vietnam and Thailand — the ones submitting most of the rates.

  The fix in both directions is to stop routing calendar dates through UTC at all.
*/

/** True for a bare calendar date, 'YYYY-MM-DD', with no time and no zone. */
const isDateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())

/**
 * Parse a DB value into a Date positioned correctly in LOCAL time.
 *
 * A date-only string is built from its parts so it lands on local midnight of the day it names.
 * Anything else (a timestamptz, an epoch, an existing Date) is a real instant and is left alone —
 * those genuinely have a timezone and converting them would be the bug in reverse.
 */
export function parseDbDate(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (isDateOnly(v)) {
    const [y, m, d] = v.trim().split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Parse a date typed or pasted by a human — a CSV cell, a spreadsheet column.
 *
 * `new Date(string)` is the wrong tool here and was the reason Valid Until arrived blank. It is
 * locale-guessy and fails in two different ways on the same column:
 *
 *   '15/08/2026'  Invalid Date  → stored NULL, the cell just goes blank
 *   '08/09/2026'  Aug 9         → SILENTLY wrong when the author meant 8 September
 *
 * The forwarders filling these sheets are in India, Vietnam, Thailand and Colombia — all
 * day-first locales — so both cases are routine rather than exotic.
 *
 * The rules here are explicit and ordered:
 *   1. ISO `YYYY-MM-DD` — unambiguous, built from parts so it stays local (never UTC).
 *   2. Slash/dash/dot dates — month-first, matching the template's own `m/d/yy` format and every
 *      date this app emits.
 *   3. If the FIRST number is > 12 it cannot be a month, so read it day-first. That is the one
 *      unambiguous rescue available, and it turns a silent blank into the right date.
 *
 * Genuinely ambiguous values (`08/09/2026`) resolve month-first by convention. Anything else —
 * 'n/a', 'TBD', a note someone typed in the date column — returns null, which callers should
 * REPORT rather than swallow.
 *
 * @returns {Date|null} local-midnight Date, or null if it is not a date at all.
 */
export function parseInputDate(raw) {
  if (raw === null || raw === undefined) return null
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw
  const s = String(raw).trim()
  if (!s) return null

  const mk = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    const dt = new Date(y, m - 1, d)
    // Rejects impossible days that would otherwise roll over — 31 Feb becoming 3 March.
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null
  }

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return mk(+m[1], +m[2], +m[3])

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) {
    const a = +m[1], b = +m[2]
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    if (a > 12 && b <= 12) return mk(year, b, a)   // first number cannot be a month → day-first
    return mk(year, a, b)                          // month-first, the template's own format
  }

  // Named months ('8-Aug-2026', 'Aug 8, 2026') are unambiguous, so Date can have those.
  if (/[A-Za-z]{3}/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }
  return null
}

/**
 * Whole days from today until `v`. Negative when it has passed, 0 when it is today.
 *
 * Compared as CALENDAR DAYS, not as elapsed time: a rate valid until tomorrow has one day left
 * whether it is now 9am or 11pm, because what expires is a date and not a moment. Subtracting the
 * two dates through Date.UTC does that and sidesteps DST — a naive millisecond difference across a
 * clock change is 23 or 25 hours and rounds to the wrong day roughly twice a year.
 *
 * @returns {number|null} null when there is no date to measure.
 */
export function daysUntil(v, from = new Date()) {
  const target = parseDbDate(v)
  if (!target) return null
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
  const b = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  return Math.round((a - b) / 86400000)
}

/** DB value → local date string for display. Handles DATE and TIMESTAMP correctly. */
export function fmtDate(v, opts) {
  const d = parseDbDate(v)
  return d ? d.toLocaleDateString(undefined, opts) : '—'
}

/**
 * Date picker value → 'YYYY-MM-DD' for a Postgres `date` column.
 *
 * Uses the LOCAL calendar parts. `toISOString()` here is what shifted the day for anyone east of
 * UTC: the user picked a day off a calendar, and a calendar day has no timezone — converting it to
 * an instant and back is what invents one.
 */
export function toDateString(v) {
  if (v === null || v === undefined || v === '') return null
  if (isDateOnly(v)) return v.trim()          // already a calendar date; do not round-trip it
  const d = v instanceof Date ? v : new Date(v)
  if (isNaN(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
