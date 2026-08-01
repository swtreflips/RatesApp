-- The post-commit lifecycle moves server-side.
--
-- Booked, scheduled and shipped were plain UPDATEs with the actor id supplied BY THE CLIENT:
--
--     markContainerBooked(id, booking, actorId)  ->  PATCH { booked_by: actorId }
--
-- Nothing checked that value against auth.uid(). So `booked_by` recorded what the browser
-- claimed, not who acted — forgeable from devtools by any internal user, and wrong by accident
-- the first time a refactor passes a stale id. For a column whose entire purpose is attribution
-- that is not good enough, and it was already inconsistent with commit_container, which takes
-- the identity from the session and never accepts it as an argument.
--
-- THE SECOND REASON, which matters more day to day: the state machine lived in the React store.
--
--     if (container.logisticsStatus !== 'committed') return
--
-- A business rule in a component, which is exactly the shape of the sibling-plants bug — a rule
-- the client believed and the database knew nothing about. Nothing stopped a container jumping
-- from committed straight to shipped. Each function below carries its own source-state guard, so
-- the sequence is enforced rather than merely obeyed.
--
-- Every function is internal-only, mirroring commit_container. Suppliers build and fill drafts;
-- the logistics lifecycle after commit belongs to internal staff, and RLS already refuses a
-- supplier any write to a committed container.

create or replace function public.book_container(
  p_container_id uuid,
  p_booking jsonb
) returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may book a container';
  end if;

  update planner_containers
     set logistics_status = 'booked',
         booking   = p_booking,
         booked_at = now(),
         booked_by = auth.uid()          -- from the session, never a parameter
   where id = p_container_id
     and logistics_status = 'committed'  -- the guard that makes the sequence real
  returning * into c;

  if c.id is null then
    raise exception 'container % is not awaiting booking', p_container_id;
  end if;
  return c;
end;
$$;

create or replace function public.unbook_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may un-book a container';
  end if;

  -- Reversing a step discards that step's data. Booking details and both stamps go together;
  -- a half-cleared row would later read as "booked by nobody at no time".
  update planner_containers
     set logistics_status = 'committed',
         booking = null, booked_at = null, booked_by = null
   where id = p_container_id and logistics_status = 'booked'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not booked', p_container_id;
  end if;
  return c;
end;
$$;

create or replace function public.schedule_container(
  p_container_id uuid,
  p_schedule jsonb
) returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers; v_status text;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may schedule a container';
  end if;

  select logistics_status into v_status from planner_containers where id = p_container_id;

  if v_status = 'booked' then
    -- Advancing: stamp who scheduled it first.
    update planner_containers
       set logistics_status = 'scheduled',
           schedule = p_schedule, scheduled_at = now(), scheduled_by = auth.uid()
     where id = p_container_id returning * into c;

  elsif v_status in ('scheduled', 'shipped') then
    -- Revising. Forwarders move ETD and ETA routinely; the stamps record who scheduled it
    -- first, so a revision must not overwrite them, and must not walk a shipped container back.
    update planner_containers
       set schedule = p_schedule
     where id = p_container_id returning * into c;

  else
    raise exception 'container % must be booked before it can be scheduled', p_container_id;
  end if;

  return c;
end;
$$;

create or replace function public.unschedule_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may un-schedule a container';
  end if;

  update planner_containers
     set logistics_status = 'booked',
         schedule = null, scheduled_at = null, scheduled_by = null
   where id = p_container_id and logistics_status = 'scheduled'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not scheduled', p_container_id;
  end if;
  return c;
end;
$$;

create or replace function public.ship_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may mark a container shipped';
  end if;

  update planner_containers
     set logistics_status = 'shipped', shipped_at = now(), shipped_by = auth.uid()
   where id = p_container_id and logistics_status = 'scheduled'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not scheduled', p_container_id;
  end if;
  return c;
end;
$$;

create or replace function public.unship_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may un-ship a container';
  end if;

  -- The schedule survives: un-shipping says the sailing has not happened yet, not that the
  -- routing was wrong. Only the shipped stamps clear.
  update planner_containers
     set logistics_status = 'scheduled', shipped_at = null, shipped_by = null
   where id = p_container_id and logistics_status = 'shipped'
  returning * into c;

  if c.id is null then
    raise exception 'container % is not shipped', p_container_id;
  end if;
  return c;
end;
$$;

