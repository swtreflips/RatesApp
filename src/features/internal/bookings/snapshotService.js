import { supabase } from '../../../lib/supabase'

/*
  Booking snapshots — the shared OFR seed.

  WHAT IS STORED is only the sheet: the OFQ universe and the ocean rates applied to it, exactly
  as `groupByOfqWithOptions` parsed them. Not the drayage options, not which one someone picked,
  not any total.

  Drayage stays live from `drayage_rates` on every page load. Freezing it into a snapshot would
  have a two-week-old sheet quoting two-week-old trucking — and being current is the entire
  purpose of that table. So a snapshot ages in one dimension only: which OFQs and ocean rates
  existed when it was taken.

  A snapshot is IMMUTABLE. There is no update path here because there is no update policy in the
  database. Correcting a bad upload means uploading the right file; the wrong one stays in
  history where it can be seen for what it was.
*/

/** Past this, the page says the sheet may be out of date. Weekly rhythm, so a working week. */
export const STALE_AFTER_DAYS = 7

const DAY_MS = 86_400_000

/** Whole days since `uploadedAt`; null when there is nothing to measure. */
export function ageInDays(uploadedAt) {
  if (!uploadedAt) return null
  return Math.floor((Date.now() - new Date(uploadedAt).getTime()) / DAY_MS)
}

export const isStale = (uploadedAt) => {
  const days = ageInDays(uploadedAt)
  return days != null && days >= STALE_AFTER_DAYS
}

/** "today" · "yesterday" · "6 days ago". Deliberately coarse — nobody plans against minutes. */
export function relativeDay(uploadedAt) {
  const days = ageInDays(uploadedAt)
  if (days == null) return ''
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/*
  The columns the list needs, WITHOUT the payload. A history of twenty snapshots would otherwise
  drag twenty full universes across the wire to render twenty lines of text.
*/
const META = 'id, uploaded_at, file_name, ofq_count, ofr_count, uploaded_by, profiles:uploaded_by(full_name)'

const uploaderName = (row) => row?.profiles?.full_name ?? null

function toMeta(row) {
  return {
    id: row.id,
    uploadedAt: row.uploaded_at,
    fileName: row.file_name,
    ofqCount: row.ofq_count ?? 0,
    ofrCount: row.ofr_count ?? 0,
    uploadedBy: uploaderName(row),
  }
}

/**
 * The snapshot everyone sees. Returns `{ snapshot: null }` when none has been uploaded yet —
 * an empty table is a normal first-run state, not an error.
 */
export async function fetchLatestSnapshot() {
  const { data, error } = await supabase
    .from('booking_snapshots')
    .select(`${META}, payload`)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { snapshot: null, error }
  if (!data) return { snapshot: null, error: null }
  return { snapshot: { ...toMeta(data), ofqs: data.payload ?? [] }, error: null }
}

/** Recent uploads, newest first, metadata only. */
export async function fetchSnapshotHistory(limit = 8) {
  const { data, error } = await supabase
    .from('booking_snapshots')
    .select(META)
    .order('uploaded_at', { ascending: false })
    .limit(limit)

  if (error) return { history: [], error }
  return { history: (data ?? []).map(toMeta), error: null }
}

/**
 * Post a parsed sheet as the new latest snapshot.
 *
 * `uploaded_by` is set from the session rather than passed in — the insert policy requires it to
 * equal auth.uid(), so a caller cannot attribute an upload to someone else even by trying.
 */
export async function saveSnapshot({ ofqs, fileName }) {
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) return { snapshot: null, error: new Error('Not signed in') }

  const ofrCount = ofqs.reduce((n, o) => n + (o.oceanOptions?.length ?? 0), 0)

  const { data, error } = await supabase
    .from('booking_snapshots')
    .insert({
      uploaded_by: userId,
      file_name: fileName,
      ofq_count: ofqs.length,
      ofr_count: ofrCount,
      payload: ofqs,
    })
    .select(`${META}, payload`)
    .single()

  if (error) return { snapshot: null, error }
  return { snapshot: { ...toMeta(data), ofqs: data.payload ?? [] }, error: null }
}

export async function deleteSnapshot(id) {
  const { error } = await supabase.from('booking_snapshots').delete().eq('id', id)
  return { error }
}

/**
 * What a pending file would change about the shared view, against what is on screen now.
 *
 * This is the honest answer to "does this need re-uploading?". Age only says the sheet is old;
 * this says whether anything actually moved — new quotes raised, rates applied since. A file
 * that turns out to be identical is worth knowing about BEFORE it replaces the current one.
 */
export function diffAgainst(current, nextOfqs) {
  const nextOfrCount = nextOfqs.reduce((n, o) => n + (o.oceanOptions?.length ?? 0), 0)
  if (!current) {
    return { isFirst: true, ofqDelta: null, ofrDelta: null, newOfqIds: [], identical: false }
  }

  const currentIds = new Set(current.ofqs.map((o) => o.ofqId))
  const newOfqIds = nextOfqs.map((o) => o.ofqId).filter((id) => !currentIds.has(id))

  return {
    isFirst: false,
    ofqDelta: nextOfqs.length - current.ofqCount,
    ofrDelta: nextOfrCount - current.ofrCount,
    newOfqIds,
    // Same counts and the same OFQs — nothing has been raised or applied since. Not an error,
    // but worth saying so the upload is a decision rather than a reflex.
    identical:
      nextOfqs.length === current.ofqCount &&
      nextOfrCount === current.ofrCount &&
      newOfqIds.length === 0,
  }
}
