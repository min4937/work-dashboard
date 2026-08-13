-- ----------------------------------------------------------------------------
-- 2026-08 패치 · 팀 공지사항 (월간일정표 오른쪽)
--
-- 팀당 한 건. 같은 팀이면 누구나 읽고, 쓰기는 팀장만 할 수 있다.
-- Supabase SQL Editor 에 붙여넣고 Run 하면 된다. (schema.sql 전체를 다시
-- 실행해도 같은 결과가 된다. 여러 번 실행해도 안전하다)
-- ----------------------------------------------------------------------------

create table if not exists public.team_notices (
  team_id    uuid primary key references public.teams(id) on delete cascade,
  content    text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.team_notices enable row level security;

drop policy if exists team_notices_select on public.team_notices;
create policy team_notices_select on public.team_notices
  for select to authenticated
  using (team_id = public.current_team_id());

drop policy if exists team_notices_insert on public.team_notices;
create policy team_notices_insert on public.team_notices
  for insert to authenticated
  with check (team_id = public.current_team_id() and public.is_team_leader());

drop policy if exists team_notices_update on public.team_notices;
create policy team_notices_update on public.team_notices
  for update to authenticated
  using (team_id = public.current_team_id() and public.is_team_leader())
  with check (team_id = public.current_team_id() and public.is_team_leader());

-- 팀장이 공지를 고치면 팀원 화면에 즉시 반영되도록 Realtime 에 올린다.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_notices'
  ) then
    alter publication supabase_realtime add table public.team_notices;
  end if;
end;
$$;
