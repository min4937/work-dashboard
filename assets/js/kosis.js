/* ============================================================================
   통계자료 (KOSIS 국가통계포털)

   보고서 양식은 그대로 두고 지역·최신값만 갈아끼우는 작업을 줄이기 위한 탭.

   설계 원칙
   - 기간을 화면에서 고르지 않는다. 항상 '최신 공표 시점'을 받는다(newEstPrdCnt).
     그래야 해마다 연도를 손으로 고치는 일이 없어진다.
   - 기준시점·출처는 사람이 옮겨 적지 않고 API 응답값을 그대로 문장에 박는다.
     이 부분이 수작업에서 가장 자주 틀리는 자리다.
   - 값이 없으면 빈칸이 아니라 '-' 로 찍고 경고를 띄운다. 조용히 비면 위험하다.

   KOSIS 는 CORS 헤더를 주지 않으므로 브라우저에서 직접 부를 수 없다.
   supabase/functions/kosis-proxy 를 거친다. 인증키도 그쪽 시크릿에 있다.
   ============================================================================ */

/* 시도 코드. 통계표마다 2자리(stat2)와 8자리(admin8) 체계가 갈려서 둘 다 들고 있다.
   어느 쪽인지는 지표 관리의 '연결 시험'으로 확인한다. */
const KOSIS_REGIONS=[
  {name:"전국",          stat2:"00", admin8:"00000000"},
  {name:"서울특별시",     stat2:"11", admin8:"11000000"},
  {name:"부산광역시",     stat2:"21", admin8:"26000000"},
  {name:"대구광역시",     stat2:"22", admin8:"27000000"},
  {name:"인천광역시",     stat2:"23", admin8:"28000000"},
  {name:"광주광역시",     stat2:"24", admin8:"29000000"},
  {name:"대전광역시",     stat2:"25", admin8:"30000000"},
  {name:"울산광역시",     stat2:"26", admin8:"31000000"},
  {name:"세종특별자치시", stat2:"29", admin8:"36110000"},
  {name:"경기도",        stat2:"31", admin8:"41000000"},
  {name:"강원특별자치도", stat2:"32", admin8:"51000000"},
  {name:"충청북도",       stat2:"33", admin8:"43000000"},
  {name:"충청남도",       stat2:"34", admin8:"44000000"},
  {name:"전북특별자치도", stat2:"35", admin8:"52000000"},
  {name:"전라남도",       stat2:"36", admin8:"46000000"},
  {name:"경상북도",       stat2:"37", admin8:"47000000"},
  {name:"경상남도",       stat2:"38", admin8:"48000000"},
  {name:"제주특별자치도", stat2:"39", admin8:"50000000"}
];

const KOSIS_STORE_KEY="myCompanyDashboard_lastStatsRegion";

let kosisCatalog=[];    // 등록된 지표 목록
let kosisResults=[];    // 마지막 조회 결과

function setStatsMessage(t,e=false){
  const x=$("statsMessage");
  if(x){ x.textContent=t||""; x.style.color=e?"var(--red)":"var(--muted)"; }
}
function setStatsAdminMessage(t,e=false){
  const x=$("statsAdminMessage");
  if(x){ x.textContent=t||""; x.style.color=e?"var(--red)":"var(--muted)"; }
}

function kosisRegion(name){
  return KOSIS_REGIONS.find(r=>r.name===name)||KOSIS_REGIONS[0];
}

/* 소수점 자리수를 지켜 천단위 구분 */
function kosisFormatNumber(v,digits){
  if(v===null||v===undefined) return "-";
  return Number(v).toLocaleString("ko-KR",{minimumFractionDigits:digits,maximumFractionDigits:digits});
}

function kosisDeltaText(pct){
  if(pct===null||pct===undefined) return "-";
  if(Math.abs(pct)<0.05) return "전기와 비슷한 수준";
  return `${Math.abs(pct).toFixed(1)}% ${pct>0?"증가":"감소"}`;
}

