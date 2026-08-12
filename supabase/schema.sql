-- ============================================================================
-- 회사생활 대시보드 · Supabase 스키마 (v2)
--
-- v1 대비 달라진 점
--   · 로그인: 매직링크 → 이메일 + 비밀번호 (최초 가입 때만 메일 인증)
--   · 소속: 단일 팀 고정 → 팀장이 만든 팀에 초대코드로 참여
--   · 급여: 팀 공유 폐지. 월급은 완전히 개인 데이터가 되어 아무도 못 본다
--   · 상태바: member_status 신설 (출근/자리비움/퇴근 실시간 공유)
--
-- 실행 방법
--   Supabase 대시보드 → SQL Editor → 이 파일 전체 붙여넣기 → Run
--   여러 번 실행해도 안전하다 (idempotent).
--
-- 실행 후 할 일은 파일 맨 아래 [초기 설정] 참고.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. 공통 헬퍼 (테이블을 참조하지 않는 것만 먼저 정의한다)
-- ----------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 초대코드 8자리. 헷갈리는 글자(0/O, 1/I)는 뺐다.
create or replace function public.generate_invite_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), ''
  )
  from generate_series(1, 8);
$$;


-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 팀. 팀장 1명이 만들고, 초대코드로 팀원을 받는다.
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '우리 팀',
  leader_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_leader_idx on public.teams (leader_id);

-- 초대코드는 팀장만 볼 수 있어야 하므로 teams 와 분리한다.
-- (RLS 는 행 단위라 한 테이블 안에서 특정 컬럼만 가릴 수 없다)
create table if not exists public.team_invites (
  team_id    uuid primary key references public.teams(id) on delete cascade,
  code       text not null unique,
  updated_at timestamptz not null default now()
);

-- 팀원 프로필. team_id 가 null 이면 아직 어느 팀에도 속하지 않은 상태다.
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  team_id      uuid references public.teams(id) on delete set null,
  display_name text not null default '',
  job_title    text not null default '',
  sort_order   integer not null default 950,
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_team_idx on public.profiles (team_id);

-- 일일 업무일지 (같은 팀끼리 공유 · 야근/연차 상태의 단일 진실 공급원)
create table if not exists public.daily_logs (
  user_id        uuid not null references auth.users(id) on delete cascade,
  work_date      date not null,
  morning        text not null default '',
  afternoon      text not null default '',
  overtime       text not null default '',
  start_time     text,
  end_time       text,
  overtime_hours numeric(4,2) not null default 0,
  work_status    text not null default '정상근무',
  updated_at     timestamptz not null default now(),
  primary key (user_id, work_date)
);

create index if not exists daily_logs_work_date_idx on public.daily_logs (work_date);

-- 연차 신청 (같은 팀 공유 · 누가 언제 쉬는지 일정 조율용)
-- 개인별 총연차/사용/잔여 일수는 여기 없다. user_state 에만 있고 본인만 본다.
create table if not exists public.leave_requests (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  leave_date date not null,
  leave_type text not null default '연차',
  note       text not null default '',
  status     text not null default '신청',
  created_at timestamptz not null default now(),
  unique (user_id, leave_date)
);

-- 근무 상태 (왼쪽 상태바)
create table if not exists public.member_status (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  status      text not null default 'off' check (status in ('working', 'away', 'off')),
  status_date date not null default current_date,
  updated_at  timestamptz not null default now()
);

-- 공유 문서 메타데이터 (실제 파일은 Storage 의 team-documents 버킷)
create table if not exists public.team_files (
  id           bigint generated always as identity primary key,
  uploader_id  uuid not null references auth.users(id) on delete cascade,
  file_name    text not null,
  storage_path text not null unique,
  file_size    bigint not null default 0,
  mime_type    text not null default '',
  category     text not null default '기타',
  note         text not null default '',
  created_at   timestamptz not null default now()
);

create index if not exists team_files_uploader_idx on public.team_files (uploader_id);

-- 개인 전체 상태 (설정·급여·연차일수·월간기록·주간메모)
-- ★ 오직 본인만 읽고 쓴다. 팀장도 열람할 수 없다. ★
create table if not exists public.user_state (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  settings     jsonb not null default '{}'::jsonb,
  records      jsonb not null default '{}'::jsonb,
  weekly_memos jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

drop trigger if exists user_state_touch on public.user_state;
create trigger user_state_touch
  before update on public.user_state
  for each row execute function public.touch_updated_at();

-- 공휴일 · 코드를 고치지 않고 매년 INSERT 로 갱신한다.
create table if not exists public.holidays (
  holiday_date date primary key,
  name         text not null
);


-- ----------------------------------------------------------------------------
-- 1-2. 권한 판정 헬퍼 (테이블 생성 뒤에 정의해야 한다)
--
-- 전부 SECURITY DEFINER 다. 정책 안에서 profiles/teams 를 다시 조회할 때
-- 그 테이블의 RLS 가 또 평가되어 무한 재귀에 빠지는 것을 막는다.
-- ----------------------------------------------------------------------------

-- 지금 로그인한 사람의 소속 팀
create or replace function public.current_team_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id from public.profiles where user_id = auth.uid();
$$;

-- 지금 로그인한 사람이 자기 팀의 팀장인가
create or replace function public.is_team_leader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.teams
    where leader_id = auth.uid() and id = public.current_team_id()
  );
