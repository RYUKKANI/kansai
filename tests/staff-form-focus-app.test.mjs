import test from "node:test";
import assert from "node:assert/strict";

// 다른 창·메일 앱에서 돌아오는 동작은 입력 양식의 취소가 아닙니다.
// 실제 플래그 활성 빌드와 SDK를 실행하고, 서버에 보낼 값은 가상의 테스트 데이터만 사용합니다.
const enabled = Boolean(process.env.STAFF_IDENTITY_TEST_DIST);
const helper = enabled ? await import("./helpers/admin-app.mjs") : null;
const uid = "00000000-0000-4000-8000-000000000001";
const legacy = {
  user_id: uid, username: "test.legacy", real_name: "佐藤 テスト", department: null,
  approval_status: "approved", role: "owner", active: true, email_confirmed: true,
  identity_enrolled: false, approved_real_name: null, name_verified_at: null,
  name_verified_by: null, legacy_account: true, legacy: true, name_request: null,
  profile_enrollment_pending: true, name_edit_mode: "unverified_edit", can_edit_real_name: true,
};
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
function restore(context, kind) {
  const { window } = context;
  if (kind === "focus") window.dispatchEvent(new window.Event("focus"));
  else window.document.dispatchEvent(new window.Event("visibilitychange"));
}
async function ready(context) {
  await helper.eventually(() => !context.window.document.querySelector("#workspace").hidden &&
    context.window.document.querySelectorAll(".admin-stat").length > 0);
}
async function dispose(context) {
  context.window.document.querySelector("#logout-button")?.click();
  await settle();
  context.dom.window.close();
}
async function enroll(context) {
  await ready(context);
  const document = context.window.document;
  document.querySelector('[data-resource="staff_account"]').click();
  await helper.eventually(() => Boolean(document.querySelector("[data-staff-migration]")));
  document.querySelector("[data-staff-migration]").click();
  const form = document.querySelector("#staff-enroll-form");
  form.elements.namedItem("real_name").value = "破棄 テスト";
  form.elements.namedItem("department").value = "非公開のテスト担当";
  form.elements.namedItem("notice_accepted").checked = true;
  return form;
}
function assertEnrollmentCleared(form) {
  assert.equal(form.elements.namedItem("username").value, "");
  assert.equal(form.elements.namedItem("username").readOnly, false);
  assert.equal(form.elements.namedItem("real_name").value, "");
  assert.equal(form.elements.namedItem("department").value, "");
  assert.equal(form.elements.namedItem("notice_accepted").checked, false);
}

