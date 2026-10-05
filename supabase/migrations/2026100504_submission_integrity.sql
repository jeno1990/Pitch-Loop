alter table public.pitch_team_submissions
  drop constraint if exists pitch_team_submissions_team_name_check;
alter table public.pitch_team_submissions
  add constraint pitch_team_submissions_team_name_check
  check (char_length(trim(team_name)) between 1 and 36);

alter table public.pitch_team_submissions
  drop constraint if exists pitch_team_submissions_representative_check;
alter table public.pitch_team_submissions
  add constraint pitch_team_submissions_representative_check
  check (char_length(trim(representative)) between 1 and 36);

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

revoke all on function public.limit_pitch_team_submissions() from public, anon, authenticated;
revoke all on function public.pitch_valid_players(text[]) from public, anon, authenticated;
grant execute on function public.pitch_valid_players(text[]) to authenticated;
