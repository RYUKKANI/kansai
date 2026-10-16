import test from "node:test";
import assert from "node:assert/strict";

// 실제 플래그 활성 빌드의 SDK·관리 화면을 실행하고 서버 응답만 대체합니다.
// 프로필 수정과 승인된 실명 확인은 구분하며, 계정 값은 서버 RPC에서만 받습니다.
const enabled = Boolean(process.env.STAFF_IDENTITY_TEST_DIST);
const helper = enabled ? await import("./helpers/admin-app.mjs") : null;
const uid = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-16T05:30:00Z";
const owner = {
  user_id: uid, username: "legacy.owner", real_name: "佐藤 テスト",
  department: null, approval_status: "approved", role: "owner", active: true,
  email_confirmed: true, identity_enrolled: false, name_verified_at: null,
  name_verified_by: null, approved_real_name: null, legacy_account: true,
  name_request: null, profile_enrollment_pending: true,
  name_edit_mode: "unverified_edit", can_edit_real_name: true,
};
function name(request) { return new URL(request.url).pathname.split("/").pop(); }
async function ready(context) {
  await helper.eventually(() => !context.window.document.querySelector("#workspace").hidden &&
    context.window.document.querySelectorAll(".admin-stat").length > 0);
}
async function dispose(context) {
  context.window.document.querySelector("#logout-button")?.click();
  await new Promise(resolve => setTimeout(resolve, 15));
  context.dom.window.close();
}
function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

for (const [lang, unverified] of [["ja", "実名未確認"], ["ko", "실명 미확인"], ["en", "Real name unverified"]]) {
  test(`registered but unverified legacy name remains visible in ${lang} header`, { skip: !enabled }, async () => {
    const context = await helper.app("owner", `https://kansaiunited.com/admin/?lang=${lang}`, {
      initialSession: true, staffIdentity: true, accountState: owner,
    });
    try {
      await ready(context);
      const document = context.window.document;
      assert.equal(document.querySelector("#account-email").textContent, owner.real_name);
      assert.equal(document.querySelector("#account-avatar").textContent, "佐藤");
      const status = document.querySelector("#account-name-status");
      assert.equal(status.hidden, false);
      assert.equal(status.textContent, unverified);
      assert.ok(document.querySelector("#account-role").textContent);
      assert.ok(document.querySelector('[data-resource="staff_applications"]'));
      assert.equal(context.requests.some(request => name(request) === "staff-auth"), false);
    } finally { await dispose(context); }
  });
}

test("header uses server username for missing name and hides unverified label only after server verification", { skip: !enabled }, async () => {
  let account = { ...owner, real_name: null };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => account,
  });
  try {
    await ready(context);
    const document = context.window.document;
    assert.equal(document.querySelector("#account-email").textContent, owner.username);
    assert.equal(document.querySelector("#account-avatar").textContent, "LE");
    assert.equal(document.querySelector("#account-name-status").hidden, false);
    const originalView = document.querySelector("#admin-content").firstElementChild;
    account = { ...owner, real_name: "李 Jean-Luc", approved_real_name: "李 Jean-Luc",
      identity_enrolled: true, name_verified_at: now,
      name_verified_by: "00000000-0000-4000-8000-000000000002" };
    context.window.dispatchEvent(new context.window.Event("focus"));
    await helper.eventually(() => document.querySelector("#account-email").textContent === account.real_name);
    assert.equal(document.querySelector("#account-name-status").hidden, true);
    assert.equal(document.querySelector("#account-name-status").textContent, "");
    assert.equal(document.querySelector("#admin-content").firstElementChild, originalView,
      "same UUID and role revalidation must not replace the current private workspace");
    assert.equal(context.requests.filter(request => name(request) === "office_capabilities").length, 1);
  } finally { await dispose(context); }
});

