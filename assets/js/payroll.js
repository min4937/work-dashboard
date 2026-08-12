const earningKeys=[
  "basicSalary","technicalAllowance","positionAllowance","qualificationAllowance","serviceAllowance",
  "jobDevelopment","transport","meal"
];
const deductionKeys=[
  "incomeTax","localTax","employmentInsurance","healthInsurance",
  "longTermCare","nationalPension","associationFee"
];


const salaryShareKeys=[...earningKeys,...deductionKeys,"hourlyOvertime","monthlyCap","pensionType","retirementMonthly","retirementBalance","payDay"];
function salarySettingsSnapshot(){const o={};salaryShareKeys.forEach(k=>o[k]=data.settings[k]??defaultSettings[k]);return o;}
async function syncMySalaryProfile(){if(!teamCloud.client||!teamCloud.user)return;const {error}=await teamCloud.client.from("salary_profiles").upsert({user_id:teamCloud.user.id,settings:salarySettingsSnapshot(),updated_at:new Date().toISOString()},{onConflict:"user_id"});if(error)console.error(error);}
function payrollForSharedSettings(settings,overtimeHours){const s={...defaultSettings,...(settings||{})};let hours=Math.max(0,Number(overtimeHours||0));const cap=Number(s.monthlyCap||0);if(cap>0)hours=Math.min(hours,cap);const fixedPay=earningKeys.reduce((a,k)=>a+Number(s[k]||0),0),deductions=deductionKeys.reduce((a,k)=>a+Number(s[k]||0),0),overtimePay=hours*Number(s.hourlyOvertime||0);return{hours,fixedPay,deductions,overtimePay,net:fixedPay+overtimePay-deductions};}
async function loadPayrollManagerPanel(){
  const panel=$("payrollManagerPanel");if(!panel)return;
  if(!teamCloud.user||!teamCloud.isPayrollManager){panel.style.display="none";return;}
  panel.style.display="block";$("teamPayrollMessage").textContent="팀 급여를 불러오는 중...";
  const sm=payrollOvertimeMonth(),first=`${sm.getFullYear()}-${String(sm.getMonth()+1).padStart(2,"0")}-01`,last=dateKey(new Date(sm.getFullYear(),sm.getMonth()+1,0));
  const [{data:p,error:pe},{data:s,error:se},{data:l,error:le}]=await Promise.all([
    teamCloud.client.from("profiles").select("user_id,display_name,job_title,sort_order"),
    teamCloud.client.from("salary_profiles").select("user_id,settings,updated_at"),
    teamCloud.client.from("daily_logs").select("user_id,work_date,overtime_hours").gte("work_date",first).lte("work_date",last)
  ]);
  if(pe||se||le){console.error(pe||se||le);$("teamPayrollMessage").textContent="팀 급여를 불러오지 못했어. v12 SQL 업데이트를 확인해줘.";return;}
  const smap=new Map((s||[]).map(x=>[x.user_id,x])),omap=new Map();(l||[]).forEach(x=>omap.set(x.user_id,(omap.get(x.user_id)||0)+Number(x.overtime_hours||0)));
  const body=$("teamPayrollBody");body.innerHTML="";
  sortTeamMembers(p||[]).forEach(m=>{const tr=document.createElement("tr"),sp=smap.get(m.user_id);if(!sp)tr.innerHTML=`<td>${escapeHtml(m.display_name||"이름 미설정")}</td><td>${escapeHtml(m.job_title||"-")}</td><td colspan="5" class="payroll-missing">급여 설정 미등록</td>`;else{const c=payrollForSharedSettings(sp.settings,omap.get(m.user_id)||0);tr.innerHTML=`<td>${escapeHtml(m.display_name||"이름 미설정")}</td><td>${escapeHtml(m.job_title||"-")}</td><td>${won(c.fixedPay)}</td><td>${formatHours(c.hours)}h</td><td>${won(c.overtimePay)}</td><td>${won(c.deductions)}</td><td><strong>${won(c.net)}</strong></td>`;}body.appendChild(tr);});
  $("teamPayrollMessage").textContent=`${sm.getFullYear()}년 ${sm.getMonth()+1}월 야근 반영 기준`;
}

