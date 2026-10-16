-- Open Hours: database setup. Paste this whole file into the Supabase SQL Editor and run it once.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.hosts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  tz text not null default 'UTC',
  duration_min int not null default 60 check (duration_min in (30, 45, 60)),
  max_per_week int not null default 4 check (max_per_week between 1 and 40),
  max_hours_per_week numeric not null default 4 check (max_hours_per_week between 0.5 and 40),
  link text not null default '' check (char_length(link) <= 200),
  avail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Private to the host: the address booking emails go to.
create table public.host_private (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notify_email text not null default '' check (char_length(notify_email) <= 120)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  guest_id uuid not null references auth.users(id) on delete cascade,
  start_at timestamptz not null,
  duration_min int not null,
  topic text not null default '' check (char_length(topic) <= 140),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  seen_by_host boolean not null default false,
  cancelled_by uuid,
  emailed_booking boolean not null default false,
  emailed_cancel boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index bookings_host_slot on public.bookings (host_id, start_at) where status = 'confirmed';
create index bookings_guest on public.bookings (guest_id, start_at);

alter table public.profiles enable row level security;
alter table public.hosts enable row level security;
alter table public.host_private enable row level security;
alter table public.bookings enable row level security;

-- Everyone signed in can see names and published hours.
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy hosts_read on public.hosts for select to authenticated using (true);
create policy hosts_insert on public.hosts for insert to authenticated with check (user_id = auth.uid());
create policy hosts_update on public.hosts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy hosts_delete on public.hosts for delete to authenticated using (user_id = auth.uid());

create policy host_private_all on public.host_private for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Bookings: you only see meetings you are part of. All changes go through the functions below.
create policy bookings_read on public.bookings for select to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid());

-- Which times are taken, without revealing who booked them.
create or replace function public.busy_slots_all()
returns table (host_id uuid, start_at timestamptz, duration_min int)
language plpgsql security definer set search_path = public stable as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  return query
    select b.host_id, b.start_at, b.duration_min
    from public.bookings b
    where b.status = 'confirmed'
      and b.start_at > now() - interval '8 days'
      and b.start_at < now() + interval '45 days';
end $$;

create or replace function public.book_slot(p_host uuid, p_start timestamptz, p_topic text)
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
  if p_start < now() + interval '2 hours' then raise exception 'That time is too soon. Pick one at least 2 hours ahead.'; end if;
  if p_start > now() + interval '30 days' then raise exception 'That time is too far ahead.'; end if;

  perform pg_advisory_xact_lock(hashtext(p_host::text));

  local_ts := p_start at time zone hrow.tz;
  dow := extract(dow from local_ts)::int;
  tmin := extract(hour from local_ts)::int * 60 + extract(minute from local_ts)::int;

  for w in select e.v from jsonb_array_elements(coalesce(hrow.avail -> (dow::text), '[]'::jsonb)) as e(v) loop
    s_min := split_part(w ->> 's', ':', 1)::int * 60 + split_part(w ->> 's', ':', 2)::int;
    e_min := split_part(w ->> 'e', ':', 1)::int * 60 + split_part(w ->> 'e', ':', 2)::int;
    if tmin >= s_min and tmin + hrow.duration_min <= e_min and ((tmin - s_min) % hrow.duration_min) = 0 then
      ok := true;
    end if;
  end loop;
  if not ok then raise exception 'That is not one of this person''s open times.'; end if;

  if exists (
    select 1 from public.bookings b
    where b.host_id = p_host and b.status = 'confirmed'
      and p_start < b.start_at + make_interval(mins => b.duration_min)
      and p_start + make_interval(mins => hrow.duration_min) > b.start_at
  ) then raise exception 'That time was just taken. Pick another one.'; end if;

  select count(*), coalesce(sum(b.duration_min), 0) into n, mins
  from public.bookings b
  where b.host_id = p_host and b.status = 'confirmed'
    and date_trunc('week', b.start_at at time zone hrow.tz) = date_trunc('week', local_ts);
  if n >= hrow.max_per_week or mins + hrow.duration_min > hrow.max_hours_per_week * 60 then
    raise exception 'This person has reached their limit for that week.';
  end if;

  insert into public.bookings (host_id, guest_id, start_at, duration_min, topic)
  values (p_host, me, p_start, hrow.duration_min, left(coalesce(btrim(p_topic), ''), 140))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.cancel_booking(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.bookings%rowtype;
begin
  select * into b from public.bookings where id = p_id and (host_id = me or guest_id = me);
  if not found then raise exception 'Meeting not found.'; end if;
  if b.status = 'cancelled' then return; end if;
  update public.bookings
    set status = 'cancelled', cancelled_by = me, seen_by_host = (me = b.host_id)
    where id = p_id;
end $$;

create or replace function public.mark_seen()
returns void
language sql security definer set search_path = public as $$
  update public.bookings set seen_by_host = true where host_id = auth.uid() and seen_by_host = false;
$$;

revoke all on function public.busy_slots_all() from public, anon;
revoke all on function public.book_slot(uuid, timestamptz, text) from public, anon;
revoke all on function public.cancel_booking(uuid) from public, anon;
revoke all on function public.mark_seen() from public, anon;
grant execute on function public.busy_slots_all() to authenticated;
grant execute on function public.book_slot(uuid, timestamptz, text) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.mark_seen() to authenticated;

-- Live updates for people who have the page open.
alter publication supabase_realtime add table public.bookings;
alter publication supabase_realtime add table public.hosts;
