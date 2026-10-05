create extension if not exists pgcrypto;

create or replace function public.pitch_valid_players(p_players text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(coalesce(p_players, '{}'::text[])) <= 20
    and coalesce(bool_and(char_length(trim(player_name)) between 1 and 36), true)
  from unnest(coalesce(p_players, '{}'::text[])) as player_name;
$$;

create table if not exists public.pitch_events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 42),
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pitch_event_members (
  event_id uuid not null references public.pitch_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists public.pitch_team_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.pitch_events(id) on delete cascade,
  submitter_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  team_name text not null check (char_length(trim(team_name)) between 1 and 36),
  representative text not null check (char_length(trim(representative)) between 1 and 36),
  players text[] not null default '{}' check (public.pitch_valid_players(players)),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists pitch_events_owner_idx on public.pitch_events(owner_id);
create index if not exists pitch_event_members_user_idx on public.pitch_event_members(user_id);
create index if not exists pitch_team_submissions_event_idx on public.pitch_team_submissions(event_id, status);
create index if not exists pitch_team_submissions_submitter_idx on public.pitch_team_submissions(submitter_id);

create or replace function public.is_pitch_event_member(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pitch_event_members m
    where m.event_id = p_event_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_pitch_event_owner(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pitch_events e
    where e.id = p_event_id and e.owner_id = (select auth.uid())
  );
$$;

create or replace function public.touch_pitch_event_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pitch_events_touch_updated_at on public.pitch_events;
create trigger pitch_events_touch_updated_at
before update on public.pitch_events
for each row execute function public.touch_pitch_event_updated_at();

create or replace function public.create_pitch_event(p_name text, p_duration_seconds integer default 420)
returns setof public.pitch_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.pitch_events;
  v_code text;
  v_duration integer := greatest(60, least(3600, coalesce(p_duration_seconds, 420)));
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 42 then raise exception 'Event name is required'; end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.pitch_events where code = v_code);
  end loop;

  insert into public.pitch_events (code, owner_id, name, state)
  values (
    v_code,
    (select auth.uid()),
    trim(p_name),
    jsonb_build_object(
      'version', 2,
      'eventName', trim(p_name),
      'duration', v_duration,
      'remaining', v_duration,
      'endAt', null,
      'running', false,
      'game', 1,
      'teams', '[]'::jsonb,
      'active', '[]'::jsonb,
      'queue', '[]'::jsonb
    )
  ) returning * into v_event;

  insert into public.pitch_event_members(event_id, user_id)
  values (v_event.id, (select auth.uid())) on conflict do nothing;
  return next v_event;
end;
$$;

create or replace function public.join_pitch_event(p_code text)
returns setof public.pitch_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.pitch_events;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select * into v_event from public.pitch_events where code = upper(trim(p_code));
  if not found then raise exception 'Event not found'; end if;
  insert into public.pitch_event_members(event_id, user_id)
  values (v_event.id, (select auth.uid())) on conflict do nothing;
  return next v_event;
end;
$$;

create or replace function public.approve_pitch_team_submission(p_submission_id uuid)
returns setof public.pitch_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.pitch_team_submissions;
  v_event public.pitch_events;
  v_state jsonb;
  v_team_id uuid := gen_random_uuid();
  v_team jsonb;
  v_active jsonb;
  v_color text;
begin
  select * into v_submission from public.pitch_team_submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission not found'; end if;
  select * into v_event from public.pitch_events where id = v_submission.event_id for update;
  if v_event.owner_id <> (select auth.uid()) then raise exception 'Only the event owner can approve teams'; end if;
  if v_submission.status <> 'pending' then raise exception 'Submission was already reviewed'; end if;
  if jsonb_array_length(coalesce(v_event.state->'teams', '[]'::jsonb)) >= 32 then
    raise exception 'This event already has the maximum of 32 teams';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_event.state->'teams', '[]'::jsonb)) as existing_team
    where lower(trim(existing_team->>'name')) = lower(trim(v_submission.team_name))
  ) then
    raise exception 'A team with this name already exists';
  end if;

  v_color := (array['cyan','orange','lime','violet','blue','rose','gold','mint'])[1 + floor(random() * 8)::int];
  v_team := jsonb_build_object(
    'id', v_team_id::text,
    'name', v_submission.team_name,
    'rep', v_submission.representative,
    'players', to_jsonb(v_submission.players),
    'color', v_color
  );
  v_state := v_event.state;
  v_state := jsonb_set(v_state, '{teams}', coalesce(v_state->'teams', '[]'::jsonb) || jsonb_build_array(v_team), true);
  v_active := coalesce(v_state->'active', '[]'::jsonb);
  if jsonb_array_length(v_active) < 2 then
    v_state := jsonb_set(v_state, '{active}', v_active || jsonb_build_array(v_team_id::text), true);
  else
    v_state := jsonb_set(v_state, '{queue}', coalesce(v_state->'queue', '[]'::jsonb) || jsonb_build_array(v_team_id::text), true);
  end if;

  update public.pitch_events set state = v_state where id = v_event.id returning * into v_event;
  update public.pitch_team_submissions set status = 'approved', reviewed_at = now() where id = p_submission_id;
  return next v_event;
