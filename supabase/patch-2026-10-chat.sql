-- ----------------------------------------------------------------------------
-- 2026-10 패치 · 팀 채팅
--   채널(공개·비공개) · 1:1 대화 · 스레드 · 리액션 · 수정/삭제 · 고정 · 안 읽음
--   입력 중 표시 · 첨부 · 검색 · 채널 나가기/보관
--
-- 메시지는 chat_messages 표에 저장하고, 실시간 전달은 DB 트리거가 비공개
-- Broadcast 채널로 쏜다 (Broadcast from Database). 화면은 이 신호를 받아
-- 그리고, 연결이 끊겼다 돌아오면 DB 를 다시 읽어 빈 곳을 메운다.
-- → 진실은 언제나 DB 다. 실시간은 "새 글 왔어" 신호일 뿐이다.
--
-- 쓰기는 모두 RPC 로만 한다 (직접 INSERT/UPDATE 정책을 두지 않는다).
-- Supabase SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전하다.
-- (기능이 추가될 때마다 이 파일에 덧붙이므로, 예전에 실행했어도 한 번 더 실행한다)
--
-- ※ Realtime 설정의 "Allow public access" 는 켜둔 채로 둔다.
--    끄면 기존 공지·상태바·업무일지(공개 채널 구독)가 멈춘다.
--    채팅 채널은 private 로 구독하므로 켜져 있어도 아래 RLS 를 거친다.
-- ----------------------------------------------------------------------------


-- 1. 표 -----------------------------------------------------------------------

