/* ============================================================================
   팀 채팅 (채널 · 1:1 대화 · 메시지 · 안 읽음)

   1:1 대화도 kind='dm' 인 채널일 뿐이라 보내기·받기·읽음은 채널과 똑같이 돈다.
   다른 점은 멤버가 두 사람뿐이고, 이름 대신 상대 이름을 보여준다는 것.

   흐름
     보내기   화면에 먼저 그린다(전송 중) → send_chat_message RPC
              → DB 트리거가 chat:<채널> 비공개 Broadcast 로 행을 쏜다
     받기     Broadcast 로 온 행을 id 순서 자리에 끼워 넣는다
              내가 보낸 것은 client_id 로 '전송 중' 칸과 맞바꾼다
     빈 곳    재접속(SUBSCRIBED)·탭 복귀 때 최근 메시지를 DB 에서 다시 읽어 합친다

   순서는 언제나 서버가 매긴 id 로 정한다. 도착 순서는 믿지 않는다.
   쓰기는 모두 RPC 로만 한다 (supabase/patch-2026-10-chat.sql).
   ============================================================================ */

const CHAT_PAGE_SIZE=50;
const CHAT_GROUP_GAP_MS=5*60*1000;   // 같은 사람이 5분 안에 이어 쓰면 이름 줄을 생략
const CHAT_BASE_TITLE=document.title;
const CHAT_MESSAGE_COLUMNS="id,client_id,channel_id,user_id,parent_id,body,created_at,edited_at,deleted_at";

let chat=emptyChatState();

function emptyChatState(){
  return {
    teamId:null,
    channels:[],            // chat_bootstrap 결과
    activeId:null,
    messages:new Map(),     // 채널 id → 서버 메시지 배열 (id 오름차순)
    pending:new Map(),      // client_id → 아직 서버 확인을 못 받은 내 메시지
    hasMore:new Map(),      // 채널 id → 더 오래된 메시지가 남았는가
    loading:false,
    subs:new Map(),         // 채널 id → Realtime 채널
    joinedOnce:new Set(),   // 처음 SUBSCRIBED 를 받은 채널 (다음 SUBSCRIBED 는 재접속)
    teamSub:null,
    newSince:null,          // 채널을 열 때의 읽음 포인터 ('새 메시지' 줄 위치)
    readTimer:null,
    refreshTimer:null,
    creating:false,
    openingDm:false
  };
}


/* --------------------------------------------------------------- 시작 · 종료 */

/* 로그인 상태가 정해질 때마다 불린다. 같은 팀이면 목록만 새로 읽는다. */
async function startChat(){
  if(!teamCloud.client || !teamCloud.user || !teamCloud.teamId){
    stopChat();
    return;
  }
  if(chat.teamId!==teamCloud.teamId){
    stopChat();
    chat.teamId=teamCloud.teamId;
  }

  // 비공개 채널은 현재 로그인 토큰으로 권한을 판정한다.
  try{
    await teamCloud.client.realtime.setAuth();
  }catch(e){
    console.error(e);
  }
  await refreshChatChannels();
  syncChatSubscriptions();
}

function stopChat(){
  if(teamCloud.client){
    chat.subs.forEach(ch=>teamCloud.client.removeChannel(ch));
    if(chat.teamSub) teamCloud.client.removeChannel(chat.teamSub);
  }
  clearTimeout(chat.readTimer);
  clearTimeout(chat.refreshTimer);
  chat=emptyChatState();
  renderChatBadges();
  if(isChatPageActive()) renderChatPage();
}


/* ------------------------------------------------------------------ 채널 목록 */

async function refreshChatChannels(){
  if(!teamCloud.client || !chat.teamId) return;
  const {data,error}=await teamCloud.client.rpc("chat_bootstrap");
  if(error){
    console.error(error);
    setChatNotice("채팅 정보를 불러오지 못했어. 관리자가 patch-2026-10-chat.sql 을 실행했는지 확인해줘.",true);
    return;
  }

  chat.channels=(data||[]).map(c=>({
    ...c,
    last_read_id:Number(c.last_read_id||0),
    unread_count:Number(c.unread_count||0),
    last_message_id:Number(c.last_message_id||0)
  }));

  if(!chat.channels.some(c=>c.id===chat.activeId)){
    const first=chat.channels[0]||null;
    chat.activeId=first?.id||null;
    chat.newSince=first?.unread_count ? first.last_read_id : null;
  }

  renderChatBadges();
  if(isChatPageActive()) await renderChatPage();
}

