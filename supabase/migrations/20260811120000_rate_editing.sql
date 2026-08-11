-- Editing a rate after it lands, and remembering that it happened.
--
-- A typo in an uploaded rate currently has no fix short of re-uploading the whole sheet. Both
-- roles need a correction path: internal because they key rates in on a forwarder's behalf, and
-- forwarders because they submitted it in the first place.
--
-- Three of the four paths were already permitted. This adds the fourth and the audit.
--
--                        rates (ocean)              drayage_rates
--   internal   UPDATE    MISSING  ← added here      already existed
--   forwarder  UPDATE    already existed            already existed
--
-- The asymmetry looks like an oversight rather than a decision: internal can already update
-- drayage_rates, and internal is the role that records rates on a forwarder's behalf in the first
-- place (Upload Rates), so it could create an ocean rate it could never correct.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The missing policy
--
-- Uses current_role_is('internal') to match the sibling policies on this table rather than
-- my_org_type(); the rates tables were written against that helper and mixing the two in one
-- table makes the rules harder to reason about than either alone.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "internal updates rates" on public.rates;
create policy "internal updates rates" on public.rates
  for update to public
  using (current_role_is('internal'))
  with check (current_role_is('internal'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. rate_edits — what changed, who changed it, and what it was before
--
-- WHY THIS EXISTS. A rate is a number a supplier gave us. Editing it in place destroys the
-- evidence of what they actually quoted, and the most consequential case is internal correcting a
-- FORWARDER's submitted price: without a record there is no way to answer "did we mistype this, or
-- did they?" — a question that only ever gets asked when money is already at stake.
--
-- ONE ROW PER FIELD, not per edit. Field-level rows make "what happened to this rate's price"
-- answerable with a single WHERE, and they keep old/new as plain text so the table never has to
-- know the shape of the column it is describing.
--
-- Text for old_value/new_value on purpose: this table spans two rate tables whose columns are
-- numeric, integer, date and text. A typed column would need one per type, and the audit is read
-- by humans, not summed.
--
-- rate_id is NOT a foreign key. A deleted rate's history is the part you most want to keep, and an
-- FK with cascade would delete exactly that; an FK without cascade would block the delete.
-- table_name says which table the id points at.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.rate_edits (
  id          uuid primary key default gen_random_uuid(),

  rate_id     uuid not null,
  table_name  text not null check (table_name in ('rates', 'drayage_rates')),

  field       text not null,
  old_value   text,
  new_value   text,

  edited_by   uuid references public.profiles(id),
  edited_at   timestamptz not null default now()
);

-- "What has happened to this rate" — the only hot query.
create index if not exists rate_edits_rate_idx
  on public.rate_edits (rate_id, edited_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS
--
-- Read: internal sees everything; a forwarder sees the history of their OWN rates — including
-- edits internal made to them, which is the point. Someone changing your quoted price is
-- something you are entitled to see.
--
-- Insert: you may only write an audit row for a rate you could actually have edited, and only
-- under your own name. Otherwise the table is a place to write fiction about other people's rates.
--
-- NO UPDATE OR DELETE POLICY, deliberately. An audit trail that can be rewritten is not an audit
-- trail. Corrections are new rows.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.rate_edits enable row level security;

revoke all on public.rate_edits from anon, authenticated;
grant select, insert on public.rate_edits to authenticated;

create policy rate_edits_read on public.rate_edits
  for select to authenticated
  using (
    current_role_is('internal')
    or exists (select 1 from public.rates r
                where r.id = rate_id and table_name = 'rates'
                  and r.forwarder_id = my_forwarder())
    or exists (select 1 from public.drayage_rates d
                where d.id = rate_id and table_name = 'drayage_rates'
                  and d.forwarder_id = my_forwarder())
  );

create policy rate_edits_insert on public.rate_edits
  for insert to authenticated
  with check (
    edited_by = auth.uid()
    and (
      current_role_is('internal')
      or exists (select 1 from public.rates r
                  where r.id = rate_id and table_name = 'rates'
                    and r.forwarder_id = my_forwarder())
      or exists (select 1 from public.drayage_rates d
                  where d.id = rate_id and table_name = 'drayage_rates'
                    and d.forwarder_id = my_forwarder())
    )
  );

comment on table public.rate_edits is
  'RATES | OWNER: whoever edits a rate | READ BY: Received/Active Rates | field-level history of manual rate corrections across rates + drayage_rates. rate_id is deliberately NOT an FK so history outlives the row. No update/delete policy — an editable audit trail is not one';
comment on column public.rate_edits.table_name is
  'Which table rate_id points at. There is no FK, so this is what makes the reference resolvable';
