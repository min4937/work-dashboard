/* ============================================================================
   팀 채팅 · 채널 관리

   채널 찾기 (사이드바 ☰)
     참여 중 · 참여할 수 있는 공개 채널(나갔던 것 포함) · 보관된 채널을 보여준다.
     보관된 채널은 목록에 없으니 열어볼 때 chat.archivedView 로 잠깐 끼워 넣고 읽기만 한다.

   채널 정보 (머리줄 ⓘ)
     종류 · 설명 · 멤버. 비공개 채널은 팀원 초대, 기본 채널이 아니면 나가기,
     만든 사람·팀장은 보관/보관 해제.

   권한은 모두 서버 RPC 가 다시 확인한다. 화면은 버튼을 숨기기만 한다.
   ============================================================================ */

let chatBrowseItems=[];
let chatInfoMembers=[];

function chatKindLabel(c){
  if(c.archived || c.archived_at) return "보관됨";
  if(c.kind==="dm") return "1:1 대화";
  if(c.kind==="private") return "비공개 채널";
  return c.is_default ? "기본 채널 (팀 전체)" : "공개 채널";
}

function canManageChatChannel(c){
  if(!c || c.kind==="dm" || c.is_default) return false;
  return c.created_by===teamCloud.user?.id || !!teamCloud.isLeader;
}

/* 채널 목록이 바뀐 뒤 공통으로 하는 일 */
async function reloadChatChannelsAndOpen(id){
  await refreshChatChannels();
  syncChatSubscriptions();
  if(id && chatChannel(id)) openChatChannel(id);
}


/* --------------------------------------------------------------- 채널 찾기 */

async function openChatBrowse(){
  openChatSide("browse","채널 찾기");
  $("chatSideList").innerHTML='<div class="empty chat-empty">채널을 불러오는 중이야.</div>';

  const {data,error}=await teamCloud.client.rpc("list_chat_channels");
  if(!isChatSideOpen("browse")) return;
  if(error){
    console.error(error);
    $("chatSideList").innerHTML='<div class="empty chat-empty">채널 목록을 불러오지 못했어.</div>';
    return;
  }
  chatBrowseItems=data||[];
  renderChatBrowse();
}

function renderChatBrowse(){
  const joined=chatBrowseItems.filter(c=>!c.archived_at && c.is_member);
  const open=chatBrowseItems.filter(c=>!c.archived_at && !c.is_member);
  const archived=chatBrowseItems.filter(c=>c.archived_at);

  const row=(c,button)=>
    `<div class="chat-browse-item">`+
    `<div class="chat-browse-main"><b>${c.kind==="private" ? "🔒" : "#"} ${escapeHtml(c.name)}</b>`+
    `<small>${escapeHtml(chatKindLabel(c))} · ${c.member_count}명</small>`+
    `${c.topic ? `<span>${escapeHtml(c.topic)}</span>` : ""}</div>${button}</div>`;

  const section=(title,items,button,empty)=>
    `<div class="chat-browse-section">${title}</div>`+
    (items.length ? items.map(c=>row(c,button(c))).join("") : `<div class="chat-side-empty">${empty}</div>`);

  $("chatSideList").innerHTML=
    section("참여할 수 있는 채널",open,
      c=>`<button type="button" class="btn primary chat-browse-btn" data-browse-join="${c.id}">참여</button>`,
      "새로 참여할 공개 채널이 없어.")+
    section("참여 중",joined,
      c=>`<button type="button" class="btn chat-browse-btn" data-browse-open="${c.id}">열기</button>`,
      "참여 중인 채널이 없어.")+
    section("보관된 채널",archived,
      c=>`<button type="button" class="btn chat-browse-btn" data-browse-view="${c.id}">보기</button>`,
      "보관된 채널이 없어.");
}

async function joinChatChannel(id){
  const {error}=await teamCloud.client.rpc("join_chat_channel",{p_channel:id});
  if(error){
    setChatNotice(error.message||"채널에 참여하지 못했어.",true);
    return;
  }
  closeChatSide();
  await reloadChatChannelsAndOpen(id);
}

