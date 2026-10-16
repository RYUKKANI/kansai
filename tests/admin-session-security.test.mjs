import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { app, eventually, uid } from "./helpers/admin-app.mjs";
import { browserScript } from "./helpers/browser-script.mjs";

// 실제 배포 빌드와 Supabase SDK를 실행하되 계정·토큰·서버 응답은 모두 가상입니다.
// 공격 링크가 저장 세션을 바꾸는 초기화 시점을 검사하므로 로그인 이후 UI 모의 함수로 대체하지 않습니다.
const sessionKey = "kansai-admin-session";
const attackerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const attackerToken = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({
  sub: attackerId, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600,
}) + ".SYNTHETIC-URL-TEST";
const fragment = new URLSearchParams({
  access_token: attackerToken, refresh_token: "SYNTHETIC-URL-REFRESH",
  expires_in: "3600", token_type: "bearer", type: "recovery",
});
const approved = {
  user_id: uid, username: "existing.owner", real_name: "山田 Ana-María", department: "運営",
  approval_status: "approved", role: "owner", active: true, email_confirmed: true,
  identity_enrolled: true, approved_real_name: "山田 Ana-María", legacy_account: true,
  name_verified_at: "2026-10-15T05:00:00Z", name_verified_by: null, legacy: false, name_request: null,
};
const options = { staffIdentity: true, accountState: approved };
const path = (request) => new URL(request.url).pathname;
const saved = (context) => JSON.parse(context.window.localStorage.getItem(sessionKey) ?? "null");
const subject = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
async function ready(context) {
  await eventually(() => !context.window.document.querySelector("#workspace").hidden &&
    context.window.document.querySelectorAll(".admin-stat").length > 0);
}
async function dispose(context) {
  context.window.document.querySelector("#logout-button").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  context.dom.window.close();
}
function assertNoUrlCredentials(context) {
  assert.equal(context.requests.some((request) => request.authorization === "Bearer " + attackerToken), false,
    "a URL token must never authorize an Auth, role, or content request");
  assert.equal(context.requests.some((request) => path(request) === "/auth/v1/token"), false,
    "opening an ordinary office URL must not exchange a code or refresh the supplied URL token");
}

test("actual admin initialization preserves an existing UUID and session when a different account token is in the URL", async () => {
  const context = await app("owner", "https://kansaiunited.com/admin/?lang=ko#" + fragment, {
    ...options, initialSession: true,
  });
  try {
    await ready(context);
    assert.equal(subject(saved(context).access_token), uid);
    assert.equal(saved(context).refresh_token, "TEST-REFRESH");
    assert.equal(saved(context).user.id, uid);
    assertNoUrlCredentials(context);
    assert.equal(context.requests.some((request) => path(request) === "/auth/v1/logout"), false,
      "rejecting a link must preserve the valid account instead of signing it out");
    assert.ok(context.requests.some((request) => path(request) === "/rest/v1/admin_roles" &&
      new URL(request.url).searchParams.get("user_id") === "eq." + uid));
  } finally { await dispose(context); }
});

test("a URL token cannot log a signed-out browser in or open internal office data", async () => {
  const context = await app("owner", "https://kansaiunited.com/admin/#" + fragment, options);
  try {
    // SDK 초기화·Auth 이벤트·역할 조회가 모두 같은 이벤트 루프에서 처리될 시간을 줍니다.
    // 취약했던 빌드에서는 이 시간 안에 토큰이 저장되고 내부 조회가 시작됩니다.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(saved(context), null);
    assert.equal(context.window.document.querySelector("#workspace").hidden, true);
    assert.equal(context.requests.some((request) => path(request).startsWith("/rest/v1/")), false);
    assertNoUrlCredentials(context);
  } finally { await dispose(context); }
});

test("ordinary office initialization never exchanges a URL code even with a locally stored recovery verifier", async () => {
  const verifier = JSON.stringify("synthetic-browser-verifier/recovery");
  const context = await app("owner", "https://kansaiunited.com/admin/?lang=en&code=synthetic-foreign-code", {
    ...options, initialSession: true, initialStorage: { [sessionKey + "-code-verifier"]: verifier },
  });
  try {
    await ready(context);
    assert.equal(subject(saved(context).access_token), uid);
    assert.equal(context.window.localStorage.getItem(sessionKey + "-code-verifier"), verifier,
      "only the dedicated help callback may consume an outstanding recovery verifier");
    assertNoUrlCredentials(context);
  } finally { await dispose(context); }
});

