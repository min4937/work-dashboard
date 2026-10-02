/* ============================================================================
   팀 채팅 · @멘션 자동완성

   입력칸에서 '@' 뒤에 글자를 치면 팀원 목록이 뜬다. ↑↓ 로 고르고 Enter/Tab 으로
   넣는다. 넣은 '@이름' 은 그리기 쪽(chat.js chatHighlightMentions)이 강조하고,
   나를 부른 메시지는 노란 바탕으로 보인다.

   보내기 Enter 보다 먼저 받아야 하므로 keydown 을 캡처 단계에 건다.
   ============================================================================ */

const CHAT_MENTION_MAX=6;

const chatMention={input:null,start:-1,items:[],index:0,box:null};

function attachChatMention(input){
  if(!input) return;
  input.addEventListener("input",()=>updateChatMention(input));
  input.addEventListener("click",()=>updateChatMention(input));
  input.addEventListener("keydown",e=>onChatMentionKey(e,input),true);
  input.addEventListener("blur",()=>setTimeout(closeChatMention,150));
}

/* 커서 바로 앞이 '@글자' 면 후보를 띄운다. 이메일처럼 앞에 글자가 붙은 @ 는 무시한다. */
function updateChatMention(input){
  const caret=input.selectionStart;
  const match=input.value.slice(0,caret).match(/(^|\s)@([^\s@]{0,20})$/);
  if(!match){
    closeChatMention();
    return;
  }

  const query=match[2].toLowerCase();
  const me=teamCloud.user?.id;
  const items=sortTeamMembers(teamCloud.members)
    .filter(m=>m.user_id!==me && m.display_name && m.display_name.toLowerCase().includes(query))
    .slice(0,CHAT_MENTION_MAX);
  if(!items.length){
    closeChatMention();
    return;
  }

  const sameQuery=chatMention.input===input && chatMention.start===caret-match[2].length-1;
  chatMention.input=input;
  chatMention.start=caret-match[2].length-1;
  chatMention.items=items;
  chatMention.index=sameQuery ? Math.min(chatMention.index,items.length-1) : 0;
  renderChatMention();
}

function renderChatMention(){
  if(!chatMention.box){
    const box=document.createElement("div");
    box.className="chat-mention-box";
    // mousedown 에서 처리해야 입력칸 blur 보다 먼저 잡힌다
    box.addEventListener("mousedown",e=>{
      const btn=e.target.closest("[data-mention-idx]");
      if(!btn) return;
      e.preventDefault();
      chatMention.index=Number(btn.dataset.mentionIdx);
      applyChatMention();
    });
    chatMention.box=box;
  }

  const host=chatMention.input.closest(".chat-composer");
  if(chatMention.box.parentNode!==host) host.appendChild(chatMention.box);

  chatMention.box.innerHTML=chatMention.items.map((m,i)=>
    `<button type="button" data-mention-idx="${i}" class="${i===chatMention.index?"active":""}">`+
    `${chatMemberStatusDot(m.user_id)}<b>${escapeHtml(m.display_name)}</b>`+
    `<span>${escapeHtml(m.job_title||"")}</span></button>`
  ).join("");
  chatMention.box.hidden=false;
}

function closeChatMention(){
  if(chatMention.box) chatMention.box.hidden=true;
  chatMention.items=[];
}

function onChatMentionKey(e,input){
  if(!chatMention.items.length || chatMention.input!==input || chatMention.box?.hidden) return;

  if(e.key==="ArrowDown" || e.key==="ArrowUp"){
    const step=e.key==="ArrowDown" ? 1 : -1;
    const n=chatMention.items.length;
    chatMention.index=(chatMention.index+step+n)%n;
    renderChatMention();
  }else if((e.key==="Enter" || e.key==="Tab") && !e.isComposing && e.keyCode!==229){
    applyChatMention();
  }else if(e.key==="Escape"){
    closeChatMention();
  }else{
    return;
  }
  // 보내기·고치기 등 입력칸의 다른 키 처리로 넘어가지 않게 막는다
  e.preventDefault();
  e.stopImmediatePropagation();
}

function applyChatMention(){
  const member=chatMention.items[chatMention.index];
  const input=chatMention.input;
  if(!member || !input) return;

  const caret=input.selectionStart;
  const text=`@${member.display_name} `;
  input.value=input.value.slice(0,chatMention.start)+text+input.value.slice(caret);
  const pos=chatMention.start+text.length;
  input.focus();
  input.setSelectionRange(pos,pos);
  closeChatMention();
  input.dispatchEvent(new Event("input"));   // 높이 맞추기
}

attachChatMention($("chatInput"));
attachChatMention($("chatThreadInput"));
