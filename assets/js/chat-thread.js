/* ============================================================================
   팀 채팅 · 스레드 패널 (오른쪽)

   원글 아래로 답글을 모아 보는 창. 답글은 parent_id 가 있는 chat_messages 행이다.
   보내기·받기·리액션·수정은 chat.js 의 것을 그대로 쓰고, 여기서는
   어느 원글의 답글을 들고 있는지와 패널 그리기만 맡는다.

   답글은 채널 안 읽은 수에 들어가지 않는다 (슬랙과 같다).
   ============================================================================ */

const CHAT_THREAD_LIMIT=500;

let chatThread=emptyChatThread();

function emptyChatThread(){
  return {parentId:null,channelId:null,replies:[],loading:false};
}

function isChatThreadOpen(){
  return chatThread.parentId!==null;
}

function chatThreadParent(){
  return chat.messages.get(chatThread.channelId)?.find(m=>m.id===chatThread.parentId)||null;
}

function chatThreadReply(id){
  return chatThread.replies.find(r=>r.id===id)||null;
}

async function openChatThread(parentId){
  const parent=chat.messages.get(chat.activeId)?.find(m=>m.id===parentId);
  if(!parent) return;

  // 오른쪽 자리는 스레드와 검색이 나눠 쓴다
  if(isChatSearchOpen()) closeChatSearch();
  if(chatThread.parentId!==parentId) clearChatDrafts("thread");
  chatThread={parentId,channelId:parent.channel_id,replies:[],loading:true};
  $("chatThread").hidden=false;
  document.querySelector(".chat-layout")?.classList.add("side-open");
  setChatThreadNotice("");
  renderChatThread({stickToBottom:true});

  try{
    const {data,error}=await teamCloud.client
      .from("chat_messages")
      .select("*")
      .eq("parent_id",parentId)
      .order("id",{ascending:true})
      .limit(CHAT_THREAD_LIMIT);
    if(error) throw error;
    if(chatThread.parentId!==parentId) return;   // 불러오는 사이 다른 스레드로 옮겨갔다
    mergeChatThreadReplies(data||[]);
    await loadChatReactions(chatThread.replies.map(r=>r.id));
  }catch(e){
    console.error(e);
    setChatThreadNotice("답글을 불러오지 못했어.",true);
  }

  if(chatThread.parentId!==parentId) return;
  chatThread.loading=false;
  renderChatThread({stickToBottom:true});
  $("chatThreadInput")?.focus();
}

function closeChatThread(){
  chatThread=emptyChatThread();
  clearChatDrafts("thread");
  const panel=$("chatThread");
  if(panel) panel.hidden=true;
  if(!isChatSearchOpen()) document.querySelector(".chat-layout")?.classList.remove("side-open");
}

/* id 순서로 끼워 넣고, 이미 있는 답글은 덮어쓴다(수정·삭제). */
function mergeChatThreadReplies(rows){
  const index=new Map(chatThread.replies.map((r,i)=>[r.id,i]));
  rows.forEach(raw=>{
    const row=normalizeChatRow(raw);
    if(index.has(row.id)) chatThread.replies[index.get(row.id)]=row;
    else{
      index.set(row.id,chatThread.replies.length);
      chatThread.replies.push(row);
    }
  });
  chatThread.replies.sort((a,b)=>a.id-b.id);
}

/* chat.js 의 onChatMessage 가 답글 행을 넘겨준다 */
function onChatThreadRow(row){
  if(row.parent_id!==chatThread.parentId) return;
  const atBottom=isChatThreadAtBottom();
  mergeChatThreadReplies([row]);
  renderChatThread({stickToBottom:atBottom || row.user_id===teamCloud.user?.id});
}

function isChatThreadAtBottom(){
  const box=$("chatThreadList");
  if(!box) return false;
  return box.scrollHeight-box.scrollTop-box.clientHeight<40;
}

function setChatThreadNotice(text,isError=false){
  const el=$("chatThreadNotice");
  if(!el) return;
  el.textContent=text||"";
  el.style.color=isError ? "var(--red)" : "var(--muted)";
}

function renderChatThread({stickToBottom=false}={}){
  if(!isChatThreadOpen()) return;
  const box=$("chatThreadList");
  if(!box) return;

  const channel=chatChannel(chatThread.channelId);
  $("chatThreadChannel").textContent=channel
    ? (channel.kind==="dm" ? `@ ${chatChannelLabel(channel)}` : `# ${channel.name}`)
    : "";

  const parent=chatThreadParent();
  if(!parent){
    box.innerHTML='<div class="empty chat-empty">원래 메시지를 찾을 수 없어.</div>';
    return;
  }

  const wasAtBottom=isChatThreadAtBottom();
  const prevTop=box.scrollTop;
  const wasEditing=document.activeElement?.id==="chatEditInput";

  const pending=[...chat.pending.values()]
    .filter(p=>p.parent_id===chatThread.parentId)
    .map(p=>({...p,id:null,pending:true}));
  const replies=[...chatThread.replies,...pending];
  const count=chatThread.replies.filter(r=>!r.deleted_at).length;

  const divider=chatThread.loading
    ? '<div class="chat-thread-divider">답글을 불러오는 중이야.</div>'
    : `<div class="chat-thread-divider">${count ? `답글 ${count}개` : "아직 답글이 없어."}</div>`;

  box.innerHTML=chatMessageHtml(parent,{inThread:true})+divider+chatListHtml(replies,{inThread:true});

  if(stickToBottom || wasAtBottom) box.scrollTop=box.scrollHeight;
  else box.scrollTop=prevTop;
  restoreChatEditFocus(wasEditing);

  const input=$("chatThreadInput");
  input.disabled=!!parent.deleted_at;
  input.placeholder=parent.deleted_at ? "지운 메시지에는 답글을 달 수 없어." : "답글 보내기";
}

async function sendChatReply(){
  const input=$("chatThreadInput");
  const body=input.value.trim();
  const parent=chatThreadParent();
  if(!parent || parent.deleted_at) return;
  if(!body && !chatFiles.drafts.thread.length) return;
  if(body.length>4000){
    setChatThreadNotice("메시지는 4000자까지 보낼 수 있어.",true);
    return;
  }
  const attachments=takeChatDrafts("thread");
  if(!attachments) return;

  const item={
    client_id:newClientId(),
    channel_id:parent.channel_id,
    parent_id:parent.id,
    user_id:teamCloud.user.id,
    body,
    attachments,
    created_at:new Date().toISOString(),
    failed:false
  };
  chat.pending.set(item.client_id,item);
  input.value="";
  autoSizeChatThreadInput();
  setChatThreadNotice("");
  renderChatThread({stickToBottom:true});
  await deliverChatMessage(item);
}

function autoSizeChatThreadInput(){
  const input=$("chatThreadInput");
  if(!input) return;
  input.style.height="auto";
  input.style.height=`${Math.min(input.scrollHeight,140)}px`;
}


/* ------------------------------------------------------------------- 이벤트 */

$("chatThreadClose").addEventListener("click",closeChatThread);
$("chatThreadSendBtn").addEventListener("click",sendChatReply);
$("chatThreadInput").addEventListener("input",autoSizeChatThreadInput);
$("chatThreadInput").addEventListener("keydown",e=>{
  if(e.key==="Escape" && !e.target.value){
    closeChatThread();
    return;
  }
  // 한글 조합 중의 Enter 는 글자 확정이다
  if(e.key!=="Enter" || e.shiftKey || e.isComposing || e.keyCode===229) return;
  e.preventDefault();
  sendChatReply();
});
