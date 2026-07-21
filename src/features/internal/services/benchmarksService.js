import { supabase } from '../../../lib/supabase'

/*
  Drayage rate benchmarks (DRAYAGE_ANALYTICS.md §5). One immutable row per drayage_rates.id —
  computed once, then read as a cache (Layer 1) and, over time, accumulated as history (Layer 2's
  free groundwork). Internal-only by RLS; forwarders have no access.
*/

/** All benchmark rows (internal RLS scopes the read). */
export async function fetchBenchmarks() {
  const { data, error } = await supabase
    .from('drayage_rate_benchmarks')
    .select('rate_id, distance_m, duration_s, cost_per_mile, cost_per_hour, computed_at')
  return { benchmarks: data ?? [], error }
}

/**
 * Write-through the newly computed benchmarks (§5). Upsert + ignoreDuplicates so a concurrent
 * tab (or a rate already benchmarked between fetch and insert) is a no-op, never an error —
 * benchmarks are immutable, so "already there" is success.
 */
export async function insertBenchmarks(rows) {
  if (!rows?.length) return { error: null, count: 0 }
  const { error } = await supabase
    .from('drayage_rate_benchmarks')
    .upsert(rows, { onConflict: 'rate_id', ignoreDuplicates: true })
  return { error, count: error ? 0 : rows.length }
}
