import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { typescriptModule } from "./helpers/typescript-module.mjs";

const { createGateway, normalizeUsername, normalizeIp, trustedClientIp } = await typescriptModule("supabase/functions/staff-auth/gateway.ts");
const { readGatewayConfig, serverKey } = await typescriptModule("supabase/functions/staff-auth/configuration.ts");
const { updateAuthUser } = await typescriptModule("supabase/functions/staff-auth/auth-update.ts");
const { recoverAuthEmail } = await typescriptModule("supabase/functions/staff-auth/auth-recovery.ts");
const { createRegistrationCaptchaVerifier } = await typescriptModule("supabase/functions/staff-auth/registration-captcha.ts");
const { createLegacyInviteHandler } = await typescriptModule("supabase/functions/invite-staff/handler.ts");
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPERATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EMAIL = "current-address@example.invalid";
const NOW = 1_792_000_000_000;
const CHALLENGE = "A".repeat(43);
const configuration = (overrides = {}) => ({
  enabled: true, registrationEnabled: true, registrationCaptchaMode: "disabled", legacyEmailEnabled: true,
  allowedOrigins: ["https://club.example.invalid"],
  emailRedirectTo: "https://club.example.invalid/admin/",
  recoveryRedirectTo: "https://club.example.invalid/admin/help/",
  hmacSecret: "unit-test-hmac-secret-is-at-least-thirty-two-characters",
  ipMode: "disabled", ipHeader: "", ipHeaderAttested: false,
  forwardAuthIp: false, forwardedForOptIn: false, authSecretKey: "legacy-service-test-only",
  ...overrides,
});
const ok = data => ({ data, error: null });
const bad = (code = "P0001") => ({ data: null, error: { code, message: `do not expose ${EMAIL} secret-token` } });
function fixture(overrides = {}) {
  const calls = [];
  const counters = new Map();
  const reservationNames = new Set();
  const operations = new Map();
  const rpc = async (name, args) => {
    calls.push({ type: "rpc", name, args });
    if (overrides.rpc) {
      const response = await overrides.rpc(name, args);
      if (response !== undefined) return response;
    }
    if (name === "staff_auth_rate_limit") {
      const key = `${args.p_bucket}:${args.p_key_hash}`;
      const current = (counters.get(key) ?? 0) + 1;
      counters.set(key, current);
      return ok(current <= args.p_limit);
    }
    if (name === "staff_auth_identity") return ok({ user_id: USER, email: EMAIL, approval_status: "approved" });
    if (name === "staff_auth_reserve") {
      if (reservationNames.has(args.p_username)) return bad("23505");
      reservationNames.add(args.p_username);
      return ok("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    }
    if (name === "staff_auth_finalize") return ok(null);
    if (name === "office_enroll_identity") return ok({ user_id: USER, username: args.p_username, approval_status: "approved" });
    if (name === "office_owner_begin_password_reset") {
      if (overrides.ownerRole && overrides.ownerRole !== "owner" || overrides.sessionRevoked || ![USER, TARGET].includes(args.p_user_id)) return bad("42501");
      let operation = operations.get(args.p_operation_id);
      if (operation && (operation.target_user_id !== args.p_user_id || operation.reason !== args.p_reason)) return bad("23505");
      if (!operation) {
        operation = { operation_id: args.p_operation_id, target_user_id: args.p_user_id, actor_id: USER, state: "requested", reason: args.p_reason, expires_at: new Date(NOW + 300000).toISOString() };
        operations.set(args.p_operation_id, operation);
      }
      return ok({ ...operation });
    }
    if (name === "staff_auth_owner_password_claim") {
      const operation = operations.get(args.p_operation_id);
      if (!operation || operation.actor_id !== args.p_actor_id || operation.state !== "requested") return bad("P0001");
      operation.state = "executing";
      return ok({ ...operation });
    }
    if (name === "staff_auth_owner_password_finish") {
      const operation = operations.get(args.p_operation_id);
      if (!operation || operation.actor_id !== args.p_actor_id) return bad("42501");
      operation.state = args.p_state;
      return ok(null);
    }
    throw new Error(`Unexpected test RPC ${name}`);
  };
  const auth = Object.fromEntries(["getUser", "getClaims", "signInWithPassword", "signUp", "resetPasswordForEmail", "signInWithOtp", "signOut", "updateUser"].map(method => [method, async (...args) => {
    calls.push({ type: "auth", method, args });
    if (overrides[method]) return overrides[method](...args);
    if (method === "getClaims") return ok({ claims: { sub: USER, amr: [{ method: "recovery", timestamp: NOW / 1000 }] } });
    if (method === "getUser" || method === "updateUser") return ok({ user: { id: USER, email: EMAIL } });
    if (method === "signInWithPassword") return ok({ user: { id: USER, email: EMAIL }, session: { access_token: "actual-auth-access-token", refresh_token: "actual-auth-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: USER, email: EMAIL } } });
    return ok({});
  }]));
  auth.admin = { createUser: async input => {
    calls.push({ type: "auth", method: "admin.createUser", args: [input] });
    return overrides.createUser ? overrides.createUser(input) : ok({ user: { id: USER, email: input.email, email_confirmed_at: new Date(NOW).toISOString(), app_metadata: input.app_metadata } });
  }, updateUserById: async (userId, input) => {
    calls.push({ type: "auth", method: "admin.updateUserById", args: [userId, input] });
    return overrides.updateUserById ? overrides.updateUserById(userId, input) : ok({ user: { id: userId, email: EMAIL } });
  } };
  const client = { rpc, auth };
  const handler = createGateway({ service: client, config: configuration(overrides.config), authClient: ip => { calls.push({ type: "client", ip }); return client; }, userClient: (token, ip) => { calls.push({ type: "userClient", token, ip }); return client; }, verifyRegistrationCaptcha: async input => { calls.push({ type: "captcha" }); return overrides.verifyRegistrationCaptcha ? overrides.verifyRegistrationCaptcha(input) : "passed"; }, now: () => NOW });
  const send = (body, headers = {}, init = {}) => handler(new Request("https://auth.example.invalid/functions/v1/staff-auth", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://club.example.invalid", ...headers }, body: JSON.stringify(body), ...init,
  }));
  return { calls, counters, handler, send, client, operations };
}
const registration = overrides => ({ action: "register", username: "Kansai.Owner", password: "safe-test-password-only", password_confirmation: "safe-test-password-only", real_name: "田中  류컁이 José-Anne", department: "コーチ / 운영", email: "new-account@example.invalid", notice_accepted: true, ...overrides });
const authCalls = fixture => fixture.calls.filter(call => call.type === "auth");
const rpcCalls = (fixture, name) => fixture.calls.filter(call => call.type === "rpc" && (!name || call.name === name));
const ownerClaims = (claims = {}) => ok({ claims: { sub: USER, aal: "aal1", amr: [{ method: "password", timestamp: NOW / 1000 }], ...claims } });
const ownerFixture = (overrides = {}) => fixture({ getClaims: () => ownerClaims(), ...overrides });
const ownerReset = (overrides = {}) => ({ action: "owner_reset_password", user_id: TARGET, operation_id: OPERATION, password: "new-password-for-member", password_confirmation: "new-password-for-member", reason: "本人確認後の依頼による初期化", ...overrides });
const ownerHeaders = { authorization: "Bearer actual-owner-session-token" };

test("existing UUID and current Auth email are preserved; public response contains only Auth session", async () => {
  const f = fixture();
  const response = await f.send({ action: "login", username: "  KANSAI.Owner ", password: "existing-password" }, { "x-forwarded-for": "spoofed", "cf-connecting-ip": "203.0.113.3" });
  assert.equal(response.status, 200);
  assert.deepEqual(rpcCalls(f, "staff_auth_identity")[0].args, { p_username: "kansai.owner" });
  assert.equal(authCalls(f)[0].args[0].email, EMAIL);
  const body = await response.json();
  assert.equal(body.session.access_token, "actual-auth-access-token");
  assert.equal(body.session.user, undefined);
  assert.equal(JSON.stringify(body).includes(EMAIL), false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(f.calls.find(call => call.type === "client").ip, null);
});

test("username rules match DB and Unicode names preserve original scripts and duplicate names", async () => {
  assert.equal(normalizeUsername(" 9USER.Name_1- "), "9user.name_1-");
  for (const value of ["ab", "a".repeat(33), "a bcd", "한글아이디", "-user", "user@example.invalid"]) assert.throws(() => normalizeUsername(value));
  const f = fixture();
  assert.equal((await f.send(registration({ username: "member1", real_name: "ژوزه‌ علی-Anne" }))).status, 200);
  assert.equal((await f.send(registration({ username: "member2", real_name: "ژوزه‌ علی-Anne", email: "new2@example.invalid" }))).status, 200);
  assert.equal(rpcCalls(f, "staff_auth_reserve").length, 2);
});

test("unknown, suspended and mismatched Auth UUID all use generic invalid credentials", async () => {
  for (const identity of [null, { user_id: USER, email: EMAIL, approval_status: "suspended" }]) {
    const f = fixture({ rpc: name => name === "staff_auth_identity" ? ok(identity) : undefined });
    const response = await f.send({ action: "login", username: "unknown", password: "password" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_credentials" });
    assert.equal(authCalls(f).length, 0);
  }
  const f = fixture({ signInWithPassword: () => ok({ user: { id: "another-uuid" }, session: { access_token: "a", refresh_token: "r" } }) });
  assert.equal((await f.send({ action: "login", username: "member", password: "password" })).status, 401);
});

test("pending account receives Auth session but no approval or role mutation", async () => {
  const f = fixture({ rpc: name => name === "staff_auth_identity" ? ok({ user_id: USER, email: EMAIL, approval_status: "pending" }) : undefined });
  assert.equal((await f.send({ action: "login", username: "member", password: "password" })).status, 200);
  assert.deepEqual([...new Set(rpcCalls(f).map(call => call.name))].sort(), ["staff_auth_identity", "staff_auth_rate_limit"]);
});

test("rotating forged proxy headers cannot bypass normalized identifier attempts", async () => {
  const f = fixture({ rpc: name => name === "staff_auth_identity" ? ok(null) : undefined });
  const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => f.send({ action: "login", username: index % 2 ? "  MEMBER " : "member", password: "wrong" }, { "x-forwarded-for": `203.0.113.${index}`, "x-real-ip": `198.51.100.${index}`, "cf-connecting-ip": `192.0.2.${index}` })));
  assert.equal(responses.filter(response => response.status === 401).length, 8);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(rpcCalls(f, "staff_auth_rate_limit").some(call => call.args.p_bucket.endsWith(":ip")), false);
  for (const call of rpcCalls(f, "staff_auth_rate_limit")) {
    assert.match(call.args.p_key_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(call.args).includes("member"), false);
    assert.equal(JSON.stringify(call.args).includes("wrong"), false);
  }
});

test("global DB bucket caps distinct username attack across simultaneous edge instances", async () => {
  const f = fixture({ rpc: name => name === "staff_auth_identity" ? ok(null) : undefined });
  const responses = await Promise.all(Array.from({ length: 201 }, (_, i) => f.send({ action: "login", username: `member${i}`, password: "wrong" }, { "x-forwarded-for": `203.0.${Math.floor(i / 255)}.${i % 255}` })));
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(rpcCalls(f, "staff_auth_identity").length, 200);
});

test("limiter/database failures fail closed before Auth or identity lookup", async () => {
  for (const result of [bad("XX000"), ok(null), ok("true")]) {
    const f = fixture({ rpc: name => name === "staff_auth_rate_limit" ? result : undefined });
    const response = await f.send({ action: "login", username: "member", password: "secret-password" });
    assert.equal(response.status, 503);
    assert.equal(authCalls(f).length, 0);
    assert.equal(rpcCalls(f, "staff_auth_identity").length, 0);
    assert.equal((await response.text()).includes("secret-password"), false);
  }
});

test("registration atomically reserves then creates an Auth account without sending email before finalizing pending identity", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.send(registration())).json(), { success: true, code: "registration_received" });
  const names = f.calls.filter(call => call.type === "rpc" || call.type === "auth").map(call => call.name ?? call.method);
  assert.ok(names.indexOf("staff_auth_reserve") < names.indexOf("admin.createUser"));
  assert.ok(names.indexOf("admin.createUser") < names.indexOf("staff_auth_finalize"));
  assert.equal(rpcCalls(f, "staff_auth_reserve")[0].args.p_email_confirmation_required, false);
  assert.deepEqual(rpcCalls(f, "staff_auth_finalize")[0].args, { p_reservation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", p_user_id: USER });
  for (const call of rpcCalls(f)) assert.equal(JSON.stringify(call).includes("safe-test-password-only"), false);
  assert.deepEqual(authCalls(f)[0].args[0], { email: "new-account@example.invalid", password: "safe-test-password-only", email_confirm: true, app_metadata: { staff_signup_policy: "manual_approval_no_email_v1" } });
  assert.equal(authCalls(f).some(call => ["signUp", "signInWithOtp", "resetPasswordForEmail", "signInWithPassword"].includes(call.method)), false);
  assert.deepEqual(await (await f.send(registration({ username: "member2", email: "new2@example.invalid" }))).json(), { success: true, code: "registration_received" });
});

test("concurrent duplicate registration produces one Auth creation and no existing-email mapping takeover", async () => {
  const f = fixture();
  const responses = await Promise.all([f.send(registration()), f.send(registration({ username: "KANSAI.OWNER" }))]);
  assert.equal(responses.every(response => response.status === 200), true);
  assert.equal(authCalls(f).filter(call => call.method === "admin.createUser").length, 1);
  const existing = fixture({ rpc: name => name === "staff_auth_reserve" ? bad("23505") : undefined });
  const duplicate = await existing.send(registration());
  assert.deepEqual(await duplicate.json(), { success: true, code: "registration_received" });
  assert.equal(authCalls(existing).length, 0);
  assert.equal(rpcCalls(existing, "staff_auth_finalize").length, 0);
});

test("failed finalization does not grant approval or expose service-created UUID or contact", async () => {
  const f = fixture({ rpc: name => name === "staff_auth_finalize" ? bad("P0001") : undefined });
  const response = await f.send(registration());
  assert.deepEqual(await response.json(), { success: true, code: "registration_received" });
  assert.equal(rpcCalls(f).some(call => /role|approve|owner/.test(call.name)), false);
});

test("service account creation never hands an anonymous registration an Auth session", async () => {
  const f = fixture({ createUser: () => ok({ user: { id: USER }, session: { access_token: "must-not-return", refresh_token: "must-not-return" } }) });
  const response = await f.send(registration());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("must-not-return"), false);
  assert.equal(rpcCalls(f, "staff_auth_finalize").length, 0);
});

test("failed Auth creation stays generic and never finalizes or alters an existing account", async () => {
  for (const error of [bad("email_exists"), bad("unexpected_failure")]) {
    const f = fixture({ createUser: () => error });
    const response = await f.send(registration());
    assert.deepEqual(await response.json(), { success: true, code: "registration_received" });
    assert.equal(rpcCalls(f, "staff_auth_finalize").length, 0);
    assert.equal(authCalls(f).some(call => /updateUser|deleteUser|signUp|invite/.test(call.method)), false);
  }
});

test("new passwords use UTF-8 byte bounds while existing login passwords keep their previous validation", async () => {
  for (const secret of ["a".repeat(72), "한".repeat(24), "🔑".repeat(18)]) {
    const f = fixture();
    assert.equal((await f.send(registration({ password: secret, password_confirmation: secret }))).status, 200);
    assert.equal(authCalls(f).find(call => call.method === "admin.createUser").args[0].password, secret);
  }
  for (const secret of ["a".repeat(73), "한".repeat(25), "🔑".repeat(19)]) {
    const f = fixture();
    assert.equal((await f.send(registration({ password: secret, password_confirmation: secret }))).status, 400);
    assert.equal(authCalls(f).some(call => call.method === "admin.createUser"), false);
    const reset = await f.send({ action: "set_password", password: secret, password_confirmation: secret }, { authorization: "Bearer recovery-session" });
    assert.equal(reset.status, 400);
    assert.equal(authCalls(f).some(call => call.method === "updateUser"), false);
  }
  const legacy = fixture();
  const previous = "a".repeat(80);
  assert.equal((await legacy.send({ action: "login", username: "legacy-owner", password: previous })).status, 200);
  assert.equal(authCalls(legacy).find(call => call.method === "signInWithPassword").args[0].password, previous);
});

test("the manual approval Auth marker is server-owned and cannot be replaced through request metadata", async () => {
  for (const metadata of [{ app_metadata: { staff_signup_policy: "another-policy", role: "owner" } }, { user_metadata: { staff_signup_policy: "manual_approval_no_email_v1" } }, { staff_signup_policy: "manual_approval_no_email_v1" }, { password_hash: "must-not-import-a-hash" }]) {
    const f = fixture();
    assert.equal((await f.send(registration(metadata))).status, 400);
    assert.equal(authCalls(f).some(call => call.method === "admin.createUser"), false);
  }
});

test("shared registration creation cap applies even when attackers rotate usernames, emails and spoofed IP headers", async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => f.send(registration({ username: `member${index}`, email: `new${index}@example.invalid` }), { "x-forwarded-for": `192.0.2.${index}`, "cf-connecting-ip": `203.0.113.${index}` })));
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(authCalls(f).filter(call => call.method === "admin.createUser").length, 10);
  assert.equal(rpcCalls(f, "staff_auth_rate_limit").find(call => call.args.p_bucket === "register:shared").args.p_limit, 10);
});

