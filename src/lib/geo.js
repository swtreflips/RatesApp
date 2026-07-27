// Thin HTTP client for the geo/routing "brain" (geoapi-next) — see BRAIN.md §6.
// This is the ONLY place rates-app knows the brain exists. It holds no secrets,
// just the brain's public URL; HERE/Nominatim/cache live server-side in the brain.

import { supabase } from './supabase'

const BASE = import.meta.env.VITE_GEO_API_URL

if (!BASE) {
  console.warn('[geo] Missing VITE_GEO_API_URL — geo features disabled.')
}

// The brain authenticates every /api/* route except /healthz, so only signed-in users
// spend the HERE and Nominatim quota.
//
// Read the session PER REQUEST, never once at module load: access tokens last an hour,
// and a single Apply Rates job runs chunked calls for minutes. A captured token can
// expire mid-job and 401 every remaining chunk. getSession() refreshes when near expiry.
async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw statusError('geo_not_authenticated', 401)
  return { Authorization: `Bearer ${session.access_token}` }
}

// Carries the HTTP status so postChunked can tell a retryable hiccup from a verdict.
function statusError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

async function failure(path, res) {
  let detail
  try {
    detail = (await res.json()).detail
  } catch {
    // non-JSON error body; status alone will have to do
  }
  return statusError(
    `geo ${path} failed: ${res.status}${detail ? ` (${detail})` : ''}`,
    res.status,
  )
}

async function get(path, params) {
  if (!BASE) throw new Error('geo_api_not_configured')
  const url = new URL(path, BASE)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url, { headers: await authHeaders() })
  if (!res.ok) throw await failure(path, res)
  return res.json()
}

async function post(path, body) {
  if (!BASE) throw new Error('geo_api_not_configured')
  const res = await fetch(new URL(path, BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await failure(path, res)
  return res.json()
}

// Chunk sizes are sized so a worst-case ALL-NOVEL chunk (every location/route a cache
// miss, upstreams serialized inside the brain) still finishes within the brain's
// 60s maxDuration. Chunks go SEQUENTIALLY on purpose: concurrent invocations each
// carry their own Nominatim rate limiter, which would multiply the polite 1 req/s.
const WITHIN_BATCH_CHUNK = 30
const ROUTE_BATCH_CHUNK = 15

async function postChunked(path, pairs, chunkSize) {
  const results = []
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const chunk = pairs.slice(i, i + chunkSize)
    let data
    try {
      data = await post(path, { pairs: chunk })
    } catch (e) {
      // One retry: a timed-out cold chunk has already written its cache entries,
      // so the retry runs warm. But a 4xx is a verdict, not a hiccup — an expired
      // token or a malformed body will fail identically the second time, so retrying
      // only doubles the failures (and, on 401, the noise).
      if (e.status >= 400 && e.status < 500) throw e
      data = await post(path, { pairs: chunk })
    }
    results.push(...data.results)
  }
  return results
}

// Truck (drayage) route between two US locations. Cache-first in the brain — a known
// lane never re-spends HERE quota. Returns { origin, destination, distance_m,
// duration_s, base_duration_s, typical_duration_s, polyline, transport_mode,
// provider, cached, origin_result, destination_result }.
export function getRoute(a, b) {
  return get('/api/route', { a, b })
}

// Batch straight-line proximity checks. pairs: [{ a, b, miles }] → results
// index-aligned with pairs: { a, b, miles, ok, within, a_found, b_found, cached }
// or { ok:false, error }. Per-pair failures; chunking handled here.
export function withinBatch(pairs) {
  return postChunked('/api/within-batch', pairs, WITHIN_BATCH_CHUNK)
}

// Batch drayage route summaries (no polyline). pairs: [{ a, b }] → results
// index-aligned: { a, b, ok, distance_m, duration_s, cached } or { ok:false, detail }.
export function routeBatch(pairs) {
  return postChunked('/api/route-batch', pairs, ROUTE_BATCH_CHUNK)
}

// Geocode a US location (cache → Nominatim). Returns { query, latitude, longitude,
// display_name, provider, cached }.
export function geocode(q) {
  return get('/api/geocode', { q })
}

// Are two locations within `miles` of each other (straight-line, PostGIS)?
// Returns { a, b, miles, within, a_result, b_result }.
export function withinMiles(a, b, miles = 100) {
  return get('/api/within', { a, b, miles })
}
