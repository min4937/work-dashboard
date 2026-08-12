function weekMemoKey(mondayDate){
  return dateKey(mondayDate);
}

function weekRangeLabel(mondayDate){
  const sunday=new Date(mondayDate);
  sunday.setDate(mondayDate.getDate()+6);
  return `${mondayDate.getMonth()+1}/${mondayDate.getDate()} ~ ${sunday.getMonth()+1}/${sunday.getDate()}`;
}

function normalizeWeeklyMemoItems(raw){
  // v10.x의 문자열 메모도 자동으로 체크리스트 항목으로 변환
  if(Array.isArray(raw)){
    return raw.map(item=>({
      text:String(item?.text||""),
      done:Boolean(item?.done)
    }));
  }
  if(typeof raw==="string" && raw.trim()){
    return raw.split(/\r?\n/)
      .map(s=>s.trim())
      .filter(Boolean)
      .map(text=>({text,done:false}));
  }
  return [];
}

function saveWeeklyMemoItems(key,items){
  data.weeklyMemos=data.weeklyMemos||{};
  const cleaned=items
    .map(item=>({text:String(item.text||""),done:Boolean(item.done)}))
    .filter(item=>item.text.trim() || item.done);

  if(cleaned.length){
    data.weeklyMemos[key]=cleaned;
  }else{
    delete data.weeklyMemos[key];
  }
  persist();
}

function makeWeekMemoCell(mondayDate){
  data.weeklyMemos=data.weeklyMemos||{};
  const key=weekMemoKey(mondayDate);
  let items=normalizeWeeklyMemoItems(data.weeklyMemos[key]);

  const cell=document.createElement("div");
  cell.className="week-memo-cell";

  const title=document.createElement("div");
  title.className="week-memo-title";
  title.textContent=weekRangeLabel(mondayDate);

  const list=document.createElement("div");
  list.className="week-checklist";

  const renderItems=()=>{
    list.innerHTML="";

    items.forEach((item,index)=>{
      const row=document.createElement("div");
      row.className=`week-check-row${item.done?" done":""}`;

      const check=document.createElement("input");
      check.type="checkbox";
      check.checked=Boolean(item.done);
      check.title="완료";
      check.addEventListener("change",()=>{
        items[index].done=check.checked;
        row.classList.toggle("done",check.checked);
        saveWeeklyMemoItems(key,items);
      });

      const input=document.createElement("input");
      input.type="text";
      input.className="week-check-text";
      input.placeholder="할 일";
      input.value=item.text||"";
      input.addEventListener("input",()=>{
        items[index].text=input.value;
        saveWeeklyMemoItems(key,items);
      });
      input.addEventListener("keydown",(e)=>{
        if(e.key==="Enter"){
          e.preventDefault();
          items.splice(index+1,0,{text:"",done:false});
          saveWeeklyMemoItems(key,items);
          renderItems();
          requestAnimationFrame(()=>{
            const inputs=list.querySelectorAll(".week-check-text");
            inputs[index+1]?.focus();
          });
        }
      });

      const del=document.createElement("button");
      del.type="button";
      del.className="week-check-delete";
      del.textContent="×";
      del.title="항목 삭제";
      del.addEventListener("click",()=>{
        items.splice(index,1);
        saveWeeklyMemoItems(key,items);
        renderItems();
      });

      row.appendChild(check);
      row.appendChild(input);
      row.appendChild(del);
      list.appendChild(row);
    });
  };

  const add=document.createElement("button");
  add.type="button";
  add.className="week-check-add";
  add.textContent="+ 할 일 추가";
  add.addEventListener("click",()=>{
    items.push({text:"",done:false});
    saveWeeklyMemoItems(key,items);
    renderItems();
    requestAnimationFrame(()=>{
      const inputs=list.querySelectorAll(".week-check-text");
      inputs[inputs.length-1]?.focus();
    });
  });

  if(items.length===0) items=[{text:"",done:false}];
  renderItems();

  cell.appendChild(title);
  cell.appendChild(list);
  cell.appendChild(add);
  return cell;
}

