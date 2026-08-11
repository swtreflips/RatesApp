import { supabase } from '../../lib/supabase'

/*
  Correcting a rate after it lands, for both ocean (`rates`) and drayage (`drayage_rates`).

  Who may do it is decided entirely by RLS — internal may edit any rate, a forwarder only their
  own (`forwarder_id = my_forwarder()`). Nothing here checks identity, deliberately: a permission
  enforced in the client is a suggestion, and both roles hit the same functions below.

  Every save does two things: write the change, then record what changed. The audit is field-level
  (one `rate_edits` row per altered column) because the question people actually ask is "what
  happened to this rate's price", not "what did this edit touch".
*/

/** Generated columns. Postgres rejects any write to these, so they must never reach an update. */
const GENERATED = new Set([
  'drayage_lane', 'fuel_surcharge_amount', 'fuel_surcharge_pct_eff', 'total_rate',
])

/* ── field specs ──────────────────────────────────────────────────────────
   What each rate type exposes for editing, in dialog order. `kind` drives both the input type
   and how the value is parsed on the way out.

   ROUTING FIELDS ARE INCLUDED, which is the risky part and is handled rather than avoided:
   drayage_rates carries a partial unique index on (forwarder_id, last_cy_cfs, final_destination)
   WHERE status = 'current', so re-pointing a rate at a lane that already has a current rate is a
   real collision. `saveRateEdit` catches it and says so in words instead of surfacing a raw
   Postgres error. */

export const OCEAN_FIELDS = [
  { name: 'pol',            label: 'Port of Loading',   kind: 'text',   group: 'routing' },
  { name: 'pod',            label: 'Port of Discharge', kind: 'text',   group: 'routing' },
  { name: 'last_cy',        label: 'Last CY',           kind: 'text',   group: 'routing' },
  { name: 'fd',             label: 'Final Destination', kind: 'text',   group: 'routing' },
  { name: 'carrier',        label: 'Carrier',           kind: 'text',   group: 'identity' },
  { name: 'container_type', label: 'Container Type',    kind: 'text',   group: 'identity' },
  { name: 'rate_amount',    label: 'Rate',              kind: 'number', group: 'money' },
  { name: 'currency',       label: 'Currency',          kind: 'text',   group: 'money' },
  { name: 'free_days',      label: 'Free Days',         kind: 'int',    group: 'money' },
  { name: 'transit_days',   label: 'Transit Days',      kind: 'int',    group: 'money' },
  { name: 'valid_from',     label: 'Valid From',        kind: 'date',   group: 'validity' },
  { name: 'valid_until',    label: 'Valid Until',       kind: 'date',   group: 'validity' },
  { name: 'notes',          label: 'Notes',             kind: 'text',   group: 'notes' },
]

export const DRAYAGE_FIELDS = [
  { name: 'last_cy_cfs',          label: 'Last CY/CFS',        kind: 'text',   group: 'routing' },
  { name: 'final_destination',    label: 'Final Destination',  kind: 'text',   group: 'routing' },
  { name: 'dest_zip',             label: 'Zip Code',           kind: 'text',   group: 'routing' },
  { name: 'rate',                 label: 'Rate',               kind: 'number', group: 'money' },
  { name: 'fuel_surcharge_pct',   label: 'Fuel Surcharge %',   kind: 'number', group: 'money' },
  { name: 'fuel_surcharge',       label: 'Fuel Surcharge $',   kind: 'number', group: 'money' },
  { name: 'toll_fee',             label: 'Toll Fee',           kind: 'number', group: 'fees' },
  { name: 'pre_pull_fee',         label: 'Pre-pull Fee',       kind: 'number', group: 'fees' },
  { name: 'pier_pass_fee',        label: 'Pier Pass Fee',      kind: 'number', group: 'fees' },
  { name: 'clean_truck_fee',      label: 'Clean Truck Fee',    kind: 'number', group: 'fees' },
  { name: 'drop_fee',             label: 'Drop Fee',           kind: 'number', group: 'fees' },
  { name: 'chassis_fee',          label: 'Chassis Fee',        kind: 'number', group: 'fees' },
  { name: 'chassis_split_fee',    label: 'Chassis Split Fee',  kind: 'number', group: 'fees' },
  { name: 'port_congestion_fee',  label: 'Port Congestion',    kind: 'number', group: 'fees' },
  { name: 'demurrage_fee',        label: 'Demurrage Fee',      kind: 'number', group: 'fees' },
  { name: 'min_chassis_days',     label: 'Min Chassis Days',   kind: 'int',    group: 'chassis' },
  { name: 'chassis_days_included',label: 'Chassis Days Incl.', kind: 'int',    group: 'chassis' },
  { name: 'storage_fee_per_day',  label: 'Storage Fee /Day',   kind: 'number', group: 'chassis' },
  { name: 'provided_at',          label: 'Date Received',      kind: 'date',   group: 'validity' },
  { name: 'notes',                label: 'Notes',              kind: 'text',   group: 'notes' },
]

