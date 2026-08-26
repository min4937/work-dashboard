/* ============================================================================
   야근 인정 계산 · 급여 · 급여일

   급여는 완전히 개인 데이터다. user_state 테이블에 본인만 읽고 쓸 수 있게
   저장되며, 팀장을 포함해 누구도 남의 급여를 볼 수 없다.
   ============================================================================ */

const earningKeys=[
  "basicSalary","technicalAllowance","positionAllowance","qualificationAllowance","serviceAllowance",
  "jobDevelopment","transport","meal"
];
const deductionKeys=[
  "incomeTax","localTax","employmentInsurance","healthInsurance",
  "longTermCare","nationalPension","associationFee"
];

const payLabels={
  basicSalary:"기본급",
  technicalAllowance:"기술수당",
  positionAllowance:"직급수당",
  qualificationAllowance:"자격수당",
  serviceAllowance:"근속수당",
  jobDevelopment:"직무개발비",
  transport:"교통비 보조",
  meal:"식대",
  incomeTax:"소득세",
  localTax:"주민세(지방소득세)",
  employmentInsurance:"고용보험",
  healthInsurance:"건강보험",
  longTermCare:"장기요양보험",
  nationalPension:"국민연금",
  associationFee:"사우회비"
};


/* ==========================================================================
   월별 공제 : 자동계산 + 그 달만 덮어쓰기

   공제 항목은 성격이 셋으로 갈린다.
     · 국민연금 · 건강보험 · 장기요양 → 연 단위로 정해진 기준액에 묶여 있다.
       기준소득월액은 전년도 소득으로 해마다 7월에, 건강보험 보수월액은 4월
       정산으로 한 번 정해지고 그대로 간다. 그래서 이 달 급여로는 역산이 안 된다.
       명세서 금액을 한 번 넣어 두면 그 값을 다음 달로 이어 쓴다.
       (한 번도 넣은 적이 없을 때만 요율로 근사치를 낸다)
     · 소득세 → 간이세액표(급여구간 × 부양가족)라 자동 산출이 어려워서
       마찬가지로 마지막에 넣은 값을 이어 쓴다.
     · 고용보험 · 주민세 → 그 달 값에서 바로 나온다. 고용보험은 그 달 과세
       보수 기준이라 야근비 따라 달라지고, 주민세는 소득세의 10%로 떨어진다.

   급여명세서를 받은 달은 실제 금액을 넣어 두면 그 항목만 그 달에 잠긴다.
   ========================================================================== */

const NON_TAX_CAP=200000;   // 식대·교통비 비과세 월 한도

function payrollMonthKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function payrollMonths(){
  const s=data.settings;
  if(!s.payrollMonths || typeof s.payrollMonths!=="object") s.payrollMonths={};
  return s.payrollMonths;
}

function hasValue(v){
  return v!==undefined && v!==null && v!=="" && !Number.isNaN(Number(v));
}

/* 그 달에 직접 넣어 둔 값들 */
function monthOverride(key){
  return payrollMonths()[key] || {};
}

/* 4대보험·소득세는 10원 미만을 절사한다. */
function cut10(n){
  return Math.floor(Number(n||0)/10)*10;
}

/* 해당 월 이전(그 달 포함)에 마지막으로 직접 넣은 달의 키. 없으면 null */
function carriedFromMonth(key,field){
  const months=Object.keys(payrollMonths())
    .filter(k=>k<=key && hasValue(payrollMonths()[k]?.[field])).sort();
  return months.length ? months[months.length-1] : null;
}

/* 해당 월 이전(그 달 포함)에 마지막으로 직접 넣은 값. 없으면 null */
function carriedOver(key,field){
  const from=carriedFromMonth(key,field);
  return from===null ? null : Number(payrollMonths()[from][field]);
}

/* 비과세 합계 — 직접 넣은 값이 있으면 그걸 쓰고, 없으면 식대·교통비로 계산한다. */
function nonTaxableAmount(){
  const s=data.settings;
  const manual=Number(s.nonTaxableMonthly||0);
  if(manual>0) return manual;
  return Math.min(Number(s.meal||0),NON_TAX_CAP)+Math.min(Number(s.transport||0),NON_TAX_CAP);
}

