-- Weekly ERP snapshot sync — the functions.
--
-- THREE functions, and the split is the point:
--
--   planner_po_line_diff()   decides WHAT CHANGES. Touches no permanent table.
--   planner_sync_preview()   summarises the diff for the confirm screen.
--   sync_po_lines()          applies the diff, logs it, returns the same shape as the preview.
--
-- Preview and apply therefore share ONE definition of what changes and cannot drift, which is
-- the only thing that makes a preview worth trusting. A p_dry_run flag would not achieve this:
-- a Postgres function cannot roll back its own transaction, so the preview has to BE the
-- read-only half rather than a discarded write.
--
-- The diff returns the INCOMING VALUES as well as the verdict, so the apply never has to re-read
-- the caller's JSON. Everything the writer needs is in the row it is acting on.
--
-- THE API TRANSITION IS A ONE-LINER. When NetSuite is wired directly, an Edge Function calls
-- sync_po_lines(rows_from_netsuite, 'api', false) with the service key. Same function, same
-- guards, same audit trail — only where the rows came from changes. That is the whole reason the
-- reconcile lives in the database instead of in the upload dialog.
--
-- Expected shape of p_rows — an array of objects, already normalised by the caller:
--
--   [{ "internal_id": "6907937", "document_number": "PO154830", "sku": "RDPT-NK10513L",
--      "supplier": "Manchester Paper Bags LLC", "quantity": 1550, "quantity_available": 1550,
--      "due_date": "2025-11-28", "origin": "United Arab Emirates",
--      "pol": "Jebel Ali, United Arab Emirates", "destination": "Dayton, NJ",
--      "raw": { ...every unmapped column... } }]

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_po_line_diff — what would change, and nothing else
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_po_line_diff(p_rows jsonb)
returns table (
  action                 text,     -- insert | update | close | reopen | unchanged
  po_line_id             uuid,
  organization_id        uuid,
  supplier               text,
  document_number        text,
  sku                    text,
  -- incoming, carried through so the apply never re-parses p_rows
  new_internal_id        text,
  new_quantity           numeric,
  new_quantity_available numeric,
  new_due_date           date,
  new_origin             text,
  new_pol                text,
  new_destination        text,
  new_raw                jsonb,
  -- current, for the preview's before → after
  old_quantity           numeric,
  old_quantity_available numeric,
  old_due_date           date,
  old_destination        text,
  inferred_reason        text,
  allocated_quantity     numeric,
  conflict               text      -- null | closed_while_allocated | over_committed | supplier_changed
)
language plpgsql
volatile                            -- builds a temp table; claiming stable would be a lie
security definer
set search_path = public
as $$
declare
  bad_suppliers text;
  dup_keys      text;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'the snapshot must be a JSON array of rows';
  end if;

  if jsonb_array_length(p_rows) = 0 then
    raise exception 'the snapshot is empty — refusing to close every open line';
  end if;

  -- Re-entrant: preview and apply may both run on one pooled connection.
  drop table if exists _incoming;
  create temp table _incoming on commit drop as
  select
    nullif(btrim(r->>'internal_id'),'')          as internal_id,
    btrim(r->>'document_number')                 as document_number,
    btrim(r->>'sku')                             as sku,
    btrim(r->>'supplier')                        as supplier,
    nullif(r->>'quantity','')::numeric           as quantity,
    nullif(r->>'quantity_available','')::numeric as quantity_available,
    nullif(r->>'due_date','')::date              as due_date,
    nullif(btrim(r->>'origin'),'')               as origin,
    nullif(btrim(r->>'pol'),'')                  as pol,
    nullif(btrim(r->>'destination'),'')          as destination,
    coalesce(r->'raw', '{}'::jsonb)              as raw
  from jsonb_array_elements(p_rows) as r;

  /*
    A duplicate key inside the FILE is fatal, not something to resolve by picking a winner.
    (document_number, sku) is the natural key the table is built on; two rows claiming it means
    the export is not what this sync assumes it is, and an arbitrary winner would silently
    discard real quantity.
  */
  select string_agg(d.document_number || ' · ' || d.sku, ', ')
    into dup_keys
    from (
      select i.document_number, i.sku
        from _incoming i
       group by i.document_number, i.sku
      having count(*) > 1
       limit 10
    ) d;

  if dup_keys is not null then
    raise exception 'the file repeats (document number, item): %. Each PO line must appear once', dup_keys;
  end if;

  /*
    An unresolved vendor name ABORTS the whole batch rather than skipping its rows.

    Skipping looks kinder and is far worse: the skipped supplier would then be absent from the
    file as far as close-detection is concerned, and every open line they own would close. A
    vendor renamed in NetSuite would silently wipe a factory off the board.
  */
  select string_agg(distinct i.supplier, ', ')
    into bad_suppliers
    from _incoming i
    left join organizations o
      on o.name = i.supplier and o.type = 'supplier'
   where o.id is null;

  if bad_suppliers is not null then
    raise exception
      'these supplier names do not match any organization: %. Fix organizations.name or the export, then re-upload',
      bad_suppliers;
  end if;

  return query
  with resolved as (
    select i.*, o.id as org_id
      from _incoming i
      join organizations o on o.name = i.supplier and o.type = 'supplier'
  ),
  -- ONLY suppliers present in the file are candidates for closing. A supplier missing entirely
  -- is far more likely a filter left on the export than every one of their POs completing at
  -- once, and closing them all would be unrecoverable without this line.
  file_orgs as (
    select distinct org_id from resolved
  ),
  allocated as (
    select a.po_line_id, sum(a.quantity) as qty
      from planner_allocations a
     group by a.po_line_id
  ),
  matched as (
    select
      r.*,
      l.id                 as line_id,
      l.status             as old_status,
      l.quantity           as cur_quantity,
      l.quantity_available as cur_quantity_available,
      l.due_date           as cur_due_date,
      l.destination        as cur_destination,
      l.origin             as cur_origin,
      l.pol                as cur_pol,
      l.internal_id        as cur_internal_id,
      l.raw                as cur_raw,
      l.organization_id    as cur_org,
      l.committed_quantity as cur_committed,
      coalesce(al.qty, 0)  as alloc_qty
    from resolved r
    left join planner_po_lines l
      on l.document_number = r.document_number and l.sku = r.sku
    left join allocated al on al.po_line_id = l.id
  )
  -- in the file
  select
    case
      when m.line_id is null       then 'insert'
      when m.old_status = 'closed' then 'reopen'
      when m.cur_quantity           is distinct from m.quantity
        or m.cur_quantity_available is distinct from m.quantity_available
        or m.cur_due_date           is distinct from m.due_date
        or m.cur_destination        is distinct from m.destination
        or m.cur_origin             is distinct from m.origin
        or m.cur_pol                is distinct from m.pol
        or m.cur_internal_id        is distinct from m.internal_id
        or m.cur_org                is distinct from m.org_id
        or m.cur_raw                is distinct from m.raw    then 'update'
      else 'unchanged'
    end,
    m.line_id, m.org_id, m.supplier, m.document_number, m.sku,
    m.internal_id, m.quantity, m.quantity_available, m.due_date,
    m.origin, m.pol, m.destination, m.raw,
    m.cur_quantity, m.cur_quantity_available, m.cur_due_date, m.cur_destination,
    null::text,
    m.alloc_qty,
    case
      -- A supplier change on an allocated line would strand the allocation in a container
      -- belonging to the previous organization, which RLS would then refuse to show anyone.
      when m.line_id is not null and m.cur_org is distinct from m.org_id
                                 and m.alloc_qty > 0                        then 'supplier_changed'
      when coalesce(m.cur_committed, 0) > coalesce(m.quantity, 0)           then 'over_committed'
      else null
    end
  from matched m

  union all

  -- in the table, not in the file
  select
    'close',
    l.id, l.organization_id, o.name, l.document_number, l.sku,
    null::text, null::numeric, null::numeric, null::date,
    null::text, null::text, null::text, null::jsonb,
    l.quantity, l.quantity_available, l.due_date, l.destination,
    /*
      THE INFERENCE. A guess, and it lands in a column that says so.

      The feed never states why a line left, and a withdrawn (mis-entered, deleted upstream) line
      is indistinguishable from a cancellation by its final numbers alone — both vanish with
      quantity still available. snapshots_seen is the one discriminator available: a line that
      appeared in a single export and never moved a case is a correction, not a decision.
    */
    case
      when coalesce(l.quantity_available, 0) = 0                       then 'fulfilled'
      when coalesce(l.quantity, 0) > coalesce(l.quantity_available, 0) then 'cancelled'
      when l.snapshots_seen = 1
       and coalesce(l.quantity, 0) = coalesce(l.quantity_available, 0) then 'withdrawn'
      else 'unknown'
    end,
    coalesce(al.qty, 0),
    case when coalesce(al.qty, 0) > 0 then 'closed_while_allocated' else null end
  from planner_po_lines l
  join organizations o on o.id = l.organization_id
  left join allocated al on al.po_line_id = l.id
  where l.status = 'open'
    and l.organization_id in (select org_id from file_orgs)
    and not exists (
      select 1 from resolved r
       where r.document_number = l.document_number and r.sku = l.sku
    );
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_sync_summary — the shape both the preview and the apply return
--
-- Private helper, and the ONE piece of implicit coupling here: it reads a temp table named
-- _diff that its caller must have materialised. Kept private and revoked from every client role
-- precisely because of that — it is not callable except by the two functions below.
--
-- plpgsql + EXECUTE rather than `language sql`, and not by preference: a SQL-bodied function is
-- parsed when it is CREATED, and _diff does not exist then. The body has to stay a string until
-- a caller has materialised the table.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_sync_summary()
returns jsonb
language plpgsql
volatile
set search_path = public
as $fn$
declare
  result jsonb;
