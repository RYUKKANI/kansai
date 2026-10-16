import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { createClient } from "@supabase/supabase-js";
import { JSDOM } from "jsdom";

const compiled = await build({ entryPoints: ["src/lib/staff-auth-recovery.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { createStaffRecoveryFetch } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const url = "https://test-project.supabase.co";
const key = "sb_publishable_TEST_ONLY";
function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function sdk(memory, network, extraAuth = {}) {
  return createClient(url, key, {
    auth: { storageKey: "staff-pkce-test", storage: memory, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce", ...extraAuth },
    global: { fetch: createStaffRecoveryFetch(url, key, network) },
  });
}
function session() {
  const user = { id: "00000000-0000-4000-8000-000000000001", email: "test@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const accessToken = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated", amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) }] })).toString("base64url") + ".test-signature";
  return { access_token: accessToken, refresh_token: "test-refresh", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user };
}

test("actual Supabase SDK owns the PKCE verifier and proxies only the recovery challenge through the gateway", async () => {
  const memory = storage();
  const requests = [];
  const response = session();
  const network = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.json() : null;
    requests.push({ url: request.url, headers: request.headers, body });
    if (request.url.endsWith("/functions/v1/staff-auth")) return Response.json({ success: true, code: "recovery_received" });
    if (new URL(request.url).searchParams.get("grant_type") === "pkce") return Response.json(response);
    if (new URL(request.url).pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    throw new Error("Unexpected Auth request");
  };
  const client = sdk(memory, network);
  const events = [];
  const { data: listener } = client.auth.onAuthStateChange((event) => { events.push(event); });
  try {
    const result = await client.auth.resetPasswordForEmail("test@example.invalid", { redirectTo: "https://attacker.invalid/ignored" });
    assert.equal(result.error, null);
    assert.equal(requests.length, 1);
    const recovery = requests[0];
    assert.equal(recovery.url, url + "/functions/v1/staff-auth");
    assert.equal(recovery.headers.get("apikey"), key);
    assert.equal(recovery.headers.get("authorization"), null);
    assert.deepEqual(Object.keys(recovery.body).sort(), ["action", "code_challenge", "code_challenge_method", "email"]);
    assert.equal(recovery.body.action, "recovery");
    assert.equal(recovery.body.code_challenge_method, "s256");
    assert.match(recovery.body.code_challenge, /^[a-zA-Z0-9_-]{43}$/);
    assert.ok([...memory.values.keys()].some((key) => key.endsWith("-code-verifier")));
    assert.ok([...memory.values.values()].some((value) => value.includes("/recovery")));
    // 실제 SDK가 동일한 브라우저 저장소에서 verifier를 찾아 코드 교환을 수행합니다.
    const exchange = await client.auth.exchangeCodeForSession("test-recovery-code");
    assert.equal(exchange.error, null);
    assert.equal(exchange.data.user.id, response.user.id);
    const tokenRequest = requests[1];
    assert.equal(new URL(tokenRequest.url).searchParams.get("grant_type"), "pkce");
    assert.equal(tokenRequest.body.auth_code, "test-recovery-code");
    assert.equal(createHash("sha256").update(tokenRequest.body.code_verifier).digest("base64url"), recovery.body.code_challenge);
    assert.equal(events.includes("PASSWORD_RECOVERY"), true);
    assert.equal(memory.getItem("staff-pkce-test-code-verifier"), null);
    await client.auth.signOut();
    assert.equal([...memory.values.values()].some((value) => value.includes("/recovery")), false);
  } finally { listener.subscription.unsubscribe(); await client.auth.stopAutoRefresh(); }
});

test("a callback opened in a different browser cannot exchange the recovery code without its verifier", async () => {
  let networkCalls = 0;
  const client = sdk(storage(), async () => { networkCalls++; return Response.json(session()); });
  try {
    const result = await client.auth.exchangeCodeForSession("stolen-or-different-browser-code");
    assert.ok(result.error);
    assert.equal(networkCalls, 0);
    assert.equal(result.data.session, null);
  } finally { await client.auth.stopAutoRefresh(); }
});

test("gateway recovery throttling remains an SDK error with no raw server details", async () => {
  const client = sdk(storage(), async () => Response.json({ error: "rate_limited", detail: "private server detail" }, { status: 429 }));
  try {
    const result = await client.auth.resetPasswordForEmail("test@example.invalid");
    assert.equal(result.error.code, "rate_limited");
    assert.doesNotMatch(result.error.message, /private server detail/);
  } finally { await client.auth.stopAutoRefresh(); }
});

