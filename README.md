# 회사생활 대시보드

연간·월간 일정, 일일/주간 업무일지, 야근·급여, 연차, 팀원 근무 상태를 한 화면에서
관리하는 팀 대시보드. 빌드 도구 없이 동작하는 정적 웹앱이며 데이터는 Supabase에 저장한다.

## 구성

```
index.html               화면 마크업
assets/
  config.js              Supabase 연결 정보 (직접 채워야 함)
  styles.css
  js/
    state.js             상수 · localStorage · 공용 유틸
    payroll.js           야근 인정 계산 · 급여 · 급여일
    leave.js             연차 집계 · 연차 신청
    daily.js             일일 업무일지
    weekly.js            주간 업무일지
    calendar.js          월간 달력(팀원 근무상황 표시) · 연간달력 모달 · 주간 메모
    manual.js            메뉴얼 및 서식 파일
    notice.js            팀 공지사항 (팀장만 작성)
    events.js            달력 중요일정 (개인 / 팀 공유)
    status.js            근무 상태바 (출근/자리비움/외근/퇴근) · 출·퇴근 시각 기록
    cloud.js             Supabase 클라이언트 · 프로필 · 팀 정보
    auth.js              회원가입 · 로그인 · 팀 생성/참여
    sync.js              개인 데이터 양방향 동기화 · 공휴일
    main.js              화면 렌더 오케스트레이션 · 이벤트 · 초기화
supabase/
  schema.sql             테이블 · RLS 정책 · RPC · Storage · 공휴일
  patch-2026-08-field-status.sql   기존 프로젝트에 '외근' 상태 허용
  patch-2026-08-team-notices.sql   기존 프로젝트에 팀 공지사항 테이블 추가
  patch-2026-08-calendar-events.sql 기존 프로젝트에 중요일정 테이블 추가
```

스크립트는 ES 모듈이 아니라 순서대로 로드되는 전역 스크립트다. `index.html` 하단의
로드 순서를 바꾸면 안 된다 (`state.js`가 가장 먼저, `main.js`가 가장 마지막).

## 팀 구성 방식

```
팀장  회원가입 → "팀장으로 새 팀 만들기" 체크 → 팀 이름 입력
      로그인 후 [팀 정보] 에 8자리 초대코드가 나온다

팀원  회원가입 → 초대코드 입력 → 팀장의 팀에 소속
```

메일 인증은 **가입할 때 한 번만** 한다. 그 뒤로는 각자 이메일과 비밀번호로 로그인한다.
초대코드는 팀장만 볼 수 있고, 유출되면 [팀 정보]에서 재발급하면 기존 코드는 즉시 막힌다.

## 설치

### 1. Supabase

1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성 (리전은 **Seoul** 권장 — 나중에 못 바꾼다)
2. SQL Editor에 `supabase/schema.sql` 전체를 붙여넣고 Run
3. Authentication → Sign In / Providers → Email
   - **Confirm email 켜기** (가입 때 한 번 인증)
   - Allow new users to sign up 켜두기 — 초대코드가 없으면 어느 팀에도 못 들어오므로 가입 자체는 열어둬도 된다
4. Authentication → URL Configuration
   ```
   Site URL      : https://<깃허브아이디>.github.io/<리포지토리>/
   Redirect URLs : 같은 주소 + http://localhost:8000/
   ```
5. Authentication → Emails → SMTP Settings에 **커스텀 SMTP 연결** (사실상 필수)
   내장 메일은 발송량이 매우 적어 팀원 가입 인증 메일이 막힌다. Resend 무료 한도면 충분하다.
6. Settings → API의 값으로 `assets/config.js`를 채운다

SQL로 관리자를 지정하는 절차는 없다. 첫 팀장은 앱에서 회원가입할 때 만들어진다.

### 2. GitHub Pages

```bash
gh repo create <리포지토리> --public --source=. --push
```

