/* ============================================================================
   근무 상태바 (왼쪽 사이드바)

     초록 working  출근
     노랑 away     자리비움
     보라 field    외근
     회색 off      퇴근 / 미출근

   본인 상태만 바꿀 수 있고, 같은 팀원에게 실시간으로 보인다.
   일일업무일지에 퇴근시간을 넣어 저장하면 자동으로 회색이 된다.

   출근/퇴근 버튼을 누르면 그 시각이 오늘 일일업무일지의 출·퇴근시간으로
   기록된다. 사이드바의 시간 입력칸에서 직접 고칠 수도 있다.
   ============================================================================ */

const STATUS_LABELS = { working: "출근", away: "자리비움", field: "외근", off: "퇴근" };
const STATUS_ORDER = ["working", "away", "field", "off"];

/* 어제 눌러둔 '출근'이 오늘까지 초록으로 남지 않도록, 날짜가 다르면 퇴근으로 본다. */
function effectiveStatus(record) {
  if (!record) return "off";
  if (record.status_date !== dateKey(new Date())) return "off";
  return record.status || "off";
}

function myStatus() {
  if (!teamCloud.user) return "off";
  return effectiveStatus(teamCloud.memberStatus.get(teamCloud.user.id));
}

function renderStatusBar() {
  const wrap = $("statusBarList");
  const controls = $("statusControls");
  const notice = $("statusBarNotice");
  if (!wrap) return;

  if (!teamCloud.user || !teamCloud.teamId) {
    wrap.innerHTML = "";
    if (controls) controls.style.display = "none";
    if (notice) {
      notice.style.display = "block";
      notice.textContent = teamCloud.user
        ? "팀에 참여하면 팀원 상태가 보여."
        : "로그인하면 팀원 상태가 보여.";
    }
    return;
  }

  if (notice) notice.style.display = "none";
  if (controls) controls.style.display = "block";

  const mine = myStatus();
  STATUS_ORDER.forEach(s => {
    const btn = $(`statusBtn_${s}`);
    if (btn) btn.classList.toggle("active", mine === s);
  });

  wrap.innerHTML = "";
  if (!teamCloud.members.length) {
    wrap.innerHTML = '<div class="status-empty">팀원이 없어.</div>';
    return;
  }

  // 오늘 일일업무일지에 기록된 출·퇴근시간을 함께 보여준다.
  const todayLogs = teamCloud.teamDayLogs.get(dateKey(new Date())) || [];
  const todayLogByUser = new Map(todayLogs.map(x => [x.user_id, x]));

  teamCloud.members.forEach(member => {
    const record = teamCloud.memberStatus.get(member.user_id);
    const status = effectiveStatus(record);
    const isMe = member.user_id === teamCloud.user.id;
    const log = todayLogByUser.get(member.user_id);
    const times = log && (log.start_time || log.end_time)
      ? `${log.start_time || "-"} ~ ${log.end_time || "-"}`
      : "";

    const row = document.createElement("div");
    row.className = `status-row${isMe ? " me" : ""}`;
    row.innerHTML = `
      <span class="status-dot ${status}" title="${STATUS_LABELS[status]}"></span>
      <div class="status-name">
        <div class="status-person">${escapeHtml(member.display_name || "이름 미설정")}${isMe ? '<span class="me-badge">나</span>' : ""}</div>
        <div class="status-sub">${escapeHtml(member.job_title || "")} ${STATUS_LABELS[status]}</div>
        ${times ? `<div class="status-time">${escapeHtml(times)}</div>` : ""}
      </div>
    `;
    wrap.appendChild(row);
  });
}


/* ---------------------------------------------------------- 출·퇴근 시각 기록 */

