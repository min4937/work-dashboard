function normalizeLeaveStatus(status){if(status==="오전연차")return"오전반차";if(status==="오후연차")return"오후반차";return status||"정상근무";}
function leaveStatusLabel(status){const s=normalizeLeaveStatus(status);return s==="연차"?"하루 연차":s;}

function leaveDaysForCategory(category){
  const value=normalizeLeaveStatus(category);
  if(value==="연차") return 1;
  if(value==="오전반차" || value==="오후반차" || value==="반차") return 0.5;
  return 0;
}

function annualLeaveStats(year=new Date().getFullYear()){
  const total=Number(data.settings.totalAnnualLeave||0);
  let used=0;
  const history=[];

  const source=[];

  if(teamCloud.configured && teamCloud.user){
    for(const [date,status] of teamCloud.myWorkStatusByDate.entries()){
      if(Number(date.slice(0,4))===year){
        source.push([date,{category:status,memo:""}]);
      }
    }
  }else{
    const keys=new Set([
      ...Object.keys(data.dailyLogs||{}),
      ...Object.keys(data.records||{})
    ]);
    for(const date of keys){
      if(Number(date.slice(0,4))!==year) continue;
      const log=data.dailyLogs?.[date];
      const old=data.records?.[date];
      source.push([date,{
        category:log?.work_status || old?.category || "정상근무",
        memo:""
      }]);
    }
  }

  source.sort((a,b)=>a[0].localeCompare(b[0])).forEach(([date,rec])=>{
    const days=leaveDaysForCategory(rec.category);
    if(days>0){
      used+=days;
      history.push({
        date,
        category:rec.category==="반차"?"반차":leaveStatusLabel(rec.category),
        memo:"",
        days
      });
    }
  });

  const remaining=total-used;
  return {total,used,remaining,history};
}

function renderLeavePage(){
  const year=new Date().getFullYear();
  const s=annualLeaveStats(year);
  const fmt=(n)=>Number(n).toLocaleString("ko-KR",{maximumFractionDigits:1});

  const totalEl=$("leaveTotal");
  if(!totalEl) return;

  totalEl.textContent=`${fmt(s.total)}일`;
  $("leaveUsed").textContent=`${fmt(s.used)}일`;
  $("leaveRemaining").textContent=`${fmt(s.remaining)}일`;
  $("leaveYearLabel").textContent=`${year}년`;

  $("leaveSentence").innerHTML=
    `올해 연차 총 <strong>${fmt(s.total)}일</strong> 중 <strong>${fmt(s.used)}일</strong>을 썼고, 지금 <strong>${fmt(s.remaining)}일</strong>이 남았어.`;

  const pct=s.total>0 ? Math.min(100,Math.max(0,(s.used/s.total)*100)) : 0;
  $("leaveProgressBar").style.width=`${pct}%`;

  const history=$("leaveHistory");
  if(!s.history.length){
    history.innerHTML='<div class="empty">아직 등록된 연차가 없어. 일일업무일지에서 근무 상태를 연차로 선택하면 자동으로 여기에 쌓여.</div>';
  }else{
    history.innerHTML="";
    s.history.forEach(item=>{
      const row=document.createElement("div");
      row.className="leave-list-item";
      row.innerHTML=`
        <div><strong>${item.date.slice(5).replace("-","/")}</strong></div>
        <div><span class="leave-type-badge">${item.category}</span></div>
        <div>${item.memo||"-"}</div>
        <div class="leave-days">${fmt(item.days)}일</div>
      `;
      history.appendChild(row);
    });
  }
}






