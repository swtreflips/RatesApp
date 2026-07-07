// Thin HTTP client for the geo/routing "brain" (geoapi-next) — see BRAIN.md §6.
// This is the ONLY place rates-app knows the brain exists. It holds no secrets,
// just the brain's public URL; HERE/Nominatim/cache live server-side in the brain.

const BASE = import.meta.env.VITE_GEO_API_URL

if (!BASE) {
  console.warn('[geo] Missing VITE_GEO_API_URL — geo features disabled.')
}

async function get(path, params) {
  if (!BASE) throw new Error('geo_api_not_configured')
  const url = new URL(path, BASE)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url)
  if (!res.ok) {
    let detail
    try {
      detail = (await res.json()).detail
    } catch {
      // non-JSON error body; status alone will have to do
    }
    throw new Error(`geo ${path} failed: ${res.status}${detail ? ` (${detail})` : ''}`)
  }
  return res.json()
}

// Truck (drayage) route between two US locations. Cache-first in the brain — a known
// lane never re-spends HERE quota. Returns { origin, destination, distance_m,
// duration_s, base_duration_s, typical_duration_s, polyline, transport_mode,
// provider, cached, origin_result, destination_result }.
export function getRoute(a, b) {
  return get('/api/route', { a, b })
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