/* 국민연금·건강보험의 기준이 되는 보수월액.
   비과세(식대 등)는 빼고 잡는다. 직접 넣어 둔 값이 있으면 그게 우선이다. */
function insuranceBase(){
  const s=data.settings;
  const fixedPay=earningKeys.reduce((sum,k)=>sum+Number(s[k]||0),0);
  return Number(s.insuranceBaseWage||0) || Math.max(0,fixedPay-nonTaxableAmount());
}

/* 이어 쓰는 항목들 — 급여에서 역산이 안 돼 마지막에 넣은 명세서 금액을 그대로 쓴다. */
const carriedKeys=["incomeTax","nationalPension","healthInsurance","longTermCare"];

/* 요율로 계산한 그 달 공제액.
   이어 쓸 값이 있으면 그게 먼저고, 없을 때만 요율로 근사치를 낸다.
   요율이 0인 항목은 설정의 고정금액을 그대로 쓴다. */
function autoDeductions(key,gross){
  const s=data.settings;
  const rate=(k)=>Number(s[k]||0);
  const base=insuranceBase();

  let pensionBase=base;
  const floor=Number(s.pensionBaseFloor||0);
  const cap=Number(s.pensionBaseCap||0);
  if(floor>0) pensionBase=Math.max(pensionBase,floor);
  if(cap>0) pensionBase=Math.min(pensionBase,cap);

  const nationalPension=carriedOver(key,"nationalPension")
    ?? (rate("rateNationalPension")>0
      ? cut10(pensionBase*rate("rateNationalPension")/100)
      : Number(s.nationalPension||0));

  const healthInsurance=carriedOver(key,"healthInsurance")
    ?? (rate("rateHealthInsurance")>0
      ? cut10(base*rate("rateHealthInsurance")/100)
      : Number(s.healthInsurance||0));

  // 장기요양은 '실제로 낸 건강보험료' 기준이라, 건강보험이 이어 쓰는 값이면
  // 그 값을 기준으로 잡는다.
  const longTermCare=carriedOver(key,"longTermCare")
    ?? (rate("rateLongTermCare")>0
      ? cut10(healthInsurance*rate("rateLongTermCare")/100)
      : Number(s.longTermCare||0));

  const taxableGross=Math.max(0,gross-nonTaxableAmount());
  const employmentInsurance=rate("rateEmploymentInsurance")>0
    ? cut10(taxableGross*rate("rateEmploymentInsurance")/100)
    : Number(s.employmentInsurance||0);

  const incomeTax=carriedOver(key,"incomeTax") ?? Number(s.incomeTax||0);

  const localTax=rate("rateLocalTax")>0
    ? cut10(incomeTax*rate("rateLocalTax")/100)
    : Number(s.localTax||0);

  return {
    incomeTax,localTax,employmentInsurance,healthInsurance,
    longTermCare,nationalPension,
    associationFee:Number(s.associationFee||0),
    taxableGross,base,pensionBase
  };
}

/* 그 달 최종 공제액. 직접 넣은 항목은 입력값이, 나머지는 자동값이 쓰인다. */
function deductionsForMonth(key,gross){
  const auto=autoDeductions(key,gross);
  const over=monthOverride(key);
  const amounts={};
  const manual={};
  deductionKeys.forEach(k=>{
    if(hasValue(over[k])){
      amounts[k]=Number(over[k]);
      manual[k]=true;
    }else{
      amounts[k]=Number(auto[k]||0);
      manual[k]=false;
    }
  });
  return {amounts,manual,auto};
}


function totals(){
  const s=data.settings;
  const sourceMonth=payrollOvertimeMonth();
  let hours=overtimeHoursForMonth(sourceMonth);
  const overtimePay=hours*Number(s.hourlyOvertime||0);
  const fixedPay=earningKeys.reduce((sum,k)=>sum+Number(s[k]||0),0);
  const gross=fixedPay+overtimePay;
  const monthKey=payrollMonthKey(viewDate);
  const {amounts,manual,auto}=deductionsForMonth(monthKey,gross);
  const deductions=deductionKeys.reduce((sum,k)=>sum+Number(amounts[k]||0),0);
  const net=gross-deductions;
  return {hours,overtimePay,fixedPay,deductions,gross,net,monthKey,amounts,manual,auto};
}

