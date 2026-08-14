/* ============================================================================
   달력 중요일정

   일일업무일지와는 별개다. 날짜칸의 + 버튼으로 추가하고, 저장할 때
   개인 일정(나만 보기) / 팀 공유 중에서 고른다.

   로그인 전에는 이 브라우저(localStorage)에만 저장된다.
   ============================================================================ */

const EVENT_VISIBILITY_LABELS={ personal:"개인", team:"팀 공유" };

// 지금 편집 중인 일정 {date, id, title, visibility, isNew}
let editingEvent=null;

function localEvents(){
  data.events=data.events||{};
  return data.events;
}

function eventEntriesForDate(key){
  if(teamCloud.configured && teamCloud.user){
    return teamCloud.eventsByDate.get(key)||[];
  }
  return (localEvents()[key]||[]).map(e=>({...e,event_date:key,user_id:"me",mine:true}));
}

/* 보고 있는 달의 일정을 한 번에 읽어 날짜별로 묶는다. */
async function loadCalendarEvents(monthDate=viewDate){
  if(!teamCloud.client || !teamCloud.user){
    teamCloud.eventsByDate=new Map();
    return;
  }

  const from=dateKey(new Date(monthDate.getFullYear(),monthDate.getMonth(),-7));
  const to=dateKey(new Date(monthDate.getFullYear(),monthDate.getMonth()+1,7));

  const {data:rows,error}=await teamCloud.client
    .from("calendar_events")
    .select("id,user_id,team_id,event_date,title,visibility")
    .gte("event_date",from)
    .lte("event_date",to)
    .order("id",{ascending:true});

  if(error){
    console.error(error);
    return;
  }

  const byDate=new Map();
  (rows||[]).forEach(row=>{
    const list=byDate.get(row.event_date)||[];
    list.push({...row,mine:row.user_id===teamCloud.user.id});
    byDate.set(row.event_date,list);
  });

  teamCloud.eventsByDate=byDate;
  renderCalendar();
}

function eventOwnerName(userId){
  if(userId===teamCloud.user?.id) return "나";
  const member=teamCloud.members.find(m=>m.user_id===userId);
  return member?.display_name||"팀원";
}


/* ------------------------------------------------------------------ 모달 */

function openEventModal(key,event=null){
  editingEvent=event
    ? {...event,date:key,isNew:false}
    : {date:key,id:null,title:"",visibility:"personal",isNew:true,mine:true};

  const readonly=Boolean(event) && !event.mine;

  $("eventModalTitle").textContent=readonly ? "팀 공유 일정" : (event ? "일정 수정" : "일정 추가");
  $("eventDateLabel").textContent=displayDailyDate(key);
  $("eventTitleInput").value=editingEvent.title||"";
  $("eventVisibility").value=editingEvent.visibility||"personal";

  // 남이 만든 팀 일정은 읽기만 한다
  $("eventTitleInput").disabled=readonly;
  $("eventVisibility").disabled=readonly;
  $("saveEvent").style.display=readonly ? "none" : "inline-block";
  $("deleteEvent").style.display=(!readonly && event) ? "inline-block" : "none";
  $("eventOwnerNote").textContent=readonly
    ? `${eventOwnerName(event.user_id)}님이 등록한 일정이야. 만든 사람만 고칠 수 있어.`
    : "";

  // 팀에 속해 있어야 팀 공유를 고를 수 있다
  const canShare=Boolean(teamCloud.user && teamCloud.teamId);
  $("eventVisibility").querySelector('option[value="team"]').disabled=!canShare;
  $("eventShareNote").textContent=canShare
    ? "팀 공유로 저장하면 같은 팀 전원의 달력에 보여."
    : "팀에 참여하면 팀 공유 일정을 만들 수 있어.";

  setEventMessage("");
  $("eventModal").classList.add("open");
  $("eventModal").setAttribute("aria-hidden","false");
  if(!readonly) setTimeout(()=>$("eventTitleInput").focus(),0);
}

function closeEventModal(){
  editingEvent=null;
  $("eventModal").classList.remove("open");
  $("eventModal").setAttribute("aria-hidden","true");
}

function setEventMessage(text,isError=false){
  const el=$("eventMessage");
  if(!el) return;
  el.textContent=text||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

async function saveCalendarEvent(){
  if(!editingEvent) return;

  const title=$("eventTitleInput").value.trim();
  const visibility=$("eventVisibility").value==="team" ? "team" : "personal";
  if(!title){
    setEventMessage("일정 내용을 적어줘.",true);
    return;
  }
  if(visibility==="team" && !(teamCloud.user && teamCloud.teamId)){
    setEventMessage("팀에 참여해야 팀 공유 일정을 만들 수 있어.",true);
    return;
  }

  const key=editingEvent.date;

  if(teamCloud.configured && teamCloud.user){
    const payload={
      user_id:teamCloud.user.id,
      team_id:visibility==="team" ? teamCloud.teamId : null,
      event_date:key,
      title,
      visibility,
      updated_at:new Date().toISOString()
    };

    const query=editingEvent.id
      ? teamCloud.client.from("calendar_events").update(payload).eq("id",editingEvent.id)
      : teamCloud.client.from("calendar_events").insert(payload);

    const {error}=await query;
    if(error){
      console.error(error);
      setEventMessage("일정을 저장하지 못했어. DB 패치를 실행했는지 확인해줘.",true);
      return;
    }
    await loadCalendarEvents();
  }else{
    const list=localEvents()[key]||[];
    if(editingEvent.id){
      const target=list.find(e=>e.id===editingEvent.id);
      if(target){ target.title=title; target.visibility=visibility; }
    }else{
      list.push({id:Date.now(),title,visibility});
    }
    localEvents()[key]=list;
    persist();
  }

  closeEventModal();
  renderCalendar();
  renderAnnualCalendar();
}

async function deleteCalendarEvent(){
  if(!editingEvent || !editingEvent.id) return;
  if(!confirm("이 일정을 삭제할까?")) return;

  const key=editingEvent.date;

  if(teamCloud.configured && teamCloud.user){
    const {error}=await teamCloud.client
      .from("calendar_events").delete().eq("id",editingEvent.id);
    if(error){
      console.error(error);
      setEventMessage("일정을 삭제하지 못했어.",true);
      return;
    }
    await loadCalendarEvents();
  }else{
    const list=(localEvents()[key]||[]).filter(e=>e.id!==editingEvent.id);
    if(list.length) localEvents()[key]=list;
    else delete localEvents()[key];
    persist();
  }

  closeEventModal();
  renderCalendar();
  renderAnnualCalendar();
}