/* 보관 채널은 bootstrap 목록에 없으니 잠깐 끼워 넣고 연다 (다른 채널로 옮기면 빠진다) */
function viewArchivedChatChannel(id){
  const item=chatBrowseItems.find(c=>c.id===id);
  if(!item) return;
  if(!chatChannel(id)){
    chat.archivedView={
      ...item,
      archived:true,
      last_read_id:0,
      unread_count:0,
      last_message_id:0
    };
    chat.channels.push(chat.archivedView);
  }
  openChatChannel(id);
}


/* --------------------------------------------------------------- 채널 정보 */

async function openChatInfo(){
  const c=chatChannel(chat.activeId);
  if(!c) return;
  openChatSide("info",c.kind==="dm" ? "대화 정보" : "채널 정보");
  const channelId=c.id;
  $("chatSideList").innerHTML='<div class="empty chat-empty">불러오는 중이야.</div>';

  const {data,error}=await teamCloud.client.rpc("chat_channel_members",{p_channel:channelId});
  if(!isChatSideOpen("info") || chat.activeId!==channelId) return;
  if(error) console.error(error);
  chatInfoMembers=(data||[]).map(r=>r.user_id);
  renderChatInfo();
}

function renderChatInfo(){
  const c=chatChannel(chat.activeId);
  if(!c) return;
  const archived=!!c.archived;
  const memberSet=new Set(chatInfoMembers);
  const members=sortTeamMembers(teamCloud.members).filter(m=>memberSet.has(m.user_id));
  const outsiders=sortTeamMembers(teamCloud.members).filter(m=>!memberSet.has(m.user_id));

  const title=c.kind==="dm" ? `@ ${chatChannelLabel(c)}` : `${c.kind==="private" ? "🔒" : "#"} ${c.name}`;
  const creator=c.created_by ? chatMemberName(c.created_by) : "자동 생성";

  const html=[];
  html.push(`<div class="chat-info-block"><div class="chat-info-name">${escapeHtml(title)}</div>`+
    `<div class="chat-info-kind">${escapeHtml(chatKindLabel(c))}${c.kind!=="dm" ? ` · 만든 사람 ${escapeHtml(creator)}` : ""}</div>`+
    `${c.topic ? `<div class="chat-info-topic">${escapeHtml(c.topic)}</div>` : ""}</div>`);

  html.push(`<div class="chat-browse-section">멤버 ${members.length}명</div>`);
  html.push(members.map(m=>
    `<div class="chat-info-member">${chatMemberStatusDot(m.user_id)}<b>${escapeHtml(m.display_name||"이름 미설정")}</b>`+
    `<small>${escapeHtml(m.job_title||"")}</small>${m.user_id===teamCloud.user?.id ? '<span class="me-badge">나</span>' : ""}</div>`
  ).join("") || '<div class="chat-side-empty">멤버 정보를 불러오지 못했어.</div>');

  // 비공개 채널 초대
  if(c.kind==="private" && !archived){
    html.push('<div class="chat-browse-section">팀원 초대</div>');
    html.push(outsiders.length
      ? `<div class="chat-member-picks chat-info-invite">${outsiders.map(m=>
          `<label class="chat-member-pick"><input type="checkbox" value="${escapeHtml(m.user_id)}">`+
          `${escapeHtml(m.display_name||"이름 미설정")}<small>${escapeHtml(m.job_title||"")}</small></label>`).join("")}</div>`+
        `<button type="button" class="btn primary chat-info-action" data-info-invite>고른 팀원 초대</button>`
      : '<div class="chat-side-empty">팀원이 모두 이 채널에 있어.</div>');
  }

  // 나가기 · 보관
  const actions=[];
  if(!archived && c.kind!=="dm" && !c.is_default){
    actions.push('<button type="button" class="btn chat-info-action" data-info-leave>채널 나가기</button>');
  }
  if(canManageChatChannel(c)){
    actions.push(archived
      ? '<button type="button" class="btn chat-info-action" data-info-unarchive>보관 해제</button>'
      : '<button type="button" class="btn danger chat-info-action" data-info-archive>채널 보관</button>');
  }
  if(actions.length){
    html.push('<div class="chat-browse-section">관리</div>');
    html.push(`<div class="chat-info-actions">${actions.join("")}</div>`);
    html.push(`<div class="chat-side-empty">`+
      (c.kind==="private"
        ? "비공개 채널에서 나가면 다시 초대받아야 들어올 수 있어."
        : "공개 채널은 나가도 ☰ 채널 찾기에서 다시 참여할 수 있어.")+
      (canManageChatChannel(c) ? " 보관하면 모두에게 목록에서 빠지고 읽기만 돼." : "")+
      `</div>`);
  }

  $("chatSideList").innerHTML=html.join("");
}

