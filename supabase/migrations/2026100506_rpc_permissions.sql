revoke all on function public.create_pitch_event(text, integer) from public, anon, authenticated;
revoke all on function public.join_pitch_event(text) from public, anon, authenticated;
revoke all on function public.approve_pitch_team_submission(uuid) from public, anon, authenticated;
revoke all on function public.is_pitch_event_member(uuid) from public, anon, authenticated;
revoke all on function public.is_pitch_event_owner(uuid) from public, anon, authenticated;
revoke all on function public.pitch_valid_players(text[]) from public, anon, authenticated;
revoke all on function public.limit_pitch_team_submissions() from public, anon, authenticated;
revoke all on function public.touch_pitch_event_updated_at() from public, anon, authenticated;

grant execute on function public.create_pitch_event(text, integer) to authenticated;
grant execute on function public.join_pitch_event(text) to authenticated;
grant execute on function public.approve_pitch_team_submission(uuid) to authenticated;
grant execute on function public.is_pitch_event_member(uuid) to authenticated;
grant execute on function public.is_pitch_event_owner(uuid) to authenticated;
grant execute on function public.pitch_valid_players(text[]) to authenticated;

notify pgrst, 'reload schema';
