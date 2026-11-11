-- WU Volunteer FB Cleaner: remove empty rooms imported from Firebase
-- Run in Supabase Dashboard > SQL Editor.
--
-- Definition:
-- A room is EMPTY when it has no non-empty persistent data in any of:
-- allFilesData, fileScores, rawThreadsData, modeMemory.
-- focus/cursors are transient collaboration state and do not make a room valid.
--
-- STEP 1: Preview the exact rooms that match the cleanup rule.
select
  r.code,
  r.name,
  r.created_at,
  r.is_deleted,
  coalesce((
    select jsonb_object_agg(d.section, jsonb_typeof(d.data))
    from public.room_data d
    where d.room_code = r.code
      and d.section in ('allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory')
      and d.data is not null
      and d.data not in ('null'::jsonb, '{}'::jsonb, '[]'::jsonb)
  ), '{}'::jsonb) as persistent_data_found
from public.rooms r
where not exists (
  select 1
  from public.room_data d
  where d.room_code = r.code
    and d.section in ('allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory')
    and d.data is not null
    and d.data not in ('null'::jsonb, '{}'::jsonb, '[]'::jsonb)
)
order by r.created_at desc;

-- STEP 2: When ready, run this DELETE statement.
-- It deletes ONLY rooms matching the empty-room rule above.
-- room_data rows are removed automatically by ON DELETE CASCADE.
-- The returned rows are the rooms actually deleted.
delete from public.rooms r
where not exists (
  select 1
  from public.room_data d
  where d.room_code = r.code
    and d.section in ('allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory')
    and d.data is not null
    and d.data not in ('null'::jsonb, '{}'::jsonb, '[]'::jsonb)
)
returning r.code, r.name, r.created_at;