$$;

-- 대상 사용자가 나와 같은 팀인가 (팀 미소속끼리 서로 보이는 일이 없도록 null 제외)
create or replace function public.is_same_team(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = uid
      and p.team_id is not null
      and p.team_id = public.current_team_id()
  );
$$;


-- ----------------------------------------------------------------------------
-- 2. RLS 활성화
-- ----------------------------------------------------------------------------

alter table public.teams          enable row level security;
alter table public.team_invites   enable row level security;
alter table public.profiles       enable row level security;
alter table public.daily_logs     enable row level security;
alter table public.leave_requests enable row level security;
alter table public.member_status  enable row level security;
alter table public.team_files     enable row level security;
alter table public.user_state     enable row level security;
alter table public.holidays       enable row level security;


-- ----------------------------------------------------------------------------
-- 3. 정책
--
--   읽기: 같은 팀이면 서로 열람 (업무일지·연차신청·상태·공유문서)
--   쓰기: 언제나 본인 행만. 팀장도 남의 데이터는 고칠 수 없다.
--   예외: user_state 는 읽기까지 본인만 (급여·연차일수가 여기 들어있다)
-- ----------------------------------------------------------------------------

-- teams: 내 팀만 열람, 이름 변경은 팀장만
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated
  using (id = public.current_team_id() or leader_id = auth.uid());

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update to authenticated
  using (leader_id = auth.uid()) with check (leader_id = auth.uid());

-- 팀 생성은 create_team RPC 로만 (직접 INSERT 정책을 두지 않는다)


-- team_invites: 초대코드는 팀장만 볼 수 있다.
-- 팀원이 가입할 때의 코드 조회는 join_team RPC(SECURITY DEFINER)가 대신한다.
drop policy if exists team_invites_select on public.team_invites;
create policy team_invites_select on public.team_invites
  for select to authenticated
  using (team_id = public.current_team_id() and public.is_team_leader());


-- profiles: 같은 팀끼리 열람 + 본인 행은 언제나. 쓰기는 본인만.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or (team_id is not null and team_id = public.current_team_id())
  );

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- daily_logs: 같은 팀 열람, 본인만 수정
drop policy if exists daily_logs_select on public.daily_logs;
create policy daily_logs_select on public.daily_logs
  for select to authenticated
  using (user_id = auth.uid() or public.is_same_team(user_id));

drop policy if exists daily_logs_insert on public.daily_logs;
create policy daily_logs_insert on public.daily_logs
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists daily_logs_update on public.daily_logs;
create policy daily_logs_update on public.daily_logs
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists daily_logs_delete on public.daily_logs;
create policy daily_logs_delete on public.daily_logs
  for delete to authenticated using (user_id = auth.uid());


-- leave_requests: 같은 팀 열람(팀장 포함), 본인만 신청/취소
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_same_team(user_id));

drop policy if exists leave_requests_insert on public.leave_requests;
create policy leave_requests_insert on public.leave_requests
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists leave_requests_update on public.leave_requests;
create policy leave_requests_update on public.leave_requests
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists leave_requests_delete on public.leave_requests;
create policy leave_requests_delete on public.leave_requests
  for delete to authenticated using (user_id = auth.uid());


-- member_status: 같은 팀 열람, 본인 것만 변경
drop policy if exists member_status_select on public.member_status;
create policy member_status_select on public.member_status
  for select to authenticated
  using (user_id = auth.uid() or public.is_same_team(user_id));

drop policy if exists member_status_insert on public.member_status;
create policy member_status_insert on public.member_status
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists member_status_update on public.member_status;
create policy member_status_update on public.member_status
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- team_files: 같은 팀 열람 · 전원 업로드 가능 · 삭제는 올린 사람만
-- (팀장이라도 남이 올린 파일은 지우거나 고칠 수 없다)
drop policy if exists team_files_select on public.team_files;
create policy team_files_select on public.team_files
  for select to authenticated
  using (uploader_id = auth.uid() or public.is_same_team(uploader_id));

drop policy if exists team_files_insert on public.team_files;
create policy team_files_insert on public.team_files
  for insert to authenticated with check (uploader_id = auth.uid());

