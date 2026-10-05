revoke execute on function public.is_pitch_event_member(uuid) from anon;
revoke execute on function public.is_pitch_event_owner(uuid) from anon;
revoke execute on function public.create_pitch_event(text, integer) from anon;
revoke execute on function public.join_pitch_event(text) from anon;
revoke execute on function public.approve_pitch_team_submission(uuid) from anon;
