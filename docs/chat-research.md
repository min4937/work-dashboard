# 팀 채팅 기능 리서치 (슬랙형)

목표: 대시보드에 슬랙과 비슷한 팀원 간 채팅을 넣는다. 팀 규모는 수~수십 명이다.
구조는 지금과 같이 간다. 빌드 없는 바닐라 JS 전역 스크립트, GitHub Pages, Supabase.

## 0. 결론

- **DB가 원본이다.** 메시지는 Postgres 테이블에 저장하고 RLS로 막는다.
- **실시간은 신호로만 쓴다.** DB 트리거가 비공개 채널로 Broadcast를 보낸다(Broadcast from Database).
  - 연결이 끊긴 사이의 메시지는 재구독할 때 DB에서 다시 읽어 메운다.
- **타이핑 표시와 접속 표시는 저장하지 않는다.** 클라이언트 Broadcast와 Presence로만 보낸다.
- **추가 인프라나 비용이 없다.** 30명이 하루 500건을 보내면 월 약 45만 건이다. Free 한도(200만 건) 안에 들어간다.

## 1. 현재 대시보드의 출발점

- 실시간 구독은 이미 있다. `notice.js`, `status.js`, `daily.js`, `weekly.js`가 `postgres_changes`로 구독한다.
  - 패턴: `teamCloud.xxxChannel` 에 보관 → `removeChannel` 로 해제.
- 팀 단위 RLS 헬퍼가 있다: `current_team_id()`, `is_same_team(uid)`, `is_team_leader()` (`supabase/schema.sql`).
- publication 등록은 `schema.sql` 6장의 `do $$ ... alter publication supabase_realtime add table` 블록에서 한다.
- 출력 이스케이프에는 `escapeHtml`, `workTextHtml`을 쓴다 (`state.js`).
- 팀원 목록은 `teamCloud.members`에 있다. `user_id`와 `display_name`이 들어 있다.
- 채팅은 Postgres Changes 대신 Broadcast를 쓴다. 이유는 2장에 있다.
  - 그래서 기존 구독 패턴을 그대로 복사하면 안 된다.

## 2. Supabase Realtime (공식문서)

| 기능 | 용도 | 비고 |
|---|---|---|
| Broadcast | 채팅, DB 변경 알림, 타이핑 | 공식 Chat 예제도 Broadcast를 쓴다 |
| Presence | 온라인 여부처럼 천천히 바뀌는 상태 | `track()`을 자주 부르면 안 된다. 클라이언트당 30초에 5회까지 |
| Postgres Changes | 소규모 DB 변경 구독 | 이벤트마다 구독자별로 RLS를 검사한다. 단일 스레드라 처리량이 구독자 수에 비례한다 |

- **Broadcast from Database (권장)**
  - 트리거에서 `realtime.broadcast_changes(topic, event, op, table, schema, NEW, OLD)` 또는 `realtime.send(payload, event, topic, private)`를 부른다.
  - 함수는 `security definer set search_path = ''`로 만든다.
  - 클라이언트 구독:
    ```js
    await client.realtime.setAuth();
    client.channel(`room:${channelId}`, { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, p => ...)
      .subscribe(status => { if (status === "SUBSCRIBED") gapFill(); });
    ```
- **비공개 채널 권한**
  - 대시보드에서 "Allow public access"를 끈다.
  - `realtime.messages`에 SELECT/INSERT RLS를 건다.
  - 정책 안에서 `(select realtime.topic())`와 `channel_members`를 대조한다.
  - 주의: 권한 결과는 연결이 유지되는 동안 캐시된다. 멤버에서 빼도 재구독하거나 JWT가 갱신될 때까지 수신이 가능하다.
- **Broadcast Replay (알파)**: 최대 72시간, 최대 25건까지 다시 받을 수 있다. 보조 수단일 뿐이고 누락분 보충은 DB 조회로 한다.
- **한도 (Free / Pro)**

  | 항목 | Free | Pro |
  |---|---|---|
  | 동시접속 | 200 | 500 |
  | 메시지/초 | 100 | 500 |
  | Broadcast payload | 256KB | 3,000KB |
  | Presence 메시지/초 | 20 | 50 |

  - 공통: 연결당 채널은 100개까지다.
