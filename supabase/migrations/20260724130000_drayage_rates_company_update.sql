-- Fix: forwarders can't Confirm / supersede a teammate's drayage rate.
-- Run via `supabase db push`, or paste into the Supabase SQL editor.
--
-- SYMPTOM: "new row violates row-level security policy for table drayage_rates" when clicking
-- Confirm (and it would hit Update price / supersession too).
--
-- CAUSE: the blanket policy was `for all ... with check (forwarder_id = my_forwarder() and
-- provider_id = auth.uid())`. On UPDATE, WITH CHECK validates the RESULTING row — and Confirm
-- only bumps confirmed_at, leaving provider_id as the original submitter. So any analyst who
-- didn't personally create the row is rejected. Same for supersession's status flip, and for any
-- rate internal recorded on-behalf (provider_id = an internal user), which no forwarder could
-- ever confirm.
--
-- FIX: keep per-analyst stamping where it belongs (INSERT = "you must record yourself as the
-- submitter") and make UPDATE company-level, matching the company-level isolation model
-- (SUPABASE.md §7). provider_id remains the attribution of who first submitted.

-- Drop the blanket FOR ALL policy, whatever it was named, without touching the internal policies.
do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'drayage_rates'
      and cmd = 'ALL'
      and coalesce(with_check, '') like '%provider_id%'
  loop
    execute format('drop policy %I on drayage_rates', pol.policyname);
  end loop;
end $$;

-- Company-level read
create policy "forwarder reads drayage rates" on drayage_rates
  for select using (forwarder_id = my_forwarder());

-- Insert: you may only file rates for YOUR company, stamped as YOU (attribution integrity)
create policy "forwarder inserts drayage rates" on drayage_rates
  for insert with check (forwarder_id = my_forwarder() and provider_id = auth.uid());

-- Update: COMPANY-level — Confirm (confirmed_at) and supersession (status flip) are company acts
-- on rows a teammate (or internal, on-behalf) may have created. Still cannot move a row to
-- another company.
create policy "forwarder updates drayage rates" on drayage_rates
  for update using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder());

create policy "forwarder deletes drayage rates" on drayage_rates
  for delete using (forwarder_id = my_forwarder());