function kosisSourceText(r){
  return ["KOSIS 국가통계포털",r.orgName,r.tableName].filter(Boolean).join(", ");
}

/* 앞 글자의 받침 유무로 조사를 고른다.
   지표 이름이 바뀔 때마다 '미분양주택는' 같은 오류가 나면 그대로 결재가 올라가므로
   문장 틀에서 {은는}·{이가} 같은 자리표시자를 쓰게 하고 여기서 정리한다. */
const KOSIS_PARTICLES={"은는":["은","는"],"이가":["이","가"],"을를":["을","를"],"와과":["과","와"],"으로로":["으로","로"]};

function kosisFixParticles(text){
  return String(text).replace(/(.)\{(은는|이가|을를|와과|으로로)\}/g,(m,prev,kind)=>{
    const [withBatchim,withoutBatchim]=KOSIS_PARTICLES[kind];
    const code=prev.charCodeAt(0);
    // 한글 음절이 아니면(숫자·영문 등) 판단이 어려우니 받침 없는 쪽으로 둔다
    if(code<0xac00||code>0xd7a3) return prev+withoutBatchim;
    const batchim=(code-0xac00)%28;
    // 'ㄹ' 받침은 '로/으로' 에서만 예외적으로 받침 없는 쪽을 쓴다
    if(kind==="으로로") return prev+(batchim===0||batchim===8?withoutBatchim:withBatchim);
    return prev+(batchim!==0?withBatchim:withoutBatchim);
  });
}

/* 문장 틀의 자리표시자를 실제 값으로 바꾼다 */
function kosisBuildSentence(spec,r,regionName){
  const value=r.missing?"-":kosisFormatNumber(r.value,spec.digits);
  const unit=spec.unit||r.unit||"";
  const text=String(spec.sentence||"")
    .replaceAll("{지역}",regionName)
    .replaceAll("{지표}",spec.label)
    .replaceAll("{값}",value)
    .replaceAll("{단위}",unit)
    .replaceAll("{시점}",r.periodText||"")
    .replaceAll("{증감}",kosisDeltaText(r.deltaPct))
    .replaceAll("{출처}",kosisSourceText(r));
  return kosisFixParticles(text);
}


/* ------------------------------------------------------------------ 페이지 */

async function renderStatsPage(){
  const sel=$("statsRegion");
  if(sel && !sel.options.length){
    KOSIS_REGIONS.forEach(r=>{
      const o=document.createElement("option");
      o.value=r.name; o.textContent=r.name;
      sel.appendChild(o);
    });
    sel.value=localStorage.getItem(KOSIS_STORE_KEY)||"충청북도";
  }

  if(!teamCloud.user||!teamCloud.teamId){
    $("statsLoginNotice").style.display="block";
    $("statsLoginNotice").textContent=teamCloud.user
      ? "팀에 참여하면 통계자료를 쓸 수 있어."
      : "로그인 후 통계자료를 쓸 수 있어.";
    $("statsMain").style.display="none";
    $("statsAdminPanel").style.display="none";
    return;
  }

  $("statsLoginNotice").style.display="none";
  $("statsMain").style.display="block";
  $("statsAdminPanel").style.display="block";
  await loadKosisCatalog();
}

async function loadKosisCatalog(){
  const {data,error}=await teamCloud.client.from("kosis_indicators")
    .select("id,key,label,org_id,tbl_id,itm_id,prd_se,periods,region_param,region_scheme,extra_params,unit,digits,sentence,sort_order,verified,created_by")
    .order("sort_order",{ascending:true}).order("id",{ascending:true});

  if(error){
    console.error(error);
    $("statsCatalog").innerHTML='<div class="empty">지표 목록을 불러오지 못했어. SQL 패치를 적용했는지 확인해줘.</div>';
    return;
  }

  kosisCatalog=(data||[]).map(x=>({
    id:x.id, key:x.key, label:x.label,
    orgId:x.org_id, tblId:x.tbl_id, itmId:x.itm_id||"",
    prdSe:x.prd_se, periods:x.periods||2,
    regionParam:x.region_param||"objL1", regionScheme:x.region_scheme||"stat2",
    extraParams:x.extra_params||{}, unit:x.unit||"", digits:x.digits||0,
    sentence:x.sentence||"", verified:x.verified, createdBy:x.created_by
  }));

  renderKosisCatalog();
}

