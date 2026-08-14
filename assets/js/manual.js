/* ============================================================================
   메뉴얼 및 서식 (팀 공유 문서)

   업로드는 팀원 누구나 할 수 있고, 삭제는 올린 사람만 할 수 있다.
   팀장이라도 남이 올린 파일은 지우거나 고칠 수 없다.

   저장 경로는 <team_id>/<user_id>/<파일명> 이고, Storage 정책이 이 경로로
   팀과 소유자를 판정한다.
   ============================================================================ */

/* 올릴 수 있는 파일 형식. index.html 의 안내문·accept 속성과 같이 관리한다. */
const ALLOWED_FILE_EXTENSIONS=[
  "pdf","hwp","hwpx","doc","docx","xls","xlsx","ppt","pptx","txt","csv",
  "jpg","jpeg","png","gif","webp","heic",
  "dwg","dxf",
  "zip","7z","rar"
];
const MAX_FILE_SIZE=50*1024*1024;

function fileExtension(name){
  const parts=String(name||"").split(".");
  return parts.length>1 ? parts.pop().toLowerCase() : "";
}

function formatFileSize(bytes){
  const n=Number(bytes||0);
  if(n<1024) return `${n} B`;
  if(n<1048576) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1048576).toFixed(1)} MB`;
}

function setManualMessage(t,e=false){
  const x=$("manualUploadMessage");
  if(x){ x.textContent=t||""; x.style.color=e?"var(--red)":"var(--muted)"; }
}

async function renderManualPage(){
  if(!teamCloud.user||!teamCloud.teamId){
    $("manualLoginNotice").style.display="block";
    $("manualLoginNotice").textContent=teamCloud.user
      ? "팀에 참여하면 공유 파일을 쓸 수 있어."
      : "로그인 후 공유 파일을 볼 수 있어.";
    $("manualUploadArea").style.display="none";
    $("manualFileList").innerHTML='<div class="empty">팀에 참여하면 공유 파일이 보여.</div>';
    return;
  }
  $("manualLoginNotice").style.display="none";
  $("manualUploadArea").style.display="block";
  await loadManualFiles();
}

async function loadManualFiles(){
  if(!teamCloud.user||!teamCloud.teamId) return;

  const [{data:f,error:fe},{data:m,error:me}]=await Promise.all([
    teamCloud.client.from("team_files")
      .select("id,uploader_id,file_name,storage_path,file_size,mime_type,category,note,created_at")
      .order("created_at",{ascending:false}),
    teamCloud.client.from("profiles").select("user_id,display_name")
  ]);

  if(fe||me){
    console.error(fe||me);
    $("manualFileList").innerHTML='<div class="empty">공유 파일을 불러오지 못했어.</div>';
    return;
  }

  teamCloud.teamFiles=f||[];
  const names=new Map((m||[]).map(x=>[x.user_id,x.display_name]));
  const list=$("manualFileList");
  list.innerHTML="";

  if(!f?.length){
    list.innerHTML='<div class="empty">아직 공유된 파일이 없어.</div>';
    return;
  }

  f.forEach(x=>{
    // 삭제는 올린 사람만
    const canDelete=x.uploader_id===teamCloud.user.id;
    const d=document.createElement("div");
    d.className="file-item";
    d.innerHTML=
      `<div><div class="file-name">${escapeHtml(x.file_name)}</div>`+
      `<div class="file-meta">${escapeHtml(x.note||"설명 없음")}</div></div>`+
      `<span class="file-category">${escapeHtml(x.category||"기타")}</span>`+
      `<div class="file-meta">${escapeHtml(names.get(x.uploader_id)||"팀원")}</div>`+
      `<div class="file-meta">${formatFileSize(x.file_size)}<br>${new Date(x.created_at).toLocaleDateString("ko-KR")}</div>`+
      `<div class="file-actions"><button class="mini-btn" data-download="${x.id}">다운로드</button>`+
      `${canDelete?`<button class="mini-btn danger" data-delete="${x.id}">삭제</button>`:""}</div>`;
    list.appendChild(d);
  });

  list.querySelectorAll("[data-download]").forEach(b=>
    b.addEventListener("click",()=>downloadManualFile(Number(b.dataset.download))));
  list.querySelectorAll("[data-delete]").forEach(b=>
    b.addEventListener("click",()=>deleteManualFile(Number(b.dataset.delete))));
}

async function uploadManualFile(){
  if(!teamCloud.user||!teamCloud.teamId) return;

  const input=$("manualFileInput");
  const file=input.files?.[0];
  if(!file){ setManualMessage("파일을 선택해줘.",true); return; }
  if(file.size>MAX_FILE_SIZE){ setManualMessage("파일은 50MB 이하로 올려줘.",true); return; }

  const ext=fileExtension(file.name);
  if(!ALLOWED_FILE_EXTENSIONS.includes(ext)){
    setManualMessage(
      `.${ext||"확장자 없음"} 은 올릴 수 없어. 지원 형식: ${ALLOWED_FILE_EXTENSIONS.join(", ")}`,
      true
    );
    return;
  }

  const btn=$("uploadManualFile");
  btn.disabled=true;
  btn.textContent="업로드 중...";

  const safe=file.name.replace(/[^\w.\-가-힣() ]+/g,"_");
  const rnd=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);
  const path=`${teamCloud.teamId}/${teamCloud.user.id}/${Date.now()}-${rnd}-${safe}`;

  const {error:ue}=await teamCloud.client.storage
    .from("team-documents")
    .upload(path,file,{upsert:false,contentType:file.type||"application/octet-stream"});

  if(ue){
    console.error(ue);
    setManualMessage("업로드에 실패했어.",true);
    btn.disabled=false;
    btn.textContent="파일 업로드";
    return;
  }

  const {error:me}=await teamCloud.client.from("team_files").insert({
    uploader_id:teamCloud.user.id,
    file_name:file.name,
    storage_path:path,
    file_size:file.size,
    mime_type:file.type||"",
    category:$("manualFileCategory").value||"기타",
    note:$("manualFileNote").value.trim()
  });

  if(me){
    // 메타데이터 저장에 실패하면 올라간 파일도 되돌린다
    await teamCloud.client.storage.from("team-documents").remove([path]);
    setManualMessage("파일 정보 저장에 실패했어.",true);
  }else{
    input.value="";
    $("manualFileNote").value="";
    setManualMessage(`${file.name} 업로드 완료!`);
    await loadManualFiles();
  }

  btn.disabled=false;
  btn.textContent="파일 업로드";
}

async function downloadManualFile(id){
  const f=teamCloud.teamFiles.find(x=>x.id===id);
  if(!f) return;
  const {data:blob,error}=await teamCloud.client.storage
    .from("team-documents").download(f.storage_path);
  if(error){ alert("다운로드 실패"); return; }
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=f.file_name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function deleteManualFile(id){
  const f=teamCloud.teamFiles.find(x=>x.id===id);
  if(!f) return;
  if(f.uploader_id!==teamCloud.user.id){
    alert("내가 올린 파일만 삭제할 수 있어.");
    return;
  }
  if(!confirm(`${f.file_name} 파일을 삭제할까?`)) return;

  const {error}=await teamCloud.client.storage
    .from("team-documents").remove([f.storage_path]);
  if(error){ alert("파일 삭제 실패"); return; }

  await teamCloud.client.from("team_files").delete().eq("id",id);
  await loadManualFiles();
}