test("registration CAPTCHA policy is server-owned and fail-closed before reservation or privileged Auth creation", async () => {
  const unconfigured = fixture({ config: { registrationCaptchaMode: "unconfigured" } });
  assert.equal((await unconfigured.send(registration({ captcha_token: "cannot-bypass-missing-config" }))).status, 503);
  assert.equal(authCalls(unconfigured).length, 0);
  assert.equal(rpcCalls(unconfigured, "staff_auth_reserve").length, 0);
  const missing = fixture({ config: { registrationCaptchaMode: "turnstile" } });
  assert.equal((await missing.send(registration())).status, 400);
  assert.equal(authCalls(missing).length, 0);
  for (const [result, status] of [["failed", 400], ["unavailable", 503], ["passed", 200]]) {
    const f = fixture({ config: { registrationCaptchaMode: "hcaptcha" }, verifyRegistrationCaptcha: () => result });
    assert.equal((await f.send(registration({ captcha_token: "test-captcha-token" }))).status, status);
    assert.equal(authCalls(f).filter(call => call.method === "admin.createUser").length, result === "passed" ? 1 : 0);
    for (const call of rpcCalls(f)) assert.equal(JSON.stringify(call.args).includes("test-captcha-token"), false);
  }
  const spoofed = fixture();
  assert.equal((await spoofed.send(registration({ email_confirmation_required: true, email_confirm: true, registrationCaptchaMode: "disabled" }))).status, 400);
  assert.equal(authCalls(spoofed).length, 0);
});