for (const event of ["focus", "visibility"]) {
  test(`returning through ${event} preserves unsigned signup view and typed fields`, { skip: !enabled }, async () => {
    const context = await helper.app("owner", undefined, { staffIdentity: true });
    try {
      await settle();
      const document = context.window.document;
      document.querySelector('[data-staff-show="signup"]').click();
      const panel = document.querySelector('[data-staff-panel="signup"]');
      const form = document.querySelector("#staff-signup-form");
      form.elements.namedItem("username").value = "signup.test";
      form.elements.namedItem("real_name").value = "登録 テスト";
      form.elements.namedItem("department").value = "運営テスト";
      form.elements.namedItem("email").value = "signup@example.invalid";
      form.elements.namedItem("password").value = "synthetic-test-password";
      form.elements.namedItem("password_confirmation").value = "synthetic-test-password";
      const passwordLength = form.elements.namedItem("password").value.length;
      assert.equal(panel.hidden, false);
      restore(context, event);
      await settle();
      assert.equal(panel.hidden, false, "window restoration must not turn signup back into login");
      assert.equal(form.elements.namedItem("password").value.length, passwordLength,
        "no-session revalidation must not clear unsent signup passwords");
      assert.equal(form.elements.namedItem("username").value, "signup.test");
      assert.equal(form.elements.namedItem("real_name").value, "登録 テスト");
      assert.equal(document.querySelector("#workspace").hidden, true);
      assert.equal(context.requests.some(request => new URL(request.url).pathname.includes("/staff-auth")), false);
    } finally { await dispose(context); }
  });

  test(`returning through ${event} preserves an unsigned login password before submit`, { skip: !enabled }, async () => {
    const context = await helper.app("owner", undefined, { staffIdentity: true });
    try {
      await settle();
      const document = context.window.document;
      const form = document.querySelector("#staff-login-form");
      form.elements.namedItem("username").value = "login.test";
      form.elements.namedItem("password").value = "synthetic-test-password";
      const passwordLength = form.elements.namedItem("password").value.length;
      restore(context, event);
      await settle();
      assert.equal(form.elements.namedItem("password").value.length, passwordLength,
        "window restoration is not a logout and must preserve an unsent login password");
      assert.equal(document.querySelector('[data-staff-panel="login"]').hidden, false);
      assert.equal(document.querySelector("#workspace").hidden, true);
    } finally { await dispose(context); }
  });

  test(`returning through ${event} preserves same-account legacy enrollment view and unsaved profile fields`, { skip: !enabled }, async () => {
    const context = await helper.app("owner", undefined, {
      initialSession: true, staffIdentity: true, accountState: legacy,
    });
    try {
      await ready(context);
      const document = context.window.document;
      document.querySelector('[data-resource="staff_account"]').click();
      await helper.eventually(() => Boolean(document.querySelector("[data-staff-migration]")));
      document.querySelector("[data-staff-migration]").click();
      const panel = document.querySelector('[data-staff-panel="migration"]');
      const form = document.querySelector("#staff-enroll-form");
      form.elements.namedItem("real_name").value = "訂正 テスト";
      form.elements.namedItem("department").value = "運営テスト";
      form.elements.namedItem("notice_accepted").checked = true;
      assert.equal(panel.hidden, false);
      restore(context, event);
      await settle();
      assert.equal(document.querySelector("#staff-auth-portal").hidden, false,
        "same-account revalidation must not hide the profile enrollment portal");
      assert.equal(panel.hidden, false, "same-account revalidation must not close enrollment and open the dashboard");
      assert.equal(document.querySelector("#workspace").hidden, true);
      assert.equal(form.elements.namedItem("real_name").value, "訂正 テスト");
      assert.equal(form.elements.namedItem("department").value, "運営テスト");
      assert.equal(form.elements.namedItem("notice_accepted").checked, true);
      assert.equal(form.elements.namedItem("username").value, legacy.username);
    } finally { await dispose(context); }
  });
}

test("actual sign out discards hidden legacy enrollment and previous account details", { skip: !enabled }, async () => {
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: legacy,
  });
  try {
    const form = await enroll(context);
    const document = context.window.document;
    // 실제 SDK signOut과 SIGNED_OUT 알림을 거치되 운영 계정은 사용하지 않습니다.
    document.querySelector("#logout-button").click();
    await helper.eventually(() => !document.querySelector('[data-staff-panel="login"]').hidden &&
      document.querySelector("#header-account").hidden);
    assertEnrollmentCleared(form);
    assert.equal(document.querySelector("#staff-account-state").children.length, 0);
    assert.equal(document.querySelector("#admin-content").children.length, 0);
    assert.equal(document.querySelector("#admin-navigation").children.length, 0);
    assert.equal(document.querySelector("#workspace").hidden, true);
  } finally { await dispose(context); }
});

test("suspended session closes enrollment and discards drafts on focus revalidation", { skip: !enabled }, async () => {
  let account = { ...legacy };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
  });
  try {
    const form = await enroll(context);
    const document = context.window.document;
    account = { ...legacy, role: null, active: false, approval_status: "suspended", legacy_account: false };
    restore(context, "focus");
    await helper.eventually(() => !document.querySelector('[data-staff-panel="account"]').hidden);
    assertEnrollmentCleared(form);
    assert.equal(document.querySelector('[data-staff-panel="migration"]').hidden, true);
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.equal(document.querySelector("#header-account").hidden, true);
    assert.equal(document.querySelector("#admin-content").children.length, 0);
  } finally { await dispose(context); }
});