end;
$$;

create or replace function public.limit_pitch_team_submissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.event_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.event_id::text || ':' || new.submitter_id::text, 0));
  if (
    select count(*) from public.pitch_team_submissions
    where event_id = new.event_id and submitter_id = new.submitter_id and status = 'pending'
  ) >= 3 then
    raise exception 'You can have at most 3 pending team requests for this event';
  end if;
  if (
    select count(*) from public.pitch_team_submissions
    where event_id = new.event_id and status = 'pending'
  ) >= 50 then
    raise exception 'This event has too many pending team requests';
  end if;
  return new;
end;
$$;

drop trigger if exists pitch_team_submissions_limit on public.pitch_team_submissions;
create trigger pitch_team_submissions_limit
before insert on public.pitch_team_submissions
for each row execute function public.limit_pitch_team_submissions();

alter table public.pitch_events enable row level security;
alter table public.pitch_event_members enable row level security;
alter table public.pitch_team_submissions enable row level security;

revoke all on public.pitch_events, public.pitch_event_members, public.pitch_team_submissions from anon, authenticated;
grant select, update, delete on public.pitch_events to authenticated;
grant select on public.pitch_event_members to authenticated;
grant select, insert, update on public.pitch_team_submissions to authenticated;

drop policy if exists pitch_events_member_select on public.pitch_events;
create policy pitch_events_member_select on public.pitch_events for select to authenticated
using (public.is_pitch_event_member(id));
drop policy if exists pitch_events_owner_update on public.pitch_events;
create policy pitch_events_owner_update on public.pitch_events for update to authenticated
using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists pitch_events_owner_delete on public.pitch_events;
create policy pitch_events_owner_delete on public.pitch_events for delete to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists pitch_members_self_select on public.pitch_event_members;
create policy pitch_members_self_select on public.pitch_event_members for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists pitch_submissions_read on public.pitch_team_submissions;
create policy pitch_submissions_read on public.pitch_team_submissions for select to authenticated
using (submitter_id = (select auth.uid()) or public.is_pitch_event_owner(event_id));
drop policy if exists pitch_submissions_member_insert on public.pitch_team_submissions;
create policy pitch_submissions_member_insert on public.pitch_team_submissions for insert to authenticated
with check (submitter_id = (select auth.uid()) and status = 'pending' and public.is_pitch_event_member(event_id));
drop policy if exists pitch_submissions_owner_update on public.pitch_team_submissions;
create policy pitch_submissions_owner_update on public.pitch_team_submissions for update to authenticated
using (public.is_pitch_event_owner(event_id))
with check (public.is_pitch_event_owner(event_id) and status in ('approved', 'rejected'));

revoke all on function public.is_pitch_event_member(uuid) from public;
revoke all on function public.is_pitch_event_owner(uuid) from public;
revoke all on function public.create_pitch_event(text, integer) from public;
revoke all on function public.join_pitch_event(text) from public;
revoke all on function public.approve_pitch_team_submission(uuid) from public;
revoke all on function public.pitch_valid_players(text[]) from public, anon, authenticated;
revoke all on function public.limit_pitch_team_submissions() from public, anon, authenticated;
grant execute on function public.is_pitch_event_member(uuid) to authenticated;
grant execute on function public.is_pitch_event_owner(uuid) to authenticated;
grant execute on function public.create_pitch_event(text, integer) to authenticated;
grant execute on function public.join_pitch_event(text) to authenticated;
grant execute on function public.approve_pitch_team_submission(uuid) to authenticated;
grant execute on function public.pitch_valid_players(text[]) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.pitch_events;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.pitch_team_submissions;
exception when duplicate_object then null;
end $$;