function renderSummary(){
  const t=totals();
  $("fixedPay").textContent=won(t.fixedPay);
  $("otSummary").textContent=`${t.hours.toLocaleString("ko-KR")}h · ${won(t.overtimePay)}`;
  $("deductionTotal").textContent=won(t.deductions);
  $("netPay").textContent=won(t.net);
  $("pensionMonthly").textContent=won(data.settings.retirementMonthly);
  renderPaydayCountdown();

  // 월간일정표에서는 '현재 보고 있는 달'의 야근 실적을 보여준다.
  const currentHours=monthlyOvertimeHours();
  const currentPay=currentHours*Number(data.settings.hourlyOvertime||0);
  const otHoursOnly=$("otHoursOnly");
  const otPayOnly=$("otPayOnly");
  if(otHoursOnly) otHoursOnly.textContent=`${currentHours.toLocaleString("ko-KR")}시간`;
  if(otPayOnly) otPayOnly.textContent=won(currentPay);

  const salaryTitle=$("salaryMonthTitle");
  const salaryNote=$("salaryOvertimeSourceNote");
  const sourceMonth=payrollOvertimeMonth();
  if(salaryTitle){
    salaryTitle.textContent=`${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월 급여 예상`;
  }
  if(salaryNote){
    salaryNote.textContent=
      `${sourceMonth.getFullYear()}년 ${sourceMonth.getMonth()+1}월 야근비가 `+
      `${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월 월급에 포함돼.`;
  }
}

/* 오늘 기준으로 다음 월급날을 찾는다. (토·일·공휴일 조정까지 반영) */
function nextPaydayFromToday(){
  const today=new Date();
  today.setHours(0,0,0,0);
  let payday=effectivePaydayDate(today.getFullYear(),today.getMonth());
  if(payday<today) payday=effectivePaydayDate(today.getFullYear(),today.getMonth()+1);
  return payday;
}

function renderPaydayCountdown(){
  const ddayEl=$("paydayDday");
  if(!ddayEl) return;

  const today=new Date();
  today.setHours(0,0,0,0);
  const payday=nextPaydayFromToday();
  const days=Math.round((payday-today)/86400000);
  const weekdays=["일","월","화","수","목","금","토"];
  const label=`${payday.getMonth()+1}월 ${payday.getDate()}일(${weekdays[payday.getDay()]})`;

  ddayEl.textContent=days===0 ? "D-DAY" : `D-${days}`;
  ddayEl.classList.toggle("today",days===0);

  $("paydaySentence").innerHTML=days===0
    ? `오늘이 월급날이야! <strong>${label}</strong>`
    : `다음 월급날 <strong>${label}</strong>까지 <strong>${days}일</strong> 남았어.`;

  const configured=Math.min(31,Math.max(1,Number(data.settings.payDay||25)));
  const lastDay=new Date(payday.getFullYear(),payday.getMonth()+1,0).getDate();
  const nominalDay=Math.min(configured,lastDay);
  $("paydayNote").textContent=payday.getDate()!==nominalDay
    ? `원래 월급날은 ${nominalDay}일이지만 휴일이라 ${payday.getDate()}일로 앞당겨졌어.`
    : `월급날은 매월 ${configured}일이야. 토·일·공휴일이면 직전 평일로 자동 조정돼.`;
}

/* 공제 항목 옆에 붙는 근거 한 줄.
   명세서 금액을 직접 넣은 달은 계산이 아니라 입력값이라 근거를 붙이지 않는다. */
