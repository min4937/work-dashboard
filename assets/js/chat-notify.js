/* ============================================================================
   팀 채팅 · 알림

   어떤 메시지를 알릴지 (계정 설정 · 어느 PC 에서든 같다)
     all       모든 새 메시지 (스레드 답글은 내 글에 달린 것만)
     mentions  1:1 대화 · 나를 부른 글 · 내 글의 답글   ← 기본값 (슬랙과 같다)
     off       알리지 않는다 (안 읽은 수 표시는 그대로)
     채널 음소거: 그 채널은 나를 부른 글만 알리고, 안 읽은 수를 탭 제목에서 뺀다.

   어떻게 알릴지
     화면을 보고 있으면   오른쪽 아래 팝업 + 알림음
     탭이 가려져 있으면   데스크톱 알림(켠 브라우저만) + 알림음
     그 대화를 지금 보고 있으면 알리지 않는다.

   설정은 data.settings.chatNotify 에 두어 기존 개인 설정 동기화(user_state)를 탄다.
   데스크톱 알림은 브라우저 권한이 PC 마다 달라서 켜고 끄기를 이 브라우저에만 저장한다.
   ============================================================================ */

const CHAT_DESKTOP_KEY="myCompanyDashboard_chatNotify";
const CHAT_TOAST_MS=7000;
const CHAT_TOAST_MAX=3;
const CHAT_SOUND_GAP_MS=1500;   // 메시지가 몰려 와도 소리는 1.5초에 한 번
const CHAT_NOTIFY_LEVELS=[
  ["all","모든 새 메시지"],
  ["mentions","1:1 · 나를 부른 글 · 내 글의 답글"],
  ["off","끄기 (안 읽은 수만 표시)"]
];


/* ------------------------------------------------------------------- 설정 */

function chatNotifySettings(){
  const s=data.settings.chatNotify||{};
  return {
    level:["all","mentions","off"].includes(s.level) ? s.level : "mentions",
    sound:s.sound!==false,
    muted:Array.isArray(s.muted) ? s.muted : []
  };
}

function saveChatNotifySettings(patch){
  data.settings.chatNotify={...chatNotifySettings(),...patch};
  persist();   // 로그인 상태면 계정에도 저장된다 (sync.js)
}

function isChatChannelMuted(channelId){
  return chatNotifySettings().muted.includes(channelId);
}

function setChatChannelMuted(channelId,muted){
  const list=chatNotifySettings().muted.filter(id=>id!==channelId);
  if(muted) list.push(channelId);
  saveChatNotifySettings({muted:list});
  renderChatBadges();   // 음소거 채널은 탭 제목의 안 읽은 수에서 빠진다
}


/* --------------------------------------------------------- 데스크톱 알림 권한 */

function chatDesktopSupported(){
  return typeof window.Notification==="function";
}

function chatDesktopEnabled(){
  if(!chatDesktopSupported() || Notification.permission!=="granted") return false;
  try{
    return localStorage.getItem(CHAT_DESKTOP_KEY)==="on";
  }catch(e){
    return false;
  }
}

function saveChatDesktop(on){
  try{
    localStorage.setItem(CHAT_DESKTOP_KEY,on ? "on" : "off");
  }catch(e){
    console.error(e);
  }
}

/* 권한 요청은 브라우저 규칙상 사용자가 버튼을 눌렀을 때만 할 수 있다 */
async function toggleChatDesktop(){
  if(!chatDesktopSupported()){
    setChatNotice("이 브라우저는 데스크톱 알림을 지원하지 않아.",true);
    return;
  }
  if(chatDesktopEnabled()){
    saveChatDesktop(false);
  }else{
    const permission=Notification.permission==="granted"
      ? "granted"
      : await Notification.requestPermission();
    if(permission!=="granted"){
      setChatNotice("브라우저가 알림을 막고 있어. 주소창 왼쪽 자물쇠 → 알림 → 허용으로 바꿔줘.",true);
    }else{
      saveChatDesktop(true);
    }
  }
  renderChatNotifyButton();
  if(isChatSideOpen("notify")) renderChatNotifyPanel();
}


/* --------------------------------------------------------------- 알림음 */

let chatAudio=null;
let chatSoundAt=0;

function chatAudioContext(){
  if(!chatAudio){
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC) return null;
    chatAudio=new AC();
  }
  return chatAudio;
}

