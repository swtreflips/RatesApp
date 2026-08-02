-- Container codes were being generated in the browser, and colliding.
--
-- The planner store kept `containerCodeSequences`, a per-prefix counter that starts at {} on
-- every page load and was never seeded from existing rows. So the first container added for a
-- supplier that already had one regenerated its code — Ditar already had DS0001, the client
-- offered DS0001 again, and `planner_containers_code_key` rejected it.
--
-- It only bit suppliers with an existing container, which is why it looked arbitrary: adding to
-- a brand-new supplier worked every time.
--
-- `next_container_code(org_code)` has existed since the schema landed and does this properly —
-- one atomic INSERT ... ON CONFLICT DO UPDATE RETURNING, so two people adding a container at the
-- same moment cannot receive the same number. Nothing ever called it, and `planner_sequences`
-- is empty.
--
-- Pointing the client at it is not enough on its own: the counter would start from 1 and collide
-- with every code already issued. This seeds it from the codes in the table first.

insert into public.planner_sequences (org_code, next_number)
select left(code, 2), max(nullif(regexp_replace(substring(code from 3), '\D', '', 'g'), '')::int) + 1
  from public.planner_containers
 where code ~ '^[A-Z]{2}[0-9]+$'
 group by left(code, 2)
on conflict (org_code) do update
  -- never move a counter backwards; issuing a number twice is the bug being fixed
  set next_number = greatest(public.planner_sequences.next_number, excluded.next_number);

comment on table public.planner_sequences is
  'Monotonic per-organization container numbering, advanced only by next_container_code(). Seeded from existing planner_containers codes when client-side generation was retired.';
