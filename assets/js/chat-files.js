/* ============================================================================
   팀 채팅 · 파일 첨부

   📎 버튼 · 끌어다 놓기 · 붙여넣기(캡처 이미지)로 고른 파일을 그 자리에서 바로
   Storage 'chat-files' 버킷에 올린다. 보낼 때는 올라간 파일의 경로·이름만
   메시지(attachments)에 실린다. 파일 자체는 비공개라 볼 때마다 서명 URL 을 받는다.

   경로  <팀 id>/<채널 id>/<무작위 id>.<확장자>
         → Storage RLS 가 이 경로로 '그 채널을 볼 수 있는 사람'만 통과시킨다.
         원래 파일 이름은 경로에 넣지 않는다 (한글·특수문자 키 오류를 피하려고).
   ============================================================================ */

const CHAT_FILE_BUCKET="chat-files";
const CHAT_FILE_MAX_BYTES=20*1024*1024;
const CHAT_FILE_MAX_COUNT=10;
const CHAT_FILE_URL_SECONDS=3600;
const CHAT_IMAGE_TYPE=/^image\/(png|jpe?g|gif|webp)$/i;

const chatFiles={
  drafts:{main:[],thread:[]},   // 보내기 전 첨부 {key,name,size,type,path,status}
  urls:new Map(),               // 경로 → {url,expires} (실패한 것은 url:null 로 잠깐 기억)
  queue:new Set(),
  queueTimer:null
};

function chatComposerChannel(target){
  return target==="thread" ? chatThread.channelId : chat.activeId;
}

function formatChatFileSize(bytes){
  const n=Number(bytes||0);
  if(n<1024) return `${n}B`;
  if(n<1024*1024) return `${Math.round(n/1024)}KB`;
  return `${(n/1024/1024).toFixed(1)}MB`;
}

function setChatComposerNotice(target,text,isError){
  if(target==="thread") setChatThreadNotice(text,isError);
  else setChatNotice(text,isError);
}


/* ------------------------------------------------------------- 올리기 · 보내기 전 */

async function addChatFiles(target,fileList){
  const channelId=chatComposerChannel(target);
  if(!channelId || !chat.teamId) return;
  const drafts=chatFiles.drafts[target];

  const jobs=[];
  for(const file of fileList){
    if(drafts.length>=CHAT_FILE_MAX_COUNT){
      setChatComposerNotice(target,`첨부는 한 번에 ${CHAT_FILE_MAX_COUNT}개까지야.`,true);
      break;
    }
    if(file.size>CHAT_FILE_MAX_BYTES){
      setChatComposerNotice(target,`${file.name} 은(는) 20MB 를 넘어서 올릴 수 없어.`,true);
      continue;
    }
    const ext=(String(file.name).match(/\.([A-Za-z0-9]{1,8})$/)?.[1]||"bin").toLowerCase();
    const draft={
      key:newClientId(),
      name:file.name||"파일",
      size:file.size,
      type:file.type||"",
      path:`${chat.teamId}/${channelId}/${newClientId()}.${ext}`,
      status:"uploading"
    };
    drafts.push(draft);
    jobs.push(uploadChatDraft(target,draft,file));
  }
  renderChatDrafts(target);
  await Promise.all(jobs);
}

async function uploadChatDraft(target,draft,file){
  const {error}=await teamCloud.client.storage
    .from(CHAT_FILE_BUCKET)
    .upload(draft.path,file,{upsert:false,contentType:draft.type||"application/octet-stream"});
  if(error){
    console.error(error);
    draft.status="error";
    setChatComposerNotice(target,`${draft.name} 을(를) 올리지 못했어.`,true);
  }else{
    draft.status="done";
  }
  renderChatDrafts(target);
}

/* 보낼 때 부른다. 아직 올라가는 중이거나 실패한 게 있으면 보내지 않는다. */
function takeChatDrafts(target){
  const drafts=chatFiles.drafts[target];
  if(drafts.some(d=>d.status==="uploading")){
    setChatComposerNotice(target,"파일을 올리는 중이야. 끝나면 보내줘.",true);
    return null;
  }
  if(drafts.some(d=>d.status==="error")){
    setChatComposerNotice(target,"올리지 못한 파일을 × 로 빼고 다시 보내줘.",true);
    return null;
  }
  const files=drafts.map(d=>({path:d.path,name:d.name,size:d.size,type:d.type}));
  chatFiles.drafts[target]=[];
  renderChatDrafts(target);
  return files;
}

function clearChatDrafts(target){
  chatFiles.drafts[target]=[];
  renderChatDrafts(target);
}

function removeChatDraft(target,key){
  chatFiles.drafts[target]=chatFiles.drafts[target].filter(d=>d.key!==key);
  renderChatDrafts(target);
}

