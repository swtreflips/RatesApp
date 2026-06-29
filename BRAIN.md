# BRAIN.md — Wiring the Geo/Routing "Brain" into rates-app

**Status:** Design + integration spec. **Path A chosen first** (standalone geo service); Path B kept
as a future migration (§8). Created June 29, 2026.
**Relates to:** `geoapi-next` repo (the brain), `SUPA.md` in that repo (PostGIS/cache setup), `DRAY.md`
(drayage service — the eventual consumer of routes).

---

## 0. TL;DR

- `rates-app` is a **Vite React SPA** — it ships static files to a CDN and runs **only in the browser**.
  It has **no server**, so it cannot safely hold secrets or run upstream-API logic itself.
- The **brain** (geocoding via Nominatim, routing via HERE, both cache-backed) runs **server-side** in
  the `geoapi-next` Next.js project, deployed as **its own Vercel project**.
- rates-app talks to the brain over **plain HTTPS** (`fetch`). Secrets (HERE key, Supabase
  service-role key) live in the **brain's Vercel env vars — never in the browser bundle**.
- The brain and rates-app already **share one Supabase project** (the "rates" project), so the cache
  tables (`geocode_cache`, `here_route_cache`, `us_ports`) are common ground.
- Because the boundary is just an HTTP URL, **migrating to Path B (Supabase Edge Function) later
  changes only the URL/invoke call in rates-app — nothing else.**

---

## 1. The core constraint (why the brain can't live inside rates-app)

```
rates-app = Vite SPA  →  `vite build`  →  folder of static HTML/JS/CSS  →  Vercel CDN
                                                                            │
                                                              runs in the USER'S BROWSER
                                                              (no Node process, no server)
```

Anything bundled into rates-app is **public**. If the HERE key or Supabase service-role key were
imported into a React component, Vite would compile them into the downloadable JS — anyone could read
them in DevTools and drain your quota / bypass RLS.

`geoapi-next` is the opposite: its `app/api/*/route.ts` files declare `export const runtime = 'nodejs'`
and execute on a **server** (Vercel Functions). Secrets read via `process.env` there never reach the
browser. **That is why the brain must stay server-side and be *called*, not *imported*.**

> Mental model: rates-app is the **client**. geoapi-next is a **private API service**. The HERE key is
> a server secret living with the service, exactly like the service-role key already does.

---

## 2. Path A topology

```
        ┌──────────────────────────────────────────────────────────────┐
        │  rates-app  (browser SPA — static on Vercel CDN)              │
        │                                                                │
        │   src/lib/geo.js   ──►  fetch('https://<brain>/api/route?…')   │
        │   (thin HTTP client; holds NO secrets, only the brain's URL)   │
        └───────────────────────────────┬────────────────────────────────┘
                                         │  HTTPS (CORS-enabled)
                                         │  cross-origin browser call
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  geoapi-next  (THE BRAIN — own Vercel project, Node runtime)  │
        │                                                                │
        │   /api/geocode   q          → resolveLocation()                │
        │   /api/within    a,b,miles  → resolveLocation ×2 + PostGIS     │
        │   /api/route     a,b        → resolveLocation ×2 + HERE  ★NEW   │
        │   /api/healthz                                                 │
        │                                                                │
        │   lib/resolve · lib/geocode · lib/here(NEW) · lib/cache        │
        │   Secrets (server-only env):                                   │
        │     SUPABASE_SERVICE_ROLE_KEY · HERE_API_KEY · CONTACT_EMAIL   │
        └───────┬───────────────────────────────────┬────────────────────┘
                │ supabase-js (service-role)         │ fetch (on cache miss only)
                ▼                                     ▼
   ┌────────────────────────────┐        ┌─────────────────────────────┐
   │ Supabase "rates" project   │        │  Upstream APIs               │
   │  geocode_cache             │        │   Nominatim (geocoding)      │
   │  here_route_cache   ★NEW   │        │   HERE Routing v8 (truck)    │
   │  us_ports                  │        └─────────────────────────────┘
   │  + PostGIS fns             │
   │  (SAME project rates-app   │
   │   uses for its own data)   │
   └────────────────────────────┘
```

Two clouds, one boundary: **rates-app (Vercel) → brain (Vercel) → Supabase + upstreams.** The brain is
the only thing that ever sees a secret or an upstream API.

---

## 3. Where every secret and config value lives

| Value | Lives in | Exposed to browser? | Notes |
|---|---|---|---|
| `HERE_API_KEY` | **brain's** Vercel env vars | ❌ never | Server-only. Same category as service-role key. |
| `SUPABASE_SERVICE_ROLE_KEY` | brain's Vercel env vars | ❌ never | Bypasses RLS for cache read/write. See `geoapi-next/SUPA.md §6`. |
| `SUPABASE_URL`, `CONTACT_EMAIL` | brain's Vercel env vars | ❌ | Required by `lib/config.ts`. |
| Brain's **public URL** (`https://geoapi-next-….vercel.app`) | **rates-app** env (`VITE_GEO_API_URL`) | ✅ fine | A URL is not a secret. This is *all* rates-app needs. |
| Supabase **anon** key | rates-app env (`VITE_…`) | ✅ by design | rates-app's normal DB access; unrelated to the brain. |

