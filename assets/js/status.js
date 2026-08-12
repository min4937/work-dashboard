/* ============================================================================
   근무 상태바 (왼쪽 사이드바)

     초록 working  출근
     노랑 away     자리비움
     회색 off      퇴근 / 미출근

   본인 상태만 바꿀 수 있고, 같은 팀원에게 실시간으로 보인다.
   일일업무일지에 퇴근시간을 넣어 저장하면 자동으로 회색이 된다.
   ============================================================================ */

const STATUS_LABELS = { working: "출근", away: "자리비움", off: "퇴근" };

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
  ["working", "away", "off"].forEach(s => {
    const btn = $(`statusBtn_${s}`);
    if (btn) btn.classList.toggle("active", mine === s);
  });

  wrap.innerHTML = "";
  if (!teamCloud.members.length) {
    wrap.innerHTML = '<div class="status-empty">팀원이 없어.</div>';
    return;
  }

  teamCloud.members.forEach(member => {
    const record = teamCloud.memberStatus.get(member.user_id);
    const status = effectiveStatus(record);
    const isMe = member.user_id === teamCloud.user.id;

    const row = document.createElement("div");
    row.className = `status-row${isMe ? " me" : ""}`;
    row.innerHTML = `
      <span class="status-dot ${status}" title="${STATUS_LABELS[status]}"></span>
      <div class="status-name">
        <div class="status-person">${escapeHtml(member.display_name || "이름 미설정")}${isMe ? '<span class="me-badge">나</span>' : ""}</div>
        <div class="status-sub">${escapeHtml(member.job_title || "")} ${STATUS_LABELS[status]}</div>
      </div>
    `;
    wrap.appendChild(row);
  });
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
