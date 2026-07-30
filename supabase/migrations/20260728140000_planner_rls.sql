-- Stuffer Planner security. STUFFER.md "Security".
--
-- THE INVARIANT
--   Every planner row carries one organization_id. A factory only ever sees or writes rows
--   where organization_id in (select my_orgs()). Internal sees everything. Enforced by RLS, not the UI.
--
-- SETTLED WITH THE OWNER:
--   * A factory CAN create draft containers and allocate into them. A factory that cannot
--     build a draft cannot do the job the app exists for.
--   * Only internal COMMITS. Only an internal admin UNCOMMITS.
--   * A factory NEVER sees another factory's containers or PO lines. They are direct
--     competitors — this is the strongest requirement in the file, not a preference.
--
-- Two layers, both required. RLS NARROWS a grant; it cannot create one. Miss the grant and
-- internal users see an empty board that looks like missing data rather than a permissions bug.

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants. `authenticated` only — anon gets nothing, anywhere.
-- No DELETE on po_lines: the internal push upserts, it never removes.
-- ─────────────────────────────────────────────────────────────────────────────
grant select, insert, update on public.planner_po_lines            to authenticated;
grant select                 on public.planner_po_line_events      to authenticated;
grant select, insert, update, delete on public.planner_containers  to authenticated;
grant select, insert, update, delete on public.planner_allocations to authenticated;
grant select                 on public.planner_import_batches      to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_po_lines
-- ─────────────────────────────────────────────────────────────────────────────
-- "Internal sees everything" is ALWAYS my_org_type() = 'internal', never an organization
-- comparison: my_org() is now non-null for internal users too, so comparing it would scope
-- them to PTP's own rows and hide every supplier line.
--
-- Scoping uses `in (select my_orgs())` rather than `= my_org()` so that sibling companies run
-- by the same team are included. For an ungrouped organization my_orgs() returns exactly one
-- row, so this is identical to the equality it replaces.
create policy planner_po_lines_read on public.planner_po_lines
  for select to authenticated
  using (my_org_type() = 'internal' or organization_id in (select my_orgs()));

-- Only internal inserts PO lines. Factories never create demand, they answer it.
create policy planner_po_lines_internal_insert on public.planner_po_lines
  for insert to authenticated
  with check (my_org_type() = 'internal');

-- Factories update their own lines; internal updates any. WHICH COLUMNS a factory may touch
-- is enforced by the trigger below — RLS cannot express column-level rules.
create policy planner_po_lines_update on public.planner_po_lines
  for update to authenticated
  using      (my_org_type() = 'internal' or organization_id in (select my_orgs()))
  with check (my_org_type() = 'internal' or organization_id in (select my_orgs()));

-- ─────────────────────────────────────────────────────────────────────────────
-- The column guard. RLS grants access to ROWS, not columns; without this a factory could
-- rewrite quantities, destinations or committed_quantity on its own lines.
--
-- Internal may write the factory-owned fields too — a deliberate MVP relaxation of
-- CLAUDE.md's matrix, so internal can fill in cargo ready dates on a factory's behalf while
-- the process beds in.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_guard_po_line_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role and internal are unrestricted. auth.uid() is null for service_role.
  if auth.uid() is null or my_org_type() = 'internal' then
    return new;
  end if;

  if new.document_number    is distinct from old.document_number
  or new.sku                is distinct from old.sku
  or new.internal_id        is distinct from old.internal_id
  or new.organization_id    is distinct from old.organization_id
  or new.quantity           is distinct from old.quantity
  or new.quantity_available is distinct from old.quantity_available
  or new.due_date           is distinct from old.due_date
  or new.origin             is distinct from old.origin
  or new.pol                is distinct from old.pol
  or new.destination        is distinct from old.destination
  or new.committed_quantity is distinct from old.committed_quantity
  or new.raw                is distinct from old.raw
  then
    raise exception
      'a supplier may only change cargo_ready, cbm_per_case and cbm_total on a PO line';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_planner_guard_po_line_columns on public.planner_po_lines;
create trigger trg_planner_guard_po_line_columns
  before update on public.planner_po_lines
  for each row execute function public.planner_guard_po_line_columns();

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_containers.  Factories: full DRAFT CRUD within their own organization, never a
-- committed container, never another organization's.
-- ─────────────────────────────────────────────────────────────────────────────
create policy planner_containers_read on public.planner_containers
  for select to authenticated
  using (my_org_type() = 'internal' or organization_id in (select my_orgs()));

create policy planner_containers_insert on public.planner_containers
  for insert to authenticated
  with check (
    (my_org_type() = 'internal')
    or (organization_id in (select my_orgs()) and status = 'draft' and committed_at is null)
  );

-- A factory may edit a draft and may not turn it into a committed one. Commit goes through
-- the RPC, which is the only place that writes status='committed'.
create policy planner_containers_update on public.planner_containers
  for update to authenticated
  using      (my_org_type() = 'internal' or (organization_id in (select my_orgs()) and status = 'draft'))
  with check (my_org_type() = 'internal' or (organization_id in (select my_orgs()) and status = 'draft'));

