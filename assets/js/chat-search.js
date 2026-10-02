/* ============================================================================
   팀 채팅 · 검색 · 메시지로 이동

   사이드바 위 검색칸에서 Enter → search_chat_messages RPC (내가 볼 수 있는 대화만)
   → 오른쪽 패널에 결과. 결과를 누르면 그 대화를 열고 그 메시지까지 거슬러 올라가
   가운데로 보여준다. 스레드 답글이면 스레드도 연다.

   jumpToChatMessage 는 데스크톱 알림을 눌렀을 때도 쓴다.
   ============================================================================ */

const CHAT_SEARCH_LIMIT=50;
const CHAT_JUMP_MAX_PAGES=20;   // 50건씩 최대 20번(1000건)까지 거슬러 올라간다

let chatSearchState={query:"",results:[],loading:false};

async function runChatSearch(){
  const query=$("chatSearchInput").value.trim();
  if(query.length<2){
    setChatNotice("검색어는 두 글자 이상 넣어줘.",true);
    return;
  }

  openChatSide("search","검색");
  chatSearchState={query,results:[],loading:true};
  renderChatSearch();

  const {data,error}=await teamCloud.client.rpc("search_chat_messages",{p_query:query,p_limit:CHAT_SEARCH_LIMIT});
  if(chatSearchState.query!==query || !isChatSideOpen("search")) return;   // 그 사이 바뀌었다
  chatSearchState.loading=false;
  if(error){
    console.error(error);
    $("chatSideList").innerHTML='<div class="empty chat-empty">검색하지 못했어.</div>';
    return;
  }
  chatSearchState.results=(data||[]).map(r=>({...r,id:Number(r.id),parent_id:r.parent_id ? Number(r.parent_id) : null}));
  renderChatSearch();
}

/* 이미 이스케이프된 문자열에서 검색어를 강조한다 */
function chatSearchHighlight(html,query){
  const q=escapeHtml(query);
  if(!q) return html;
  return html.replace(new RegExp(escapeRegExp(q),"gi"),m=>`<mark>${m}</mark>`);
}

/* 검색어 앞뒤만 잘라 보여준다 */
function chatSearchSnippet(body,query){
  const text=String(body||"");
  const at=text.toLowerCase().indexOf(query.toLowerCase());
  if(at<0 || text.length<=120) return text;
  const from=Math.max(0,at-40);
  return `${from>0?"…":""}${text.slice(from,from+120)}${from+120<text.length?"…":""}`;
}

function renderChatSearch(){
  const box=$("chatSideList");
  const {query,results,loading}=chatSearchState;
  setChatSideTitle(query ? `"${query}" 검색` : "검색");

  if(loading){
    box.innerHTML='<div class="empty chat-empty">찾는 중이야.</div>';
    return;
  }
  if(!results.length){
    box.innerHTML='<div class="empty chat-empty">찾은 메시지가 없어.</div>';
    return;
  }

  const more=results.length>=CHAT_SEARCH_LIMIT
    ? `<div class="chat-more">최근 ${CHAT_SEARCH_LIMIT}건만 보여줘. 검색어를 더 구체적으로 써봐.</div>`
    : "";
  box.innerHTML=`<div class="chat-search-count">${results.length}건</div>`+results.map((r,i)=>{
    const channel=chatChannel(r.channel_id);
    const where=!channel ? "" : channel.kind==="dm" ? `@ ${chatChannelLabel(channel)}` : `# ${channel.name}`;
    const date=new Date(r.created_at);
    const when=`${date.getMonth()+1}/${date.getDate()} ${chatTimeLabel(r.created_at)}`;
    const body=r.body ? chatSearchHighlight(escapeHtml(chatSearchSnippet(r.body,query)),query) : "<i>첨부 파일</i>";
    return `<button type="button" class="chat-search-item" data-search-idx="${i}">`+
      `<div class="chat-search-meta"><b>${escapeHtml(chatMemberName(r.user_id))}</b>`+
      `<span>${escapeHtml(where)}${r.parent_id?" · 스레드":""}</span><span>${when}</span></div>`+
      `<div class="chat-search-body">${body}</div></button>`;
  }).join("")+more;
}


/* ------------------------------------------------------------- 메시지로 이동 */

function chatListHas(channelId,id){
  return !!chat.messages.get(channelId)?.some(m=>m.id===id);
}

function flashChatMessage(container,id){
  const el=container?.querySelector(`[data-mid="${id}"]`);
  if(!el) return false;
  el.scrollIntoView({block:"center"});
  el.classList.add("flash");
  setTimeout(()=>el.classList.remove("flash"),2200);
  return true;
}

/* target = {channel_id, id, parent_id} */
async function jumpToChatMessage(target){
  if(!chatChannel(target.channel_id)) return;
  const tab=document.querySelector('[data-page="chatPage"]');
  if(!isChatPageActive()) tab?.click();

  if(chat.activeId!==target.channel_id) openChatChannel(target.channel_id);
  if(!chat.messages.has(target.channel_id)){
    try{
      await loadInitialChatMessages(target.channel_id);
    }catch(e){
      console.error(e);
      return;
    }
  }
  if(chat.activeId!==target.channel_id) return;   // 그 사이 다른 대화로 옮겨갔다
  renderChatMessages();

  // 원글(또는 그 메시지)이 보일 때까지 이전 메시지를 더 불러온다
  const topId=target.parent_id||target.id;
  for(let i=0;i<CHAT_JUMP_MAX_PAGES && !chatListHas(target.channel_id,topId) && chat.hasMore.get(target.channel_id);i++){
    await loadOlderChatMessages();
  }
  if(!chatListHas(target.channel_id,topId)){
    setChatNotice("너무 오래된 메시지라 찾지 못했어.",true);
    return;
  }

  flashChatMessage($("chatMessageList"),topId);
  if(target.parent_id){
    await openChatThread(target.parent_id);
    flashChatMessage($("chatThreadList"),target.id);
  }
}


/* ------------------------------------------------------------------- 이벤트 */

$("chatSearchInput").addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    e.target.value="";
    if(isChatSideOpen("search")) closeChatSide();
    return;
  }
  if(e.key!=="Enter" || e.isComposing || e.keyCode===229) return;
  e.preventDefault();
  runChatSearch();
});

$("chatSideList").addEventListener("click",e=>{
  if(!isChatSideOpen("search")) return;
  const item=e.target.closest("[data-search-idx]");
  if(!item) return;
  const hit=chatSearchState.results[Number(item.dataset.searchIdx)];
  if(hit) jumpToChatMessage(hit);
});
