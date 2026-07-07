/*
  Apply Rates — job-wide geo call manager over src/lib/geo.js.

  Two jobs:
  1. Memoize identical (kind, a, b) pairs across the WHOLE run — many OFQs share the same
     (last CY, final destination) pair, so total geo calls ≈ unique pairs, never rows × CYs.
     Memoizing the PROMISE (not the result) also collapses concurrent duplicate requests.
  2. Funnel everything through a small concurrency pool so the brain (and its upstream
     Nominatim/HERE rate limits) never sees a request stampede.

  Calls never reject: they resolve { ok:true, ...data } or { ok:false, error } so one bad
  pair can't blow up a Promise.all in the matcher.
*/

import { getRoute, withinMiles } from '../../../lib/geo'
import { norm } from './matcher'
import { GEO_CONCURRENCY } from './config'

export function createGeoBatch({ concurrency = GEO_CONCURRENCY } = {}) {
  const memo = new Map()
  const stats = { calls: 0, memoHits: 0, errors: 0 }

  let active = 0
  const queue = []
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return
    active += 1
    const { fn, resolve } = queue.shift()
    fn()
      .then((data) => resolve({ ok: true, ...data }))
      .catch((e) => {
        stats.errors += 1
        resolve({ ok: false, error: e.message })
      })
      .finally(() => {
        active -= 1
        runNext()
      })
  }
  const schedule = (fn) => new Promise((resolve) => {
    queue.push({ fn, resolve })
    runNext()
  })

  const call = (kind, a, b, fn) => {
    const key = `${kind}|${norm(a)}|${norm(b)}`
    if (memo.has(key)) {
      stats.memoHits += 1
      return memo.get(key)
    }
    stats.calls += 1
    const promise = schedule(fn)
    memo.set(key, promise)
    return promise
  }

  return {
    // miles is part of the memo key — per-CY threshold overrides give distinct answers
    within: (a, b, miles) => call(`within:${miles}`, a, b, () => withinMiles(a, b, miles)),
    route: (a, b) => call('route', a, b, () => getRoute(a, b)),
    stats,
  }
}
