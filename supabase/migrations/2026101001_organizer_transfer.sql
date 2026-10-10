create table if not exists public.pitch_event_transfer_tokens (
  event_id uuid primary key references public.pitch_events(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.pitch_event_transfer_tokens enable row level security;
revoke all on public.pitch_event_transfer_tokens from public, anon, authenticated;
create index if not exists pitch_event_transfer_tokens_initiator_idx
  on public.pitch_event_transfer_tokens(initiated_by);

drop policy if exists pitch_transfer_tokens_no_direct_access on public.pitch_event_transfer_tokens;
create policy pitch_transfer_tokens_no_direct_access
on public.pitch_event_transfer_tokens
as restrictive
for all
to postgres
using (false)
with check (false);

create or replace function public.create_pitch_organizer_transfer(p_event_id uuid)
returns table (transfer_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.pitch_events;
  v_token text;
  v_expires_at timestamptz := now() + interval '10 minutes';
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;

  select * into v_event
  from public.pitch_events
  where id = p_event_id
  for update;

  if not found or v_event.owner_id <> (select auth.uid()) then
    raise exception 'Only the current organizer can create a handoff link';
  end if;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into public.pitch_event_transfer_tokens (event_id, initiated_by, token_hash, created_at, expires_at)
  values (
    p_event_id,
    (select auth.uid()),
    extensions.digest(v_token, 'sha256'),
    now(),
    v_expires_at
  )
  on conflict (event_id) do update set
    initiated_by = excluded.initiated_by,
    token_hash = excluded.token_hash,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at;

  return query select v_token, v_expires_at;
end;
$$;

create or replace function public.claim_pitch_organizer_transfer(p_event_id uuid, p_transfer_token text)
returns setof public.pitch_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.pitch_events;
  v_transfer public.pitch_event_transfer_tokens;
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  select * into v_event
  from public.pitch_events
  where id = p_event_id
  for update;

  if not found then raise exception 'Event not found'; end if;
  if v_event.owner_id = v_user_id then raise exception 'You are already the organizer'; end if;

  select * into v_transfer
  from public.pitch_event_transfer_tokens
  where event_id = p_event_id
  for update;

  if not found
    or v_transfer.initiated_by <> v_event.owner_id
    or v_transfer.expires_at <= now()
    or v_transfer.token_hash <> extensions.digest(trim(coalesce(p_transfer_token, '')), 'sha256')
    or not exists (
      select 1
      from public.pitch_event_members member
      where member.event_id = p_event_id and member.user_id = v_user_id
    )
  then
    raise exception 'This organizer handoff link is invalid or has expired';
  end if;

  update public.pitch_events
  set owner_id = v_user_id
  where id = p_event_id
  returning * into v_event;

  delete from public.pitch_event_transfer_tokens where event_id = p_event_id;
  return next v_event;
end;
$$;

create or replace function public.cancel_pitch_organizer_transfer(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;

  select owner_id into v_owner_id
  from public.pitch_events
  where id = p_event_id
  for update;

  if not found or v_owner_id <> (select auth.uid()) then
    raise exception 'Only the current organizer can cancel a handoff';
  end if;

  delete from public.pitch_event_transfer_tokens where event_id = p_event_id;
end;
$$;

revoke all on function public.create_pitch_organizer_transfer(uuid) from public, anon, authenticated;
revoke all on function public.claim_pitch_organizer_transfer(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_pitch_organizer_transfer(uuid) from public, anon, authenticated;

grant execute on function public.create_pitch_organizer_transfer(uuid) to authenticated;
grant execute on function public.claim_pitch_organizer_transfer(uuid, text) to authenticated;
grant execute on function public.cancel_pitch_organizer_transfer(uuid) to authenticated;

notify pgrst, 'reload schema';
