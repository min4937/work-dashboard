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

function setGlobalLoginStatus(message,type=""){
  const el=$("globalLoginStatus");
  if(!el) return;
  el.textContent=message||"";
  el.className=`login-status${type?` ${type}`:""}`;
}

function openLoginModal(){
  const modal=$("loginModal");
  if(!modal) return;
  updateGlobalAuthUi();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden","false");
  if(!teamCloud.user){
    requestAnimationFrame(()=>$("globalTeamEmail")?.focus());
  }
}

function closeLoginModal(){
  const modal=$("loginModal");
  if(!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden","true");
}

function updateGlobalAuthUi(){
  const btn=$("globalAuthBtn");
  const state=$("globalAuthState");
  const signedOut=$("loginSignedOutArea");
  const signedIn=$("loginSignedInArea");
  const email=$("loginUserEmail");

  if(!btn||!state) return;

  if(!teamCloud.configured){
    state.textContent="팀 연동 설정 필요";
    btn.textContent="팀 로그인";
    if(signedOut) signedOut.style.display="block";
    if(signedIn) signedIn.style.display="none";
    setGlobalLoginStatus("Supabase 연결 설정을 확인해줘.","error");
    return;
  }

  if(teamCloud.user){
    state.textContent=teamCloud.user.email||"로그인됨";
    btn.textContent="로그인됨";
    if(email) email.textContent=teamCloud.user.email||"";
    if(signedOut) signedOut.style.display="none";
    if(signedIn) signedIn.style.display="block";
    setGlobalLoginStatus("팀 업무일지가 Supabase와 연동되고 있어.","success");
  }else{
    state.textContent="팀 로그인 전";
    btn.textContent="팀 로그인";
    if(signedOut) signedOut.style.display="block";
    if(signedIn) signedIn.style.display="none";
    setGlobalLoginStatus("Supabase에 등록된 팀원 이메일로 로그인해.");
  }
}

async function sendTeamMagicLink(email){
  if(!teamCloud.client){
    return {ok:false,message:"Supabase 연결이 아직 준비되지 않았어."};
  }
  const clean=String(email||"").trim();
  if(!clean){
    return {ok:false,message:"로그인할 이메일을 입력해줘."};
  }

  const redirectUrl=location.origin+location.pathname;
  const {error}=await teamCloud.client.auth.signInWithOtp({
    email:clean,
    options:{
      shouldCreateUser:false,
      emailRedirectTo:redirectUrl
    }
  });

  if(error){
    console.error(error);
    return {ok:false,message:"로그인 링크를 보내지 못했어. Supabase에 등록된 팀원 이메일인지 확인해줘."};
  }
  return {
    ok:true,
    message:"로그인 링크를 보냈어! 메일을 열어서 링크를 누르면 이 사이트로 돌아와 로그인돼."
  };
}

function updateSyncUi(){
  updateGlobalAuthUi();
  const dot=$("syncDot");
  const text=$("syncStatusText");
  const signOut=$("signOutTeam");
  const email=$("teamEmail");
  const send=$("sendMagicLink");
  const explain=$("cloudExplain");

  if(!teamCloud.configured){
    dot.className="sync-dot wait";
    text.textContent="팀 연동 설정 필요 · 현재는 내 브라우저에만 저장";
    signOut.style.display="none";
    email.style.display="none";
    send.style.display="none";
    explain.style.display="block";
    return;
  }

  if(teamCloud.user){
    dot.className="sync-dot on";
    text.textContent=`팀 연동됨 · ${teamCloud.user.email}`;
    signOut.style.display="inline-block";
    email.style.display="none";
    send.style.display="none";
    explain.style.display="none";
  }else{
    dot.className="sync-dot wait";
    text.textContent="팀 연동 준비됨 · 이메일로 로그인해";
    signOut.style.display="none";
    email.style.display="inline-block";
    send.style.display="inline-block";
    explain.style.display="block";
    explain.textContent="팀 계정으로 로그인하면 같은 날짜의 4명 업무일지가 한 화면에 표시돼. 로그인 링크는 등록된 팀원 이메일로만 보낼 수 있어.";
  }
}


function updateTeamInfoButton(){const b=$("teamInfoBtn");if(b)b.textContent=teamCloud.user?`팀 · ${teamCloud.teamName||"우리 팀"}`:"팀 정보";}
async function loadTeamMeta(){
  if(!teamCloud.client||!teamCloud.user){teamCloud.teamName="우리 팀";teamCloud.teamRoles=[];teamCloud.isPayrollManager=false;updateTeamInfoButton();return;}
  const [{data:s,error:se},{data:r,error:re}]=await Promise.all([teamCloud.client.from("team_settings").select("id,team_name").eq("id",1).maybeSingle(),teamCloud.client.from("team_roles").select("user_id,payroll_manager")]);
  if(!se&&s?.team_name)teamCloud.teamName=s.team_name;if(!re)teamCloud.teamRoles=r||[];teamCloud.isPayrollManager=teamCloud.teamRoles.some(x=>x.user_id===teamCloud.user.id&&x.payroll_manager===true);updateTeamInfoButton();
}
async function openTeamModal(){
  $("teamModal").classList.add("open");$("teamModal").setAttribute("aria-hidden","false");
  if(!teamCloud.user){$("teamModalLoggedOut").style.display="block";$("teamModalLoggedIn").style.display="none";return;}
  $("teamModalLoggedOut").style.display="none";$("teamModalLoggedIn").style.display="block";await loadTeamMeta();
  const {data:m,error}=await teamCloud.client.from("profiles").select("user_id,display_name,job_title,sort_order");if(error){$("teamMemberList").innerHTML='<div class="empty">팀원 목록을 불러오지 못했어.</div>';return;}
  $("teamNameDisplay").textContent=teamCloud.teamName;$("teamNameInput").value=teamCloud.teamName;$("teamNameManagerArea").style.display=teamCloud.isPayrollManager?"block":"none";$("teamAdminNote").textContent=teamCloud.isPayrollManager?"월급관리자는 팀 이름과 월급관리자 권한을 변경할 수 있어.":"팀 이름과 월급관리자 지정은 월급관리자만 변경할 수 있어.";
  const rm=new Map(teamCloud.teamRoles.map(x=>[x.user_id,!!x.payroll_manager])),list=$("teamMemberList");list.innerHTML="";
  sortTeamMembers(m||[]).forEach(x=>{const im=rm.get(x.user_id)===true,row=document.createElement("div");row.className="team-member-row";const a=teamCloud.isPayrollManager?`<button class="payroll-manage-btn" data-user="${x.user_id}" data-enabled="${im}">${im?"관리자 해제":"월급관리자 지정"}</button>`:(im?'<span class="payroll-badge">월급관리자</span>':'<span></span>');row.innerHTML=`<div><div class="team-member-name">${escapeHtml(x.display_name||"이름 미설정")}</div>${im?'<span class="payroll-badge" style="margin-top:4px">월급관리자</span>':""}</div><span class="team-rank-badge">${escapeHtml(x.job_title||"직급 미설정")}</span>${a}`;list.appendChild(row);});
  if(teamCloud.isPayrollManager)list.querySelectorAll(".payroll-manage-btn").forEach(b=>b.addEventListener("click",async()=>{b.disabled=true;const {error:e}=await teamCloud.client.rpc("set_payroll_manager",{target_user_id:b.dataset.user,enabled:b.dataset.enabled!=="true"});if(e){alert(e.message||"권한 변경 실패");b.disabled=false;return;}await loadTeamMeta();await openTeamModal();if($("salaryPage")?.classList.contains("active"))await loadPayrollManagerPanel();}));
}
function closeTeamModal(){$("teamModal").classList.remove("open");$("teamModal").setAttribute("aria-hidden","true");}

async function syncMyCloudProfile(){
  if(!teamCloud.client || !teamCloud.user) return;
  const display=(data.settings.userName||"").trim() || (teamCloud.user.email||"팀원").split("@")[0];
  const title=(data.settings.jobTitle||"").trim();
  const {error}=await teamCloud.client.from("profiles").upsert({
    user_id:teamCloud.user.id,
    display_name:display,
    job_title:title,
    sort_order:jobTitleSortOrder(title)
  },{onConflict:"user_id"});
  if(error) console.error(error);
}

async function initTeamCloud(){
  const cfg=window.TEAM_SYNC_CONFIG||{};
  const url=(cfg.supabaseUrl||"").trim();
  const key=(cfg.supabasePublishableKey||"").trim();

  if(!url || !key || !window.supabase){
    teamCloud.configured=false;
    updateSyncUi();
    updateGlobalAuthUi();
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

  if(teamCloud.user){
    await pullUserState();
    await syncMyCloudProfile();
    await loadTeamMeta();
    await loadMyLoggedDates(viewDate.getFullYear());
    const sourceMonth=payrollOvertimeMonth();
    if(sourceMonth.getFullYear()!==viewDate.getFullYear()){
      await loadMyLoggedDates(sourceMonth.getFullYear());
    }
    renderAll();
  }

  teamCloud.client.auth.onAuthStateChange(async(_event,session)=>{
    teamCloud.user=session?.user||null;
    updateSyncUi();
    updateGlobalAuthUi();
    if(teamCloud.user){
      await pullUserState();
      await syncMyCloudProfile();
      await loadTeamMeta();
      await loadMyLoggedDates(viewDate.getFullYear());
      const sourceMonth=payrollOvertimeMonth();
      if(sourceMonth.getFullYear()!==viewDate.getFullYear()){
        await loadMyLoggedDates(sourceMonth.getFullYear());
      }
      renderAll();
    }else{
      renderAll();
    }
    if($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
    if($("weeklyLogPage")?.classList.contains("active")) renderWeeklyLogPage();
  });

  updateSyncUi();
  updateGlobalAuthUi();
  if($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
  if($("weeklyLogPage")?.classList.contains("active")) renderWeeklyLogPage();
}
