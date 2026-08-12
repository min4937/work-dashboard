/* Supabase 연결 설정
 *
 * Supabase 대시보드 → Settings → API 에서 값을 복사해 채운다.
 *   supabaseUrl           : Project URL
 *   supabasePublishableKey: Publishable key (= anon key)
 *
 * 이 두 값은 브라우저에 노출되는 것이 정상이며 공개돼도 안전하다.
 * 실제 접근 통제는 supabase/schema.sql 의 RLS 정책이 담당한다.
 * service_role key 는 절대 여기에 넣지 말 것 — 모든 권한을 우회한다.
 */
window.TEAM_SYNC_CONFIG = {
  supabaseUrl: "https://<프로젝트ID>.supabase.co",
  supabasePublishableKey: "<publishable key 붙여넣기>"
};
