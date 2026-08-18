/* ============================================================================
   인증 · 팀 가입

   흐름
     1. 회원가입 — 이메일 + 비밀번호 + 이름/직급 + (팀장으로 새 팀 만들기 | 초대코드)
        팀 의도는 user_metadata 에 실어 두고, 메일 인증 후 첫 로그인 때 실행한다.
     2. 메일 인증 — 최초 한 번만. 링크를 누르면 이 사이트로 돌아온다.
     3. 이후 로그인 — 이메일 + 비밀번호

   초대코드 검증은 서버(join_team RPC)에서 한다. user_metadata 는 사용자가
   조작할 수 있으므로 클라이언트 값은 신뢰하지 않는다.
   ============================================================================ */

const AUTH_TAB_SIGNIN = "signin";
const AUTH_TAB_SIGNUP = "signup";
let authTab = AUTH_TAB_SIGNIN;

function setLoginStatus(message, type = "") {
  const el = $("globalLoginStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = `login-status${type ? ` ${type}` : ""}`;
}

function switchAuthTab(tab) {
  authTab = tab;
  const isSignup = tab === AUTH_TAB_SIGNUP;
  $("authTabSignin").classList.toggle("active", !isSignup);
  $("authTabSignup").classList.toggle("active", isSignup);
  $("signinForm").style.display = isSignup ? "none" : "block";
  $("signupForm").style.display = isSignup ? "block" : "none";
  setLoginStatus(isSignup
    ? "가입하면 인증 메일이 한 번 발송돼. 인증 후에는 이메일과 비밀번호로 로그인해."
    : "가입할 때 정한 이메일과 비밀번호로 로그인해.");
}

/* 팀장으로 만들기 / 초대코드로 참여 토글 */
function updateSignupRoleFields() {
  const asLeader = $("signupAsLeader").checked;
  $("signupTeamNameField").style.display = asLeader ? "block" : "none";
  $("signupInviteCodeField").style.display = asLeader ? "none" : "block";
}

function openLoginModal() {
  const modal = $("loginModal");
  if (!modal) return;
  updateGlobalAuthUi();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  if (!teamCloud.user) {
    switchAuthTab(authTab);
    requestAnimationFrame(() => $("signinEmail")?.focus());
  }
}

function closeLoginModal() {
  const modal = $("loginModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function updateGlobalAuthUi() {
  const btn = $("globalAuthBtn");
  const state = $("globalAuthState");
  const signedOut = $("loginSignedOutArea");
  const signedIn = $("loginSignedInArea");
  const email = $("loginUserEmail");

  if (!btn || !state) return;

  if (!teamCloud.configured) {
    state.textContent = "팀 연동 설정 필요";
    btn.textContent = "로그인";
    if (signedOut) signedOut.style.display = "block";
    if (signedIn) signedIn.style.display = "none";
    setLoginStatus("Supabase 연결 설정을 확인해줘.", "error");
    return;
  }

  if (teamCloud.user) {
    state.textContent = teamCloud.user.email || "로그인됨";
    btn.textContent = "내 계정";
    if (email) email.textContent = teamCloud.user.email || "";
    if (signedOut) signedOut.style.display = "none";
    if (signedIn) signedIn.style.display = "block";
    const where = teamCloud.teamId
      ? `${teamCloud.teamName}${teamCloud.isLeader ? " · 팀장" : ""}`
      : "아직 소속 팀이 없어";
    setLoginStatus(where, "success");
  } else {
    state.textContent = "로그인 전";
    btn.textContent = "로그인";
    if (signedOut) signedOut.style.display = "block";
    if (signedIn) signedIn.style.display = "none";
  }
}

/* ---------------------------------------------------------------- 로그인 */

async function signInWithPassword() {
  if (!teamCloud.client) {
    setLoginStatus("Supabase 연결이 아직 준비되지 않았어.", "error");
    return;
  }
  const email = $("signinEmail").value.trim();
  const password = $("signinPassword").value;

  if (!email || !password) {
    setLoginStatus("이메일과 비밀번호를 모두 입력해줘.", "error");
    return;
  }

  const btn = $("signinSubmit");
  btn.disabled = true;
  btn.textContent = "로그인 중...";

  const { error } = await teamCloud.client.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = "로그인";

  if (error) {
    const msg = /Email not confirmed/i.test(error.message)
      ? "아직 메일 인증을 안 했어. 받은 인증 메일의 링크를 먼저 눌러줘."
      : "이메일 또는 비밀번호가 맞지 않아.";
    setLoginStatus(msg, "error");
    return;
  }

  setLoginStatus("로그인됐어.", "success");
  closeLoginModal();
}

/* ---------------------------------------------------------------- 회원가입 */

async function signUpWithPassword() {
  if (!teamCloud.client) {
    setLoginStatus("Supabase 연결이 아직 준비되지 않았어.", "error");
    return;
  }

  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  const displayName = $("signupDisplayName").value.trim();
  const jobTitle = $("signupJobTitle").value;
  const asLeader = $("signupAsLeader").checked;
  const teamName = $("signupTeamName").value.trim();
  const inviteCode = $("signupInviteCode").value.trim();

  if (!email || !password) {
    setLoginStatus("이메일과 비밀번호를 입력해줘.", "error");
    return;
  }
  if (password.length < 8) {
    setLoginStatus("비밀번호는 8자 이상으로 정해줘.", "error");
    return;
  }
  if (!displayName) {
    setLoginStatus("이름을 입력해줘. 팀원 목록에 이 이름으로 표시돼.", "error");
    return;
  }
  if (asLeader && !teamName) {
    setLoginStatus("만들 팀 이름을 입력해줘.", "error");
    return;
  }
  if (!asLeader && !inviteCode) {
    setLoginStatus("팀장에게 받은 초대코드를 입력해줘.", "error");
    return;
  }

  const btn = $("signupSubmit");
  btn.disabled = true;
  btn.textContent = "가입 중...";

  const { data: result, error } = await teamCloud.client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: location.origin + location.pathname,
      data: {
        display_name: displayName,
        job_title: jobTitle,
        want_leader: asLeader,
        team_name: teamName,
        invite_code: inviteCode
      }
    }
  });

  btn.disabled = false;
  btn.textContent = "가입하기";

  if (error) {
    const msg = /already registered|already exists/i.test(error.message)
      ? "이미 가입된 이메일이야. 로그인 탭에서 로그인해줘."
      : `가입에 실패했어: ${error.message}`;
    setLoginStatus(msg, "error");
    return;
  }

  // 메일 인증이 켜져 있으면 세션 없이 사용자만 만들어진다.
  if (result?.session) {
    setLoginStatus("가입하고 바로 로그인됐어.", "success");
    closeLoginModal();
  } else {
    setLoginStatus(`${email} 로 인증 메일을 보냈어. 메일의 링크를 누르면 가입이 끝나고, 그다음부터는 이메일과 비밀번호로 로그인하면 돼.`, "success");
  }
}