/* 재접속 신호가 여러 채널에서 한꺼번에 와도 한 번만 다시 읽는다. */
function scheduleChatRefresh(){
  clearTimeout(chat.refreshTimer);
  chat.refreshTimer=setTimeout(async()=>{
    await refreshChatChannels();
    syncChatSubscriptions();
    if(chat.activeId) await fillChatGap(chat.activeId);
  },800);
}

function chatChannel(id){
  return chat.channels.find(c=>c.id===id)||null;
}


/* ---------------------------------------------------------------- 실시간 구독 */

function syncChatSubscriptions(){
  if(!teamCloud.client || !chat.teamId) return;
  const wanted=new Set(chat.channels.map(c=>c.id));

  chat.subs.forEach((ch,id)=>{
    if(wanted.has(id)) return;
    teamCloud.client.removeChannel(ch);
    chat.subs.delete(id);
    chat.joinedOnce.delete(id);
  });

  wanted.forEach(id=>{
    if(chat.subs.has(id)) return;
    const ch=teamCloud.client
      .channel(`chat:${id}`,{config:{private:true}})
      .on("broadcast",{event:"message"},({payload})=>onChatMessage(payload))
      .subscribe(status=>{
        if(status!=="SUBSCRIBED") return;
        // 첫 구독은 방금 목록을 읽었으니 넘어간다. 그 뒤의 SUBSCRIBED 는 끊겼다 다시 붙은 것이다.
        if(chat.joinedOnce.has(id)) scheduleChatRefresh();
        else chat.joinedOnce.add(id);
      });
    chat.subs.set(id,ch);
  });

  if(!chat.teamSub){
    chat.teamSub=teamCloud.client
      .channel(`chat-team:${chat.teamId}`,{config:{private:true}})
      .on("broadcast",{event:"channel"},()=>scheduleChatRefresh())
      .subscribe();
  }
}

function onChatMessage(row){
  if(!row || !row.id || row.parent_id) return;
  row.id=Number(row.id);
  const channel=chatChannel(row.channel_id);
  if(!channel) return;

  const isNew=mergeChatMessages(row.channel_id,[row]);
  chat.pending.delete(row.client_id);
  if(!isNew) {
    if(row.channel_id===chat.activeId) renderChatMessages();
    return;
  }

  channel.last_message_id=Math.max(channel.last_message_id,row.id);

  const mine=row.user_id===teamCloud.user?.id;
  if(mine){
    channel.last_read_id=Math.max(channel.last_read_id,row.id);
  }else if(row.id>channel.last_read_id){
    channel.unread_count+=1;
  }

  if(row.channel_id===chat.activeId && isChatPageActive()){
    const atBottom=isChatListAtBottom();
    renderChatMessages({stickToBottom:atBottom || mine});
    if(atBottom || mine) markChatReadSoon();
    else showChatJump(true);
  }
  renderChatBadges();
}


/* ------------------------------------------------------------- 메시지 불러오기 */

/* 배열에 id 순서대로 끼워 넣는다. 새로 들어간 게 있으면 true. */
function mergeChatMessages(channelId,rows){
  const list=chat.messages.get(channelId);
  if(!list) return true;   // 아직 안 연 채널은 열 때 DB 에서 읽는다
  const known=new Set(list.map(m=>m.id));
  let added=false;
  rows.forEach(r=>{
    const id=Number(r.id);
    if(known.has(id)) return;
    known.add(id);
    list.push({...r,id});
    added=true;
  });
  if(added) list.sort((a,b)=>a.id-b.id);
  return added;
}

async function fetchChatMessages(channelId,beforeId=null){
  let q=teamCloud.client
    .from("chat_messages")
    .select(CHAT_MESSAGE_COLUMNS)
    .eq("channel_id",channelId)
    .is("parent_id",null)
    .order("id",{ascending:false})
    .limit(CHAT_PAGE_SIZE);
  if(beforeId) q=q.lt("id",beforeId);
  const {data,error}=await q;
  if(error) throw error;
  return (data||[]).map(r=>({...r,id:Number(r.id)})).reverse();
}

