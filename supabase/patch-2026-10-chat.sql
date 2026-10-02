-- ----------------------------------------------------------------------------
-- 2026-10 패치 · 팀 채팅 (채널 · 1:1 대화 · 메시지 · 안 읽음)
--
-- 메시지는 chat_messages 표에 저장하고, 실시간 전달은 DB 트리거가 비공개
-- Broadcast 채널로 쏜다 (Broadcast from Database). 화면은 이 신호를 받아
-- 그리고, 연결이 끊겼다 돌아오면 DB 를 다시 읽어 빈 곳을 메운다.
-- → 진실은 언제나 DB 다. 실시간은 "새 글 왔어" 신호일 뿐이다.
--
-- 쓰기는 모두 RPC 로만 한다 (직접 INSERT/UPDATE 정책을 두지 않는다).
-- Supabase SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전하다.
-- (1:1 대화가 추가됐으므로 예전에 이 파일을 실행했어도 한 번 더 실행한다)
--
-- ※ Realtime 설정의 "Allow public access" 는 켜둔 채로 둔다.
--    끄면 기존 공지·상태바·업무일지(공개 채널 구독)가 멈춘다.
--    채팅 채널은 private 로 구독하므로 켜져 있어도 아래 RLS 를 거친다.
-- ----------------------------------------------------------------------------


-- 1. 표 -----------------------------------------------------------------------

-- 채널. public = 팀 채널, dm = 1:1 대화 (private 는 앞으로 쓸 자리)
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

-- 메시지. 순서는 서버가 매기는 id 하나로 정한다 (클라이언트 시계를 믿지 않는다).
-- client_id 는 보낸 쪽이 만든 값으로, 재전송해도 한 번만 들어가게 하는 열쇠다.
-- parent_id(스레드) · edited_at · deleted_at 은 2단계에서 쓴다.
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  parent_id  bigint references public.chat_messages(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);

create index if not exists chat_messages_channel_idx on public.chat_messages (channel_id, id);
create index if not exists chat_messages_parent_idx  on public.chat_messages (parent_id, id)
  where parent_id is not null;


-- 2. 권한 판정 헬퍼 -----------------------------------------------------------

-- 지금 로그인한 사람이 이 채널을 볼 수 있는가
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
      and c.archived_at is null
      and (
        c.kind = 'public'
        or exists (
          select 1 from public.chat_members m
          where m.channel_id = c.id and m.user_id = auth.uid()
        )
      )
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


-- 3. RLS ----------------------------------------------------------------------

alter table public.chat_channels enable row level security;
alter table public.chat_members  enable row level security;
alter table public.chat_messages enable row level security;

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


-- 4. Broadcast 트리거 ---------------------------------------------------------

-- 메시지가 저장되면 채널 토픽으로 행 전체를 쏜다.
-- 저장(commit)이 끝난 뒤에 나가므로 "보였는데 DB 에는 없는" 메시지는 생기지 않는다.
create or replace function public.chat_broadcast_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    to_jsonb(new),
    'message',
    'chat:' || new.channel_id::text,
    true
  );
  return null;
end;
$$;

drop trigger if exists chat_messages_broadcast on public.chat_messages;
create trigger chat_messages_broadcast
  after insert on public.chat_messages
  for each row execute function public.chat_broadcast_message();

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
  where c.team_id = v_team and c.archived_at is null
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

-- 채널 만들기 (팀원 누구나). 지금 팀원 전원을 멤버로 넣어둔다.
-- 빈 채널이니 읽음 포인터 0 이면 이후 메시지가 모두 '안 읽음'으로 잡힌다.
create or replace function public.create_chat_channel(p_name text, p_topic text default '')
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
    values (v_team, 'public', v_name, left(btrim(coalesce(p_topic, '')), 200), v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '이미 있는 채널 이름이야.';
  end;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  select v_id, p.user_id, 0
  from public.profiles p
  where p.team_id = v_team
  on conflict do nothing;

  return v_id;
end;
$$;

-- 메시지 보내기. 같은 client_id 로 다시 부르면 새로 만들지 않고 처음 것을 돌려준다
-- (네트워크가 끊겨 재전송해도 두 번 올라가지 않는다).
-- 내가 보낸 메시지까지는 읽은 것으로 친다.
create or replace function public.send_chat_message(
  p_channel   uuid,
  p_client_id uuid,
  p_body      text
)
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
  if v_uid is null or not public.chat_can_access(p_channel) then
    raise exception '이 채널에 메시지를 보낼 수 없어.';
  end if;
  if char_length(v_body) < 1 then
    raise exception '빈 메시지는 보낼 수 없어.';
  end if;
  if char_length(v_body) > 4000 then
    raise exception '메시지는 4000자까지 보낼 수 있어.';
  end if;

  insert into public.chat_messages (client_id, channel_id, user_id, body)
  values (p_client_id, p_channel, v_uid, v_body)
  on conflict (client_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.chat_messages
    where client_id = p_client_id and user_id = v_uid;
    if v_row.id is null then
      raise exception '메시지를 보내지 못했어.';
    end if;
  end if;

  insert into public.chat_members (channel_id, user_id, last_read_id)
  values (p_channel, v_uid, v_row.id)
  on conflict (channel_id, user_id)
  do update set last_read_id = greatest(public.chat_members.last_read_id, excluded.last_read_id);

  return v_row;
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
