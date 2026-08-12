-- ============================================================================
-- 회사생활 대시보드 · Supabase 스키마 (v1)
--
-- 실행 방법
--   Supabase 대시보드 → SQL Editor → 이 파일 전체 붙여넣기 → Run
--   여러 번 실행해도 안전하다 (idempotent).
--
-- 실행 후 반드시 할 일은 파일 맨 아래 [초기 설정] 섹션 참고.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. 공통 헬퍼
--    (테이블을 참조하는 is_payroll_manager 는 테이블 생성 뒤인 1-2 절에 있다.
--     language sql 함수는 생성 시점에 본문을 검증하므로 순서를 지켜야 한다.)
-- ----------------------------------------------------------------------------

-- updated_at 자동 갱신 트리거
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 팀원 프로필 (팀 전체에 공개되는 최소 정보)
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  job_title    text not null default '',
  sort_order   integer not null default 950,
  updated_at   timestamptz not null default now()
);

-- 일일 업무일지 (팀 전체 공유 · 야근/연차의 단일 진실 공급원)
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

-- 급여 프로필 (월급관리자 집계용 · 급여 관련 항목만 담는다)
create table if not exists public.salary_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 개인 전체 상태 (설정·월간기록·주간메모) · 기기 간 양방향 동기화용
-- 본인 외에는 월급관리자도 읽을 수 없다.
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

-- 연차 신청
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

-- 팀 공통 설정 (id = 1 단일 행)
create table if not exists public.team_settings (
  id         integer primary key default 1,
  team_name  text not null default '우리 팀',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint team_settings_single_row check (id = 1)
);

insert into public.team_settings (id, team_name)
values (1, '우리 팀')
on conflict (id) do nothing;

-- 권한 (월급관리자)
create table if not exists public.team_roles (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  payroll_manager boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- 공유 문서 메타데이터 (실제 파일은 Storage 의 team-documents 버킷)
create table if not exists public.team_files (
  id           bigint generated always as identity primary key,
  file_name    text not null,
  storage_path text not null unique,
  file_size    bigint not null default 0,
  uploaded_by  uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- 공휴일 · 코드를 고치지 않고 매년 여기에 INSERT 하면 달력에 반영된다.
-- (기존에는 index.html 안에 2026~2027 만 하드코딩되어 있었다)
create table if not exists public.holidays (
  holiday_date date primary key,
  name         text not null
);


-- ----------------------------------------------------------------------------
-- 1-2. 권한 판정 헬퍼 (team_roles 테이블이 만들어진 뒤에 정의해야 한다)
--
-- SECURITY DEFINER 로 두어야 team_roles 를 참조하는 정책이 다시 team_roles 의
-- 정책을 평가하는 무한 재귀를 피할 수 있다.
-- ----------------------------------------------------------------------------

create or replace function public.is_payroll_manager(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_roles
    where user_id = uid and payroll_manager = true
  );
$$;


-- ----------------------------------------------------------------------------
-- 2. RLS 활성화
-- ----------------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.daily_logs     enable row level security;
alter table public.salary_profiles enable row level security;
alter table public.user_state     enable row level security;
alter table public.leave_requests enable row level security;
alter table public.team_settings  enable row level security;
alter table public.team_roles     enable row level security;
alter table public.team_files     enable row level security;
alter table public.holidays       enable row level security;


-- ----------------------------------------------------------------------------
-- 3. 정책
--    원칙: 팀 공유가 필요한 것만 전체 열람, 쓰기는 언제나 본인 행만.
-- ----------------------------------------------------------------------------

-- profiles: 팀 전원 열람, 본인 행만 쓰기
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- daily_logs: 팀 전원 열람(업무일지 공유가 목적), 본인 행만 쓰기
drop policy if exists daily_logs_select on public.daily_logs;
create policy daily_logs_select on public.daily_logs
  for select to authenticated using (true);

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


-- salary_profiles: ★핵심★ 본인 또는 월급관리자만 열람.
-- 이 정책이 없으면 로그인한 팀원 누구나 개발자도구로 전원 급여를 볼 수 있다.
-- 쓰기는 관리자라도 불가 — 오직 본인만.
drop policy if exists salary_profiles_select on public.salary_profiles;
create policy salary_profiles_select on public.salary_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_payroll_manager());

drop policy if exists salary_profiles_insert on public.salary_profiles;
create policy salary_profiles_insert on public.salary_profiles
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists salary_profiles_update on public.salary_profiles;
create policy salary_profiles_update on public.salary_profiles
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- user_state: 오직 본인. 월급관리자도 열람 불가.
drop policy if exists user_state_all on public.user_state;
create policy user_state_all on public.user_state
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- leave_requests: 팀 전원 열람(누가 언제 쉬는지 공유), 본인 것만 쓰기
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
  for select to authenticated using (true);

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


-- team_settings: 전원 열람, 월급관리자만 수정
drop policy if exists team_settings_select on public.team_settings;
create policy team_settings_select on public.team_settings
  for select to authenticated using (true);

drop policy if exists team_settings_update on public.team_settings;
create policy team_settings_update on public.team_settings
  for update to authenticated
  using (public.is_payroll_manager()) with check (public.is_payroll_manager());


-- team_roles: 전원 열람, 직접 쓰기는 전면 금지.
-- 권한 변경은 아래 set_payroll_manager RPC 를 통해서만 가능하다.
drop policy if exists team_roles_select on public.team_roles;
create policy team_roles_select on public.team_roles
  for select to authenticated using (true);


-- team_files: 전원 열람/업로드, 삭제는 올린 사람 또는 월급관리자
drop policy if exists team_files_select on public.team_files;
create policy team_files_select on public.team_files
  for select to authenticated using (true);

drop policy if exists team_files_insert on public.team_files;
create policy team_files_insert on public.team_files
  for insert to authenticated with check (uploaded_by = auth.uid());

drop policy if exists team_files_delete on public.team_files;
create policy team_files_delete on public.team_files
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_payroll_manager());


