/* ============================================================================
   팀 채팅 · 데스크톱 알림

   슬랙 기본값처럼 '나한테 온 것'만 알린다.
     · 1:1 대화의 새 메시지
     · 나를 @부른 메시지 (채널 · 스레드 모두)
     · 내가 쓴 글에 달린 스레드 답글
   그 대화를 지금 보고 있으면 알리지 않는다.

   켜고 끄기는 이 브라우저에만 저장한다 (PC 마다 원하는 게 다르다).
   권한 요청은 브라우저 규칙상 사용자가 버튼을 눌렀을 때만 할 수 있다.
   ============================================================================ */

const CHAT_NOTIFY_KEY="myCompanyDashboard_chatNotify";

function chatNotifySupported(){
  return typeof window.Notification==="function";
}

function chatNotifyEnabled(){
  if(!chatNotifySupported() || Notification.permission!=="granted") return false;
  try{
    return localStorage.getItem(CHAT_NOTIFY_KEY)==="on";
  }catch(e){
    return false;
  }
}

function saveChatNotify(on){
  try{
    localStorage.setItem(CHAT_NOTIFY_KEY,on ? "on" : "off");
  }catch(e){
    console.error(e);
  }
}

async function toggleChatNotify(){
  if(!chatNotifySupported()){
    setChatNotice("이 브라우저는 데스크톱 알림을 지원하지 않아.",true);
    return;
  }
  if(chatNotifyEnabled()){
    saveChatNotify(false);
    renderChatNotifyButton();
    setChatNotice("알림을 껐어.");
    return;
  }

  const permission=Notification.permission==="granted"
    ? "granted"
    : await Notification.requestPermission();
  if(permission!=="granted"){
    setChatNotice("브라우저가 알림을 막고 있어. 주소창 왼쪽 자물쇠 → 알림 → 허용으로 바꿔줘.",true);
    renderChatNotifyButton();
    return;
  }
  saveChatNotify(true);
  renderChatNotifyButton();
  setChatNotice("1:1 대화와 나를 부른 메시지가 오면 알려줄게.");
}

function renderChatNotifyButton(){
  const btn=$("chatNotifyBtn");
  if(!btn) return;
  const on=chatNotifyEnabled();
  btn.textContent=on ? "🔔 알림 켜짐" : "🔕 알림 꺼짐";
  btn.classList.toggle("on",on);
  btn.title=on
    ? "1:1 대화 · 나를 부른 메시지 · 내 글의 답글이 오면 알려줘. 누르면 꺼."
    : "누르면 데스크톱 알림을 켜.";
}

/* 이 메시지가 '나한테 온 것'인가 */
function chatNotifyReason(row,channel){
  const me=teamCloud.user?.id;
  if(!me || row.user_id===me || row.deleted_at || row.op==="update") return "";
  if(channel.kind==="dm") return "dm";
  if(chatMentionsMe(row)) return "mention";
  if(row.parent_id && findChatMessage(row.parent_id)?.user_id===me) return "reply";
  return "";
}

/* 지금 그 대화를 보고 있는가 */
function isLookingAtChat(row){
  if(document.visibilityState!=="visible" || !isChatPageActive()) return false;
  if(chat.activeId!==row.channel_id) return false;
  return !row.parent_id || chatThread.parentId===row.parent_id;
}

function notifyChatMessage(row){
  if(!chatNotifyEnabled()) return;
  const channel=chatChannel(row.channel_id);
  if(!channel) return;
  const reason=chatNotifyReason(row,channel);
  if(!reason || isLookingAtChat(row)) return;

  const name=chatMemberName(row.user_id);
  const where=channel.kind==="dm" ? "1:1 대화" : `#${channel.name}`;
  const title=reason==="reply" ? `${name} · 내 글에 답글` : `${name} · ${where}`;
  const files=Array.isArray(row.attachments) ? row.attachments.length : 0;
  const body=(row.body||"").trim() || (files ? `파일 ${files}개를 보냈어.` : "");

  try{
    // 같은 대화 알림은 tag 로 하나로 합쳐 쌓이지 않게 한다
    const n=new Notification(title,{body:body.slice(0,140),tag:`chat-${row.channel_id}`});
    n.onclick=()=>{
      window.focus();
      n.close();
      jumpToChatMessage(row);
    };
  }catch(e){
    // 모바일 브라우저는 생성자 대신 서비스워커 알림만 허용한다. 그때는 조용히 넘어간다.
    console.error(e);
  }
}

$("chatNotifyBtn").addEventListener("click",toggleChatNotify);
renderChatNotifyButton();