리포지토리 → Settings → Pages → Source를 `Deploy from a branch` / `main` / `/ (root)`로 지정.

### 3. 로컬 실행

`file://`로 열면 인증 리다이렉트가 동작하지 않으므로 정적 서버를 쓴다.

```bash
python -m http.server 8000
```

## 권한 모델

같은 팀이면 서로 열람할 수 있고, **쓰기는 언제나 본인 데이터만** 가능하다.
팀장이라고 해서 남의 데이터를 고칠 수 있는 곳은 한 군데도 없다.

| 데이터 | 테이블 | 열람 | 수정 |
|---|---|---|---|
| 일일/주간 업무일지, 출퇴근, 야근시간 | `daily_logs` | 같은 팀 전원 | 본인만 |
| 연차 **신청 현황** | `leave_requests` | 같은 팀 전원 | 본인만 |
| 근무 상태 (초록/노랑/보라/회색) | `member_status` | 같은 팀 전원 | 본인만 |
| 팀 공지사항 | `team_notices` | 같은 팀 전원 | **팀장만** |
| 중요일정 (팀 공유) | `calendar_events` | 같은 팀 전원 | 만든 사람만 |
| 중요일정 (개인) | `calendar_events` | **본인만** | 본인만 |
| 이름·직급 | `profiles` | 같은 팀 전원 | 본인만 |
| 공유 문서 | `team_files` + Storage | 같은 팀 전원 | 올린 사람만 삭제 |
| 팀 이름 | `teams` | 같은 팀 전원 | 팀장만 |
| 초대코드 | `team_invites` | **팀장만** | 팀장만 |
| **급여 · 연차 일수 · 월간기록 · 주간메모** | `user_state` | **본인만** | 본인만 |

월급과 개인 연차 일수(총/사용/잔여)는 `user_state`에 들어 있고 RLS가 본인 행만
내주므로, 팀장을 포함해 **누구도 남의 것을 볼 수 없다**. 팀장이 보는 연차 정보는
`leave_requests`의 신청 현황(누가 언제 쉬는지)뿐이다.

공유 문서는 `<team_id>/<user_id>/<파일명>` 경로에 저장되고, Storage 정책이 이 경로로
팀과 소유자를 판정한다. 업로드는 팀원 누구나, 삭제는 올린 사람만 할 수 있다.

## 중요일정

월간일정표 날짜칸 오른쪽 위의 `+` 로 등록한다. 일일업무일지와는 별개이며 저장할 때
공개 범위를 고른다.

| 공개 범위 | 보이는 사람 | 고치는 사람 |
|---|---|---|
| 개인 일정 | 나만 | 나만 |
| 팀 공유 | 같은 팀 전원 | 만든 사람만 |

일정 칩을 누르면 수정·삭제 창이 열린다. 남이 만든 팀 공유 일정은 읽기 전용이다.
로그인 전에는 이 브라우저(localStorage)에만 저장된다.

> 기존 프로젝트는 `supabase/patch-2026-08-calendar-events.sql`을 한 번 실행해야 한다.

## 공유 파일 형식

문서 `pdf hwp hwpx doc docx xls xlsx ppt pptx txt csv` ·
이미지 `jpg jpeg png gif webp heic` · 도면 `dwg dxf` · 압축 `zip 7z rar`,
한 파일당 50MB 이하. 목록은 `manual.js`의 `ALLOWED_FILE_EXTENSIONS`와
업로드 입력칸의 `accept` 속성에 함께 적혀 있으니 바꿀 때 두 곳을 같이 고친다.

## 팀 공지사항

월간일정표 오른쪽 패널. 팀당 한 건이고 **팀장만** 쓸 수 있다. 팀원에게는 읽기 전용으로
보이며, 화면뿐 아니라 `team_notices`의 RLS 정책(`is_team_leader()`)으로도 막혀 있다.
팀장이 저장하면 Realtime으로 팀원 화면에 즉시 반영된다.