create or replace function public.revise_container_booking(
  p_container_id uuid,
  p_booking jsonb
) returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers;
begin
  if my_org_type() is distinct from 'internal' then
    raise exception 'only internal users may revise a booking';
  end if;

  -- Correcting details without moving the container. booked_at / booked_by are untouched:
  -- they record who booked it, and a later correction does not change that fact.
  update planner_containers
     set booking = p_booking
   where id = p_container_id
     and logistics_status in ('booked', 'scheduled', 'shipped')
  returning * into c;

  if c.id is null then
    raise exception 'container % has no booking to revise', p_container_id;
  end if;
  return c;
end;
$$;

comment on function public.book_container is
  'Advance committed -> booked. Stamps booked_by from auth.uid(); the caller cannot supply it.';
comment on function public.schedule_container is
  'Advance booked -> scheduled, or revise the schedule of an already scheduled/shipped container without disturbing its first-scheduled stamps.';
comment on function public.unship_container is
  'Reverse shipped -> scheduled. Clears the shipped stamps only; the schedule survives.';

-- One more guard, in the same spirit.
--
-- uncommit_container checked `status = 'committed'` but said nothing about logistics_status, so
-- a direct call could uncommit a SHIPPED container and wipe its booking and schedule in one
-- statement. The rule "roll the logistics back first" existed only in the React store:
--
--     if (container.logisticsStatus && container.logisticsStatus !== 'committed') return
--
-- which is a business rule the database knew nothing about, guarding the most destructive
-- action in the app. You cannot un-book a real booking with a button click, and the database
-- should be the thing that says so.
create or replace function public.uncommit_container(p_container_id uuid)
returns public.planner_containers
language plpgsql security definer set search_path to 'public' as $$
declare c public.planner_containers; v_logistics text;
begin
  if my_org_type() is distinct from 'internal' or my_org_role() is distinct from 'admin' then
    raise exception 'only an internal admin may uncommit a container';
  end if;

  select logistics_status into v_logistics
    from planner_containers where id = p_container_id and status = 'committed';

  if v_logistics is not null and v_logistics <> 'committed' then
    raise exception 'container % is %; roll the logistics back before uncommitting',
      p_container_id, v_logistics;
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

-- The RPCs are the intended path. This makes them the ONLY path.
--
-- Routing every transition through a SECURITY DEFINER function fixes attribution only if nothing
-- else can write those columns — and RLS lets an internal user UPDATE any container, so a direct
-- PATCH could still set booked_by to a colleague's uuid. A foreign key stops a made-up value; it
-- does not stop a real one belonging to someone else, which is the case that matters.
--
-- Inside a SECURITY DEFINER function current_user is the owner; through PostgREST it is
-- `authenticated`. That difference is the whole check: the lifecycle columns become writable
-- only from the functions that stamp them from auth.uid().
-- SECURITY INVOKER, deliberately, and this is the subtle part: inside a SECURITY DEFINER
-- function `current_user` is the OWNER, so a definer trigger would see `postgres` on every
-- call — including PostgREST ones — and the check could never match. As an invoker it sees
-- `authenticated` for a direct PATCH and the owner when fired from inside a transition
-- function, which is exactly the distinction being drawn.
create or replace function public.planner_guard_container_lifecycle()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if current_user = 'authenticated' then
    if new.status            is distinct from old.status
    or new.logistics_status  is distinct from old.logistics_status
    or new.ofq_reference     is distinct from old.ofq_reference
    or new.committed_at is distinct from old.committed_at or new.committed_by is distinct from old.committed_by
    or new.booked_at    is distinct from old.booked_at    or new.booked_by    is distinct from old.booked_by
    or new.scheduled_at is distinct from old.scheduled_at or new.scheduled_by is distinct from old.scheduled_by
    or new.shipped_at   is distinct from old.shipped_at   or new.shipped_by   is distinct from old.shipped_by
    or new.booking is distinct from old.booking
    or new.schedule is distinct from old.schedule
    then
      raise exception
        'lifecycle columns are set by commit/book/schedule/ship functions, not by direct update';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists planner_guard_container_lifecycle on public.planner_containers;
create trigger planner_guard_container_lifecycle
  before update on public.planner_containers
  for each row execute function public.planner_guard_container_lifecycle();

comment on function public.planner_guard_container_lifecycle is
  'Lifecycle and attribution columns are writable only from the SECURITY DEFINER transition functions. A direct PATCH from an authenticated session is refused, so booked_by cannot be set to another user.';
