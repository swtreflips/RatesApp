-- profiles.role may say 'supplier'.
--
-- The check allowed only 'internal' | 'forwarder', which predates organizations existing. So a
-- factory user had to be stored as role='forwarder' — a workaround that is wrong on its face
-- and, worse, invisible: nothing breaks, the row just lies about what the person is.
--
-- Widened rather than dropped. `role` is now redundant — my_org_type() reads
-- organizations.type, and every policy uses that — but dropping a column three apps might
-- still SELECT is HUB2's contract phase, not this migration. Expand adds, contract removes,
-- and they are deliberately far apart.
--
-- Run this BEFORE creating factory profiles, or the first ones written carry the workaround
-- and someone has to remember to correct them later.

alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('internal', 'forwarder', 'supplier'));

-- Any row already carrying the workaround: a profile whose organization is a supplier but
-- whose role still says forwarder. Idempotent, and a no-op on a clean database.
update public.profiles p
   set role = 'supplier'
  from public.organizations o
 where o.id = p.organization_id
   and o.type = 'supplier'
   and p.role <> 'supplier';

comment on column public.profiles.role is
  'internal | forwarder | supplier. REDUNDANT with organizations.type, which my_org_type() reads and every policy uses. Kept until HUB2''s contract phase; do not write new logic against it.';
