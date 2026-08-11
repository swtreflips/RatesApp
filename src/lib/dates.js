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