> Rule of thumb: if a value can drain money or bypass security, it lives with the brain. rates-app only
> ever knows **where** the brain is, never **how** it authenticates upstream.

---

## 4. The new piece — `/api/route` (HERE) inside the brain

This mirrors the existing `/api/within` exactly: geocode both endpoints (cache → Nominatim), then do
the real work. For routing the "real work" is a call to HERE Routing v8 with `transportMode=truck`
(drayage = truck moves), cached in a new `here_route_cache` table so a given lane is only ever routed
once.

### 4a. Request flow — cache HIT (the common case)

```
browser
  └─► GET /api/route?a=Los Angeles, CA&b=Long Beach, CA
        │
        ├─ resolveLocation("los angeles, ca")  ─► geocode_cache HIT ─► {lat,lon}
        ├─ resolveLocation("long beach, ca")    ─► geocode_cache HIT ─► {lat,lon}
        │
        └─ getCachedRoute(key)  ─► here_route_cache HIT
                                    └─► return {distance, duration, polyline, cached:true}
        ◄──────────────────── 200, NO upstream calls, NO HERE quota spent
```

### 4b. Request flow — cache MISS

```
browser
  └─► GET /api/route?a=…&b=…
        ├─ resolveLocation(a) ─► (cache miss) ─► Nominatim ─► write geocode_cache
        ├─ resolveLocation(b) ─► (cache miss) ─► Nominatim ─► write geocode_cache
        │
        └─ getCachedRoute(key) ─► MISS
                                   └─► HERE Routing v8 (truck, origin→destination)
                                        └─► putCachedRoute(key, summary+polyline)
                                             └─► return {…, cached:false}
        ◄──────────────────── 200, HERE quota spent ONCE; next identical lane is free
```

### 4c. Cache key

The route cache key must be **order-sensitive and built from the normalized geocode keys** (A→B ≠ B→A
for a real road route):

```
routeKey = `${normalize(a)}|${normalize(b)}|truck`
```

Reusing `normalize()` from `lib/geocode.ts` keeps "Los Angeles, CA" and " los angeles,  ca " collapsing
to the same key — same discipline as the geocode cache.

### 4d. Sketch of `lib/here.ts` (to build in geoapi-next)

```ts
// origin/destination are {latitude, longitude} from resolveLocation()
export async function fetchHereRoute(o: LatLng, d: LatLng) {
  const url = new URL('https://router.hereapi.com/v8/routes')
  url.searchParams.set('transportMode', 'truck')
  url.searchParams.set('origin', `${o.latitude},${o.longitude}`)
  url.searchParams.set('destination', `${d.latitude},${d.longitude}`)
  url.searchParams.set('return', 'summary,polyline')
  url.searchParams.set('apikey', must('HERE_API_KEY'))   // server-only env
  // …fetch with AbortController timeout (mirror searchNominatim), map 4xx/5xx → UpstreamError
  // return { distanceMeters, durationSeconds, polyline }
}
```

And `here_route_cache` (mirror `geocode_cache`'s shape from `geoapi-next/SUPA.md §2`):

```sql
create table if not exists here_route_cache (
  route_key      text primary key,           -- `${a}|${b}|truck` (normalized)
  origin_query   text not null,
  dest_query     text not null,
  distance_m     double precision not null,
  duration_s     double precision not null,
  polyline       text,                        -- HERE flexible polyline (decode client-side to draw)
  provider       text not null default 'here',
  created_at     timestamptz default now()
);
```

> Routes don't need PostGIS — they're precomputed road distances, not point geometry. Only
> `geocode_cache`/`us_ports` need the `geography` column + GiST index described in `SUPA.md`.

---

## 5. The two things Path A forces you to handle (don't skip these)

Because the browser calls the brain on a **different origin** (`rates-app.vercel.app` →
`geoapi-next.vercel.app`), Path A introduces two concerns that Path B would hand you for free:

### 5a. CORS — required, or the browser blocks the response

The brain must answer cross-origin requests, including the preflight `OPTIONS`. Add a tiny helper in
geoapi-next and return these headers from every `/api/*` response:

```ts
const cors = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? '*', // lock to rates-app's URL in prod
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,authorization',
}
// export async function OPTIONS() { return new Response(null, { status: 204, headers: cors }) }
// and spread `...cors` into every NextResponse.json(..., { headers })
```

Set `ALLOWED_ORIGIN` to your real rates-app domain in production rather than `*`.

### 5b. Abuse / access control — the brain is public by default

A public URL means anyone can call it and spend your HERE/Nominatim quota. For a learning phase `*` CORS
is fine, but before real use add **one** of:
- a **shared secret header** rates-app sends (`Authorization: Bearer <token>` checked in the route), or
- verify the **Supabase JWT** rates-app already has (the brain can validate the user's access token), or
- basic per-IP rate limiting.

> This is exactly the friction Path B removes: a Supabase Edge Function sits behind Supabase auth, so
> "only logged-in rates-app users can call it" is the default, not something you build. Note it now;
> revisit when you graduate to Path B.

---

## 6. How rates-app calls the brain

One thin client module — the **only** place rates-app knows the brain exists. Keep the interface
identical to what a future Edge Function would expose, so the swap in §8 is a one-file change.

```js
// rates-app/src/lib/geo.js
const BASE = import.meta.env.VITE_GEO_API_URL  // e.g. https://geoapi-next-xxx.vercel.app

export async function getRoute(a, b) {
  const url = `${BASE}/api/route?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`route failed: ${res.status}`)
  return res.json()   // { distance_m, duration_s, polyline, cached }
}

