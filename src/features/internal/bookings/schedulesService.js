import { supabase } from '../../../lib/supabase'
import { dateVal, startOfToday } from './rateValidity'

/*
  Sailings for a Bookings ocean rate, and the pick made against it. SAILINGS.md §3–§4.

  The schedules warehouse lives in THIS project (MIGRATION.md Phase 3 moved it here and Phase 5
  repointed the Schedules app at it), so there is no second client and no cross-project problem —
  the ordinary `supabase` client reaches it.

  READ `schedules_latest_secure`, NEVER `schedules_latest`. Postgres refuses RLS policies on a
  materialized view, so grants are the only guard available and grants cannot express "internal
  only". The MV is therefore locked outright and exposed through an owner-rights view whose WHERE
  evaluates the caller's `my_org_type()`. Hitting the MV directly raises `permission denied` — a
  500, not an empty list.
*/

/** The seven fields the panel shows, plus the keys and a breadcrumb to the source row. */
const SAILING_COLUMNS =
  'schedule_hash, carrier_code, port_of_loading, last_cy, port_of_discharge, ' +
  'etd, pod_eta, eta, transit_time_days, transport_type, mother_vessel'

/** Enough to choose from without turning the panel into a schedules browser. */
const MAX_SAILINGS = 25

/** ms → 'YYYY-MM-DD' in LOCAL time. `toISOString` would shift the day across a timezone. */
function toISODate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The earliest ETD worth offering: the cargo ready date, or today when there isn't one.
 *
 * A booking cannot leave before its cargo is ready, so that date is the floor. `dateVal` already
 * parses the seed's 'M/D/YYYY' and ISO forms and returns Infinity for anything it cannot read —
 * falling back to today then, rather than passing Infinity into a query, keeps the list bounded
 * and keeps a malformed date from quietly offering sailings that already left.
 */
export function earliestEtd(cargoReadyDate, now = startOfToday()) {
  const ms = dateVal(cargoReadyDate)
  return toISODate(Number.isFinite(ms) ? Math.max(ms, now) : now)
}

/**
 * Sailings that could carry this booking.
 *
 * Matched on carrier + POL + Last CY, which is the MV's own lane key. Ports are compared with
 * `ilike` and NOT `eq`: the scraped data genuinely holds both "Houston, TX" and "Houston, Tx"
 * (and five more such pairs), so a case-sensitive match returns roughly half the sailings — which
 * reads as a short list rather than as a failure. `ilike` with no wildcards is exact-but-blind-to-
 * case; port names contain no % or _ for it to interpret.
 *
 * Last CY rather than POD is the destination key on purpose: the ocean leg can end at an inland
 * ramp (discharge Los Angeles, rail to Salt Lake City) or at the port itself, and `last_cy` is
 * where the ocean stops and drayage begins either way — the same handover Bookings already keys
 * drayage on. See SAILINGS.md §2d.
 */
export async function findSailings({ carrier, pol, lastCy, cargoReadyDate }) {
  if (!carrier || !pol || !lastCy) return { sailings: [], error: null }

  const { data, error } = await supabase
    .from('schedules_latest_secure')
    .select(SAILING_COLUMNS)
    .eq('carrier_code', carrier)
    .ilike('port_of_loading', pol)
    .ilike('last_cy', lastCy)
    .gt('etd', earliestEtd(cargoReadyDate))
    .order('etd', { ascending: true })
    .limit(MAX_SAILINGS)

  if (error) return { sailings: [], error }
  return { sailings: data ?? [], error: null }
}

/* ── the pick ─────────────────────────────────────────────────────────────── */

const PICK_COLUMNS =
  'id, ofq_id, ofr_id, schedule_hash, carrier_code, port_of_loading, last_cy, ' +
  'port_of_discharge, etd, pod_eta, eta, transit_time_days, transport_type, ' +
  'mother_vessel, picked_by, picked_at'

/**
 * Every pick on the board, keyed `${ofqId}|${ofrId}`.
 *
 * One read for the whole page rather than one per card: the panel only ever shows a handful at a
 * time, but the OFQ list can be long and a request per expansion would make opening quotes feel
 * slower for no benefit.
 */
export async function fetchPicks() {
  const { data, error } = await supabase
    .from('booking_schedule_picks')
    .select(PICK_COLUMNS)
  if (error) return { picks: new Map(), error }
  return { picks: new Map((data ?? []).map((p) => [pickKey(p.ofq_id, p.ofr_id), p])), error: null }
}

export const pickKey = (ofqId, ofrId) => `${ofqId}|${ofrId}`

/**
 * Record (or replace) the sailing chosen for one ocean rate.
 *
 * Upsert on (ofq_id, ofr_id) — re-picking is the normal case and must replace rather than
 * accumulate. The sailing is COPIED in full: `schedules_latest` is rebuilt on every ingest over a
 * 5-day window, so the row picked today is likely gone next week, and a decision that evaporates
 * with the feed is not a decision.
 *
 * `picked_by` comes from the session rather than the caller, matching `saveSnapshot` — the policy
 * requires it to equal `auth.uid()`, so a pick cannot be attributed to someone else even by trying.
 */
export async function savePick({ ofqId, ofrId, sailing }) {
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id ?? null

  const row = {
    ofq_id: ofqId,
    ofr_id: ofrId,
    schedule_hash: sailing.schedule_hash ?? null,
    carrier_code: sailing.carrier_code ?? null,
    port_of_loading: sailing.port_of_loading ?? null,
    last_cy: sailing.last_cy ?? null,
    port_of_discharge: sailing.port_of_discharge ?? null,
    etd: sailing.etd ?? null,
    pod_eta: sailing.pod_eta ?? null,
    eta: sailing.eta ?? null,
    transit_time_days: sailing.transit_time_days ?? null,
    transport_type: sailing.transport_type ?? null,
    mother_vessel: sailing.mother_vessel ?? null,
    picked_by: userId ?? null,
    picked_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('booking_schedule_picks')
    .upsert(row, { onConflict: 'ofq_id,ofr_id' })
    .select(PICK_COLUMNS)
    .single()

  if (error) return { pick: null, error }
  return { pick: data, error: null }
}

/** Drop the pick for one ocean rate. */
export async function clearPick({ ofqId, ofrId }) {
  const { error } = await supabase
    .from('booking_schedule_picks')
    .delete()
    .eq('ofq_id', ofqId)
    .eq('ofr_id', ofrId)
  return { error }
}

/**
 * Has this sailing already left?
 *
 * Derived here and stored nowhere — the same rule as expired ocean rates on this screen
 * (rateValidity.js). A pick made in August is simply expired in September with nothing having
 * run in between, and there is no column to drift out of step with the calendar.
 *
 * Strictly BEFORE today, so a sailing leaving today still counts as catchable.
 */
export const hasSailed = (pick, asOf = startOfToday()) =>
  !!pick?.etd && dateVal(pick.etd) < asOf

/* ── display ──────────────────────────────────────────────────────────────── */

/** '2026-08-18' → '18 Aug'. Blank stays an em dash rather than "Invalid Date". */
export function shortDate(iso) {
  const ms = dateVal(iso)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The scraped ports carry inconsistent casing ("NORFOLK, VA"); title-case them for reading. */
export function tidyPlace(s) {
  const str = String(s ?? '').trim()
  if (!str) return '—'
  return str.replace(/[^\s,\/-]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    // two-letter US state codes read better uppercase: "Los Angeles, Ca" → "Los Angeles, CA"
    .replace(/,\s*([A-Za-z]{2})$/, (_, st) => `, ${st.toUpperCase()}`)
}