begin
  execute $q$
  with counts as (
    select
      count(*) filter (where action = 'insert')    as inserted,
      count(*) filter (where action = 'update')    as updated,
      count(*) filter (where action = 'close')     as closed,
      count(*) filter (where action = 'reopen')    as reopened,
      count(*) filter (where action = 'unchanged') as unchanged,
      count(*) filter (where action <> 'close')    as in_file
    from _diff
  ),
  -- The denominator is open lines belonging to suppliers the file actually carries, which is the
  -- same set close-detection ran against.
  exposure as (
    select count(*) as open_lines
      from planner_po_lines l
     where l.status = 'open'
       and l.organization_id in (select distinct organization_id from _diff)
  ),
  reasons as (
    select jsonb_object_agg(inferred_reason, n) as by_reason
      from (select inferred_reason, count(*) n from _diff
             where action = 'close' group by inferred_reason) r
  ),
  conflicts as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'conflict',        conflict,
             'document_number', document_number,
             'sku',             sku,
             'supplier',        supplier,
             'allocated',       allocated_quantity
           ) order by conflict, document_number), '[]'::jsonb) as items
      from _diff where conflict is not null
  )
  select jsonb_build_object(
    'inserted',  c.inserted,
    'updated',   c.updated,
    'closed',    c.closed,
    'reopened',  c.reopened,
    'unchanged', c.unchanged,
    'rows_in_file', c.in_file,
    'closed_by_reason', coalesce(r.by_reason, '{}'::jsonb),
    'conflicts', f.items,
    'open_lines_in_scope', e.open_lines,
    -- Trips on a truncated download, a partly-filtered export, or the wrong file entirely.
    -- The floor of 5 keeps small, legitimate weeks from being blocked by a percentage.
    'blast_radius_exceeded',
      c.closed > greatest(5, ceil(0.25 * e.open_lines))
  )
  from counts c, exposure e, reasons r, conflicts f
  $q$ into result;

  return result;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_sync_preview — read-only against permanent tables, safe to call repeatedly
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_sync_preview(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if auth.uid() is not null and my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may sync PO lines';
  end if;

  drop table if exists _diff;
  create temp table _diff on commit drop as
  select * from planner_po_line_diff(p_rows);

  select planner_sync_summary() into result;

  -- The preview REPORTS the blast radius rather than refusing on it. Refusing to even show you
  -- what a suspicious file would do is how someone ends up guessing.
  return result || jsonb_build_object('dry_run', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- sync_po_lines — the one that writes
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sync_po_lines(
  p_rows   jsonb,
  p_source text    default 'csv',
  p_force  boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  result   jsonb;
  batch_id uuid;
begin
  -- auth.uid() is null for service_role, which is how the future Edge Function gets in.
  if auth.uid() is not null and my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may sync PO lines';
  end if;

  perform set_config('planner.source', coalesce(p_source, 'csv'), true);

  drop table if exists _diff;
  create temp table _diff on commit drop as
  select * from planner_po_line_diff(p_rows);

  select planner_sync_summary() into result;

  if (result->>'blast_radius_exceeded')::boolean and not p_force then
    raise exception
      'this file would close % of % open lines. If that is right, re-run with force — otherwise check the export is complete',
      result->>'closed', result->>'open_lines_in_scope';
  end if;

  insert into planner_import_batches
    (source, row_count, pushed_by, inserted_count, updated_count,
     closed_count, reopened_count, unchanged_count, conflicts)
  values
    (coalesce(p_source,'csv'), (result->>'rows_in_file')::int, auth.uid(),
     (result->>'inserted')::int, (result->>'updated')::int, (result->>'closed')::int,
     (result->>'reopened')::int, (result->>'unchanged')::int, result->'conflicts')
  returning id into batch_id;

  -- ── new lines ──────────────────────────────────────────────────────────────
  insert into planner_po_lines
    (organization_id, document_number, sku, internal_id, quantity, quantity_available,
     due_date, origin, pol, destination, raw, last_seen_at, last_seen_batch_id)
  select
    d.organization_id, d.document_number, d.sku, d.new_internal_id,
    d.new_quantity, d.new_quantity_available, d.new_due_date,
    d.new_origin, d.new_pol, d.new_destination, d.new_raw, now(), batch_id
  from _diff d
  where d.action = 'insert';

  -- ── changed lines ──────────────────────────────────────────────────────────
  -- Factory-owned columns — cargo_ready, cbm_per_case, cbm_total — are absent from this list and
  -- from the file. Internal never overwrites what a supplier measured.
  update planner_po_lines l
     set organization_id    = d.organization_id,
         internal_id        = d.new_internal_id,
         quantity           = d.new_quantity,
         quantity_available = d.new_quantity_available,
         due_date           = d.new_due_date,
         origin             = d.new_origin,
         pol                = d.new_pol,
         destination        = d.new_destination,
         raw                = d.new_raw,
         last_seen_at       = now(),
         last_seen_batch_id = batch_id
    from _diff d
   where l.id = d.po_line_id and d.action = 'update';

  -- ── returners ──────────────────────────────────────────────────────────────
  -- A line that comes back invalidates whatever was concluded about its departure, so the
  -- confirmed reason and the note are cleared along with the guess. Cargo ready, CBM and every
  -- history row survive untouched — which is the entire payoff of closing instead of deleting.
  update planner_po_lines l
     set status                  = 'open',
         reopen_count            = l.reopen_count + 1,
         closed_at               = null,
         closed_reason_inferred  = null,
         closed_reason_confirmed = null,
         closed_note             = null,
         closed_confirmed_by     = null,
         closed_confirmed_at     = null,
         organization_id         = d.organization_id,
         internal_id             = d.new_internal_id,
         quantity                = d.new_quantity,
         quantity_available      = d.new_quantity_available,
         due_date                = d.new_due_date,
         origin                  = d.new_origin,
         pol                     = d.new_pol,
         destination             = d.new_destination,
         raw                     = d.new_raw,
         last_seen_at            = now(),
         last_seen_batch_id      = batch_id
    from _diff d
   where l.id = d.po_line_id and d.action = 'reopen';

  -- ── departures ─────────────────────────────────────────────────────────────
  update planner_po_lines l
     set status                 = 'closed',
         closed_at              = now(),
         closed_reason_inferred = d.inferred_reason,
         last_seen_batch_id     = batch_id
    from _diff d
   where l.id = d.po_line_id and d.action = 'close';

  /*
    snapshots_seen advances for EVERY line in the file, changed or not — it counts appearances,
    not edits. Riding it on the `update` branch would leave an unchanged line stuck at 1 forever
    and make it look permanently like a data-entry error the day it finally closes.

    This deliberately moves updated_at on unchanged rows once a week. That is the cost of the
    counter and it is worth paying: nothing downstream reads updated_at for meaning, and the CBM
    observation dates that DO matter come from the event log, not from this column — which is
    exactly why planner_cbm_observations was built to read the log in the first place.
  */
  update planner_po_lines l
     set snapshots_seen = l.snapshots_seen + 1,
         last_seen_at   = now()
    from _diff d
   where l.id = d.po_line_id and d.action in ('update','unchanged','reopen');

  -- ── the arc ────────────────────────────────────────────────────────────────
  insert into planner_po_line_status_events
    (po_line_id, organization_id, from_status, to_status, inferred_reason, batch_id)
  select d.po_line_id, d.organization_id,
         case when d.action = 'close' then 'open' else 'closed' end,
         case when d.action = 'close' then 'closed' else 'open' end,
         d.inferred_reason, batch_id
    from _diff d
   where d.action in ('close','reopen');

  return result || jsonb_build_object('dry_run', false, 'batch_id', batch_id, 'forced', p_force);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- confirm_po_line_closure — a human replacing a guess with a fact
--
-- Writes ONLY the confirmed columns. closed_reason_inferred is left exactly as the sync wrote
-- it, so "what did the system think, and was it right" stays answerable forever.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.confirm_po_line_closure(
  p_line_id uuid,
  p_reason  text,
  p_note    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may confirm why a PO line closed';
  end if;

  update planner_po_lines
     set closed_reason_confirmed = p_reason,
         closed_note             = nullif(btrim(coalesce(p_note,'')), ''),
         closed_confirmed_by     = auth.uid(),
         closed_confirmed_at     = now()
   where id = p_line_id and status = 'closed';

  if not found then
    raise exception 'no closed PO line with that id';
  end if;
end;
$$;

revoke all on function public.planner_po_line_diff(jsonb) from anon, authenticated;
revoke all on function public.planner_sync_summary()      from anon, authenticated;
grant execute on function public.planner_sync_preview(jsonb)               to authenticated;
grant execute on function public.sync_po_lines(jsonb, text, boolean)       to authenticated;
grant execute on function public.confirm_po_line_closure(uuid, text, text) to authenticated;

comment on function public.sync_po_lines(jsonb, text, boolean) is
  'PLANNER | reconciles planner_po_lines against a complete snapshot of open ERP PO lines. Internal or service_role only. The CSV upload and the future NetSuite API call this same function — only the row source differs';
comment on function public.planner_sync_preview(jsonb) is
  'PLANNER | read-only preview of sync_po_lines, computed from the same diff so the two cannot disagree';