test("role withdrawal closes enrollment and rebuilds only the currently permitted navigation", { skip: !enabled }, async () => {
  let account = { ...legacy };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
  });
  try {
    const form = await enroll(context);
    const document = context.window.document;
    account = { ...legacy, role: "coach" };
    context.tables.admin_roles[0].role = "coach";
    restore(context, "visibility");
    await helper.eventually(() => !document.querySelector("#workspace").hidden &&
      !document.querySelector('[data-resource="staff_applications"]'));
    assertEnrollmentCleared(form);
    assert.equal(document.querySelector("#staff-auth-portal").hidden, true);
    assert.equal(document.querySelector('[data-resource="admin_roles"]'), null);
  } finally { await dispose(context); }
});

test("different account UUID closes enrollment and never reuses the previous account profile draft", { skip: !enabled }, async () => {
  let account = { ...legacy };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
  });
  try {
    const form = await enroll(context);
    const document = context.window.document;
    const nextId = "00000000-0000-4000-8000-000000000003";
    account = { ...legacy, user_id: nextId, username: "second.test", real_name: "別人 テスト" };
    context.tables.admin_roles.push({ user_id: nextId, email: "second@example.invalid", role: "owner", active: true });
    const originalFetch = context.window.fetch;
    context.window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, context.window.location.href);
      return url.pathname.endsWith("/auth/v1/user")
        ? Promise.resolve(Response.json({ id: nextId, email: "second@example.invalid", aud: "authenticated", role: "authenticated",
          app_metadata: {}, user_metadata: {}, created_at: "2026-10-16T00:00:00Z" }))
        : originalFetch(input, options);
    };
    restore(context, "focus");
    await helper.eventually(() => !document.querySelector("#workspace").hidden &&
      document.querySelector("#account-email").textContent === account.real_name);
    assertEnrollmentCleared(form);
    assert.equal(document.querySelector("#staff-auth-portal").hidden, true);
  } finally { await dispose(context); }
});

test("same-account revalidation updates an assigned username while preserving unsent enrollment fields", { skip: !enabled }, async () => {
  let account = { ...legacy };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
  });
  try {
    const form = await enroll(context);
    account = { ...legacy, username: "renamed.test" };
    restore(context, "focus");
    await helper.eventually(() => form.elements.namedItem("username").value === "renamed.test");
    assert.equal(form.elements.namedItem("username").readOnly, true);
    assert.equal(form.elements.namedItem("real_name").value, "破棄 テスト");
    assert.equal(form.elements.namedItem("department").value, "非公開のテスト担当");
    assert.equal(form.elements.namedItem("notice_accepted").checked, true);
    assert.equal(context.window.document.querySelector("#staff-auth-portal").hidden, false);
  } finally { await dispose(context); }
});

test("confirmed enrollment save exits the draft view and opens the same approved account", { skip: !enabled }, async () => {
  let account = { ...legacy };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
    staffAuth(payload) {
      assert.equal(payload.action, "enroll");
      account = { ...legacy, real_name: payload.real_name, department: payload.department,
        identity_enrolled: true, profile_enrollment_pending: false };
      return { success: true, account };
    },
  });
  try {
    const form = await enroll(context);
    const document = context.window.document;
    restore(context, "focus");
    await settle();
    assert.equal(document.querySelector("#staff-auth-portal").hidden, false);
    form.dispatchEvent(new context.window.Event("submit", { bubbles: true, cancelable: true }));
    await helper.eventually(() => !document.querySelector("#workspace").hidden &&
      document.querySelector("#account-email").textContent === "破棄 テスト");
    assert.equal(document.querySelector("#staff-auth-portal").hidden, true);
    assert.equal(account.user_id, uid);
    assert.equal(account.role, "owner");
    assert.equal(account.approved_real_name, null);
    assert.equal(document.querySelector("#account-name-status").hidden, false);
    assert.equal(form.elements.namedItem("real_name").value, "");
  } finally { await dispose(context); }
});
