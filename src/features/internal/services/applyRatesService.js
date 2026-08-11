import { supabase } from '../../../lib/supabase'

/*
  Apply Rates — read the full active rate pool (internal role reads all rows via RLS).
  "Active" mirrors the forwarder-side definition (submissionService.fetchActiveRates):
  valid_until >= today OR no valid_until. Newest first so dedupe keeps the latest rate
  per uniqueness key.
*/
export async function fetchActiveRates() {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('rates')
    .select('id, pol, pod, last_cy, fd, carrier, container_type, contract, contractname, rate_amount, free_days, currency, valid_until, created_at, forwarder:forwarders(name)')
    .or(`valid_until.gte.${today},valid_until.is.null`)
    .order('created_at', { ascending: false })
  return { rates: data ?? [], error }
}
