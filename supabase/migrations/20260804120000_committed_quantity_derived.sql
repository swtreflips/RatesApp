-- committed_quantity stops being a number the client accumulates.
--
-- THE BUG. It was maintained by the browser applying deltas: +250 when a container was
-- committed, -250 when it was uncommitted, each a read-then-write with no transaction around it.
-- Every delta had to fire exactly once, in order, and never interleave with another. They did
-- not. Three PO lines were found holding 349 cases committed against ZERO containers — one at
-- 149 of a 150 that had been reversed, which is the signature of a partially applied delta.
--
-- Worse, deleting a committed container applied no reversal at all: the container and its
-- allocations went, and their cases stayed marked committed forever with nothing pointing at
-- them.
--
-- WHY IT WENT UNNOTICED. `availableQty` is `quantity_available − committed_quantity − drafts`,
-- and the grid hides a line once committed_quantity reaches the quantity. So a line that drifted
-- all the way up simply disappeared. The failure erased its own evidence.
--
-- THE FIX. committed_quantity is DERIVED. It is, by definition:
--
--     Σ planner_allocations.quantity  where the container is status = 'committed'
--
-- Triggers compute that. The client no longer maintains it — and could not corrupt it if it
-- tried, because every path that could change the answer recomputes the answer.
--
-- The client-side reconcile in plannerStore.reconcileCommitted() does the same sum and stays as
-- the belt to this braces; both are idempotent, so they cannot fight. It also repairs older
-- damage on a database where this migration has not yet been applied.

create or replace function public.planner_recalc_committed(p_line_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_line_ids is null or cardinality(p_line_ids) = 0 then
    return;
  end if;

  /*
    The `is distinct from` guard is not an optimisation, it is what keeps this compatible with
    the column guard. planner_guard_po_line_columns raises if a FACTORY changes
    committed_quantity — and a factory editing their own draft allocations fires this trigger.
    Their drafts never count toward the total, so the recomputed value equals the stored one and
    no UPDATE is issued at all. Without the guard, every supplier allocation would raise.
  */
  update planner_po_lines l
     set committed_quantity = t.total
    from (
      select x.id,
             coalesce((
               select sum(a.quantity)
                 from planner_allocations a
                 join planner_containers c on c.id = a.container_id
                where a.po_line_id = x.id
                  and c.status = 'committed'
             ), 0) as total
        from planner_po_lines x
       where x.id = any(p_line_ids)
    ) t
   where l.id = t.id
     and l.committed_quantity is distinct from t.total;
end;
$$;

comment on function public.planner_recalc_committed(uuid[]) is
  'PLANNER | recomputes planner_po_lines.committed_quantity as the sum of allocations in COMMITTED containers. Called by triggers only — the value is derived, never accumulated';

-- ─────────────────────────────────────────────────────────────────────────────
-- Allocations: any change to who holds how much can move the total.
--
-- A container DELETE cascades to its allocations, so this trigger is also what makes deleting a
-- committed container give its cases back — the case the client never handled.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_allocations_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform planner_recalc_committed(
    array_remove(array[
      case when tg_op <> 'INSERT' then old.po_line_id end,
      case when tg_op <> 'DELETE' then new.po_line_id end
    ], null)
  );
  return null;   -- AFTER trigger; the return value is ignored
end;
$$;

drop trigger if exists trg_planner_allocations_recalc on public.planner_allocations;
create trigger trg_planner_allocations_recalc
  after insert or update or delete on public.planner_allocations
  for each row execute function public.planner_allocations_recalc();

-- ─────────────────────────────────────────────────────────────────────────────
-- Containers: committing or uncommitting moves every line inside at once, without any
-- allocation row changing.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_containers_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform planner_recalc_committed(
    (select array_agg(distinct po_line_id)
       from planner_allocations
      where container_id = new.id)
  );
  return null;
end;
$$;

drop trigger if exists trg_planner_containers_recalc on public.planner_containers;
create trigger trg_planner_containers_recalc
  after update of status on public.planner_containers
  for each row when (old.status is distinct from new.status)
  execute function public.planner_containers_recalc();

-- ─────────────────────────────────────────────────────────────────────────────
-- Repair whatever has already drifted.
--
-- Runs over every line rather than a known-bad list: the three found by hand are the ones that
-- happened to be visible, and the same mechanism has been live for as long as commit has.
-- ─────────────────────────────────────────────────────────────────────────────
select public.planner_recalc_committed(array_agg(id)) from public.planner_po_lines;

comment on column public.planner_po_lines.committed_quantity is
  'DERIVED: the sum of allocations in committed containers, maintained by trigger. Never write this directly — see 20260804120000';