-- 채널. public = 팀 공개 채널, private = 초대받은 사람만, dm = 1:1 대화
-- archived_at 이 찍히면 보관된 채널: 목록에서 빠지고 읽기만 된다.
create table if not exists public.chat_channels (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  kind        text not null default 'public' check (kind in ('public','private','dm')),
  name        text not null,
  topic       text not null default '',
  is_default  boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

-- 1:1 대화의 두 사람을 정렬해 붙인 열쇠 ('작은id:큰id'). 같은 두 사람의 방이 둘 생기지 않게 한다.
alter table public.chat_channels add column if not exists dm_key text;

-- 팀 안에서 채널 이름은 겹치지 않는다 (DM 은 이름이 없으니 제외)
create unique index if not exists chat_channels_team_name_uniq
  on public.chat_channels (team_id, name) where kind <> 'dm';
-- 팀마다 기본 채널(#일반)은 하나뿐
create unique index if not exists chat_channels_team_default_uniq
  on public.chat_channels (team_id) where is_default;
-- 같은 두 사람의 1:1 대화방은 하나뿐
create unique index if not exists chat_channels_dm_uniq
  on public.chat_channels (team_id, dm_key) where kind = 'dm';

-- 채널 멤버 + 읽음 포인터. 슬랙의 last_read 와 같은 방식이다.
-- 안 읽은 수 = 이 채널에서 last_read_id 보다 큰 남의 메시지 수
create table if not exists public.chat_members (
  channel_id   uuid not null references public.chat_channels(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  last_read_id bigint not null default 0,
  joined_at    timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members (user_id);

-- 공개 채널에서 '나가기' 를 누르면 행을 지우지 않고 숨긴다.
-- (지우면 chat_bootstrap 이 공개 채널이라고 다시 넣어버린다)
alter table public.chat_members add column if not exists hidden boolean not null default false;

-- 메시지. 순서는 서버가 매기는 id 하나로 정한다 (클라이언트 시계를 믿지 않는다).
-- client_id 는 보낸 쪽이 만든 값으로, 재전송해도 한 번만 들어가게 하는 열쇠다.
-- parent_id 가 있으면 스레드 답글이다 (한 단계만. 답글에 답글은 없다).
-- 삭제는 행을 지우지 않고 deleted_at 을 찍고 본문을 비운다 (답글이 달린 원글이 사라지지 않게).
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  parent_id  bigint references public.chat_messages(id) on delete cascade,
  body       text not null check (char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);

-- 첨부만 보내는 메시지는 본문이 비어 있을 수 있다. 예전 '1자 이상' 제약을 바꾼다.
-- (본문과 첨부 중 하나는 있어야 한다는 규칙은 send_chat_message 가 지킨다)
alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check check (char_length(body) <= 4000);

-- 첨부 파일 목록 [{path, name, size, type}]. 파일 자체는 Storage 'chat-files' 버킷에 있다.
alter table public.chat_messages add column if not exists attachments jsonb not null default '[]'::jsonb;

-- 스레드 원글에 답글 수와 마지막 답글 시각을 들고 있게 한다 (목록의 '답글 3개' 표시용)
alter table public.chat_messages add column if not exists reply_count   integer not null default 0;
alter table public.chat_messages add column if not exists last_reply_at timestamptz;

create index if not exists chat_messages_channel_idx on public.chat_messages (channel_id, id);
create index if not exists chat_messages_parent_idx  on public.chat_messages (parent_id, id)
  where parent_id is not null;

-- 고정 메시지. 채널마다 여러 개. 누가 언제 고정했는지 남긴다.
create table if not exists public.chat_pins (
  message_id bigint primary key references public.chat_messages(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  pinned_by  uuid references auth.users(id) on delete set null,
  pinned_at  timestamptz not null default now()
);

create index if not exists chat_pins_channel_idx on public.chat_pins (channel_id, pinned_at);

-- 리액션. 한 사람이 같은 메시지에 같은 이모지는 한 번만 단다.
create table if not exists public.chat_reactions (
  message_id bigint not null references public.chat_messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);


-- 2. 권한 판정 헬퍼 -----------------------------------------------------------

-- 지금 로그인한 사람이 이 채널을 볼 수 있는가 (보관된 채널도 읽기는 된다)
--   public  : 같은 팀이면 누구나
--   그 외   : 멤버로 등록된 사람만
create or replace function public.chat_can_access(p_channel uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_channels c
    where c.id = p_channel
      and c.team_id = public.current_team_id()
      and (
        c.kind = 'public'
        or exists (
          select 1 from public.chat_members m
          where m.channel_id = c.id and m.user_id = auth.uid()
        )
      )
  );
$$;

-- 이 채널에 쓸 수 있는가 (볼 수 있고, 보관되지 않았다)
create or replace function public.chat_can_write(p_channel uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.chat_can_access(p_channel)
     and exists (select 1 from public.chat_channels c where c.id = p_channel and c.archived_at is null);
$$;

-- 채널 설정(보관)을 바꿀 수 있는가: 만든 사람 또는 팀장
create or replace function public.chat_can_manage(p_channel uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.chat_can_access(p_channel)
     and exists (
       select 1 from public.chat_channels c
       where c.id = p_channel and c.kind <> 'dm' and not c.is_default
         and (c.created_by = auth.uid() or public.is_team_leader())
     );
$$;

-- Realtime 토픽 이름으로 판정한다. 'chat:<채널 uuid>' 만 통과시키고
-- 모양이 다른 토픽은 uuid 로 바꾸다 오류가 나지 않게 먼저 걸러낸다.
create or replace function public.chat_can_access_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_topic is null
     or p_topic !~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.chat_can_access(substr(p_topic, 6)::uuid);
end;
$$;


-- 첨부 파일 경로 '<팀 id>/<채널 id>/<파일>' 에서 채널 id 를 꺼낸다. 모양이 다르면 null.
create or replace function public.chat_file_channel(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_parts text[] := storage.foldername(p_name);
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2
     or v_parts[1] is distinct from public.current_team_id()::text
     or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_parts[2]::uuid;
end;
$$;

-- 올리기는 그 채널에 쓸 수 있는 사람만 (보관된 채널에는 못 올린다)
create or replace function public.chat_can_write_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.chat_can_write(public.chat_file_channel(p_name)), false);
$$;

-- 내 팀 폴더이고, 그 채널을 볼 수 있는 사람만 내려받는다.
create or replace function public.chat_can_access_file(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_parts text[] := storage.foldername(p_name);
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2
     or v_parts[1] is distinct from public.current_team_id()::text
     or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.chat_can_access(v_parts[2]::uuid);
end;
$$;


-- 3. RLS ----------------------------------------------------------------------

alter table public.chat_channels enable row level security;
alter table public.chat_members  enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_pins      enable row level security;

drop policy if exists chat_channels_select on public.chat_channels;
create policy chat_channels_select on public.chat_channels
  for select to authenticated
  using (public.chat_can_access(id));

-- 읽음 포인터는 내 것만 보인다
drop policy if exists chat_members_select on public.chat_members;
create policy chat_members_select on public.chat_members
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages
  for select to authenticated
  using (public.chat_can_access(channel_id));

drop policy if exists chat_reactions_select on public.chat_reactions;
create policy chat_reactions_select on public.chat_reactions
  for select to authenticated
  using (exists (
    select 1 from public.chat_messages m
    where m.id = message_id and public.chat_can_access(m.channel_id)
  ));

drop policy if exists chat_pins_select on public.chat_pins;
create policy chat_pins_select on public.chat_pins
  for select to authenticated
  using (public.chat_can_access(channel_id));

-- 비공개 Broadcast 채널 구독 권한
--   chat:<채널 id>      → 그 채널을 볼 수 있는 사람
--   chat-team:<팀 id>   → 같은 팀 (채널이 새로 생기면 알려주는 용도)
drop policy if exists chat_realtime_select on realtime.messages;
create policy chat_realtime_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      public.chat_can_access_topic((select realtime.topic()))
      or (select realtime.topic()) = 'chat-team:' || public.current_team_id()::text
    )
  );


-- 화면이 직접 보내는 Broadcast(입력 중 표시) 권한. 그 채널을 볼 수 있는 사람만 보낸다.
drop policy if exists chat_realtime_insert on realtime.messages;
create policy chat_realtime_insert on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.chat_can_access_topic((select realtime.topic()))
  );

-- 첨부 파일 버킷. 비공개이고 한 파일 20MB 까지.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 20971520)
on conflict (id) do nothing;

drop policy if exists chat_files_select on storage.objects;
create policy chat_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and public.chat_can_access_file(name));

drop policy if exists chat_files_insert on storage.objects;
create policy chat_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and public.chat_can_write_file(name));

-- 지우기는 올린 사람만. 보내지 않고 뺀 첨부와, 지운 메시지의 첨부를 화면이 지운다.
-- (Storage 파일은 SQL 로 직접 지울 수 없어 Storage API 를 거쳐야 한다)
drop policy if exists chat_files_delete on storage.objects;
create policy chat_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-files' and owner_id = (select auth.uid())::text);


-- 4. Broadcast 트리거 ---------------------------------------------------------

-- 메시지가 저장·수정되면 채널 토픽으로 행 전체를 쏜다. op 에 insert/update 를 붙인다.
-- 저장(commit)이 끝난 뒤에 나가므로 "보였는데 DB 에는 없는" 메시지는 생기지 않는다.
-- 수정·삭제·답글 수 변경도 모두 update 로 같은 길을 탄다.
create or replace function public.chat_broadcast_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    to_jsonb(new) || jsonb_build_object('op', lower(tg_op)),
    'message',
    'chat:' || new.channel_id::text,
    true
  );
  return null;
end;
$$;

drop trigger if exists chat_messages_broadcast on public.chat_messages;
create trigger chat_messages_broadcast
  after insert or update on public.chat_messages
  for each row execute function public.chat_broadcast_message();

-- 리액션이 달리거나 빠지면 그 메시지의 채널 토픽으로 알린다
create or replace function public.chat_broadcast_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r         record;
  v_channel uuid;
begin
  if tg_op = 'DELETE' then
    r := old;
  else
    r := new;
  end if;

  select m.channel_id into v_channel from public.chat_messages m where m.id = r.message_id;
  if v_channel is null then
    return null;   -- 메시지와 함께 지워지는 중
  end if;

  perform realtime.send(
    jsonb_build_object('message_id', r.message_id, 'user_id', r.user_id,
                       'emoji', r.emoji, 'op', lower(tg_op)),
    'reaction',
    'chat:' || v_channel::text,
    true
  );
  return null;
end;
$$;

drop trigger if exists chat_reactions_broadcast on public.chat_reactions;
create trigger chat_reactions_broadcast
  after insert or delete on public.chat_reactions
  for each row execute function public.chat_broadcast_reaction();

-- 고정·해제를 채널 토픽으로 알린다
create or replace function public.chat_broadcast_pin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if tg_op = 'DELETE' then
    r := old;
  else
    r := new;
  end if;
  perform realtime.send(
    jsonb_build_object('message_id', r.message_id, 'pinned_by', r.pinned_by,
                       'pinned_at', r.pinned_at, 'op', lower(tg_op)),
    'pin',
    'chat:' || r.channel_id::text,
    true
  );
  return null;
end;
$$;

drop trigger if exists chat_pins_broadcast on public.chat_pins;
create trigger chat_pins_broadcast
  after insert or delete on public.chat_pins
  for each row execute function public.chat_broadcast_pin();

-- 채널이 생기면 팀 토픽으로 알린다 (받은 쪽은 채널 목록을 다시 읽는다)
create or replace function public.chat_broadcast_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'kind', new.kind),
    'channel',
    'chat-team:' || new.team_id::text,
    true
  );
  return null;