-- holidays: 로그인 전에도 달력에 표시돼야 하므로 anon 도 열람 가능. 쓰기는 관리자만.
drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays
  for select to anon, authenticated using (true);

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays
  for all to authenticated
  using (public.is_payroll_manager()) with check (public.is_payroll_manager());


-- ----------------------------------------------------------------------------
-- 4. RPC · 월급관리자 권한 부여/해제
-- ----------------------------------------------------------------------------

create or replace function public.set_payroll_manager(target_user_id uuid, enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  manager_count integer;
begin
  if not public.is_payroll_manager() then
    raise exception '월급관리자만 권한을 변경할 수 있습니다.';
  end if;

  -- 마지막 남은 관리자가 스스로를 해제해 아무도 관리할 수 없게 되는 상황을 막는다.
  if enabled = false then
    select count(*) into manager_count from public.team_roles where payroll_manager = true;
    if manager_count <= 1 then
      raise exception '월급관리자는 최소 1명 이상 있어야 합니다.';
    end if;
  end if;

  insert into public.team_roles (user_id, payroll_manager, updated_at)
  values (target_user_id, enabled, now())
  on conflict (user_id)
  do update set payroll_manager = excluded.payroll_manager, updated_at = now();
end;
$$;

revoke all on function public.set_payroll_manager(uuid, boolean) from public;
grant execute on function public.set_payroll_manager(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Storage · 공유 문서 버킷
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('team-documents', 'team-documents', false)
on conflict (id) do nothing;

drop policy if exists team_documents_select on storage.objects;
create policy team_documents_select on storage.objects
  for select to authenticated using (bucket_id = 'team-documents');

drop policy if exists team_documents_insert on storage.objects;
create policy team_documents_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'team-documents');

drop policy if exists team_documents_delete on storage.objects;
create policy team_documents_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'team-documents' and (owner = auth.uid() or public.is_payroll_manager()));


-- ----------------------------------------------------------------------------
-- 6. Realtime · 일일업무일지 실시간 반영
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daily_logs'
  ) then
    alter publication supabase_realtime add table public.daily_logs;
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
-- [초기 설정] 위 스크립트 실행 후 아래 순서로 진행할 것
--
-- 1) 팀원 계정 등록
--    Authentication → Users → "Add user" → Send invitation
--    (앱은 shouldCreateUser:false 로 동작하므로, 여기 등록되지 않은 이메일은
--     로그인 링크 자체를 받을 수 없다. 이게 외부인 차단 장치다.)
--
-- 2) 첫 월급관리자 지정 — RPC 는 이미 관리자인 사람만 호출할 수 있으므로
--    최초 1명은 아래 SQL 로 직접 넣어야 한다. 이메일만 본인 것으로 바꿔 실행:
--
--      insert into public.team_roles (user_id, payroll_manager)
--      select id, true from auth.users where email = 'you@example.com'
--      on conflict (user_id) do update set payroll_manager = true;
--
--    이후 나머지 관리자 지정/해제는 앱의 [팀 정보] 화면에서 하면 된다.
--
-- 3) 로그인 리다이렉트 URL 등록
--    Authentication → URL Configuration → Redirect URLs 에 아래 두 개 추가:
--      https://<깃허브아이디>.github.io/<리포지토리이름>/
--      http://localhost:8000/          (로컬 테스트용)
--
-- 4) assets/config.js 에 프로젝트 URL 과 publishable key 입력
--    Settings → API 에서 확인. publishable(anon) key 는 공개돼도 안전하다 —
--    실제 접근 통제는 위의 RLS 정책이 담당한다. service_role key 는 절대 넣지 말 것.
-- ============================================================================