function renderChatDrafts(target){
  const box=$(target==="thread" ? "chatThreadDrafts" : "chatDrafts");
  if(!box) return;
  const drafts=chatFiles.drafts[target];
  box.hidden=!drafts.length;
  box.innerHTML=drafts.map(d=>{
    const state=d.status==="uploading" ? "올리는 중…" : d.status==="error" ? "실패" : formatChatFileSize(d.size);
    return `<span class="chat-draft ${d.status}">📎 <b>${escapeHtml(d.name)}</b><small>${state}</small>`+
      `<button type="button" data-draft-remove="${d.key}" data-draft-target="${target}" title="빼기">×</button></span>`;
  }).join("");
}


/* ------------------------------------------------------------------- 보여주기 */

/* 서명 URL 이 있으면 돌려주고, 없으면 모아서 한 번에 받아온 뒤 다시 그린다. */
function chatFileUrl(path){
  const hit=chatFiles.urls.get(path);
  if(hit && hit.expires>Date.now()+60000) return hit.url;
  if(!chatFiles.queue.has(path)){
    chatFiles.queue.add(path);
    clearTimeout(chatFiles.queueTimer);
    chatFiles.queueTimer=setTimeout(flushChatFileUrls,30);
  }
  return null;
}

async function flushChatFileUrls(){
  const paths=[...chatFiles.queue];
  if(!paths.length || !teamCloud.client) return;
  const {data,error}=await teamCloud.client.storage
    .from(CHAT_FILE_BUCKET)
    .createSignedUrls(paths,CHAT_FILE_URL_SECONDS);
  paths.forEach(p=>chatFiles.queue.delete(p));

  const now=Date.now();
  const byPath=new Map((data||[]).map(d=>[d.path,d]));
  paths.forEach(p=>{
    const url=byPath.get(p)?.signedUrl||null;
    // 실패한 것은 5분 동안 다시 묻지 않는다 (다시 그릴 때마다 요청이 돌지 않게)
    chatFiles.urls.set(p,{url,expires:url ? now+CHAT_FILE_URL_SECONDS*1000 : now+5*60000});
  });
  if(error) console.error(error);
  rerenderChatViews();
}

function chatAttachmentsHtml(m){
  const files=Array.isArray(m.attachments) ? m.attachments : [];
  if(!files.length || m.deleted_at) return "";

  const html=files.map(f=>{
    const name=escapeHtml(f.name||"파일");
    if(CHAT_IMAGE_TYPE.test(f.type||"") && !m.pending){
      const url=chatFileUrl(f.path);
      return url
        ? `<a class="chat-image" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${name}">`+
          `<img src="${escapeHtml(url)}" alt="${name}" loading="lazy"></a>`
        : `<span class="chat-image loading">${name}</span>`;
    }
    return `<button type="button" class="chat-file" data-file-path="${escapeHtml(f.path)}" data-file-name="${name}">`+
      `<span class="chat-file-icon">📄</span><span class="chat-file-name">${name}</span>`+
      `<small>${formatChatFileSize(f.size)}</small></button>`;
  }).join("");
  return `<div class="chat-files">${html}</div>`;
}

/* 내려받기는 공유 문서 탭과 같이 blob 으로 받아 원래 이름으로 저장한다. */
async function downloadChatFile(path,name){
  const {data:blob,error}=await teamCloud.client.storage.from(CHAT_FILE_BUCKET).download(path);
  if(error){
    console.error(error);
    setChatNotice("파일을 내려받지 못했어.",true);
    return;
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=name||"파일";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}


/* ------------------------------------------------------------------- 이벤트 */

function wireChatFileInput(target,buttonId,inputId,textareaId,dropAreaSelector){
  const input=$(inputId);
  $(buttonId).addEventListener("click",()=>input.click());
  input.addEventListener("change",()=>{
    if(input.files?.length) addChatFiles(target,[...input.files]);
    input.value="";
  });

  // 캡처한 이미지를 붙여넣으면 바로 첨부한다 (글자 붙여넣기는 그대로 둔다)
  $(textareaId).addEventListener("paste",e=>{
    const files=[...(e.clipboardData?.files||[])];
    if(!files.length) return;
    e.preventDefault();
    addChatFiles(target,files);
  });

  const area=document.querySelector(dropAreaSelector);
  area.addEventListener("dragover",e=>{
    if(![...(e.dataTransfer?.types||[])].includes("Files")) return;
    e.preventDefault();
    area.classList.add("dragging");
  });
  area.addEventListener("dragleave",e=>{
    if(!area.contains(e.relatedTarget)) area.classList.remove("dragging");
  });
  area.addEventListener("drop",e=>{
    area.classList.remove("dragging");
    const files=[...(e.dataTransfer?.files||[])];
    if(!files.length) return;
    e.preventDefault();
    addChatFiles(target,files);
  });
}

wireChatFileInput("main","chatAttachBtn","chatFileInput","chatInput",".chat-main");
wireChatFileInput("thread","chatThreadAttachBtn","chatThreadFileInput","chatThreadInput",".chat-thread");

document.querySelector(".chat-layout").addEventListener("click",e=>{
  const remove=e.target.closest("[data-draft-remove]");
  if(remove) return removeChatDraft(remove.dataset.draftTarget,remove.dataset.draftRemove);
  const file=e.target.closest("[data-file-path]");
  if(file) downloadChatFile(file.dataset.filePath,file.dataset.fileName);
});