test("header change respects server role instead of Auth user metadata and renders name as text", { skip: !enabled }, async () => {
  const account = { ...owner, role: "staff", real_name: '<img src=x onerror="throw 1"> 李' };
  const context = await helper.app("staff", undefined, {
    initialSession: true, staffIdentity: true, accountState: account,
  });
  try {
    await ready(context);
    const document = context.window.document;
    assert.equal(document.querySelector("#account-email").textContent, account.real_name);
    assert.equal(document.querySelector("#account-email img"), null);
    assert.equal(document.querySelector('[data-resource="staff_applications"]'), null,
      "the fixture contains metadata role owner, which must never grant Owner navigation");
  } finally { await dispose(context); }
});

test("successful self Owner identity edit refreshes header from account RPC without another login", { skip: !enabled }, async () => {
  let account = { ...owner };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => ({ ...account }),
    rpc(rpc, args) {
      if (rpc === "office_staff_applications") return [{ ...account }];
      if (rpc === "office_owner_account") return { ...account, can_edit_real_name: true, password_is_set: true };
      if (rpc === "office_owner_update_identity") {
        account = { ...account, username: args.p_username, real_name: args.p_real_name };
        return { ...account, can_edit_real_name: true, password_is_set: true };
      }
      return [];
    },
  });
  try {
    await ready(context);
    const document = context.window.document;
    document.querySelector('[data-resource="staff_applications"]').click();
    await helper.eventually(() => Boolean(document.querySelector(`[data-owner-account-target="${uid}"]`)));
    document.querySelector(`[data-owner-account-target="${uid}"]`).click();
    await helper.eventually(() => Boolean(document.querySelector('[data-owner-form="identity"]')));
    const form = document.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("username").value = "renamed.owner";
    form.elements.namedItem("real_name").value = "佐藤 李";
    form.elements.namedItem("reason").value = "氏名の表記を訂正";
    form.dispatchEvent(new context.window.Event("submit", { bubbles: true, cancelable: true }));
    await helper.eventually(() => document.querySelector("#account-email").textContent === "佐藤 李");
    assert.equal(document.querySelector("#account-name-status").hidden, false,
      "manual profile changes do not confer real-name verification");
    assert.equal(document.querySelector("#workspace").hidden, false);
    assert.equal(account.user_id, uid);
    assert.equal(context.requests.some(request => name(request) === "staff-auth"), false);
    assert.equal(context.requests.some(request => name(request) === "logout"), false);
  } finally { await dispose(context); }
});

test("own unverified name save restores enrollment action and migration reads the latest registered name", { skip: !enabled }, async () => {
  let account = { ...owner };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => ({ ...account }),
    rpc(rpc, args) {
      if (rpc === "office_update_unverified_name") {
        account = { ...account, real_name: args.p_real_name };
        return { ...account };
      }
      return [];
    },
  });
  try {
    await ready(context);
    const document = context.window.document;
    document.querySelector('[data-resource="staff_account"]').click();
    await helper.eventually(() => Boolean(document.querySelector('[data-staff-action="update-unverified-name"]')) &&
      Boolean(document.querySelector("[data-staff-migration]")));
    assert.equal(document.querySelector("[data-staff-migration]").textContent, "実名と所属・担当業務の登録を完了");
    const form = document.querySelector('[data-staff-action="update-unverified-name"]').closest("form");
    form.elements.namedItem("real_name").value = "姜 Jean-Luc";
    form.elements.namedItem("reason").value = "正式な表記を登録";
    form.dispatchEvent(new context.window.Event("submit", { bubbles: true, cancelable: true }));
    await helper.eventually(() => document.querySelector("#account-email").textContent === "姜 Jean-Luc" &&
      Boolean(document.querySelector("[data-staff-migration]")));
    const enrollment = document.querySelector("[data-staff-migration]");
    enrollment.focus();
    const before = context.requests.filter(request => name(request) === "office_account_state").length;
    context.window.dispatchEvent(new context.window.Event("focus"));
    await helper.eventually(() => context.requests.filter(request => name(request) === "office_account_state").length > before);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(document.querySelector("[data-staff-migration]"), enrollment,
      "identity refresh must preserve the enrollment button and keyboard focus");
    assert.equal(document.activeElement, enrollment);
    enrollment.click();
    await helper.eventually(() => !document.querySelector('[data-staff-panel="migration"]').hidden);
    assert.equal(document.querySelector("#staff-enroll-real-name").value, "姜 Jean-Luc");
    assert.equal(document.querySelector("#staff-enroll-username").value, owner.username);
    assert.equal(document.querySelector("#staff-enroll-username").readOnly, true);
  } finally { await dispose(context); }
});