/* 처음 열 때: 최근 50건 */
async function loadInitialChatMessages(channelId){
  const rows=await fetchChatMessages(channelId);
  chat.messages.set(channelId,rows);
  chat.hasMore.set(channelId,rows.length===CHAT_PAGE_SIZE);
}

/* 위로 스크롤: 지금 가진 것보다 오래된 50건 */
async function loadOlderChatMessages(){
  const id=chat.activeId;
  const list=chat.messages.get(id);
  if(chat.loading || !list?.length || !chat.hasMore.get(id)) return;

  chat.loading=true;
  const box=$("chatMessageList");
  const prevHeight=box.scrollHeight;
  try{
    const rows=await fetchChatMessages(id,list[0].id);
    chat.hasMore.set(id,rows.length===CHAT_PAGE_SIZE);
    mergeChatMessages(id,rows);
    renderChatMessages();
    // 읽던 자리가 그대로 보이도록 늘어난 높이만큼 내려준다
    box.scrollTop+=box.scrollHeight-prevHeight;
  }catch(e){
    console.error(e);
  }finally{
    chat.loading=false;
  }
}

/* 끊겼던 사이의 메시지 메우기.
   최근 50건을 다시 읽어 합친다. 그 50건이 가진 것과 이어지지 않으면
   사이가 너무 벌어진 것이니 최근 50건으로 새로 시작한다. */
async function fillChatGap(channelId){
  const list=chat.messages.get(channelId);
  if(!list) return;
  try{
    const rows=await fetchChatMessages(channelId);
    const newest=list.length ? list[list.length-1].id : 0;
    if(rows.length && rows[0].id>newest && rows.length===CHAT_PAGE_SIZE){
      chat.messages.set(channelId,rows);
      chat.hasMore.set(channelId,true);
    }else{
      mergeChatMessages(channelId,rows);
    }
    if(channelId===chat.activeId && isChatPageActive()){
      const atBottom=isChatListAtBottom();
      renderChatMessages({stickToBottom:atBottom});
      if(atBottom) markChatReadSoon();
    }
  }catch(e){
    console.error(e);
  }
}


/* ------------------------------------------------------------------- 보내기 */