/* 파일 없이 짧은 두 음을 만든다. 브라우저는 사용자가 한 번 누르기 전에는 소리를 막는다. */
function playChatSound(){
  if(!chatNotifySettings().sound) return;
  const now=Date.now();
  if(now-chatSoundAt<CHAT_SOUND_GAP_MS) return;
  const ctx=chatAudioContext();
  if(!ctx || ctx.state!=="running") return;
  chatSoundAt=now;

  [[880,0],[1320,0.11]].forEach(([freq,delay])=>{
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    const t=ctx.currentTime+delay;
    osc.type="sine";
    osc.frequency.value=freq;
    gain.gain.setValueAtTime(0.0001,t);
    gain.gain.exponentialRampToValueAtTime(0.08,t+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,t+0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t+0.2);
  });
}

// 첫 클릭 때 소리 장치를 깨워 둔다 (자동재생 정책)
document.addEventListener("pointerdown",()=>{
  const ctx=chatAudioContext();
  if(ctx?.state==="suspended") ctx.resume();
},{passive:true});


/* ------------------------------------------------------------- 알릴지 판단 */

/* 알릴 이유. 없으면 "" */
function chatNotifyReason(row,channel){
  const me=teamCloud.user?.id;
  if(!me || row.user_id===me || row.deleted_at || row.op==="update") return "";
  const s=chatNotifySettings();
  if(s.level==="off") return "";

  const mention=chatMentionsMe(row);
  if(isChatChannelMuted(channel.id)) return mention ? "mention" : "";
  if(channel.kind==="dm") return "dm";
  if(mention) return "mention";
  if(row.parent_id && findChatMessage(row.parent_id)?.user_id===me) return "reply";
  if(s.level==="all" && !row.parent_id) return "all";
  return "";
}

/* 지금 그 대화를 보고 있는가 */
function isLookingAtChat(row){
  if(document.visibilityState!=="visible" || !isChatPageActive()) return false;
  if(chat.activeId!==row.channel_id) return false;
  return !row.parent_id || chatThread.parentId===row.parent_id;
}

function chatNotifyText(row,channel,reason){
  const name=chatMemberName(row.user_id);
  const where=channel.kind==="dm" ? "1:1 대화"
    : `${channel.kind==="private" ? "🔒" : "#"}${channel.name}`;
  const title=reason==="reply" ? `${name} · 내 글에 답글`
    : reason==="mention" ? `${name} · ${where} 에서 나를 불렀어`
    : `${name} · ${where}`;
  const files=Array.isArray(row.attachments) ? row.attachments.length : 0;
  const body=(row.body||"").trim() || (files ? `파일 ${files}개를 보냈어.` : "");
  return {title,body:body.slice(0,140)};
}

/* chat.js onChatMessage 가 새 메시지마다 부른다 */
function notifyChatMessage(row){
  const channel=chatChannel(row.channel_id);
  if(!channel) return;
  const reason=chatNotifyReason(row,channel);
  if(!reason || isLookingAtChat(row)) return;

  const {title,body}=chatNotifyText(row,channel,reason);
  if(document.visibilityState==="visible"){
    showChatToast(row,title,body);
  }else if(chatDesktopEnabled()){
    showChatDesktop(row,title,body);
  }
  playChatSound();
}

