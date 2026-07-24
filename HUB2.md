# HUB2 — The Plan

The plan for moving four standalone apps onto two domains, one database, and one internal
hub — without merging any of them.

---

## The shape

```
ptpworkspace.com          the hub — a dashboard of cards        ZERO TRUST
  rates.ptpworkspace.com  RatesApp, internal views              ZERO TRUST
  plan.ptpworkspace.com   Stuffer Planner                       ZERO TRUST
  <next>.ptpworkspace.com future tools, same pattern            ZERO TRUST

ptpdesk.com               partners
  quotes.ptpdesk.com      forwarders — split out of RatesApp    Supabase + MFA
  plan.ptpdesk.com        factories — SAME deployment as
                          plan.ptpworkspace.com                 Supabase + MFA

Supabase                  ONE project. Postgres + Auth + RLS + Edge Functions.
                          The only thing the apps actually share.

geoapi-next               the brain — HERE/Nominatim keys + route cache.
                          Deliberately PUBLIC, never behind Zero Trust,
                          protected by a Supabase JWT check. See groundwork.
```

**Apps stay standalone.** They relate through data, not code. The hub is a dashboard plus
single sign-on — not a container the apps move into.

### How it works, per person

**Internal — Jordan, a planner at PTP**

Goes to `ptpworkspace.com`. Cloudflare Access challenges once (Google or email OTP); the
email is on the policy, so they're in. They land on a dashboard of cards — Rates, Planner,
Schedules, Shipments, Tools. Clicking *Planner* opens `plan.ptpworkspace.com`, and Access
is already satisfied — **no second gate.** Inside each app they sign in to Supabase once per
app, per device, and stay signed in. They see everything: all organizations, all rates, all
containers, and the internal-only tooling.

**Forwarder — an analyst at a drayage company**

Goes to `quotes.ptpdesk.com`. No Cloudflare Access — the app loads and asks for email,
password, and their TOTP code. They see the forwarder side of RatesApp only: lanes open for
quoting, their submission form, their own active rates. Everything is scoped by
`organization_id = my_org()`, so another forwarder's pricing is invisible — and after the
split, the internal code isn't even in the bundle they downloaded.

**Factory — a merchandiser at a supplier**

Goes to `plan.ptpdesk.com`. No Access, same Supabase login + TOTP. They land on **the same
planning board internal users see** — same tray, same grid, same drag-and-drop, same live
presence avatars. What differs is scope and permission: their own containers and their own
PO lines, and no Commit, Uncommit, or Export. Their write surface is Cargo Ready Date and
the CBM fields on their own lines, either in the grid or by uploading the CSV they email
today.