/* ------------------------------------------------------------ 비밀번호 재설정 */

async function sendPasswordReset() {
  if (!teamCloud.client) return;
  const email = $("signinEmail").value.trim();
  if (!email) {
    setLoginStatus("비밀번호를 재설정할 이메일을 먼저 입력해줘.", "error");
    return;
  }
  const { error } = await teamCloud.client.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname
  });
  setLoginStatus(
    error ? "재설정 메일을 보내지 못했어." : `${email} 로 비밀번호 재설정 메일을 보냈어.`,
    error ? "error" : "success"
  );
}

/* 재설정 메일로 돌아온 경우 새 비밀번호를 받는다. */
async function handlePasswordRecovery() {
  const next = prompt("새 비밀번호를 입력해줘 (8자 이상)");
  if (!next) return;
  if (next.length < 8) {
    alert("비밀번호는 8자 이상이어야 해.");
    return;
  }
  const { error } = await teamCloud.client.auth.updateUser({ password: next });
  alert(error ? "비밀번호를 바꾸지 못했어." : "비밀번호를 변경했어.");
}

async function signOut() {
  if (teamCloud.client) await teamCloud.client.auth.signOut();
  teamCloud.user = null;
  teamCloud.profile = null;
  teamCloud.teamId = null;
  teamCloud.isLeader = false;
  teamCloud.inviteCode = "";
  teamCloud.members = [];
  teamCloud.memberStatus = new Map();
  teamCloud.myLoggedDates = new Set();
  teamCloud.myOvertimeByDate = new Map();
  teamCloud.myWorkStatusByDate = new Map();
  kosisKey = "";   // 남의 계정으로 갈아타는 자리라 인증키는 메모리에서도 지운다
  closeLoginModal();
}

