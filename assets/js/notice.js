/* ============================================================================
   팀 공지사항 (월간일정표 오른쪽)

   팀당 한 건이고 팀장만 쓸 수 있다. 팀원에게는 읽기 전용으로 보인다.
   쓰기 권한은 화면뿐 아니라 team_notices 의 RLS 정책으로도 막혀 있다.
   ============================================================================ */

// 팀장이 지금 공지를 고치고 있는가 (저장하면 다시 읽기 모드로 돌아간다)
let noticeEditing=false;

function noticeUpdaterName(userId){
  if(!userId) return "";
  if(userId===teamCloud.user?.id) return "나";
  const member=teamCloud.members.find(m=>m.user_id===userId);
  return member?.display_name || "팀장";
}

function noticeTimeLabel(iso){
  if(!iso) return "";
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return "";
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setNoticeMessage(text,isError=false){
  const el=$("noticeMessage");
  if(!el) return;
  el.textContent=text||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

function renderNoticePanel(){
  const lock=$("noticeLock");
  const view=$("noticeView");
  const edit=$("noticeEditArea");
  const meta=$("noticeMeta");
  const editBtn=$("editNotice");
  if(!lock||!view||!edit) return;

  // 로그인 전 · 팀 미소속
  if(!teamCloud.configured || !teamCloud.user || !teamCloud.teamId){
    lock.style.display="block";
    lock.textContent=!teamCloud.user
      ? "팀 로그인 후 공지사항을 볼 수 있어."
      : "팀을 만들거나 초대코드로 참여하면 공지사항이 보여.";
    view.style.display="none";
    edit.style.display="none";
    if(meta) meta.textContent="";
    if(editBtn) editBtn.style.display="none";
    return;
  }

  lock.style.display="none";
  const notice=teamCloud.notice||{content:"",updated_at:"",updated_by:null};
  const content=String(notice.content||"");

  if(meta){
    const who=noticeUpdaterName(notice.updated_by);
    const when=noticeTimeLabel(notice.updated_at);
    meta.textContent=content.trim() && when ? `${when} · ${who}` : "";
  }

  // 팀장이라도 저장을 마치면 읽기 모드로 보여서 '작성 완료' 느낌이 나게 한다.
  const editMode=teamCloud.isLeader && (noticeEditing || !content.trim());

  if(editMode){
    view.style.display="none";
    edit.style.display="block";
    if(editBtn) editBtn.style.display="none";
    const input=$("noticeInput");
    if(input && document.activeElement!==input) input.value=content;
  }else{
    edit.style.display="none";
    view.style.display="block";
    if(editBtn) editBtn.style.display=teamCloud.isLeader ? "inline-block" : "none";
    view.innerHTML=content.trim()
      ? workTextHtml(content)
      : '<div class="empty">아직 등록된 공지사항이 없어.</div>';
  }
}

function startNoticeEdit(){
  noticeEditing=true;
  setNoticeMessage("");
  renderNoticePanel();
  const input=$("noticeInput");
  if(input){
    input.focus();
    input.setSelectionRange(input.value.length,input.value.length);
  }
}

async function loadTeamNotice(){
  if(!teamCloud.client || !teamCloud.user || !teamCloud.teamId){
    teamCloud.notice=null;
    renderNoticePanel();
    return;
  }

  const {data:row,error}=await teamCloud.client
    .from("team_notices")
    .select("content,updated_by,updated_at")
    .eq("team_id",teamCloud.teamId)
    .maybeSingle();

  if(error){
    console.error(error);
    setNoticeMessage("공지사항을 불러오지 못했어.",true);
    return;
  }

  teamCloud.notice=row||{content:"",updated_by:null,updated_at:""};
  renderNoticePanel();
  subscribeNoticeRealtime();
}

async function saveTeamNotice(){
  if(!teamCloud.user || !teamCloud.teamId){
    setNoticeMessage("팀에 참여한 뒤에 쓸 수 있어.",true);
    return;
  }
  if(!teamCloud.isLeader){
    setNoticeMessage("공지사항은 팀장만 쓸 수 있어.",true);
    return;
  }

  const content=$("noticeInput").value.trim();
  const button=$("saveNotice");
  button.disabled=true;
  button.textContent="저장 중...";
  const restore=()=>{ button.disabled=false; button.textContent="작성 완료"; };

  const payload={
    team_id:teamCloud.teamId,
    content,
    updated_by:teamCloud.user.id,
    updated_at:new Date().toISOString()
  };

  const {error}=await teamCloud.client
    .from("team_notices")
    .upsert(payload,{onConflict:"team_id"});

  restore();

  if(error){
    console.error(error);
    setNoticeMessage("공지사항을 저장하지 못했어. 팀장 권한과 DB 설정을 확인해줘.",true);
    return;
  }

  teamCloud.notice=payload;
  noticeEditing=false;
  renderNoticePanel();
  setNoticeMessage("");
}

function subscribeNoticeRealtime(){
  if(!teamCloud.client || !teamCloud.teamId) return;
  unsubscribeNoticeRealtime();

  teamCloud.noticeChannel=teamCloud.client
    .channel(`notice-${teamCloud.teamId}`)
    .on("postgres_changes",{
      event:"*",
      schema:"public",
      table:"team_notices",
      filter:`team_id=eq.${teamCloud.teamId}`
    },payload=>{
      // 내가 방금 저장한 내용이면 다시 그릴 필요가 없다.
      const row=payload.new;
      if(!row) return;
      teamCloud.notice={
        content:row.content||"",
        updated_by:row.updated_by||null,
        updated_at:row.updated_at||""
      };
      renderNoticePanel();
    })
    .subscribe();
}

function unsubscribeNoticeRealtime(){
  if(teamCloud.noticeChannel){
    teamCloud.client?.removeChannel(teamCloud.noticeChannel);
    teamCloud.noticeChannel=null;
  }
}
