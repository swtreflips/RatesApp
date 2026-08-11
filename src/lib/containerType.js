/*
  One canonical form for container size, so the same box always compares equal.

  THE PROBLEM this solves: box size is written three different ways across the system and none of
  them is wrong.

    OFR universe file   20'         40'          40' HC
    stored on rates     20' GP      40' GP       40' HC
    typed by hand       20         40HC         40 HC

  "GP" is implied rather than written in day-to-day use — 20' IS 20' GP — so a literal string
  comparison would decide that a 20' OFQ and a 20' GP rate are different boxes and quietly refuse
  to match them. Everything here exists to stop that.

  Matching compares CANONICAL CODES ('20GP', '40HC'), never labels. That means neither the upload
  files nor the stored data have to change spelling, and a new spelling only ever needs a rule
  here.

  Box size is part of an ocean rate's identity (BIDDING.md §6): a smaller box occupies less slot
  space and is priced differently, so a 40' HC rate is not a quote for a 20' move. Matching them
  loosely does not produce an approximate answer, it produces a wrong one.
*/

/** The canonical codes. Order is display order. */
export const CONTAINER_CODES = ['20GP', '40GP', '40HC', '45HC']

/** The standard box when nothing is stated at all. */
export const DEFAULT_CONTAINER_CODE = '40HC'

/** Human labels, in the shorthand actually used: GP implied, HC explicit. */
export const CONTAINER_LABELS = {
  '20GP': "20'",
  '40GP': "40'",
  '40HC': "40' HC",
  '45HC': "45' HC",
}

/**
 * Any spelling → a canonical code.
 *
 * Two rules, applied in order:
 *   1. BLANK means the standard box. Not "unknown" — the app has always resolved an empty
 *      container column to 40' HC on write, and ~95% of moves are 40' HC.
 *   2. Otherwise the SIZE comes from the leading number and the TYPE from whether the text says
 *      high-cube. A stated size is read literally: someone who wrote 40' meant a standard 40',
 *      or they would have written HC. Only silence is interpreted.
 *
 * Unrecognised text returns null rather than guessing, so a junk cell fails visibly instead of
 * silently becoming a 40' HC and matching the wrong rates.
 */
export function canonicalContainer(value) {
  const s = String(value ?? '').trim()
  if (s === '') return DEFAULT_CONTAINER_CODE

  const lower = s.toLowerCase()
  const size = lower.match(/\b(20|40|45)\b|^(20|40|45)/)
  if (!size) return null
  const feet = size[1] ?? size[2]

  // "hc" bounded by non-letters rather than \b: there is no word boundary between the digit and
  // the h in "40hc", so \bhc\b silently read the most common shorthand as a general-purpose box.
  // Bounding on letters still keeps it from firing inside an ordinary word.
  // 45' is only made as a high cube, so the marker is optional there.
  const isHC = /(?:^|[^a-z])hc(?:[^a-z]|$)/.test(lower) || /high\s*cube/.test(lower) || feet === '45'
  const code = `${feet}${isHC ? 'HC' : 'GP'}`
  return CONTAINER_CODES.includes(code) ? code : null
}

/** Canonical code → the label shown to people. Falls back to the raw value if unrecognised. */
export const containerLabel = (value) => {
  const code = canonicalContainer(value)
  return code ? CONTAINER_LABELS[code] : String(value ?? '').trim() || '—'
}

/** Do these two spellings mean the same box? Unrecognised never equals anything, including itself. */
export function sameContainer(a, b) {
  const ca = canonicalContainer(a)
  const cb = canonicalContainer(b)
  return ca !== null && ca === cb
}
