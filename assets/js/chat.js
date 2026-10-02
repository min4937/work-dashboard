/* ============================================================================
   팀 채팅 (채널 · 1:1 대화 · 메시지 · 수정/삭제 · 리액션 · 안 읽음)
   스레드 패널은 chat-thread.js, @멘션 자동완성은 chat-mention.js

   1:1 대화도 kind='dm' 인 채널일 뿐이라 보내기·받기·읽음은 채널과 똑같이 돈다.
   다른 점은 멤버가 두 사람뿐이고, 이름 대신 상대 이름을 보여준다는 것.

   흐름
     보내기   화면에 먼저 그린다(전송 중) → send_chat_message RPC
              → DB 트리거가 chat:<채널> 비공개 Broadcast 로 행을 쏜다
     받기     Broadcast 로 온 행을 id 순서 자리에 끼워 넣는다
              내가 보낸 것은 client_id 로 '전송 중' 칸과 맞바꾼다
     고침     수정·삭제·답글 수 변경은 같은 행이 op:'update' 로 다시 온다 → 덮어쓴다
     리액션   reaction 이벤트로 (메시지, 사람, 이모지) 를 더하거나 뺀다
     빈 곳    재접속(SUBSCRIBED)·탭 복귀 때 최근 메시지를 DB 에서 다시 읽어 합친다

   순서는 언제나 서버가 매긴 id 로 정한다. 도착 순서는 믿지 않는다.
   쓰기는 모두 RPC 로만 한다 (supabase/patch-2026-10-chat.sql).
   ============================================================================ */

const CHAT_PAGE_SIZE=50;
const CHAT_GROUP_GAP_MS=5*60*1000;   // 같은 사람이 5분 안에 이어 쓰면 이름 줄을 생략
const CHAT_BASE_TITLE=document.title;
const CHAT_REACTION_EMOJIS=["👍","❤️","😂","🎉","👀","🙏","✅"];

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
    openingDm:false,
    reactions:new Map(),    // 메시지 id → Map(이모지 → Set(사람 id))
    editingId:null,         // 지금 고치고 있는 메시지 id
    editDraft:""
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
  closeChatThread();
  closeChatReactionPicker();
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
      .on("broadcast",{event:"reaction"},({payload})=>onChatReaction(payload))
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

function normalizeChatRow(row){
  return {
    ...row,
    id:Number(row.id),
    parent_id:row.parent_id ? Number(row.parent_id) : null,
    reply_count:Number(row.reply_count||0)
  };
}

/* 실시간으로 온 행이든 RPC 응답이든 여기로 모은다.
   새 메시지면 끼워 넣고 안 읽음을 세고, 이미 있는 메시지면(수정·삭제·답글 수) 덮어쓴다. */
