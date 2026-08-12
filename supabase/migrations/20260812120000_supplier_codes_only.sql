-- Suppliers become codes. The legal names leave the database.
--
-- Before a beta rollout inside the team, the factories' registered names are being removed from
-- this system entirely. They were never needed here: the app groups, filters and numbers
-- containers by supplier, and a three-letter code does all of that. The name↔entity mapping lives
-- in NetSuite, which is the system of record for it.
--
-- EVERY STATEMENT KEYS ON THE OLD CODE, NEVER ON THE NAME. Writing `where name = 'Some Factory
-- Ltd'` would put the very strings being removed into the repository, in a file that outlives the
-- row it deletes. The old two-letter codes are already unique, so they are the safe handle.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS BREAKS, AND WHY IT IS HANDLED BELOW
--
-- The weekly ERP sync resolved suppliers with `join organizations o on o.name = i.supplier`. Once
-- name holds a code, an export carrying legal names matches nothing and the sync raises. Section 5
-- repoints that join at `o.code`, which is the honest key now and stays correct regardless of what
-- name ever holds.
--
-- >>> THE NETSUITE EXPORT MUST NOW EMIT THE SUPPLIER CODE IN ITS SUPPLIER COLUMN. <<<
-- Until it does, the next upload fails — loudly, listing what did not match, which is the correct
-- failure. It does not silently close every open PO.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Clear the planner's test data ─────────────────────────────────────────
-- Containers, their allocations and the per-supplier numbering are all test artefacts from
-- development. They are cleared rather than migrated because their codes embed the OLD supplier
-- prefixes: keeping them would leave DS0011 sitting beside DTR0001 for the same factory, two
-- numbering families for one supplier, permanently.
--
-- Order matters — allocations reference containers.
delete from public.planner_allocations;
delete from public.planner_containers;
delete from public.planner_sequences;

-- committed_quantity is derived from allocations in committed containers. With no allocations left
-- it must be zero; anything else is a stale accumulation from before it became derived.
update public.planner_po_lines set committed_quantity = 0 where committed_quantity <> 0;

-- ── 2. Widen the code constraint ─────────────────────────────────────────────
-- It was CHECK (code ~ '^[A-Z]{2}$') — exactly two letters — which is what made two-letter codes
-- the only option in the first place and rejected the first UPDATE below.
--
-- 2 to 4 rather than exactly 3: the internal organization's code is two letters and does not need
-- reissuing just because the suppliers changed shape, and a fourth character leaves room for the
-- next pair of sister plants without another migration.
--
-- Nothing else assumes a length. next_container_code() builds codes as `code || lpad(n, 4, '0')`,
-- so PRS0001 works exactly as DS0001 did, and planner_sequences keys on the code as plain text.
alter table public.organizations drop constraint if exists organizations_code_check;
alter table public.organizations add constraint organizations_code_check
  check (code ~ '^[A-Z]{2,4}$');

-- ── 3. Suppliers: new three-letter codes, name collapsed onto the code ───────
-- Two letters could not carry the distinctions that matter here. Two pairs of suppliers are
-- sister plants under one owner, and their old codes differed by a single letter — VP/VE and
-- JT/QJ — which is exactly the kind of pair someone misreads at speed. Three letters make them
-- obvious: VNS/VNI and JST/JSQ.
--
-- `name` is set to the code rather than dropped: it is NOT NULL, it is what the UI already renders,
-- and half the readers in two applications select it. Collapsing the two means every existing
-- screen shows the code with no client change at all.
update public.organizations set code = 'PRS', name = 'PRS' where code = 'PW';
update public.organizations set code = 'MRK', name = 'MRK' where code = 'ME';
update public.organizations set code = 'JST', name = 'JST' where code = 'JT';
update public.organizations set code = 'JSQ', name = 'JSQ' where code = 'QJ';
update public.organizations set code = 'TSW', name = 'TSW' where code = 'TP';
update public.organizations set code = 'GLS', name = 'GLS' where code = 'GP';
update public.organizations set code = 'VNS', name = 'VNS' where code = 'VE';
update public.organizations set code = 'VNI', name = 'VNI' where code = 'VP';
update public.organizations set code = 'MCT', name = 'MCT' where code = 'MP';
update public.organizations set code = 'ECO', name = 'ECO' where code = 'EP';
update public.organizations set code = 'MSD', name = 'MSD' where code = 'MI';
update public.organizations set code = 'GRP', name = 'GRP' where code = 'GR';
update public.organizations set code = 'SRV', name = 'SRV' where code = 'SE';
update public.organizations set code = 'INT', name = 'INT' where code = 'IP';
update public.organizations set code = 'PMA', name = 'PMA' where code = 'PM';
update public.organizations set code = 'THL', name = 'THL' where code = 'TL';
update public.organizations set code = 'DTR', name = 'DTR' where code = 'DS';
update public.organizations set code = 'KMD', name = 'KMD' where code = 'KD';