test("a malformed successful HTTP response is never converted into an SDK recovery receipt", async () => {
  for (const body of [{}, { success: false, code: "recovery_received" }, { success: true }, { success: true, code: "registration_received" }]) {
    const client = sdk(storage(), async () => Response.json(body));
    try {
      const result = await client.auth.resetPasswordForEmail("test@example.invalid");
      assert.ok(result.error);
      assert.equal(result.error.status, 503);
      assert.equal(result.data, null);
    } finally { await client.auth.stopAutoRefresh(); }
  }
});

test("pinned SDK flow correlation preserves an earlier emailed verifier after a throttled resend", async () => {
  const memory = storage();
  const requests = [];
  let sent = null;
  const network = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    requests.push({ url: request.url, body });
    if (request.url.endsWith("/functions/v1/staff-auth")) {
      if (sent) return Response.json({ error: "rate_limited" }, { status: 429 });
      sent = body;
      return Response.json({ success: true, code: "recovery_received" });
    }
    if (new URL(request.url).searchParams.get("grant_type") === "pkce") {
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), sent.code_challenge);
      return Response.json(session());
    }
    throw new Error("Unexpected Auth request");
  };
  const client = sdk(memory, network, { experimental: { appendPkceFlowIdToRedirects: true } });
  try {
    const redirectTo = "https://club.example.invalid/admin/help/";
    assert.equal((await client.auth.resetPasswordForEmail("test@example.invalid", { redirectTo })).error, null);
    const first = requests[0].body;
    assert.match(first.flow_id, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(first.redirect_to, undefined);
    assert.equal((await client.auth.resetPasswordForEmail("test@example.invalid", { redirectTo })).error.code, "rate_limited");
    const second = requests[1].body;
    assert.notEqual(first.flow_id, second.flow_id);
    assert.ok(memory.getItem(`staff-pkce-test-flow-${first.flow_id}-code-verifier`));
    assert.equal(memory.getItem(`staff-pkce-test-flow-${second.flow_id}-code-verifier`), null);
    const result = await client.auth.exchangeCodeForSession("earlier-emailed-code", { flowId: first.flow_id });
    assert.equal(result.error, null);
    assert.equal(result.data.user.id, session().user.id);
  } finally { await client.auth.stopAutoRefresh(); }
});

// 실제 브라우저 분기와 자동 URL 처리를 검사합니다. Auth 네트워크·서명 키는 이 테스트 전용입니다.
const browserBundle = await build({ stdin: {
  contents: `import { createClient } from '@supabase/supabase-js';
    import { mountStaffAuthHelp, recoveryCallbackState } from './src/scripts/staff-auth-help';
    import { createStaffRecoveryFetch } from './src/lib/staff-auth-recovery';
    export function boot(root, network) {
      const callback = recoveryCallbackState(window.location.href);
      const client = createClient('${url}', '${key}', {
        auth: { storageKey: 'browser-recovery-test', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', experimental: { appendPkceFlowIdToRedirects: true } },
        global: { fetch: createStaffRecoveryFetch('${url}', '${key}', network) }
      });
      const controller = mountStaffAuthHelp({ root, client, callback });
      return { client, controller };
    }`,
  resolveDir: process.cwd(), sourcefile: "browser-recovery-test.ts", loader: "ts",
}, bundle: true, write: false, format: "iife", globalName: "RecoveryBrowser", define: {
  "import.meta.env.BASE_URL": '"/"', "import.meta.env.PUBLIC_SUPABASE_URL": '""', "import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY": '""',
} });
const helpHtml = (await readFile("src/pages/admin/help.astro", "utf8"))
  .replace(/^---[\s\S]*?---/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/data-enabled=\{String\(enabled\)\}/g, 'data-enabled="false"');
const browserKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const browserJwk = { ...browserKeys.publicKey.export({ format: "jwk" }), kid: "recovery-browser-test", alg: "ES256", use: "sig" };
function signedBrowserSession() {
  const result = session();
  const claims = { sub: result.user.id, aud: "authenticated", role: "authenticated", iss: url + "/auth/v1", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) }] };
  const input = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: browserJwk.kid })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
  result.access_token = input + "." + sign("sha256", Buffer.from(input), { key: browserKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return result;
}
async function until(condition) {
  for (let count = 0; count < 150; count++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(condition(), "Browser recovery did not reach its expected state");
}
function browser(address, network, saved = []) {
  const dom = new JSDOM(helpHtml, { url: address, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(window, { TextEncoder, TextDecoder, Request, Response, Headers, AbortController, AbortSignal });
  Object.defineProperty(window, "crypto", { value: webcrypto });
  for (const [name, value] of saved) window.localStorage.setItem(name, value);
  window.eval(browserBundle.outputFiles[0].text);
  const runtime = window.RecoveryBrowser.boot(window.document.querySelector("#staff-auth-help"), network);
  return { dom, window, runtime,
    snapshot: () => Array.from({ length: window.localStorage.length }, (_, index) => {
      const name = window.localStorage.key(index);
      return [name, window.localStorage.getItem(name)];
    }),
    async close() { runtime.controller.destroy(); await runtime.client.auth.stopAutoRefresh(); dom.window.close(); },
  };
}

test("previously issued PKCE callback still auto-initializes and resumes signed recovery after reload", async () => {
  const requests = [];
  const result = signedBrowserSession();
  const network = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().json() : null;
    requests.push({ path: target.pathname, method: request.method, body });
    if (target.pathname === "/functions/v1/staff-auth") return Response.json({ success: true, code: "recovery_received" });
    if (target.pathname === "/auth/v1/token" && target.searchParams.get("grant_type") === "pkce") return Response.json(result);
    if (target.pathname === "/auth/v1/user") return Response.json(result.user);
    if (target.pathname === "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [browserJwk] });
    throw new Error("Unexpected fake Auth operation");
  };
  const first = browser("https://club.example.invalid/admin/help/?lang=ja", network);
  let saved;
  try {
    // 메일 양식을 제거하기 전에 발급된 링크와 브라우저 verifier를 격리된 SDK로 재현합니다.
    assert.equal(first.window.document.querySelector("#staff-recovery-form"), null);
    const issuedBeforeTransition = await first.runtime.client.auth.resetPasswordForEmail("test@example.invalid", {
      redirectTo: "https://club.example.invalid/admin/help/",
    });
    assert.equal(issuedBeforeTransition.error, null);
    assert.match(requests[0].body.flow_id, /^[A-Za-z0-9_-]{8,64}$/);
    saved = first.snapshot();
    assert.ok(saved.some(([name]) => name.endsWith("-code-verifier")));
  } finally { await first.close(); }
  const callback = browser("https://club.example.invalid/admin/help/?lang=ja&code=fake-one-time-code&sb_flow_id=" + requests[0].body.flow_id, network, saved);
  let resumed;
  try {
    await until(() => !callback.window.document.querySelector("#staff-new-password-panel").hidden);
    assert.equal(requests.filter(request => request.path === "/auth/v1/token").length, 1);
    assert.equal(callback.window.location.search, "?lang=ja");
    assert.equal(callback.window.document.querySelector("#staff-help-options").hidden, true);
    resumed = callback.snapshot();
  } finally { await callback.close(); }
  const reloaded = browser("https://club.example.invalid/admin/help/?lang=ja", network, resumed);
  try {
    await until(() => !reloaded.window.document.querySelector("#staff-new-password-panel").hidden);
    assert.equal(requests.filter(request => request.path === "/auth/v1/token").length, 1);
    assert.equal(reloaded.window.document.querySelector("#staff-help-message").dataset.error, "false");
  } finally { await reloaded.close(); }
});

test("actual browser callback without a PKCE verifier surfaces a safe explanation and performs no token exchange", async () => {
  const requests = [];
  const app = browser("https://club.example.invalid/admin/help/?lang=ja&code=fake-other-browser-code", async (input, init) => {
    requests.push(new URL(new Request(input, init).url).pathname);
    throw new Error("Unexpected fake Auth operation");
  });
  try {
    await until(() => app.window.document.querySelector("#staff-help-message").dataset.error === "true");
    const notice = app.window.document.querySelector("#staff-help-message");
    assert.match(notice.textContent, /リンクを申請したブラウザー/);
    assert.doesNotMatch(notice.textContent, /fake-other-browser-code/);
    assert.equal(app.window.document.querySelector("#staff-new-password-panel").hidden, true);
    assert.equal(app.window.location.search, "?lang=ja");
    assert.equal(requests.includes("/auth/v1/token"), false);
  } finally { await app.close(); }
});

test("actual browser initialization error from an expired exchange is shown without provider error detail", async () => {
  const requests = [];
  const memory = [["browser-recovery-test-code-verifier", JSON.stringify("fake-verifier-for-expired-flow/recovery")]];
  const app = browser("https://club.example.invalid/admin/help/?lang=ja&code=fake-expired-code", async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    requests.push(path);
    if (path === "/auth/v1/token") return Response.json({ code: "flow_state_expired", msg: "do not expose this provider detail" }, { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } });
    throw new Error("Unexpected fake Auth operation");
  }, memory);
  try {
    await until(() => app.window.document.querySelector("#staff-help-message").dataset.error === "true");
    const notice = app.window.document.querySelector("#staff-help-message");
    assert.match(notice.textContent, /リンクを申請したブラウザー/);
    assert.doesNotMatch(notice.textContent, /provider detail|fake-expired-code/);
    assert.equal(requests.filter(path => path === "/auth/v1/token").length, 1);
    assert.equal(app.window.document.querySelector("#staff-new-password-panel").hidden, true);
  } finally { await app.close(); }
});

test("actual recovery controller rejects more than 72 UTF-8 bytes and accepts the Unicode boundary without changing its AMR gate", async () => {
  const requests = [];
  const result = signedBrowserSession();
  const app = browser(
    "https://club.example.invalid/admin/help/?lang=ja",
    async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? await request.json().catch(() => null)
          : null;
      requests.push({ path, body });
      if (path === "/auth/v1/user") return Response.json(result.user);
      if (path === "/auth/v1/.well-known/jwks.json")
        return Response.json({ keys: [browserJwk] });
      if (path === "/functions/v1/staff-auth")
        return Response.json({ success: true, code: "password_updated" });
      if (path === "/auth/v1/logout")
        return new Response(null, { status: 204 });
      throw new Error("Unexpected fake Auth operation");
    },
    [["browser-recovery-test", JSON.stringify(result)]],
  );
  try {
    const document = app.window.document;
    await until(
      () => !document.querySelector("#staff-new-password-panel").hidden,
    );
    const form = document.querySelector("#staff-new-password-form");
    const password = form.elements.namedItem("password");
    const confirmation = form.elements.namedItem("password_confirmation");
    assert.equal(password.maxLength, 72);
    assert.equal(confirmation.maxLength, 72);
    const boundary = "가".repeat(24);
    assert.equal(new TextEncoder().encode(boundary).length, 72);
    password.value = boundary + "a";
    confirmation.value = password.value;
    form.dispatchEvent(
      new app.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(() => password.getAttribute("aria-invalid") === "true");
    assert.equal(document.activeElement, password);
    assert.match(
      document.querySelector("#staff-help-message").textContent,
      /UTF-8で72バイト/,
    );
    assert.equal(
      requests.some((request) => request.body?.action === "set_password"),
      false,
    );
    password.value = boundary;
    confirmation.value = boundary;
    password.dispatchEvent(new app.window.Event("input", { bubbles: true }));
    form.dispatchEvent(
      new app.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(
      () => document.querySelector("#staff-new-password-panel").hidden,
    );
    assert.equal(
      requests.filter((request) => request.body?.action === "set_password")
        .length,
      1,
    );
    assert.equal(
      requests.find((request) => request.body?.action === "set_password").body
        .password,
      boundary,
    );
    assert.equal(password.value, "");
    assert.equal(confirmation.value, "");
  } finally {
    await app.close();
  }
});

test("signup and help need no email and direct account recovery to verified administrators", async () => {
  const portalSource = await readFile("src/components/admin/StaffAuthPortal.astro", "utf8");
  const supportSource = await readFile("src/components/StaffSupportRecovery.astro", "utf8");
  const portal = new JSDOM(portalSource.replace(/^---[\s\S]*?---/, "")).window.document;
  const help = new JSDOM(helpHtml).window.document;
  const signup = portal.querySelector('[data-staff-panel="signup"]');
  assert.match(signup.textContent, /メールアドレスは不要/);
  assert.match(signup.textContent, /統括が本人と関係者であることを確認/);
  assert.equal(signup.querySelector('[name="email"], input[type="email"]'), null);
  for (const field of signup.querySelectorAll('[autocomplete="new-password"]')) assert.equal(field.maxLength, 72);
  const options = help.querySelector("#staff-help-options");
  assert.match(options.textContent, /本人と既存アカウントを確認.*管理画面から対応/);
  assert.equal(options.querySelector("#staff-recovery-form, #staff-help-legacy, input[type=email]"), null);
  assert.equal(options.textContent.includes("reset-staff-password.mjs"), false);
  assert.match(supportSource, /統括アカウントの復旧/);
  assert.match(supportSource, /申請だけではログインや権限の変更はできません/);
  assert.equal(supportSource.includes('type="email"'), false);
});