test("invalid CAPTCHA cannot exhaust the club-wide account-creation quota", async () => {
  let passed = false;
  const f = fixture({ config: { registrationCaptchaMode: "turnstile" }, verifyRegistrationCaptcha: () => passed ? "passed" : "failed" });
  for (let index = 0; index < 10; index++) {
    const response = await f.send(registration({ username: `badcaptcha${index}`, email: `badcaptcha${index}@example.invalid`, captcha_token: "invalid-token" }));
    assert.equal(response.status, 400);
  }
  assert.equal(rpcCalls(f, "staff_auth_rate_limit").some(call => call.args.p_bucket === "register:shared"), false);
  passed = true;
  const response = await f.send(registration({ captcha_token: "valid-token" }));
  assert.equal(response.status, 200);
  assert.equal(authCalls(f).filter(call => call.method === "admin.createUser").length, 1);
});

test("CAPTCHA provider adapters use official POST endpoints and require approved hostname and action", async () => {
  for (const mode of ["hcaptcha", "turnstile"]) {
    const requests = [];
    const check = createRegistrationCaptchaVerifier({ mode, secret: "test-server-only-secret", sitekey: "test-site-key", allowedOrigins: ["https://club.example.invalid"], request: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ success: true, hostname: "club.example.invalid", action: "staff-register" });
    } });
    assert.equal(await check({ token: "test-response-token", ip: null }), "passed");
    assert.equal(requests[0].url, mode === "hcaptcha" ? "https://api.hcaptcha.com/siteverify" : "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(requests[0].init.method, "POST");
    const body = new URLSearchParams(requests[0].init.body);
    assert.equal(body.get("response"), "test-response-token");
    assert.equal(body.get("secret"), "test-server-only-secret");
    assert.equal(body.has("remoteip"), false);
    assert.equal(requests[0].url.includes("test-server-only-secret"), false);
  }
  for (const result of [{ success: false }, { success: true, hostname: "untrusted.invalid", action: "staff-register" }, { success: true, hostname: "club.example.invalid", action: "another-flow" }]) {
    const check = createRegistrationCaptchaVerifier({ mode: "turnstile", secret: "test-secret", sitekey: "test-sitekey", allowedOrigins: ["https://club.example.invalid"], request: async () => Response.json(result) });
    assert.equal(await check({ token: "test-token", ip: null }), "failed");
  }
  const unavailable = createRegistrationCaptchaVerifier({ mode: "hcaptcha", secret: "", sitekey: "", allowedOrigins: [], request: async () => { throw new Error("must not call provider"); } });
  assert.equal(await unavailable({ token: "test-token", ip: null }), "unavailable");
});

