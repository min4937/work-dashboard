/* ============================================================================
   Supabase 연결 · 내 프로필 · 팀 정보
   ============================================================================ */

async function loadMyLoggedDates(year=viewDate.getFullYear()){
  if(!teamCloud.client || !teamCloud.user){
    teamCloud.myLoggedDates=new Set();
    teamCloud.myOvertimeByDate=new Map();
    teamCloud.myWorkStatusByDate=new Map();
    return;
  }

  const from=`${year}-01-01`;
  const to=`${year}-12-31`;

  const {data:rows,error}=await teamCloud.client
    .from("daily_logs")
    .select("work_date,overtime_hours,work_status")
    .eq("user_id",teamCloud.user.id)
    .gte("work_date",from)
    .lte("work_date",to);

  if(error){
    console.error(error);
    return;
  }

  // 해당 연도 데이터만 갱신하고 다른 연도 캐시는 유지
  for(const key of [...teamCloud.myLoggedDates]){
    if(key.startsWith(`${year}-`)) teamCloud.myLoggedDates.delete(key);
  }
  for(const key of [...teamCloud.myOvertimeByDate.keys()]){
    if(key.startsWith(`${year}-`)) teamCloud.myOvertimeByDate.delete(key);
  }
  for(const key of [...teamCloud.myWorkStatusByDate.keys()]){
    if(key.startsWith(`${year}-`)) teamCloud.myWorkStatusByDate.delete(key);
  }

  (rows||[]).forEach(r=>{
    teamCloud.myLoggedDates.add(r.work_date);
    teamCloud.myOvertimeByDate.set(r.work_date,Number(r.overtime_hours||0));
    teamCloud.myWorkStatusByDate.set(r.work_date,r.work_status||"정상근무");
  });

  renderCalendar();
  renderAnnualCalendar();
  renderSummary();
  renderPayBreakdown();
  renderLeavePage();
}


function updateSyncUi(){
  updateGlobalAuthUi();
  const dot=$("syncDot");
  const text=$("syncStatusText");

  if(!dot||!text) return;

  if(!teamCloud.configured){
    dot.className="sync-dot wait";
    text.textContent="팀 연동 설정 필요 · 현재는 내 브라우저에만 저장";
    return;
  }

  if(teamCloud.user && teamCloud.teamId){
    dot.className="sync-dot on";
    text.textContent=`${teamCloud.teamName} · ${teamCloud.user.email}`;
  }else if(teamCloud.user){
    dot.className="sync-dot wait";
    text.textContent="아직 소속 팀이 없어 · 팀을 만들거나 초대코드로 참여해";
  }else{
    dot.className="sync-dot wait";
    text.textContent="로그인 전 · 이 브라우저에만 저장돼";
  }
}


function updateTeamInfoButton(){
  const b=$("teamInfoBtn");
  if(b) b.textContent=teamCloud.teamId ? `팀 · ${teamCloud.teamName}` : "팀 정보";
}


/* 내 프로필 → 소속 팀 → (팀장이면) 초대코드 순서로 읽는다. */
async function loadTeamMeta(){
  if(!teamCloud.client||!teamCloud.user){
    teamCloud.profile=null;
    teamCloud.teamId=null;
    teamCloud.teamName="우리 팀";
    teamCloud.isLeader=false;
    teamCloud.inviteCode="";
    updateTeamInfoButton();
    return;
  }

  const {data:p,error:pe}=await teamCloud.client
    .from("profiles")
    .select("user_id,team_id,display_name,job_title,sort_order")
    .eq("user_id",teamCloud.user.id)
    .maybeSingle();

  if(pe) console.error(pe);
  teamCloud.profile=p||null;
  teamCloud.teamId=p?.team_id||null;

  if(!teamCloud.teamId){
    teamCloud.teamName="우리 팀";
    teamCloud.isLeader=false;
    teamCloud.inviteCode="";
    updateTeamInfoButton();
    return;
  }

  const {data:t}=await teamCloud.client
    .from("teams")
    .select("id,name,leader_id")
    .eq("id",teamCloud.teamId)
    .maybeSingle();

  teamCloud.teamName=t?.name||"우리 팀";
  teamCloud.isLeader=t?.leader_id===teamCloud.user.id;

  if(teamCloud.isLeader){
    const {data:inv}=await teamCloud.client
      .from("team_invites")
      .select("code")
      .eq("team_id",teamCloud.teamId)
      .maybeSingle();
    teamCloud.inviteCode=inv?.code||"";
  }else{
    teamCloud.inviteCode="";
  }

  updateTeamInfoButton();
}


