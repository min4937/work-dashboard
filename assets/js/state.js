const STORAGE_KEY = "myCompanyDashboard_v2";
const OLD_STORAGE_KEY = "myCompanyDashboard_v1";

const defaultSettings = {
  userName:"",
  companyName:"",
  jobTitle:"",
  onboardingDone:false,
  basicSalary:0,
  technicalAllowance:0,
  positionAllowance:0,
  qualificationAllowance:0,
  serviceAllowance:0,
  jobDevelopment:0,
  transport:0,
  meal:0,
  hourlyOvertime:0,
  regularEndTime:"18:00",
  overtimeStartTime:"19:00",
  overtimeCutoffTime:"22:00",
  dailyCap:3,
  monthlyCap:0,
  incomeTax:0,
  localTax:0,
  employmentInsurance:0,
  healthInsurance:0,
  longTermCare:0,
  nationalPension:0,
  associationFee:0,
  pensionType:"미설정",
  retirementMonthly:0,
  retirementBalance:0,
  totalAnnualLeave:0,
  payDay:25
};

const defaultData = { settings:{...defaultSettings}, records:{}, dailyLogs:{}, weeklyMemos:{}, updatedAt:"1970-01-01T00:00:00.000Z" };

// 내장 공휴일 데이터가 있는 연도. 이 연도들은 holidayData 가 완전하다고 보고
// 양력 고정 공휴일 폴백을 쓰지 않는다. (cloudHolidayYears 는 sync.js 가 채운다)
const builtinHolidayYears = new Set(["2026","2027"]);
const cloudHolidayYears = new Set();

/* 2026~2027 대한민국 공휴일
   2026년에는 노동절·제헌절 공휴일 지정 등 최신 변경을 반영.
*/
const holidayData = {
  "2026-01-01":"신정",
  "2026-02-16":"설날 연휴",
  "2026-02-17":"설날",
  "2026-02-18":"설날 연휴",
  "2026-03-01":"삼일절",
  "2026-03-02":"삼일절 대체공휴일",
  "2026-05-01":"노동절",
  "2026-05-05":"어린이날",
  "2026-05-24":"부처님오신날",
  "2026-05-25":"부처님오신날 대체공휴일",
  "2026-06-03":"전국동시지방선거일",
  "2026-06-06":"현충일",
  "2026-07-17":"제헌절",
  "2026-08-15":"광복절",
  "2026-08-17":"광복절 대체공휴일",
  "2026-09-24":"추석 연휴",
  "2026-09-25":"추석",
  "2026-09-26":"추석 연휴",
  "2026-10-03":"개천절",
  "2026-10-05":"개천절 대체공휴일",
  "2026-10-09":"한글날",
  "2026-12-25":"기독탄신일",

  "2027-01-01":"신정",
  "2027-02-06":"설날 연휴",
  "2027-02-07":"설날",
  "2027-02-08":"설날 연휴",
  "2027-02-09":"설날 대체공휴일",
  "2027-03-01":"삼일절",
  "2027-05-01":"노동절",
  "2027-05-03":"노동절 대체공휴일",
  "2027-05-05":"어린이날",
  "2027-05-13":"부처님오신날",
  "2027-06-06":"현충일",
  "2027-07-17":"제헌절",
  "2027-07-19":"제헌절 대체공휴일",
  "2027-08-15":"광복절",
  "2027-08-16":"광복절 대체공휴일",
  "2027-09-14":"추석 연휴",
  "2027-09-15":"추석",
  "2027-09-16":"추석 연휴",
  "2027-10-03":"개천절",
  "2027-10-04":"개천절 대체공휴일",
  "2027-10-09":"한글날",
  "2027-10-11":"한글날 대체공휴일",
  "2027-12-25":"기독탄신일",
  "2027-12-27":"기독탄신일 대체공휴일"
};

const fixedHolidayNames = {
  "01-01":"신정",
  "03-01":"삼일절",
  "05-01":"노동절",
  "05-05":"어린이날",
  "06-06":"현충일",
  "07-17":"제헌절",
  "08-15":"광복절",
  "10-03":"개천절",
  "10-09":"한글날",
  "12-25":"기독탄신일"
};

let data = loadData();

// 회사 야근 인정 규칙은 설정으로 바꿀 수 없게 고정한다.
function applyFixedOvertimeRules(){
  data.settings.dailyCap=3;
  data.settings.regularEndTime="18:00";
  data.settings.overtimeStartTime="19:00";
  data.settings.overtimeCutoffTime="22:00";
}
applyFixedOvertimeRules();

