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
                          The only place server-side code runs, and the only
                          thing the apps actually share.
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

**And it is decoupled — the planner does not wait for RatesApp.** Expand is additive: create
`organizations` carrying the existing `forwarders.id` values, add a nullable
`profiles.organization_id` beside `forwarder_id`, backfill. RatesApp does not change a line.
Whoever touches the database first runs it.

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
| 2 | **Vite SPA everywhere, never Next** | No SSR need — every route is behind a login. Consequence: **the frontend holds only public values; every secret lives in a Supabase Edge Function** |
| 3 | **`organizations`, not `forwarders`/`suppliers`** | Two apps invented the same concept twice. One table, `type = internal \| forwarder \| customer` |
| 4 | **One Supabase project per environment** | Production + Development. One `auth.users`, one organization directory, one onboarding — the apps stay standalone, but the *people* are the same |
| 5 | **Identity comes from `profiles`, never `user_metadata`** | `user_metadata` is user-writable. Client and RLS read the same row |
| 6 | **Retire by unreachability, then delete** | A Vite build inlines its env vars, so stripping keys does not neutralize a deployment that already shipped. Only unreachability does |

Each was argued out and settled. Reverse one only deliberately.

---

## Sequence

### Now — while the apps stay separate

Cheap habits that stop later phases from growing. Nothing else in this file applies yet.

- [ ] **Baseline the schema** — `supabase db pull`, commit it. Every hand-run change from here is drift someone has to reconstruct
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

### Phase B — Database foundations

- [ ] **CI exists** — no `.github/` and no test runner today. GitHub Actions + Vitest. Five items in this plan assume CI
- [ ] Secret scanning in CI
- [ ] Baseline verified: `supabase db reset` reproduces production, RLS policies and generated columns intact
- [ ] Consolidate `schedules` into the rates project → the freed slot becomes **Development**
- [ ] **Organizations migration** — expand, migrate, contract (below), rehearsed on Development
- [ ] `pg_dump` daily backup job (GitHub Action → private storage)
- [ ] Drift check in CI — `supabase db diff --linked`, non-empty output fails

**Gate:** the schema reproduces from migrations alone; tenancy is `organization_id` everywhere.

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

**The planner does not have to wait for this.** Expand is additive — create `organizations`
carrying the existing `forwarders.id` values, add a nullable `profiles.organization_id`
beside `forwarder_id`, backfill. RatesApp keeps reading `forwarder_id` and does not change a
line. Whoever touches the database first runs expand; nothing blocks anything.

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