function totals(){
  const s=data.settings;
  const sourceMonth=payrollOvertimeMonth();
  let hours=overtimeHoursForMonth(sourceMonth);
  const overtimePay=hours*Number(s.hourlyOvertime||0);
  const fixedPay=earningKeys.reduce((sum,k)=>sum+Number(s[k]||0),0);
  const deductions=deductionKeys.reduce((sum,k)=>sum+Number(s[k]||0),0);
  const gross=fixedPay+overtimePay;
  const net=gross-deductions;
  return {hours,overtimePay,fixedPay,deductions,gross,net};
}

function renderSummary(){
  const t=totals();
  $("fixedPay").textContent=won(t.fixedPay);
  $("otSummary").textContent=`${t.hours.toLocaleString("ko-KR")}h · ${won(t.overtimePay)}`;
  $("deductionTotal").textContent=won(t.deductions);
  $("netPay").textContent=won(t.net);
  $("pensionMonthly").textContent=won(data.settings.retirementMonthly);

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

function renderPayBreakdown(){
  const t=totals();
  const s=data.settings;
  const labels={
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
  let rows="";
  earningKeys.forEach(k=>{
    rows += `<div>${labels[k]}</div><div class="amount">${won(s[k])}</div>`;
  });
  const sourceMonth=payrollOvertimeMonth();
  rows += `<div>${sourceMonth.getMonth()+1}월 야근비 (${t.hours}h)</div><div class="amount">${won(t.overtimePay)}</div>`;
  rows += `<div class="total">총 지급액</div><div class="amount total">${won(t.gross)}</div>`;
  deductionKeys.forEach(k=>{
    rows += `<div>${labels[k]}</div><div class="amount">− ${won(s[k])}</div>`;
  });
  rows += `<div class="total">공제 합계</div><div class="amount total">− ${won(t.deductions)}</div>`;
  rows += `<div class="total net">예상 실수령액</div><div class="amount total net">${won(t.net)}</div>`;
  $("payBreakdown").innerHTML=rows;
}

function parseTimeMinutes(value){
  if(!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h,m]=value.split(":").map(Number);
  return h*60+m;
}

function calculateOvertimeHours(startTime,endTime){
  // 회사 야근 인정은 '퇴근시간'만으로 계산한다.
  // 출근시간이 비어 있어도 퇴근시간이 있으면 정상 계산된다.
  const end=parseTimeMinutes(endTime);
  if(end===null) return 0;

  // 회사 규칙
  // 18:00 정시퇴근
  // 18:00~19:00 저녁시간 제외
  // 19:00~22:00만 인정
  // 완료된 1시간 단위만 인정
  // 하루 최대 3시간
  const overtimeStart=19*60;   // 19:00
  const overtimeCutoff=22*60;  // 22:00

  const recognizedEnd=Math.min(end,overtimeCutoff);
  const eligibleMinutes=Math.max(0,recognizedEnd-overtimeStart);

  return Math.min(3,Math.floor(eligibleMinutes/60));
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
      overtime_hours:Number(log.overtime_hours ?? calculateOvertimeHours(log.start_time,log.end_time)),
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
      if(date.startsWith(prefix)) hours += recognizedHours(value);
    }
  }else{
    const keys=new Set([
      ...Object.keys(data.dailyLogs||{}),
      ...Object.keys(data.records||{})
    ]);
    for(const date of keys){
      if(date.startsWith(prefix)){
        hours += recognizedHours(getMyDailySummary(date).overtime_hours);
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
  const hours=calculateOvertimeHours(start,end);
  const preview=$("dailyOvertimePreview");
  const rule=$("dailyOvertimeRule");
  const mini=$("dailyOvertimeMini");

  if(preview) preview.textContent=`${formatHours(hours)}시간`;
  if(rule) rule.textContent="20:00=1h · 21:00=2h · 22:00=3h";
  if(mini) mini.textContent=`자동 야근 ${formatHours(hours)}h`;
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