let viewDate = new Date();
viewDate.setDate(1);
let annualYear = new Date().getFullYear();
let dailyLogDate = dateKey(new Date());
let teamCloud = {
  configured:false,
  client:null,
  user:null,

  // 내 프로필과 소속 팀
  profile:null,
  teamId:null,
  teamName:"우리 팀",
  isLeader:false,
  inviteCode:"",

  members:[],
  logs:[],
  myLoggedDates:new Set(),
  myOvertimeByDate:new Map(),
  myWorkStatusByDate:new Map(),
  channel:null,
  weeklyChannel:null,
  statusChannel:null,
  weeklyMembers:[],
  weeklyLogs:[],
  teamFiles:[],
  leaveRequests:[],
  memberStatus:new Map()
};

const $ = (id) => document.getElementById(id);
const won = (n) => Math.round(Number(n || 0)).toLocaleString("ko-KR") + "원";
const num = (id) => Number($(id).value || 0);

function dateKey(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function migrateV1(old){
  const migrated = {
    settings:{...defaultSettings},
    records: old?.records || {},
    dailyLogs: old?.dailyLogs || {},
    weeklyMemos: old?.weeklyMemos || {}
  };
  if(old?.settings){
    migrated.settings.basicSalary = Number(old.settings.monthlySalary || 0);
    migrated.settings.hourlyOvertime = Number(old.settings.hourlyOvertime || 0);
    migrated.settings.dailyCap = Number(old.settings.dailyCap || 0);
    migrated.settings.monthlyCap = Number(old.settings.monthlyCap || 0);
  }
  return migrated;
}

function loadData(){
  try{
    const saved = localStorage.getItem(STORAGE_KEY);
    if(saved){
      const parsed = JSON.parse(saved);
      return {
        settings:{...defaultSettings,...(parsed.settings||{})},
        records:parsed.records||{},
        dailyLogs:parsed.dailyLogs||{},
        weeklyMemos:parsed.weeklyMemos||{},
        updatedAt:parsed.updatedAt||"1970-01-01T00:00:00.000Z"
      };
    }
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if(old){
      const migrated = migrateV1(JSON.parse(old));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return structuredClone(defaultData);
  }catch(e){
    return structuredClone(defaultData);
  }
}
function persist(){
  data.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  // 로그인 상태라면 클라우드에도 반영한다 (sync.js · 1.5초 디바운스)
  if(typeof schedulePushUserState === "function") schedulePushUserState();
}

function getHoliday(key){
  if(holidayData[key]) return holidayData[key];
  const year = key.slice(0,4);
  // 해당 연도의 공휴일 목록을 통째로 알고 있으면 폴백을 쓰지 않는다.
  if(builtinHolidayYears.has(year) || cloudHolidayYears.has(year)) return "";
  // 목록이 없는 연도는 최소한 양력 고정 공휴일만이라도 표시한다.
  // (음력 명절·대체공휴일은 holidays 테이블에 등록해야 나온다)
  return fixedHolidayNames[key.slice(5)] || "";
}

function recognizedHours(raw){
  let h=Math.max(0,Number(raw||0));
  const cap=Number(data.settings.dailyCap||0);
  if(cap>0) h=Math.min(h,cap);
  return h;
}

function monthRecords(){
  const prefix=`${viewDate.getFullYear()}-${String(viewDate.getMonth()+1).padStart(2,"0")}`;
  return Object.entries(data.records)
    .filter(([k])=>k.startsWith(prefix))
    .sort((a,b)=>a[0].localeCompare(b[0]));
}

const jobTitleRankMap = {
  "대표":0,
  "소장":10,
  "이사":20,
  "팀장":25,
  "부장":30,
  "차장":40,
  "과장":50,
  "대리":60,
  "주임":70,
  "사원":90,
  "인턴":100,
  "기타":900,
  "":999
};

function jobTitleSortOrder(title){
  return jobTitleRankMap[String(title||"").trim()] ?? 950;
}

function sortTeamMembers(members){
  return [...(members||[])].sort((a,b)=>{
    const ar=Number(a.sort_order ?? jobTitleSortOrder(a.job_title));
    const br=Number(b.sort_order ?? jobTitleSortOrder(b.job_title));
    if(ar!==br) return ar-br;
    return String(a.display_name||"").localeCompare(String(b.display_name||""),"ko");
  });
}

function escapeHtml(value=""){
  return String(value).replace(/[&<>"']/g, ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));
}

function workTextHtml(text){
  const items=String(text||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!items.length) return '<span class="none">-</span>';
  return `<ul>${items.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}