/* 내 이름·직급을 팀에 공개되는 프로필에 반영한다. */
async function syncMyCloudProfile(){
  if(!teamCloud.client || !teamCloud.user || !teamCloud.teamId) return;

  const local=(data.settings.userName||"").trim();
  const server=(teamCloud.profile?.display_name||"").trim();

  // 새 기기에서 로컬이 비어 있으면 서버 이름을 가져다 쓴다 (덮어쓰기 방지)
  if(!local && server){
    data.settings.userName=server;
    if(!data.settings.jobTitle && teamCloud.profile?.job_title){
      data.settings.jobTitle=teamCloud.profile.job_title;
    }
    localStorage.setItem(STORAGE_KEY,JSON.stringify(data));
    renderSettings();
    updateBranding();
  }

  const display=(data.settings.userName||"").trim() || server || (teamCloud.user.email||"팀원").split("@")[0];
  const title=(data.settings.jobTitle||"").trim() || (teamCloud.profile?.job_title||"");

  const {error}=await teamCloud.client.from("profiles").update({
    display_name:display,
    job_title:title,
    sort_order:jobTitleSortOrder(title),
    updated_at:new Date().toISOString()
  }).eq("user_id",teamCloud.user.id);

  if(error) console.error(error);
}


/* 팀원 목록 + 현재 상태를 읽어 사이드바를 다시 그린다. */
async function refreshTeamMembers(){
  if(!teamCloud.client||!teamCloud.user||!teamCloud.teamId){
    teamCloud.members=[];
    teamCloud.memberStatus=new Map();
    renderStatusBar();
    return;
  }

  const [{data:members,error:me},{data:statuses,error:se}]=await Promise.all([
    teamCloud.client.from("profiles")
      .select("user_id,display_name,job_title,sort_order")
      .eq("team_id",teamCloud.teamId),
    teamCloud.client.from("member_status").select("user_id,status,status_date,updated_at")
  ]);

  if(me){console.error(me);return;}
  if(se) console.error(se);

  teamCloud.members=sortTeamMembers(members||[]);
  teamCloud.memberStatus=new Map((statuses||[]).map(s=>[s.user_id,s]));
  renderStatusBar();
}


/* ------------------------------------------------------------------ 팀 모달 */

async function openTeamModal(){
  $("teamModal").classList.add("open");
  $("teamModal").setAttribute("aria-hidden","false");

  if(!teamCloud.user){
    $("teamModalLoggedOut").style.display="block";
    $("teamModalLoggedIn").style.display="none";
    return;
  }

  $("teamModalLoggedOut").style.display="none";
  $("teamModalLoggedIn").style.display="block";
  await loadTeamMeta();

  if(!teamCloud.teamId){
    $("teamMemberList").innerHTML='<div class="empty">아직 소속 팀이 없어. 팀을 만들거나 초대코드로 참여해줘.</div>';
    $("teamNameDisplay").textContent="소속 팀 없음";
    $("teamNameManagerArea").style.display="none";
    $("inviteCodeArea").style.display="none";
    $("teamAdminNote").textContent="";
    return;
  }

  $("teamNameDisplay").textContent=teamCloud.teamName;
  $("teamNameInput").value=teamCloud.teamName;
  $("teamNameManagerArea").style.display=teamCloud.isLeader?"block":"none";
  $("teamAdminNote").textContent=teamCloud.isLeader
    ? "팀장은 팀 이름을 바꾸고 초대코드를 재발급할 수 있어."
    : "팀 이름 변경과 초대코드 발급은 팀장만 할 수 있어.";

  // 초대코드는 팀장에게만 보인다
  $("inviteCodeArea").style.display=teamCloud.isLeader?"block":"none";
  if(teamCloud.isLeader) $("inviteCodeValue").textContent=teamCloud.inviteCode||"-";

  const {data:m,error}=await teamCloud.client
    .from("profiles")
    .select("user_id,display_name,job_title,sort_order")
    .eq("team_id",teamCloud.teamId);

  if(error){
    $("teamMemberList").innerHTML='<div class="empty">팀원 목록을 불러오지 못했어.</div>';
    return;
  }

  const {data:t}=await teamCloud.client
    .from("teams").select("leader_id").eq("id",teamCloud.teamId).maybeSingle();
  const leaderId=t?.leader_id;

  const list=$("teamMemberList");
  list.innerHTML="";
  sortTeamMembers(m||[]).forEach(x=>{
    const row=document.createElement("div");
    row.className="team-member-row";
    const isLeaderRow=x.user_id===leaderId;
    row.innerHTML=
      `<div><div class="team-member-name">${escapeHtml(x.display_name||"이름 미설정")}</div>`+
      `${isLeaderRow?'<span class="leader-badge" style="margin-top:4px">팀장</span>':""}</div>`+
      `<span class="team-rank-badge">${escapeHtml(x.job_title||"직급 미설정")}</span>`+
      `<span>${x.user_id===teamCloud.user.id?'<span class="me-badge">나</span>':""}</span>`;
    list.appendChild(row);
  });
}

