/* ============================================================================
   화면 렌더 오케스트레이션 · 이벤트 연결 · 초기화
   이 파일은 항상 마지막에 로드된다.
   ============================================================================ */

function renderSettings(){
  Object.keys(defaultSettings).forEach(k=>{
    const el=$(k);
    if(!el) return;
    if(el.tagName==="SELECT"){
      el.value=data.settings[k]??defaultSettings[k];
    }else if(typeof defaultSettings[k]==="number"){
      el.value=Number(data.settings[k]||0) || "";
    }else{
      el.value=data.settings[k]??defaultSettings[k];
    }
  });
  renderPayBreakdown();
}

function renderAll(){
  renderAnnualCalendar();
  renderCalendar();
  renderSummary();
  renderPayBreakdown();
  renderLeavePage();
  renderStatusBar();
  const dailyPage=$("dailyLogPage");
  if(dailyPage?.classList.contains("active")) renderDailyLogPage();
  const weeklyPage=$("weeklyLogPage");
  if(weeklyPage?.classList.contains("active")) renderWeeklyLogPage();
  const manualPage=$("manualPage");
  if(manualPage?.classList.contains("active")) renderManualPage();
}

function updateBranding(){
  const name=(data.settings.userName||"").trim();
  const company=(data.settings.companyName||"").trim();

  $("appTitle").textContent = name ? `${name}님의 회사생활 대시보드` : "회사생활 대시보드";
  $("appSubtitle").textContent = company
    ? `${company} · 일정 · 팀 업무일지 · 야근 · 급여 · 연차 관리`
    : "내 일정 · 팀 업무일지 · 야근 · 급여 · 연차를 한 곳에서 관리해.";
}

function openProfileModal(firstVisit=false){
  $("profileUserName").value=data.settings.userName||"";
  $("profileCompanyName").value=data.settings.companyName||"";
  $("profileJobTitle").value=data.settings.jobTitle||"";
  $("profileAnnualLeave").value=Number(data.settings.totalAnnualLeave||0) || "";
  $("profileBasicSalary").value=Number(data.settings.basicSalary||0) || "";
  $("profileOvertimeRate").value=Number(data.settings.hourlyOvertime||0) || "";

  $("profileModalTitle").textContent=firstVisit ? "내 대시보드 시작하기" : "내 정보";
  $("closeProfileModal").style.display=firstVisit ? "none" : "inline-block";
  $("profileDangerZone").style.display=firstVisit ? "none" : "block";

  $("profileSyncBox").style.display=firstVisit ? "none" : "block";
  $("restoreSyncBackup").style.display=localStorage.getItem(SYNC_BACKUP_KEY) ? "inline-block" : "none";
  setSyncStatus(teamCloud.user
    ? `${teamCloud.user.email} 계정과 동기화 중`
    : "로그인 전 · 이 브라우저에만 저장돼");
  $("profileModal").classList.add("open");
  $("profileModal").setAttribute("aria-hidden","false");
}

function closeProfileModal(){
  $("profileModal").classList.remove("open");
  $("profileModal").setAttribute("aria-hidden","true");
}


/* ------------------------------------------------------------ 설정 · 연차 */

if($("leaveRequestDate")&&!$("leaveRequestDate").value)$("leaveRequestDate").value=dateKey(new Date());

$("saveLeaveSettings").addEventListener("click",()=>{
  data.settings.totalAnnualLeave=Number($("totalAnnualLeave").value||0);
  persist();
  renderLeavePage();
  alert("올해 총 연차를 저장했어.");
});

