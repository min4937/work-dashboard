-- ----------------------------------------------------------------------------
-- 2026-08 패치 · 근무 상태에 '외근(field)' 추가
--
-- 이미 schema.sql 을 한 번 실행한 프로젝트는 member_status 의 CHECK 제약이
-- ('working','away','off') 로 남아 있어서 외근 버튼을 누르면 저장이 실패한다.
-- 이 파일만 Supabase SQL Editor 에 붙여넣고 Run 하면 된다. (schema.sql 전체를
-- 다시 실행해도 같은 결과가 된다)
-- ----------------------------------------------------------------------------

alter table public.member_status drop constraint if exists member_status_status_check;
alter table public.member_status add constraint member_status_status_check
  check (status in ('working', 'away', 'field', 'off'));