function closeTeamModal(){
  $("teamModal").classList.remove("open");
  $("teamModal").setAttribute("aria-hidden","true");
}

async function rotateInviteCode(){
  if(!teamCloud.isLeader) return;
  if(!confirm("초대코드를 새로 발급할까? 기존 코드는 즉시 사용할 수 없게 돼.")) return;
  const {data:code,error}=await teamCloud.client.rpc("rotate_invite_code");
  if(error){
    alert(error.message||"초대코드 재발급에 실패했어.");
    return;
  }
  teamCloud.inviteCode=code||"";
  $("inviteCodeValue").textContent=teamCloud.inviteCode||"-";
}

function copyInviteCode(){
  if(!teamCloud.inviteCode) return;
  navigator.clipboard?.writeText(teamCloud.inviteCode).then(
    ()=>{
      const b=$("copyInviteCode");
      const old=b.textContent;
      b.textContent="복사됨!";
      setTimeout(()=>{b.textContent=old;},1500);
    },
    ()=>alert(`초대코드: ${teamCloud.inviteCode}`)
  );
}


/* ---------------------------------------------------------------- 초기화 */

async function applySignedInState(){
  await loadTeamMeta();
  await ensureTeamMembership();
  await pullUserState();
  await syncMyCloudProfile();
  await loadMyLoggedDates(viewDate.getFullYear());
  await refreshTeamMembers();
  subscribeStatusRealtime();
  updateSyncUi();
  renderAll();
}

async function initTeamCloud(){
  const cfg=window.TEAM_SYNC_CONFIG||{};
  const url=(cfg.supabaseUrl||"").trim();
  const key=(cfg.supabasePublishableKey||"").trim();

  if(!url || !key || !window.supabase || url.includes("<")){
    teamCloud.configured=false;
    updateSyncUi();
    updateGlobalAuthUi();
    renderStatusBar();
    renderDailyLogPage();
    return;
  }

  teamCloud.configured=true;
  teamCloud.client=window.supabase.createClient(url,key);
  updateGlobalAuthUi();

  // 공휴일은 로그인 전에도 달력에 필요하다.
  loadCloudHolidays();

  const {data:{session}}=await teamCloud.client.auth.getSession();
  teamCloud.user=session?.user||null;

  if(teamCloud.user) await applySignedInState();

  teamCloud.client.auth.onAuthStateChange(async(event,session)=>{
    if(event==="PASSWORD_RECOVERY"){
      await handlePasswordRecovery();
      return;
    }

    teamCloud.user=session?.user||null;
    updateSyncUi();
    updateGlobalAuthUi();

    if(teamCloud.user){
      await applySignedInState();
    }else{
      unsubscribeStatusRealtime();
      renderStatusBar();
      renderAll();
    }

    if($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
    if($("weeklyLogPage")?.classList.contains("active")) renderWeeklyLogPage();
  });

  updateSyncUi();
  updateGlobalAuthUi();
  renderStatusBar();
  if($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
  if($("weeklyLogPage")?.classList.contains("active")) renderWeeklyLogPage();
}