drop policy if exists team_files_update on public.team_files;
create policy team_files_update on public.team_files
  for update to authenticated
  using (uploader_id = auth.uid()) with check (uploader_id = auth.uid());

drop policy if exists team_files_delete on public.team_files;
create policy team_files_delete on public.team_files
  for delete to authenticated using (uploader_id = auth.uid());


-- user_state: 읽기까지 본인만. 팀장도 열람 불가.
drop policy if exists user_state_all on public.user_state;
create policy user_state_all on public.user_state
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- holidays: 로그인 전에도 달력에 필요하므로 익명 열람 허용. 쓰기는 팀장만.
drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays
  for select to anon, authenticated using (true);

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays
  for all to authenticated
  using (public.is_team_leader()) with check (public.is_team_leader());


-- ----------------------------------------------------------------------------
-- 4. RPC · 팀 생성 / 참여 / 초대코드 재발급
-- ----------------------------------------------------------------------------

-- 팀장이 새 팀을 만든다. 반환값은 팀원에게 알려줄 초대코드.
create or replace function public.create_team(
  team_name    text,
  display_name text,
  job_title    text default ''
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  new_team uuid;
  new_code text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  if exists (select 1 from public.profiles where user_id = auth.uid() and team_id is not null) then
    raise exception '이미 소속된 팀이 있습니다.';
  end if;

  insert into public.teams (name, leader_id)
  values (coalesce(nullif(btrim(team_name), ''), '우리 팀'), auth.uid())
  returning id into new_team;

  -- 코드가 겹치면 다시 뽑는다
  loop
    new_code := public.generate_invite_code();
    exit when not exists (select 1 from public.team_invites i where i.code = new_code);
  end loop;

  insert into public.team_invites (team_id, code) values (new_team, new_code);

  insert into public.profiles (user_id, team_id, display_name, job_title, sort_order)
  values (
    auth.uid(),
    new_team,
    coalesce(nullif(btrim(display_name), ''), '팀장'),
    coalesce(job_title, ''),
    950
  )
  on conflict (user_id) do update
    set team_id      = excluded.team_id,
        display_name = excluded.display_name,
        job_title    = excluded.job_title,
        updated_at   = now();

  return new_code;
end;
$$;


-- 팀원이 초대코드로 참여한다. 반환값은 참여한 팀의 id.
create or replace function public.join_team(
  invite_code  text,
  display_name text,
  job_title    text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
  mine   uuid;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select team_id into target
  from public.team_invites
  where upper(btrim(code)) = upper(btrim(invite_code));

  if target is null then
    raise exception '초대코드가 올바르지 않습니다.';
  end if;

  select team_id into mine from public.profiles where user_id = auth.uid();
  if mine is not null and mine <> target then
    raise exception '이미 다른 팀에 소속되어 있습니다.';
  end if;

  insert into public.profiles (user_id, team_id, display_name, job_title, sort_order)
  values (
    auth.uid(),
    target,
    coalesce(nullif(btrim(display_name), ''), '팀원'),
    coalesce(job_title, ''),
    950
  )
  on conflict (user_id) do update
    set team_id      = excluded.team_id,
        display_name = excluded.display_name,
        job_title    = excluded.job_title,
        updated_at   = now();

  return target;
end;
$$;


-- 초대코드 재발급. 코드가 외부로 샜을 때 팀장이 돌린다.
create or replace function public.rotate_invite_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  my_team  uuid;
  new_code text;
begin
  if not public.is_team_leader() then
    raise exception '팀장만 초대코드를 재발급할 수 있습니다.';
  end if;

  my_team := public.current_team_id();

  loop
    new_code := public.generate_invite_code();
    exit when not exists (select 1 from public.team_invites i where i.code = new_code);
  end loop;

  update public.team_invites
  set code = new_code, updated_at = now()
  where team_id = my_team;

  return new_code;
end;
$$;


revoke all on function public.create_team(text, text, text)  from public;
revoke all on function public.join_team(text, text, text)    from public;
revoke all on function public.rotate_invite_code()           from public;
revoke all on function public.generate_invite_code()         from public;

grant execute on function public.create_team(text, text, text) to authenticated;
grant execute on function public.join_team(text, text, text)   to authenticated;
grant execute on function public.rotate_invite_code()          to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Storage · 공유 문서 버킷
--
-- 파일 경로는 <team_id>/<user_id>/<파일명> 이다.
-- 첫 번째 폴더로 팀을 가르고, 두 번째 폴더로 소유자를 가른다.
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('team-documents', 'team-documents', false)
on conflict (id) do nothing;

drop policy if exists team_documents_select on storage.objects;
create policy team_documents_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-documents'
    and (storage.foldername(name))[1] = public.current_team_id()::text
  );

drop policy if exists team_documents_insert on storage.objects;
create policy team_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-documents'
    and (storage.foldername(name))[1] = public.current_team_id()::text
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- 남이 올린 파일은 지울 수 없다 (팀장도 마찬가지)
drop policy if exists team_documents_delete on storage.objects;
create policy team_documents_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-documents'
    and (storage.foldername(name))[2] = auth.uid()::text
  );


