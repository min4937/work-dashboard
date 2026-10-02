/* ============================================================================
   팀 채팅 · 입력 중 표시

   저장하지 않는 일시 신호라 DB 를 거치지 않고 화면끼리 Broadcast 로 주고받는다.
   (Slack 도 타이핑 이벤트는 저장 없이 같은 경로로 흘려보낸다)

   보내는 쪽  글자를 칠 때 3초에 한 번까지만 보낸다
             → Broadcast 1건 = 보내기 1 + 받는 사람 수 로 과금되므로 꼭 줄여야 한다
   받는 쪽    6초 동안 새 신호가 없거나 그 사람 메시지가 도착하면 지운다
   ============================================================================ */

const CHAT_TYPING_SEND_MS=3000;
const CHAT_TYPING_TTL_MS=6000;

const chatTyping={
  lastSent:new Map(),   // 채널 id → 마지막으로 보낸 시각
  who:new Map(),        // 채널 id → Map(사람 id → 사라질 시각)
  timer:null
};

function sendChatTyping(channelId){
  const ch=chat.subs.get(channelId);
  if(!ch || !teamCloud.user) return;
  const now=Date.now();
  if(now-(chatTyping.lastSent.get(channelId)||0)<CHAT_TYPING_SEND_MS) return;
  chatTyping.lastSent.set(channelId,now);
  Promise.resolve(ch.send({type:"broadcast",event:"typing",payload:{user_id:teamCloud.user.id}}))
    .catch(e=>console.error(e));
}

/* 보냈으면 다음에 칠 때 바로 다시 알릴 수 있게 한다 */
function resetChatTypingSent(channelId){
  chatTyping.lastSent.delete(channelId);
}

function onChatTyping(channelId,payload){
  const userId=payload?.user_id;
  if(!userId || userId===teamCloud.user?.id) return;
  let users=chatTyping.who.get(channelId);
  if(!users){
    users=new Map();
    chatTyping.who.set(channelId,users);
  }
  users.set(userId,Date.now()+CHAT_TYPING_TTL_MS);
  renderChatTyping();
  scheduleChatTypingSweep();
}

function clearChatTyping(channelId,userId){
  if(chatTyping.who.get(channelId)?.delete(userId)) renderChatTyping();
}

function resetChatTyping(){
  chatTyping.lastSent.clear();
  chatTyping.who.clear();
  clearTimeout(chatTyping.timer);
  chatTyping.timer=null;
  renderChatTyping();
}

/* 시간이 지난 것을 지운다. 남은 게 있을 때만 다시 돈다. */
function scheduleChatTypingSweep(){
  if(chatTyping.timer) return;
  chatTyping.timer=setTimeout(()=>{
    chatTyping.timer=null;
    const now=Date.now();
    let left=0;
    chatTyping.who.forEach(users=>{
      users.forEach((until,id)=>{ if(until<=now) users.delete(id); });
      left+=users.size;
    });
    renderChatTyping();
    if(left) scheduleChatTypingSweep();
  },1000);
}

function renderChatTyping(){
  const el=$("chatTyping");
  if(!el) return;
  const now=Date.now();
  const ids=[...(chatTyping.who.get(chat.activeId)||new Map())]
    .filter(([,until])=>until>now)
    .map(([id])=>id);

  if(!ids.length){
    el.textContent="";
    return;
  }
  const names=ids.map(chatMemberName);
  el.textContent=names.length>3
    ? "여러 명이 입력 중이야…"
    : `${names.join(", ")}님이 입력 중이야…`;
}

["chatInput","chatThreadInput"].forEach(id=>{
  $(id).addEventListener("input",e=>{
    if(!e.target.value.trim()) return;
    sendChatTyping(id==="chatThreadInput" ? chatThread.channelId : chat.activeId);
  });
});