function renderKosisCatalog(){
  const box=$("statsCatalog");
  if(!box) return;
  if(!kosisCatalog.length){
    box.innerHTML='<div class="empty">아직 등록된 지표가 없어. 위에서 통계표를 찾아 등록해줘.</div>';
    return;
  }
  box.innerHTML="";
  kosisCatalog.forEach(s=>{
    const canDelete=s.createdBy===teamCloud.user.id||teamCloud.isLeader;
    const d=document.createElement("div");
    d.className="stats-catalog-item";
    d.innerHTML=
      `<div><div class="file-name">${escapeHtml(s.label)} <span class="file-meta">{{${escapeHtml(s.key)}}}</span></div>`+
      `<div class="file-meta">${escapeHtml(s.orgId)} / ${escapeHtml(s.tblId)}${s.itmId?` / ${escapeHtml(s.itmId)}`:""} · ${escapeHtml(s.prdSe)} · ${escapeHtml(s.regionScheme)}</div></div>`+
      `<div class="file-meta">${s.verified?"확인됨":"미확인"}</div>`+
      `<div class="file-actions">${canDelete?`<button class="mini-btn danger" data-kosis-del="${s.id}">삭제</button>`:""}</div>`;
    box.appendChild(d);
  });
  box.querySelectorAll("[data-kosis-del]").forEach(b=>
    b.addEventListener("click",()=>deleteKosisIndicator(Number(b.dataset.kosisDel))));
}


/* ------------------------------------------------------------------ 조회 */

async function fetchKosisAll(){
  if(!teamCloud.user||!teamCloud.teamId) return;
  if(!kosisCatalog.length){ setStatsMessage("등록된 지표가 없어. 지표 관리에서 먼저 추가해줘.",true); return; }

  const regionName=$("statsRegion").value;
  localStorage.setItem(KOSIS_STORE_KEY,regionName);
  const region=kosisRegion(regionName);

  const btn=$("statsFetch");
  btn.disabled=true; btn.textContent="조회 중...";
  setStatsMessage(`${regionName} 최신자료를 불러오는 중...`);

  // 지표별로 프록시를 부른다. 한 건이 실패해도 나머지는 살린다.
  const settled=await Promise.all(kosisCatalog.map(async spec=>{
    try{
      const {data,error}=await teamCloud.client.functions.invoke("kosis-proxy",{
        body:{
          action:"indicator",
          orgId:spec.orgId, tblId:spec.tblId, itmId:spec.itmId,
          prdSe:spec.prdSe, periods:Math.max(2,spec.periods),
          regionParam:spec.regionParam,
          regionCode:region[spec.regionScheme]||region.stat2,
          extraParams:spec.extraParams
        }
      });
      if(error) throw new Error(error.message||"호출 실패");
      if(data?.error) throw new Error(data.error);
      return {spec,result:data,error:null};
    }catch(err){
      console.error(spec.key,err);
      return {spec,result:null,error:err.message||String(err)};
    }
  }));

  kosisResults=settled.map(x=>({...x,regionName}));
  renderKosisResults();

  const failed=settled.filter(x=>x.error).length;
  const missing=settled.filter(x=>!x.error&&x.result?.missing).length;
  const parts=[`${regionName} · 지표 ${settled.length}건 조회 완료`];
  if(missing) parts.push(`${missing}건은 해당 지역 공표값이 없어 '-' 로 표시했어`);
  if(failed) parts.push(`${failed}건은 조회에 실패했어`);
  setStatsMessage(parts.join(" · "),failed>0);

  btn.disabled=false; btn.textContent="최신자료 조회";
}

