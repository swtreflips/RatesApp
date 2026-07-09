import { supabase } from '../../../lib/supabase'

/*
  Expected Supabase tables:

  ── rate_request_batches ──────────────────────────
  id            uuid  PK  default gen_random_uuid()
  requester_id  uuid  FK → auth.users(id)
  created_at    timestamptz  default now()
  status        text  default 'posted'

  ── rate_request_lanes ────────────────────────────
  id               uuid  PK  default gen_random_uuid()
  batch_id         uuid  FK → rate_request_batches(id)
  pol              text  not null
  pod              text                -- optional: requester-specified discharge port
  last_cy          text                -- optional: requester-specified last container yard
  fd               text  not null
  container_type   text
  container_count  integer
  created_at       timestamptz  default now()
*/

/**
 * Posts a batch of lanes to Supabase.
 * Creates a batch record, then inserts all lanes linked to that batch.
 *
 * @param {{ pol: string, fd: string, containerType?: string, containerCount?: number }[]} lanes
 * @param {string} requesterId — auth user id
 * @returns {{ batch, lanes, error }}
 */
export async function postRateRequestBatch(lanes, requesterId) {
  // 1. Create the batch
  const { data: batch, error: batchError } = await supabase
    .from('rate_request_batches')
    .insert({ requester_id: requesterId })
    .select()
    .single()

  if (batchError) return { batch: null, lanes: null, error: batchError }

  // 2. Insert lanes linked to the batch
  const laneRows = lanes.map(l => ({
    batch_id: batch.id,
    pol: l.pol,
    pod: l.pod || null,
    last_cy: l.lastCy || null,
    fd: l.fd,
    container_type: l.containerType || null,
    container_count: l.containerCount || null,
  }))

  const { data: insertedLanes, error: lanesError } = await supabase
    .from('rate_request_lanes')
    .insert(laneRows)
    .select()

  if (lanesError) return { batch, lanes: null, error: lanesError }

  return { batch, lanes: insertedLanes, error: null }
}

/**
 * Fetches all rates the internal team can see — **lane-linked AND independent** (lane_id NULL).
 * RLS (`requester reads rates` = current_role_is('internal')) scopes it to internal users, so no
 * explicit filter is needed. `lane_id` is selected to drive the Request/Standalone badge.
 * Flat list, newest first.
 *
 * @returns {{ rates, error }}
 */
export async function fetchReceivedRates() {
  // "Active Rates" = still valid (or open-ended). Same rule as the forwarder Active
  // Rates and Apply Rates views — expired rates stay in the DB but drop off this list.
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('rates')
    .select(
      'id, lane_id, pol, pod, last_cy, fd, carrier, rate_amount, free_days, currency, valid_until, notes, created_at, forwarder:forwarders(name)'
    )
    .or(`valid_until.gte.${today},valid_until.is.null`)
    .order('created_at', { ascending: false })

  return { rates: data ?? [], error }
}

/**
 * Fetches the internal team's OPEN requests — active lanes still within the 10-day
 * window — with a count of rates received on each. RLS scopes lanes to the internal
 * team (current_role_is('internal')), so no owner filter is needed.
 *
 * `rates(count)` is an embedded aggregate (PostgREST), returned as `[{ count }]`.
 *
 * @returns {{ lanes, error }}
 */
export async function fetchOpenRequests() {
  const { data, error } = await supabase
    .from('rate_request_lanes')
    .select('id, pol, pod, last_cy, fd, container_type, container_count, period, posted_at, expires_at, rates(count)')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })

  return { lanes: data ?? [], error }
}