function newClientId(){
  if(window.crypto?.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>
    (c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
}

async function sendChatMessage(){
  const input=$("chatInput");
  const body=input.value.trim();
  if(!body || !chat.activeId) return;
  if(body.length>4000){
    setChatNotice("메시지는 4000자까지 보낼 수 있어.",true);
    return;
  }

  const item={
    client_id:newClientId(),
    channel_id:chat.activeId,
    user_id:teamCloud.user.id,
    body,
    created_at:new Date().toISOString(),
    failed:false
  };
  chat.pending.set(item.client_id,item);
  input.value="";
  autoSizeChatInput();
  setChatNotice("");
  renderChatMessages({stickToBottom:true});
  await deliverChatMessage(item);
}

/* 같은 client_id 로 보내므로 재시도해도 두 번 올라가지 않는다. */
async function deliverChatMessage(item){
  item.failed=false;
  const {data,error}=await teamCloud.client.rpc("send_chat_message",{
    p_channel:item.channel_id,
    p_client_id:item.client_id,
    p_body:item.body
  });
  if(error){
    console.error(error);
    item.failed=true;
    if(item.channel_id===chat.activeId) renderChatMessages();
    return;
  }
  // Broadcast 보다 응답이 먼저 오면 여기서 확정한다. 나중에 온 쪽은 id 중복으로 무시된다.
  onChatMessage(data);
}

function retryChatMessage(clientId){
  const item=chat.pending.get(clientId);
  if(!item) return;
  renderChatMessages();
  deliverChatMessage(item);
}

function discardChatMessage(clientId){
  chat.pending.delete(clientId);
  renderChatMessages();
}


/* --------------------------------------------------------------------- 읽음 */

function isChatPageActive(){
  return !!$("chatPage")?.classList.contains("active");
}

function isChatListAtBottom(){
  const box=$("chatMessageList");
  if(!box) return false;
  return box.scrollHeight-box.scrollTop-box.clientHeight<40;
}

/* 지금 보고 있는 채널의 마지막 메시지까지 읽은 것으로 한다.
   탭이 가려져 있거나 맨 아래를 보고 있지 않으면 읽은 게 아니다. */
function markChatReadSoon(){
  if(document.visibilityState!=="visible" || !isChatPageActive()) return;
  const channel=chatChannel(chat.activeId);
  const list=chat.messages.get(chat.activeId);
  if(!channel || !list?.length) return;

  const lastId=list[list.length-1].id;
  if(lastId<=channel.last_read_id && channel.unread_count===0) return;

  channel.last_read_id=Math.max(channel.last_read_id,lastId);
  channel.unread_count=0;
  renderChatBadges();
  showChatJump(false);

  clearTimeout(chat.readTimer);
  const channelId=channel.id;
  chat.readTimer=setTimeout(async()=>{
    const {error}=await teamCloud.client.rpc("mark_chat_read",{p_channel:channelId,p_last_id:lastId});
    if(error) console.error(error);
  },600);
}

function renderChatBadges(){
  const total=chat.channels.reduce((sum,c)=>sum+(c.unread_count||0),0);
  const badge=$("chatTabBadge");
  if(badge){
    badge.textContent=total>99 ? "99+" : String(total);
    badge.hidden=total===0;
  }
  document.title=total ? `(${total>99?"99+":total}) ${CHAT_BASE_TITLE}` : CHAT_BASE_TITLE;
  if(isChatPageActive()) renderChatSidebar();
}

function showChatJump(show){
  const btn=$("chatJumpBtn");
  if(btn) btn.hidden=!show;
}


/* --------------------------------------------------------------------- 화면 */

function setChatNotice(text,isError=false){
  const el=$("chatNotice");
  if(!el) return;
  el.textContent=text||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

async function renderChatPage({stickToBottom=false}={}){
  const lock=$("chatLock");
  const layout=$("chatLayout");
  if(!lock || !layout) return;

  if(!teamCloud.configured || !teamCloud.user || !teamCloud.teamId){
    lock.style.display="block";
    lock.textContent=!teamCloud.user
      ? "팀 로그인 후 채팅을 쓸 수 있어."
      : "팀을 만들거나 초대코드로 참여하면 채팅이 열려.";
    layout.style.display="none";
    return;
  }

  lock.style.display="none";
  layout.style.display="";
  renderChatSidebar();

  const channel=chatChannel(chat.activeId);
  renderChatHeader(channel);
  $("chatInput").disabled=!channel;
  $("chatSendBtn").disabled=!channel;
  if(!channel){
    $("chatMessageList").innerHTML='<div class="empty chat-empty">채널을 불러오는 중이야.</div>';
    return;
  }

  const fresh=!chat.messages.has(channel.id);
  if(fresh){
    $("chatMessageList").innerHTML='<div class="empty chat-empty">메시지를 불러오는 중이야.</div>';
    try{
      await loadInitialChatMessages(channel.id);
    }catch(e){
      console.error(e);
      $("chatMessageList").innerHTML='<div class="empty chat-empty">메시지를 불러오지 못했어.</div>';
      return;
    }
    if(channel.id!==chat.activeId) return;   // 불러오는 사이 다른 채널로 옮겨갔다
  }

  // 처음 열 때만 맨 아래로 내린다. 목록을 다시 읽을 때는 보던 자리를 지킨다.
  renderChatMessages({stickToBottom:fresh || stickToBottom});
  if(isChatListAtBottom()) markChatReadSoon();
}

function openChatChannel(id){
  if(id===chat.activeId) return;
  const channel=chatChannel(id);
  if(!channel) return;
  chat.activeId=id;
  // 안 읽은 게 있으면 그 앞에 '새 메시지' 줄을 긋는다
  chat.newSince=channel.unread_count>0 ? channel.last_read_id : null;
  showChatJump(false);
  setChatNotice("");
  renderChatPage({stickToBottom:true});
  $("chatInput")?.focus();
}

/* 1:1 대화방은 상대가 아직 아무 말도 안 했으면 받는 쪽 목록에는 숨긴다.
   (구독은 해둔다. 첫 메시지가 오는 순간 목록에 나타난다) */
function isChatDmVisible(c){
  return c.last_message_id>0 || c.created_by===teamCloud.user?.id || c.id===chat.activeId;
}

function chatChannelLabel(c){
  return c.kind==="dm" ? chatMemberName(c.dm_user_id) : c.name;
}

function chatMemberStatusDot(userId){
  const status=effectiveStatus(teamCloud.memberStatus.get(userId));
  return `<span class="status-dot ${STATUS_DOT_CLASS[status]} chat-dm-dot" title="${STATUS_LABELS[status]}"></span>`;
}

function chatChannelButton(c){
  const unread=c.unread_count||0;
  const cls=["chat-channel-btn"];
  if(c.id===chat.activeId) cls.push("active");
  if(unread) cls.push("unread");
  const icon=c.kind==="dm" ? chatMemberStatusDot(c.dm_user_id) : '<span class="chat-hash">#</span>';
  return `<button type="button" class="${cls.join(" ")}" data-channel="${escapeHtml(c.id)}">`+
    `${icon}<span class="chat-channel-name">${escapeHtml(chatChannelLabel(c))}</span>`+
    `${unread ? `<span class="chat-badge">${unread>99?"99+":unread}</span>` : ""}</button>`;
}

function renderChatSidebar(){
  const box=$("chatChannelList");
  const dmBox=$("chatDmList");
  if(!box || !dmBox) return;

  box.innerHTML=chat.channels.filter(c=>c.kind!=="dm").map(chatChannelButton).join("")
    || '<div class="empty">채널이 없어.</div>';

  const dms=chat.channels
    .filter(c=>c.kind==="dm" && isChatDmVisible(c))
    .sort((a,b)=>(b.last_message_id||0)-(a.last_message_id||0));   // 최근 대화가 위로
  dmBox.innerHTML=dms.map(chatChannelButton).join("")
    || '<div class="chat-side-empty">+ 를 눌러 팀원과 1:1 대화를 시작해.</div>';
}

function renderChatHeader(channel){
  if(channel?.kind==="dm"){
    const member=teamCloud.members.find(m=>m.user_id===channel.dm_user_id);
    const name=chatChannelLabel(channel);
    $("chatChannelTitle").textContent=`@ ${name}`;
    $("chatChannelTopic").textContent=member?.job_title ? `${member.job_title} · 1:1 대화` : "1:1 대화";
    $("chatInput").placeholder=`${name}님에게 메시지 보내기`;
    return;
  }
  $("chatChannelTitle").textContent=channel ? `# ${channel.name}` : "";
  $("chatChannelTopic").textContent=channel?.topic||"";
  $("chatInput").placeholder=channel ? `#${channel.name} 에 메시지 보내기` : "";
}

function chatMemberName(userId){
  if(!userId) return "(나간 사람)";
  const member=teamCloud.members.find(m=>m.user_id===userId);
  if(member?.display_name) return member.display_name;
  if(userId===teamCloud.user?.id) return data.settings.userName||"나";
  return "이름 미설정";
}

function chatAvatarColor(userId){
  let h=0;
  for(const ch of String(userId||"")) h=(h*31+ch.charCodeAt(0))%360;
  return `hsl(${h} 52% 46%)`;
}

function chatTimeLabel(iso){
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return "";
  const pad=n=>String(n).padStart(2,"0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function chatDayKey(iso){
  const d=new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function chatDayLabel(iso){
  return new Date(iso).toLocaleDateString("ko-KR",{year:"numeric",month:"long",day:"numeric",weekday:"long"});
}

/* 본문은 escapeHtml 을 거친다. http/https 주소만 링크로 바꾼다. */
function chatBodyHtml(text){
  const parts=String(text||"").split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((part,i)=>{
    if(i%2===0) return escapeHtml(part);
    const url=escapeHtml(part);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  }).join("");
}

function renderChatMessages({stickToBottom=false}={}){
  const box=$("chatMessageList");
  if(!box) return;
  const channelId=chat.activeId;
  const list=chat.messages.get(channelId);
  if(!list) return;

  const wasAtBottom=isChatListAtBottom();
  const prevTop=box.scrollTop;
  const me=teamCloud.user?.id;

  const pending=[...chat.pending.values()].filter(p=>p.channel_id===channelId);
  const items=[...list,...pending.map(p=>({...p,id:null,pending:true}))];

  if(!items.length){
    box.innerHTML='<div class="empty chat-empty">아직 메시지가 없어. 첫 메시지를 남겨봐.</div>';
    return;
  }

  const html=[];
  if(chat.hasMore.get(channelId)) html.push('<div class="chat-more">위로 올리면 이전 메시지를 더 불러와.</div>');
  else html.push('<div class="chat-start">채널의 첫 메시지야.</div>');

  let prev=null;
  let newLineDrawn=false;
  items.forEach(m=>{
    const dayChanged=!prev || chatDayKey(prev.created_at)!==chatDayKey(m.created_at);
    if(dayChanged) html.push(`<div class="chat-day"><span>${escapeHtml(chatDayLabel(m.created_at))}</span></div>`);

    let newLine=false;
    if(!newLineDrawn && chat.newSince!==null && m.id && m.id>chat.newSince && m.user_id!==me){
      html.push('<div class="chat-newline"><span>새 메시지</span></div>');
      newLineDrawn=newLine=true;
    }

    const continued=prev && !dayChanged && !newLine
      && prev.user_id===m.user_id
      && new Date(m.created_at)-new Date(prev.created_at)<CHAT_GROUP_GAP_MS;

    const cls=["chat-msg"];
    if(continued) cls.push("cont");
    if(m.pending) cls.push("pending");
    if(m.failed) cls.push("failed");

    const name=chatMemberName(m.user_id);
    const time=chatTimeLabel(m.created_at);
    const gutter=continued
      ? `<span class="chat-gutter-time">${time}</span>`
      : `<span class="chat-avatar" style="background:${chatAvatarColor(m.user_id)}">${escapeHtml(name.slice(0,1))}</span>`;
    const head=continued ? "" :
      `<div class="chat-meta"><span class="chat-name">${escapeHtml(name)}</span><span class="chat-time">${time}</span></div>`;

    let status="";
    if(m.failed){
      status=`<div class="chat-fail">전송 실패 · `+
        `<button type="button" data-retry="${escapeHtml(m.client_id)}">다시 보내기</button> · `+
        `<button type="button" data-discard="${escapeHtml(m.client_id)}">지우기</button></div>`;
    }

    html.push(`<div class="${cls.join(" ")}">${gutter}<div class="chat-content">${head}`+
      `<div class="chat-body">${chatBodyHtml(m.body)}</div>${status}</div></div>`);
    prev=m;
  });

  box.innerHTML=html.join("");
  if(stickToBottom || wasAtBottom) box.scrollTop=box.scrollHeight;
  else box.scrollTop=prevTop;
}

function autoSizeChatInput(){
  const input=$("chatInput");
  if(!input) return;
  input.style.height="auto";
  input.style.height=`${Math.min(input.scrollHeight,160)}px`;
}


/* ------------------------------------------------------------------ 채널 추가 */

function toggleChatChannelForm(show){
  const form=$("chatChannelForm");
  if(!form) return;
  form.hidden=!show;
  if(show){
    $("chatChannelNameInput").value="";
    $("chatChannelTopicInput").value="";
    $("chatChannelNameInput").focus();
  }
}

async function createChatChannel(){
  if(chat.creating) return;
  const name=$("chatChannelNameInput").value.trim();
  const topic=$("chatChannelTopicInput").value.trim();
  if(!name) return;

  chat.creating=true;
  const {data:id,error}=await teamCloud.client.rpc("create_chat_channel",{p_name:name,p_topic:topic});
  chat.creating=false;
  if(error){
    setChatNotice(error.message||"채널을 만들지 못했어.",true);
    return;
  }

  toggleChatChannelForm(false);
  await refreshChatChannels();
  syncChatSubscriptions();
  if(id) openChatChannel(id);
}


/* ---------------------------------------------------------------- 1:1 대화 */

function toggleChatDmPicker(show){
  const picker=$("chatDmPicker");
  if(!picker) return;
  picker.hidden=!show;
  if(!show) return;

  const me=teamCloud.user?.id;
  const others=sortTeamMembers(teamCloud.members).filter(m=>m.user_id!==me);
  picker.innerHTML=others.length
    ? others.map(m=>
        `<button type="button" class="chat-dm-pick" data-dm-user="${escapeHtml(m.user_id)}">`+
        `${chatMemberStatusDot(m.user_id)}<span class="chat-channel-name">${escapeHtml(m.display_name||"이름 미설정")}</span>`+
        `<span class="chat-dm-title">${escapeHtml(m.job_title||"")}</span></button>`
      ).join("")
    : '<div class="chat-side-empty">대화할 팀원이 아직 없어.</div>';
}

async function openChatDm(userId){
  // 이미 있는 방이면 서버를 거치지 않고 바로 연다
  const existing=chat.channels.find(c=>c.kind==="dm" && c.dm_user_id===userId);
  toggleChatDmPicker(false);
  if(existing){
    openChatChannel(existing.id);
    return;
  }

  if(chat.openingDm) return;
  chat.openingDm=true;
  const {data:id,error}=await teamCloud.client.rpc("get_or_create_dm",{p_user:userId});
  chat.openingDm=false;
  if(error){
    setChatNotice(error.message||"1:1 대화를 열지 못했어.",true);
    return;
  }

  await refreshChatChannels();
  syncChatSubscriptions();
  if(id) openChatChannel(id);
}


/* ------------------------------------------------------------------- 이벤트 */

// 채널 목록과 1:1 대화 목록, 대화 상대 고르기를 한 곳에서 받는다
document.querySelector(".chat-sidebar").addEventListener("click",e=>{
  const pick=e.target.closest("[data-dm-user]");
  if(pick) return openChatDm(pick.dataset.dmUser);
  const btn=e.target.closest("[data-channel]");
  if(btn) openChatChannel(btn.dataset.channel);
});

$("chatAddDmBtn").addEventListener("click",()=>toggleChatDmPicker($("chatDmPicker").hidden));

$("chatMessageList").addEventListener("click",e=>{
  const retry=e.target.closest("[data-retry]");
  if(retry) return retryChatMessage(retry.dataset.retry);
  const discard=e.target.closest("[data-discard]");
  if(discard) discardChatMessage(discard.dataset.discard);
});

$("chatMessageList").addEventListener("scroll",()=>{
  const box=$("chatMessageList");
  if(box.scrollTop<80) loadOlderChatMessages();
  if(isChatListAtBottom()) markChatReadSoon();
});

$("chatInput").addEventListener("keydown",e=>{
  // 한글 조합 중의 Enter 는 글자 확정이다. 이때 보내면 마지막 글자가 따로 한 번 더 간다.
  if(e.key!=="Enter" || e.shiftKey || e.isComposing || e.keyCode===229) return;
  e.preventDefault();
  sendChatMessage();
});
$("chatInput").addEventListener("input",autoSizeChatInput);
$("chatSendBtn").addEventListener("click",sendChatMessage);

$("chatJumpBtn").addEventListener("click",()=>{
  const box=$("chatMessageList");
  box.scrollTop=box.scrollHeight;
  markChatReadSoon();
});

$("chatAddChannelBtn").addEventListener("click",()=>toggleChatChannelForm($("chatChannelForm").hidden));
$("chatChannelCancel").addEventListener("click",()=>toggleChatChannelForm(false));
$("chatChannelCreate").addEventListener("click",createChatChannel);
$("chatChannelNameInput").addEventListener("keydown",e=>{
  if(e.key==="Enter" && !e.isComposing && e.keyCode!==229){
    e.preventDefault();
    createChatChannel();
  }
});

// 탭으로 돌아오면 그 사이 놓친 것을 메우고, 보고 있던 채널은 읽음 처리한다.
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState!=="visible" || !chat.teamId) return;
  scheduleChatRefresh();
  if(isChatPageActive() && isChatListAtBottom()) markChatReadSoon();
});