function deductionBasis(k,t){
  const s=data.settings;
  const rate=(key)=>Number(s[key]||0);
  const by=(label,baseAmount,rateKey)=>
    `${label} ${Number(baseAmount||0).toLocaleString("ko-KR")}원 × ${rate(rateKey)}% (10원 절사)`;
  // 이어 쓰는 중이면 어느 달 명세서에서 온 값인지 밝혀 준다.
  const carried=(field)=>{
    const from=carriedFromMonth(t.monthKey,field);
    if(!from) return "";
    const [y,m]=from.split("-");
    return `${y}년 ${Number(m)}월 명세서 값 이어 씀`;
  };

  if(t.manual[k]) return "";

  switch(k){
    case "nationalPension":
      return carried("nationalPension") ||
        (rate("rateNationalPension")>0
          ? by("기준소득월액",t.auto.pensionBase,"rateNationalPension") : "설정 고정액");
    case "healthInsurance":
      return carried("healthInsurance") ||
        (rate("rateHealthInsurance")>0
          ? by("보수월액",t.auto.base,"rateHealthInsurance") : "설정 고정액");
    case "longTermCare":
      return carried("longTermCare") ||
        (rate("rateLongTermCare")>0
          ? by("건강보험료",t.amounts.healthInsurance,"rateLongTermCare") : "설정 고정액");
    case "employmentInsurance":
      return rate("rateEmploymentInsurance")>0
        ? by("과세보수",t.auto.taxableGross,"rateEmploymentInsurance") : "설정 고정액";
    case "localTax":
      return rate("rateLocalTax")>0
        ? by("소득세",t.amounts.incomeTax,"rateLocalTax") : "설정 고정액";
    case "incomeTax":{
      // 간이세액표는 자동 산출이 안 돼서 마지막에 직접 넣은 값을 이어 쓴다.
      const from=carried("incomeTax");
      return from ? `간이세액표 · ${from}` : "간이세액표 · 설정 고정액";
    }
    case "associationFee":
      return "설정 고정액";
    default:
      return "";
  }
}

function renderPayBreakdown(){
  const t=totals();
  const s=data.settings;
  let rows="";
  earningKeys.forEach(k=>{
    rows += `<div>${payLabels[k]}</div><div class="amount">${won(s[k])}</div>`;
  });
  const sourceMonth=payrollOvertimeMonth();
  rows += `<div>${sourceMonth.getMonth()+1}월 야근비 (${t.hours}h)</div><div class="amount">${won(t.overtimePay)}</div>`;
  rows += `<div class="total">총 지급액</div><div class="amount total">${won(t.gross)}</div>`;
  deductionKeys.forEach(k=>{
    const tag=t.manual[k]
      ? `<span class="pay-tag manual">명세서</span>`
      : `<span class="pay-tag">자동</span>`;
    const basis=deductionBasis(k,t);
    const basisLine=basis ? `<span class="pay-basis">${basis}</span>` : "";
    rows += `<div>${payLabels[k]} ${tag}${basisLine}</div>`+
            `<div class="amount">− ${won(t.amounts[k])}</div>`;
  });
  rows += `<div class="total">공제 합계</div><div class="amount total">− ${won(t.deductions)}</div>`;
  rows += `<div class="total net">예상 실수령액</div><div class="amount total net">${won(t.net)}</div>`;
  $("payBreakdown").innerHTML=rows;
}

/* ------------------------------------------------ 이번 달 공제 직접 입력하기 */

function renderMonthlyDeductions(){
  const wrap=$("monthlyDeductionFields");
  if(!wrap) return;

  const t=totals();
  const key=t.monthKey;
  const over=monthOverride(key);
  const year=viewDate.getFullYear();
  const month=viewDate.getMonth()+1;

  const title=$("monthlyDeductionTitle");
  if(title) title.textContent=`${year}년 ${month}월 공제 입력`;

  wrap.innerHTML=deductionKeys.map(k=>{
    const manual=hasValue(over[k]);
    const autoAmount=Number(t.auto[k]||0).toLocaleString("ko-KR");
    return `<div class="field monthly-deduction${manual?" manual":""}">
      <label for="md_${k}">${payLabels[k]}
        <span class="pay-tag${manual?" manual":""}">${manual?"명세서":"자동"}</span>
      </label>
      <input id="md_${k}" type="number" min="0" step="10"
             value="${manual?Number(over[k]):""}"
             placeholder="자동 ${autoAmount}원" />
    </div>`;
  }).join("");

  const note=$("monthlyDeductionNote");
  if(note){
    const filled=deductionKeys.filter(k=>hasValue(over[k]));
    // 이 달에 직접 넣지는 않았지만 지난 명세서 값을 이어 쓰는 항목들
    const carriedNow=carriedKeys.filter(k=>{
      const from=carriedFromMonth(key,k);
      return from && from!==key;
    });

    let text=filled.length
      ? `이 달 명세서 금액으로 넣어 둔 항목 — <strong>${filled.map(k=>payLabels[k]).join(" · ")}</strong>`
      : `이 달은 아직 명세서 금액이 없어서 전부 자동 계산값이야.`;

    if(carriedNow.length){
      const list=carriedNow.map(k=>{
        const from=carriedFromMonth(key,k);
        const [cy,cm]=from.split("-");
        return `${payLabels[k]} ${carriedOver(key,k).toLocaleString("ko-KR")}원`+
               `(${cy}년 ${Number(cm)}월)`;
      }).join(" · ");
      text += ` 지난 명세서 값을 이어 쓰는 항목 — <strong>${list}</strong>.`;
    }
    text += `<br>과세 보수 ${Number(t.auto.taxableGross||0).toLocaleString("ko-KR")}원 `+
            `(비과세 ${nonTaxableAmount().toLocaleString("ko-KR")}원 제외) · `+
            `요율 계산용 보수월액 ${Number(t.auto.base||0).toLocaleString("ko-KR")}원 기준.`;
    note.innerHTML=text;
  }
}

