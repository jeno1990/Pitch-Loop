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

alter table public.pitch_team_submissions
  drop constraint if exists pitch_team_submissions_players_valid;
alter table public.pitch_team_submissions
  add constraint pitch_team_submissions_players_valid
  check (public.pitch_valid_players(players));

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

revoke all on function public.pitch_valid_players(text[]) from public, anon, authenticated;
revoke all on function public.limit_pitch_team_submissions() from public, anon, authenticated;
revoke all on function public.approve_pitch_team_submission(uuid) from public, anon;
grant execute on function public.approve_pitch_team_submission(uuid) to authenticated;
grant execute on function public.pitch_valid_players(text[]) to authenticated;
