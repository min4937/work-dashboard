/* ============================================================================
   개인 데이터 양방향 동기화

   기존 버전은 설정·월간기록·주간메모가 localStorage 에만 있었다. 브라우저를
   바꾸거나 캐시를 지우면 전부 사라졌고, 급여 설정은 salary_profiles 로 올라가기만
   하고 다시 내려받는 경로가 없어서 새 기기에서는 0원으로 보였다.

   여기서는 user_state 테이블을 두고 로그인할 때 내려받고 저장할 때 올린다.
   충돌은 updated_at 기준 last-write-wins 로 처리하고, 서버 데이터로 덮어쓰기
   직전의 로컬 상태는 되돌릴 수 있도록 따로 보관한다.
   ============================================================================ */

const SYNC_BACKUP_KEY = "myCompanyDashboard_preSyncBackup";
let syncPushTimer = null;
let syncPulling = false;

function setSyncStatus(message, type = "") {
  const el = $("syncStateText");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = type === "error" ? "var(--red)" : "var(--muted)";
}

function localUpdatedAt() {
  return data.updatedAt || "1970-01-01T00:00:00.000Z";
}

/* 서버 → 로컬. 로그인 직후 한 번 호출한다. */
async function pullUserState() {
  if (!teamCloud.client || !teamCloud.user) return;
  syncPulling = true;
  try {
    const { data: row, error } = await teamCloud.client
      .from("user_state")
      .select("settings,records,weekly_memos,updated_at")
      .eq("user_id", teamCloud.user.id)
      .maybeSingle();

    if (error) {
      console.error(error);
      setSyncStatus("내 설정을 불러오지 못했어. 이 브라우저 데이터로 계속 사용해.", "error");
      return;
    }

    // 서버에 아직 없으면 지금 로컬 상태를 최초 업로드한다.
    if (!row) {
      await pushUserState(true);
      setSyncStatus("이 브라우저 데이터를 클라우드에 처음 올렸어.");
      return;
    }

    // 로컬이 더 최신이면 로컬을 올린다.
    if (localUpdatedAt() > row.updated_at) {
      await pushUserState(true);
      setSyncStatus("이 브라우저 변경분을 클라우드에 반영했어.");
      return;
    }

    // 서버가 더 최신 → 덮어쓰기. 되돌릴 수 있게 직전 로컬 상태를 남긴다.
    if (row.updated_at > localUpdatedAt()) {
      try {
        localStorage.setItem(SYNC_BACKUP_KEY, JSON.stringify(data));
      } catch (e) {
        console.warn("동기화 전 백업 실패", e);
      }

      data = {
        settings: { ...defaultSettings, ...(row.settings || {}) },
        records: row.records || {},
        dailyLogs: data.dailyLogs || {},
        weeklyMemos: row.weekly_memos || {},
        updatedAt: row.updated_at
      };
      applyFixedOvertimeRules();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      renderSettings();
      renderAll();
      updateBranding();
      setSyncStatus("다른 기기에서 저장한 내 설정을 불러왔어.");
      return;
    }

    setSyncStatus("클라우드와 최신 상태야.");
  } finally {
    syncPulling = false;
  }
}

/* 로컬 → 서버. persist() 가 호출할 때마다 예약되고 1.5초 뒤 한 번만 실행된다. */
async function pushUserState(immediate = false) {
  if (!teamCloud.client || !teamCloud.user) return;
  if (syncPulling && !immediate) return;

  const { error } = await teamCloud.client.from("user_state").upsert(
    {
      user_id: teamCloud.user.id,
      settings: data.settings,
      records: data.records || {},
      weekly_memos: data.weeklyMemos || {},
      updated_at: data.updatedAt || new Date().toISOString()
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error(error);
    setSyncStatus("클라우드 저장 실패 — 이 브라우저에는 저장됐어.", "error");
    return;
  }

  setSyncStatus("클라우드에 저장됨");
}

function schedulePushUserState() {
  if (!teamCloud.client || !teamCloud.user || syncPulling) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => pushUserState(), 1500);
}

/* 동기화로 덮어쓰기 직전의 로컬 상태로 되돌린다. */
function restorePreSyncBackup() {
  const raw = localStorage.getItem(SYNC_BACKUP_KEY);
  if (!raw) {
    alert("되돌릴 백업이 없어.");
    return;
  }
  if (!confirm("클라우드에서 내려받기 직전의 이 브라우저 상태로 되돌릴까? 지금 화면의 설정은 그 내용으로 바뀌어.")) return;

  try {
    const parsed = JSON.parse(raw);
    data = {
      settings: { ...defaultSettings, ...(parsed.settings || {}) },
      records: parsed.records || {},
      dailyLogs: parsed.dailyLogs || {},
      weeklyMemos: parsed.weeklyMemos || {},
      updatedAt: new Date().toISOString()
    };
    applyFixedOvertimeRules();
    persist();
    renderSettings();
    renderAll();
    updateBranding();
    setSyncStatus("백업 상태로 되돌렸어.");
  } catch (e) {
    alert("백업을 읽지 못했어.");
  }
}

/* ----------------------------------------------------------------------------
   공휴일 · 코드 대신 DB 에서 가져온다.
   기존에는 2026~2027 만 하드코딩돼 있어서 2028년부터는 음력 명절과 대체공휴일이
   달력에서 통째로 빠졌다. holidays 테이블에 INSERT 하면 즉시 반영된다.
   로그인 전에도 보이도록 익명 조회를 허용해 뒀다.
---------------------------------------------------------------------------- */
async function loadCloudHolidays() {
  if (!teamCloud.client) return;
  const { data: rows, error } = await teamCloud.client
    .from("holidays")
    .select("holiday_date,name");

  if (error) {
    console.warn("공휴일을 불러오지 못했어. 내장 데이터로 표시해.", error);
    return;
  }
  (rows || []).forEach(r => {
    holidayData[r.holiday_date] = r.name;
    cloudHolidayYears.add(r.holiday_date.slice(0, 4));
  });
  renderCalendar();
  renderAnnualCalendar();
}
