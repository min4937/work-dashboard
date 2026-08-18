-- ----------------------------------------------------------------------------
-- 2026-08 패치 · KOSIS 통계자료 탭 (지표 카탈로그)
--
-- 보고서 양식에 넣을 통계 지표를 팀이 함께 관리하는 표다. 한 번 찾아낸
-- 통계표(orgId/tblId)를 여기 적어두면 다음부터는 지역만 바꿔 재사용한다.
--
-- 같은 팀이면 누구나 읽고 추가할 수 있고, 고치거나 지우는 건 등록한 사람과
-- 팀장만 할 수 있다. (통계 담당이 팀장이 아닌 경우가 많아 추가는 열어둔다)
--
-- Supabase SQL Editor 에 붙여넣고 Run 하면 된다. 여러 번 실행해도 안전하다.
-- ----------------------------------------------------------------------------

create table if not exists public.kosis_indicators (
  id            bigint generated always as identity primary key,
  team_id       uuid not null references public.teams(id) on delete cascade,

  -- 문서 플레이스홀더로 쓰이는 키. 예: 총인구  ->  {{총인구}}
  key           text not null,
  label         text not null,

  -- KOSIS 통계표 식별자. 통계자료 탭의 '통계표 찾기'로 확보한다.
  org_id        text not null,
  tbl_id        text not null,
  itm_id        text not null default '',

  prd_se        text not null default 'Y',      -- Y=연 Q=분기 M=월
  periods       integer not null default 2,     -- 2 이상이어야 증감 문구가 나온다
  region_param  text not null default 'objL1',
  region_scheme text not null default 'stat2',  -- stat2(2자리) | admin8(8자리)
  extra_params  jsonb not null default '{}'::jsonb,

  unit          text not null default '',       -- 비우면 KOSIS 의 단위를 쓴다
  digits        integer not null default 0,

  -- 본문 삽입 문장 틀.
  --   값   : {지역} {지표} {값} {단위} {시점} {증감} {출처}
  --   조사 : {은는} {이가} {을를} {와과} {으로로}  (앞 글자 받침을 보고 자동 선택)
  sentence      text not null default '{지역}의 {지표}{은는} {시점} 기준 {값}{단위}이다.',

  sort_order    integer not null default 0,
  verified      boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (team_id, key)
);

create index if not exists kosis_indicators_team_idx
  on public.kosis_indicators (team_id, sort_order, id);

alter table public.kosis_indicators enable row level security;

drop policy if exists kosis_indicators_select on public.kosis_indicators;
create policy kosis_indicators_select on public.kosis_indicators
  for select to authenticated
  using (team_id = public.current_team_id());

drop policy if exists kosis_indicators_insert on public.kosis_indicators;
create policy kosis_indicators_insert on public.kosis_indicators
  for insert to authenticated
  with check (team_id = public.current_team_id() and created_by = auth.uid());

drop policy if exists kosis_indicators_update on public.kosis_indicators;
create policy kosis_indicators_update on public.kosis_indicators
  for update to authenticated
  using (team_id = public.current_team_id() and (created_by = auth.uid() or public.is_team_leader()))
  with check (team_id = public.current_team_id());

drop policy if exists kosis_indicators_delete on public.kosis_indicators;
create policy kosis_indicators_delete on public.kosis_indicators
  for delete to authenticated
  using (team_id = public.current_team_id() and (created_by = auth.uid() or public.is_team_leader()));