test("opening account page refreshes a remotely changed profile before enrollment without a focus event", { skip: !enabled }, async () => {
  let account = { ...owner };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => ({ ...account }),
  });
  try {
    await ready(context);
    const document = context.window.document;
    assert.equal(document.querySelector("#account-email").textContent, owner.real_name);
    account = { ...account, username: "latest.owner", real_name: "最新 テスト" };
    document.querySelector('[data-resource="staff_account"]').click();
    await helper.eventually(() => Boolean(document.querySelector("[data-staff-migration]")));
    assert.equal(document.querySelector("#account-email").textContent, "最新 テスト");
    document.querySelector("[data-staff-migration]").click();
    await helper.eventually(() => !document.querySelector('[data-staff-panel="migration"]').hidden);
    assert.equal(document.querySelector("#staff-enroll-real-name").value, "最新 テスト");
    assert.equal(document.querySelector("#staff-enroll-username").value, "latest.owner");
    assert.equal(document.querySelector("#staff-enroll-username").readOnly, true);
    assert.equal(context.requests.some(request => name(request) === "staff-auth"), false);
  } finally { await dispose(context); }
});

test("same-role account switch clears the previous private view before the next identity settles and ignores old responses", { skip: !enabled }, async () => {
  const oldResponse = deferred();
  const nextResponse = deferred();
  const nextUid = "00000000-0000-4000-8000-000000000003";
  const nextAccount = { ...owner, user_id: nextUid, username: "second.owner", real_name: "別人 テスト" };
  let account = { ...owner };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true, accountState: () => ({ ...account }),
    rpc(rpc, args) {
      if (rpc === "office_update_unverified_name") {
        account = { ...account, real_name: args.p_real_name };
        return { ...account };
      }
      return [];
    },
  });
  try {
    await ready(context);
    const document = context.window.document;
    const originalRoleLabel = document.querySelector("#account-role").textContent;
    document.querySelector('[data-resource="staff_account"]').click();
    await helper.eventually(() => Boolean(document.querySelector("[data-staff-migration]")));
    const oldForm = document.querySelector('[data-staff-action="update-unverified-name"]').closest("form");
    let authReads = 0;
    let stateReads = 0;
    const originalFetch = context.window.fetch;
    context.window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, context.window.location.href);
      const path = url.pathname;
      const record = () => context.requests.push({ url: url.href, method: options.method ?? "GET", body: options.body });
      if (path.endsWith("/auth/v1/user")) {
        authReads++;
        if (authReads === 1) return originalFetch(input, options);
        record();
        return Response.json({ id: nextUid, email: "second@example.invalid", aud: "authenticated", role: "authenticated",
          user_metadata: {}, app_metadata: {}, created_at: now });
      }
      if (path.endsWith("/rpc/office_account_state")) {
        record();
        stateReads++;
        if (stateReads === 1) return Response.json(await oldResponse.promise);
        if (stateReads === 2) return Response.json({ ...account });
        if (stateReads === 3) return Response.json(await nextResponse.promise);
        return Response.json(nextAccount);
      }
      if (path.endsWith("/admin_roles") && url.searchParams.get("user_id") === "eq." + nextUid) {
        record();
        return Response.json([{ user_id: nextUid, email: "second@example.invalid", role: "owner", active: true }]);
      }
      return originalFetch(input, options);
    };
    // 백그라운드의 이전 계정 조회가 늦는 동안, 저장 후 직접 재검증에서 다른 계정이 확인되는 상황입니다.
    document.dispatchEvent(new context.window.Event("visibilitychange"));
    await helper.eventually(() => stateReads === 1);
    oldForm.elements.namedItem("real_name").value = "保存中 テスト";
    oldForm.elements.namedItem("reason").value = "氏名の表記を訂正";
    oldForm.dispatchEvent(new context.window.Event("submit", { bubbles: true, cancelable: true }));
    await helper.eventually(() => stateReads === 3);
    assert.equal(oldForm.isConnected, false);
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.equal(document.querySelector("#header-account").hidden, true);
    assert.equal(document.querySelector("#admin-content").children.length, 0);
    assert.equal(document.querySelector("#admin-navigation").children.length, 0);
    oldResponse.release(owner);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(document.querySelector("#workspace").hidden, true,
      "the old account response must not reopen its private view while the next account is pending");
    assert.equal(document.querySelector("#account-email").textContent, "");
    nextResponse.release(nextAccount);
    await helper.eventually(() => document.querySelector("#account-email").textContent === nextAccount.real_name &&
      !document.querySelector("#workspace").hidden && document.querySelectorAll(".admin-stat").length > 0);
    assert.equal(document.querySelector("#account-role").textContent, originalRoleLabel);
    assert.equal(oldForm.isConnected, false);
  } finally { oldResponse.release(owner); nextResponse.release(nextAccount); await dispose(context); }
});