function showChatDesktop(row,title,body){
  try{
    // 같은 대화 알림은 tag 로 하나로 합쳐 쌓이지 않게 한다
    const n=new Notification(title,{body,tag:`chat-${row.channel_id}`});
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


/* ------------------------------------------------------------ 화면 안 팝업 */

function chatToastBox(){
  let box=$("chatToasts");
  if(!box){
    box=document.createElement("div");
    box.id="chatToasts";
    box.className="chat-toasts";
    document.body.appendChild(box);
  }
  return box;
}

function showChatToast(row,title,body){
  const box=chatToastBox();
  // 같은 대화의 이전 팝업은 새 것으로 바꾼다
  box.querySelector(`[data-toast-channel="${row.channel_id}"]`)?.remove();

  const toast=document.createElement("div");
  toast.className="chat-toast";
  toast.dataset.toastChannel=row.channel_id;
  const name=chatMemberName(row.user_id);
  toast.innerHTML=
    `<span class="chat-avatar" style="background:${chatAvatarColor(row.user_id)}">${escapeHtml(name.slice(0,1))}</span>`+
    `<div class="chat-toast-text"><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`+
    `<button type="button" class="chat-toast-close" title="닫기">×</button>`;

  toast.addEventListener("click",e=>{
    toast.remove();
    if(e.target.closest(".chat-toast-close") || !row.id) return;   // 미리보기는 갈 곳이 없다
    jumpToChatMessage(row);
  });
  box.appendChild(toast);

  while(box.children.length>CHAT_TOAST_MAX) box.firstElementChild.remove();
  setTimeout(()=>toast.remove(),CHAT_TOAST_MS);
}


/* ------------------------------------------------------------- 설정 패널 */

function renderChatNotifyButton(){
  const btn=$("chatNotifyBtn");
  if(!btn) return;
  const {level}=chatNotifySettings();
  const muted=chat.activeId && isChatChannelMuted(chat.activeId);
  btn.textContent=muted ? "🔕 음소거" : level==="off" ? "🔕 알림 끔" : "🔔 알림";
  btn.classList.toggle("on",level!=="off" && !muted);
  btn.title="알림 설정";
}

function openChatNotifyPanel(){
  openChatSide("notify","알림 설정");
  renderChatNotifyPanel();
}

function renderChatNotifyPanel(){
  const s=chatNotifySettings();
  const channel=chatChannel(chat.activeId);
  const desktopOn=chatDesktopEnabled();
  const desktopBlocked=chatDesktopSupported() && Notification.permission==="denied";

  const levels=CHAT_NOTIFY_LEVELS.map(([value,label])=>
    `<label class="chat-member-pick"><input type="radio" name="chatNotifyLevel" value="${value}"${s.level===value?" checked":""}>${label}</label>`
  ).join("");

  const where=channel
    ? (channel.kind==="dm" ? `@${chatChannelLabel(channel)} 대화` : `${channel.kind==="private"?"🔒":"#"}${channel.name}`)
    : "";
  const muteBlock=channel
    ? `<div class="chat-browse-section">이 대화</div>`+
      `<label class="chat-member-pick chat-notify-row"><input type="checkbox" data-notify-mute${isChatChannelMuted(channel.id)?" checked":""}>`+
      `${escapeHtml(where)} 음소거</label>`+
      `<div class="chat-side-empty">음소거하면 나를 부른 글만 알리고, 안 읽은 수를 탭 제목에서 뺀다.</div>`
    : "";

  $("chatSideList").innerHTML=
    `<div class="chat-browse-section">알림 받을 메시지</div><div class="chat-notify-group">${levels}</div>`+
    `<div class="chat-browse-section">알리는 방법</div>`+
    `<label class="chat-member-pick chat-notify-row"><input type="checkbox" data-notify-sound${s.sound?" checked":""}>알림음</label>`+
    `<div class="chat-notify-row chat-notify-desktop"><span>데스크톱 알림 (이 브라우저)</span>`+
    `<button type="button" class="btn${desktopOn?"":" primary"} chat-browse-btn" data-notify-desktop>${desktopOn?"끄기":"켜기"}</button></div>`+
    `<div class="chat-side-empty">대시보드를 보고 있으면 화면 오른쪽 아래에 팝업으로, 다른 창을 보고 있으면 데스크톱 알림으로 알려줘.`+
    `${desktopBlocked ? " 지금은 브라우저가 알림을 막고 있어서, 주소창 왼쪽 자물쇠 → 알림 → 허용으로 바꿔야 해." : ""}</div>`+
    muteBlock+
    `<div class="chat-side-empty">알림 범위와 음소거는 계정에 저장돼서 어느 PC 에서든 같아.</div>`+
    `<div class="chat-notify-test"><button type="button" class="btn chat-browse-btn" data-notify-test>알림 미리보기</button></div>`;
}

$("chatNotifyBtn").addEventListener("click",()=>{
  if(isChatSideOpen("notify")) closeChatSide();
  else openChatNotifyPanel();
});

$("chatSideList").addEventListener("change",e=>{
  if(!isChatSideOpen("notify")) return;
  if(e.target.name==="chatNotifyLevel") saveChatNotifySettings({level:e.target.value});
  else if(e.target.matches("[data-notify-sound]")) saveChatNotifySettings({sound:e.target.checked});
  else if(e.target.matches("[data-notify-mute]") && chat.activeId) setChatChannelMuted(chat.activeId,e.target.checked);
  renderChatNotifyButton();
});

$("chatSideList").addEventListener("click",e=>{
  if(!isChatSideOpen("notify")) return;
  if(e.target.closest("[data-notify-desktop]")) return toggleChatDesktop();
  if(e.target.closest("[data-notify-test]")){
    const channel=chatChannel(chat.activeId);
    if(!channel) return;
    const sample={channel_id:channel.id,user_id:teamCloud.user?.id,body:"새 메시지가 오면 이렇게 알려줄게.",created_at:new Date().toISOString()};
    showChatToast(sample,"알림 미리보기",sample.body);
    chatSoundAt=0;
    playChatSound();
  }
});

renderChatNotifyButton();
