-- Schedules security, re-derived for this project's blast radius. MIGRATION.md Phase 3.
--
-- At source these tables sat alone in a project only internal people held keys to, so RLS
-- off cost nothing: THE PROJECT WAS THE BOUNDARY. Here that boundary moves down to the
-- TABLE, because `authenticated` now includes forwarders and the anon key ships in every
-- RatesApp bundle. Nothing is carried across unexamined.
--
-- TWO LAYERS, both required. Phase 2 revoked every grant, which denies internal users too
-- -- RLS NARROWS a grant, it cannot create one. So:
--   1. GRANT SELECT to `authenticated`  → the role may read the table at all
--   2. POLICY my_org_type() = 'internal' → ...but only if the caller is internal
-- Miss layer 1 and internal users get nothing. Miss layer 2 and every forwarder reads the
-- warehouse.
--
-- `anon` is granted NOTHING here. The Schedules app gets a Supabase login (MIGRATION.md
-- decision 1), so its callers are `authenticated`, never `anon`.
--
-- Writes stay absent by design: ingest and the scrapers hold the service key, which
-- bypasses RLS entirely. No client ever writes these tables.

-- ── base tables ──────────────────────────────────────────────────────────────
grant select on public.schedules  to authenticated;
grant select on public.ports      to authenticated;
grant select on public.vessels    to authenticated;
grant select on public.sea_routes to authenticated;

-- "Internal sees everything" is ALWAYS my_org_type() = 'internal', never a my_org()
-- comparison -- my_org() is NULL for internal users, so a comparison would deny them.
-- The function returns NULL for a caller with no profile row, and NULL is not 'internal',
-- so this fails closed on its own.
create policy schedules_internal_read  on public.schedules
  for select to authenticated using (my_org_type() = 'internal');

create policy ports_internal_read      on public.ports
  for select to authenticated using (my_org_type() = 'internal');

create policy vessels_internal_read    on public.vessels
  for select to authenticated using (my_org_type() = 'internal');

create policy sea_routes_internal_read on public.sea_routes
  for select to authenticated using (my_org_type() = 'internal');

-- ── the materialized view — the real gotcha ──────────────────────────────────
-- Postgres REFUSES a policy on a materialized view, so grants are the only thing that can
-- guard schedules_latest, and grants cannot express "internal". Phase 2 locked it. Expose
-- it through a plain view instead.
--
-- A plain view runs with its OWNER's rights (security_invoker is off by default, and must
-- stay off here) so it can read the locked MV -- while the WHERE clause evaluates the
-- CALLER's my_org_type(). Internal sees rows; everyone else sees zero.
--
-- A view rather than a SECURITY DEFINER function on purpose: the app keeps every PostgREST
-- .eq() filter and sort, which an RPC would cost.
create or replace view public.schedules_latest_secure as
  select * from public.schedules_latest
   where my_org_type() = 'internal';

grant select on public.schedules_latest_secure to authenticated;

-- ── repoint the RPCs at the guarded view ─────────────────────────────────────
-- Both are SECURITY INVOKER (confirmed by introspection -- MIGRATION.md originally claimed
-- otherwise). Reading the locked MV as the caller would raise `permission denied` rather
-- than returning zero rows, which is a worse failure: it leaks that the object exists and
-- it surfaces as a 500 instead of an empty result.
--
-- The return type stays `setof schedules_latest` -- that names a row SHAPE and needs no
-- privilege on the MV. Only the body's SELECT does.
create or replace function public.nearby_schedules(
  p_pol text, p_lat double precision, p_lon double precision, p_radius_meters double precision)
returns setof public.schedules_latest
language sql
stable
set search_path = public
as $$
  select s.*
    from schedules_latest_secure s
   where s.port_of_loading = p_pol
     and s.last_cy_geom is not null
     and st_dwithin(s.last_cy_geom,
                    st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
                    p_radius_meters)
   order by s.eta asc;
$$;

create or replace function public.distinct_pols()
returns setof text
language sql
stable
set search_path = public
as $$
  select distinct port_of_loading
    from schedules_latest_secure
   where port_of_loading is not null
   order by 1;
$$;

-- nearest_ports and is_near read `ports`, which now has RLS. Both are INVOKER, so they
-- inherit the caller's visibility automatically -- a forwarder gets zero rows, not an
-- error. No change needed to either.

grant execute on function public.nearby_schedules(text, double precision, double precision, double precision) to authenticated;
grant execute on function public.distinct_pols() to authenticated;
grant execute on function public.nearest_ports(double precision, double precision, integer, text[]) to authenticated;
grant execute on function public.is_near(double precision, double precision, text, double precision) to authenticated;

-- ── deny anon at the grant layer too ─────────────────────────────────────────
-- Supabase ships ALTER DEFAULT PRIVILEGES granting new tables, views and functions to
-- `anon` automatically. So without these revokes the view and RPCs above are reachable by
-- anon -- they return zero rows only because my_org_type() is NULL for a caller with no
-- profile.
--
-- That predicate is doing real work and would hold on its own. Revoking anyway: a boundary
-- enforced at one layer becomes a boundary enforced at zero the day someone edits the
-- predicate. Denied at the grant, and denied again by the policy.
revoke all on public.schedules_latest_secure from anon;
revoke execute on function public.nearby_schedules(text, double precision, double precision, double precision) from anon;
revoke execute on function public.distinct_pols() from anon;
revoke execute on function public.nearest_ports(double precision, double precision, integer, text[]) from anon;
revoke execute on function public.is_near(double precision, double precision, text, double precision) from anon;