-- ----------------------------------------------------------------------------
-- 6. Realtime · 업무일지와 상태바 실시간 반영
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daily_logs'
  ) then
    alter publication supabase_realtime add table public.daily_logs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'member_status'
  ) then
    alter publication supabase_realtime add table public.member_status;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. 공휴일 초기 데이터 (2026 ~ 2027)
--    이후 연도는 확정될 때마다 같은 형식으로 INSERT 만 추가하면 된다.
-- ----------------------------------------------------------------------------

insert into public.holidays (holiday_date, name) values
  ('2026-01-01','신정'),
  ('2026-02-16','설날 연휴'),
  ('2026-02-17','설날'),
  ('2026-02-18','설날 연휴'),
  ('2026-03-01','삼일절'),
  ('2026-03-02','삼일절 대체공휴일'),
  ('2026-05-01','노동절'),
  ('2026-05-05','어린이날'),
  ('2026-05-24','부처님오신날'),
  ('2026-05-25','부처님오신날 대체공휴일'),
  ('2026-06-03','전국동시지방선거일'),
  ('2026-06-06','현충일'),
  ('2026-07-17','제헌절'),
  ('2026-08-15','광복절'),
  ('2026-08-17','광복절 대체공휴일'),
  ('2026-09-24','추석 연휴'),
  ('2026-09-25','추석'),
  ('2026-09-26','추석 연휴'),
  ('2026-10-03','개천절'),
  ('2026-10-05','개천절 대체공휴일'),
  ('2026-10-09','한글날'),
  ('2026-12-25','기독탄신일'),
  ('2027-01-01','신정'),
  ('2027-02-06','설날 연휴'),
  ('2027-02-07','설날'),
  ('2027-02-08','설날 연휴'),
  ('2027-02-09','설날 대체공휴일'),
  ('2027-03-01','삼일절'),
  ('2027-05-01','노동절'),
  ('2027-05-03','노동절 대체공휴일'),
  ('2027-05-05','어린이날'),
  ('2027-05-13','부처님오신날'),
  ('2027-06-06','현충일'),
  ('2027-07-17','제헌절'),
  ('2027-07-19','제헌절 대체공휴일'),
  ('2027-08-15','광복절'),
  ('2027-08-16','광복절 대체공휴일'),
  ('2027-09-14','추석 연휴'),
  ('2027-09-15','추석'),
  ('2027-09-16','추석 연휴'),
  ('2027-10-03','개천절'),
  ('2027-10-04','개천절 대체공휴일'),
  ('2027-10-09','한글날'),
  ('2027-10-11','한글날 대체공휴일'),
  ('2027-12-25','기독탄신일'),
  ('2027-12-27','기독탄신일 대체공휴일')
on conflict (holiday_date) do nothing;


-- ============================================================================
-- [초기 설정] 위 스크립트 실행 후
--
-- 1) 이메일 + 비밀번호 로그인 켜기
--    Authentication → Sign In / Providers → Email 사용
--      · "Confirm email" 켜기   → 가입 때 한 번만 메일 인증한다
--      · "Allow new users to sign up" 켜두기
--        (초대코드가 없으면 팀에 들어올 수 없으므로, 가입 자체는 열어둬도
--         남의 팀 데이터는 보이지 않는다)
--
-- 2) URL 등록
--    Authentication → URL Configuration
--      Site URL      : https://<깃허브아이디>.github.io/<리포지토리>/
--      Redirect URLs : 같은 주소 + http://localhost:8000/
--
-- 3) 커스텀 SMTP 연결 (사실상 필수)
--    Authentication → Emails → SMTP Settings
--    기본 내장 메일은 발송량이 매우 적어서 팀원 가입 인증 메일이 막힌다.
--
-- 4) 첫 팀장 계정은 앱에서 직접 만든다
--    사이트 → 로그인 → [회원가입] → "팀장으로 새 팀 만들기" 체크 → 팀 이름 입력
--    가입 메일 인증 후 로그인하면 [팀 정보]에 초대코드가 나온다.
--    이 코드를 팀원에게 알려주면 팀원은 가입 화면에서 코드를 넣고 참여한다.
--    → SQL 로 손댈 일이 없다.
--
-- 5) assets/config.js 에 Project URL 과 Publishable key 입력
--    Settings → API. publishable(anon) key 는 공개돼도 안전하다.
--    service_role key 는 절대 넣지 말 것.
-- ============================================================================
