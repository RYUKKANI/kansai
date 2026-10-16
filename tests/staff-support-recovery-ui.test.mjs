import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

// [편집 안내] 실제 기기 복구 양식과 컨트롤러를 실행합니다. 비밀번호와 기기 증명은 격리된 가짜 값만 사용합니다.
const markup = (await readFile("src/components/StaffSupportRecovery.astro", "utf8"))
  .replace(/^---[\s\S]*?---/, "").replace(/<script[\s\S]*?<\/script>/g, "");
const bundle = (await build({ entryPoints: ["src/scripts/staff-support-recovery.ts"], bundle: true, write: false,
  format: "iife", globalName: "SupportUI", define: { "import.meta.env.BASE_URL": '"/"',
    "import.meta.env.PUBLIC_SUPABASE_URL": '""', "import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY": '""' } })).outputFiles[0].text;
const KEY = "kansai-owner-recovery-device-v1";
const FP = "abcdef1234567890";
const PASSWORD = "isolated-test-password-only";
async function eventually(condition) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(condition(), "Support UI did not reach expected state");
}
function app({ language = "ko", request, initial, blockedStorage = false } = {}) {
  const dom = new JSDOM(`<main data-enabled="false">${markup}</main>`, { url: `https://club.example.invalid/admin/help/?lang=${language}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Response, Request, Headers });
  if (initial) window.sessionStorage.setItem(KEY, JSON.stringify(initial));
  window.eval(bundle + "\nwindow.__supportUI = SupportUI;");
  const root = window.document.querySelector("#staff-support-recovery-root");
  const calls = [];
  const state = { current: "requested", expires: new Date(Date.now() + 300000).toISOString() };
  const controller = window.__supportUI.mountStaffSupportRecovery({ root,
    storage: blockedStorage ? { getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem() {} } : window.sessionStorage,
    request: async body => {
      calls.push(structuredClone(body));
      if (request) return request(body);
      if (body.action === "support_recovery_request") return { success: true, code: "support_recovery_requested", request_id: body.request_id, device_fingerprint: FP, expires_at: state.expires };
      if (body.action === "support_recovery_status") return { success: true, code: "support_recovery_status", request_id: body.request_id, device_fingerprint: FP, expires_at: state.expires, state: state.current };
      return { success: true, code: "support_password_updated", request_id: body.request_id };
    } });
  const element = id => root.querySelector(id);
  const submit = id => element(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const idle = () => eventually(() => root.getAttribute("aria-busy") !== "true");
  const create = async () => { element("#staff-support-username").value = "Kiri.Test"; submit("#staff-support-request-form"); await idle(); };
  const approve = async () => { state.current = "approved"; element("#staff-support-check").click(); await idle(); };
  const save = (password = PASSWORD, confirmation = password) => {
    element("#staff-support-password").value = password; element("#staff-support-password-confirm").value = confirmation;
    submit("#staff-support-password-form");
  };
  return { dom, root, controller, state, calls, element, submit, idle, create, approve, save,
    notice: () => element("#staff-support-message").textContent,
    record: () => JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") };
}

test("request has a fresh cryptographic proof, public references only, and grants no password form", async () => {
  const a = app(); await a.create();
  assert.equal(a.calls[0].username, "kiri.test");
  assert.match(a.calls[0].device_secret, /^[a-f0-9]{64}$/);
  assert.match(a.calls[0].request_id, /^[a-f0-9-]{36}$/);
  assert.equal(a.element("#staff-support-request-id").textContent, a.calls[0].request_id);
  assert.equal(a.element("#staff-support-fingerprint").textContent, "ABCD-EF12-3456-7890");
  assert.equal(a.root.outerHTML.includes(a.calls[0].device_secret), false);
  assert.equal(a.element("#staff-support-password-form").hidden, true);
  assert.equal(a.record().deviceSecret, a.calls[0].device_secret);
  a.controller.destroy(); a.dom.window.close();
});
test("approval opens password fields and shows the shorter server expiry", async () => {
  const a = app(); await a.create();
  const original = a.element("#staff-support-expiry").textContent;
  a.state.expires = new Date(Date.now() + 60000).toISOString(); await a.approve();
  assert.equal(a.element("#staff-support-password-form").hidden, false);
  assert.notEqual(a.element("#staff-support-expiry").textContent, original);
  assert.equal(a.record().expiresAt, a.state.expires);
  a.dom.window.close();
});
test("password validation rejects mismatches and overlong UTF-8 without sending", async () => {
  const a = app(); await a.create(); await a.approve();
  a.save(PASSWORD, "different-test-only"); await a.idle();
  assert.equal(a.calls.filter(c => c.action === "support_recovery_complete").length, 0);
  a.save("한".repeat(25)); await a.idle();
  assert.equal(a.calls.filter(c => c.action === "support_recovery_complete").length, 0);
  a.dom.window.close();
});
test("confirmed save clears credentials and local proof and duplicate submissions cannot reset twice", async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const a = app({ request: async body => {
    if (body.action === "support_recovery_request") return { success: true, code: "support_recovery_requested", request_id: body.request_id, device_fingerprint: FP, expires_at: new Date(Date.now()+300000).toISOString() };
    if (body.action === "support_recovery_status") return { success: true, code: "support_recovery_status", request_id: body.request_id, device_fingerprint: FP, expires_at: new Date(Date.now()+300000).toISOString(), state: "approved" };
    await waiting; return { success: true, code: "support_password_updated", request_id: body.request_id };
  } });
  await a.create(); await a.approve(); a.save(); a.submit("#staff-support-password-form");
  await eventually(() => a.calls.some(c => c.action === "support_recovery_complete"));
  assert.equal(a.element("#staff-support-password").value, "");
  assert.equal(a.record().attempted, true);
  release(); await a.idle();
  assert.match(a.notice(), /저장했습니다/);
  assert.equal(a.record(), null);
  assert.equal(a.calls.filter(c => c.action === "support_recovery_complete").length, 1);
  a.dom.window.close();
});
for (const reply of [{}, { success: false }, { success: true, code: "support_password_already_updated" }]) {
  test(`unexpected completion ${JSON.stringify(reply)} is uncertain, never a new successful password change`, async () => {
    const a = app(); await a.create(); await a.approve();
    // 기존 클라이언트의 네트워크 함수만 불확실한 결과로 대체하기 위해 새 컨트롤러로 탭 재개를 재현합니다.
    const saved = a.record(); a.dom.window.close();
    const b = app({ initial: saved, request: async body => body.action === "support_recovery_status"
      ? { success: true, code: "support_recovery_status", request_id: body.request_id, device_fingerprint: FP, expires_at: saved.expiresAt, state: "approved" }
      : { ...reply, request_id: body.request_id } });
    await b.approve(); b.save(); await b.idle();
    assert.match(b.notice(), /다시 제출하지/);
    assert.equal(b.element("#staff-support-password-form").hidden, true);
    b.save(); await b.idle(); assert.equal(b.calls.filter(c=>c.action==="support_recovery_complete").length,1);
    b.dom.window.close();
  });
}
test("reloading an attempted request never automatically re-enables or resubmits the password", async () => {
  const a = app(); await a.create(); const saved = { ...a.record(), attempted: true }; a.dom.window.close();
  const b = app({ initial: saved }); await b.approve();
  assert.equal(b.element("#staff-support-password-form").hidden, true);
  assert.match(b.notice(), /다시 제출하지/);
  assert.equal(b.calls.filter(c=>c.action==="support_recovery_complete").length,0);
  b.state.current = "succeeded"; b.element("#staff-support-check").click(); await b.idle();
  assert.match(b.notice(), /저장했습니다/); assert.equal(b.record(),null);
  b.dom.window.close();
});
test("a known failed terminal request can be closed, with a new approval required", async () => {
  const a = app(); await a.create(); const saved = { ...a.record(), attempted: true }; a.dom.window.close();
  const b = app({ initial: saved }); b.state.current="failed"; b.element("#staff-support-check").click(); await b.idle();
  b.element("#staff-support-forget").click();
  assert.equal(b.element("#staff-support-request-form").hidden,false);
  assert.equal(b.element("#staff-support-password-form").hidden,true);
  assert.equal(b.record(),null); b.dom.window.close();
});
test("unavailable sessionStorage prevents creation of an unusable request", async () => {
  const a = app({blockedStorage:true}); await a.create();
  assert.equal(a.calls.length,0); assert.match(a.notice(),/유지할 수 없습니다/); a.dom.window.close();
});
for (const [language, expected] of [["ja",/管理者/],["ko",/관리자/],["en",/administrator/]]) {
  test(`support status uses ${language} without translating the account identifier`,async()=>{
    const a=app({language}); await a.create(); assert.match(a.notice(),expected); assert.equal(a.calls[0].username,"kiri.test"); a.dom.window.close();
  });
}