> **One honest detail.** Cloudflare Access SSO covers the *gate*, not the app session.
> Supabase sessions live in `localStorage`, which is per-origin, so an internal user signs
> in to each app separately the first time. Sessions are long-lived, so in practice it is
> once per app per device. If that ever grates, the fix is a session cookie scoped to
> `.ptpworkspace.com` — **which is safe only because partners live on a different registrable
> domain.** Another place [two domains](#domains--buy-two) pays for itself.

### The three rules everything follows

1. **Split when the audiences see different things; keep one app when they see the same thing.**
   RatesApp's internal and forwarder views never share a screen → split. Stuffer Planner's
   three roles share one live tray → never splits.
2. **The hub is Cloudflare Access SSO.** Authenticate once at `ptpworkspace.com`, click a
   card, land on another subdomain already authenticated. Adding an app = new subdomain,
   new card, add the hostname to the Access policy.
3. **The database is the shared layer.** No monorepo, no shared package. The apps write
   disjoint tables.

---

## Absorption is small

The apps share **exactly three things: `profiles`, `organizations`, and the RLS helper
functions.** That is the entire surface. No shared code, no shared normalization, no
coordinated releases, no monorepo.

**And it is nearly decoupled.** Expand is additive: create `organizations` carrying the
existing `forwarders.id` values, add a nullable `profiles.organization_id` beside
`forwarder_id`, backfill. RatesApp does not change a line. The single ordering constraint is
that expand lands **before the planner's schema is written**, so the planner builds on
`organizations` instead of inventing `suppliers`.

**The piece that makes it genuinely cheap is the helper facade.** Create `my_org()`,
`my_org_type()`, and `my_org_role()` now, backed by today's columns. The planner writes every
policy against them from day one. When the organizations migration lands you change only the
function bodies — every policy in both apps keeps working. The planner never learns the model
changed underneath it.

Details: [RatesApp groundwork](#ratesapp-groundwork--getting-ready-to-be-joined) ·
[Stuffer Planner checklist](#stuffer-planner-backend--the-absorption-checklist)

---

## Domains — buy two

**Yes, one domain would technically work.** Buy two anyway. It is ~$12/year for the only
decision in this plan you cannot walk back.

| | One domain | **Two domains** |
|---|---|---|
| The rule you have to remember | "ZT on these subdomains, not those" — a judgement call every time you add one | **"`ptpworkspace.com` is always Zero Trust. `ptpdesk.com` never is."** No exceptions, nothing to decide |
| Wildcard mistake | One `*.domain.com` Access rule either locks partners out or exposes internal | Impossible — the zones have opposite defaults |
| Cookie boundary | Partner and internal hostnames are *same-site* | *Cross-site*, enforced by the browser |
| Partner email | Invitations arrive from your internal-sounding domain | `ptpdesk.com` sends partner mail; one clean SPF/DKIM/DMARC setup |
| Cost | ~$12/yr | ~$24/yr |

**The decisive argument is that partner URLs can never be moved.** Once forwarders and
factories hold credentials and bookmarks, changing their login domain is a comms exercise
with people outside the company — and a "your login moved" email is indistinguishable from
phishing. You get one clean opportunity. Spend the extra twelve dollars there.

Names are yours. `quotes.` / `plan.` / `rates.` are fine; so are `containers.`, `desk.`,
anything memorable to the people typing it.

- [ ] Register both — auto-renew ON, registrar lock ON, renewal notices to a shared inbox

---

## Decisions (settled)

| # | Decision | One-line reason |
|---|---|---|
| 1 | **Standalone apps; hub = SSO** | Merging costs two major-version upgrades and a grid-library swap, and buys nothing a user notices |
| 2 | **Vite SPA everywhere for the apps** | No SSR need — every route is behind a login. Consequence: **the frontend holds only public values.** Secrets live server-side: Supabase Edge Functions, or `geoapi-next` where an upstream API key and a rate limiter genuinely need a server |
| 3 | **`organizations`, not `forwarders`/`suppliers`** | Two apps invented the same concept twice. One table, `type = internal \| forwarder \| customer` |
| 4 | **One Supabase project, everything in it** | One `auth.users`, one organization directory, one onboarding — the apps stay standalone, but the *people* are the same. Dev is local (`supabase start`), not a second project |
| 5 | **Identity comes from `profiles`, never `user_metadata`** | `user_metadata` is user-writable. Client and RLS read the same row |
| 6 | **Retire by unreachability, then delete** | A Vite build inlines its env vars, so stripping keys does not neutralize a deployment that already shipped. Only unreachability does |

Each was argued out and settled. Reverse one only deliberately.

---

## Sequence

### Now — while the apps stay separate

Cheap habits that stop later phases from growing. Nothing else in this file applies yet.

- [ ] **Baseline the schema** — `supabase db pull`, commit it. Every hand-run change from here is drift someone has to reconstruct
- [ ] **Close the brain's three gaps** — CORS, JWT auth, and the two batch endpoints. Not domain work: Apply Rates and Drayage Analytics cannot work until it is done. See [brain groundwork](#the-brain-geoapi-next--groundwork)
- [ ] **Write migrations from today on.** One repo owns them — see [Stuffer Planner](#stuffer-planner-backend--the-absorption-checklist)
- [ ] **Identity hardening in RatesApp** (below) — a day, depends on nothing
- [ ] Any new table gets `organization_id`, never `forwarder_id` or `supplier_id`
- [ ] Start the mock-account register — organization, who holds it, intended real owner

**Do not** register domains yet, buy anything, or start hub work.

### Phase A — Identity hardening (RatesApp, ~1 day)

Role lives in two places today: `profiles.role` (read by RLS and Edge Functions) and
`user_metadata.role` (read by the app, **writable by the user**). Delete the second.

- [ ] `AuthProvider`: one `profiles` query → `role`, `organization_id`, name. `undefined` = loading, `null` = no row
- [ ] `role = normalizeRole(profile?.role) ?? null` — **no row, no role, no domain**
- [ ] Query failure resolves to `null` (deny), never a guess
- [ ] Delete `devRole`, `toggleDevRole`, the `dev_role` localStorage read, and the TopNav switcher
- [ ] `App`: `LoadingScreen` while unresolved, `NoAccess` when null
- [ ] `RoleRouter`: explicit switch, not `role === FORWARDER ? … : '/internal'`
- [ ] **Two-organization fixture** in `supabase/seed.sql` — the isolation test is vacuous with one

**Gate:** from a forwarder session, `supabase.auth.updateUser({ data: { role: 'internal' } })` then reload. A rendered internal dashboard is a failed check.

### Phase B — One database

Two Supabase projects today: `rates` and `schedules` (internal only). Everything ends up in
one.

- [ ] **Baseline `rates` first** — `supabase db pull`, commit. Minutes, and it is the recorded starting point before anything moves
- [ ] Verify it reproduces: `supabase db reset` locally, RLS policies, helpers, and generated columns intact
- [ ] **Move the schedules tables into `rates`** — [full procedure](#folding-a-supabase-project-into-the-target). PostGIS first; RLS is re-derived, not copied
- [ ] **Retire the `schedules` project**
- [ ] **Expand** — `organizations`, `organization_services`, `profiles.org_role`, the three helpers (below). Additive: RatesApp keeps running on `forwarder_id` and does not change a line
- [ ] **Then** build the planner's tables in the same project, on that model
- [ ] `pg_dump` daily backup job (GitHub Action → private storage)
- [ ] **CI exists** — no `.github/` and no test runner today. GitHub Actions + Vitest. Four items in this plan assume CI
- [ ] Secret scanning in CI
- [ ] Drift check in CI — `supabase db diff --linked`, non-empty output fails

**Gate:** the schema reproduces from migrations alone, and one project holds everything.

#### One project is not one tangled schema

`containers` and `rates` have nothing to do with each other and never will. They are
independent tables that happen to share a database.

The apps share **two tables — `profiles` and `organizations` — plus the helper functions.**
Everything else stays as separate as it is today. You are not merging the apps; you are
giving them one place to look up *who someone is*.

#### The development environment is local, not a second project

The Supabase CLI runs a full local stack — Postgres, Auth, Storage — with `supabase start`.
Write a migration, `supabase db reset` replays everything from scratch, verify, then push to
production. **That is the dev environment.** No second cloud project required.

So the slot freed by retiring `schedules` does not have to become anything. Leave it empty;
it is there later if you want a staging environment that is not your laptop.

> The one dependency is Docker Desktop. If you would rather not run it on Windows, use the
> freed slot as a cloud Development project instead — same workflow, just not local. Either
> is fine.

#### The only ordering that matters

```
baseline → consolidate schedules → EXPAND → planner tables → everything else
```

When the planner's schema is written, `profiles` and `organizations` must already exist in
their shared form. Otherwise the planner creates `suppliers` and a second `profiles`, and you
migrate twice — re-testing the RLS you had just finished verifying.

#### The organizations migration

```
organizations         id, name, type ('internal'|'forwarder'|'customer'), active
organization_services organization_id, service, active
profiles              id → auth.users, organization_id NOT NULL, org_role, full_name, tags
```

`profiles.role` and `profiles.company` disappear — role becomes `organizations.type`.
PTP becomes an organization with `type='internal'`, so `organization_id` is NOT NULL
everywhere and the "null means internal" special case is gone.

**The trick:** create `organizations` rows carrying the existing `forwarders.id` values
unchanged. Every `forwarder_id` already stored is then already a valid `organization_id` —
the migration is a copy, not a remap, and each step verifies with a query returning zero.

| Stage | Reversible by |
|---|---|
| **Expand** — new tables, nullable `organization_id` beside every `forwarder_id`, backfilled | Dropping the columns; nothing reads them |
| **Migrate** — `my_org()`/`my_org_type()`, policies moved, indexes and unique constraints recreated, apps switched | Both policy shapes exist; swap back |
| **Contract** — drop `forwarder_id`, `my_forwarder()`, `current_role_is()`, `forwarders`, `profiles.role` | Not reversible — last, and separate |

> `organization_id` means **whose data this is**, not who typed it. Internal upload on behalf
> of a forwarder sets `organization_id` to the forwarder, `provider_id` to the internal user.

### Phase C — The hub

Small. It is a dashboard, DNS, and one Access policy.

- [ ] New Vercel project: a card grid, permission-aware, linking to each subdomain
- [ ] Point each app at its `*.ptpworkspace.com` subdomain — Cloudflare DNS-only first, let the cert issue, then switch to proxied, SSL **Full (Strict)**
- [ ] One Cloudflare Access application covering the zone; **verify SSO actually carries across hostnames** — this is the load-bearing claim of the whole design
- [ ] **Block every `.vercel.app` origin** — Deployment Protection on every project. Verify from a clean browser; a page that renders is a failed check
- [ ] Retire old URLs as each app moves — [unreachable day 0, deleted day 14](#decommissioning)

**Gate:** internal users reach every tool from one dashboard with one login, and no `.vercel.app` URL serves production data.

### Phase D — Partner access

- [ ] Split RatesApp's forwarder views into their own Vercel project → `quotes.ptpdesk.com`
- [ ] Attach `plan.ptpdesk.com` to the **existing** Stuffer Planner project as a second domain
- [ ] **In Vercel, ensure neither domain redirects to the other** — the default primary-domain redirect would bounce factories onto the internal hostname
- [ ] `ptpdesk.com` hostnames: **never proxied through Access.** RLS is the entire boundary
- [ ] Isolation tests in CI — a forwarder cannot see another forwarder's quote on a shared lane
- [ ] Storage buckets private, scoped by `organization_id`
- [ ] `service_role` absent from every client bundle — check the built output

### Phase E — Onboarding (the point of all this)

Mock accounts are already partner-scoped logins held by you, so handover is data-only and
all history survives — the UUID does not change.

- [ ] **Supabase Pro** before any invitation; verify backups
- [ ] Custom SMTP (Resend / SES / Postmark) + SPF, DKIM, DMARC on `ptpdesk.com`
- [ ] Mandatory TOTP MFA at first login; CAPTCHA + tightened rate limits; no self-registration
- [ ] Recovery email sends a **code**, not a link. Identical response for existing and unknown addresses
- [ ] Per handover: change email → **clear the existing MFA enrollment** (the TOTP secret is yours) → force password reset → record a handover timestamp → remove from the mock register
- [ ] Invite **named individuals** (`jon@forwarder.com`), never shared mailboxes
- [ ] **Onboard one organization first.** The first real external login is where assumptions break

**Gate:** the first invitation points at `ptpdesk.com`, never a Vercel URL.

---

## RatesApp groundwork — getting ready to be joined

The two apps share **`profiles`, `organizations`, and the RLS helper functions.** Nothing
else. Groundwork means readying those three, and stopping there.

**Expand is additive, so RatesApp is never blocked** — create `organizations` carrying the
existing `forwarders.id` values, add a nullable `profiles.organization_id` beside
`forwarder_id`, backfill. RatesApp keeps reading `forwarder_id` and does not change a line.

But **the planner does wait for it**, because its schema has to be written against
`organizations` and `my_org()` rather than inventing `suppliers`. That is the one ordering
constraint in this plan — see [Phase B](#the-only-ordering-that-matters).

### Do anyway — improves RatesApp on its own merits

- [ ] **Baseline the schema.** `supabase db pull`, verify RLS policies, helpers, and generated columns survived, commit. ~1 hour
- [ ] **Identity hardening** (Phase A above). ~1 day. The planner mirrors this pattern, so both apps behave identically at the auth boundary

### One migration, before the planner's backend

**The helper facade — the piece that makes everything else cheap.** Create the target
function names *now*, backed by today's columns:

```sql
create or replace function my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select forwarder_id from profiles where id = auth.uid()
$$;

create or replace function my_org_type() returns text
language sql stable security definer set search_path = public as $$
  select case when role = 'internal' then 'internal' else 'forwarder' end
  from profiles where id = auth.uid()
$$;

create or replace function my_org_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(org_role, 'member') from profiles where id = auth.uid()
$$;
```

The planner writes every policy against these from day one. When the organizations migration
lands you change **only the function bodies** — `select organization_id from profiles` — and
every policy in both apps keeps working untouched. The planner never learns the model changed
underneath it.

This is also what stops `RLS.md`'s inline `exists (select 1 from profiles me where …)` from
ever being written. One idiom, one place to change it.

Two rules so the planner's policies are written correctly:

- `my_org()` returns null for internal users today. Isolation policies must **fail closed on null** (RatesApp's already do)
- "internal sees everything" uses `my_org_type() = 'internal'`, **never** `my_org()`

- [ ] Add the three helpers
- [ ] Add `profiles.org_role` — `text default 'member'`, check `admin | member`. RatesApp ignores it; the planner needs it on day one
- [ ] Run **expand** — `organizations`, `organization_services`, nullable `organization_id`, backfilled, zero mismatches verified

### At your leisure, afterwards

- [ ] Migrate RatesApp's policies onto the helpers
- [ ] **Contract** — drop `forwarder_id`, `my_forwarder()`, `current_role_is()`, `forwarders`, `profiles.role`, `profiles.company`

### Two decisions that are documents, not code

- [ ] **`supabase/` stops being RatesApp's.** It is the database's. Planner SQL lands there too. Put a README in the directory saying so, before you forget you decided it
- [ ] **Write the `profiles` / `organizations` contract down once**, in a doc both repos link to. That page is what stops the planner inventing `suppliers`

---

## Working across two repos, one database

**One `supabase/` directory, and it lives in RatesApp. The planner repo gets no Supabase
tooling at all.**

> **The trap:** one database can have only one migration history. If both repos run
> `supabase init` and link to the same project, you get two `migrations/` directories that do
> not know about each other — `db push` from one tries to re-apply what the other already
> ran, and `db diff` reports permanent phantom drift. Never `supabase init` in the planner
> repo.

**Schema work for either app** — in the RatesApp repo:

```bash
supabase migration new planner_containers
# write the SQL
supabase db reset      # replays everything locally, from scratch
supabase db push       # when it is right
```

**App work on the planner** — in the stufferPlanner repo:

```bash
# in RatesApp, once:
supabase start         # local Postgres + Auth + Storage

# in stufferPlanner/.env.local:
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<the local anon key supabase start prints>
VITE_DATA_SOURCE=supabase
```

Each app points at whichever stack you want — local while developing, production when
deployed. Neither app ever runs a migration; they only read env vars.

- [ ] **`supabase/seed.sql` covers the whole database.** Add planner fixtures alongside the
      rates ones — sample containers, master items, and the two factory organizations. Then
      `db reset` produces a working local dataset for *both* apps in one command
- [ ] The planner's existing repository abstraction is the right seam: `LocalMasterItemRepo`
      gains a `SupabaseMasterItemRepo` sibling and `VITE_DATA_SOURCE` flips between them.
      Migrate one repo at a time — the app stays shippable at every step

---

## Folding a Supabase project into the target

Written app-agnostically, because it applies to any project you absorb later. Schedules
specifics follow.

> **The principle that shapes all of it:** a schema is copied, **security is re-derived.**
> The source project's policies were written for the blast radius it had. The target has a
> different one — partners hold accounts there. Never carry RLS and grants across
> unexamined.

### 1. Inventory the source before touching anything

- [ ] Tables, views, **materialized views**, functions, triggers, indexes, sequences
- [ ] **Extensions** — these do not travel reliably in a schema dump
- [ ] Grants and RLS policies, recorded as *what the target will need*, not as a copy
- [ ] Storage buckets, auth users, cron jobs, Edge Functions
- [ ] **Every writer and reader** — apps, scripts, notebooks, anything holding a key
- [ ] Row counts and table sizes. The free tier is 500 MB; know before, not during

### 2. Prepare the target

- [ ] **Enable required extensions first.** A schema dump referencing `postgis` fails on a project that does not have it
- [ ] Check every incoming name against the target: tables, functions, types. Rename in the migration, not afterwards

### 3. Move the schema — as a migration, not a one-off

```bash
supabase db dump --schema public -f source_schema.sql    # from the source project
```

- [ ] **Read the dump by hand.** This is where you notice what did not come across
- [ ] Land it in `supabase/migrations/`, so the target still reproduces from nothing
- [ ] Strip the source's RLS and grants out of it — those get rewritten in step 6

### 4. Move the data

```bash
supabase db dump --data-only -f source_data.sql
```

- [ ] Respect FK order; load parents first
- [ ] For large tables prefer `COPY` over generated `INSERT`s
- [ ] Data is **not** a migration — load it once, do not commit it to `migrations/`

### 5. Rebuild derived objects rather than copying them

- [ ] Materialized views: create, index, then refresh. Never dump their contents
- [ ] Anything computable from base data — caches, aggregates — is recomputed

### 6. Re-derive security for the target's blast radius

- [ ] Enable RLS on every table that arrives without it, unless you can state why not
- [ ] Rewrite policies against the target's identity model (`my_org()`, `my_org_type()`)
- [ ] **Audit every `GRANT ... TO anon`.** In the target, `anon` is the key in every public bundle
- [ ] Verify from a partner-scoped session, not an internal one

### 7. Repoint the consumers, one at a time

- [ ] New URL and key per consumer; verify each before moving to the next
- [ ] Scripts and notebooks count. They fail silently and nobody notices for a week

### 8. Verify, then retire

- [ ] Row counts match, per table
- [ ] Every consumer exercised end to end
- [ ] Only then [decommission](#decommissioning) the old project

---

### Schedules specifics

The source is a Python scraper pipeline (`ocean-routing`, `ingest_schedules.py`) writing a
warehouse that a React app reads. Per `Schedules/SUPA.md`:

| Object | Note |
|---|---|
| `schedules` | Warehouse — every snapshot ever, hybrid relational + JSONB, **PostGIS geom columns**, `UNIQUE(schedule_hash)`. **RLS disabled** |
| `ports` | Port table + geocode cache |
| BEFORE trigger | Auto-fills `pol_geom` / `pod_geom` / `last_cy_geom` — **requires PostGIS** |
| `schedules_latest` | **Materialized view**, latest-per-lane, with a unique index required for `REFRESH ... CONCURRENTLY` |
| `refresh_schedules_latest()` | `SECURITY DEFINER`, called by ingest over RPC |
| Grants | `GRANT SELECT ON schedules_latest TO anon, authenticated` |

**The one that matters — RLS off stops being safe the moment it moves.**

Today `schedules` sits alone in a project only internal people hold keys to, so RLS disabled
costs nothing. In the target, forwarders and factories have accounts and the anon key ships
in every public bundle. Carried across unchanged, **every partner could read the entire
schedules warehouse, and so could anyone who extracted the anon key from a bundle.**

- [ ] Enable RLS on `schedules` and `ports`; internal-only policy via `my_org_type() = 'internal'`
- [ ] **`REVOKE SELECT ON schedules_latest FROM anon`**, keep `authenticated`, and gate it by policy
- [ ] Confirm the ingest scripts use the **service-role** key — it bypasses RLS, so ingestion keeps working. If they hold an anon key, enabling RLS breaks the pipeline

**The Render FastAPI geocoder is deleted, not migrated.**

The nested `api/` service — FastAPI on Render, `GET /geocode`, backed by its own
`geocode_cache` table — was built before the brain existed. It does exactly what the brain's
`/api/geocode` already does: Nominatim lookup, PostGIS cache. **The brain is not
rates-specific; it is the org's geo service, and schedules uses the same one.**

So this is a retirement, not a repoint:

- [ ] Point whatever geocodes in schedules (`add_port.py`, ingest) at the brain's `/api/geocode`
- [ ] **Do not migrate the `api/geocode_cache` table** — the brain owns the geocode cache now. This also settles the "`ports` vs brain cache collision" worry by deleting one side of it
- [ ] Delete the Render service and its nested `api/` repo. One fewer deployment target, no Render in the estate at all
- [ ] **New auth wrinkle:** the brain's [JWT check](#skip-the-shared-secret-go-straight-to-the-supabase-jwt) assumes a logged-in browser user. `add_port.py` and ingest are **server-side scripts with no user session** — so the brain must *also* accept a service credential (service-role key or a server-only shared secret) for backend callers. Browser → JWT; script → service token. Add this when you build the brain's auth, not after

**The rest, in order:**

- [ ] Import `schedules` + `ports` + the geom trigger as a migration
- [ ] Verify by running one full ingest and confirming the MV refreshes and the React grid still loads

**Three specifics that are easy to get wrong:**

- [ ] **PostGIS on the target first — before importing anything.** The geom-filling BEFORE trigger depends on it, and **extensions do not travel reliably in a schema dump.** Import first and the trigger creation fails, or worse, the geom columns import as a type the project does not recognise
- [ ] **`schedules_latest` is recreated, never dumped.** A materialized view's query cannot be altered in place — drop and recreate. Recreate its **unique index** too: that index is what makes `REFRESH ... CONCURRENTLY` possible, and without concurrent refresh every ingest locks the view the React app is reading
- [ ] **Check the table size before you start.** `schedules` is "every snapshot ever, kept forever" — the one table in your entire estate that can genuinely threaten the **500 MB free tier**. Know the number going in, not when an import stalls
- [ ] **Three consumers to repoint (the fourth is deleted).** `ingest_schedules.py` · `ocean-routing`'s scrapers and alerts engine · the React app. Scripts fail *silently* — a repointed pipeline that still writes the old project looks fine for a week, until someone asks why the grid stopped updating

---

## Stuffer Planner backend — the absorption checklist

Stuffer Planner has **no backend yet** — `VITE_DATA_SOURCE=local`, everything behind
`LocalSupplierRepo` / `LocalProfileRepo`. `RLS.md` is a design, not an implementation.

**That is the opportunity.** Building it against the shared model costs an edit to a design
doc. Building it against `suppliers` and a second `profiles` table costs a migration of a
second live schema later, with a table-name collision in the middle.

### Non-negotiable

- [ ] **No `suppliers` table.** Factories are `organizations` with `type='customer'`
- [ ] **No second `profiles` table.** There is one, shared with RatesApp: `id`, `organization_id`, `org_role`, `full_name`, notification tags. It already exists
- [ ] **`admin` vs `internal` becomes `profiles.org_role`** (`admin | member`), orthogonal to `organizations.type`. The planner is what makes this real rather than hypothetical — RatesApp does not need it yet, the planner does on day one
- [ ] **Use the shared RLS helpers** — `my_org()`, `my_org_type()`, `my_org_role()` as `SECURITY DEFINER`. `RLS.md` currently inlines `exists (select 1 from profiles me where …)` in every policy. Two RLS idioms in one database means every identity change is edited twice, in two styles
- [ ] **Scope on `organization_id`**, not `supplier_id`. The core invariant becomes `organization_id = my_org()` — identical to every other table in the database

### Schema mechanics

- [ ] **One repo owns migrations.** Two repos on one database means two migration histories and no way to order them. RatesApp already holds the baseline — treat its `supabase/` directory as *the database's*, not RatesApp's. Planner SQL lands there
- [ ] Check names before creating: `containers`, `container_allocations`, `master_items`, `container_sequences` are unclaimed today. Stay in `public`; skip the extra schema
- [ ] Keep the 2-letter supplier `code` — move it to `organizations.code`. It is used for container numbering (`next_container_code`) and is genuinely useful
- [ ] DB is snake_case throughout; map to camelCase in TS types as you already do

### What is NOT shared

The apps are standalone. They share **three things and nothing else:**

| Shared | Not shared |
|---|---|
| `profiles` | Every domain table — containers, allocations, master items, rates, drayage |
| `organizations` (+ `organization_services`) | Business logic, validation, normalization |
| The RLS helper functions | UI, components, stack, release cadence |

`containers.ofq_reference` is the planner's own field — the forwarder's number on a committed
container. RatesApp's `OFQID` is a column in the AIS rates-input CSV that Apply Rates groups
by. **Same word, different things.** No join, no shared handling, no coordination.

### Auth and onboarding

- [ ] Mirror RatesApp's post-Phase-A `AuthProvider` — profiles as the only source, fail-closed. Two apps behaving differently at the auth boundary is how one of them ends up wrong
- [ ] **One onboarding process, not two.** `ONBOARDING.md` and `RLS.md`'s onboarding section must merge into a single document: create organization → create auth user → insert profile → (internal only) add to the Access policy
- [ ] Factories reaching `plan.ptpdesk.com` get **no Cloudflare Access account.** `RLS.md` currently contemplates ZT for factories — drop that. Administering external identities in two systems scales badly and RLS is already the real boundary, by its own core invariant

### One thing to settle before writing the policies

`CLAUDE.md`'s permissions matrix says factories *"View all containers (draft + committed):
Yes."* `RLS.md`'s `containers_read` scopes them: `me.supplier_id = containers.supplier_id`.

Those read differently. "All" probably means *both statuses*, not *every supplier's* — but
this is a cross-tenant visibility question, so decide it explicitly rather than discovering
the answer from whichever doc gets implemented.

- [ ] Confirm: can a factory see another factory's containers and allocations? Write the
      answer into both docs, then implement it once

### Realtime

- [ ] Presence and locking work unchanged, but confirm Realtime connection limits on your tier before onboarding several factories at once
- [ ] Presence broadcasts identity. If factories cannot see each other's containers, make sure they cannot see each other's **avatars** either — a presence channel is a side channel

---

## The brain (`geoapi-next`) — groundwork

A Next.js service on Vercel holding the HERE and Nominatim keys plus a Supabase-backed cache.
RatesApp's browser calls it directly; `src/lib/geo.js` is the only place RatesApp knows it
exists.

**It is the org's shared geo service, not a rates dependency.** Schedules retires its Render
FastAPI geocoder and calls the same brain (see [schedules specifics](#schedules-specifics)).
Getting its groundwork right therefore pays off across every app that needs geocoding or
routing — one service, one place for the upstream keys, one cache.

**It is not ready — and this is not a domain problem.**

### Three gaps between what RatesApp calls and what the brain serves

| Gap | Evidence | Consequence |
|---|---|---|
| **No CORS** | No `Access-Control-*` headers, no `OPTIONS` handler, empty `next.config.ts`, no `vercel.json` | Every browser call is blocked — **on any domain**, including today's |
| **No auth** | No `Authorization` handling anywhere in `app/` or `lib/` | Anyone who finds the URL spends your HERE quota |
| **Two endpoints missing** | Only `geocode`, `route`, `within`, `healthz` exist | `/api/within-batch` and `/api/route-batch` 404 — Apply Rates geo checks and Drayage Analytics benchmarks cannot run |

Confirm in ten seconds: run a Drayage Analytics benchmark against the deployed app and watch
the network tab for a 404, or a CORS failure on `/api/route`.

> **RatesApp's client is ahead of the brain's server.** The consuming side was built to
> BRAIN.md's spec; the brain stopped at four endpoints. All of this has to be built anyway —
> the only choice is whether it gets built once, with the final domains in mind, or twice.

### CORS as an allowlist, not a single origin

`Access-Control-Allow-Origin` holds exactly one origin and cannot take a list, so BRAIN.md's
single `ALLOWED_ORIGIN` would make the domain move a flag day. Echo the request origin
instead:

```ts
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim())

function corsFor(request: Request) {
  const origin = request.headers.get('origin') ?? ''
  return {
    ...(ALLOWED.includes(origin) && { 'Access-Control-Allow-Origin': origin }),
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,authorization',
  }
}
```

`ALLOWED_ORIGINS` then holds the old and new URLs at the same time, and **the custom-domain
cutover becomes an env var edit with no downtime.**

- [ ] Allowlist + `Vary: Origin` on every `/api/*` response
- [ ] An `OPTIONS` handler per route — the batch endpoints are JSON POSTs, so they preflight
- [ ] Never `*` in production

### Skip the shared secret; go straight to the Supabase JWT

BRAIN.md sequences shared-secret now, JWT later. Since neither exists, that is two pieces of
work where one will do — and a static token ends up inlined in the public bundle anyway, so
it proves little.

The brain already holds a Supabase client and a service-role key. Verify the caller's token
server-side and have `geo.js` attach `session.access_token`. Result: **only logged-in users
spend your HERE quota, with nothing secret in the browser.**

- [ ] Verify the Supabase JWT on every `/api/*` route except `/healthz`
- [ ] `geo.js` sends `Authorization: Bearer <session.access_token>`
- [ ] **Also accept a service credential for backend callers.** Schedules' `add_port.py` and ingest have no user session — browser callers present a JWT, server-side scripts present a server-only token (service-role key or shared secret, never in a bundle). Build both when you build the auth
- [ ] Per-IP rate limiting only if abuse appears — it caps damage, it does not authenticate
- [ ] Remember the cache is the real quota defence: only *novel* pairs cost anything upstream

### The two missing endpoints

- [ ] `/api/within-batch` — POST `{ pairs: [{a,b,miles}] }`, results index-aligned with input
- [ ] `/api/route-batch` — POST `{ pairs: [{a,b}] }`, route summaries without polylines
- [ ] Honour the contract `geo.js` already assumes: **per-pair failures, never a whole-batch throw**
- [ ] Stay inside the brain's 60s `maxDuration` — the client already chunks at 30 and 15 for this reason, sequentially, so Nominatim's rate limiter is not multiplied

### Domain — deliberately public, outside Zero Trust

- [ ] **Never put the brain behind Cloudflare Access.** `geo.js` sends no credentials, so Access would return HTML login pages where the code expects JSON — and the failure would not obviously point at Cloudflare
- [ ] A stable subdomain is optional and cosmetic. BRAIN.md is right: *"a custom domain only changes the label of a still-public URL."* The JWT is the protection, not the hostname
- [ ] **Write down that it is intentionally public**, so it never reads as an oversight against the "no `.vercel.app` serves production data" rule

### It shares your Supabase project

The brain holds `SUPABASE_SERVICE_ROLE_KEY` for the same project and writes its geocode and
route cache there.

- [ ] Its cache tables belong in the shared migration history — `geoapi-next/schema.sql` becomes a migration under `supabase/migrations/`
- [ ] Treat it as a **second server-side component with elevated database access**, listed alongside the Edge Functions — not as a frontend dependency

### The exit, if you ever want it

`src/lib/geo.js` is the only place RatesApp knows the brain exists, and its interface already
matches what a Supabase Edge Function would expose. BRAIN.md §9's "Path B" really is a
one-file swap — and it would retire this deployment, its CORS, and its auth entirely, since
an Edge Function sits behind Supabase auth by default.

Not now. Worth knowing the door is there.

---

## Decommissioning

Used whenever an app moves to its new hostname.

**Day 0 — unreachable and inert:** remove the DNS record · disable production deploys ·
Deployment Protection on · strip Supabase env vars · **verify dead from a clean browser** ·
add a row to the decommission register with a delete-after date and an owner.

**Day 14 — delete** the Vercel project and clear the register row. Two weeks is a floor;
extend past one full cycle of whatever the app does.

> Stripping env vars does **not** neutralize a build that already shipped — Vite inlined them.
> Reachability is the control; deletion is what removes the artifact.

---

## Must not be skipped

1. **`.vercel.app` origins blocked** — Access protects the hostname, not the origin behind it
2. **Old deployments unreachable the day they move**, deleted on a dated schedule
3. **Custom SMTP** — invitations and password recovery both depend on it
4. **Isolation tests in CI, across two organizations** — `ptpdesk.com` has no proxy in front of it
5. **Role and organization never come from anything the user can write**
6. **RLS re-derived on every absorbed table** — a table that was safely open in a single-tenant project is readable by every partner in a shared one

---

## Done

- [ ] `ptpworkspace.com` reaches every internal tool with one login
- [ ] `ptpdesk.com` serves both partner audiences, invite-only, MFA enforced
- [ ] No `.vercel.app` URL serves production data; decommission register empty
- [ ] One `organizations` table; no `forwarders`, no `suppliers`, no `profiles.role`
- [ ] Schema reproduces from migrations alone
- [ ] Isolation tests green across two organizations
- [ ] Partners onboarded as named individuals; mock register empty
- [ ] One backup restore rehearsed
