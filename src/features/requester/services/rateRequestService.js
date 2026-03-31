import { supabase } from '../../../lib/supabase'

/*
  Expected Supabase tables:

  ── rate_request_batches ──────────────────────────
  id            uuid  PK  default gen_random_uuid()
  requester_id  uuid  FK → auth.users(id)
  created_at    timestamptz  default now()
  status        text  default 'posted'

  ── rate_request_lanes ────────────────────────────
  id            uuid  PK  default gen_random_uuid()
  batch_id      uuid  FK → rate_request_batches(id)
  pol           text  not null
  fd            text  not null
  created_at    timestamptz  default now()
*/

/**
 * Posts a batch of lanes to Supabase.
 * Creates a batch record, then inserts all lanes linked to that batch.
 *
 * @param {{ pol: string, fd: string }[]} lanes
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
  }))

  const { data: insertedLanes, error: lanesError } = await supabase
    .from('rate_request_lanes')
    .insert(laneRows)
    .select()

  if (lanesError) return { batch, lanes: null, error: lanesError }

  return { batch, lanes: insertedLanes, error: null }
}
