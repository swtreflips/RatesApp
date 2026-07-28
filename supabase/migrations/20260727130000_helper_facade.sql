-- The helper facade — HUB2.md step 4.
--
-- Three functions with the names the FUTURE model will use, backed by the columns that
-- exist TODAY. Every policy written from here on targets these instead of forwarder_id
-- and profiles.role directly.
--
-- The payoff: when the organizations migration lands, only these three BODIES change --
--   my_org()      → select organization_id from profiles ...
--   my_org_type() → select o.type from profiles p join organizations o ...
-- and every policy in every app keeps working, untouched. Without the facade the same
-- migration means rewriting each policy in two applications and re-verifying the RLS you
-- had just finished testing.
--
-- This is also what stops the second RLS idiom from being born. RLS.md currently inlines
-- `exists (select 1 from profiles me where ...)` in every policy; two idioms in one
-- database means every identity change is edited twice, in two styles.
--
-- Mirrors the shape of the existing my_forwarder() / current_role_is(): stable,
-- security definer, search_path pinned. Those two stay for now and are dropped in
-- HUB2's contract phase, once policies have moved across.
--
-- TWO RULES for anything written against these:
--   1. my_org() returns NULL for internal users today (they have no forwarder_id).
--      Isolation policies must FAIL CLOSED on null -- `organization_id = my_org()` is
--      null-safe by accident, but `coalesce`-ing it to a default would not be.
--   2. "internal sees everything" is ALWAYS my_org_type() = 'internal', NEVER a my_org()
--      comparison.

-- Backing column for my_org_role(), added FIRST: a LANGUAGE sql function body is parsed
-- and its references resolved at creation time, so my_org_role() cannot be created before
-- the column it selects exists.
--
-- Added before the planner's backend exists so its schema can be written against the
-- finished shape. RatesApp ignores it.
alter table public.profiles
  add column if not exists org_role text not null default 'member';

do $$
begin
  alter table public.profiles
    add constraint profiles_org_role_check check (org_role in ('admin', 'member'));
exception
  when duplicate_object then null;
end
$$;

-- Whose data is this. Today: the forwarder. After organizations: the organization.
-- NULL for internal users, and for any caller with no profile row at all.
create or replace function public.my_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select forwarder_id from profiles where id = auth.uid();
$$;

-- What kind of party the caller belongs to.
--
-- NOTE: HUB2 drafts this as `case when role = 'internal' then 'internal' else 'forwarder' end`.
-- Reading the column directly is equivalent today -- profiles.role is NOT NULL with
-- CHECK (role IN ('internal','forwarder')) -- and strictly better later: when
-- organizations introduces type='customer', the CASE would mis-map it to 'forwarder'
-- while this returns it correctly.
--
-- Returns NULL when there is no profile row: no row, no type, no access.
create or replace function public.my_org_type()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

-- The caller's standing WITHIN their organization -- orthogonal to which organization it
-- is. RatesApp does not use this yet; Stuffer Planner needs it on day one, where
-- admin/member is what separates a factory's manager from its staff.
create or replace function public.my_org_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(org_role, 'member') from profiles where id = auth.uid();
$$;

comment on function public.my_org() is
  'Whose data this is. NULL for internal users and for callers with no profile. Policies must fail closed on NULL.';
comment on function public.my_org_type() is
  'internal | forwarder (later: customer). NULL when there is no profile row. Use this for "internal sees everything", never my_org().';
comment on function public.my_org_role() is
  'admin | member within the caller''s own organization. Orthogonal to my_org_type().';
