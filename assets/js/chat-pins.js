/* ============================================================================
   팀 채팅 · 메시지 고정

   중요한 메시지를 채널에 고정해 두고 머리줄 [📌 N] 로 모아 본다.
   고정·해제는 그 채널에 쓸 수 있는 사람 누구나 (슬랙과 같다).
   다른 사람이 고정하면 pin 이벤트로 바로 반영된다.
   ============================================================================ */

let chatPinsCache=new Map();   // 고정 패널에 띄운 메시지 (아직 안 불러온 오래된 것 포함)

function chatPinsOf(channelId){
  return chat.pins.get(channelId)||new Map();
}

function isChatPinned(m){
  return !!m.id && chatPinsOf(m.channel_id).has(m.id);
}

/* 채널을 처음 열 때 부른다. 표가 없으면(SQL 패치 전) 조용히 넘어간다. */
async function loadChatPins(channelId){
  const {data,error}=await teamCloud.client
    .from("chat_pins")
    .select("message_id,pinned_by,pinned_at")
    .eq("channel_id",channelId);
  if(error){
    console.error(error);
    return;
  }
  chat.pins.set(channelId,new Map((data||[]).map(p=>[Number(p.message_id),{pinned_by:p.pinned_by,pinned_at:p.pinned_at}])));
  if(channelId===chat.activeId){
    renderChatPinsButton();
    rerenderChatViews();
  }
}

function applyChatPin(channelId,messageId,info){
  let pins=chat.pins.get(channelId);
  if(!pins){
    pins=new Map();
    chat.pins.set(channelId,pins);
  }
  if(info) pins.set(messageId,info);
  else pins.delete(messageId);
}

function onChatPin(channelId,p){
  if(!p?.message_id) return;
  const id=Number(p.message_id);
  applyChatPin(channelId,id,p.op==="delete" ? null : {pinned_by:p.pinned_by,pinned_at:p.pinned_at});
  if(channelId!==chat.activeId) return;
  renderChatPinsButton();
  rerenderChatViews();
  if(isChatSideOpen("pins")) openChatPins();
}

/* 누르면 바로 반영하고 실패하면 되돌린다 */
async function toggleChatPin(messageId){
  const m=findChatMessage(messageId)||chatPinsCache.get(messageId);
  if(!m) return;
  const was=chatPinsOf(m.channel_id).get(messageId)||null;
  applyChatPin(m.channel_id,messageId,was ? null : {pinned_by:teamCloud.user.id,pinned_at:new Date().toISOString()});
  renderChatPinsButton();
  rerenderChatViews();

  const {error}=await teamCloud.client.rpc("toggle_chat_pin",{p_message:messageId});
  if(error){
    console.error(error);
    applyChatPin(m.channel_id,messageId,was);
    renderChatPinsButton();
    rerenderChatViews();
    setChatNotice(error.message||"고정하지 못했어.",true);
    return;
  }
  if(isChatSideOpen("pins")) openChatPins();
}

function renderChatPinsButton(){
  const btn=$("chatPinsBtn");
  if(!btn) return;
  const n=chatPinsOf(chat.activeId).size;
  btn.textContent=`📌 ${n}`;
  btn.classList.toggle("on",n>0);
}

/* 고정된 메시지 모아 보기. 오래돼서 아직 안 불러온 메시지도 있으니 id 로 따로 읽는다. */
async function openChatPins(){
  const channelId=chat.activeId;
  const channel=chatChannel(channelId);
  if(!channel) return;
  if(!isChatSideOpen("pins")) openChatSide("pins","고정된 메시지");

  const pins=[...chatPinsOf(channelId)].sort((a,b)=>String(b[1].pinned_at).localeCompare(String(a[1].pinned_at)));
  const box=$("chatSideList");
  setChatSideTitle(`고정된 메시지 ${pins.length}개`);
  if(!pins.length){
    box.innerHTML='<div class="empty chat-empty">고정된 메시지가 없어. 메시지에 마우스를 올리고 📌 를 눌러봐.</div>';
    return;
  }

  const {data,error}=await teamCloud.client
    .from("chat_messages")
    .select("*")
    .in("id",pins.map(([id])=>id));
  if(!isChatSideOpen("pins") || chat.activeId!==channelId) return;
  if(error){
    console.error(error);
    box.innerHTML='<div class="empty chat-empty">고정된 메시지를 불러오지 못했어.</div>';
    return;
  }

  const byId=new Map((data||[]).map(r=>[Number(r.id),normalizeChatRow(r)]));
  box.innerHTML=pins.map(([id,info])=>{
    const m=byId.get(id);
    if(!m) return "";
    const date=new Date(m.created_at);
    const files=Array.isArray(m.attachments) ? m.attachments.length : 0;
    const body=m.body ? chatBodyHtml(m.body) : `<i>파일 ${files}개</i>`;
    return `<div class="chat-pin-item">`+
      `<button type="button" class="chat-search-item" data-pin-jump="${id}">`+
      `<div class="chat-search-meta"><b>${escapeHtml(chatMemberName(m.user_id))}</b>`+
      `<span>${date.getMonth()+1}/${date.getDate()} ${chatTimeLabel(m.created_at)}</span>`+
      `<span>${escapeHtml(chatMemberName(info.pinned_by))} 고정</span></div>`+
      `<div class="chat-search-body">${body}</div></button>`+
      `${channel.archived ? "" : `<button type="button" class="chat-pin-remove" data-pin-remove="${id}" title="고정 해제">×</button>`}`+
      `</div>`;
  }).join("");
  chatPinsCache=byId;
}

$("chatPinsBtn").addEventListener("click",()=>{
  if(isChatSideOpen("pins")) closeChatSide();
  else openChatPins();
});

$("chatSideList").addEventListener("click",e=>{
  if(!isChatSideOpen("pins")) return;
  const remove=e.target.closest("[data-pin-remove]");
  if(remove) return toggleChatPin(Number(remove.dataset.pinRemove));
  const jump=e.target.closest("[data-pin-jump]");
  if(!jump) return;
  const m=chatPinsCache.get(Number(jump.dataset.pinJump));
  if(m) jumpToChatMessage(m);
});
