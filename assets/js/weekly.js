function startOfWeek(dateValue){
  const d=new Date(dateValue);
  d.setHours(0,0,0,0);
  const offset=(d.getDay()+6)%7;
  d.setDate(d.getDate()-offset);
  return d;
}

let weeklyAnchorDate=startOfWeek(new Date());

function weeklyDateRange(){
  const start=startOfWeek(weeklyAnchorDate);
  const end=new Date(start);
  end.setDate(start.getDate()+6);
  return {start,end};
}

function weeklyRangeLabel(){
  const {start,end}=weeklyDateRange();
  return `${start.getFullYear()}년 ${start.getMonth()+1}월 ${start.getDate()}일 ~ ${end.getMonth()+1}월 ${end.getDate()}일`;
}

function weeklyDayHeader(d){
  const names=["일","월","화","수","목","금","토"];
  return `${d.getMonth()+1}/${d.getDate()} (${names[d.getDay()]})`;
}

function isWeekendDate(d){
  return d.getDay()===0 || d.getDay()===6;
}

/* 업무일지에 실제 내용이 올라온 날인가 (= 그날 출근했다고 본다) */
function hasWrittenLog(logs,key){
  return logs.some(log=>log.work_date===key &&
    (log.morning||log.afternoon||log.overtime||log.start_time||log.end_time));
}

/* 월~금은 항상 보이고, 토·일은 누군가 일지를 올린 날만 보인다. */
function weeklyVisibleDays(logs){
  const {start}=weeklyDateRange();
  const days=[];
  for(let i=0;i<7;i++){
    const d=new Date(start);
    d.setDate(start.getDate()+i);
    if(isWeekendDate(d) && !hasWrittenLog(logs,dateKey(d))) continue;
    days.push(d);
  }
  return days;
}

function weeklyLogCellHtml(log){
  if(!log){
    return '<span style="color:#b7bcc2">-</span>';
  }

  const parts=[];
  if(log.morning){
    parts.push(`<div class="weekly-log-section"><span class="weekly-log-label">오전</span><div class="weekly-log-text">${escapeHtml(log.morning)}</div></div>`);
  }
  if(log.afternoon){
    parts.push(`<div class="weekly-log-section"><span class="weekly-log-label">오후</span><div class="weekly-log-text">${escapeHtml(log.afternoon)}</div></div>`);
  }
  if(log.overtime){
    parts.push(`<div class="weekly-log-section"><span class="weekly-log-label ot">야근</span><div class="weekly-log-text">${escapeHtml(log.overtime)}</div></div>`);
  }

  const timeBits=[];
  if(log.start_time) timeBits.push(`출근 ${escapeHtml(log.start_time)}`);
  if(log.end_time) timeBits.push(`퇴근 ${escapeHtml(log.end_time)}`);
  if(Number(log.overtime_hours)>0) timeBits.push(`인정야근 ${formatHours(log.overtime_hours)}h`);

  if(timeBits.length){
    parts.push(`<div class="weekly-time">${timeBits.join(" · ")}</div>`);
  }

  if(log.work_status && log.work_status!=="정상근무"){
    const status=leaveStatusLabel(log.work_status);
    parts.push(`<span class="weekly-status">${escapeHtml(status)}</span>`);
  }

  return parts.length ? parts.join("") : '<span style="color:#b7bcc2">업무내용 없음</span>';
}

