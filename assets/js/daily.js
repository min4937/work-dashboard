function hasMyDailyLog(key){
  if(teamCloud.configured && teamCloud.user){
    return teamCloud.myLoggedDates.has(key);
  }
  return Boolean(data.dailyLogs && data.dailyLogs[key]);
}

function displayDailyDate(key){
  const d=new Date(key+"T00:00:00");
  const weekdays=["일","월","화","수","목","금","토"];
  return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${weekdays[d.getDay()]})`;
}

function setDailyMessage(msg, isError=false){
  const el=$("dailyMessage");
  if(!el) return;
  el.textContent=msg||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

function openDailyLog(key){
  dailyLogDate=key;
  const d=new Date(key+"T00:00:00");
  viewDate=new Date(d.getFullYear(),d.getMonth(),1);
  const btn=document.querySelector('[data-page="dailyLogPage"]');
  if(btn) btn.click();
  renderDailyLogPage();
}

function localDailyMember(){
  return {
    user_id:"local",
    display_name:(data.settings.userName||"내 업무").trim() || "내 업무",
    job_title:(data.settings.jobTitle||"").trim(),
    sort_order:jobTitleSortOrder(data.settings.jobTitle)
  };
}

function getLocalDailyLog(){
  return data.dailyLogs?.[dailyLogDate] || {
    morning:"",afternoon:"",overtime:"",start_time:"",end_time:"",
    overtime_hours:0,work_status:"정상근무"
  };
}

function renderDailyRows(members, logs, editableUserId){
  const body=$("dailyLogBody");
  if(!body) return;
  body.innerHTML="";

  if(!members.length){
    body.innerHTML='<tr><td colspan="4" style="padding:28px;text-align:center;color:var(--muted)">표시할 팀원이 없어.</td></tr>';
    return;
  }

  members.forEach(member=>{
    const log=logs.find(x=>x.user_id===member.user_id) || {
      morning:"",afternoon:"",overtime:"",start_time:"",end_time:"",
      overtime_hours:0,work_status:"정상근무"
    };
    const editable=member.user_id===editableUserId;
    const periods=[
      ["오전","morning"],
      ["오후","afternoon"],
      ["야근","overtime"]
    ];

    periods.forEach(([label,key],idx)=>{
      const tr=document.createElement("tr");

      if(idx===0){
        const tdName=document.createElement("td");
        tdName.className="daily-member";
        tdName.rowSpan=3;
        tdName.innerHTML=`
          ${escapeHtml(member.display_name||"이름 미설정")}
          ${member.job_title?`<div style="margin-top:4px;font-size:9px;color:var(--muted)">${escapeHtml(member.job_title)}</div>`:""}
          ${editable?'<div class="daily-own-label">내 업무</div>':""}
        `;
        tr.appendChild(tdName);
      }

      const tdPeriod=document.createElement("td");
      tdPeriod.className="daily-period";
      tdPeriod.textContent=label;
      tr.appendChild(tdPeriod);

      const tdContent=document.createElement("td");
      tdContent.className="daily-content";
      if(editable){
        tdContent.innerHTML=`<textarea class="daily-textarea" id="daily_${key}" placeholder="${label} 업무를 한 줄에 하나씩 입력">${escapeHtml(log[key]||"")}</textarea>`;
      }else{
        tdContent.innerHTML=`<div class="readonly-work">${workTextHtml(log[key])}</div>`;
      }
      tr.appendChild(tdContent);

      if(idx===0){
        const tdTime=document.createElement("td");
        tdTime.className="daily-time";
        tdTime.rowSpan=3;
        if(editable){
          tdTime.innerHTML=`
            <label style="text-align:left">출근</label>
            <input id="daily_start_time" type="time" value="${escapeHtml(log.start_time||"")}" />
            <label style="text-align:left;margin-top:9px">퇴근</label>
            <input id="daily_end_time" type="time" value="${escapeHtml(log.end_time||"")}" />
            <div class="auto-ot-mini" id="dailyOvertimeMini">자동 야근 ${formatHours(log.overtime_hours||0)}h</div>
            <div style="font-size:9px;color:var(--muted);margin-top:5px">퇴근시간 입력 즉시 자동 계산</div>
          `;
        }else{
          tdTime.innerHTML=`
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px">출근</div>
            <strong>${escapeHtml(log.start_time||"-")}</strong>
            <div style="font-size:11px;color:var(--muted);margin:10px 0 4px">퇴근</div>
            <strong>${escapeHtml(log.end_time||"-")}</strong>
            <div class="auto-ot-mini">자동 야근 ${formatHours(log.overtime_hours||0)}h</div>
          `;
        }
        tr.appendChild(tdTime);
      }

      body.appendChild(tr);
    });
  });

  if(editableUserId){
    const startInput=$("daily_start_time");
    const endInput=$("daily_end_time");
    if(startInput){
      startInput.addEventListener("input",updateDailyOvertimePreview);
      startInput.addEventListener("change",updateDailyOvertimePreview);
    }
    if(endInput){
      endInput.addEventListener("input",updateDailyOvertimePreview);
      endInput.addEventListener("change",updateDailyOvertimePreview);
    }
    updateDailyOvertimePreview();
  }
}

async function loadCloudDaily(){
  if(!teamCloud.client || !teamCloud.user) return;
  setDailyMessage("팀 업무일지를 불러오는 중...");
  const [{data:members,error:memberError},{data:logs,error:logError}] = await Promise.all([
    teamCloud.client.from("profiles").select("user_id,display_name,job_title,sort_order").order("sort_order",{ascending:true}).order("display_name",{ascending:true}),
    teamCloud.client.from("daily_logs").select("user_id,work_date,morning,afternoon,overtime,start_time,end_time,overtime_hours,work_status,updated_at").eq("work_date",dailyLogDate)
  ]);

  if(memberError || logError){
    console.error(memberError||logError);
    setDailyMessage("팀 업무일지를 불러오지 못했어. Supabase 설정과 권한을 확인해줘.",true);
    return;
  }
  teamCloud.members=sortTeamMembers(members||[]);
  teamCloud.logs=logs||[];
  renderDailyRows(teamCloud.members,teamCloud.logs,teamCloud.user.id);
  const mine=teamCloud.logs.find(x=>x.user_id===teamCloud.user.id);
  if($("dailyWorkStatus")) $("dailyWorkStatus").value=normalizeLeaveStatus(mine?.work_status||"정상근무");
  updateDailyOvertimePreview();
  setDailyMessage(`${teamCloud.members.length}명의 팀 계정과 연결됨`);
  subscribeDailyRealtime();
}

function subscribeDailyRealtime(){
  if(!teamCloud.client || !teamCloud.user) return;
  if(teamCloud.channel){
    teamCloud.client.removeChannel(teamCloud.channel);
    teamCloud.channel=null;
  }
  teamCloud.channel=teamCloud.client
    .channel(`daily-${dailyLogDate}`)
    .on("postgres_changes",{
      event:"*",
      schema:"public",
      table:"daily_logs",
      filter:`work_date=eq.${dailyLogDate}`
    },()=>loadCloudDaily())
    .subscribe();
}

async function renderDailyLogPage(){
  const label=$("dailyDateLabel");
  if(!label) return;
  label.textContent=displayDailyDate(dailyLogDate);
  updateSyncUi();

  const currentSummary=getMyDailySummary(dailyLogDate);
  if($("dailyWorkStatus")) $("dailyWorkStatus").value=normalizeLeaveStatus(currentSummary.work_status||"정상근무");
  if($("dailyOvertimeRule")) $("dailyOvertimeRule").textContent="20:00=1h · 21:00=2h · 22:00=3h";

  if(teamCloud.configured && teamCloud.user){
    await syncMyCloudProfile();
    await loadMyLoggedDates();
    await loadCloudDaily();
  }else{
    const member=localDailyMember();
    const localLog={user_id:"local",...getLocalDailyLog()};
    renderDailyRows([member],[localLog],"local");
    if($("dailyWorkStatus")) $("dailyWorkStatus").value=normalizeLeaveStatus(localLog.work_status||data.records?.[dailyLogDate]?.category||"정상근무");
    setDailyMessage(teamCloud.configured ? "팀 계정 로그인 전에는 이 화면의 내용이 팀과 공유되지 않아." : "현재 로컬 임시 저장 모드야.");
  }
}

function returnToMonthlyAfterDailySave(){
  const d=new Date(dailyLogDate+"T00:00:00");
  viewDate=new Date(d.getFullYear(),d.getMonth(),1);
  renderAll();
  const monthlyBtn=document.querySelector('[data-page="schedulePage"]');
  if(monthlyBtn) monthlyBtn.click();
}

async function saveMyDailyLog(){
  const startTime=$("daily_start_time")?.value||null;
  const endTime=$("daily_end_time")?.value||null;
  const overtimeHours=calculateOvertimeHours(startTime,endTime);
  updateDailyOvertimePreview();

  const payload={
    morning:$("daily_morning")?.value.trim()||"",
    afternoon:$("daily_afternoon")?.value.trim()||"",
    overtime:$("daily_overtime")?.value.trim()||"",
    start_time:startTime,
    end_time:endTime,
    overtime_hours:overtimeHours,
    work_status:$("dailyWorkStatus")?.value||"정상근무"
  };

  if(teamCloud.configured){
    if(!teamCloud.user){
      setDailyMessage("먼저 팀 계정으로 로그인해줘.",true);
      return;
    }
    const {error}=await teamCloud.client.from("daily_logs").upsert({
      user_id:teamCloud.user.id,
      work_date:dailyLogDate,
      ...payload,
      updated_at:new Date().toISOString()
    },{onConflict:"user_id,work_date"});
    if(error){
      console.error(error);
      setDailyMessage("저장에 실패했어. 데이터베이스 권한 설정을 확인해줘.",true);
      return;
    }
    teamCloud.myLoggedDates.add(dailyLogDate);
    teamCloud.myOvertimeByDate.set(dailyLogDate,overtimeHours);
    teamCloud.myWorkStatusByDate.set(dailyLogDate,payload.work_status);
    renderCalendar();
    renderAnnualCalendar();
    renderSummary();
    renderPayBreakdown();
    renderLeavePage();
    setDailyMessage(`내 업무일지를 저장했어. 퇴근 ${endTime||"-"} → 인정 야근 ${formatHours(overtimeHours)}시간`);
    await loadCloudDaily();
    returnToMonthlyAfterDailySave();
  }else{
    data.dailyLogs=data.dailyLogs||{};
    data.dailyLogs[dailyLogDate]=payload;
    // 예전 날짜별 기록의 야근/연차 데이터가 있다면 일일업무일지로 자연스럽게 이전
    if(data.records?.[dailyLogDate]) delete data.records[dailyLogDate];
    persist();
    renderCalendar();
    renderAnnualCalendar();
    renderSummary();
    renderPayBreakdown();
    renderLeavePage();
    setDailyMessage(`이 브라우저에 업무일지를 저장했어. 퇴근 ${endTime||"-"} → 인정 야근 ${formatHours(overtimeHours)}시간`);
    returnToMonthlyAfterDailySave();
  }
}