-- ── 4. The groups named after their parent company ───────────────────────────
-- A group is the commercial relationship spanning two factories — one owner, two plants. Naming it
-- after the parent left the legal name in the database under a different column, which is the
-- thing being removed. Keyed on the group's primary member's NEW code, so no name appears here
-- either.
update public.organization_groups g set name = 'DTR'
 where exists (select 1 from public.organizations o
                where o.group_id = g.id and o.is_group_primary and o.code = 'DTR');
update public.organization_groups g set name = 'JSN'
 where exists (select 1 from public.organizations o
                where o.group_id = g.id and o.is_group_primary and o.code = 'JST');

-- ── 5. Repoint the sync at the code ──────────────────────────────────────────
-- Suppliers are now identified by code end to end. Matching on `name` still worked by accident
-- (name equals code today) but said the wrong thing about what identifies a supplier, and would
-- break the moment anyone put anything else in `name`.
--
-- The error message loses its "fix organizations.name" advice, which would now be wrong advice.
CREATE OR REPLACE FUNCTION public.planner_po_line_diff(p_rows jsonb)
 RETURNS TABLE(action text, po_line_id uuid, organization_id uuid, supplier text, document_number text, sku text, new_internal_id text, new_quantity numeric, new_quantity_available numeric, new_due_date date, new_origin text, new_pol text, new_destination text, new_raw jsonb, old_quantity numeric, old_quantity_available numeric, old_due_date date, old_destination text, inferred_reason text, allocated_quantity numeric, conflict text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      on o.code = btrim(i.supplier) and o.type = 'supplier'
   where o.id is null;

  if bad_suppliers is not null then
    raise exception
      'these supplier CODES do not match any organization: %. The export must send the supplier code, not the name — fix the export or add the code in organizations.code, then re-upload',
      bad_suppliers;
  end if;

  return query
  with resolved as (
    select i.*, o.id as org_id
      from _incoming i
      join organizations o on o.code = btrim(i.supplier) and o.type = 'supplier'
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
$function$;

comment on function public.planner_po_line_diff is
  'PLANNER | resolves suppliers by organizations.code, never by name. The legal names were removed from this database in 20260812120000 and live only in NetSuite, so the ERP export must send the CODE in its supplier column';

-- ── 6. Two display names carrying a company ──────────────────────────────────
-- A profile's full_name is shown wherever a user appears, so a surname that is actually the
-- factory leaks exactly what sections 3 and 4 remove.
--
-- Keyed on the profile UUID, because keying on the name would put it in this file. The supplier
-- one derives its new surname from the organization's code, so it stays correct rather than being
-- a second copy of the mapping that can fall out of step.
update public.profiles p
   set full_name = 'Luis ' || o.code
  from public.organizations o
 where p.id = '00824ba5-c475-4415-ae51-9d5ae9b81c22'
   and o.id = p.organization_id;

-- This one belongs to a FORWARDER, which has no code — forwarder names are deliberately out of
-- scope here (this change is about the factories), so the surname is set literally.
update public.profiles
   set full_name = 'Luis UNI'
 where id = 'ef80ffd3-0c73-43b9-99e6-f58cd6a81863';

commit;