test("recovery generic result never resolves usernames or exposes existing email and uses configured help URL", async () => {
  for (const result of [ok({}), bad("email_not_found"), bad("over_email_send_rate_limit")]) {
    const f = fixture({ resetPasswordForEmail: () => result });
    const response = await f.send({ action: "recovery", email: "  RECOVERY@EXAMPLE.INVALID ", code_challenge: CHALLENGE, code_challenge_method: "s256" });
    assert.deepEqual(await response.json(), { success: true, code: "recovery_received" });
    assert.equal(rpcCalls(f, "staff_auth_identity").length, 0);
    assert.deepEqual(authCalls(f)[0].args, ["recovery@example.invalid", { redirectTo: "https://club.example.invalid/admin/help/", captchaToken: undefined, codeChallenge: CHALLENGE, codeChallengeMethod: "s256" }]);
  }
});

test("recovery requires browser-owned PKCE challenge; verifier and caller redirect are never accepted", async () => {
  for (const extra of [{}, { code_challenge: CHALLENGE, code_challenge_method: "plain" }, { code_challenge: "short", code_challenge_method: "s256" }, { code_challenge: CHALLENGE, code_challenge_method: "s256", code_verifier: "must-not-receive" }, { code_challenge: CHALLENGE, code_challenge_method: "s256", redirectTo: "https://attacker.invalid" }]) {
    const f = fixture();
    assert.equal((await f.send({ action: "recovery", email: EMAIL, ...extra })).status, 400);
    assert.equal(authCalls(f).length, 0);
  }
});

test("server Auth recovery adapter forwards SDK challenge and configured help URL without creating own verifier", async () => {
  const requests = [];
  const f = fixture({ resetPasswordForEmail: (address, options) => recoverAuthEmail("https://auth.example.invalid/", "sb_publishable_test", address, options, null, async (url, init) => {
    requests.push({ url, init });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) });
  const response = await f.send({ action: "recovery", email: EMAIL, code_challenge: CHALLENGE, code_challenge_method: "s256", captcha_token: "captcha-for-auth" });
  assert.equal(response.status, 200);
  assert.equal(new URL(requests[0].url).pathname, "/auth/v1/recover");
  assert.equal(new URL(requests[0].url).searchParams.get("redirect_to"), "https://club.example.invalid/admin/help/");
  assert.equal(requests[0].init.headers["Sb-Forwarded-For"], undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: EMAIL, code_challenge: CHALLENGE, code_challenge_method: "s256", gotrue_meta_security: { captcha_token: "captcha-for-auth" } });
  assert.equal(requests[0].init.body.includes("code_verifier"), false);
});

test("legacy help fallback is explicit and cannot automatically create a user", async () => {
  const f = fixture();
  assert.equal((await f.send({ action: "legacy_login", email: EMAIL })).status, 200);
  assert.equal(authCalls(f)[0].args[0].options.shouldCreateUser, false);
  const disabled = fixture({ config: { legacyEmailEnabled: false } });
  assert.equal((await disabled.send({ action: "legacy_login", email: EMAIL })).status, 503);
  assert.equal(authCalls(disabled).length, 0);
});