- **과금**: Broadcast 1건은 보내기 1 + 받는 사람 수로 센다. 그래서 타이핑 이벤트는 반드시 빈도를 제한해야 한다.
- **백그라운드 탭**: Chrome은 5분 넘게 숨겨진 탭의 타이머를 분당 1회로 제한한다.
  - `createClient(url, key, { realtime: { worker: true, heartbeatCallback } })`로 heartbeat를 Worker에서 돌린다.
  - 끊기면 `client.connect()`로 다시 연결한다.

출처:
- https://supabase.com/docs/guides/realtime
- https://supabase.com/docs/guides/realtime/broadcast
- https://supabase.com/docs/guides/realtime/authorization
- https://supabase.com/docs/guides/realtime/postgres-changes
- https://supabase.com/docs/guides/realtime/presence
- https://supabase.com/docs/guides/realtime/limits
- https://supabase.com/docs/guides/realtime/pricing
- https://supabase.com/blog/realtime-broadcast-replay
- https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794

공식 예제:
- **Slack clone**: `users`, `channels`, `messages`, `user_roles`, `role_permissions` 테이블. `authorize()` 함수와 Access Token Hook으로 RBAC를 한다. 실시간은 Postgres Changes를 쓴다.
  - https://github.com/supabase/supabase/tree/master/examples/slack-clone/nextjs-slack-clone
- **Supabase UI Realtime Chat**: 순수 Broadcast이고 저장하지 않는다. 연결이 끊기면 메시지 도착을 보장하지 않는다고 공식 문서에 적혀 있다.
  - https://supabase.com/ui/docs/nextjs/realtime-chat

## 3. Slack 기능 구조

| 기능 | Slack 방식 | 우리 구현 |
|---|---|---|
| 채널 | public/private, 사이드바 | `channels.kind = public / private / dm` |
| DM / 그룹 DM | 멤버가 고정된 대화 | `kind='dm'` + `channel_members` |
| 스레드 | `thread_ts == ts`면 부모, `reply_count` | `messages.parent_id`, 부모에 `reply_count` 캐시 |
| 읽음 / unread | `conversations.mark`로 `last_read` 포인터 | `channel_members.last_read_at` (또는 `last_read_id`) |
| 히스토리 | cursor 페이지네이션, 한 번에 200건 이하 | `(created_at, id)` keyset |
| 멘션 | Activity 탭 | 본문 `<@user_id>` 토큰 + `mentions` 테이블 또는 배열 |
| 리액션 | 이모지별 카운트 | `reactions(message_id, user_id, emoji)` PK |
| 수정 / 삭제 | "(edited)", 삭제 표시 | `edited_at`, `deleted_at` (soft delete) |
| 핀 / 저장 | 채널 핀, 개인 저장 | `pins`, `saved_items` |
| 첨부 | 파일 업로드 | 비공개 Storage 버킷 `chat/{channel_id}/...` |
| 타이핑 | 저장하지 않는 일시 이벤트 | 클라이언트 Broadcast, 3초에 한 번 이하 |

Slack 아키텍처 (Slack Engineering, "Real-time Messaging"):
- 메시지 흐름: 클라이언트 → Webapp API(DB 저장) → Admin Server → Channel Server(consistent hashing) → Gateway(WebSocket) → 클라이언트.
- **저장이 먼저이고 실시간 전달은 그 다음이다.** 타이핑 같은 일시 이벤트는 같은 경로로 가지만 저장하지 않는다. 우리 설계와 같은 구조다.
- Flannel(엣지 캐시)의 교훈: 처음 띄울 때 받는 데이터를 최소화하고, 나머지는 필요할 때 지연 로딩한다.

출처:
- https://slack.engineering/real-time-messaging/
- https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/
- https://docs.slack.dev/messaging/retrieving-messages/
- https://api.slack.com/methods/conversations.mark
- https://docs.slack.dev/apis/web-api/pagination/

## 4. 데이터 모델 설계 레퍼런스

- **ID와 순서**
  - 순서 기준은 서버가 정하는 `bigint identity` 또는 `created_at`으로 한다. 클라이언트 시계는 믿지 않는다 (Lamport 1978).
  - 클라이언트가 만든 `client_id uuid unique`는 중복제거 키로만 쓴다.
  - ULID와 Snowflake는 분산 환경용이다. 단일 DB에서는 필요 없다.