/* ------------------------------------------------------------------ 팀 배정

   로그인은 됐는데 아직 팀이 없는 경우를 처리한다.
   가입할 때 넣어둔 의도(user_metadata)가 있으면 그대로 실행하고,
   없으면 팀 배정 모달을 띄운다.
--------------------------------------------------------------------------- */

async function ensureTeamMembership() {
  if (!teamCloud.client || !teamCloud.user) return;
  if (teamCloud.teamId) return;

  const meta = teamCloud.user.user_metadata || {};
  const displayName = (meta.display_name || "").trim()
    || (data.settings.userName || "").trim()
    || (teamCloud.user.email || "팀원").split("@")[0];
  const jobTitle = meta.job_title || data.settings.jobTitle || "";

  if (meta.want_leader === true && meta.team_name) {
    const ok = await runCreateTeam(meta.team_name, displayName, jobTitle);
    if (ok) return;
  } else if (meta.invite_code) {
    const ok = await runJoinTeam(meta.invite_code, displayName, jobTitle);
    if (ok) return;
  }

  openTeamSetupModal();
}

async function runCreateTeam(teamName, displayName, jobTitle) {
  const { data: code, error } = await teamCloud.client.rpc("create_team", {
    team_name: teamName,
    display_name: displayName,
    job_title: jobTitle
  });
  if (error) {
    console.error(error);
    setTeamSetupMessage(error.message || "팀을 만들지 못했어.", true);
    return false;
  }
  teamCloud.inviteCode = code || "";
  await loadTeamMeta();
  return true;
}

async function runJoinTeam(inviteCode, displayName, jobTitle) {
  const { error } = await teamCloud.client.rpc("join_team", {
    invite_code: inviteCode,
    display_name: displayName,
    job_title: jobTitle
  });
  if (error) {
    console.error(error);
    setTeamSetupMessage(error.message || "팀에 참여하지 못했어.", true);
    return false;
  }
  await loadTeamMeta();
  return true;
}

/* 팀 배정 모달 (메타데이터가 없거나 실패했을 때) */

function setTeamSetupMessage(text, isError = false) {
  const el = $("teamSetupMessage");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "var(--red)" : "var(--muted)";
}

function openTeamSetupModal() {
  const modal = $("teamSetupModal");
  if (!modal) return;
  $("teamSetupDisplayName").value =
    (data.settings.userName || "").trim() ||
    (teamCloud.user?.email || "").split("@")[0];
  $("teamSetupJobTitle").value = data.settings.jobTitle || "";
  updateTeamSetupFields();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeTeamSetupModal() {
  const modal = $("teamSetupModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function updateTeamSetupFields() {
  const asLeader = $("teamSetupAsLeader").checked;
  $("teamSetupTeamNameField").style.display = asLeader ? "block" : "none";
  $("teamSetupInviteField").style.display = asLeader ? "none" : "block";
}

async function submitTeamSetup() {
  const displayName = $("teamSetupDisplayName").value.trim();
  const jobTitle = $("teamSetupJobTitle").value;
  const asLeader = $("teamSetupAsLeader").checked;
  const teamName = $("teamSetupTeamName").value.trim();
  const inviteCode = $("teamSetupInviteCode").value.trim();

  if (!displayName) {
    setTeamSetupMessage("이름을 입력해줘.", true);
    return;
  }
  if (asLeader && !teamName) {
    setTeamSetupMessage("팀 이름을 입력해줘.", true);
    return;
  }
  if (!asLeader && !inviteCode) {
    setTeamSetupMessage("초대코드를 입력해줘.", true);
    return;
  }

  const btn = $("teamSetupSubmit");
  btn.disabled = true;
  btn.textContent = "처리 중...";

  const ok = asLeader
    ? await runCreateTeam(teamName, displayName, jobTitle)
    : await runJoinTeam(inviteCode, displayName, jobTitle);

  btn.disabled = false;
  btn.textContent = "완료";

  if (!ok) return;

  data.settings.userName = displayName;
  data.settings.jobTitle = jobTitle;
  persist();
  closeTeamSetupModal();
  updateBranding();
  renderAll();
  await refreshTeamMembers();
}