function onChatMessage(raw){
  if(!raw || !raw.id) return;
  const row=normalizeChatRow(raw);
  chat.pending.delete(row.client_id);

  // 스레드 답글은 채널 목록·안 읽음과 무관하다. 열려 있는 스레드만 갱신한다.
  if(row.parent_id){
    onChatThreadRow(row);
    return;
  }

  const channel=chatChannel(row.channel_id);
  if(!channel) return;

  // 아직 안 연 채널은 목록이 없으니 op 로 새 글인지 판단한다
  const loaded=chat.messages.has(row.channel_id);
  const isNew=loaded ? mergeChatMessages(row.channel_id,[row]) : row.op!=="update";
  if(!isNew){
    if(row.channel_id===chat.activeId) rerenderChatViews();
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

/* 배열에 id 순서대로 끼워 넣는다. 이미 있는 id 는 서버 값으로 덮어쓴다(수정·삭제·답글 수).
   새로 들어간 게 있으면 true. */
function mergeChatMessages(channelId,rows){
  const list=chat.messages.get(channelId);
  if(!list) return true;   // 아직 안 연 채널은 열 때 DB 에서 읽는다
  const index=new Map(list.map((m,i)=>[m.id,i]));
  let added=false;
  rows.forEach(r=>{
    const row=normalizeChatRow(r);
    if(index.has(row.id)){
      list[index.get(row.id)]=row;
      return;
    }
    index.set(row.id,list.length);
    list.push(row);
    added=true;
  });
  if(added) list.sort((a,b)=>a.id-b.id);
  return added;
}

async function fetchChatMessages(channelId,beforeId=null){
  let q=teamCloud.client
    .from("chat_messages")
    .select("*")
    .eq("channel_id",channelId)
    .is("parent_id",null)
    .order("id",{ascending:false})
    .limit(CHAT_PAGE_SIZE);
  if(beforeId) q=q.lt("id",beforeId);
  const {data,error}=await q;
  if(error) throw error;
  const rows=(data||[]).map(normalizeChatRow).reverse();
  await loadChatReactions(rows.map(r=>r.id));
  return rows;
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
  const args={p_channel:item.channel_id,p_client_id:item.client_id,p_body:item.body};
  if(item.parent_id) args.p_parent=item.parent_id;   // 답글일 때만 넘긴다
  const {data,error}=await teamCloud.client.rpc("send_chat_message",args);
  if(error){
    console.error(error);
    item.failed=true;
    if(item.channel_id===chat.activeId) rerenderChatViews();
    return;
  }
  // Broadcast 보다 응답이 먼저 오면 여기서 확정한다. 나중에 온 쪽은 id 중복으로 무시된다.
  onChatMessage(data);
}

function retryChatMessage(clientId){
  const item=chat.pending.get(clientId);
  if(!item) return;
  rerenderChatViews();
  deliverChatMessage(item);
}

function discardChatMessage(clientId){
  chat.pending.delete(clientId);
  rerenderChatViews();
}


/* ---------------------------------------------------------------- 수정 · 삭제 */

function findChatMessage(id){
  for(const list of chat.messages.values()){
    const m=list.find(x=>x.id===id);
    if(m) return m;
  }
  return chatThreadReply(id);
}

function startChatEdit(id){
  const m=findChatMessage(id);
  if(!m || m.user_id!==teamCloud.user?.id || m.deleted_at) return;
  chat.editingId=id;
  chat.editDraft=m.body;
  rerenderChatViews();
  const input=$("chatEditInput");
  if(input){
    input.focus();
    input.setSelectionRange(input.value.length,input.value.length);
  }
}

function cancelChatEdit(){
  chat.editingId=null;
  chat.editDraft="";
  rerenderChatViews();
}

async function saveChatEdit(){
  const id=chat.editingId;
  const body=($("chatEditInput")?.value||chat.editDraft).trim();
  if(!id) return;
  if(!body){
    setChatNotice("내용을 비울 수는 없어. 지우려면 삭제를 눌러줘.",true);
    return;
  }
  const {data,error}=await teamCloud.client.rpc("edit_chat_message",{p_id:id,p_body:body});
  if(error){
    setChatNotice(error.message||"메시지를 고치지 못했어.",true);
    return;
  }
  chat.editingId=null;
  chat.editDraft="";
  onChatMessage(data);
  rerenderChatViews();
}

async function deleteChatMessage(id){
  if(!confirm("이 메시지를 삭제할까? 되돌릴 수 없어.")) return;
  const {data,error}=await teamCloud.client.rpc("delete_chat_message",{p_id:id});
  if(error){
    setChatNotice(error.message||"메시지를 지우지 못했어.",true);
    return;
  }
  chat.reactions.delete(id);
  onChatMessage(data);
}


/* ------------------------------------------------------------------- 리액션 */

/* 서버에서 읽은 값으로 그 메시지들의 리액션을 통째로 바꾼다. */
async function loadChatReactions(ids){
  if(!ids.length || !teamCloud.client) return;
  const {data,error}=await teamCloud.client
    .from("chat_reactions")
    .select("message_id,user_id,emoji")
    .in("message_id",ids);
  if(error){
    console.error(error);
    return;
  }
  ids.forEach(id=>chat.reactions.delete(id));
  (data||[]).forEach(r=>applyChatReaction(Number(r.message_id),r.user_id,r.emoji,true));
}

/* 같은 이벤트가 두 번 와도 결과가 같도록 Set 에 넣고 뺀다. */
function applyChatReaction(messageId,userId,emoji,add){
  let byEmoji=chat.reactions.get(messageId);
  if(!byEmoji){
    if(!add) return;
    byEmoji=new Map();
    chat.reactions.set(messageId,byEmoji);
  }
  let users=byEmoji.get(emoji);
  if(!users){
    if(!add) return;
    users=new Set();
    byEmoji.set(emoji,users);
  }
  if(add) users.add(userId);
  else users.delete(userId);
  if(!users.size) byEmoji.delete(emoji);
  if(!byEmoji.size) chat.reactions.delete(messageId);
}

function onChatReaction(p){
  if(!p || !p.message_id) return;
  applyChatReaction(Number(p.message_id),p.user_id,p.emoji,p.op!=="delete");
  rerenderChatViews();
}

/* 누르면 바로 화면에 반영하고, 실패하면 되돌린다. */
async function toggleChatReaction(messageId,emoji){
  const me=teamCloud.user?.id;
  const had=!!chat.reactions.get(messageId)?.get(emoji)?.has(me);
  applyChatReaction(messageId,me,emoji,!had);
  rerenderChatViews();

  const {error}=await teamCloud.client.rpc("toggle_chat_reaction",{p_message:messageId,p_emoji:emoji});
  if(error){
    console.error(error);
    applyChatReaction(messageId,me,emoji,had);
    rerenderChatViews();
    setChatNotice(error.message||"반응을 남기지 못했어.",true);
  }
}

let chatReactionPicker=null;

function openChatReactionPicker(anchor,messageId){
  closeChatReactionPicker();
  const box=document.createElement("div");
  box.className="chat-react-picker";
  box.innerHTML=CHAT_REACTION_EMOJIS
    .map(e=>`<button type="button" data-pick-emoji="${e}">${e}</button>`).join("");
  box.addEventListener("click",e=>{
    const btn=e.target.closest("[data-pick-emoji]");
    if(!btn) return;
    closeChatReactionPicker();
    toggleChatReaction(messageId,btn.dataset.pickEmoji);
  });
  document.body.appendChild(box);

  // 버튼 바로 위에 띄우되 화면 밖으로 나가지 않게
  const r=anchor.getBoundingClientRect();
  const w=box.offsetWidth, h=box.offsetHeight;
  box.style.left=`${Math.max(8,Math.min(window.innerWidth-w-8,r.right-w))}px`;
  box.style.top=`${r.top-h-6<8 ? r.bottom+6 : r.top-h-6}px`;
  chatReactionPicker=box;
}

function closeChatReactionPicker(){
  chatReactionPicker?.remove();
  chatReactionPicker=null;
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
  chat.editingId=null;
  closeChatThread();
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

/* 본문은 escapeHtml 을 거친다. http/https 주소만 링크로 바꾸고, @팀원이름 은 강조한다. */
function chatBodyHtml(text){
  const parts=String(text||"").split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((part,i)=>{
    if(i%2===0) return chatHighlightMentions(escapeHtml(part));
    const url=escapeHtml(part);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  }).join("");
}

function escapeRegExp(text){
  return String(text).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

function chatMyName(){
  return teamCloud.members.find(m=>m.user_id===teamCloud.user?.id)?.display_name||"";
}

/* 이미 이스케이프된 문자열에서 '@이름' 을 찾는다. 이름도 같은 방식으로 이스케이프해 맞춘다.
   긴 이름부터 맞춰야 '김민' 이 '김민수' 를 먼저 잡아먹지 않는다. */
function chatHighlightMentions(html){
  const myName=chatMyName();
  const names=teamCloud.members
    .map(m=>m.display_name).filter(Boolean)
    .map(n=>({raw:n,esc:escapeHtml(n)}))
    .sort((a,b)=>b.esc.length-a.esc.length);
  if(!names.length || !html.includes("@")) return html;
  const pattern=names.map(n=>escapeRegExp(n.esc)).join("|");
  const re=new RegExp(`@(${pattern})`,"g");
  return html.replace(re,(all,esc)=>{
    const mine=names.find(n=>n.esc===esc)?.raw===myName;
    return `<span class="chat-mention${mine?" me":""}">${all}</span>`;
  });
}

function chatMentionsMe(m){
  const myName=chatMyName();
  return !!myName && m.user_id!==teamCloud.user?.id && String(m.body||"").includes(`@${myName}`);
}

/* 리액션 칩 줄 */
function chatReactionsHtml(id){
  const byEmoji=chat.reactions.get(id);
  if(!byEmoji?.size) return "";
  const me=teamCloud.user?.id;
  const chips=[...byEmoji].map(([emoji,users])=>{
    const who=[...users].map(chatMemberName).join(", ");
    return `<button type="button" class="chat-reaction${users.has(me)?" mine":""}" `+
      `data-react="${id}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(who)}">`+
      `${escapeHtml(emoji)} <b>${users.size}</b></button>`;
  }).join("");
  return `<div class="chat-reactions">${chips}</div>`;
}

/* 마우스를 올리면 뜨는 버튼 줄. 전송 중이거나 지운 메시지에는 없다. */
function chatActionsHtml(m,inThread){
  if(!m.id || m.deleted_at) return "";
  const mine=m.user_id===teamCloud.user?.id;
  const btn=(act,icon,title)=>`<button type="button" data-act="${act}" data-id="${m.id}" title="${title}">${icon}</button>`;
  return `<div class="chat-actions">`+
    btn("react","😊","반응 남기기")+
    (!inThread && !m.parent_id ? btn("thread","💬","스레드로 답글") : "")+
    (mine ? btn("edit","✏️","고치기")+btn("delete","🗑️","삭제") : "")+
    `</div>`;
}

/* 메시지 한 칸. inThread 면 스레드 패널용(스레드 링크 없음, 원글은 그 자리에서 못 고침). */
function chatMessageHtml(m,{continued=false,inThread=false}={}){
  const cls=["chat-msg"];
  if(continued) cls.push("cont");
  if(m.pending) cls.push("pending");
  if(m.failed) cls.push("failed");
  if(!m.deleted_at && chatMentionsMe(m)) cls.push("mention");

  const name=chatMemberName(m.user_id);
  const time=chatTimeLabel(m.created_at);
  const gutter=continued
    ? `<span class="chat-gutter-time">${time}</span>`
    : `<span class="chat-avatar" style="background:${chatAvatarColor(m.user_id)}">${escapeHtml(name.slice(0,1))}</span>`;
  const head=continued ? "" :
    `<div class="chat-meta"><span class="chat-name">${escapeHtml(name)}</span><span class="chat-time">${time}</span></div>`;

  // 스레드 원글은 본문 목록에서만, 답글은 스레드에서만 고친다 (입력칸이 두 곳에 생기지 않게)
  const editable=chat.editingId===m.id && (inThread ? !!m.parent_id : !m.parent_id);
  let body;
  if(m.deleted_at){
    body='<div class="chat-body chat-deleted">삭제된 메시지야.</div>';
  }else if(editable){
    body=`<div class="chat-edit"><textarea id="chatEditInput" class="chat-edit-input" rows="2" maxlength="4000">${escapeHtml(chat.editDraft)}</textarea>`+
      `<div class="chat-edit-actions"><span>Enter 저장 · Esc 취소</span>`+
      `<button type="button" class="mini-btn" data-edit-cancel>취소</button>`+
      `<button type="button" class="btn primary" data-edit-save>저장</button></div></div>`;
  }else{
    body=`<div class="chat-body">${chatBodyHtml(m.body)}${m.edited_at?'<span class="chat-edited">(수정됨)</span>':""}</div>`;
  }

  let status="";
  if(m.failed){
    status=`<div class="chat-fail">전송 실패 · `+
      `<button type="button" data-retry="${escapeHtml(m.client_id)}">다시 보내기</button> · `+
      `<button type="button" data-discard="${escapeHtml(m.client_id)}">지우기</button></div>`;
  }

  const reactions=m.id && !m.deleted_at ? chatReactionsHtml(m.id) : "";
  const thread=!inThread && !m.parent_id && m.reply_count>0
    ? `<button type="button" class="chat-thread-link" data-thread="${m.id}">💬 답글 ${m.reply_count}개`+
      `${m.last_reply_at?`<span> · 마지막 ${chatTimeLabel(m.last_reply_at)}</span>`:""}</button>`
    : "";

  return `<div class="${cls.join(" ")}">${gutter}<div class="chat-content">${head}${body}${status}${reactions}${thread}</div>`+
    `${editable ? "" : chatActionsHtml(m,inThread)}</div>`;
}

/* 목록(본문 또는 스레드) 그리기 공용: 날짜 줄 · 이어쓰기 묶음 · 새 메시지 줄 */
function chatListHtml(items,{newSince=null,inThread=false}={}){
  const me=teamCloud.user?.id;
  const html=[];
  let prev=null;
  let newLineDrawn=false;
  items.forEach(m=>{
    const dayChanged=!prev || chatDayKey(prev.created_at)!==chatDayKey(m.created_at);
    if(dayChanged) html.push(`<div class="chat-day"><span>${escapeHtml(chatDayLabel(m.created_at))}</span></div>`);

    let newLine=false;
    if(!newLineDrawn && newSince!==null && m.id && m.id>newSince && m.user_id!==me){
      html.push('<div class="chat-newline"><span>새 메시지</span></div>');
      newLineDrawn=newLine=true;
    }

    const continued=!!prev && !dayChanged && !newLine
      && prev.user_id===m.user_id && !prev.deleted_at
      && new Date(m.created_at)-new Date(prev.created_at)<CHAT_GROUP_GAP_MS;

    html.push(chatMessageHtml(m,{continued,inThread}));
    prev=m;
  });
  return html.join("");
}

/* 고치는 중이던 입력칸이 다시 그려져도 커서를 잃지 않게 */
function restoreChatEditFocus(wasEditing){
  if(!wasEditing) return;
  const input=$("chatEditInput");
  if(!input) return;
  input.focus();
  input.setSelectionRange(input.value.length,input.value.length);
}

function rerenderChatViews(){
  if(!isChatPageActive()) return;
  renderChatMessages();
  renderChatThread();
}

function renderChatMessages({stickToBottom=false}={}){
  const box=$("chatMessageList");
  if(!box) return;
  const channelId=chat.activeId;
  const list=chat.messages.get(channelId);
  if(!list) return;

  const wasAtBottom=isChatListAtBottom();
  const prevTop=box.scrollTop;
  const wasEditing=document.activeElement?.id==="chatEditInput";

  // 스레드 답글로 보내는 중인 것은 본문 목록에 그리지 않는다
  const pending=[...chat.pending.values()].filter(p=>p.channel_id===channelId && !p.parent_id);
  const items=[...list,...pending.map(p=>({...p,id:null,pending:true}))];

  if(!items.length){
    box.innerHTML='<div class="empty chat-empty">아직 메시지가 없어. 첫 메시지를 남겨봐.</div>';
    return;
  }

  const head=chat.hasMore.get(channelId)
    ? '<div class="chat-more">위로 올리면 이전 메시지를 더 불러와.</div>'
    : '<div class="chat-start">채널의 첫 메시지야.</div>';
  box.innerHTML=head+chatListHtml(items,{newSince:chat.newSince});

  if(stickToBottom || wasAtBottom) box.scrollTop=box.scrollHeight;
  else box.scrollTop=prevTop;
  restoreChatEditFocus(wasEditing);
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

/* 본문 목록과 스레드 패널의 메시지 버튼을 한 곳에서 받는다 */
function onChatListClick(e){
  const retry=e.target.closest("[data-retry]");
  if(retry) return retryChatMessage(retry.dataset.retry);
  const discard=e.target.closest("[data-discard]");
  if(discard) return discardChatMessage(discard.dataset.discard);

  const chip=e.target.closest("[data-react]");
  if(chip) return toggleChatReaction(Number(chip.dataset.react),chip.dataset.emoji);
  const thread=e.target.closest("[data-thread]");
  if(thread) return openChatThread(Number(thread.dataset.thread));

  if(e.target.closest("[data-edit-save]")) return saveChatEdit();
  if(e.target.closest("[data-edit-cancel]")) return cancelChatEdit();

  const act=e.target.closest("[data-act]");
  if(!act) return;
  const id=Number(act.dataset.id);
  if(act.dataset.act==="react") return openChatReactionPicker(act,id);
  if(act.dataset.act==="thread") return openChatThread(id);
  if(act.dataset.act==="edit") return startChatEdit(id);
  if(act.dataset.act==="delete") return deleteChatMessage(id);
}

/* 고치는 입력칸: Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소 */
function onChatListKeydown(e){
  if(e.target.id!=="chatEditInput") return;
  if(e.key==="Escape"){
    e.preventDefault();
    cancelChatEdit();
  }else if(e.key==="Enter" && !e.shiftKey && !e.isComposing && e.keyCode!==229){
    e.preventDefault();
    saveChatEdit();
  }
}

function onChatListInput(e){
  if(e.target.id==="chatEditInput") chat.editDraft=e.target.value;
}

["chatMessageList","chatThreadList"].forEach(id=>{
  $(id).addEventListener("click",onChatListClick);
  $(id).addEventListener("keydown",onChatListKeydown);
  $(id).addEventListener("input",onChatListInput);
});

// 반응 고르기 창은 바깥을 누르거나 스크롤하면 닫는다
document.addEventListener("mousedown",e=>{
  if(chatReactionPicker && !e.target.closest(".chat-react-picker,[data-act='react']")) closeChatReactionPicker();
});
document.addEventListener("scroll",closeChatReactionPicker,true);

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
// ↑ 키로 내 마지막 메시지 고치기 (입력칸이 비어 있을 때만, 슬랙과 같다)
$("chatInput").addEventListener("keydown",e=>{
  if(e.key!=="ArrowUp" || e.target.value) return;
  const me=teamCloud.user?.id;
  const mine=[...(chat.messages.get(chat.activeId)||[])].reverse().find(m=>m.user_id===me && !m.deleted_at);
  if(!mine) return;
  e.preventDefault();
  startChatEdit(mine.id);
});

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
