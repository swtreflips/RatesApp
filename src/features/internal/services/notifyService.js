import { supabase } from '../../../lib/supabase'

/*
  Client wrapper for the `notify-forwarders` Edge Function (ALERTS.md §6). The browser sends only
  `kind` + `forwarderIds` (+ optional `period`) — the function resolves emails and computes
  lanes-per-forwarder server-side, and the signed-in user's JWT (attached automatically by
  supabase-js) is what the function role-gates on.

  Three modes:
   • preview  — returns the per-forwarder roster (counts + last-notified); sends nothing.
   • request  — emails all open lanes to the selected forwarders.
   • reminder — emails each forwarder only their outstanding lanes.
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

/** Roster for the modal. `forwarderIds` omitted → all active forwarders. */
export function previewNotification(forwarderIds, period) {
  return invokeNotify({ kind: 'preview', forwarderIds, period })
}

/** Send. `kind` is 'request' | 'reminder'; `forwarderIds` is the chosen recipient set. */
export function sendNotification(kind, forwarderIds, period) {
  return invokeNotify({ kind, forwarderIds, period })
}