/* 화면에 입력한 값을 그 달에 저장한다. 비운 항목은 자동계산으로 되돌아간다. */
function saveMonthlyDeductions(){
  const key=payrollMonthKey(viewDate);
  const entry={};
  deductionKeys.forEach(k=>{
    const el=$(`md_${k}`);
    if(!el) return;
    const v=el.value.trim();
    if(v!=="") entry[k]=Number(v);
  });

  if(Object.keys(entry).length) payrollMonths()[key]=entry;
  else delete payrollMonths()[key];

  persist();
  renderAll();
}

/* 그 달 입력을 모두 지워 자동 계산으로 되돌린다. */
function resetMonthlyDeductions(){
  const key=payrollMonthKey(viewDate);
  if(!payrollMonths()[key]) return;
  delete payrollMonths()[key];
  persist();
  renderAll();
}

function parseTimeMinutes(value){
  if(!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h,m]=value.split(":").map(Number);
  return h*60+m;
}

const WEEKDAY_OVERTIME_CAP=3;   // 평일 야근 인정 한도
const HOLIDAY_WORK_CAP=8;       // 주말·공휴일 출근 추가수당 한도

/* 주말(토·일)이거나 공휴일인 날짜인가 */
function isHolidayWorkDate(key){
  if(!key) return false;
  const d=new Date(key+"T00:00:00");
  if(Number.isNaN(d.getTime())) return false;
  return d.getDay()===0 || d.getDay()===6 || Boolean(getHoliday(key));
}

function overtimeCapForDate(key){
  return isHolidayWorkDate(key) ? HOLIDAY_WORK_CAP : WEEKDAY_OVERTIME_CAP;
}

function overtimeLabelForDate(key){
  return isHolidayWorkDate(key) ? "추가근무" : "야근";
}

function calculateOvertimeHours(startTime,endTime,key){
  const end=parseTimeMinutes(endTime);
  if(end===null) return 0;

  // 주말·공휴일 출근은 근무한 시간 전체를 추가수당으로 인정한다.
  //   출근~퇴근을 완료된 1시간 단위로 계산 · 하루 최대 8시간
  //   (출근시간이 없으면 근무한 길이를 알 수 없어 0으로 둔다)
  if(isHolidayWorkDate(key)){
    const start=parseTimeMinutes(startTime);
    if(start===null) return 0;
    const worked=Math.max(0,end-start);
    return Math.min(HOLIDAY_WORK_CAP,Math.floor(worked/60));
  }

  // 평일 야근 인정은 '퇴근시간'만으로 계산한다.
  // 출근시간이 비어 있어도 퇴근시간이 있으면 정상 계산된다.
  //   18:00 정시퇴근 · 18:00~19:00 저녁시간 제외 · 19:00~22:00만 인정
  //   완료된 1시간 단위만 인정 · 하루 최대 3시간
  const overtimeStart=19*60;   // 19:00
  const overtimeCutoff=22*60;  // 22:00

  const recognizedEnd=Math.min(end,overtimeCutoff);
  const eligibleMinutes=Math.max(0,recognizedEnd-overtimeStart);

  return Math.min(WEEKDAY_OVERTIME_CAP,Math.floor(eligibleMinutes/60));
}

function formatHours(hours){
  const n=Number(hours||0);
  return n.toLocaleString("ko-KR",{maximumFractionDigits:2});
}