- **멱등 전송**: `insert ... on conflict (client_id) do nothing`. 재시도해도 메시지가 한 번만 생긴다. Stripe의 idempotency key와 같은 원리다.
- **낙관적 UI**: Zulip의 local echo 방식이다.
  1. 임시 `client_id`로 먼저 그린다.
  2. Broadcast로 같은 `client_id`가 오면 서버의 `id`와 `created_at`으로 바꾼다.
  3. 실패하면 "재전송" 버튼을 띄운다.
- **누락 보충(gap fill)**: 순서가 중요하다. 구독을 먼저 하고 조회를 나중에 해야 한다.
  1. 구독한다.
  2. `SUBSCRIBED` 상태가 되면 `id > 마지막으로 받은 id`를 조회한다.
  3. `id`로 중복을 제거하며 합친다.
  - 탭 복귀(`visibilitychange`)와 재연결 때도 같은 루틴을 돈다.
- **페이지네이션**: OFFSET은 쓰지 않는다. `where (created_at,id) < ($1,$2) order by created_at desc, id desc limit 50`.
- **unread 수**
  - 포인터 방식으로 한다: `count(*) where channel_id=? and id > last_read_id`.
  - 인덱스는 `(channel_id, id)`.
  - 채널 전체를 RPC 한 번에 집계한다.
- **검색**: Postgres FTS에는 한국어 사전이 없다. `pg_trgm` GIN 인덱스와 `ILIKE`를 쓴다.
- **규모 감각**: Discord는 `(channel_id, created_at)` 인덱스가 RAM을 넘어서 Cassandra로 옮겼다. 수십 명 팀이면 Postgres 테이블 하나로 충분하다.

출처:
- https://use-the-index-luke.com/no-offset
- https://github.com/ulid/spec
- https://zulip.readthedocs.io/en/latest/subsystems/sending-messages.html
- https://zulip.readthedocs.io/en/latest/subsystems/events-system.html
- https://zulip.readthedocs.io/en/latest/subsystems/unread_messages.html
- https://stripe.com/en-US/blog/idempotency
- https://supabase.com/docs/guides/database/full-text-search
- https://discord.com/blog/how-discord-stores-billions-of-messages

## 5. 논문 · 고전 자료

| 자료 | 이 프로젝트에 주는 시사점 |
|---|---|
| Lamport, *Time, Clocks, and the Ordering of Events in a Distributed System* (CACM 1978) — https://lamport.azurewebsites.net/pubs/time-clocks.pdf | 순서는 하나의 권위(DB)가 정한다 |
| Birman & Joseph, *Reliable Communication in the Presence of Failures* (ACM TOCS 1987) | 인과 순서와 전체 순서 브로드캐스트의 구분. 우리는 채널 단위 전체 순서(DB id)를 쓴다 |
| Adya et al., *Thialfi: A Client Notification Service for Internet-Scale Applications* (SOSP 2011) — https://research.google.com/pubs/archive/37474.pdf | 알림에는 버전만 싣고 데이터는 다시 가져온다. 우리의 "Broadcast는 신호, 진실은 DB"와 같다 |
| Kleppmann et al., *Local-first software* (Onward! 2019) — https://www.inkandswitch.com/essay/local-first/local-first.pdf | 오프라인 지원이 필요해지면 IndexedDB 캐시를 검토한다. 지금은 필요 없다 |
| Discord, *How Discord Stores Billions/Trillions of Messages* | 채널 + 시간 버킷 파티셔닝. 규모가 커질 때 참고한다 |

## 6. Netstudy(`../Netstudy/docs/tcp-chat.md`) 에서 가져올 개념

Netstudy는 TCP 소켓을 직접 다루는 서버라서 코드는 그대로 쓸 수 없다. 대신 설계 교훈은 그대로 대응된다.

| Netstudy 교훈 | 대시보드 채팅에서의 대응 |
|---|---|
| Room(목록 + 브로드캐스트) / Session(연결 1개) 분리 | `channels` + `channel_members` / Realtime 채널 구독 1개 |
| **단일 writer**: 한 소켓에 여러 Task가 쓰면 프레임이 섞인다 | 메시지 삽입은 RPC 하나(`send_message`)로 모은다. 순서는 DB가 매긴다 |
| 같은 발신자의 순서만 보존되고 발신자 사이 순서는 보장되지 않는다 | 클라이언트 도착 순서를 믿지 않는다. 항상 `id`로 정렬해 끼워 넣는다 |
| 느린 클라이언트 / 백프레셔: 큐가 차면 끊는다 | Supabase가 대신 처리한다. 우리가 할 일은 끊긴 뒤 gap fill로 복구하는 것 |
| 연결 완료 ≠ 등록 완료 (`* joined` 를 받고 나서 진행) | `subscribe()` 호출 ≠ 수신 준비. `SUBSCRIBED` 콜백 뒤에 조회한다 |
| 정리 경로는 한 곳으로 모은다 | 채널 전환과 로그아웃 시 `unsubscribeChatRealtime()` 한 함수에서만 해제한다 |
| Nagle 끄기 (작은 메시지 지연) | 해당 없음. WebSocket이 처리한다 |

