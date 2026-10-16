-- Open Hours: update for 15-minute slots and flexible meeting length.
-- Run this ONCE in the Supabase SQL Editor if you already ran the first schema.sql.
-- (Fresh projects should run schema.sql instead; it already includes all of this.)

alter table public.hosts drop constraint if exists hosts_duration_min_check;
alter table public.hosts add constraint hosts_duration_min_check check (duration_min between 15 and 240);
alter table public.hosts add column min_meeting_min int not null default 15 check (min_meeting_min in (15, 30, 45, 60));
alter table public.hosts add column max_meeting_min int not null default 60 check (max_meeting_min in (15, 30, 45, 60, 90, 120));
alter table public.hosts add constraint hosts_meeting_range check (min_meeting_min <= max_meeting_min);

drop function if exists public.book_slot(uuid, timestamptz, text);

create or replace function public.book_slot(p_host uuid, p_start timestamptz, p_duration int, p_topic text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  hrow public.hosts%rowtype;
  local_ts timestamp;
  dow int;
  tmin int;
  ok boolean := false;
  w jsonb;
  s_min int;
  e_min int;
  n int;
  mins numeric;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if p_host = me then raise exception 'You cannot book yourself.'; end if;
  if not exists (select 1 from public.profiles where id = me) then raise exception 'Add your name first.'; end if;

  select * into hrow from public.hosts where user_id = p_host and active;
  if not found then raise exception 'This person is not taking bookings right now.'; end if;
  if p_duration is null or p_duration % 15 <> 0 then raise exception 'Meetings run in 15-minute steps.'; end if;
  if p_duration < hrow.min_meeting_min or p_duration > hrow.max_meeting_min then
    raise exception 'This person takes meetings of % to % minutes.', hrow.min_meeting_min, hrow.max_meeting_min;
  end if;
  if p_start < now() + interval '2 hours' then raise exception 'That time is too soon. Pick one at least 2 hours ahead.'; end if;
  if p_start > now() + interval '30 days' then raise exception 'That time is too far ahead.'; end if;

  perform pg_advisory_xact_lock(hashtext(p_host::text));

  local_ts := p_start at time zone hrow.tz;
  if extract(second from local_ts) <> 0 or (extract(minute from local_ts)::int % 15) <> 0 then
    raise exception 'Start times must fall on a quarter hour.';
  end if;
  dow := extract(dow from local_ts)::int;
  tmin := extract(hour from local_ts)::int * 60 + extract(minute from local_ts)::int;

  for w in select e.v from jsonb_array_elements(coalesce(hrow.avail -> (dow::text), '[]'::jsonb)) as e(v) loop
    s_min := split_part(w ->> 's', ':', 1)::int * 60 + split_part(w ->> 's', ':', 2)::int;
    e_min := split_part(w ->> 'e', ':', 1)::int * 60 + split_part(w ->> 'e', ':', 2)::int;
    if tmin >= s_min and tmin + p_duration <= e_min then
      ok := true;
    end if;
  end loop;
  if not ok then raise exception 'That is not within this person''s open hours.'; end if;

  if exists (
    select 1 from public.bookings b
    where b.host_id = p_host and b.status = 'confirmed'
      and p_start < b.start_at + make_interval(mins => b.duration_min)
      and p_start + make_interval(mins => p_duration) > b.start_at
  ) then raise exception 'That time was just taken. Pick another one.'; end if;

  select count(*), coalesce(sum(b.duration_min), 0) into n, mins
  from public.bookings b
  where b.host_id = p_host and b.status = 'confirmed'
    and date_trunc('week', b.start_at at time zone hrow.tz) = date_trunc('week', local_ts);
  if n >= hrow.max_per_week or mins + p_duration > hrow.max_hours_per_week * 60 then
    raise exception 'This person has reached their limit for that week.';
  end if;

  insert into public.bookings (host_id, guest_id, start_at, duration_min, topic)
  values (p_host, me, p_start, p_duration, left(coalesce(btrim(p_topic), ''), 140))
  returning id into new_id;
  return new_id;
end $$;

revoke all on function public.book_slot(uuid, timestamptz, int, text) from public, anon;
grant execute on function public.book_slot(uuid, timestamptz, int, text) to authenticated;