test("enrollment uses getUser verified bearer and UUID-scoped RPC, never caller actor or role", async () => {
  const f = fixture();
  const input = { action: "enroll", username: "newname", real_name: "류컁이", department: "Owner", notice_accepted: true };
  assert.equal((await f.send(input)).status, 401);
  const response = await f.send(input, { authorization: "Bearer verified-user-token" });
  assert.equal(response.status, 200);
  assert.deepEqual(authCalls(f)[0].args, ["verified-user-token"]);
  assert.equal(rpcCalls(f, "office_enroll_identity")[0].args.p_user_id, undefined);
  assert.equal((await f.send({ ...input, actor_id: "another-user" }, { authorization: "Bearer verified-user-token" })).status, 400);
  assert.equal((await f.send({ ...input, role: "owner" }, { authorization: "Bearer verified-user-token" })).status, 400);
});

test("invalid bearer is checked by Auth and shared limiter precedes verification", async () => {
  const f = fixture({ getUser: () => bad("bad_jwt") });
  const response = await f.send({ action: "set_password", password: "new-safe-test-password", password_confirmation: "new-safe-test-password" }, { authorization: "Bearer fake-token" });
  assert.equal(response.status, 401);
  const first = f.calls.find(call => call.type === "rpc" || call.type === "auth");
  assert.equal(first.name, "staff_auth_rate_limit");
  assert.equal(authCalls(f).some(call => call.method === "updateUser"), false);
});

test("password reset requires server-verified recent recovery/invite AMR or Supabase current-password validation", async () => {
  const input = { action: "set_password", password: "new-safe-test-password", password_confirmation: "new-safe-test-password" };
  for (const method of ["recovery", "invite"]) {
    const f = fixture({ getClaims: () => ok({ claims: { sub: USER, amr: [{ method, timestamp: NOW / 1000 - 30 }] } }) });
    assert.equal((await f.send(input, { authorization: "Bearer recovery-session" })).status, 200);
    assert.equal(authCalls(f).filter(call => call.method === "updateUser").length, 1);
  }
  for (const claims of [{ sub: USER, amr: [{ method: "password", timestamp: NOW / 1000 }] }, { sub: USER, amr: [{ method: "recovery", timestamp: NOW / 1000 - 901 }] }, { sub: "other", amr: [{ method: "recovery", timestamp: NOW / 1000 }] }]) {
    const f = fixture({ getClaims: () => ok({ claims }) });
    assert.equal((await f.send(input, { authorization: "Bearer ordinary-session" })).status, 400);
    assert.equal(authCalls(f).some(call => call.method === "updateUser"), false);
  }
  const f = fixture();
  assert.equal((await f.send({ ...input, current_password: "actual-existing-password" }, { authorization: "Bearer ordinary-session" })).status, 200);
  assert.deepEqual(authCalls(f).find(call => call.method === "updateUser").args[0], { password: "new-safe-test-password", current_password: "actual-existing-password" });
  assert.deepEqual(authCalls(f).find(call => call.method === "signInWithPassword").args[0], { email: EMAIL, password: "actual-existing-password" });
  assert.deepEqual(authCalls(f).find(call => call.method === "signOut").args[0], { scope: "local" });
  assert.equal(authCalls(f).some(call => call.method === "getClaims"), false);
});

test("wrong current password cannot reach update even if Auth password-change setting is permissive", async () => {
  const f = fixture({ signInWithPassword: () => bad("invalid_credentials") });
  const response = await f.send({ action: "set_password", password: "new-safe-test-password", password_confirmation: "new-safe-test-password", current_password: "wrong-password" }, { authorization: "Bearer ordinary-session" });
  assert.equal(response.status, 400);
  assert.equal(authCalls(f).some(call => call.method === "updateUser"), false);
});

test("stateless Auth update uses verified bearer official REST and snake-case current_password without refresh token", async () => {
  const requests = [];
  const result = await updateAuthUser("https://auth.example.invalid/", "sb_publishable_test", "verified-bearer", { password: "new-safe-password", current_password: "verified-current-password" }, null, async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ id: USER }), { headers: { "content-type": "application/json" } });
  });
  assert.equal(result.data.user.id, USER);
  assert.equal(requests[0].url, "https://auth.example.invalid/auth/v1/user");
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.headers.Authorization, "Bearer verified-bearer");
  assert.equal(requests[0].init.headers["Sb-Forwarded-For"], undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), { password: "new-safe-password", current_password: "verified-current-password" });
  assert.equal(JSON.stringify(requests).includes("refresh_token"), false);
  const failed = await updateAuthUser("https://auth.example.invalid", "key", "bearer", { password: "new-safe-password" }, null, async () => new Response(JSON.stringify({ error: `private ${EMAIL}` }), { status: 422 }));
  assert.deepEqual(failed, { data: null, error: { code: "password_update_failed" } });
});

test("failed password save is not reported as success", async () => {
  const f = fixture({ updateUser: () => bad("same_password") });
  const response = await f.send({ action: "set_password", password: "new-safe-test-password", password_confirmation: "new-safe-test-password" }, { authorization: "Bearer recovery-session" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "password_update_failed" });
});

test("Owner reset binds an authenticated audited operation and sends only the new password to Auth Admin", async () => {
  const f = ownerFixture();
  const response = await f.send(ownerReset(), ownerHeaders);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, code: "owner_password_reset_succeeded", operation_id: OPERATION });
  const mutation = authCalls(f).find(call => call.method === "admin.updateUserById");
  assert.deepEqual(mutation.args, [TARGET, { password: "new-password-for-member" }]);
  assert.deepEqual(rpcCalls(f, "office_owner_begin_password_reset")[0].args, { p_user_id: TARGET, p_operation_id: OPERATION, p_reason: "本人確認後の依頼による初期化" });
  assert.deepEqual(rpcCalls(f, "staff_auth_owner_password_claim")[0].args, { p_operation_id: OPERATION, p_actor_id: USER });
  assert.deepEqual(rpcCalls(f, "staff_auth_owner_password_finish")[0].args, { p_operation_id: OPERATION, p_actor_id: USER, p_state: "succeeded" });
  for (const call of rpcCalls(f)) assert.equal(JSON.stringify(call.args).includes("new-password-for-member"), false);
  assert.equal(f.operations.get(OPERATION).target_user_id, TARGET);
  assert.equal(authCalls(f).some(call => ["updateUser", "resetPasswordForEmail", "signInWithOtp", "admin.createUser"].includes(call.method)), false);
});