$("saveSettings").addEventListener("click",()=>{
  const s={...data.settings};
  Object.keys(defaultSettings).forEach(k=>{
    const el=$(k);
    if(!el) return;
    if(el.tagName==="SELECT"){
      s[k]=el.value;
    }else if(typeof defaultSettings[k]==="number"){
      s[k]=Number(el.value||0);
    }else{
      s[k]=el.value;
    }
  });
  data.settings={...defaultSettings,...s};
  applyFixedOvertimeRules();
  data.settings.payDay=Math.min(31,Math.max(1,Number(data.settings.payDay||25)));
  persist();          // persist() 가 클라우드 동기화까지 예약한다
  renderAll();
  updateBranding();
  alert("급여·공제·퇴직연금 설정을 저장했어.");
});


/* -------------------------------------------------------- 주간 · 일일 이동 */

$("prevWeeklyDate").addEventListener("click",()=>{
  weeklyAnchorDate=startOfWeek(weeklyAnchorDate);
  weeklyAnchorDate.setDate(weeklyAnchorDate.getDate()-7);
  renderWeeklyLogPage();
});

$("nextWeeklyDate").addEventListener("click",()=>{
  weeklyAnchorDate=startOfWeek(weeklyAnchorDate);
  weeklyAnchorDate.setDate(weeklyAnchorDate.getDate()+7);
  renderWeeklyLogPage();
});

$("thisWeekBtn").addEventListener("click",()=>{
  weeklyAnchorDate=startOfWeek(new Date());
  renderWeeklyLogPage();
});

$("prevDailyDate").addEventListener("click",()=>{
  const d=new Date(dailyLogDate+"T00:00:00");
  d.setDate(d.getDate()-1);
  dailyLogDate=dateKey(d);
  renderDailyLogPage();
});
$("nextDailyDate").addEventListener("click",()=>{
  const d=new Date(dailyLogDate+"T00:00:00");
  d.setDate(d.getDate()+1);
  dailyLogDate=dateKey(d);
  renderDailyLogPage();
});
$("todayDailyDate").addEventListener("click",()=>{
  dailyLogDate=dateKey(new Date());
  renderDailyLogPage();
});
$("dailyToSchedule").addEventListener("click",()=>{
  const d=new Date(dailyLogDate+"T00:00:00");
  viewDate=new Date(d.getFullYear(),d.getMonth(),1);
  renderAll();
  const monthlyBtn=document.querySelector('[data-page="schedulePage"]');
  if(monthlyBtn) monthlyBtn.click();
});
$("saveDailyLog").addEventListener("click",saveMyDailyLog);
$("dailySignInBtn").addEventListener("click",openLoginModal);


/* --------------------------------------------------------------- 연/월 이동 */

$("prevYear").addEventListener("click",()=>{
  annualYear--;
  renderAnnualCalendar();
});
$("nextYear").addEventListener("click",()=>{
  annualYear++;
  renderAnnualCalendar();
});
$("thisYearBtn").addEventListener("click",()=>{
  annualYear=new Date().getFullYear();
  renderAnnualCalendar();
});

$("prevMonth").addEventListener("click",async()=>{
  viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()-1,1);
  if(teamCloud.configured && teamCloud.user) await loadMyLoggedDates();
  renderAll();
});
$("nextMonth").addEventListener("click",async()=>{
  viewDate=new Date(viewDate.getFullYear(),viewDate.getMonth()+1,1);
  if(teamCloud.configured && teamCloud.user) await loadMyLoggedDates();
  renderAll();
});
$("todayBtn").addEventListener("click",async()=>{
  const now=new Date();
  viewDate=new Date(now.getFullYear(),now.getMonth(),1);
  if(teamCloud.configured && teamCloud.user) await loadMyLoggedDates(viewDate.getFullYear());
  renderAll();
});


/* --------------------------------------------------------- 백업 · 불러오기 */

