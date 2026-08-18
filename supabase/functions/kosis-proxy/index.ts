/* ============================================================================
   KOSIS 국가통계포털 프록시 (Supabase Edge Function)

   왜 프록시가 필요한가
   - KOSIS OpenAPI 는 CORS 헤더를 주지 않아 브라우저에서 직접 못 부른다.
     그래서 값 조회는 반드시 이 함수를 거친다.

   인증키
   - 사람마다 KOSIS 에서 직접 발급받은 키를 쓴다. 키는 호출할 때마다 요청 본문에
     실려 오고, 여기서는 저장하지 않는다. (로그에도 남기지 않는다)
   - KOSIS_API_KEY 시크릿을 걸어두면 키를 안 보낸 요청의 폴백으로만 쓰인다.

   배포
     supabase functions deploy kosis-proxy
     supabase secrets set KOSIS_API_KEY=공용키   # 선택. 없어도 된다

   호출 (assets/js/kosis.js 에서)
     client.functions.invoke("kosis-proxy", { body: { action, ... } })

   action
     indicator : 통계표 1개 + 지역 1개 -> 최신값·직전값·기준시점·출처
     search    : 키워드로 통계표(ORG_ID/TBL_ID) 찾기
     meta      : 통계표의 분류축 코드값 확인 (지역코드 체계 판별용)
   ============================================================================ */

const BASE = "https://kosis.kr/openapi";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** 호출자가 보낸 본인 키를 쓰고, 없으면 공용 시크릿으로 떨어진다. */
function resolveApiKey(body: Record<string, any>): string {
  const own = String(body?.apiKey || "").trim();
  if (own) return own;
  const shared = Deno.env.get("KOSIS_API_KEY");
  if (shared) return shared;
  throw new Error("KOSIS 인증키가 없어. 통계자료 탭에서 본인 인증키를 등록해줘.");
}

/** KOSIS 는 오류도 HTTP 200 으로 주고 본문에 err 코드를 담는다. */
async function callKosis(path: string, params: Record<string, string>, apiKey: string): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, apiKey, format: "json", jsonVD: "Y" });
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { "User-Agent": "nicetoesa-work-dashboard/1.0" },
  });
  if (!res.ok) throw new Error(`KOSIS 응답 오류 (HTTP ${res.status})`);

  const data = await res.json();
  if (data && !Array.isArray(data) && (data.err || data.errMsg)) {
    throw new Error(`KOSIS 오류 [${data.err}] ${data.errMsg}`);
  }
  return data;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "" || s === "-" || s === "..." || s.toUpperCase() === "X") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** PRD_DE("2024","202406","2024Q2") -> "2024년 6월" 같은 표기 */
function periodText(prd: string): string {
  if (!prd) return "";
  if (prd.length === 4) return `${prd}년`;
  if (prd.length === 6) {
    const y = prd.slice(0, 4);
    const tail = prd.slice(4);
    if (tail.startsWith("Q")) return `${y}년 ${tail.slice(1)}분기`;
    return `${y}년 ${Number(tail)}월`;
  }
  if (prd.length === 8) return `${prd.slice(0, 4)}년 ${Number(prd.slice(4, 6))}월 ${Number(prd.slice(6))}일`;
  return prd;
}

async function handleIndicator(b: Record<string, any>, apiKey: string) {
  const params: Record<string, string> = {
    method: "getList",
    orgId: String(b.orgId),
    tblId: String(b.tblId),
    prdSe: String(b.prdSe || "Y"),
    // 기간을 박지 않는다. 항상 '최신 N개 시점'으로 받아 기준시점 오기입을 막는다.
    newEstPrdCnt: String(b.periods || 2),
  };
  params[String(b.regionParam || "objL1")] = String(b.regionCode);
  if (b.itmId) params.itmId = String(b.itmId);
  for (const [k, v] of Object.entries(b.extraParams || {})) params[k] = String(v);

  const raw = await callKosis("Param/statisticsParameterData.do", params, apiKey);
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length === 0) return { missing: true, value: null, period: "", periodText: "" };

  rows.sort((a: any, z: any) => String(z.PRD_DE || "").localeCompare(String(a.PRD_DE || "")));
  const latest: any = rows[0];
  const prev: any = rows[1] || null;

  const value = toNumber(latest.DT);
  const prevValue = prev ? toNumber(prev.DT) : null;
  const deltaPct = value !== null && prevValue !== null && prevValue !== 0
    ? ((value - prevValue) / prevValue) * 100
    : null;

  return {
    missing: value === null,
    value,
    prevValue,
    deltaPct,
    period: String(latest.PRD_DE || ""),
    periodText: periodText(String(latest.PRD_DE || "")),
    prevPeriod: prev ? String(prev.PRD_DE || "") : "",
    unit: latest.UNIT_NM || "",
    tableName: latest.TBL_NM || "",
    orgName: latest.ORG_NM || "",
    regionName: latest.C1_NM || "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST 로만 호출할 수 있어." }, 405);

  try {
    const body = await req.json();
    const action = String(body.action || "indicator");
    const apiKey = resolveApiKey(body);

    if (action === "indicator") {
      if (!body.orgId || !body.tblId || !body.regionCode) {
        return json({ error: "orgId, tblId, regionCode 는 필수야." }, 400);
      }
      return json(await handleIndicator(body, apiKey));
    }

    if (action === "search") {
      const raw = await callKosis("statisticsSearch.do", {
        method: "getList",
        searchNm: String(body.keyword || ""),
      }, apiKey);
      const rows = (Array.isArray(raw) ? raw : []).slice(0, 50).map((r: any) => ({
        orgId: r.ORG_ID, tblId: r.TBL_ID, tblName: r.TBL_NM, prdSe: r.PRD_SE, orgName: r.ORG_NM,
      }));
      return json({ rows });
    }

    if (action === "meta") {
      const raw = await callKosis("Param/statisticsParameterData.do", {
        method: "getMeta",
        orgId: String(body.orgId),
        tblId: String(body.tblId),
        type: String(body.type || "OBJ"),
      }, apiKey);
      const rows = (Array.isArray(raw) ? raw : []).map((r: any) => ({
        code: r.OBJ_ID ?? r.ITM_ID ?? r.C1 ?? "",
        name: r.OBJ_NM ?? r.ITM_NM ?? r.C1_NM ?? "",
      }));
      // 지역코드가 2자리인지 8자리인지 알려주면 카탈로그 등록이 쉬워진다
      const widths = [...new Set(rows.map((r) => String(r.code).length).filter(Boolean))];
      return json({ rows, codeWidths: widths, guessScheme: Math.max(0, ...widths) >= 8 ? "admin8" : "stat2" });
    }

    return json({ error: `알 수 없는 action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
