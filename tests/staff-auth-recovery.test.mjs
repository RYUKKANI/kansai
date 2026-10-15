import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createClient } from "@supabase/supabase-js";

const compiled = await build({ entryPoints: ["src/lib/staff-auth-recovery.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { createStaffRecoveryFetch } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const url = "https://test-project.supabase.co";
const key = "sb_publishable_TEST_ONLY";
function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function sdk(memory, network) {
  return createClient(url, key, {
    auth: { storageKey: "staff-pkce-test", storage: memory, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
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