$("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`회사대시보드_백업_${dateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("importBtn").addEventListener("click",()=>$("importFile").click());
$("importFile").addEventListener("change",async(e)=>{
  const file=e.target.files?.[0];
  if(!file)return;
  try{
    const obj=JSON.parse(await file.text());
    if(!obj.settings||!obj.records)throw new Error("형식 오류");
    data={
      settings:{...defaultSettings,...obj.settings},
      records:obj.records,
      dailyLogs:obj.dailyLogs||{},
      weeklyMemos:obj.weeklyMemos||{},
      updatedAt:new Date().toISOString()
    };
    applyFixedOvertimeRules();
    persist();
    renderSettings();
    renderAll();
    alert("백업을 불러왔어.");
  }catch(err){
    alert("올바른 백업 파일이 아니야.");
  }
  e.target.value="";
});


/* ------------------------------------------------------------------ 팀 모달 */

$("teamInfoBtn").addEventListener("click",openTeamModal);
$("closeTeamModal").addEventListener("click",closeTeamModal);
$("teamModal").addEventListener("click",e=>{if(e.target===$("teamModal"))closeTeamModal();});

$("saveTeamName").addEventListener("click",async()=>{
  if(!teamCloud.user||!teamCloud.isLeader||!teamCloud.teamId) return;
  const name=$("teamNameInput").value.trim();
  if(!name) return;
  const {error}=await teamCloud.client.from("teams")
    .update({name,updated_at:new Date().toISOString()})
    .eq("id",teamCloud.teamId);
  if(error){ alert("팀 이름 저장에 실패했어."); return; }
  teamCloud.teamName=name;
  updateTeamInfoButton();
  updateSyncUi();
  await openTeamModal();
});

$("rotateInviteCode").addEventListener("click",rotateInviteCode);
$("copyInviteCode").addEventListener("click",copyInviteCode);

$("uploadManualFile").addEventListener("click",uploadManualFile);
$("refreshManualFiles").addEventListener("click",loadManualFiles);
$("submitLeaveRequest").addEventListener("click",submitLeaveRequest);


/* --------------------------------------------------------------- 로그인 모달 */

$("globalAuthBtn").addEventListener("click",openLoginModal);
$("closeLoginModal").addEventListener("click",closeLoginModal);
$("loginModal").addEventListener("click",e=>{
  if(e.target===$("loginModal")) closeLoginModal();
});

$("authTabSignin").addEventListener("click",()=>switchAuthTab(AUTH_TAB_SIGNIN));
$("authTabSignup").addEventListener("click",()=>switchAuthTab(AUTH_TAB_SIGNUP));

$("signinSubmit").addEventListener("click",signInWithPassword);
$("signupSubmit").addEventListener("click",signUpWithPassword);
$("forgotPassword").addEventListener("click",sendPasswordReset);
$("signupAsLeader").addEventListener("change",updateSignupRoleFields);

$("signinPassword").addEventListener("keydown",e=>{
  if(e.key==="Enter"){ e.preventDefault(); signInWithPassword(); }
});
$("signinEmail").addEventListener("keydown",e=>{
  if(e.key==="Enter"){ e.preventDefault(); $("signinPassword").focus(); }
});

$("globalSignOut").addEventListener("click",async()=>{
  await signOut();
  updateSyncUi();
  renderAll();
});


/* ------------------------------------------------------------ 팀 배정 모달 */

$("teamSetupAsLeader").addEventListener("change",updateTeamSetupFields);
$("teamSetupSubmit").addEventListener("click",submitTeamSetup);
$("teamSetupSignOut").addEventListener("click",async()=>{
  closeTeamSetupModal();
  await signOut();
  updateSyncUi();
  renderAll();
});


/* ------------------------------------------------------------------ 상태바 */

["working","away","off"].forEach(status=>{
  $(`statusBtn_${status}`).addEventListener("click",()=>setMyStatus(status));
});


/* ------------------------------------------------------------------ 내 정보 */

$("profileBtn").addEventListener("click",()=>openProfileModal(false));
$("closeProfileModal").addEventListener("click",closeProfileModal);
$("restoreSyncBackup").addEventListener("click",restorePreSyncBackup);

$("saveProfile").addEventListener("click",()=>{
  data.settings.userName=$("profileUserName").value.trim();
  data.settings.companyName=$("profileCompanyName").value.trim();
  data.settings.jobTitle=$("profileJobTitle").value;
  data.settings.totalAnnualLeave=Number($("profileAnnualLeave").value||0);
  data.settings.basicSalary=Number($("profileBasicSalary").value||0);
  data.settings.hourlyOvertime=Number($("profileOvertimeRate").value||0);
  data.settings.onboardingDone=true;
  persist();
  renderSettings();
  renderAll();
  updateBranding();
  closeProfileModal();
  if(teamCloud.user && teamCloud.teamId){
    syncMyCloudProfile()
      .then(refreshTeamMembers)
      .then(()=>{
        if($("dailyLogPage")?.classList.contains("active")) renderDailyLogPage();
        if($("weeklyLogPage")?.classList.contains("active")) renderWeeklyLogPage();
      });
  }
});

$("resetAllData").addEventListener("click",async()=>{
  const scope=teamCloud.user
    ? "이 브라우저와 클라우드 계정에 저장된"
    : "이 브라우저에 저장된";
  const ok=confirm(`${scope} 일정, 급여, 연차 등 모든 데이터를 삭제할까? 이 작업은 되돌릴 수 없어.`);
  if(!ok) return;

  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(OLD_STORAGE_KEY);
  localStorage.removeItem("myCompanyDashboard_lastPage");
  localStorage.removeItem(SYNC_BACKUP_KEY);

  // 클라우드에도 지워야 다음 로그인 때 되살아나지 않는다.
  if(teamCloud.client && teamCloud.user){
    await teamCloud.client.from("user_state").delete().eq("user_id",teamCloud.user.id);
  }

  data=structuredClone(defaultData);
  applyFixedOvertimeRules();
  viewDate=new Date();
  viewDate.setDate(1);
  annualYear=new Date().getFullYear();
  renderSettings();
  renderAll();
  updateBranding();
  openProfileModal(true);
});


/* --------------------------------------------------------------- 탭 전환 */

document.querySelectorAll(".top-tab").forEach(btn=>{
  btn.addEventListener("click",async()=>{
    const pageId=btn.dataset.page;
    document.querySelectorAll(".top-tab").forEach(b=>b.classList.toggle("active",b===btn));
    document.querySelectorAll(".page-view").forEach(p=>p.classList.toggle("active",p.id===pageId));

    // 월 이동 버튼은 월간일정표에서만 표시
    $("monthNav").style.display = pageId==="schedulePage" ? "flex" : "none";

    // 마지막으로 열어본 페이지 기억
    localStorage.setItem("myCompanyDashboard_lastPage",pageId);

    if(pageId==="dailyLogPage") await renderDailyLogPage();
    if(pageId==="weeklyLogPage") await renderWeeklyLogPage();
    if(pageId==="manualPage") await renderManualPage();
    if(pageId==="leavePage" && teamCloud.configured && teamCloud.user) await loadLeaveRequests();

    if(pageId==="salaryPage" && teamCloud.configured && teamCloud.user){
      const sourceMonth=payrollOvertimeMonth();
      await loadMyLoggedDates(sourceMonth.getFullYear());
      renderSummary();
      renderPayBreakdown();
    }
  });
});


/* ----------------------------------------------------------------- 부팅 */

const lastPage=localStorage.getItem("myCompanyDashboard_lastPage");
if(["annualPage","schedulePage","dailyLogPage","weeklyLogPage","manualPage","salaryPage","leavePage"].includes(lastPage)){
  const savedBtn=document.querySelector(`[data-page="${lastPage}"]`);
  if(savedBtn) savedBtn.click();
}else{
  const annualBtn=document.querySelector('[data-page="annualPage"]');
  if(annualBtn) annualBtn.click();
}

renderSettings();
renderAll();
updateBranding();

if(!data.settings.onboardingDone){
  openProfileModal(true);
}
initTeamCloud();