test("non-Owner, pending role and revoked current sessions cannot reach Owner Auth mutation", async () => {
  for (const overrides of [{ ownerRole: "administrator" }, { ownerRole: "editor" }, { ownerRole: "pending" }, { sessionRevoked: true }]) {
    const f = ownerFixture(overrides);
    const response = await f.send(ownerReset(), ownerHeaders);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "owner_password_reset_denied", operation_id: OPERATION });
    assert.equal(authCalls(f).some(call => call.method === "admin.updateUserById"), false);
  }
  const missing = ownerFixture();
  assert.equal((await missing.send(ownerReset())).status, 401);
  assert.equal(rpcCalls(missing, "office_owner_begin_password_reset").length, 0);
  const revokedBetween = ownerFixture({ rpc: name => name === "staff_auth_owner_password_claim" ? bad("42501") : undefined });
  assert.equal((await revokedBetween.send(ownerReset(), ownerHeaders)).status, 403);
  assert.equal(authCalls(revokedBetween).some(call => call.method === "admin.updateUserById"), false);
});

test("privileged password reset requires recent signed authentication, not refreshed JWT time or a recovery claim", async () => {
  for (const claims of [
    { sub: "other-user" },
    { amr: [{ method: "password", timestamp: NOW / 1000 - 901 }], iat: NOW / 1000 },
    { amr: [{ method: "token_refresh", timestamp: NOW / 1000 }] },
    { amr: [{ method: "recovery", timestamp: NOW / 1000 }] },
    { amr: [{ method: "invite", timestamp: NOW / 1000 }] },
    { amr: [{ method: "email/signup", timestamp: NOW / 1000 }] },
    { amr: [{ method: "password", timestamp: NOW / 1000 + 61 }] },
    { amr: [{ method: "password", timestamp: Infinity }] },
    { amr: ["password", null] },
  ]) {
    const f = ownerFixture({ getClaims: () => ownerClaims(claims) });
    const response = await f.send(ownerReset(), ownerHeaders);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "reauthentication_required", operation_id: OPERATION });
    assert.equal(rpcCalls(f, "office_owner_begin_password_reset").length, 0);
    assert.equal(authCalls(f).some(call => call.method === "admin.updateUserById"), false);
  }
  for (const method of ["password", "otp", "magiclink", "totp", "webauthn"]) {
    const f = ownerFixture({ getClaims: () => ownerClaims({ amr: [{ method, timestamp: NOW / 1000 - 30 }] }) });
    assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 200);
  }
});

test("Owner verified MFA requires signed AAL2 and malformed factor data fails closed", async () => {
  for (const factors of [[{ status: "verified", factor_type: "totp" }], null, {}, [null], [{ status: "unknown" }], ["verified"]]) {
    const f = ownerFixture({ getUser: () => ok({ user: { id: USER, factors } }) });
    assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 409);
    assert.equal(authCalls(f).some(call => call.method === "admin.updateUserById"), false);
  }
  const strong = ownerFixture({ getUser: () => ok({ user: { id: USER, factors: [{ status: "verified", factor_type: "totp" }] } }), getClaims: () => ownerClaims({ aal: "aal2", amr: [{ method: "totp", timestamp: NOW / 1000 }] }) });
  assert.equal((await strong.send(ownerReset(), ownerHeaders)).status, 200);
});

test("Owner reset rejects forged actor, role, target substitutions and secrets placed in audit reason", async () => {
  for (const extra of [{ actor_id: TARGET }, { role: "owner" }, { user_metadata: { role: "owner" } }, { old_password: "must-not-request-old-password" }, { reason: "new-password-for-member" }, { operation_id: "not-a-uuid" }]) {
    const f = ownerFixture();
    assert.equal((await f.send(ownerReset(extra), ownerHeaders)).status, 400);
    assert.equal(authCalls(f).some(call => call.method === "admin.updateUserById"), false);
    assert.equal(rpcCalls(f, "office_owner_begin_password_reset").length, 0);
  }
  for (const name of ["office_owner_begin_password_reset", "staff_auth_owner_password_claim"]) {
    const f = ownerFixture({ rpc: current => current === name ? ok({ operation_id: OPERATION, actor_id: USER, target_user_id: USER, state: current === "staff_auth_owner_password_claim" ? "executing" : "requested" }) : undefined });
    assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 409);
    assert.equal(authCalls(f).some(call => call.method === "admin.updateUserById"), false);
  }
});

test("the sole legacy Owner may reset their own password without changing UUID, email, metadata or role", async () => {
  const f = ownerFixture();
  const response = await f.send(ownerReset({ user_id: USER }), ownerHeaders);
  assert.equal(response.status, 200);
  assert.deepEqual(authCalls(f).find(call => call.method === "admin.updateUserById").args, [USER, { password: "new-password-for-member" }]);
  assert.equal(f.operations.get(OPERATION).actor_id, USER);
  assert.equal(f.operations.get(OPERATION).target_user_id, USER);
  assert.equal(rpcCalls(f).some(call => /role|approve|delete/.test(call.name)), false);
});

test("one operation never calls Auth twice, including concurrency and terminal success replay with different input", async () => {
  let started;
  let finish;
  const running = new Promise(resolve => { started = resolve; });
  const f = ownerFixture({ updateUserById: userId => {
    started();
    return new Promise(resolve => { finish = () => resolve(ok({ user: { id: userId } })); });
  } });
  const first = f.send(ownerReset(), ownerHeaders);
  await running;
  const second = await f.send(ownerReset(), ownerHeaders);
  assert.equal(second.status, 409);
  finish();
  assert.equal((await first).status, 200);
  const replay = await f.send(ownerReset({ password: "different-new-password", password_confirmation: "different-new-password" }), ownerHeaders);
  assert.deepEqual(await replay.json(), { success: true, code: "owner_password_reset_already_succeeded", operation_id: OPERATION });
  assert.equal(authCalls(f).filter(call => call.method === "admin.updateUserById").length, 1);
  const substitution = await f.send(ownerReset({ user_id: USER }), ownerHeaders);
  assert.equal(substitution.status, 409);
  assert.equal(f.operations.get(OPERATION).target_user_id, TARGET);
});

