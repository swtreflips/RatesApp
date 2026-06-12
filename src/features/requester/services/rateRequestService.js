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
 * Fetches rates submitted by forwarders against the requester team's lanes.
 * RLS scopes this to lane-linked rates the requester team is allowed to see, so no
 * explicit owner filter is needed here. Minimal S0.6 read: flat list, newest first.
 *
 * @returns {{ rates, error }}
 */
export async function fetchReceivedRates() {
  const { data, error } = await supabase
    .from('rates')
    .select(
      'id, pol, pod, last_cy, fd, carrier, rate_amount, free_days, currency, valid_until, notes, created_at, forwarder:forwarders(name)'
    )
    .not('lane_id', 'is', null)
    .order('created_at', { ascending: false })

  return { rates: data ?? [], error }
}

/**
 * Fetches the requester team's OPEN requests — active lanes still within the 10-day
 * window — with a count of rates received on each. RLS scopes lanes to the requester
 * team (current_role_is('requester')), so no owner filter is needed.
 *
 * `rates(count)` is an embedded aggregate (PostgREST), returned as `[{ count }]`.
 *
 * @returns {{ lanes, error }}
 */
export async function fetchOpenRequests() {
  const { data, error } = await supabase
    .from('rate_request_lanes')
    .select('id, pol, fd, container_type, container_count, period, posted_at, expires_at, rates(count)')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })

  return { lanes: data ?? [], error }
}