test("normal ID login still authenticates the existing UUID after an untrusted URL is ignored", {
  skip: !process.env.STAFF_IDENTITY_TEST_DIST,
}, async () => {
  const context = await app("owner", "https://kansaiunited.com/admin/#" + fragment, options);
  try {
    const form = context.window.document.querySelector("#staff-login-form");
    assert.ok(form, "requires the staff identity flag-on build");
    form.elements.namedItem("username").value = "EXISTING.Owner";
    form.elements.namedItem("password").value = "synthetic-password-only";
    form.dispatchEvent(new context.window.Event("submit", { bubbles: true, cancelable: true }));
    await ready(context);
    assert.equal(subject(saved(context).access_token), uid);
    assert.equal(saved(context).user.id, uid);
    assert.equal(context.window.document.querySelector("#account-email").textContent, approved.real_name);
    const request = context.requests.find((value) => path(value) === "/functions/v1/staff-auth");
    assert.deepEqual(JSON.parse(request.body), {
      action: "login", username: "existing.owner", password: "synthetic-password-only",
    });
    assertNoUrlCredentials(context);
  } finally { await dispose(context); }
});

// 복구 화면도 실배포와 같은 SDK 생성 경로로 검사합니다. 컨트롤러만 모의 클라이언트에
// 연결하면 SDK 생성 중 이미 저장된 세션이 바뀌는 취약점을 놓칠 수 있습니다.
async function helpApp(address, initialStorage = {}) {
  const buildRoot = process.env.STAFF_IDENTITY_TEST_DIST ?? process.env.ADMIN_TEST_DIST ?? "dist";
  const html = await readFile(nodePath.join(buildRoot, "admin/help/index.html"), "utf8");
  const dom = new JSDOM(html, { url: address, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(window, { TextEncoder, TextDecoder, Request, Response, Headers, AbortController, AbortSignal });
  Object.defineProperty(window, "crypto", { value: webcrypto });
  for (const [name, value] of Object.entries(initialStorage)) window.localStorage.setItem(name, value);
  const requests = [];
  window.fetch = async (input, options = {}) => {
    const request = new Request(input, options);
    requests.push({ url: request.url, authorization: request.headers.get("Authorization") });
    // URL의 가상 계정에 대해 유효한 응답이 와도 세션을 채택해서는 안 됩니다.
    if (new URL(request.url).pathname === "/auth/v1/user") return Response.json({
      id: attackerId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {},
    });
    if (new URL(request.url).pathname === "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [] });
    throw new Error("Unexpected synthetic help Auth operation");
  };
  for (const script of window.document.querySelectorAll("script[src]"))
    window.eval(await browserScript(nodePath.join(buildRoot, new URL(script.src).pathname.replace(/^\//, ""))));
  return { dom, window, requests };
}
function existingSession() {
  return {
    access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({
      sub: uid, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600,
    }) + ".SYNTHETIC-STORED-TEST",
    refresh_token: "SYNTHETIC-EXISTING-REFRESH", token_type: "bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600,
    user: { id: uid, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
  };
}

test("actual help initialization rejects implicit token links without adopting them or replacing an existing session", {
  skip: !process.env.STAFF_IDENTITY_TEST_DIST,
}, async () => {
  for (const stored of [null, existingSession()]) {
    const context = await helpApp("https://kansaiunited.com/admin/help/?lang=en#" + fragment,
      stored ? { [sessionKey]: JSON.stringify(stored) } : {});
    try {
      await eventually(() => context.window.document.querySelector("#staff-help-message").dataset.error === "true");
      assert.deepEqual(saved(context), stored);
      assertNoUrlCredentials(context);
      assert.equal(context.window.document.querySelector("#staff-new-password-panel").hidden, true);
      assert.equal(context.window.location.hash, "");
      assert.equal(context.window.location.search, "?lang=en");
      assert.equal(context.requests.length, 0, "rejected implicit links must never reach Auth or the gateway");
    } finally { context.dom.window.close(); }
  }
});

test("actual help rejects a code without the browser verifier and preserves its existing login", {
  skip: !process.env.STAFF_IDENTITY_TEST_DIST,
}, async () => {
  const stored = existingSession();
  const context = await helpApp("https://kansaiunited.com/admin/help/?lang=ko&code=synthetic-unrequested-code", {
    [sessionKey]: JSON.stringify(stored),
  });
  try {
    await eventually(() => context.window.document.querySelector("#staff-help-message").dataset.error === "true");
    assert.deepEqual(saved(context), stored);
    assert.equal(context.requests.length, 0);
    assert.equal(context.window.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(context.window.location.search, "?lang=ko");
  } finally { context.dom.window.close(); }
});
