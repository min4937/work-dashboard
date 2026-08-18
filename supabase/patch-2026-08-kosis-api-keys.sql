-- ----------------------------------------------------------------------------
-- 2026-08 패치 · KOSIS 개인 인증키 보관
--
-- KOSIS 인증키는 회원당 1개라 팀에서 돌려쓰면 호출 한도를 서로 잡아먹는다.
-- 각자 발급받은 키를 계정에 붙여두고 어느 PC에서 로그인하든 그대로 쓰게 한다.
--
-- ★ 오직 본인만 읽고 쓴다. 팀장도 남의 키를 볼 수 없다. ★
--   user_state 에 얹지 않고 표를 따로 둔 이유가 이것이다. user_state 는
--   백업 내려받기로 통째로 빠져나가는 자리라 인증키를 둘 곳이 아니다.
--
-- Supabase SQL Editor 에 붙여넣고 Run 하면 된다. 여러 번 실행해도 안전하다.
-- ----------------------------------------------------------------------------

create table if not exists public.kosis_api_keys (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  api_key    text not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists kosis_api_keys_touch on public.kosis_api_keys;
create trigger kosis_api_keys_touch
  before update on public.kosis_api_keys
  for each row execute function public.touch_updated_at();

alter table public.kosis_api_keys enable row level security;

-- 읽기까지 본인만. 팀 조건조차 걸지 않는다.
drop policy if exists kosis_api_keys_all on public.kosis_api_keys;
create policy kosis_api_keys_all on public.kosis_api_keys
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
