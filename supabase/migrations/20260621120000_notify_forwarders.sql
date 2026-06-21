-- notify-forwarders feature (ALERTS.md §3–§7) — audit log, recipient controls, recipient resolver.
-- Run via `supabase db push`, or paste into the Supabase SQL editor.
-- Assumes existing helpers current_role_is()/my_forwarder() and tables forwarders/profiles/
-- rate_request_lanes/rate_submissions (MEMORY.md §2–§3). graph_credentials already exists (§6c).

-- ── Audit log (ALERTS.md §7) — NOT the source of "who responded" (that's rate_submissions) ──
create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('request','reminder')),
  triggered_by uuid not null references auth.users(id),
  period       integer,
  created_at   timestamptz not null default now()
);

create table if not exists notification_recipients (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  forwarder_id    uuid not null references forwarders(id),
  email           text,                       -- snapshot of the addresses emailed (joined)
  lane_count      integer,
  status          text not null default 'queued' check (status in ('queued','sent','failed')),
  error           text,
  sent_at         timestamptz
);
create index if not exists idx_notif_recipients_forwarder on notification_recipients(forwarder_id);

alter table notifications           enable row level security;
alter table notification_recipients enable row level security;

-- Internal team reads the log (for "last notified" + a future notification center). Inserts happen
-- in the Edge Function via the service role, which bypasses RLS — so no insert policy is needed.
-- Forwarders get no access at all (no policy → denied).
drop policy if exists "internal reads notifications" on notifications;
create policy "internal reads notifications" on notifications
  for select using (current_role_is('internal'));

drop policy if exists "internal reads notification_recipients" on notification_recipients;
create policy "internal reads notification_recipients" on notification_recipients
  for select using (current_role_is('internal'));

-- ── Recipient controls (ALERTS.md §11) ──
-- forwarders.active: default recipient set for "Send Rate Request" = all active forwarders.
alter table forwarders add column if not exists active boolean not null default true;
-- profiles.receives_rate_requests: per-analyst opt-out (multi-analyst model — analysts ARE contacts).
alter table profiles  add column if not exists receives_rate_requests boolean not null default true;

-- ── Recipient resolver (locked) ──
-- Resolves forwarder companies → their analysts' login emails (auth.users.email). SECURITY DEFINER
-- so auth.users is never exposed to the client; the Edge Function (service role) is the only caller.
create or replace function get_forwarder_recipients(p_forwarder_ids uuid[])
returns table (forwarder_id uuid, forwarder_name text, email text)
language sql stable security definer set search_path = public, auth as $$
  select f.id, f.name, u.email
  from forwarders f
  join profiles   p on p.forwarder_id = f.id and p.receives_rate_requests
  join auth.users u on u.id = p.id
  where f.id = any(p_forwarder_ids) and f.active and u.email is not null;
$$;

-- Lock execution to the service role only (the Edge Function). Revoke the default PUBLIC grant,
-- then re-grant to service_role explicitly (revoking from PUBLIC would otherwise remove it too).
revoke all on function get_forwarder_recipients(uuid[]) from public, anon, authenticated;
grant execute on function get_forwarder_recipients(uuid[]) to service_role;