async function inviteChatMembers(){
  const c=chatChannel(chat.activeId);
  const ids=[...$("chatSideList").querySelectorAll(".chat-info-invite input:checked")].map(x=>x.value);
  if(!c || !ids.length) return;
  const {error}=await teamCloud.client.rpc("add_chat_members",{p_channel:c.id,p_users:ids});
  if(error){
    setChatNotice(error.message||"초대하지 못했어.",true);
    return;
  }
  setChatNotice(`${ids.length}명을 초대했어.`);
  await openChatInfo();
}

async function leaveChatChannel(){
  const c=chatChannel(chat.activeId);
  if(!c) return;
  const warn=c.kind==="private" ? " 비공개 채널이라 다시 초대받아야 들어올 수 있어." : "";
  if(!confirm(`#${c.name} 채널에서 나갈까?${warn}`)) return;

  const {error}=await teamCloud.client.rpc("leave_chat_channel",{p_channel:c.id});
  if(error){
    setChatNotice(error.message||"채널에서 나가지 못했어.",true);
    return;
  }
  closeChatSide();
  chat.activeId=null;   // 목록을 다시 읽으면 기본 채널로 간다
  await reloadChatChannelsAndOpen(null);
  setChatNotice(`#${c.name} 에서 나왔어.`);
}

async function archiveChatChannel(archive){
  const c=chatChannel(chat.activeId);
  if(!c) return;
  if(archive && !confirm(`#${c.name} 채널을 보관할까? 모두에게 목록에서 빠지고, 내용은 ☰ 채널 찾기에서 읽기만 할 수 있어.`)) return;

  const {error}=await teamCloud.client.rpc("archive_chat_channel",{p_channel:c.id,p_archive:archive});
  if(error){
    setChatNotice(error.message||"채널을 보관하지 못했어.",true);
    return;
  }
  closeChatSide();
  if(archive){
    chat.activeId=null;
    await reloadChatChannelsAndOpen(null);
    setChatNotice(`#${c.name} 을(를) 보관했어.`);
  }else{
    // 보관 해제: 읽기 전용으로 끼워 둔 것을 빼고 정식 목록에서 다시 연다
    chat.channels=chat.channels.filter(x=>x!==chat.archivedView);
    chat.archivedView=null;
    chat.activeId=null;
    await reloadChatChannelsAndOpen(c.id);
    setChatNotice(`#${c.name} 보관을 풀었어.`);
  }
}


/* ------------------------------------------------------------------- 이벤트 */

$("chatBrowseBtn").addEventListener("click",()=>{
  if(isChatSideOpen("browse")) closeChatSide();
  else openChatBrowse();
});

$("chatInfoBtn").addEventListener("click",()=>{
  if(isChatSideOpen("info")) closeChatSide();
  else openChatInfo();
});

$("chatSideList").addEventListener("click",e=>{
  if(isChatSideOpen("browse")){
    const join=e.target.closest("[data-browse-join]");
    if(join) return joinChatChannel(join.dataset.browseJoin);
    const open=e.target.closest("[data-browse-open]");
    if(open){
      closeChatSide();
      return openChatChannel(open.dataset.browseOpen);
    }
    const view=e.target.closest("[data-browse-view]");
    if(view) return viewArchivedChatChannel(view.dataset.browseView);
    return;
  }
  if(isChatSideOpen("info")){
    if(e.target.closest("[data-info-invite]")) return inviteChatMembers();
    if(e.target.closest("[data-info-leave]")) return leaveChatChannel();
    if(e.target.closest("[data-info-archive]")) return archiveChatChannel(true);
    if(e.target.closest("[data-info-unarchive]")) return archiveChatChannel(false);
  }
});