export async function geocode(q) {
  const res = await fetch(`${BASE}/api/geocode?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`geocode failed: ${res.status}`)
  return res.json()
}
```

A React feature (e.g. a drayage lane editor per `DRAY.md`) just calls `getRoute(origin, dest)` and
renders the distance/duration — it never knows about HERE, Nominatim, caching, or any secret.

```
DrayageLaneRow  ──►  getRoute(origin, dest)  ──►  src/lib/geo.js  ──►  brain  ──►  {distance, duration}
   (component)            (feature calls)           (HTTP client)
```

---

## 7. Setup checklist (Path A)

```
Brain (geoapi-next):
  [ ] Add lib/here.ts (fetchHereRoute) + app/api/route/route.ts (mirror /api/within)
  [ ] Create here_route_cache table in the rates Supabase project (§4d)
  [ ] Add CORS helper + OPTIONS handler to all /api/* routes (§5a)
  [ ] Vercel env: HERE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CONTACT_EMAIL, ALLOWED_ORIGIN
  [ ] Deploy → note the public URL
  [ ] Smoke test: curl '<url>/api/route?a=Los Angeles, CA&b=Long Beach, CA'

rates-app:
  [ ] Add VITE_GEO_API_URL=<brain url>  (Vercel env + .env.local)
  [ ] Add src/lib/geo.js (§6)
  [ ] Call getRoute()/geocode() from the feature that needs it
```

---

## 8. Path B — future alternative (Supabase Edge Function)

When the brain proves itself and the cross-origin / abuse friction of §5 starts to feel like overhead,
collapse it onto Supabase. **This is a one-way improvement in elegance and data-locality, and rates-app
barely changes.**

### Why move

```
Path A:  browser ─► Vercel function ─cross-cloud─► Supabase cache ─► upstream
                    (compute and cache live in DIFFERENT clouds; every cache
                     hit is a cross-provider round-trip; you maintain CORS,
                     a 2nd deploy, a 2nd secret store, and your own auth gate)

Path B:  browser ─► Supabase Edge Function ─local─► Supabase cache ─► upstream
                    (compute sits NEXT TO the cache it reads on every call;
                     Supabase JWT auth is automatic; one platform, one deploy,
                     one secret store; pin the function to the DB's region and
                     the hot-path cache hop becomes near-local)
```

Since the workload is **cache-dominated by design**, the hop that matters most is function↔cache — and
Path B makes it local. Path B also makes the existing PostGIS work (`cache_within_miles`, `is_near_port`
in `SUPA.md`) a local call instead of a remote RPC.

### What changes

| Layer | Path A | Path B |
|---|---|---|
| Brain code | Next.js `app/api/*/route.ts`, Node runtime | `supabase/functions/geo/index.ts`, **Deno** runtime |
| Port effort | — | mechanical: `process.env.X` → `Deno.env.get('X')`; drop `next/server`; same `lib/*` logic |
| HERE key | brain's Vercel env | `supabase secrets set HERE_API_KEY=…` |
| Auth | you build it (§5b) | Supabase JWT, automatic |
| CORS | you build it (§5a) | still set headers, but same-platform |
| **rates-app call site** | `fetch('${VITE_GEO_API_URL}/api/route?…')` | `supabase.functions.invoke('geo', { body:{ a, b } })` |

> The only rates-app change is inside `src/lib/geo.js` — swap the `fetch` for `supabase.functions.invoke`.
> Every component keeps calling `getRoute(a, b)` unchanged. **That swappability is the whole reason the
> brain lives behind an HTTP interface.**

### Migration sequence (when you decide to go)
1. `supabase functions new geo`; paste in the ported `resolve`/`geocode`/`here`/`cache` logic (Deno).
2. `supabase secrets set HERE_API_KEY=… CONTACT_EMAIL=…` (service-role + URL are injected by Supabase).
3. Deploy: `supabase functions deploy geo`. Cache tables already exist — no DB work.
4. Flip `src/lib/geo.js` to `supabase.functions.invoke('geo', …)`; ship rates-app.
5. Retire the geoapi-next Vercel project (or keep it as the reference/prototype).
```