## 7. 브라우저 측

- **알림**
  - `Notification.requestPermission()`은 사용자 클릭에서 부른다. HTTPS가 필요하다(GitHub Pages는 해당).
  - 탭이 hidden일 때만 띄우고, `tag: channelId`로 같은 채널 알림을 하나로 합친다.
  - 탭 제목에 `(3) 회사생활` 형태로 안 읽은 수를 붙인다.
- **visibilitychange**: visible로 돌아오면 gap fill을 하고 현재 채널을 읽음 처리한다.
- **XSS**
  - 본문은 `textContent`나 `escapeHtml`로 출력한다.
  - 마크다운을 넣는다면 `DOMPurify.sanitize`를 거친다. jsDelivr 단일 스크립트라 빌드 없이 쓸 수 있다.
  - 링크는 http/https만 허용한다.
- MDN Notifications: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
- MDN Page Visibility: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- OWASP XSS: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- DOMPurify: https://github.com/cure53/DOMPurify

## 8. 대안 비교

| 대안 | 판단 |
|---|---|
| **Supabase Realtime** | ✅ 채택. Auth, RLS, Storage를 그대로 쓰고 추가 비용이 없다 |
| 자체 WebSocket 서버 (Netstudy 방식) | ✗ GitHub Pages는 정적 호스팅이라 상시 서버를 따로 운영해야 한다. JWT와 RLS 연동도 직접 만들어야 한다 |
| Firebase | ✗ 인증과 데이터가 둘로 갈린다. 무료 한도가 하루 읽기 5만 건이다 |
| Ably / Pusher | ✗ 메시지 저장은 결국 Supabase에 해야 해서 구조가 이중화된다 |

## 9. 초안 스키마 (참고용, 구현 시 확정)

```sql
channels(id uuid pk, team_id uuid, kind text check (kind in ('public','private','dm')),
         name text, topic text, created_by uuid, created_at timestamptz, archived_at timestamptz)
channel_members(channel_id uuid, user_id uuid, role text, last_read_id bigint,
                muted boolean, joined_at timestamptz, primary key (channel_id, user_id))
messages(id bigint generated always as identity pk, client_id uuid unique,
         channel_id uuid, user_id uuid, parent_id bigint null, body text,
         reply_count int default 0, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz)
  index (channel_id, id), index (parent_id, id)
reactions(message_id bigint, user_id uuid, emoji text, primary key (message_id, user_id, emoji))
pins(channel_id uuid, message_id bigint, pinned_by uuid, pinned_at timestamptz)
attachments(id uuid, message_id bigint, path text, name text, size int, mime text)
```

- RLS: `messages` · `reactions` · `pins`는 `exists (select 1 from channel_members where ... user_id = auth.uid())`로 막는다. `public` 채널은 같은 팀(`current_team_id()`)이면 읽을 수 있다.
- 트리거: `messages` · `reactions` 변경 시 `realtime.broadcast_changes('room:' || channel_id, ...)`를 부른다.
- RPC
  - `send_message`: 멱등 삽입, 스레드 `reply_count` 증가
  - `mark_read`
  - `unread_counts`
  - `get_or_create_dm(user_ids)`

## 10. 단계별 구현 제안

1. **MVP**
   - 팀 기본 채널 `#general` 자동 생성
   - 채널 목록과 생성
   - 메시지 송수신(낙관적 UI + gap fill)
   - 히스토리 무한 스크롤
   - unread 뱃지
2. **슬랙 핵심**
   - DM과 그룹 DM
   - 스레드 패널
   - 수정·삭제
   - 리액션
   - @멘션 자동완성
3. **편의**
   - 타이핑 표시
   - 온라인 표시(기존 `member_status` 상태바와 연동)
   - 데스크톱 알림
   - 탭 제목 뱃지
4. **확장**
   - 파일 첨부
   - 핀
   - 검색(pg_trgm)
   - 마크다운(DOMPurify)