test("definite native rejection is audited as failed without returning provider details or retrying Auth", async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const f = ownerFixture({ updateUserById: () => ({ data: null, error: { status, message: `private ${EMAIL}` } }) });
    const response = await f.send(ownerReset(), ownerHeaders);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "owner_password_reset_failed", operation_id: OPERATION });
    assert.equal(f.operations.get(OPERATION).state, "failed");
    assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 400);
    assert.equal(authCalls(f).filter(call => call.method === "admin.updateUserById").length, 1);
  }
});

test("network, timeout, native 5xx and mismatched results are uncertain and never automatically retried", async () => {
  for (const updateUserById of [
    () => { throw new Error("network failed after Auth might commit"); },
    () => ({ data: null, error: { status: 0 } }),
    () => ({ data: null, error: { status: 408 } }),
    () => ({ data: null, error: { status: 500 } }),
    () => ok({ user: { id: USER } }),
  ]) {
    const f = ownerFixture({ updateUserById });
    const response = await f.send(ownerReset(), ownerHeaders);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "owner_password_reset_uncertain", operation_id: OPERATION });
    assert.equal(f.operations.get(OPERATION).state, "uncertain");
    assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 409);
    assert.equal(authCalls(f).filter(call => call.method === "admin.updateUserById").length, 1);
  }
});

test("successful Auth change with missing audit confirmation stays uncertain and cannot repeat the mutation", async () => {
  const f = ownerFixture({ rpc: name => name === "staff_auth_owner_password_finish" ? bad("XX000") : undefined });
  const response = await f.send(ownerReset(), ownerHeaders);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "owner_password_reset_uncertain", operation_id: OPERATION });
  assert.equal(f.operations.get(OPERATION).state, "executing");
  assert.equal((await f.send(ownerReset(), ownerHeaders)).status, 409);
  assert.equal(authCalls(f).filter(call => call.method === "admin.updateUserById").length, 1);
});

test("CORS, body bounds, JSON types, unknown fields and disabled rollout reject before Auth", async () => {
  const f = fixture();
  assert.equal((await f.send({ action: "login" }, { origin: "https://attacker.example.invalid" })).status, 403);
  assert.equal((await f.send({ action: "login" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.send({ action: "login", padding: "x".repeat(9000) })).status, 413);
  assert.equal((await f.send([])).status, 400);
  assert.equal((await f.send({ action: "lookup_email", username: "member" })).status, 400);
  assert.equal((await f.send(registration({ notice_accepted: false }))).status, 400);
  assert.equal((await f.send(registration({ password_confirmation: "different" }))).status, 400);
  assert.equal((await f.send(registration({ real_name: "invalid\nname" }))).status, 400);
  assert.equal(authCalls(f).length, 0);
  const disabled = fixture({ config: { enabled: false } });
  assert.equal((await disabled.send({ action: "login" })).status, 503);
  assert.equal(rpcCalls(disabled).length, 0);
});

test("optional IP relies on explicit verified-ingress attestation; spoofed XFF chains never accepted", async () => {
  assert.equal(normalizeIp("203.0.113.4"), "203.0.113.4");
  assert.equal(normalizeIp("2001:db8:0:0::1"), "2001:db8::1");
  for (const value of ["1.2.3.999", "01.2.3.4", "1.2.3.4, 5.6.7.8", "2001:db8::1%eth0", "1.2.3.4:1234"]) assert.equal(normalizeIp(value), null);
  const request = new Request("https://test.invalid", { headers: { "cf-connecting-ip": "203.0.113.4", "x-forwarded-for": "198.51.100.8" } });
  assert.equal(trustedClientIp(request, configuration()), null);
  assert.throws(() => trustedClientIp(request, configuration({ ipMode: "attested-header", ipHeader: "cf-connecting-ip" })));
  assert.throws(() => trustedClientIp(request, configuration({ ipMode: "attested-header", ipHeader: "x-forwarded-for", ipHeaderAttested: true })));
  const f = fixture({ config: { ipMode: "attested-header", ipHeader: "cf-connecting-ip", ipHeaderAttested: true, forwardAuthIp: true, forwardedForOptIn: true, authSecretKey: "sb_secret_test" } });
  assert.equal((await f.send({ action: "login", username: "member", password: "password" }, { "cf-connecting-ip": "203.0.113.4" })).status, 200);
  assert.equal(f.calls.find(call => call.type === "client").ip, "203.0.113.4");
  assert.equal(rpcCalls(f, "staff_auth_rate_limit").some(call => call.args.p_bucket === "login:ip"), true);
  for (const config of [{ forwardAuthIp: true }, { forwardAuthIp: true, forwardedForOptIn: true, authSecretKey: "sb_secret_test" }]) {
    const broken = fixture({ config });
    assert.equal((await broken.send({ action: "login", username: "member", password: "password" }, { "x-forwarded-for": "203.0.113.4" })).status, 503);
    assert.equal(authCalls(broken).length, 0);
  }
});

test("configuration has no implicit project/domain, wildcard origin or arbitrary credential selection", () => {
  const env = values => key => values[key];
  const defaults = readGatewayConfig(env({}), "legacy-key");
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.registrationEnabled, false);
  assert.equal(defaults.registrationCaptchaMode, "unconfigured");
  assert.equal(readGatewayConfig(env({ STAFF_AUTH_REGISTRATION_CAPTCHA_MODE: "false" }), "secret").registrationCaptchaMode, "unconfigured");
  assert.equal(readGatewayConfig(env({ STAFF_AUTH_REGISTRATION_CAPTCHA_MODE: "disabled" }), "secret").registrationCaptchaMode, "disabled");
  assert.deepEqual(defaults.allowedOrigins, []);
  assert.equal(defaults.emailRedirectTo, "");
  assert.equal(defaults.ipMode, "disabled");
  for (const origin of ["*", "https://example.invalid/path", "http://public.example.invalid"]) assert.deepEqual(readGatewayConfig(env({ STAFF_AUTH_ALLOWED_ORIGINS: JSON.stringify([origin]) }), "secret").allowedOrigins, []);
  assert.equal(serverKey(env({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_test" }) }), "SUPABASE_SECRET_KEYS", "OLD"), "sb_secret_test");
  assert.throws(() => serverKey(env({ SUPABASE_SECRET_KEYS: JSON.stringify({ one: "first", two: "second" }), OLD: "old" }), "SUPABASE_SECRET_KEYS", "OLD"));
});

test("installed Supabase SDK provisions only through service Admin API with no email request or new session", async () => {
  const requests = [];
  const sdk = createClient("https://sdk-test.example.invalid", "sb_secret_test_server_only", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      return Response.json({ id: USER, email: "new-account@example.invalid", email_confirmed_at: new Date(NOW).toISOString(), created_at: new Date(NOW).toISOString() });
    } },
  });
  const f = fixture();
  const handler = createGateway({ config: configuration(), service: { rpc: f.client.rpc, auth: sdk.auth }, authClient: () => f.client, userClient: () => f.client, verifyRegistrationCaptcha: async () => "unavailable" });
  const response = await handler(new Request("https://edge-test.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registration()) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, code: "registration_received" });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/auth/v1/admin/users");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { email: "new-account@example.invalid", password: "safe-test-password-only", email_confirm: true, app_metadata: { staff_signup_policy: "manual_approval_no_email_v1" } });
  assert.equal(requests[0].url.includes("safe-test-password-only"), false);
  assert.equal((await sdk.auth.getSession()).data.session, null);
  assert.equal(rpcCalls(f, "staff_auth_finalize").length, 1);
});

test("installed Supabase SDK performs exactly one password-only Admin PUT and never returns the Auth user", async () => {
  for (const outcome of ["success", "server_error", "network_unknown"]) {
    const requests = [];
    const sdk = createClient("https://sdk-test.example.invalid", "sb_secret_test_server_only", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
        if (outcome === "network_unknown") throw new TypeError("fake dropped response");
        if (outcome === "server_error") return Response.json({ code: "unexpected_failure", msg: "private provider detail" }, { status: 503 });
        return Response.json({ id: TARGET, email: EMAIL, app_metadata: { private: "must-not-return" } });
      } },
    });
    const f = ownerFixture();
    const handler = createGateway({ config: configuration(), service: { rpc: f.client.rpc, auth: sdk.auth }, authClient: () => f.client, userClient: () => f.client, verifyRegistrationCaptcha: async () => "unavailable", now: () => NOW });
    const response = await handler(new Request("https://edge-test.invalid", { method: "POST", headers: { "content-type": "application/json", ...ownerHeaders }, body: JSON.stringify(ownerReset()) }));
    assert.equal(response.status, outcome === "success" ? 200 : 409);
    const body = await response.json();
    assert.equal(body.code ?? body.error, outcome === "success" ? "owner_password_reset_succeeded" : "owner_password_reset_uncertain");
    assert.equal(body.operation_id, OPERATION);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, `/auth/v1/admin/users/${TARGET}`);
    assert.equal(requests[0].method, "PUT");
    assert.deepEqual(requests[0].body, { password: "new-password-for-member" });
    for (const secret of [EMAIL, TARGET, "new-password-for-member", "must-not-return", "private provider detail", "sb_secret_test_server_only"]) assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal((await sdk.auth.getSession()).data.session, null);
    assert.equal(f.operations.get(OPERATION).state, outcome === "success" ? "succeeded" : "uncertain");
  }
});