function setWeeklyMessage(msg,isError=false){
  const el=$("weeklyMessage");
  if(!el) return;
  el.textContent=msg||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

function updateWeeklySyncUi(){
  const dot=$("weeklySyncDot");
  const text=$("weeklySyncStatus");
  if(!dot||!text) return;

  if(!teamCloud.configured){
    dot.className="sync-dot wait";
    text.textContent="팀 연동 전 · 현재는 내 업무일지만 표시";
  }else if(teamCloud.user && teamCloud.teamId){
    dot.className="sync-dot on";
    text.textContent=`${teamCloud.teamName} · ${teamCloud.user.email}`;
  }else{
    dot.className="sync-dot wait";
    text.textContent=teamCloud.user?"팀에 참여하면 팀원 업무일지를 함께 볼 수 있어":"로그인하면 팀원 업무일지를 함께 볼 수 있어";
  }
}

function renderWeeklySheet(members,logs){
  const head=$("weeklyLogHead");
  const body=$("weeklyLogBody");
  if(!head||!body) return;

  const days=weeklyVisibleDays(logs);

  // 열 개수가 달라지므로 표 최소폭도 같이 맞춘다
  const table=head.closest("table");
  if(table) table.style.minWidth=`${135+days.length*145}px`;

  head.innerHTML=`
    <tr>
      <th style="width:135px">직급 · 성명</th>
      ${days.map(d=>{
        const key=dateKey(d);
        const holiday=getHoliday(key);
        const cls=[];
        if(isWeekendDate(d)) cls.push("weekend");
        // 평일 공휴일은 빨간색으로 알아보게 한다
        if(holiday && !isWeekendDate(d)) cls.push("holiday");
        const title=holiday ? ` title="${escapeHtml(holiday)}"` : "";
        const name=holiday && !isWeekendDate(d)
          ? `<div class="weekly-holiday-name">${escapeHtml(holiday)}</div>`
          : "";
        return `<th class="${cls.join(" ")}"${title}>${weeklyDayHeader(d)}${name}</th>`;
      }).join("")}
    </tr>
  `;

  body.innerHTML="";
  const sorted=sortTeamMembers(members);

  if(!sorted.length){
    body.innerHTML=`<tr><td colspan="${days.length+1}" style="padding:28px;text-align:center;color:var(--muted)">표시할 팀원이 없어.</td></tr>`;
    return;
  }

  sorted.forEach(member=>{
    const tr=document.createElement("tr");

    const nameTd=document.createElement("td");
    nameTd.className="weekly-member-cell";
    nameTd.innerHTML=`
      <div class="weekly-member-title">${escapeHtml(member.display_name||"이름 미설정")}</div>
      <div class="weekly-member-rank">${escapeHtml(member.job_title||"직급 미설정")}</div>
    `;
    tr.appendChild(nameTd);

    days.forEach(d=>{
      const key=dateKey(d);
      const log=logs.find(x=>x.user_id===member.user_id && x.work_date===key);
      const td=document.createElement("td");
      td.className="weekly-day-cell";
      if(isWeekendDate(d)) td.classList.add("weekend");
      else if(getHoliday(key)) td.classList.add("holiday");
      if(!log) td.classList.add("empty");
      td.innerHTML=weeklyLogCellHtml(log);
      tr.appendChild(td);
    });

    body.appendChild(tr);
  });

  const summary=$("weeklySummary");
  if(summary){
    const written=logs.filter(log=>log.morning||log.afternoon||log.overtime||log.start_time||log.end_time).length;
    const totalOt=logs.reduce((sum,log)=>sum+Number(log.overtime_hours||0),0);
    summary.innerHTML=`
      <div class="weekly-summary-chip">팀원 <strong>${sorted.length}명</strong></div>
      <div class="weekly-summary-chip">작성된 일지 <strong>${written}건</strong></div>
      <div class="weekly-summary-chip">팀 인정야근 합계 <strong>${formatHours(totalOt)}시간</strong></div>
    `;
  }
}

function localWeeklyLogs(){
  const {start,end}=weeklyDateRange();
  const rows=[];
  Object.entries(data.dailyLogs||{}).forEach(([date,log])=>{
    const d=new Date(date+"T00:00:00");
    if(d>=start && d<=end){
      rows.push({user_id:"local",work_date:date,...log});
    }
  });
  return rows;
}

async function loadCloudWeekly(){
  if(!teamCloud.client || !teamCloud.user || !teamCloud.teamId) return;

  const {start,end}=weeklyDateRange();
  const from=dateKey(start);
  const to=dateKey(end);
  setWeeklyMessage("주간업무일지를 불러오는 중...");

  const [{data:members,error:memberError},{data:logs,error:logError}] = await Promise.all([
    teamCloud.client
      .from("profiles")
      .select("user_id,display_name,job_title,sort_order")
      .order("sort_order",{ascending:true})
      .order("display_name",{ascending:true}),
    teamCloud.client
      .from("daily_logs")
      .select("user_id,work_date,morning,afternoon,overtime,start_time,end_time,overtime_hours,work_status,updated_at")
      .gte("work_date",from)
      .lte("work_date",to)
  ]);

  if(memberError || logError){
    console.error(memberError||logError);
    setWeeklyMessage("주간업무일지를 불러오지 못했어. Supabase 설정을 확인해줘.",true);
    return;
  }

  teamCloud.weeklyMembers=sortTeamMembers(members||[]);
  teamCloud.weeklyLogs=logs||[];
  renderWeeklySheet(teamCloud.weeklyMembers,teamCloud.weeklyLogs);
  setWeeklyMessage(`${weeklyRangeLabel()} · 직급순으로 표시 중`);
  subscribeWeeklyRealtime();
}

function subscribeWeeklyRealtime(){
  if(!teamCloud.client || !teamCloud.user || !teamCloud.teamId) return;

  if(teamCloud.weeklyChannel){
    teamCloud.client.removeChannel(teamCloud.weeklyChannel);
    teamCloud.weeklyChannel=null;
  }

  const {start,end}=weeklyDateRange();
  const from=dateKey(start);
  const to=dateKey(end);

  teamCloud.weeklyChannel=teamCloud.client
    .channel(`weekly-${from}`)
    .on("postgres_changes",{
      event:"*",
      schema:"public",
      table:"daily_logs"
    },payload=>{
      const workDate=payload?.new?.work_date || payload?.old?.work_date;
      if(workDate && workDate>=from && workDate<=to){
        loadCloudWeekly();
      }
    })
    .on("postgres_changes",{
      event:"*",
      schema:"public",
      table:"profiles"
    },()=>loadCloudWeekly())
    .subscribe();
}

async function renderWeeklyLogPage(){
  const label=$("weeklyDateLabel");
  if(!label) return;
  label.textContent=weeklyRangeLabel();
  updateWeeklySyncUi();

  if(teamCloud.configured && teamCloud.user && teamCloud.teamId){
    await syncMyCloudProfile();
    await loadCloudWeekly();
  }else{
    const members=[localDailyMember()];
    const logs=localWeeklyLogs();
    renderWeeklySheet(members,logs);
    setWeeklyMessage(
      teamCloud.configured
        ? "팀 계정 로그인 전에는 내 로컬 업무일지만 보여."
        : "현재 로컬 모드라서 내 업무일지만 표시돼. 팀 연동 후 4명의 일지가 함께 보여."
    );
  }
}