export const fieldsFor = (table) => (table === 'drayage_rates' ? DRAYAGE_FIELDS : OCEAN_FIELDS)

/* ── value handling ───────────────────────────────────────────────────────── */

/** DB value → the string an input shows. null/undefined become '' so inputs stay controlled. */
export function toInput(value, kind) {
  if (value === null || value === undefined) return ''
  if (kind === 'date') return String(value).slice(0, 10)   // timestamps → YYYY-MM-DD
  return String(value)
}

/**
 * Input string → the value written to the DB.
 *
 * Blank means NULL, never 0 or ''. A cleared fee is "not quoted", and storing 0 would claim the
 * forwarder quoted free — which the drayage total then happily adds up.
 */
export function fromInput(text, kind) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  if (kind === 'number') { const n = Number(s); return Number.isFinite(n) ? n : null }
  if (kind === 'int')    { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null }
  return s
}

/** Compare as the DB will see them, so "3200" against 3200 is not reported as a change. */
const sameValue = (a, b) => (a === null ? b === null : b !== null && String(a) === String(b))

/**
 * Which fields actually changed. Drives the confirmation summary AND the audit rows, so what the
 * user is shown and what gets recorded cannot drift apart.
 */
export function diffRate(original, draft, fields) {
  const changes = []
  for (const f of fields) {
    if (GENERATED.has(f.name)) continue
    const before = original[f.name] ?? null
    const after = fromInput(draft[f.name], f.kind)
    if (!sameValue(before, after)) changes.push({ field: f.name, label: f.label, before, after })
  }
  return changes
}

/* ── save ─────────────────────────────────────────────────────────────────── */

const ROUTING = new Set([
  'pol', 'pod', 'last_cy', 'fd', 'last_cy_cfs', 'final_destination',
])

export const isRoutingChange = (changes) => changes.some((c) => ROUTING.has(c.field))

/**
 * Apply the changes and record them.
 *
 * The update goes first. If it fails nothing is logged, so the audit can never claim a change that
 * did not land. If the audit insert fails afterwards the edit still stands — losing the log is bad,
 * but rolling back a correction the user watched succeed would be worse, and there is no
 * transaction across two PostgREST calls to make it atomic anyway. The audit failure is surfaced
 * rather than swallowed.
 */
export async function saveRateEdit({ table, rateId, changes }) {
  if (!changes.length) return { error: null, auditError: null }

  const patch = {}
  for (const c of changes) patch[c.field] = c.after

  const { error } = await supabase.from(table).update(patch).eq('id', rateId)

  if (error) {
    // 23505 = unique_violation. On drayage this is the partial index on
    // (forwarder_id, last_cy_cfs, final_destination) WHERE status='current' — the user has pointed
    // this rate at a lane that already has a live rate. Say that, rather than showing the raw text.
    if (error.code === '23505') {
      return {
        error: new Error(
          'That lane already has a current rate for this forwarder. Two live rates cannot share ' +
          'the same routing — edit the existing one, or supersede it instead.',
        ),
        auditError: null,
      }
    }
    return { error, auditError: null }
  }

  const { data: { session } } = await supabase.auth.getSession()
  const { error: auditError } = await supabase.from('rate_edits').insert(
    changes.map((c) => ({
      rate_id: rateId,
      table_name: table,
      field: c.field,
      old_value: c.before === null ? null : String(c.before),
      new_value: c.after === null ? null : String(c.after),
      edited_by: session?.user?.id ?? null,
    })),
  )

  return { error: null, auditError }
}

/** Edit history for one rate, newest first. */
export async function fetchRateEdits(rateId) {
  const { data, error } = await supabase
    .from('rate_edits')
    .select('id, field, old_value, new_value, edited_at, edited_by, profiles:edited_by(full_name)')
    .eq('rate_id', rateId)
    .order('edited_at', { ascending: false })
  return { edits: data ?? [], error }
}