팀장 화면은 두 가지 모드다. `작성 완료`를 누르면 입력칸 테두리가 사라지고 읽기 모드로
바뀌며, 다시 고치려면 `수정`을 누른다.

> 기존 프로젝트는 `supabase/patch-2026-08-team-notices.sql`을 한 번 실행해야 한다.

## 근무 상태바

화면 왼쪽에 팀원 수만큼 표시된다. 좁은 화면에서는 상단 가로 줄로 바뀐다.

| 색 | 상태 | 전환 |
|---|---|---|
| 🟢 초록 | 출근 | [출근] 버튼 — 출근시각이 비어 있으면 누른 시각이 기록된다 |
| 🟡 노랑 | 자리비움 | [자리비움] 버튼 |
| 🟣 보라 | 외근 | [외근] 버튼 — 오늘 근무상태가 `외근`으로 저장되어 월간일정표에 🚗로 뜬다 |
| ⚫ 회색 | 퇴근 / 미출근 | [퇴근] 버튼(누른 시각이 퇴근시간으로 기록됨), 또는 오늘 일일업무일지에 퇴근시간을 넣고 저장하면 자동 |

Realtime으로 팀원 화면에 즉시 반영된다. 날짜가 바뀌면 전날 상태는 회색으로 표시된다.

상태바 위의 **오늘 근무시간** 칸에서 출·퇴근 시각을 직접 고칠 수도 있다. 저장 위치는
일일업무일지와 같은 `daily_logs`이며, 퇴근시간이 바뀌면 야근 인정시간도 다시 계산된다.

> 기존에 `schema.sql`을 실행해 둔 프로젝트는 `외근` 상태를 저장하려면
> `supabase/patch-2026-08-field-status.sql`을 한 번 실행해야 한다.

## 운영 메모

### 공휴일 갱신
`holidays` 테이블에 추가하면 코드 수정 없이 달력에 반영된다 (팀장만 쓰기 가능).
음력 명절과 대체공휴일은 매년 확정될 때 넣어야 한다. 등록되지 않은 연도는
양력 고정 공휴일(신정·삼일절·어린이날 등)만 표시된다.

```sql
insert into public.holidays (holiday_date, name) values
  ('2028-01-01','신정')
on conflict (holiday_date) do nothing;
```

### 야근 · 추가수당 인정 규칙
코드에 고정돼 있다 (`state.js`의 `applyFixedOvertimeRules`,
`payroll.js`의 `calculateOvertimeHours` · `overtimeCapForDate`).

**평일**
- 18:00 정시 퇴근 / 18:00~19:00 저녁시간 제외
- 19:00~22:00 구간만 인정, 완료된 1시간 단위로만 계산
- 하루 최대 3시간 (20:00→1h, 21:00→2h, 22:00→3h)
- 퇴근시간만 있으면 계산된다

**주말(토·일) · 공휴일 출근**
- 출근~퇴근 시간을 완료된 1시간 단위로 인정, 하루 최대 8시간
- 길이를 알아야 하므로 **출근시간이 없으면 0시간**으로 둔다
- 달력·업무일지에서 `야근` 대신 `추가근무`로 표시된다

두 경우 모두 야근비 단가(`hourlyOvertime`)를 그대로 곱한다. 즉 추가수당 = 야근비다.

### 급여 반영 시점
이번 달 급여에는 **전월** 야근비가 포함된다 (`payrollOvertimeMonth`).
급여일은 개인 설정값(기본 25일)을 쓰며, 휴일이면 앞당겨진다.

### 개인 데이터 동기화
로그인하면 `user_state`에서 내려받고 저장할 때마다 올린다 (1.5초 디바운스).
충돌은 `updated_at` 기준 last-write-wins이고, 서버 데이터로 덮어쓰기 직전의 로컬
상태는 [내 정보 → 동기화 직전 상태로 되돌리기]로 복구할 수 있다.
