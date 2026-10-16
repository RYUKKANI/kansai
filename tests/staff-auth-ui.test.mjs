import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// [편집 안내] 실제 양식 마크업과 실제 브라우저 컨트롤러를 함께 검사합니다.
// 네트워크 경계만 대체하므로 메일 발송이나 운영 계정 변경은 발생하지 않습니다.
const portalSource = await readFile("src/components/admin/StaffAuthPortal.astro", "utf8");
const helpSource = await readFile("src/pages/admin/help.astro", "utf8");
function markup(source) {
  return source.replace(/^---[\s\S]*?---/, "")
    .replace(/src=\{asset\(club.logo\)\}/g, 'src="/assets/club-profile.jpg"')
    .replace(/href=\{help\}/g, 'href="/admin/help/"')
    .replace(/<script[\s\S]*?<\/script>/g, "");
}
const defines = {
  "import.meta.env.BASE_URL": '"/"',
  "import.meta.env.PUBLIC_SUPABASE_URL": '""',
  "import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY": '""',
};
const [portalBundle, helpBundle, languageBundle] = await Promise.all([
  build({ entryPoints: ["src/scripts/staff-auth.ts"], bundle: true, write: false, format: "iife", globalName: "StaffAuth", define: defines }),
  build({ entryPoints: ["src/scripts/staff-auth-help.ts"], bundle: true, write: false, format: "iife", globalName: "StaffHelp", define: defines }),
  build({ entryPoints: ["src/scripts/languages.ts"], bundle: true, write: false, format: "iife", globalName: "StaffLanguages", define: defines }),
]);
async function eventually(condition) {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), "Authentication UI did not reach expected state");
}
const recoveryClaims = (overrides = {}) => ({ data: { claims: { sub: "unchanged-user-id", amr: [{ method: "recovery", timestamp: Date.now() / 1000 }], ...overrides } }, error: null });
function application({ help = false, invoke, getUser, getClaims, initialize, recoveryError, signOut, language = "ja", query = "" } = {}) {
  const html = help
    ? markup(helpSource).replace(/data-enabled=\{String\(enabled\)\}/g, 'data-enabled="false"')
    : markup(portalSource);
  const dom = new JSDOM(html, { url: `https://kansaiunited.com/admin/${help ? "help/" : ""}?lang=${language}${query}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(window, { Response, Request, Headers });
  const requests = [];
  const sessions = [];
  let refreshCount = 0;
  let getUserCount = 0;
  let signOutCount = 0;
  let authListener;
  const client = {
    functions: { async invoke(name, options) {
      requests.push({ name, body: structuredClone(options.body), headers: options.headers });
      return invoke ? invoke(options.body) : { data: {
        success: true,
        code: ({ register: "registration_received", recovery: "recovery_received", legacy_login: "legacy_link_received", set_password: "password_updated" })[options.body.action],
      }, error: null };
    } },
    auth: {
      async initialize() { return initialize ? initialize() : { error: null }; },
      async resetPasswordForEmail(email) {
        requests.push({ name: "auth.recovery", body: { action: "recovery", email } });
        return { data: {}, error: recoveryError ?? null };
      },
      async setSession(session) { sessions.push(session); return { data: {}, error: null }; },
      async getSession() { return { data: { session: { access_token: "verified-staff-token" } }, error: null }; },
      async getUser(token) { getUserCount++; return getUser ? getUser(token) : { data: { user: { id: "unchanged-user-id" } }, error: null }; },
      async getClaims(token) { return getClaims ? getClaims(token) : recoveryClaims({ amr: [{ method: "password", timestamp: Date.now() / 1000 }] }); },
      async signOut(options) { signOutCount++; if (signOut) return signOut(options); authListener?.("SIGNED_OUT"); return { error: null }; },
      onAuthStateChange(listener) { authListener = listener; return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  window.eval(languageBundle.outputFiles[0].text + "\nStaffLanguages.initLanguageSwitcher(true);");
  window.eval((help ? helpBundle : portalBundle).outputFiles[0].text + `\nwindow.__staffModule = ${help ? "StaffHelp" : "StaffAuth"};`);
  const controller = help
    ? window.__staffModule.mountStaffAuthHelp({ root: window.document.querySelector("#staff-auth-help"), client })
    : window.__staffModule.mountStaffAuth({ client, notice() {}, async refresh() { refreshCount++; } });
  if (!help) controller.showLogin();
  const document = window.document;
  const set = (form, entries) => {
    const element = document.querySelector(form);
    for (const [key, value] of Object.entries(entries)) {
      const input = element.elements.namedItem(key);
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
    }
  };
  const submit = (selector) => document.querySelector(selector).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  return { dom, window, document, controller, requests, sessions, set, submit,
    counts: () => ({ refresh: refreshCount, getUser: getUserCount, signOut: signOutCount }),
    emit: (event, session = { access_token: "verified-recovery-token", user: { id: "unchanged-user-id" } }) => authListener?.(event, session),
  };
}
const signup = { username: "Staff.Name", password: "correct-password-123", password_confirmation: "correct-password-123", real_name: "金 さくら Ana-María", department: "コーチ / Staff", notice_accepted: true };
const account = { user_id: "unchanged-user-id", username: "staff.name", real_name: "金 さくら Ana-María", department: "コーチ", approval_status: "pending", email_confirmed: true, role: null, active: true, identity_enrolled: true, name_verified_at: null, name_verified_by: null, legacy_account: false, name_request: null };

test("ID login normalizes case, clears passwords and prevents duplicate submissions", async () => {
  let resolve;
  const app = application({ invoke: () => new Promise((done) => { resolve = done; }) });
  try {
    app.set("#staff-login-form", { username: "STAFF.Name", password: "secret-password" });
    const toggle = app.document.querySelector('[data-password-toggle="staff-login-password"]');
    toggle.click();
    assert.equal(app.document.querySelector("#staff-login-password").type, "text");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    app.submit("#staff-login-form");
    app.submit("#staff-login-form");
    assert.equal(app.requests.length, 1);
    assert.deepEqual(app.requests[0].body, { action: "login", username: "staff.name", password: "secret-password" });
    assert.equal(app.document.querySelector("#staff-login-password").value, "");
    assert.equal(app.document.querySelector("#staff-login-password").type, "password");
    assert.equal(app.document.querySelector('#staff-login-form button[type="submit"]').disabled, true);
    resolve({ data: { session: { access_token: "verified-access", refresh_token: "verified-refresh" } }, error: null });
    await eventually(() => app.counts().refresh === 1);
    assert.equal(app.sessions.length, 1);
    assert.equal(app.sessions[0].access_token, "verified-access");
    assert.equal(app.document.querySelector("#staff-login-form").hasAttribute("aria-busy"), false);
  } finally { app.dom.window.close(); }
});

test("authentication errors remain generic and focus an accessible error; retry unlocks", async () => {
  const app = application({ invoke: async () => ({ error: { context: Response.json({ error: "rate_limited", email: "secret@example.invalid", message: "secret key" }, { status: 429 }) } }) });
  try {
    app.set("#staff-login-form", { username: "staff.name", password: "secret-password" });
    app.submit("#staff-login-form");
    await eventually(() => app.document.querySelector("#staff-auth-message").dataset.error === "true");
    const message = app.document.querySelector("#staff-auth-message");
    assert.match(message.textContent, /試行回数/);
    assert.doesNotMatch(message.textContent, /secret/);
    assert.equal(message.getAttribute("role"), "alert");
    assert.equal(app.document.activeElement, message);
    assert.equal(app.document.querySelector('#staff-login-form button[type="submit"]').disabled, false);
    assert.equal(app.sessions.length, 0);
  } finally { app.dom.window.close(); }
});

test("a login response received after the controller resets cannot restore the old session", async () => {
  let resolve;
  const app = application({ invoke: () => new Promise((done) => { resolve = done; }) });
  try {
    app.set("#staff-login-form", { username: "staff.name", password: "secret-password" });
    app.submit("#staff-login-form");
    app.controller.showLogin();
    resolve({ data: { session: { access_token: "old-access", refresh_token: "old-refresh" } }, error: null });
    await eventually(() => !app.document.querySelector('#staff-login-form button[type="submit"]').disabled);
    assert.equal(app.sessions.length, 0);
    assert.equal(app.counts().refresh, 0);
  } finally { app.dom.window.close(); }
});

test("registration checks confirmation and sends Unicode real names without granting a role", async () => {
  const app = application();
  try {
    app.document.querySelector('[data-staff-show="signup"]').click();
    app.set("#staff-signup-form", { ...signup, password_confirmation: "different-password" });
    app.submit("#staff-signup-form");
    await eventually(() => app.document.querySelector("#staff-signup-confirm").getAttribute("aria-invalid") === "true");
    assert.equal(app.requests.length, 0);
    assert.equal(app.document.activeElement.id, "staff-signup-confirm");
    app.set("#staff-signup-form", signup);
    app.submit("#staff-signup-form");
    await eventually(() => app.requests.length === 1 && app.document.querySelector('[data-staff-panel="signup"]').hidden);
    const body = app.requests[0].body;
    assert.equal(body.username, "staff.name");
    assert.equal(body.real_name, signup.real_name);
    assert.equal(body.department, signup.department);
    assert.equal(body.notice_accepted, true);
    assert.equal(body.password_confirmation, signup.password_confirmation);
    for (const key of ["email", "role", "actor_id", "user_id", "approval_status", "desired_role"]) assert.equal(key in body, false);
    assert.equal(app.sessions.length, 0);
    assert.equal(app.document.querySelector("#staff-signup-password").value, "");
    assert.match(app.document.querySelector("#staff-auth-message").textContent, /承認状態をご確認/);
    assert.equal(app.document.querySelector('[name="email"]'), null);
    assert.doesNotMatch(app.document.querySelector("#staff-auth-message").textContent, /確認メールをご確認/);
  } finally { app.dom.window.close(); }
});

test("signup rejects over-byte passwords before a request and accepts the native Unicode boundary", async () => {
  const app = application();
  try {
    app.document.querySelector('[data-staff-show="signup"]').click();
    const tooLong = "한".repeat(25);
    app.set("#staff-signup-form", { ...signup, password: tooLong, password_confirmation: tooLong });
    app.submit("#staff-signup-form");
    await eventually(() => app.document.querySelector("#staff-signup-password").getAttribute("aria-invalid") === "true");
    assert.equal(app.requests.length, 0);
    const boundary = "한".repeat(24);
    app.set("#staff-signup-form", { ...signup, password: boundary, password_confirmation: boundary });
    app.submit("#staff-signup-form");
    await eventually(() => app.requests.length === 1);
    assert.equal(app.requests[0].body.password, boundary);
  } finally { app.dom.window.close(); }
});

test("manual-policy state omits mailbox status and does not offer orphan enrollment", () => {
  const app = application();
  try {
    app.controller.showAccount({ ...account, identity_enrolled: false, email_confirmed: true,
      email_confirmation_required: false, email_verification_status: "not_required" });
    const term = [...app.document.querySelectorAll("#staff-account-state dt")].find(node => node.textContent === "メール確認");
    assert.equal(term, undefined);
    assert.doesNotMatch(app.document.querySelector("#staff-account-state").textContent, /メール|email/i);
    assert.equal(app.document.querySelector("#staff-account-enroll").hidden, true);
    assert.equal(app.requests.length, 0);
  } finally { app.dom.window.close(); }
});

test("pending accounts display only their own state and never interpret a real name as markup", () => {
  const app = application();
  try {
    app.controller.showAccount({ ...account, real_name: '<img src="x" onerror="alert(1)">', email_confirmed: false });
    const list = app.document.querySelector("#staff-account-state");
    assert.ok(list.textContent.includes('<img src="x"'));
    assert.equal(list.querySelector("img"), null);
    assert.match(list.textContent, /承認待ち/);
    assert.match(list.textContent, /未確認/);
    assert.equal(app.requests.length, 0);
    assert.equal(app.document.querySelector('[data-staff-panel="login"]').hidden, true);
    assert.equal(app.document.querySelector("#staff-account-enroll").hidden, true);
  } finally { app.dom.window.close(); }
});

for (const [language, heading, status, placeholder] of [["ja", "関係者アカウント", "承認待ち", "ログインID"], ["ko", "관계자 계정", "승인 대기", "로그인 아이디"], ["en", "Club member account", "Awaiting approval", "Login ID"]]) {
  test(`the ${language} UI translates labels and status while preserving the original real name`, () => {
    const app = application({ language });
    try {
      assert.equal(app.document.documentElement.lang, language);
      assert.equal(app.document.querySelector("#staff-auth-heading").textContent, heading);
      assert.equal(app.document.querySelector("#staff-login-username").placeholder, placeholder);
      assert.equal(app.document.querySelector("#staff-signup-username").placeholder, placeholder);
      assert.equal(app.document.querySelector('label[for="staff-login-username"]').textContent, placeholder);
      app.controller.showAccount({ ...account, email_confirmation_required: false, email_verification_status: "not_required" });
      assert.ok(app.document.querySelector("#staff-account-state").textContent.includes(account.real_name));
      assert.ok(app.document.querySelector("#staff-account-state").textContent.includes(status));
      assert.doesNotMatch(app.document.querySelector("#staff-account-state").textContent, /メール|이메일|email/i);
    } finally { app.dom.window.close(); }
  });
}

test("legacy enrollment verifies the existing user and sends identity fields without a replacement UUID", async () => {
  const app = application({ invoke: async () => ({ data: { success: true, account }, error: null }) });
  try {
    app.controller.showMigration({ ...account, username: null, real_name: null, department: null, role: "owner", legacy_account: true, identity_enrolled: false });
    assert.equal(app.document.querySelector("#staff-enroll-real-name").value, "");
    app.set("#staff-enroll-form", { username: "OWNER-Name", real_name: "山田 太郎", department: "Owner", notice_accepted: true });
    app.submit("#staff-enroll-form");
    await eventually(() => app.counts().refresh === 1);
    assert.equal(app.counts().getUser, 1);
    assert.deepEqual(app.requests[0].body, { action: "enroll", username: "owner-name", real_name: "山田 太郎", department: "Owner", notice_accepted: true });
    assert.equal(app.requests[0].headers.Authorization, "Bearer verified-staff-token");
    assert.equal(app.sessions.length, 0);
  } finally { app.dom.window.close(); }
});

test("an existing linked ID stays read-only while the owner supplies their own real name and consent", () => {
  const app = application();
  try {
    app.controller.showMigration({ ...account, username: "linked.owner", real_name: null, department: null, identity_enrolled: false, legacy_account: true });
    assert.equal(app.document.querySelector("#staff-enroll-username").value, "linked.owner");
    assert.equal(app.document.querySelector("#staff-enroll-username").readOnly, true);
    assert.equal(app.document.querySelector("#staff-enroll-real-name").value, "");
    assert.equal(app.document.querySelector("#staff-enroll-department").value, "");
    assert.equal(app.document.querySelector('#staff-enroll-form input[name="notice_accepted"]').checked, false);
    app.controller.showMigration({ ...account, username: null, real_name: null, department: null, identity_enrolled: false });
    assert.equal(app.document.querySelector("#staff-enroll-username").readOnly, false);
  } finally { app.dom.window.close(); }
});

test("a recovery query alone cannot enable password updates even with an existing browser session", async () => {
  const app = application({ help: true, query: "&type=recovery&access_token=untrusted" });
  try {
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    app.set("#staff-new-password-form", { password: "new-password-123", password_confirmation: "new-password-123" });
    app.submit("#staff-new-password-form");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.requests.length, 0);
    assert.equal(app.counts().getUser, 0);
    app.emit("SIGNED_IN");
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { app.dom.window.close(); }
});

test("verified Auth recovery enables password update, clears credentials and closes recovery session", async () => {
  const app = application({ help: true, getClaims: () => recoveryClaims(), query: "&type=recovery#access_token=transient-token" });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    assert.equal(app.counts().getUser, 1);
    assert.equal(app.window.location.hash, "");
    assert.equal(new URL(app.window.location.href).searchParams.has("type"), false);
    app.set("#staff-new-password-form", { password: "new-password-123", password_confirmation: "new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => app.counts().signOut === 1);
    assert.deepEqual(app.requests[0].body, { action: "set_password", password: "new-password-123", password_confirmation: "new-password-123" });
    assert.equal(app.counts().getUser, 3);
    assert.equal(app.requests[0].headers.Authorization, "Bearer verified-recovery-token");
    assert.equal(app.document.querySelector("#staff-new-password").value, "");
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { app.dom.window.close(); }
});

test("invalidated recovery session cannot expose the password form after a delayed user check", async () => {
  let resolve;
  const app = application({ help: true, getClaims: () => recoveryClaims(), getUser: () => new Promise((done) => { resolve = done; }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => Boolean(resolve));
    app.emit("SIGNED_OUT");
    resolve({ data: { user: { id: "old-session" } }, error: null });
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(app.requests.length, 0);
  } finally { app.dom.window.close(); }
});

test("signing in to another account clears an already verified recovery form", async () => {
  let changed = false;
  const app = application({ help: true, getClaims: () => changed ? recoveryClaims({ sub: "different-user-id", amr: [{ method: "password", timestamp: Date.now() / 1000 }] }) : recoveryClaims(), getUser: () => ({ data: { user: { id: changed ? "different-user-id" : "unchanged-user-id" } }, error: null }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "new-password-123", password_confirmation: "new-password-123" });
    changed = true;
    app.emit("SIGNED_IN", { access_token: "different-session", user: { id: "different-user-id" } });
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(app.document.querySelector("#staff-new-password").value, "");
    app.set("#staff-new-password-form", { password: "new-password-123", password_confirmation: "new-password-123" });
    app.submit("#staff-new-password-form");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.requests.length, 0);
  } finally { app.dom.window.close(); }
});

test("help offers administrator recovery guidance and cannot dispatch a new email request", async () => {
  const app = application({ help: true });
  try {
    assert.equal(app.document.querySelector('input[type="email"], [name="email"]'), null);
    assert.equal(app.document.querySelector("#staff-recovery-form"), null);
    assert.equal(app.document.querySelector("#staff-help-legacy"), null);
    assert.match(app.document.querySelector("#staff-help-options").textContent, /管理画面から対応/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.requests.length, 0);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("PASSWORD_RECOVERY event and URL type cannot replace verified recent recovery claims", async () => {
  const app = application({ help: true, query: "&type=recovery" });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => app.counts().getUser === 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(app.requests.length, 0);
  } finally { app.dom.window.close(); }
});

test("initial recovery session resumes after reload; same-account broadcast and refresh preserve typed inputs", async () => {
  const app = application({ help: true, getClaims: () => recoveryClaims() });
  try {
    app.emit("INITIAL_SESSION");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "in-progress-password", password_confirmation: "in-progress-password" });
    for (const event of ["SIGNED_IN", "TOKEN_REFRESHED"]) {
      const before = app.counts().getUser;
      app.emit(event);
      await eventually(() => app.counts().getUser > before);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, false);
      assert.equal(app.document.querySelector("#staff-new-password").value, "in-progress-password");
    }
    app.emit("SIGNED_OUT", null);
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(app.document.querySelector("#staff-new-password").value, "");
  } finally { app.dom.window.close(); }
});

test("stale, mismatched, forged and future recovery claims never resume a password form", async () => {
  const now = Date.now() / 1000;
  for (const result of [
    recoveryClaims({ sub: "someone-else" }),
    recoveryClaims({ amr: [{ method: "recovery", timestamp: now - 901 }] }),
    recoveryClaims({ amr: [{ method: "recovery", timestamp: now + 61 }] }),
    recoveryClaims({ amr: [{ method: "recovery", timestamp: Infinity }] }),
    recoveryClaims({ amr: [{ method: "otp", timestamp: now }] }),
    recoveryClaims({ amr: ["recovery", null, false, { method: "recovery", timestamp: "not-a-number" }] }),
    { data: null, error: { message: "untrusted detail" } },
  ]) {
    const app = application({ help: true, getClaims: () => result });
    try {
      app.emit("INITIAL_SESSION");
      await eventually(() => app.counts().getUser === 1);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
      assert.equal(app.requests.length, 0);
    } finally { app.dom.window.close(); }
  }
});

test("an active recovery form clears when refreshed authentication becomes stale", async () => {
  let stale = false;
  const app = application({ help: true, getClaims: () => recoveryClaims({ amr: [{ method: "recovery", timestamp: Date.now() / 1000 - (stale ? 901 : 10) }] }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "in-progress-password", password_confirmation: "in-progress-password" });
    stale = true;
    app.emit("TOKEN_REFRESHED");
    await eventually(() => app.document.querySelector("#staff-new-password-panel").hidden);
    assert.equal(app.document.querySelector("#staff-new-password").value, "");
    assert.match(app.document.querySelector("#staff-help-message").textContent, /同じブラウザー/);
  } finally { app.dom.window.close(); }
});

test("callback with missing verifier or failed initialization directs to administrator recovery", async () => {
  for (const initialize of [() => ({ error: null }), () => ({ error: { message: "must not echo callback detail" } })]) {
    const app = application({ help: true, query: "&code=unit-test-only-sensitive-code", initialize });
    try {
      await eventually(() => app.document.querySelector("#staff-help-message").dataset.error === "true");
      const notice = app.document.querySelector("#staff-help-message");
      assert.match(notice.textContent, /最新のリンク.*同じブラウザー/);
      assert.doesNotMatch(notice.textContent, /sensitive-code|callback detail/);
      assert.equal(app.window.location.search.includes("code="), false);
      assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
      assert.equal(app.requests.length, 0);
    } finally { app.dom.window.close(); }
  }
});

// 실제 보고된 실패: 같은 계정의 토큰 갱신이 저장 작업의 세대를 바꾸면서,
// 서버에서 저장했어도 화면은 빈 비밀번호 양식으로 남았습니다.
test("a confirmed password save survives a same-account refresh while its request is pending", async () => {
  let finish;
  const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: () => new Promise(resolve => { finish = resolve; }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => Boolean(finish));
    for (const event of ["TOKEN_REFRESHED", "SIGNED_IN"]) app.emit(event);
    finish({ data: { success: true, code: "password_updated" }, error: null });
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("保存しました"));
    assert.equal(app.counts().signOut, 1);
    assert.equal(app.requests.length, 1);
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("a confirmed save never signs out a different account that took over during the request", async () => {
  let finish;
  const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: () => new Promise(resolve => { finish = resolve; }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => Boolean(finish));
    app.emit("SIGNED_IN", { access_token: "different-account-session", user: { id: "different-account" } });
    finish({ data: { success: true, code: "password_updated" }, error: null });
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("保存しました"));
    assert.equal(app.counts().signOut, 0);
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("logout cleanup failure cannot turn a confirmed password change into a failed save", async () => {
  const app = application({ help: true, getClaims: () => recoveryClaims(), signOut: async () => { throw new Error("private cleanup failure"); } });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("保存しました"));
    assert.equal(app.document.querySelector("#staff-help-message").dataset.error, "false");
    assert.doesNotMatch(app.document.querySelector("#staff-help-message").textContent, /private cleanup/);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("missing, false or malformed positive replies cannot become password-save success or an automatic retry", async () => {
  for (const data of [{}, { success: false, code: "password_updated" }, { success: true }, { success: true, code: "recovery_received" }, []]) {
    const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: async () => ({ data, error: null }) });
    try {
      app.emit("PASSWORD_RECOVERY");
      await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
      app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
      app.submit("#staff-new-password-form");
      await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("保存結果を確認できません"));
      assert.equal(app.requests.length, 1);
      assert.equal(app.counts().signOut, 0);
      assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
      assert.equal(app.document.querySelector("#staff-new-password").value, "");
      app.emit("TOKEN_REFRESHED");
      app.set("#staff-new-password-form", { password: "test-second-password-123", password_confirmation: "test-second-password-123" });
      app.submit("#staff-new-password-form");
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(app.requests.length, 1);
      assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
    } finally { app.controller.destroy(); app.dom.window.close(); }
  }
});

test("network loss after dispatch is uncertain and never claims the password stayed unchanged", async () => {
  const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: async () => { throw new Error("private network detail"); } });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("変更された可能性"));
    assert.equal(app.requests.length, 1);
    assert.equal(app.counts().signOut, 0);
    assert.doesNotMatch(app.document.querySelector("#staff-help-message").textContent, /private network detail|保存しました|変更されていません/);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("an explicit native same-password rejection stays actionable without claiming a successful change", async () => {
  const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: async () => ({ data: null, error: { context: Response.json({ error: "same_password", private: "do not display" }, { status: 422 }) } }) });
  try {
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-new-password-123", password_confirmation: "test-new-password-123" });
    app.submit("#staff-new-password-form");
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("現在と同じ"));
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, false);
    assert.equal(app.counts().signOut, 0);
    assert.doesNotMatch(app.document.querySelector("#staff-help-message").textContent, /保存しました|do not display/);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("signup requires its own positive receipt and cannot turn a false result into an accepted application", async () => {
  const app = application({ invoke: async () => ({ data: { success: false, code: "registration_received" }, error: null }) });
  try {
    app.document.querySelector('[data-staff-show="signup"]').click();
    app.set("#staff-signup-form", signup);
    app.submit("#staff-signup-form");
    await eventually(() => app.document.querySelector("#staff-auth-message").dataset.error === "true");
    assert.equal(app.document.querySelector('[data-staff-panel="signup"]').hidden, false);
    assert.doesNotMatch(app.document.querySelector("#staff-auth-message").textContent, /申請を受け付けました/);
    assert.equal(app.sessions.length, 0);
    assert.equal(app.document.querySelector('#staff-signup-form button[type="submit"]').disabled, true);
    app.set("#staff-signup-form", signup);
    app.submit("#staff-signup-form");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.requests.length, 1);
  } finally { app.dom.window.close(); }
});

test("a known unavailable registration is not accepted and can be corrected explicitly", async () => {
  const app = application({ invoke: async () => ({ data: null, error: { context: Response.json({ error: "registration_unavailable" }, { status: 409 }) } }) });
  try {
    app.document.querySelector('[data-staff-show="signup"]').click();
    app.set("#staff-signup-form", signup);
    app.submit("#staff-signup-form");
    await eventually(() => app.document.querySelector("#staff-auth-message").dataset.error === "true");
    assert.equal(app.document.querySelector('[data-staff-panel="signup"]').hidden, false);
    assert.equal(app.document.querySelector('#staff-signup-form button[type="submit"]').disabled, false);
    assert.doesNotMatch(app.document.querySelector("#staff-auth-message").textContent, /申請を受け付けました|作成された可能性/);
  } finally { app.dom.window.close(); }
});

for (const [language, expected] of [["ja", /管理画面から対応/], ["ko", /관리자 화면에서 처리/], ["en", /manage it from the admin page/]]) {
  test(`the ${language} help directs to account management without email fields or mail actions`, async () => {
    const app = application({ help: true, language });
    try {
      assert.match(app.document.querySelector("#staff-help-options").textContent, expected);
      assert.equal(app.document.querySelector('input[type="email"], [name="email"], #staff-recovery-form, #staff-help-legacy'), null);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(app.requests.length, 0);
    } finally { app.controller.destroy(); app.dom.window.close(); }
  });
}

test("existing recovery password save does not change independent device support controls or secrets", async () => {
  let release;
  const app = application({ help: true, getClaims: () => recoveryClaims(), invoke: () => new Promise(resolve => { release = resolve; }) });
  try {
    const support = app.document.createElement("section");
    support.id = "staff-support-recovery";
    support.innerHTML = '<button id="independent-support">Support</button><input autocomplete="new-password" value="support-test-only" type="password">';
    app.document.querySelector("#staff-help-options").prepend(support);
    app.emit("PASSWORD_RECOVERY");
    await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
    app.set("#staff-new-password-form", { password: "test-recovered-password", password_confirmation: "test-recovered-password" });
    app.submit("#staff-new-password-form");
    await eventually(() => app.requests.length === 1);
    assert.equal(app.document.querySelector('#staff-new-password-form button[type="submit"]').disabled, true);
    assert.equal(app.document.querySelector("#independent-support").disabled, false);
    assert.equal(support.querySelector("input").value, "support-test-only");
    release({ data: { success: true, code: "password_updated" }, error: null });
    await eventually(() => app.document.querySelector("#staff-help-message").textContent.includes("保存しました"));
    assert.equal(support.querySelector("input").value, "support-test-only");
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

test("callback provider error parameters are removed without exposing their content", async () => {
  const app = application({ help: true, query: "&error=access_denied&error_code=otp_expired&error_description=private-detail" });
  try {
    await eventually(() => app.document.querySelector("#staff-help-message").dataset.error === "true");
    assert.equal(app.window.location.search, "?lang=ja");
    assert.doesNotMatch(app.document.querySelector("#staff-help-message").textContent, /private-detail|otp_expired/);
    assert.equal(app.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { app.controller.destroy(); app.dom.window.close(); }
});

for (const [language, expected] of [["ja", /変更された可能性/], ["ko", /변경됐을 수 있습니다/], ["en", /password may have changed/]]) {
  test(`the ${language} UI explains an uncertain save without exposing secret values`, async () => {
    const app = application({ help: true, language, getClaims: () => recoveryClaims(), invoke: async () => ({ data: null, error: { context: Response.json({ error: "password_update_uncertain" }, { status: 503 }) } }) });
    try {
      app.emit("PASSWORD_RECOVERY");
      await eventually(() => !app.document.querySelector("#staff-new-password-panel").hidden);
      app.set("#staff-new-password-form", { password: "test-never-display-password-123", password_confirmation: "test-never-display-password-123" });
      app.submit("#staff-new-password-form");
      await eventually(() => app.document.querySelector("#staff-help-message").dataset.error === "true");
      assert.match(app.document.querySelector("#staff-help-message").textContent, expected);
      assert.doesNotMatch(app.document.querySelector("#staff-help-message").textContent, /test-never-display/);
      assert.equal(app.document.activeElement.id, "staff-help-message");
    } finally { app.controller.destroy(); app.dom.window.close(); }
  });
}