function renderKosisResults(){
  const box=$("statsResult");
  if(!box) return;
  if(!kosisResults.length){ box.innerHTML='<div class="empty">시도를 고르고 조회를 눌러줘.</div>'; return; }

  box.innerHTML="";
  kosisResults.forEach((row,i)=>{
    const {spec,result,error,regionName}=row;
    const d=document.createElement("div");
    d.className="stats-item";

    if(error){
      d.innerHTML=
        `<div class="stats-item-head"><strong>${escapeHtml(spec.label)}</strong>`+
        `<span class="stats-badge warn">조회 실패</span></div>`+
        `<div class="file-meta">${escapeHtml(error)}</div>`;
      box.appendChild(d);
      return;
    }

    const unit=spec.unit||result.unit||"";
    const sentence=kosisBuildSentence(spec,result,regionName);
    const missing=result.missing;

    // 값이 없으면 문장을 내주지 않는다. 그대로 복사돼 결재로 올라가는 게 제일 위험하다.
    d.innerHTML=
      `<div class="stats-item-head"><strong>${escapeHtml(spec.label)}</strong>`+
      `<span class="stats-badge${missing?" warn":""}">${missing?"공표값 없음":escapeHtml(result.periodText)+" 기준"}</span></div>`+
      `<div class="stats-value">${missing?"-":escapeHtml(kosisFormatNumber(result.value,spec.digits))}`+
      `<span class="stats-unit">${escapeHtml(unit)}</span>`+
      (missing?"":`<span class="stats-delta">${escapeHtml(kosisDeltaText(result.deltaPct))}</span>`)+
      `</div>`+
      (missing
        ? `<div class="stats-sentence warn">${escapeHtml(spec.label)}는 이 지역에 공표된 값이 없어. 다른 자료로 채우거나 지표 설정을 다시 확인해줘.</div>`
        : `<div class="stats-sentence" id="statsSentence${i}">${escapeHtml(sentence)}</div>`)+
      `<div class="file-meta">자료: ${escapeHtml(kosisSourceText(result))}</div>`+
      (missing?"":`<div class="file-actions"><button class="mini-btn" data-kosis-copy="${i}">이 문장 복사</button></div>`);
    box.appendChild(d);
  });

  box.querySelectorAll("[data-kosis-copy]").forEach(b=>
    b.addEventListener("click",()=>{
      const row=kosisResults[Number(b.dataset.kosisCopy)];
      if(!row?.result) return;
      copyKosisText(kosisBuildSentence(row.spec,row.result,row.regionName),b);
    }));
}

async function copyKosisText(text,btn){
  try{
    await navigator.clipboard.writeText(text);
    if(btn){ const old=btn.textContent; btn.textContent="복사됨!"; setTimeout(()=>btn.textContent=old,1200); }
  }catch{
    setStatsMessage("클립보드 복사에 실패했어. 문장을 직접 긁어서 복사해줘.",true);
  }
}

function copyKosisAll(){
  if(!kosisResults.length){ setStatsMessage("먼저 조회를 눌러줘.",true); return; }
  // 공표값이 없는 지표는 문장을 만들지 않는다
  const usable=kosisResults.filter(r=>r.result&&!r.result.missing);
  const skipped=kosisResults.length-usable.length;
  if(!usable.length){ setStatsMessage("복사할 문장이 없어. 조회에 성공한 지표가 없어.",true); return; }

  copyKosisText(usable.map(r=>kosisBuildSentence(r.spec,r.result,r.regionName)).join("\n"),$("statsCopyAll"));
  setStatsMessage(
    `문장 ${usable.length}건을 복사했어. 한글 문서에 그대로 붙여넣으면 돼.`+
    (skipped?` (값이 없는 ${skipped}건은 뺐어)`:""),skipped>0);
}