test("installed Supabase SDK sends actual password login/recovery wire contract without secret in URL or metadata", async () => {
  const requests = [];
  const sdk = createClient("https://sdk-test.example.invalid", "sb_publishable_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      requests.push({ url: String(input), init, body: init?.body ? JSON.parse(init.body) : null });
      if (String(input).includes("/token?grant_type=password")) return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: 3600, user: { id: USER, email: EMAIL } }), { headers: { "content-type": "application/json" } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    } },
  });
  const f = fixture();
  const handler = createGateway({ config: configuration(), service: f.client, authClient: () => sdk, userClient: () => sdk });
  const response = await handler(new Request("https://edge-test.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", username: "member", password: "actual-password-for-sdk-test" }) }));
  assert.equal(response.status, 200);
  assert.equal(requests[0].body.email, EMAIL);
  assert.equal(requests[0].body.password, "actual-password-for-sdk-test");
  assert.equal(requests[0].body.data, undefined);
  assert.equal(requests[0].url.includes("actual-password"), false);
  await sdk.auth.resetPasswordForEmail(EMAIL, { redirectTo: "https://club.example.invalid/admin/help/" });
  assert.match(requests[1].url, /\/recover\?redirect_to=/);
  assert.equal(new URL(requests[1].url).searchParams.get("redirect_to"), "https://club.example.invalid/admin/help/");
});

test("legacy invitation checks migrated DB capability before any email or membership mutation", async () => {
  for (const capabilities of [ok({ staff_identity: true }), ok({}), bad("XX000")]) {
    let sent = 0;
    let inserted = 0;
    const handler = createLegacyInviteHandler(async () => ({ client: {
      rpc: async name => { assert.equal(name, "office_capabilities"); return capabilities; },
      from: () => { inserted++; throw new Error("must not reach role writes"); },
    }, service: { auth: { admin: { inviteUserByEmail: async () => { sent++; throw new Error("must not send email"); } } } } }));
    const response = await handler(new Request("https://edge.invalid/invite-staff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, role: "editor" }) }));
    assert.equal(response.status, capabilities.error ? 503 : capabilities.data.staff_identity ? 409 : 403);
    assert.equal(sent, 0);
    assert.equal(inserted, 0);
  }
});

test("legacy invitation remains compatible before identity migration", async () => {
  let sent = 0;
  let inserted = 0;
  const handler = createLegacyInviteHandler(async () => ({ client: {
    rpc: async () => ok({ schedule: true, content: true }),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ok(null) }) }),
      insert: async row => { inserted++; assert.equal(row.user_id, USER); return ok(null); },
    }),
  }, service: { auth: { admin: { inviteUserByEmail: async () => { sent++; return ok({ user: { id: USER } }); } } } } }));
  const response = await handler(new Request("https://edge.invalid/invite-staff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, role: "editor" }) }));
  assert.equal(response.status, 200);
  assert.equal(sent, 1);
  assert.equal(inserted, 1);
});