function nowTimeValue(){
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* 오늘(또는 지정한 날짜)의 출·퇴근 시각을 읽는다. */
function getMyTimes(key = dateKey(new Date())) {
  if (teamCloud.configured && teamCloud.user) {
    const t = teamCloud.myTimesByDate.get(key);
    return { start_time: t?.start_time || "", end_time: t?.end_time || "" };
  }
  const log = data.dailyLogs?.[key];
  return { start_time: log?.start_time || "", end_time: log?.end_time || "" };
}

/* 출·퇴근 시각을 저장한다. 야근 인정시간도 함께 다시 계산한다. */
async function saveMyTimes(patch, key = dateKey(new Date())) {
  const current = getMyTimes(key);
  const next = {
    start_time: patch.start_time !== undefined ? (patch.start_time || "") : current.start_time,
    end_time: patch.end_time !== undefined ? (patch.end_time || "") : current.end_time
  };
  const overtimeHours = calculateOvertimeHours(next.start_time, next.end_time);

  if (teamCloud.configured && teamCloud.user) {
    const { error } = await teamCloud.client.from("daily_logs").upsert({
      user_id: teamCloud.user.id,
      work_date: key,
      start_time: next.start_time || null,
      end_time: next.end_time || null,
      overtime_hours: overtimeHours,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,work_date" });

    if (error) {
      console.error(error);
      alert("출·퇴근 시각을 저장하지 못했어.");
      return false;
    }

    teamCloud.myTimesByDate.set(key, next);
    teamCloud.myLoggedDates.add(key);
    teamCloud.myOvertimeByDate.set(key, overtimeHours);
    if (!teamCloud.myWorkStatusByDate.has(key)) teamCloud.myWorkStatusByDate.set(key, "정상근무");
    if (teamCloud.teamId) await loadTeamMonthLogs();
  } else {
    data.dailyLogs = data.dailyLogs || {};
    const log = data.dailyLogs[key] || {
      morning: "", afternoon: "", overtime: "",
      start_time: "", end_time: "", overtime_hours: 0, work_status: "정상근무"
    };
    data.dailyLogs[key] = { ...log, ...next, overtime_hours: overtimeHours };
    persist();
  }

  renderWorkTimeBox();
  renderCalendar();
  renderAnnualCalendar();
  renderSummary();
  renderPayBreakdown();
  renderStatusBar();
  if ($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
  return true;
}

/* 오늘의 근무 상태(정상근무 · 외근 · 연차)를 바꾼다. */
async function saveMyWorkStatus(status, key = dateKey(new Date())) {
  if (teamCloud.configured && teamCloud.user) {
    const { error } = await teamCloud.client.from("daily_logs").upsert({
      user_id: teamCloud.user.id,
      work_date: key,
      work_status: status,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,work_date" });

    if (error) { console.error(error); return; }

    teamCloud.myLoggedDates.add(key);
    teamCloud.myWorkStatusByDate.set(key, status);
    if (teamCloud.teamId) await loadTeamMonthLogs();
  } else {
    data.dailyLogs = data.dailyLogs || {};
    const log = data.dailyLogs[key] || {
      morning: "", afternoon: "", overtime: "",
      start_time: "", end_time: "", overtime_hours: 0, work_status: "정상근무"
    };
    data.dailyLogs[key] = { ...log, work_status: status };
    persist();
  }

  renderCalendar();
  renderAnnualCalendar();
  renderLeavePage();
  if ($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
}

function renderWorkTimeBox() {
  const box = $("workTimeBox");
  if (!box) return;

  const times = getMyTimes();
  const start = $("todayStartTime");
  const end = $("todayEndTime");
  if (start && document.activeElement !== start) start.value = times.start_time || "";
  if (end && document.activeElement !== end) end.value = times.end_time || "";

  const note = $("workTimeNote");
  if (note) {
    const hours = calculateOvertimeHours(times.start_time, times.end_time);
    note.textContent = times.end_time
      ? `퇴근 ${times.end_time} · 인정 야근 ${formatHours(hours)}시간`
      : "출근·퇴근 버튼을 누르면 그 시각이 자동으로 기록돼.";
  }
}

async function stampWorkTime(kind, { onlyIfEmpty = false } = {}) {
  const times = getMyTimes();
  if (onlyIfEmpty && times[kind === "start" ? "start_time" : "end_time"]) return;
  await saveMyTimes(kind === "start"
    ? { start_time: nowTimeValue() }
    : { end_time: nowTimeValue() });
}

/* 상태 버튼 클릭 처리
     출근 → 출근시각이 비어 있으면 지금 시각으로 기록 · 외근이었으면 정상근무로 되돌림
     외근 → 오늘 근무상태를 '외근' 으로 기록 (월간일정표에 🚗 로 표시됨)
     퇴근 → 퇴근시각을 지금 시각으로 기록                                    */
async function handleStatusClick(status) {
  const today = dateKey(new Date());
  const currentWorkStatus = normalizeLeaveStatus(getMyDailySummary(today).work_status);

  if (status === "working") {
    if (currentWorkStatus === "외근") await saveMyWorkStatus("정상근무", today);
    await stampWorkTime("start", { onlyIfEmpty: true });
  } else if (status === "field") {
    await saveMyWorkStatus("외근", today);
    await stampWorkTime("start", { onlyIfEmpty: true });
  } else if (status === "off") {
    await stampWorkTime("end");
  }

  await setMyStatus(status);
}

async function setMyStatus(status, silent = false) {
  if (!teamCloud.client || !teamCloud.user || !teamCloud.teamId) return;
  if (!STATUS_LABELS[status]) return;

  const today = dateKey(new Date());
  const payload = {
    user_id: teamCloud.user.id,
    status,
    status_date: today,
    updated_at: new Date().toISOString()
  };

  // 화면을 먼저 바꾸고 저장한다 (실패하면 되돌린다)
  const previous = teamCloud.memberStatus.get(teamCloud.user.id);
  teamCloud.memberStatus.set(teamCloud.user.id, payload);
  renderStatusBar();

  const { error } = await teamCloud.client
    .from("member_status")
    .upsert(payload, { onConflict: "user_id" });

  if (error) {
    console.error(error);
    if (previous) teamCloud.memberStatus.set(teamCloud.user.id, previous);
    else teamCloud.memberStatus.delete(teamCloud.user.id);
    renderStatusBar();
    if (!silent) alert("상태를 저장하지 못했어.");
  }
}

function subscribeStatusRealtime() {
  if (!teamCloud.client || !teamCloud.user || !teamCloud.teamId) return;
  unsubscribeStatusRealtime();

  teamCloud.statusChannel = teamCloud.client
    .channel(`status-${teamCloud.teamId}`)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "member_status" },
      () => refreshTeamMembers())
    .subscribe();
}

function unsubscribeStatusRealtime() {
  if (teamCloud.statusChannel) {
    teamCloud.client?.removeChannel(teamCloud.statusChannel);
    teamCloud.statusChannel = null;
  }
}