function setLeaveRequestMessage(t,e=false){const x=$("leaveRequestMessage");if(x){x.textContent=t||"";x.style.color=e?"var(--red)":"var(--muted)";}}
async function loadLeaveRequests(){const list=$("teamLeaveRequestList");if(!list)return;if(!teamCloud.user||!teamCloud.teamId){list.innerHTML='<div class="empty">팀에 참여하면 신청 내역을 볼 수 있어.</div>';return;}const y=new Date().getFullYear();const[{data:r,error:re},{data:m,error:me}]=await Promise.all([teamCloud.client.from("leave_requests").select("id,user_id,leave_date,leave_type,note,status,created_at").gte("leave_date",`${y}-01-01`).lte("leave_date",`${y}-12-31`).order("leave_date",{ascending:true}),teamCloud.client.from("profiles").select("user_id,display_name")]);if(re||me){list.innerHTML='<div class="empty">연차신청 내역을 불러오지 못했어.</div>';return;}teamCloud.leaveRequests=r||[];const mm=new Map((m||[]).map(x=>[x.user_id,x.display_name]));list.innerHTML="";if(!r?.length){list.innerHTML='<div class="empty">올해 등록된 연차신청이 없어.</div>';return;}r.forEach(x=>{const mine=x.user_id===teamCloud.user.id,d=document.createElement("div");d.className="leave-request-row";d.innerHTML=`<div><strong>${x.leave_date.slice(5).replace("-","/")}</strong></div><div class="leave-request-owner">${escapeHtml(mm.get(x.user_id)||"팀원")}</div><div><span class="leave-type-badge">${escapeHtml(leaveStatusLabel(x.leave_type))}</span></div><div class="leave-note">${escapeHtml(x.note||"-")}</div><div>${mine?`<button class="leave-request-cancel" data-cancel-leave="${x.id}">취소</button>`:"신청"}</div>`;list.appendChild(d);});list.querySelectorAll("[data-cancel-leave]").forEach(b=>b.addEventListener("click",()=>cancelLeaveRequest(Number(b.dataset.cancelLeave))));}
async function submitLeaveRequest(){if(!teamCloud.user||!teamCloud.teamId){setLeaveRequestMessage("팀에 참여한 뒤에 신청할 수 있어.",true);return;}const d=$("leaveRequestDate").value,t=normalizeLeaveStatus($("leaveRequestType").value),n=$("leaveRequestNote").value.trim();if(!d){setLeaveRequestMessage("사용일을 선택해줘.",true);return;}const b=$("submitLeaveRequest");b.disabled=true;b.textContent="신청 중...";const{error:re}=await teamCloud.client.from("leave_requests").upsert({user_id:teamCloud.user.id,leave_date:d,leave_type:t,note:n,status:"신청"},{onConflict:"user_id,leave_date"});if(re){setLeaveRequestMessage("연차신청 저장 실패",true);b.disabled=false;b.textContent="연차 신청";return;}const{error:le}=await teamCloud.client.from("daily_logs").upsert({user_id:teamCloud.user.id,work_date:d,work_status:t,updated_at:new Date().toISOString()},{onConflict:"user_id,work_date"});if(le)setLeaveRequestMessage("신청은 됐지만 일일업무일지 반영 실패",true);else{teamCloud.myLoggedDates.add(d);teamCloud.myWorkStatusByDate.set(d,t);setLeaveRequestMessage(`${d} ${leaveStatusLabel(t)} 신청 완료!`);}$("leaveRequestNote").value="";b.disabled=false;b.textContent="연차 신청";await loadLeaveRequests();if(teamCloud.teamId)await loadTeamMonthLogs();renderCalendar();renderAnnualCalendar();renderLeavePage();}
async function cancelLeaveRequest(id){const r=teamCloud.leaveRequests.find(x=>x.id===id);if(!r||r.user_id!==teamCloud.user.id||!confirm(`${r.leave_date} ${leaveStatusLabel(r.leave_type)} 신청을 취소할까?`))return;const{error:e}=await teamCloud.client.from("leave_requests").delete().eq("id",id).eq("user_id",teamCloud.user.id);if(e){setLeaveRequestMessage("취소 실패",true);return;}await teamCloud.client.from("daily_logs").update({work_status:"정상근무",updated_at:new Date().toISOString()}).eq("user_id",teamCloud.user.id).eq("work_date",r.leave_date).eq("work_status",r.leave_type);teamCloud.myWorkStatusByDate.set(r.leave_date,"정상근무");setLeaveRequestMessage("연차신청을 취소했어.");await loadLeaveRequests();if(teamCloud.teamId)await loadTeamMonthLogs();renderCalendar();renderAnnualCalendar();renderLeavePage();}
