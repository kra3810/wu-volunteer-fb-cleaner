-- WU Volunteer FB Cleaner: Supabase / PostgreSQL schema
-- Run this entire file in Supabase Dashboard > SQL Editor.
-- Deliberately keeps the existing room-code-only experience. This means data is
-- publicly readable/writable by anyone with the Supabase anon key; see notes below.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  code text primary key check (code ~ '^WU-[0-9]{4}$'),
  name text not null default 'ใบงานไม่มีชื่อ',
  created_at timestamptz not null default now(),
  last_updated timestamptz not null default now(),
  is_deleted boolean not null default false
);

create table if not exists public.room_data (
  room_code text not null references public.rooms(code) on delete cascade,
  section text not null check (section in (
    'allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory', 'focus', 'cursors'
  )),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room_code, section)
);

-- Expand allowed JSON sections for collaborative focus/cursor presence.
alter table public.room_data drop constraint if exists room_data_section_check;
alter table public.room_data add constraint room_data_section_check
  check (section in ('allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory', 'focus', 'cursors'));

create index if not exists rooms_last_updated_idx
  on public.rooms (last_updated desc);

-- jsonb_set does not create missing intermediate objects. This helper does,
-- allowing legacy writes like fileScores/<file>/custom/<category> to work.
create or replace function public.jsonb_set_deep(target jsonb, path text[], val jsonb)
returns jsonb
language plpgsql
immutable
as $$
begin
  if coalesce(array_length(path, 1), 0) = 0 then
    return coalesce(val, 'null'::jsonb);
  end if;
  target := coalesce(target, '{}'::jsonb);
  if jsonb_typeof(target) not in ('object', 'array') then
    target := '{}'::jsonb;
  end if;
  if array_length(path, 1) = 1 then
    return jsonb_set(coalesce(target, '{}'::jsonb), path, val, true);
  end if;
  return jsonb_set(
    coalesce(target, '{}'::jsonb),
    array[path[1]],
    public.jsonb_set_deep(
      coalesce(target, '{}'::jsonb) -> path[1],
      path[2:array_length(path, 1)],
      val
    ),
    true
  );
end;
$$;

-- Atomic nested updates replace Firebase paths such as:
-- rooms/WU-1234/fileScores/file.csv/base
-- p_path is the path below the section root. Empty path replaces the section.
create or replace function public.patch_room_data(
  p_room_code text,
  p_section text,
  p_path text[],
  p_value jsonb default null,
  p_remove boolean default false
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_data jsonb;
  next_data jsonb;
begin
  if p_section not in ('allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory', 'focus', 'cursors') then
    raise exception 'Invalid room data section';
  end if;

  insert into public.room_data (room_code, section, data)
  values (p_room_code, p_section, '{}'::jsonb)
  on conflict (room_code, section) do nothing;

  select data into current_data
  from public.room_data
  where room_code = p_room_code and section = p_section
  for update;

  if coalesce(array_length(p_path, 1), 0) = 0 then
    next_data := case when p_remove then '{}'::jsonb else coalesce(p_value, '{}'::jsonb) end;
  elsif p_remove then
    next_data := coalesce(current_data, '{}'::jsonb) #- p_path;
  else
    -- Firebase keys are encoded by the existing frontend, so path elements
    -- are safe JSON object keys. jsonb_set is atomic for existing parent paths.
    next_data := public.jsonb_set_deep(coalesce(current_data, '{}'::jsonb), p_path, p_value);
  end if;

  update public.room_data
  set data = next_data, updated_at = now()
  where room_code = p_room_code and section = p_section;

  update public.rooms set last_updated = now() where code = p_room_code;
end;
$$;

-- This project intentionally has no sign-in. These permissive policies preserve
-- the current "anyone with the room code can collaborate" behavior.
alter table public.rooms enable row level security;
alter table public.room_data enable row level security;

drop policy if exists "rooms public access" on public.rooms;
create policy "rooms public access" on public.rooms
  for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "room_data public access" on public.room_data;
create policy "room_data public access" on public.room_data
  for all to anon, authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.rooms to anon, authenticated;
grant select, insert, update, delete on public.room_data to anon, authenticated;
grant execute on function public.patch_room_data(text, text, text[], jsonb, boolean)
  to anon, authenticated;

-- Enable Postgres Changes for the two tables used by the browser.
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
when undefined_object then
  raise notice 'supabase_realtime publication is not available yet; enable Realtime for rooms and room_data in the dashboard.';
end $$;

do $$
begin
  alter publication supabase_realtime add table public.room_data;
exception when duplicate_object then null;
when undefined_object then
  raise notice 'Enable Realtime for room_data in the Supabase dashboard.';
end $$;