function renderAnnualCalendar(){
  const wrap=$("annualCalendar");
  if(!wrap) return;
  $("annualYearLabel").textContent=`${annualYear}년`;
  wrap.innerHTML="";
  const todayKey=dateKey(new Date());

  for(let month=0;month<12;month++){
    const card=document.createElement("section");
    card.className="mini-month";
    card.dataset.month=month;

    const title=document.createElement("div");
    title.className="mini-month-title";
    title.innerHTML=`<strong>${month+1}월</strong><span>월간 보기 →</span>`;
    card.appendChild(title);

    const week=document.createElement("div");
    week.className="mini-week";
    week.innerHTML='<div>월</div><div>화</div><div>수</div><div>목</div><div>금</div><div class="sat">토</div><div class="sun">일</div>';
    card.appendChild(week);

    const days=document.createElement("div");
    days.className="mini-days";

    const first=new Date(annualYear,month,1);
    const mondayOffset=(first.getDay()+6)%7;
    const start=new Date(annualYear,month,1-mondayOffset);

    for(let i=0;i<42;i++){
      const d=new Date(start);
      d.setDate(start.getDate()+i);
      const key=dateKey(d);
      const day=document.createElement("div");
      day.className="mini-day";
      day.textContent=d.getDate();

      if(d.getMonth()!==month) day.classList.add("other");
      if(d.getDay()===6) day.classList.add("sat");
      if(d.getDay()===0) day.classList.add("sun");
      if(getHoliday(key)) {
        day.classList.add("holiday");
        day.title=getHoliday(key);
      }
      if(hasMyDailyLog(key)){
        day.classList.add("has-daily-log");
        const summary=getMyDailySummary(key);
        const bits=[];
        if(Number(summary.overtime_hours)>0) bits.push(`야근 ${formatHours(summary.overtime_hours)}h`);
        if(leaveDaysForCategory(summary.work_status)>0) bits.push(leaveStatusLabel(summary.work_status));
        day.title=[getHoliday(key),...bits].filter(Boolean).join(" · ");
      }
      if(d.getMonth()===month && isPaydayDate(d)){
        day.classList.add("payday");
        day.title=[day.title,paydayLabelForDate(d)].filter(Boolean).join(" · ");
      }
      if(key===todayKey) day.classList.add("today");

      days.appendChild(day);
    }
    card.appendChild(days);

    card.addEventListener("click",async()=>{
      viewDate=new Date(annualYear,month,1);
      if(teamCloud.configured && teamCloud.user) await loadMyLoggedDates(viewDate.getFullYear());
      renderAll();
      const monthlyBtn=document.querySelector('[data-page="schedulePage"]');
      if(monthlyBtn) monthlyBtn.click();
    });

    wrap.appendChild(card);
  }
}

function renderCalendar(){
  const y=viewDate.getFullYear(),m=viewDate.getMonth();
  $("monthLabel").textContent=`${y}년 ${m+1}월`;
  $("unsupportedHoliday").style.display=(y===2026||y===2027)?"none":"block";

  const first=new Date(y,m,1);
  const mondayOffset=(first.getDay()+6)%7;
  const start=new Date(y,m,1-mondayOffset);
  const today=dateKey(new Date());
  const cal=$("calendar");
  cal.innerHTML="";

  for(let weekIndex=0;weekIndex<6;weekIndex++){
    const monday=new Date(start);
    monday.setDate(start.getDate()+weekIndex*7);
    cal.appendChild(makeWeekMemoCell(monday));

    for(let dayIndex=0;dayIndex<7;dayIndex++){
      const d=new Date(monday);
      d.setDate(monday.getDate()+dayIndex);

      const key=dateKey(d);
      const holiday=getHoliday(key);
      const dow=d.getDay();
      const summary=getMyDailySummary(key);

      const cell=document.createElement("div");
      cell.className="day";
      if(d.getMonth()!==m) cell.classList.add("other");
      if(key===today) cell.classList.add("today");
      if(dow===6) cell.classList.add("saturday");
      if(dow===0) cell.classList.add("sunday");
      if(holiday) cell.classList.add("holiday");
      if(hasMyDailyLog(key)) cell.classList.add("has-daily-log");

      cell.innerHTML=`<div class="num">${d.getDate()}</div>`;

      if(d.getMonth()===m && isPaydayDate(d)){
        const star=document.createElement("span");
        star.className="payday-star";
        star.textContent="★";
        star.title=paydayLabelForDate(d);
        cell.appendChild(star);

        const payChip=document.createElement("div");
        payChip.className="chip payday-chip";
        payChip.textContent="★ 월급날";
        payChip.title=paydayLabelForDate(d);
        cell.appendChild(payChip);
      }

      if(holiday){
        const c=document.createElement("div");
        c.className="chip holiday";
        c.textContent=holiday;
        cell.appendChild(c);
      }

      if(Number(summary.overtime_hours)>0){
        const c=document.createElement("div");
        c.className="chip ot";
        c.textContent=`야근 ${formatHours(summary.overtime_hours)}h`;
        cell.appendChild(c);
      }

      if(leaveDaysForCategory(summary.work_status)>0){
        const c=document.createElement("div");
        c.className="chip note";
        c.textContent=leaveStatusLabel(summary.work_status);
        cell.appendChild(c);
      }

      cell.addEventListener("click",()=>openDailyLog(key));
      cal.appendChild(cell);
    }
  }
}