end;
$$;

drop trigger if exists chat_channels_broadcast on public.chat_channels;
create trigger chat_channels_broadcast
  after insert on public.chat_channels
  for each row execute function public.chat_broadcast_channel();


-- 5. RPC ----------------------------------------------------------------------

-- 채팅 화면을 열 때 한 번 부른다.
--   · 팀에 기본 채널(#일반)이 없으면 만든다
--   · 내가 아직 멤버가 아닌 public 채널에 멤버로 넣는다
--     (새로 들어온 팀원에게 지난 대화가 전부 '안 읽음'으로 뜨지 않도록
--      읽음 포인터는 그 채널의 마지막 메시지로 둔다)
--   · 채널마다 안 읽은 수와 마지막 메시지 id 를 돌려준다
--   · 1:1 대화는 내가 멤버인 것만 나오고, dm_user_id 에 상대가 들어 있다
--   · 내가 나간(숨긴) 채널과 보관된 채널은 빠진다
-- 돌려주는 열이 바뀌면 create or replace 로는 안 되므로 지우고 다시 만든다.
drop function if exists public.chat_bootstrap();
create function public.chat_bootstrap()
returns table (
  id              uuid,
  kind            text,
  name            text,
  topic           text,
  is_default      boolean,
  created_by      uuid,
  dm_user_id      uuid,
  created_at      timestamptz,
  last_read_id    bigint,
  unread_count    integer,
  last_message_id bigint
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_team uuid := public.current_team_id();
begin
  if v_uid is null or v_team is null then
    return;
  end if;

  insert into public.chat_channels (team_id, kind, name, topic, is_default)
  values (v_team, 'public', '일반', '팀 전체 대화', true)
  on conflict do nothing;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  select c.id, v_uid,
         coalesce((select max(m.id) from public.chat_messages m where m.channel_id = c.id), 0)
  from public.chat_channels c
  where c.team_id = v_team and c.kind = 'public' and c.archived_at is null
  on conflict do nothing;

  return query
  select c.id, c.kind, c.name, c.topic, c.is_default, c.created_by,
         case when c.kind = 'dm' then
           (select o.user_id from public.chat_members o
             where o.channel_id = c.id and o.user_id <> v_uid limit 1)
         end,
         c.created_at,
         cm.last_read_id,
         (select count(*)::int from public.chat_messages m
           where m.channel_id = c.id
             and m.id > cm.last_read_id
             and m.user_id is distinct from v_uid
             and m.parent_id is null
             and m.deleted_at is null),
         (select max(m.id) from public.chat_messages m where m.channel_id = c.id)
  from public.chat_channels c
  join public.chat_members cm on cm.channel_id = c.id and cm.user_id = v_uid
  where c.team_id = v_team and c.archived_at is null and not cm.hidden
  order by c.is_default desc, c.name;
end;
$$;

-- 1:1 대화방 열기. 이미 있으면 그 방을, 없으면 새로 만들어 돌려준다.
-- 두 사람 모두 멤버로 넣으므로 상대 화면에도 같은 방이 잡힌다.
create or replace function public.get_or_create_dm(p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_team uuid := public.current_team_id();
  v_key  text;
  v_id   uuid;
begin
  if v_uid is null or v_team is null then
    raise exception '팀에 소속된 사람만 대화할 수 있어.';
  end if;
  if p_user is null or p_user = v_uid then
    raise exception '대화 상대를 골라줘.';
  end if;
  if not public.is_same_team(p_user) then
    raise exception '같은 팀원하고만 대화할 수 있어.';
  end if;

  v_key := least(v_uid::text, p_user::text) || ':' || greatest(v_uid::text, p_user::text);

  select c.id into v_id from public.chat_channels c
  where c.team_id = v_team and c.kind = 'dm' and c.dm_key = v_key;

  if v_id is null then
    insert into public.chat_channels (team_id, kind, name, dm_key, created_by)
    values (v_team, 'dm', '', v_key, v_uid)
    on conflict do nothing
    returning chat_channels.id into v_id;

    -- 두 사람이 동시에 눌렀으면 먼저 만든 쪽 방을 쓴다
    if v_id is null then
      select c.id into v_id from public.chat_channels c
      where c.team_id = v_team and c.kind = 'dm' and c.dm_key = v_key;
    end if;
  end if;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  values (v_id, v_uid, 0), (v_id, p_user, 0)
  on conflict do nothing;

  return v_id;
end;
$$;

-- 채널 만들기 (팀원 누구나).
--   공개   : 지금 팀원 전원을 멤버로 넣는다
--   비공개 : 만든 사람 + 고른 팀원만 넣는다 (다른 팀원에게는 보이지도 않는다)
-- 빈 채널이니 읽음 포인터 0 이면 이후 메시지가 모두 '안 읽음'으로 잡힌다.
drop function if exists public.create_chat_channel(text, text);
create or replace function public.create_chat_channel(
  p_name    text,
  p_topic   text    default '',
  p_private boolean default false,
  p_members uuid[]  default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_team uuid := public.current_team_id();
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '^#+', ''));
  v_id   uuid;
begin
  if v_uid is null or v_team is null then
    raise exception '팀에 소속된 사람만 채널을 만들 수 있어.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception '채널 이름은 1~30자로 정해줘.';
  end if;

  begin
    insert into public.chat_channels (team_id, kind, name, topic, created_by)
    values (v_team, case when p_private then 'private' else 'public' end,
            v_name, left(btrim(coalesce(p_topic, '')), 200), v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '이미 있는 채널 이름이야.';
  end;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  select v_id, p.user_id, 0
  from public.profiles p
  where p.team_id = v_team
    and (not coalesce(p_private, false)
         or p.user_id = v_uid
         or p.user_id = any(coalesce(p_members, '{}'::uuid[])))
  on conflict do nothing;

  return v_id;
end;
$$;

-- 메시지 보내기. 같은 client_id 로 다시 부르면 새로 만들지 않고 처음 것을 돌려준다
-- (네트워크가 끊겨 재전송해도 두 번 올라가지 않는다).
-- p_parent 를 주면 그 메시지의 스레드 답글이 되고, 원글의 답글 수가 올라간다.
-- 내가 보낸 채널 메시지까지는 읽은 것으로 친다.
-- p_attachments 는 이미 Storage 에 올린 파일 목록. 경로가 이 채널 폴더 안이어야 한다.
-- 인자가 늘 때마다 예전 것을 지워야 같은 이름 함수가 여럿 생기지 않는다.
drop function if exists public.send_chat_message(uuid, uuid, text);
drop function if exists public.send_chat_message(uuid, uuid, text, bigint);
create or replace function public.send_chat_message(
  p_channel     uuid,
  p_client_id   uuid,
  p_body        text,
  p_parent      bigint default null,
  p_attachments jsonb  default '[]'::jsonb
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
  v_prefix text := public.current_team_id()::text || '/' || p_channel::text || '/';
  v_files  jsonb;
  v_ok     boolean;
  v_row    public.chat_messages;
begin
  if v_uid is null or not public.chat_can_write(p_channel) then
    raise exception '이 채널에 메시지를 보낼 수 없어.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 10 then
    raise exception '첨부는 한 번에 10개까지야.';
  end if;

  -- 필요한 칸만 남기고, 경로가 이 채널 폴더 밖이면 거절한다
  select coalesce(jsonb_agg(jsonb_build_object(
           'path', a->>'path',
           'name', left(coalesce(nullif(a->>'name', ''), '파일'), 200),
           'size', coalesce((a->>'size')::bigint, 0),
           'type', left(coalesce(a->>'type', ''), 100))), '[]'::jsonb),
         coalesce(bool_and(a->>'path' like v_prefix || '%' and a->>'path' not like '%..%'), true)
  into v_files, v_ok
  from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a;

  if not v_ok then
    raise exception '첨부 파일 경로가 올바르지 않아.';
  end if;
  if char_length(v_body) < 1 and jsonb_array_length(v_files) = 0 then
    raise exception '빈 메시지는 보낼 수 없어.';
  end if;
  if char_length(v_body) > 4000 then
    raise exception '메시지는 4000자까지 보낼 수 있어.';
  end if;

  if p_parent is not null then
    perform 1 from public.chat_messages p
    where p.id = p_parent and p.channel_id = p_channel
      and p.parent_id is null and p.deleted_at is null;
    if not found then
      raise exception '답글을 달 메시지를 찾을 수 없어.';
    end if;
  end if;

  insert into public.chat_messages (client_id, channel_id, user_id, parent_id, body, attachments)
  values (p_client_id, p_channel, v_uid, p_parent, v_body, v_files)
  on conflict (client_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- 재전송: 처음 들어간 것을 돌려준다 (답글 수도 다시 올리지 않는다)
    select * into v_row from public.chat_messages
    where client_id = p_client_id and user_id = v_uid;
    if v_row.id is null then
      raise exception '메시지를 보내지 못했어.';
    end if;
  elsif p_parent is not null then
    update public.chat_messages
    set reply_count = reply_count + 1, last_reply_at = v_row.created_at
    where id = p_parent;
  end if;

  if v_row.parent_id is null then
    insert into public.chat_members (channel_id, user_id, last_read_id)
    values (p_channel, v_uid, v_row.id)
    on conflict (channel_id, user_id)
    do update set last_read_id = greatest(public.chat_members.last_read_id, excluded.last_read_id);
  end if;

  return v_row;
end;
$$;

-- 내 메시지 고치기
create or replace function public.edit_chat_message(p_id bigint, p_body text)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_body text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
  v_row  public.chat_messages;
begin
  select * into v_row from public.chat_messages where id = p_id;
  if v_row.id is null or v_row.user_id is distinct from v_uid
     or v_row.deleted_at is not null or not public.chat_can_write(v_row.channel_id) then
    raise exception '이 메시지는 고칠 수 없어.';
  end if;
  if char_length(v_body) > 4000
     or (char_length(v_body) < 1 and jsonb_array_length(v_row.attachments) = 0) then
    raise exception '메시지는 1~4000자로 써줘.';
  end if;
  if v_body = v_row.body then
    return v_row;
  end if;

  update public.chat_messages
  set body = v_body, edited_at = now()
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

-- 내 메시지 지우기. 행은 남기고 본문만 비운다 (답글이 달린 원글 자리를 지키려고).
-- 답글을 지우면 원글의 답글 수도 하나 줄인다.
create or replace function public.delete_chat_message(p_id bigint)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.chat_messages;
begin
  select * into v_row from public.chat_messages where id = p_id;
  if v_row.id is null or v_row.user_id is distinct from v_uid
     or not public.chat_can_write(v_row.channel_id) then
    raise exception '이 메시지는 지울 수 없어.';
  end if;
  if v_row.deleted_at is not null then
    return v_row;
  end if;

  delete from public.chat_reactions where message_id = p_id;
  delete from public.chat_pins where message_id = p_id;

  update public.chat_messages
  set body = '(삭제됨)', attachments = '[]'::jsonb, deleted_at = now()
  where id = p_id
  returning * into v_row;

  if v_row.parent_id is not null then
    update public.chat_messages
    set reply_count = greatest(reply_count - 1, 0)
    where id = v_row.parent_id;
  end if;

  return v_row;
end;
$$;

-- 리액션 달기/빼기. 이미 있으면 빼고 없으면 단다. 단 쪽이면 true.
create or replace function public.toggle_chat_reaction(p_message bigint, p_emoji text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_emoji text := btrim(coalesce(p_emoji, ''));
  v_ok    boolean;
begin
  select public.chat_can_write(m.channel_id) and m.deleted_at is null into v_ok
  from public.chat_messages m where m.id = p_message;
  if v_uid is null or not coalesce(v_ok, false) then
    raise exception '이 메시지에는 반응할 수 없어.';
  end if;
  if char_length(v_emoji) < 1 or char_length(v_emoji) > 16 then
    raise exception '이모지가 올바르지 않아.';
  end if;

  delete from public.chat_reactions
  where message_id = p_message and user_id = v_uid and emoji = v_emoji;
  if found then
    return false;
  end if;

  insert into public.chat_reactions (message_id, user_id, emoji)
  values (p_message, v_uid, v_emoji)
  on conflict do nothing;
  return true;
end;
$$;

-- 읽음 포인터 앞으로 옮기기 (뒤로는 안 간다)
create or replace function public.mark_chat_read(p_channel uuid, p_last_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_max bigint;
begin
  if v_uid is null or not public.chat_can_access(p_channel) then
    return;
  end if;

  -- 아직 없는 id 로 포인터를 미리 밀어두지 못하게 실제 마지막 메시지로 자른다
  select coalesce(max(id), 0) into v_max
  from public.chat_messages where channel_id = p_channel;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  values (p_channel, v_uid, least(coalesce(p_last_id, 0), v_max))
  on conflict (channel_id, user_id)
  do update set last_read_id = greatest(public.chat_members.last_read_id, excluded.last_read_id);
end;
$$;

-- 메시지 검색. 내가 볼 수 있는 채널·1:1 대화에서 본문이나 첨부 이름에 검색어가 든 것.
-- 한국어 사전이 없어 전문 검색 대신 부분 일치(ILIKE)를 쓴다. 팀 규모에서는 이걸로 충분하다.
create or replace function public.search_chat_messages(p_query text, p_limit integer default 50)
returns table (
  id         bigint,
  channel_id uuid,
  parent_id  bigint,
  user_id    uuid,
  body       text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_q text := btrim(coalesce(p_query, ''));
begin
  if auth.uid() is null or char_length(v_q) < 2 then
    return;
  end if;
  -- % _ \ 를 글자 그대로 찾게 한다
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select m.id, m.channel_id, m.parent_id, m.user_id, m.body, m.created_at
  from public.chat_messages m
  join public.chat_channels c on c.id = m.channel_id
  where c.team_id = public.current_team_id()
    and public.chat_can_access(c.id)
    and m.deleted_at is null
    and (
      m.body ilike '%' || v_q || '%'
      or exists (
        select 1 from jsonb_array_elements(m.attachments) a
        where a->>'name' ilike '%' || v_q || '%'
      )
    )
  order by m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

-- 팀 토픽으로 '채널 목록이 바뀌었어' 를 알린다 (멤버 추가·보관 등)
create or replace function public.chat_notify_team(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select c.team_id into v_team from public.chat_channels c where c.id = p_channel;
  if v_team is not null then
    perform realtime.send(jsonb_build_object('id', p_channel), 'channel',
                          'chat-team:' || v_team::text, true);
  end if;
end;
$$;

-- 채널 찾기 화면용 목록. 내가 볼 수 있는 공개·비공개 채널 전부 (보관된 것 포함, 1:1 제외)
create or replace function public.list_chat_channels()
returns table (
  id           uuid,
  kind         text,
  name         text,
  topic        text,
  is_default   boolean,
  created_by   uuid,
  archived_at  timestamptz,
  member_count integer,
  is_member    boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_team uuid := public.current_team_id();
begin
  if v_uid is null or v_team is null then
    return;
  end if;
  return query
  select c.id, c.kind, c.name, c.topic, c.is_default, c.created_by, c.archived_at,
         (select count(*)::int from public.chat_members m
           where m.channel_id = c.id and not m.hidden),
         exists (select 1 from public.chat_members m
                  where m.channel_id = c.id and m.user_id = v_uid and not m.hidden)
  from public.chat_channels c
  where c.team_id = v_team and c.kind <> 'dm' and public.chat_can_access(c.id)
  order by c.archived_at nulls first, c.is_default desc, c.name;
end;
$$;

-- 채널 멤버 목록 (chat_members 는 RLS 로 내 행만 보이므로 이 함수로 본다)
create or replace function public.chat_channel_members(p_channel uuid)
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.chat_can_access(p_channel) then
    return;
  end if;
  return query
  select m.user_id from public.chat_members m
  where m.channel_id = p_channel and not m.hidden;
end;
$$;

-- 공개 채널 참여 (나갔던 채널에 다시 들어올 때). 지난 대화는 읽은 것으로 친다.
create or replace function public.join_chat_channel(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_max bigint;
begin
  if v_uid is null or not public.chat_can_write(p_channel)
     or not exists (select 1 from public.chat_channels c where c.id = p_channel and c.kind = 'public') then
    raise exception '이 채널에는 참여할 수 없어.';
  end if;

  select coalesce(max(id), 0) into v_max from public.chat_messages where channel_id = p_channel;

  insert into public.chat_members (channel_id, user_id, last_read_id, hidden)
  values (p_channel, v_uid, v_max, false)
  on conflict (channel_id, user_id)
  do update set hidden = false,
                last_read_id = greatest(public.chat_members.last_read_id, excluded.last_read_id);
end;
$$;

-- 채널 나가기. 기본 채널과 1:1 대화는 나갈 수 없다.
--   공개   : 숨김 (채널 찾기에서 다시 참여할 수 있다)
--   비공개 : 멤버에서 빠진다 (다시 초대받아야 들어온다). 마지막 사람이 나가면 보관한다.
create or replace function public.leave_chat_channel(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_kind text;
  v_def  boolean;
begin
  select c.kind, c.is_default into v_kind, v_def
  from public.chat_channels c where c.id = p_channel;

  if v_uid is null or v_kind is null or not public.chat_can_access(p_channel) then
    raise exception '이 채널에서 나갈 수 없어.';
  end if;
  if v_def or v_kind = 'dm' then
    raise exception '기본 채널과 1:1 대화는 나갈 수 없어.';
  end if;

  if v_kind = 'public' then
    update public.chat_members set hidden = true
    where channel_id = p_channel and user_id = v_uid;
  else
    delete from public.chat_members where channel_id = p_channel and user_id = v_uid;
    if not exists (select 1 from public.chat_members where channel_id = p_channel) then
      update public.chat_channels set archived_at = now() where id = p_channel;
    end if;
    perform public.chat_notify_team(p_channel);
  end if;
end;
$$;

-- 비공개 채널에 팀원 초대. 그 채널 멤버라면 누구나 초대할 수 있다 (슬랙과 같다).
create or replace function public.add_chat_members(p_channel uuid, p_users uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_team  uuid := public.current_team_id();
  v_count integer;
begin
  if v_uid is null or not public.chat_can_write(p_channel)
     or not exists (select 1 from public.chat_channels c where c.id = p_channel and c.kind = 'private') then
    raise exception '비공개 채널에만 초대할 수 있어.';
  end if;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  select p_channel, p.user_id, 0
  from public.profiles p
  where p.team_id = v_team and p.user_id = any(coalesce(p_users, '{}'::uuid[]))
  on conflict do nothing;
  get diagnostics v_count = row_count;

  perform public.chat_notify_team(p_channel);
  return v_count;
end;
$$;

-- 채널 보관 / 보관 해제. 만든 사람 또는 팀장만. 보관되면 읽기만 된다.
create or replace function public.archive_chat_channel(p_channel uuid, p_archive boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.chat_can_manage(p_channel) then
    raise exception '채널을 만든 사람이나 팀장만 보관할 수 있어.';
  end if;
  update public.chat_channels
  set archived_at = case when p_archive then now() else null end
  where id = p_channel;
  perform public.chat_notify_team(p_channel);
end;
$$;

-- 메시지 고정 / 해제. 그 채널에 쓸 수 있는 사람 누구나. 고정했으면 true.
create or replace function public.toggle_chat_pin(p_message bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channel uuid;
  v_deleted timestamptz;
begin
  select m.channel_id, m.deleted_at into v_channel, v_deleted
  from public.chat_messages m where m.id = p_message;

  if v_channel is null or v_deleted is not null or not public.chat_can_write(v_channel) then
    raise exception '이 메시지는 고정할 수 없어.';
  end if;

  delete from public.chat_pins where message_id = p_message;
  if found then
    return false;
  end if;

  insert into public.chat_pins (message_id, channel_id, pinned_by)
  values (p_message, v_channel, auth.uid())
  on conflict do nothing;
  return true;
end;
$$;

-- 채널 이름 · 설명 바꾸기
--   이름 : 만든 사람 또는 팀장 (기본 채널 #일반 은 바꿀 수 없다)
--   설명 : 그 채널 멤버 누구나 (슬랙과 같다)
-- null 로 넘긴 쪽은 그대로 둔다.
create or replace function public.update_chat_channel(
  p_channel uuid,
  p_name    text default null,
  p_topic   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_name text;
begin
  select c.kind into v_kind from public.chat_channels c where c.id = p_channel;
  if v_kind is null or v_kind = 'dm' or not public.chat_can_write(p_channel) then
    raise exception '이 채널은 고칠 수 없어.';
  end if;

  if p_name is not null then
    if not public.chat_can_manage(p_channel) then
      raise exception '채널 이름은 만든 사람이나 팀장만 바꿀 수 있어.';
    end if;
    v_name := btrim(regexp_replace(p_name, '^#+', ''));
    if char_length(v_name) < 1 or char_length(v_name) > 30 then
      raise exception '채널 이름은 1~30자로 정해줘.';
    end if;
    begin
      update public.chat_channels set name = v_name where id = p_channel;
    exception when unique_violation then
      raise exception '이미 있는 채널 이름이야.';
    end;
  end if;

  if p_topic is not null then
    update public.chat_channels set topic = left(btrim(p_topic), 200) where id = p_channel;
  end if;

  perform public.chat_notify_team(p_channel);
end;
$$;