function getMyDailySummary(key){
  if(teamCloud.configured && teamCloud.user){
    return {
      overtime_hours:Number(teamCloud.myOvertimeByDate.get(key)||0),
      work_status:teamCloud.myWorkStatusByDate.get(key)||"정상근무"
    };
  }

  const log=data.dailyLogs?.[key];
  if(log){
    return {
      overtime_hours:Number(log.overtime_hours ?? calculateOvertimeHours(log.start_time,log.end_time,key)),
      work_status:log.work_status || data.records?.[key]?.category || "정상근무"
    };
  }

  // 예전 버전 기록 호환
  const old=data.records?.[key];
  return {
    overtime_hours:Number(old?.overtime||0),
    work_status:old?.category||"정상근무"
  };
}

function overtimeHoursForMonth(monthDate){
  const y=monthDate.getFullYear();
  const m=monthDate.getMonth();
  const prefix=`${y}-${String(m+1).padStart(2,"0")}`;
  let hours=0;

  if(teamCloud.configured && teamCloud.user){
    for(const [date,value] of teamCloud.myOvertimeByDate.entries()){
      if(date.startsWith(prefix)) hours += recognizedHours(value,date);
    }
  }else{
    const keys=new Set([
      ...Object.keys(data.dailyLogs||{}),
      ...Object.keys(data.records||{})
    ]);
    for(const date of keys){
      if(date.startsWith(prefix)){
        hours += recognizedHours(getMyDailySummary(date).overtime_hours,date);
      }
    }
  }

  const mcap=Number(data.settings.monthlyCap||0);
  if(mcap>0) hours=Math.min(hours,mcap);
  return Math.round(hours*100)/100;
}

function monthlyOvertimeHours(){
  return overtimeHoursForMonth(viewDate);
}

function payrollOvertimeMonth(){
  return new Date(viewDate.getFullYear(),viewDate.getMonth()-1,1);
}

function updateDailyOvertimePreview(){
  const start=$("daily_start_time")?.value||"";
  const end=$("daily_end_time")?.value||"";
  const hours=calculateOvertimeHours(start,end,dailyLogDate);
  const holidayWork=isHolidayWorkDate(dailyLogDate);
  const label=overtimeLabelForDate(dailyLogDate);
  const preview=$("dailyOvertimePreview");
  const rule=$("dailyOvertimeRule");
  const mini=$("dailyOvertimeMini");
  const title=$("dailyOvertimeTitle");

  if(preview) preview.textContent=`${formatHours(hours)}시간`;
  if(title) title.textContent=`자동 계산 ${label}`;
  if(rule){
    rule.textContent=holidayWork
      ? "주말·공휴일 출근 · 출근~퇴근 1시간 단위 · 최대 8h"
      : "20:00=1h · 21:00=2h · 22:00=3h";
  }
  if(mini) mini.textContent=`자동 ${label} ${formatHours(hours)}h`;
  return hours;
}

function effectivePaydayDate(year,month){
  const configured=Math.min(31,Math.max(1,Number(data.settings.payDay||25)));
  const lastDay=new Date(year,month+1,0).getDate();

  // 설정일이 해당 월에 없으면 우선 그 달의 말일로 맞춘다.
  let d=new Date(year,month,Math.min(configured,lastDay));

  // 토/일/대한민국 공휴일이면 직전 평일까지 계속 당긴다.
  while(
    d.getDay()===0 ||
    d.getDay()===6 ||
    Boolean(getHoliday(dateKey(d)))
  ){
    d.setDate(d.getDate()-1);
  }

  return d;
}

function effectivePayday(year,month){
  return effectivePaydayDate(year,month).getDate();
}

function isPaydayDate(d){
  const payday=effectivePaydayDate(d.getFullYear(),d.getMonth());
  return dateKey(d)===dateKey(payday);
}


function paydayLabelForDate(d){
  const configured=Math.min(31,Math.max(1,Number(data.settings.payDay||25)));
  const lastDay=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  const nominalDay=Math.min(configured,lastDay);
  const effective=effectivePaydayDate(d.getFullYear(),d.getMonth());

  if(effective.getDate()!==nominalDay){
    return `월급날 (원래 ${nominalDay}일 → 휴일로 앞당김)`;
  }
  return "월급날";
}