test("queued focus revalidation discards older identity before displaying latest server name", { skip: !enabled }, async () => {
  const pending = deferred();
  let nextRead = null;
  let reads = 0;
  let account = { ...owner, real_name: "Initial" };
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true,
    accountState() { reads++; return nextRead ? nextRead() : { ...account }; },
  });
  try {
    await ready(context);
    const document = context.window.document;
    const seen = [];
    const observer = new context.window.MutationObserver(() => seen.push(document.querySelector("#account-email").textContent));
    observer.observe(document.querySelector("#account-email"), { childList: true });
    const before = reads;
    nextRead = () => { nextRead = null; return pending.promise; };
    document.dispatchEvent(new context.window.Event("visibilitychange"));
    await helper.eventually(() => reads > before);
    account = { ...owner, real_name: "Latest" };
    context.window.dispatchEvent(new context.window.Event("focus"));
    pending.release({ ...owner, real_name: "Stale" });
    await helper.eventually(() => document.querySelector("#account-email").textContent === "Latest");
    assert.equal(seen.includes("Stale"), false,
      "a queued newer revalidation invalidates the in-flight identity immediately");
    observer.disconnect();
  } finally { pending.release(owner); await dispose(context); }
});

test("logout clears identity and prevents late account response from reopening private workspace", { skip: !enabled }, async () => {
  const pending = deferred();
  let nextRead = null;
  let reads = 0;
  const context = await helper.app("owner", undefined, {
    initialSession: true, staffIdentity: true,
    accountState() { reads++; return nextRead ? nextRead() : owner; },
  });
  try {
    await ready(context);
    const document = context.window.document;
    const before = reads;
    nextRead = () => { nextRead = null; return pending.promise; };
    document.dispatchEvent(new context.window.Event("visibilitychange"));
    await helper.eventually(() => reads > before);
    document.querySelector("#logout-button").click();
    await helper.eventually(() => document.querySelector("#workspace").hidden);
    pending.release(owner);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.equal(document.querySelector("#header-account").hidden, true);
    for (const selector of ["#account-email", "#account-role", "#account-avatar", "#account-name-status"])
      assert.equal(document.querySelector(selector).textContent, "");
    assert.equal(document.querySelector("#account-name-status").hidden, true);
    assert.equal(document.querySelector("#admin-content").children.length, 0);
    assert.equal(document.querySelector("#admin-navigation").children.length, 0);
  } finally { pending.release(owner); await dispose(context); }
});
