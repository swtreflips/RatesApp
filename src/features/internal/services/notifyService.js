import { supabase } from '../../../lib/supabase'

/*
  Client wrapper for the `notify-forwarders` Edge Function v2 (ALERTS.md §6 + DRAY.md §7).
  The browser sends `kind` + `service` + the CHECKED `analystIds` (+ optional `period`) — the
  function resolves emails server-side and the signed-in user's JWT (attached automatically by
  supabase-js) is what the function role-gates on.

  Service is hard-coded 'ocean' at the call sites until the `:service` routes land (§9b step 2);
  the payload shape is already service-ready.

  Three modes:
   • preview  — the directory: companies offering the service, analysts + tag flags, per-company
                lane counts, and `lastSelected` per analyst (the §7e memory → modal prefill).
   • request  — emails all open lanes to the checked analysts' companies.
   • reminder — emails each company only their outstanding lanes.
*/

/** Pull the function's JSON `error` message out of a non-2xx FunctionsHttpError when possible. */
async function readError(error) {
  try {
    const body = await error.context.json()
    if (body?.error) return body.error
  } catch {
    // context not a JSON Response — fall through to the generic message
  }
  return error.message || 'Request failed'
}

async function invokeNotify(payload) {
  const { data, error } = await supabase.functions.invoke('notify-forwarders', { body: payload })
  if (error) return { data: null, error: new Error(await readError(error)) }
  if (data && data.ok === false) return { data: null, error: new Error(data.error || 'Request failed') }
  return { data, error: null }
}

/** Directory + memory for the modal. `forwarderIds` omitted → all companies offering the service. */
export function previewNotification({ service = 'ocean', forwarderIds, period } = {}) {
  return invokeNotify({ kind: 'preview', service, forwarderIds, period })
}

/** Send. `kind` is 'request' | 'reminder'; `analystIds` = the analysts checked in the modal. */
export function sendNotification(kind, analystIds, { service = 'ocean', period } = {}) {
  return invokeNotify({ kind, service, analystIds, period })
}