create policy planner_containers_delete on public.planner_containers
  for delete to authenticated
  using (my_org_type() = 'internal' or (organization_id in (select my_orgs()) and status = 'draft'));

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_allocations.  Scoped THROUGH the container rather than by a denormalised column:
-- one owner of the truth, and no second place to drift.
--
-- The WITH CHECK also verifies the PO LINE belongs to the same organization — otherwise a
-- factory could allocate a competitor's PO line into its own container and read the
-- quantity back out. That is the subtle leak this table invites.
-- ─────────────────────────────────────────────────────────────────────────────
create policy planner_allocations_read on public.planner_allocations
  for select to authenticated
  using (exists (
    select 1 from public.planner_containers c
     where c.id = container_id
       and (my_org_type() = 'internal' or c.organization_id in (select my_orgs()))
  ));

create policy planner_allocations_write on public.planner_allocations
  for all to authenticated
  using (exists (
    select 1 from public.planner_containers c
     where c.id = container_id
       and (my_org_type() = 'internal' or (c.organization_id in (select my_orgs()) and c.status = 'draft'))
  ))
  with check (
    exists (
      select 1 from public.planner_containers c
       where c.id = container_id
         and (my_org_type() = 'internal' or (c.organization_id in (select my_orgs()) and c.status = 'draft'))
    )
    and exists (
      select 1 from public.planner_po_lines l
       where l.id = po_line_id
         and (my_org_type() = 'internal' or l.organization_id in (select my_orgs()))
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_po_line_events — readable, never writable. Insert only via the logging trigger,
-- which is SECURITY DEFINER. History nobody can write by hand is history you can trust.
-- ─────────────────────────────────────────────────────────────────────────────
create policy planner_events_read on public.planner_po_line_events
  for select to authenticated
  using (my_org_type() = 'internal' or organization_id in (select my_orgs()));

create policy planner_import_batches_read on public.planner_import_batches
  for select to authenticated
  using (my_org_type() = 'internal');

-- ─────────────────────────────────────────────────────────────────────────────
-- THE VIEWS — security_invoker is the whole point here.
--
-- A Postgres view runs with its OWNER's rights by default, which would make these three
-- BYPASS RLS entirely: a factory querying planner_cbm_reference would see every other
-- factory's measurements. Given factories are direct competitors, that is the exact leak
-- this migration exists to prevent.
--
-- security_invoker = true makes the base-table policies apply to the CALLER instead.
--
-- Note this is the OPPOSITE choice from schedules_latest_secure, where owner rights are
-- deliberate — that view has to read a materialized view no caller may touch, and does its
-- own filtering in the WHERE. Same mechanism, opposite intent; know which you want.
-- ─────────────────────────────────────────────────────────────────────────────
alter view public.planner_cbm_observations set (security_invoker = true);
alter view public.planner_cbm_reference    set (security_invoker = true);
alter view public.planner_crd_movements    set (security_invoker = true);

grant select on public.planner_cbm_observations to authenticated;
grant select on public.planner_cbm_reference    to authenticated;
grant select on public.planner_crd_movements    to authenticated;

revoke all on public.planner_cbm_observations from anon;
revoke all on public.planner_cbm_reference    from anon;
revoke all on public.planner_crd_movements    from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs. SECURITY DEFINER with search_path pinned — that combination without the pin is a
-- privilege-escalation shape.
-- ─────────────────────────────────────────────────────────────────────────────

-- <ORG><NNNN>, atomic. Runs as definer so a factory can mint a code without write access
-- to the counter table.
create or replace function public.next_container_code(p_org_code text)
returns text language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into planner_sequences (org_code, next_number) values (p_org_code, 2)
  on conflict (org_code) do update set next_number = planner_sequences.next_number + 1
  returning next_number - 1 into n;
  return p_org_code || lpad(n::text, 4, '0');
end;
$$;

-- Only internal commits.
create or replace function public.commit_container(p_container_id uuid, p_ofq_reference text)
returns public.planner_containers
language plpgsql security definer set search_path = public as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may commit a container';
  end if;

  update planner_containers
     set status = 'committed', ofq_reference = p_ofq_reference,
         committed_at = now(), committed_by = auth.uid(),
         logistics_status = 'committed'
   where id = p_container_id and status = 'draft'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not a draft, or does not exist', p_container_id;
  end if;
  return c;
end;
$$;

-- Only an internal ADMIN uncommits. Deliberately narrower than commit: undoing one means an
-- OFQ already exists downstream.
create or replace function public.uncommit_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path = public as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' or my_org_role() is distinct from 'admin' then
    raise exception 'only an internal admin may uncommit a container';
  end if;

  update planner_containers
     set status = 'draft', ofq_reference = null,
         committed_at = null, committed_by = null,
         logistics_status = null, booking = null, schedule = null,
         booked_at = null, booked_by = null,
         scheduled_at = null, scheduled_by = null,
         shipped_at = null, shipped_by = null
   where id = p_container_id and status = 'committed'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not committed, or does not exist', p_container_id;
  end if;
  return c;
end;
$$;

grant execute on function public.next_container_code(text)          to authenticated;
grant execute on function public.commit_container(uuid, text)       to authenticated;
grant execute on function public.uncommit_container(uuid)           to authenticated;

revoke execute on function public.next_container_code(text)    from anon;
revoke execute on function public.commit_container(uuid, text) from anon;
revoke execute on function public.uncommit_container(uuid)     from anon;
