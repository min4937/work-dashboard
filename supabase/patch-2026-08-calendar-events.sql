-- ----------------------------------------------------------------------------
-- 2026-08 패치 · 달력 중요일정 (업무일지와 별개)
--
--   visibility = 'personal'  나만 본다
--   visibility = 'team'      같은 팀 전원이 본다 (고치고 지우는 건 만든 사람만)
--
-- Supabase SQL Editor 에 붙여넣고 Run 하면 된다. (schema.sql 전체를 다시
-- 실행해도 같은 결과가 된다. 여러 번 실행해도 안전하다)
-- ----------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete cascade,
  event_date date not null,
  title      text not null,
  visibility text not null default 'personal' check (visibility in ('personal', 'team')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_events_date_idx on public.calendar_events (event_date);
create index if not exists calendar_events_user_idx on public.calendar_events (user_id);

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select to authenticated
  using (
    user_id = auth.uid()
    or (visibility = 'team' and team_id is not null and team_id = public.current_team_id())
  );

drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (visibility = 'personal' or team_id = public.current_team_id())
  );

drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (visibility = 'personal' or team_id = public.current_team_id())
  );

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events
  for delete to authenticated using (user_id = auth.uid());
