# HANDOFF — where things stand, and what to do next

Written 2026-07-27. Read this first, then [MIGRATION.md](MIGRATION.md) for the execution order
and [HUB2.md](HUB2.md) for the reasoning behind it.

---

## Done — the geo brain is locked

`geoapi-next` required no authentication until this week. Anyone with the URL — inlined into
every RatesApp bundle by Vite — could spend the HERE and Nominatim quota. That is closed.

| Commit | Repo | |
|---|---|---|
| `ec8c8a5` | geoapi-next | `lib/auth.ts` — Supabase JWT or service token on every `/api/*` except `/healthz` |
| `908ece5` | geoapi-next | `/api/healthz` reports which auth inputs are configured |
| `fcce65f` | RatesApp | `geo.js` attaches the session token; `postChunked` no longer retries 4xx |

**Verified 27/27 against production** with `geoapi-next/lock_test.ipynb` (gitignored — holds
hardcoded credentials, runs on the `schedulesenv` Python env). Anonymous → 401, both public key
formats → 401, service token → 200, real ES256 session → 200, tampered signature → 401,
`/healthz` open. Plus an Apply Rates run through the deployed browser app.

Re-run that notebook after any change to the brain. It is the only thing that proves the lock
still holds.

---

## Next — one action, and it needs you

Everything downstream is blocked on two commands:

```bash
cd c:/Users/Mike/Documents/GitHub/RatesApp
npx supabase login       # personal access token — no Docker needed
npx supabase db pull     # prompts for the DB password (Dashboard → Settings → Database)
```

**Why this is first:** `supabase/migrations/` has six feature migrations and **no baseline**.
They do `alter table rates …` and `create policy … on drayage_rates`, assuming tables nothing
creates — so **`supabase db reset` fails today**, and no migration can be verified locally
until the baseline exists.

**The moment `supabase login` is done**, a fresh session can run MIGRATION Phase 1 — introspect
both Supabase projects through the Management API and produce `MIGRATION_INVENTORY.md`. The
query set is already written out in [MIGRATION.md](MIGRATION.md#the-query-set).

**Docker is not needed for either command.** It is only required for `supabase db reset` and
`supabase start`, which come in Phase 2. Neither Docker nor WSL is installed on this machine;
install instructions are in the conversation, or use the freed Supabase project slot as a cloud
dev environment instead.

---

## Then, in this order

The two documents interleave. Two dependencies are not obvious from reading either alone:

| | Step | Note |
|---|---|---|
| 1 | MIGRATION Phase 1 — introspect both projects | everything downstream is written from it |
| 2 | **HUB2 step 4** — helper facade (~1 hr) | MIGRATION Phase 3 wants `my_org_type()`. Doing it first means writing the schedules policies **once** |
| 3 | MIGRATION Phase 2 — replicate the structure | |
| 4 | MIGRATION Phase 3 — re-derive RLS | the risky part |
| 5 | MIGRATION Phase 4 — repoint scrapers, secrets first | |
| 6 | **HUB2 step 3** — identity hardening (~1 day) | |
| 7 | MIGRATION Phase 5 — React app login | **depends on 6** — it mirrors RatesApp's post-Phase-A `AuthProvider`. Built earlier it would copy today's broken pattern |
| 8 | MIGRATION Phase 6 — delete Render, retire `jnui…` | |

HUB2 step 2 folds into 3 — `db pull` already captures the brain's tables.

---

## Context a fresh session will not have

**The docs were wrong twice, in the same way.** HUB2's "three gaps" table described the brain as
missing CORS and batch endpoints; both had been built and deployed two commits earlier, and the
claim was repeated from a stale local checkout. HUB2 also claimed schedules' `ports` matches
rates' `us_ports`; it does not — 592 global rows with nine extra columns versus a US-only table.

Both were caught by checking reality, not by reading more carefully. **Verify against the
deployed service or the database, never against a local checkout or a doc.**

**Objects the docs still undercount.** A grep found a `vessels` table and RPCs `nearest_ports`,
`nearby_schedules`, `distinct_pols`, `is_near` that HUB2 never mentions. Assume that list is also
incomplete — Phase 1 exists because only the database knows.

**Two `SECURITY DEFINER` RPCs are the real security problem.** `nearby_schedules` and
`distinct_pols` bypass RLS by design and are callable by anyone holding the anon key, which
ships in every RatesApp bundle. Enabling RLS on the tables does **not** close that path.

**Decided, do not relitigate:**

- The Schedules React app gets a **Supabase login via Google OAuth** against the rates project.
  Its JWT is then `sfoz…`-issued and the brain accepts it unchanged. Cloudflare Access is not an
  alternative — it protects a hostname, not the database.
- **Disable new user signups before enabling Google OAuth.** Otherwise anyone with a Gmail
  address gets a token the brain accepts and can spend the HERE quota.
- `ports` and `us_ports` stay **separate tables**.
- The schedules data is **disposable** — re-scrape rather than migrate. This is structure
  replication, not a data migration.

---

## Loose ends

- [ ] **`service_role` key hardcoded in `Schedules/ingest_schedules.py` and `add_port.py`**,
      valid to 2036. That repo has no git history yet; this plan gives it one. Minutes now,
      unfixable-in-history later
- [ ] **No CI anywhere.** Four items in HUB2 assume it. Worth pulling ahead of MIGRATION Phase 3
      — isolation tests are the only thing standing between you and a cross-tenant leak once
      partner accounts share the database
- [ ] `GEO_SERVICE_TOKEN` is set in Vercel but nothing consumes it. Rotate when a real consumer
      appears
- [ ] The brain's demo homepage (`geoapi-next/app/page.tsx`) now 401s — expected, it was a free
      quota console. Preview deployments of RatesApp fail CORS for the same reason

---

## Environment notes

- **Python for the notebooks:** `C:\Users\Mike\OneDrive - Prime Time Packaging\Schedules\schedulesenv`
  — has `requests`, `pandas`, `python-dotenv`, `ipykernel`
- **Docker / WSL:** neither installed
- `RatesApp/.env.local` exists (gitignored) and currently points `VITE_GEO_API_URL` at the
  deployed brain; a commented line switches it to `localhost:3000`
- Supabase projects: rates `sfozxpibfpqsdlxoheyl`, schedules `jnuigkggmynerrbxvkzy`
