# 회사생활 대시보드

연간·월간 일정, 일일/주간 업무일지, 야근·급여, 연차를 한 화면에서 관리하는 팀 대시보드.
빌드 도구 없이 동작하는 정적 웹앱이며, 데이터는 Supabase에 저장한다.

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
    calendar.js          연간/월간 달력 · 주간 메모
    manual.js            메뉴얼 및 서식 파일
    cloud.js             Supabase 클라이언트 · 인증 · 팀 정보
    sync.js              개인 데이터 양방향 동기화 · 공휴일
    main.js              화면 렌더 오케스트레이션 · 이벤트 · 초기화
supabase/
  schema.sql             테이블 · RLS 정책 · RPC · Storage · 공휴일
```

스크립트는 ES 모듈이 아니라 순서대로 로드되는 전역 스크립트다. `index.html` 하단의
로드 순서를 바꾸면 안 된다 (`state.js`가 가장 먼저, `main.js`가 가장 마지막).

## 설치

### 1. Supabase

1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성
2. SQL Editor에 `supabase/schema.sql` 전체를 붙여넣고 Run
3. Authentication → Users에서 팀원 계정을 초대
   - 앱은 `shouldCreateUser: false`로 동작한다. 여기 등록되지 않은 이메일은
     로그인 링크조차 받을 수 없고, 이것이 외부인 차단 장치다.
4. 첫 월급관리자 지정 (RPC는 이미 관리자인 사람만 호출 가능하므로 최초 1명은 SQL로)
   ```sql
   insert into public.team_roles (user_id, payroll_manager)
   select id, true from auth.users where email = 'you@example.com'
   on conflict (user_id) do update set payroll_manager = true;
   ```
5. Authentication → URL Configuration → Redirect URLs에 배포 주소 추가
   ```
   https://<깃허브아이디>.github.io/<리포지토리>/
   http://localhost:8000/
   ```
6. Settings → API의 값으로 `assets/config.js`를 채운다

### 2. GitHub Pages

```bash
gh repo create <리포지토리> --public --source=. --push
```

리포지토리 → Settings → Pages → Source를 `Deploy from a branch` / `main` / `/ (root)`로 지정.
1~2분 뒤 `https://<깃허브아이디>.github.io/<리포지토리>/` 에서 열린다.

### 3. 로컬 실행

`file://`로 열면 Supabase 인증 리다이렉트가 동작하지 않으므로 정적 서버를 쓴다.

```bash
python -m http.server 8000
# 또는
npx serve .
```

## 데이터 저장 위치

| 데이터 | 저장소 | 공유 범위 |
|---|---|---|
| 일일/주간 업무일지, 출퇴근, 야근시간 | `daily_logs` | 팀 전원 열람, 본인만 수정 |
| 연차 신청 | `leave_requests` | 팀 전원 열람, 본인만 수정 |
| 이름·직급 | `profiles` | 팀 전원 열람, 본인만 수정 |
| 급여 항목 | `salary_profiles` | **본인 + 월급관리자만 열람** |
| 설정·월간기록·주간메모 | `user_state` | **본인만** (관리자도 열람 불가) |
| 공유 문서 | Storage `team-documents` | 팀 전원 |
| 공휴일 | `holidays` | 전원 열람, 관리자만 수정 |

로그인하지 않으면 모든 데이터는 브라우저 localStorage에만 저장된다.
로그인하면 `user_state`에서 내려받고, 저장할 때마다 다시 올라간다.

## 운영 메모

### 공휴일 갱신
`holidays` 테이블에 추가하면 코드 수정 없이 달력에 반영된다.
음력 명절과 대체공휴일은 매년 확정될 때 넣어야 한다.
등록되지 않은 연도는 양력 고정 공휴일(신정·삼일절·어린이날 등)만 표시된다.

```sql
insert into public.holidays (holiday_date, name) values
  ('2028-01-01','신정')
on conflict (holiday_date) do nothing;
```

### 야근 인정 규칙
코드에 고정돼 있다 (`assets/js/state.js`의 `applyFixedOvertimeRules`,
`assets/js/payroll.js`의 `calculateOvertimeHours`).

- 18:00 정시 퇴근 / 18:00~19:00 저녁시간 제외
- 19:00~22:00 구간만 인정, 완료된 1시간 단위로만 계산
- 하루 최대 3시간 (20:00→1h, 21:00→2h, 22:00→3h)

### 급여 반영 시점
이번 달 급여에는 **전월** 야근비가 포함된다 (`payrollOvertimeMonth`).
급여일은 개인 설정값(기본 25일)을 쓰며, 휴일이면 앞당겨진다.