/* 로컬 .hwp 치환 스크립트가 그대로 먹을 수 있는 형태로 내려받는다 */
function exportKosisJson(){
  if(!kosisResults.length){ setStatsMessage("먼저 조회를 눌러줘.",true); return; }
  const regionName=kosisResults[0].regionName;
  const replacements={"{{지역명}}":regionName};

  kosisResults.forEach(({spec,result})=>{
    if(!result) return;
    const unit=spec.unit||result.unit||"";
    replacements[`{{${spec.key}}}`]=result.missing?"-":kosisFormatNumber(result.value,spec.digits);
    replacements[`{{${spec.key}.단위}}`]=unit;
    replacements[`{{${spec.key}.시점}}`]=result.periodText||"";
    replacements[`{{${spec.key}.증감}}`]=kosisDeltaText(result.deltaPct);
    replacements[`{{${spec.key}.출처}}`]=kosisSourceText(result);
  });

  const payload={region:regionName,generated_at:new Date().toISOString(),replacements};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=`kosis-${regionName}-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  setStatsMessage(`치환 JSON 을 내려받았어. 자리표시자 ${Object.keys(replacements).length}개가 들어 있어.`);
}


/* ------------------------------------------------------------- 지표 관리 */

async function searchKosisTables(){
  const kw=$("statsSearchKeyword").value.trim();
  if(!kw){ setStatsAdminMessage("검색어를 입력해줘.",true); return; }

  const btn=$("statsSearchBtn");
  btn.disabled=true; btn.textContent="검색 중...";
  setStatsAdminMessage("");

  const {data,error}=await teamCloud.client.functions.invoke("kosis-proxy",{
    body:{action:"search",keyword:kw}
  });

  btn.disabled=false; btn.textContent="통계표 검색";

  const box=$("statsSearchResult");
  if(error||data?.error){
    console.error(error||data.error);
    setStatsAdminMessage(`검색 실패: ${(error?.message)||data.error}`,true);
    box.innerHTML="";
    return;
  }
  const rows=data?.rows||[];
  if(!rows.length){ box.innerHTML='<div class="empty">검색 결과가 없어.</div>'; return; }

  box.innerHTML="";
  rows.slice(0,25).forEach(r=>{
    const d=document.createElement("div");
    d.className="stats-search-item";
    d.innerHTML=
      `<div><div class="file-name">${escapeHtml(r.tblName||"")}</div>`+
      `<div class="file-meta">${escapeHtml(r.orgName||"")} · ${escapeHtml(r.orgId||"")} / ${escapeHtml(r.tblId||"")}</div></div>`+
      `<button class="mini-btn" data-kosis-pick='${escapeHtml(JSON.stringify(r))}'>이 표 쓰기</button>`;
    box.appendChild(d);
  });

  box.querySelectorAll("[data-kosis-pick]").forEach(b=>
    b.addEventListener("click",()=>{
      const r=JSON.parse(b.dataset.kosisPick);
      $("statsFormOrgId").value=r.orgId||"";
      $("statsFormTblId").value=r.tblId||"";
      if(!$("statsFormLabel").value) $("statsFormLabel").value=r.tblName||"";
      if(r.prdSe&&["Y","Q","M"].includes(r.prdSe)) $("statsFormPrdSe").value=r.prdSe;
      setStatsAdminMessage("통계표를 폼에 넣었어. '연결 시험'으로 값이 나오는지 확인해줘.");
    }));
}

function readKosisForm(){
  return {
    key:$("statsFormKey").value.trim(),
    label:$("statsFormLabel").value.trim(),
    orgId:$("statsFormOrgId").value.trim(),
    tblId:$("statsFormTblId").value.trim(),
    itmId:$("statsFormItmId").value.trim(),
    prdSe:$("statsFormPrdSe").value,
    regionScheme:$("statsFormScheme").value,
    unit:$("statsFormUnit").value.trim(),
    digits:Number($("statsFormDigits").value||0),
    sentence:$("statsFormSentence").value
  };
}

/* 등록 전에 실제로 값이 나오는지 확인한다. 지역코드 체계가 틀리면 여기서 걸린다. */
async function testKosisIndicator(){
  const f=readKosisForm();
  if(!f.orgId||!f.tblId){ setStatsAdminMessage("orgId 와 tblId 는 필수야.",true); return null; }

  const region=kosisRegion($("statsRegion").value);
  const btn=$("statsTestBtn");
  btn.disabled=true; btn.textContent="시험 중...";

  const {data,error}=await teamCloud.client.functions.invoke("kosis-proxy",{
    body:{
      action:"indicator", orgId:f.orgId, tblId:f.tblId, itmId:f.itmId,
      prdSe:f.prdSe, periods:2, regionParam:"objL1",
      regionCode:region[f.regionScheme]||region.stat2
    }
  });

  btn.disabled=false; btn.textContent="연결 시험";

  if(error||data?.error){
    setStatsAdminMessage(`실패: ${(error?.message)||data.error}`,true);
    return null;
  }
  if(data.missing){
    setStatsAdminMessage(
      `${region.name} 에 공표값이 없어. 지역코드 체계(${f.regionScheme})나 수록주기를 바꿔서 다시 시험해봐.`,true);
    return data;
  }
  setStatsAdminMessage(
    `확인됨 · ${region.name} ${data.periodText} 기준 ${kosisFormatNumber(data.value,f.digits)}${f.unit||data.unit||""} (${kosisDeltaText(data.deltaPct)})`);
  return data;
}

async function saveKosisIndicator(){
  const f=readKosisForm();
  if(!f.key||!f.label||!f.orgId||!f.tblId){
    setStatsAdminMessage("키·표시 이름·orgId·tblId 는 모두 필요해.",true);
    return;
  }
  if(/[{}\s]/.test(f.key)){
    setStatsAdminMessage("키에는 공백이나 중괄호를 쓸 수 없어. 예: 총인구",true);
    return;
  }

  const btn=$("statsSaveBtn");
  btn.disabled=true; btn.textContent="등록 중...";

  const probe=await testKosisIndicator();   // 값이 나오는지 확인하고 verified 를 기록

  const {error}=await teamCloud.client.from("kosis_indicators").insert({
    team_id:teamCloud.teamId,
    key:f.key, label:f.label,
    org_id:f.orgId, tbl_id:f.tblId, itm_id:f.itmId,
    prd_se:f.prdSe, periods:2,
    region_param:"objL1", region_scheme:f.regionScheme,
    unit:f.unit, digits:f.digits, sentence:f.sentence,
    sort_order:kosisCatalog.length,
    verified:!!(probe&&!probe.missing),
    created_by:teamCloud.user.id
  });

  btn.disabled=false; btn.textContent="지표 등록";

  if(error){
    console.error(error);
    setStatsAdminMessage(
      error.code==="23505" ? "같은 키가 이미 등록돼 있어." : "지표 등록에 실패했어.",true);
    return;
  }

  $("statsFormKey").value=""; $("statsFormLabel").value="";
  $("statsFormItmId").value=""; $("statsFormUnit").value="";
  setStatsAdminMessage(`${f.label} 등록 완료!`);
  await loadKosisCatalog();
}

async function deleteKosisIndicator(id){
  const s=kosisCatalog.find(x=>x.id===id);
  if(!s) return;
  if(!confirm(`${s.label} 지표를 목록에서 지울까?`)) return;

  const {error}=await teamCloud.client.from("kosis_indicators").delete().eq("id",id);
  if(error){ setStatsAdminMessage("삭제에 실패했어.",true); return; }
  await loadKosisCatalog();
}

/* 지표 관리 패널 접기/펼치기 (버튼 배선은 main.js 에 모여 있다) */
function toggleKosisAdmin(){
  const body=$("statsAdminBody");
  const open=body.style.display!=="none";
  body.style.display=open?"none":"block";
  $("statsToggleAdmin").textContent=open?"펼치기":"접기";
}
