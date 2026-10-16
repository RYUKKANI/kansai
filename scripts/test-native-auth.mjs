import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// [편집 안내] 이 파일은 운영 계정을 다루는 지원 도구가 아닙니다. 스스로 만든 임시 프로젝트와
// loopback 주소만 쓰며, CLI/메일/HTTP 원문에는 토큰이 있어 실패 시에도 출력하지 않습니다.
const CLI_VERSION = "2.121.0";
const APP_ORIGIN = "http://127.0.0.1:4321";
const PROJECT_PREFIX = "kansai-auth-ci-";
const repository = path.resolve(import.meta.dirname, "..");
const localOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const processEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith("SUPABASE_") && !name.startsWith("STAFF_AUTH_") && !name.startsWith("PUBLIC_SUPABASE_")));
let stage = "prerequisites";
let temporary;
let projectId;
let functionProcess;
let started = false;
const clients = [];

class NativeAuthFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function verify(condition, code) {
  if (!condition) throw new NativeAuthFailure(code);
}
// 네이티브/게이트웨이 실패는 고정 코드와 HTTP 상태만 진단합니다. 메시지·요청값·사용자 응답은 출력하지 않습니다.
function safeFailure(status, code) {
  const allowed = new Set(["email_provider_disabled", "invalid_credentials", "email_not_confirmed", "signup_disabled",
    "over_request_rate_limit", "over_email_send_rate_limit", "captcha_failed", "unexpected_failure", "validation_failed",
    "bad_jwt", "not_authenticated", "invalid_api_key", "origin_denied", "feature_unavailable", "service_unavailable", "rate_limited", "invalid_request"]);
  const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : "unknown";
  return `http_${http}_${allowed.has(code) ? code : "unclassified"}`;
}
function localAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new NativeAuthFailure("invalid_local_address"); }
  verify(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password, "remote_address_refused");
  return url;
}
function report(label) { process.stdout.write(`Native Auth: ${label}\n`); }
function run(program, args, { input, timeout = 120000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: repository, env: processEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); }, timeout);
    // 출력에는 로컬 서비스 키도 들어갈 수 있습니다. 메모리에서만 읽고 기록/출력하지 않습니다.
    child.stdout.on("data", chunk => { if (stdout.length < 16000000) stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { if (stderr.length < 16000000) stderr += chunk.toString(); });
    child.once("error", () => { clearTimeout(timer); reject(new NativeAuthFailure("command_unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (expired || code !== 0 && !allowFailure) reject(new NativeAuthFailure(expired ? "command_timeout" : "command_failed"));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}
const cliArguments = args => ["--yes", `supabase@${CLI_VERSION}`, ...args, "--workdir", temporary];
const cli = (args, options) => run("npx", cliArguments(args), options);
async function sql(query) {
  verify(temporary && projectId?.startsWith(PROJECT_PREFIX), "isolated_database_required");
  return (await run("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"], { input: query })).stdout.trim();
}
function uuid(value) {
  verify(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), "invalid_fixture_uuid");
  return value;
}
function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function configValue(source, section, key, value) {
  const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = section ? new RegExp(`^\\[${escaped(section)}\\]\\s*$`, "m").exec(source) : null;
  if (section && !header) return source + `\n[${section}]\n${key} = ${value}\n`;
  const start = header ? header.index + header[0].length : 0;
  const tail = source.slice(start);
  const next = /^\[/m.exec(tail);
  const end = next ? start + next.index : source.length;
  const content = source.slice(start, end);
  const assignment = new RegExp(`^${escaped(key)}\\s*=.*$`, "m");
  const updated = assignment.test(content) ? content.replace(assignment, `${key} = ${value}`) : content + `\n${key} = ${value}\n`;
  return source.slice(0, start) + updated + source.slice(end);
}
async function localFetch(address, options = {}) {
  localAddress(address instanceof Request ? address.url : address);
  return fetch(address, { ...options, redirect: "manual", signal: AbortSignal.timeout(20000) });
}
async function waitFor(task, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await task()) return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new NativeAuthFailure(label);
}
function data(result, label) {
  verify(result && !result.error && result.data !== null, label);
  return result.data;
}
function client(url, key, options = {}) {
  localAddress(url);
  const result = createClient(url, key, { auth: localOptions, ...options });
  clients.push(result);
  return result;
}

async function main() {
  // CLI 명령에 --project-ref/link/remote를 받지 않습니다. 시작 전 Docker가 없으면 명확히 실패합니다.
  await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  const installed = await run("npx", ["--yes", `supabase@${CLI_VERSION}`, "--version"]);
  verify(installed.stdout.trim() === CLI_VERSION, "cli_version_mismatch");
  temporary = await mkdtemp(path.join(os.tmpdir(), "kansai-native-auth-"));
  projectId = PROJECT_PREFIX + randomBytes(5).toString("hex");
  await cli(["init"]);
  await cp(path.join(repository, "supabase", "migrations"), path.join(temporary, "supabase", "migrations"), { recursive: true });
  await cp(path.join(repository, "supabase", "functions"), path.join(temporary, "supabase", "functions"), { recursive: true });
  // 고정 CLI가 생성한 기본 설정을 보존하고 이번 검사에서 필요한 값만 바꿉니다.
  // 운영 config.toml은 수정하지 않습니다. 공개 가입 차단과 비밀번호 제공자 유지,
  // 기존 이메일 계정 복구용 Confirm Email·로컬 Mailpit 수신을 각각 확인합니다.
  const configPath = path.join(temporary, "supabase", "config.toml");
  let config = await readFile(configPath, "utf8");
  const settings = [
    ["", "project_id", projectId],
    ["api", "enabled", true], ["api", "port", 54321],
    ["api", "schemas", ["public", "graphql_public"]], ["api", "extra_search_path", ["public", "extensions"]],
    ["db", "port", 54322], ["db", "shadow_port", 54320], ["db", "major_version", 17],
    ["db.seed", "enabled", false], ["local_smtp", "enabled", true], ["local_smtp", "port", 54324],
    ["auth", "enabled", true], ["auth", "site_url", APP_ORIGIN + "/"],
    ["auth", "additional_redirect_urls", [APP_ORIGIN + "/admin/", APP_ORIGIN + "/admin/help/"]],
    ["auth", "jwt_expiry", 3600], ["auth", "enable_signup", false], ["auth", "enable_anonymous_sign_ins", false],
    // CLI의 email.enable_signup은 GOTRUE_EXTERNAL_EMAIL_ENABLED에도 연결됩니다. 이메일/비밀번호 제공자는
    // 유지하고 위의 auth.enable_signup=false로 공개 가입만 차단해야 기존 계정이 로그인할 수 있습니다.
    ["auth.email", "enable_signup", true], ["auth.email", "enable_confirmations", true], ["auth.email", "max_frequency", "60s"],
    ["storage", "enabled", true], ["storage", "file_size_limit", "10MiB"],
    ["functions.staff-auth", "enabled", true], ["functions.staff-auth", "verify_jwt", false],
    ["functions.staff-auth", "entrypoint", "./functions/staff-auth/index.ts"],
  ];
  for (const [section, key, value] of settings) config = configValue(config, section, key, JSON.stringify(value));
  await writeFile(configPath, config, { mode: 0o600 });
  const gatewayEnvironment = {
    STAFF_AUTH_ENABLED: "true",
    STAFF_AUTH_REGISTRATION_ENABLED: "true",
    STAFF_AUTH_REGISTRATION_CAPTCHA_MODE: "disabled",
    STAFF_AUTH_LEGACY_EMAIL_ENABLED: "true",
    STAFF_AUTH_SUPPORT_RECOVERY_ENABLED: "true",
    STAFF_AUTH_ALLOWED_ORIGINS: JSON.stringify([APP_ORIGIN]),
    STAFF_AUTH_LOGIN_REDIRECT_URL: `${APP_ORIGIN}/admin/`,
    STAFF_AUTH_RECOVERY_REDIRECT_URL: `${APP_ORIGIN}/admin/help/`,
    STAFF_AUTH_RATE_HMAC_SECRET: randomBytes(32).toString("hex"),
    STAFF_AUTH_IP_MODE: "disabled",
    STAFF_AUTH_FORWARD_AUTH_IP: "false",
  };
  const envFile = path.join(temporary, "gateway.env");
  await writeFile(envFile, Object.entries(gatewayEnvironment).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", { mode: 0o600 });
  stage = "start isolated Supabase and apply all migrations";
  report(`starting disposable stack with CLI ${CLI_VERSION}`);
  // 초기화 실패 중 만든 컨테이너도 finally에서 이 고유 프로젝트 ID로만 정리합니다.
  started = true;
  await cli(["start", "--exclude", "studio,postgres-meta,imgproxy,realtime,logflare,vector,supavisor"], { timeout: 1200000 });
  const status = JSON.parse((await cli(["status", "-o", "json"])).stdout);
  const api = localAddress(status.API_URL).origin;
  const mailbox = localAddress(status.INBUCKET_URL ?? status.MAILPIT_URL).origin;
  async function mailboxCount() {
    const response = await localFetch(`${mailbox}/api/v1/messages?limit=50`);
    verify(response.ok, "mailbox_listing_unavailable");
    const listing = await response.json();
    verify(Number.isInteger(listing.total), "mailbox_count_missing");
    return listing.total;
  }
  const publicKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const serverKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  verify(typeof publicKey === "string" && typeof serverKey === "string", "local_credentials_missing");
  const health = await localFetch(`${api}/auth/v1/health`, { headers: { apikey: publicKey } });
  verify(health.ok, "native_auth_unhealthy");
  const version = (await health.json()).version;
  verify(typeof version === "string" && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version), "native_auth_version_missing");
  report(`native Auth ${version}; migrations applied`);

  stage = "verify public native signup is blocked while the password provider remains enabled";
  const settingsResponse = await localFetch(`${api}/auth/v1/settings`, { headers: { apikey: publicKey } });
  verify(settingsResponse.ok, "native_auth_settings_unavailable");
  const authSettings = await settingsResponse.json();
  verify(authSettings.disable_signup === true, "native_public_signup_enabled");
  verify(authSettings.external?.email === true, "native_email_password_provider_disabled");
  // 승인·요청 제한을 거치는 서버 가입 경로만 사용해야 합니다. UI가 감춘 것만으로 통과하지
  // 않도록 실제 익명 SDK 요청의 거절과 DB/메일 부작용 부재를 함께 검사합니다.
  const directSignupEmail = `direct-signup-${randomBytes(5).toString("hex")}@example.test`;
  const mailCountBeforeDirectSignup = await mailboxCount();
  const directSignup = await client(api, publicKey).auth.signUp({
    email: directSignupEmail, password: randomBytes(24).toString("base64url"),
  });
  verify(directSignup.error?.code === "signup_disabled" && directSignup.error.status >= 400 && directSignup.error.status < 500,
    "native_public_signup_not_rejected_" + safeFailure(directSignup.error?.status, directSignup.error?.code));
  verify(directSignup.data?.user === null && directSignup.data?.session === null, "native_public_signup_returned_account");
  verify(await sql(`select count(*) from auth.users where email=${sqlLiteral(directSignupEmail)};`) === "0", "native_public_signup_created_account");
  verify(await mailboxCount() === mailCountBeforeDirectSignup, "native_public_signup_sent_email");
  report("direct public Auth signup is disabled, creates no account or mail, and the password provider stays enabled");
  functionProcess = spawn("npx", cliArguments(["functions", "serve", "staff-auth", "--env-file", envFile]), {
    cwd: repository, env: processEnvironment, stdio: ["ignore", "pipe", "pipe"],
  });
  // Edge 로그에도 입력값이 포함될 수 있으므로 결과물이나 CI 로그로 전달하지 않습니다.
  functionProcess.stdout.resume();
  functionProcess.stderr.resume();
  functionProcess.on("error", () => {});
  await waitFor(async () => {
    if (functionProcess.exitCode !== null) throw new NativeAuthFailure("edge_runtime_stopped");
    try {
      const response = await localFetch(`${api}/functions/v1/staff-auth`, { method: "OPTIONS", headers: { Origin: APP_ORIGIN } });
      return response.status === 204;
    } catch { return false; }
  }, "edge_runtime_not_ready", 120000);
  const service = client(api, serverKey);
  async function gateway(body, token) {
    const response = await localFetch(`${api}/functions/v1/staff-auth`, {
      method: "POST", headers: { apikey: publicKey, "Content-Type": "application/json", Origin: APP_ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function rpc(name, body, token) {
    const response = await localFetch(`${api}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: publicKey, "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function idLogin(username, password) {
    const result = await gateway({ action: "login", username, password });
    verify(result.status === 200 && typeof result.body.session?.access_token === "string", "gateway_login_failed_" + safeFailure(result.status, result.body.error));
    const current = client(api, publicKey);
    data(await current.auth.setSession(result.body.session), "gateway_session_failed");
    return current;
  }
  const ownerEmail = `owner-${randomBytes(5).toString("hex")}@example.test`;
  const ownerUsername = "native.owner";
  const initialPassword = randomBytes(24).toString("base64url");
  const recoveredPassword = randomBytes(24).toString("base64url");
  const supportedPassword = randomBytes(24).toString("base64url");
  const replayPassword = randomBytes(24).toString("base64url");
  const forgedActorId = randomUUID();
  stage = "create isolated Owner through native Auth";
  const owner = data(await service.auth.admin.createUser({ email: ownerEmail, password: initialPassword, email_confirm: true,
    user_metadata: { actor_id: forgedActorId, real_name: "CI forged actor", role: "coach" } }), "native_owner_creation_failed").user;
  verify(owner?.id, "native_owner_missing");
  uuid(owner.id);
  await sql(`insert into public.admin_roles(user_id,email,role,active) values(${sqlLiteral(owner.id)}::uuid,${sqlLiteral(ownerEmail)},'owner',true);`);
  data(await service.rpc("staff_auth_bootstrap_owner", { p_user_id: owner.id, p_username: ownerUsername }), "owner_identity_bootstrap_failed");
  // 첫 게이트웨이 요청 전 네이티브 제공자를 한 번 확인해 로컬 설정 오류와 아이디 경로 오류를 구분합니다.
  // 게이트웨이 식별자 제한은 소비하지 않으며, 오류 원문이나 자격 증명은 출력하지 않습니다.
  const nativeLogin = await client(api, publicKey).auth.signInWithPassword({ email: ownerEmail, password: initialPassword });
  verify(!nativeLogin.error && nativeLogin.data?.user?.id === owner.id,
    "native_owner_password_login_failed_" + safeFailure(nativeLogin.error?.status, nativeLogin.error?.code));
  report("native email/password provider accepts the disposable Owner");
  const initialOwner = await idLogin(ownerUsername.toUpperCase(), initialPassword);
  const initialToken = data(await initialOwner.auth.getSession(), "initial_owner_session_missing").session?.access_token;
  verify(initialToken && data(await initialOwner.auth.getUser(), "initial_owner_user_failed").user.id === owner.id, "initial_owner_uuid_mismatch");
  const ownerState = await rpc("office_account_state", {}, initialToken);
  verify(ownerState.status === 200 && ownerState.body.role === "owner", "native_owner_role_missing");

  stage = "unverified legacy Owner name update and trusted audit actor";
  verify(ownerState.body.profile_enrollment_pending === true && ownerState.body.name_edit_mode === "unverified_edit" && ownerState.body.can_edit_real_name === true,
    "legacy_owner_unverified_edit_not_available");
  // 이름·수정 시각을 뺀 원래 계정/권한과 최소 Auth 필드만 메모리에서 비교합니다. 해시를 읽지 않으며
  // 이름 입력만으로 소속·동의·본인 확인·선수·콘텐츠가 만들어지지 않는지 실제 DB에서 확인합니다.
  const protectedIdentityQuery = `select jsonb_build_object('account',to_jsonb(a)-'real_name'-'updated_at','role',to_jsonb(r),
    'auth',jsonb_build_object('id',u.id,'email',u.email,'app_metadata',u.raw_app_meta_data,'user_metadata',u.raw_user_meta_data),
    'content_counts',jsonb_build_object('players',(select count(*) from public.players),'articles',(select count(*) from public.articles),
      'fixtures',(select count(*) from public.fixtures),'media_assets',(select count(*) from public.media_assets)))::text
    from private.staff_accounts a join public.admin_roles r on r.user_id=a.user_id join auth.users u on u.id=a.user_id
    where a.user_id=${sqlLiteral(owner.id)}::uuid;`;
  const protectedIdentityBefore = await sql(protectedIdentityQuery);
  const unverifiedName = "CI 山田 류컁이 Ana-María";
  const nameReason = "CI unverified profile correction";
  const nameUpdated = await rpc("office_update_unverified_name", { p_real_name: unverifiedName, p_reason: nameReason }, initialToken);
  verify(nameUpdated.status === 200 && nameUpdated.body.user_id === owner.id && nameUpdated.body.username === ownerUsername && nameUpdated.body.real_name === unverifiedName,
    "unverified_name_update_failed");
  verify(nameUpdated.body.role === "owner" && nameUpdated.body.active === true && nameUpdated.body.approval_status === "approved" &&
    nameUpdated.body.profile_enrollment_pending === true && nameUpdated.body.identity_enrolled === false &&
    nameUpdated.body.approved_real_name === null && nameUpdated.body.name_verified_at === null && nameUpdated.body.name_verified_by === null &&
    nameUpdated.body.name_edit_mode === "unverified_edit" && nameUpdated.body.can_edit_real_name === true,
    "unverified_name_update_changed_approval_or_profile_state");
  verify(await sql(protectedIdentityQuery) === protectedIdentityBefore, "unverified_name_update_changed_other_data");
  // RPC의 허용 인자를 넘어 본인 확인 값이나 작업자를 넣어도 실제 변경이나 성공 이력이 생기면 안 됩니다.
  const selfVerified = await rpc("office_update_unverified_name", { p_real_name: "CI forbidden verified name", p_reason: nameReason,
    p_name_verified_by: owner.id, p_name_verified_at: new Date().toISOString(), actor_id: forgedActorId }, initialToken);
  verify(selfVerified.status >= 400, "unverified_name_rpc_accepted_forged_verification");
  const nameAfterForgery = await rpc("office_account_state", {}, initialToken);
  verify(nameAfterForgery.status === 200 && nameAfterForgery.body.real_name === unverifiedName && nameAfterForgery.body.name_verified_at === null &&
    nameAfterForgery.body.name_verified_by === null && nameAfterForgery.body.approved_real_name === null && nameAfterForgery.body.profile_enrollment_pending === true,
    "forged_name_request_changed_identity");
  verify(await sql(protectedIdentityQuery) === protectedIdentityBefore, "forged_name_request_changed_other_data");
  const nameAuditText = await sql(`select coalesce(jsonb_agg(jsonb_build_object('actor_id',actor_id,'actor_role',actor_role,'actor_name',actor_name,
    'actor_name_status',actor_name_status,'requested_by',requested_by,'entity',entity,'record_id',record_id,'action',action,'changed_fields',changed_fields,
    'before_values',before_values,'after_values',after_values,'reason',reason,'source',source,'executor',executor)),'[]'::jsonb)::text
    from public.audit_logs where entity='staff_accounts' and record_id=${sqlLiteral(owner.id)} and action='unverified_name_updated';`);
  const nameAudit = JSON.parse(nameAuditText);
  verify(nameAudit.length === 1 && nameAudit[0].actor_id === owner.id && nameAudit[0].requested_by === owner.id && nameAudit[0].actor_role === "owner" &&
    nameAudit[0].actor_name === null && nameAudit[0].actor_name_status === "unverified" && nameAudit[0].source === "human" && nameAudit[0].executor === "authenticated_user" &&
    nameAudit[0].reason === nameReason && JSON.stringify(nameAudit[0].changed_fields) === '["real_name"]' &&
    JSON.stringify(nameAudit[0].before_values) === "{}" && JSON.stringify(nameAudit[0].after_values) === "{}",
    "unverified_name_audit_actor_or_fields_incorrect");
  verify(![forgedActorId, "CI forged actor", ownerEmail, unverifiedName, initialPassword, initialToken].some(value => nameAuditText.includes(value)),
    "unverified_name_audit_exposed_unapproved_or_secret_values");
  report("unverified legacy Owner name changes preserve UUID, role and incomplete profile; self-verification is rejected and audit uses the server actor");

  stage = "verify existing private fixture permissions";
  const privatePlayer = randomUUID();
  await sql(`insert into public.players(id,internal_name) values(${sqlLiteral(privatePlayer)}::uuid,'CI private fixture only');`);
  const ownerPlayers = await localFetch(`${api}/rest/v1/players?select=id`, { headers: { apikey: publicKey, Authorization: `Bearer ${initialToken}` } });
  verify(ownerPlayers.ok && (await ownerPlayers.json()).some(row => row.id === privatePlayer), "owner_fixture_not_visible");
  report("existing UUID and Owner role survive ID login");

  stage = "native mail recovery, PKCE and password save";
  const recoveryModule = await build({ entryPoints: [path.join(repository, "src/lib/staff-auth-recovery.ts")], bundle: true, write: false, platform: "node", format: "esm" });
  const { createStaffRecoveryFetch } = await import("data:text/javascript;base64," + Buffer.from(recoveryModule.outputFiles[0].text).toString("base64"));
  const memory = new Map();
  const recoveryClient = client(api, publicKey, {
    auth: { storageKey: "native-recovery-only", storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
    global: { fetch: createStaffRecoveryFetch(api, publicKey, localFetch) },
  });
  data(await recoveryClient.auth.resetPasswordForEmail(ownerEmail), "native_recovery_request_failed");
  verify([...memory.keys()].some(name => name.endsWith("-code-verifier")), "native_pkce_verifier_missing");
  let mailHtml;
  await waitFor(async () => {
    const response = await localFetch(`${mailbox}/view/latest.html?query=${encodeURIComponent("to:" + ownerEmail)}`);
    if (!response.ok) return false;
    mailHtml = await response.text();
    return Boolean(mailHtml);
  }, "recovery_mail_missing");
  const mail = new JSDOM(mailHtml);
  const verifyLinks = [...mail.window.document.querySelectorAll("a[href]")].map(link => link.href).filter(address => {
    try { const target = localAddress(address); return target.origin === api && target.pathname === "/auth/v1/verify"; } catch { return false; }
  });
  mail.window.close();
  verify(verifyLinks.length === 1, "native_recovery_link_missing");
  const verification = await localFetch(verifyLinks[0]);
  verify([302, 303].includes(verification.status), "native_recovery_verify_failed");
  const callback = localAddress(verification.headers.get("location"));
  verify(callback.origin === APP_ORIGIN && callback.pathname === "/admin/help/" && callback.searchParams.has("code"), "native_recovery_callback_mismatch");
  const recoverySession = data(await recoveryClient.auth.exchangeCodeForSession(callback.searchParams.get("code")), "native_pkce_exchange_failed").session;
  verify(recoverySession?.user.id === owner.id, "native_recovery_uuid_mismatch");
  const saved = await gateway({ action: "set_password", password: recoveredPassword, password_confirmation: recoveredPassword }, recoverySession.access_token);
  verify(saved.status === 200 && saved.body.success === true, "native_recovery_password_save_failed");
  const oldPassword = await client(api, publicKey).auth.signInWithPassword({ email: ownerEmail, password: initialPassword });
  verify(Boolean(oldPassword.error), "old_password_still_accepted");
  const recoveredOwner = await idLogin(ownerUsername, recoveredPassword);
  verify(data(await recoveredOwner.auth.getUser(), "recovered_owner_user_failed").user.id === owner.id, "recovered_owner_uuid_changed");
  const reused = await localFetch(verifyLinks[0]);
  const reuseTarget = new URL(reused.headers.get("location") ?? APP_ORIGIN);
  verify(!reuseTarget.searchParams.has("code"), "recovery_link_reuse_succeeded");
  report("real Mailpit mail, same-browser PKCE and new password login succeed; old password and reused link fail");

  stage = "pending account native Auth and RLS";
  // 새 가입은 연락 주소를 입력받지 않습니다. 실제 Auth가 서버 식별자로 계정을 만들고
  // 메일을 발송하지 않은 채 아이디 로그인·승인 대기 제한을 적용하는지 함께 확인합니다.
  const mailCountBeforeSignup = await mailboxCount();
  const pendingPassword = randomBytes(24).toString("base64url");
  const registered = await gateway({ action: "register", username: "native.pending", password: pendingPassword, password_confirmation: pendingPassword,
    real_name: "隔離テスト 담당", department: "CI only", notice_accepted: true });
  verify(registered.status === 200 && registered.body.code === "registration_received", "pending_registration_failed");
  verify(!JSON.stringify(registered.body).includes("@"), "registration_exposed_technical_address");
  const pending = await idLogin("native.pending", pendingPassword);
  const pendingSession = data(await pending.auth.getSession(), "pending_session_missing").session;
  const pendingToken = pendingSession?.access_token;
  const pendingAuth = data(await service.auth.admin.getUserById(uuid(pendingSession?.user.id)), "pending_native_user_missing").user;
  verify(/^staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@accounts\.kansai\.invalid$/.test(pendingAuth.email), "pending_auth_identifier_not_server_generated");
  verify(await mailboxCount() === mailCountBeforeSignup, "signup_sent_unrequested_email");
  const pendingState = await rpc("office_account_state", {}, pendingToken);
  verify(pendingState.status === 200 && pendingState.body.approval_status === "pending" && pendingState.body.role === null && pendingState.body.active === false &&
    pendingState.body.email_confirmation_required === false && pendingState.body.email_confirmed === false, "pending_received_internal_role");
  const recoveredOwnerToken = data(await recoveredOwner.auth.getSession(), "recovered_owner_session_missing").session?.access_token;
  const technicalContact = await rpc("office_staff_application_contact", { p_user_id: pendingAuth.id }, recoveredOwnerToken);
  verify(technicalContact.status === 200 && technicalContact.body.email === null && technicalContact.body.contact_available === false,
    "technical_identifier_exposed_as_contact");
  const listing = await rpc("office_staff_directory", {}, pendingToken);
  verify(listing.status >= 400, "pending_accessed_staff_directory");
  const internal = await localFetch(`${api}/rest/v1/players?select=id`, { headers: { apikey: publicKey, Authorization: `Bearer ${pendingToken}` } });
  const playerRows = await internal.json();
  verify(internal.ok && Array.isArray(playerRows) && playerRows.length === 0, "pending_read_internal_players");
  report("email-free signup sends no mail; server Auth identifier stays out of contacts and pending user cannot access internal data");

  stage = "mail-free support request, project administrator approval and one-time completion";
  const requestId = randomUUID();
  const deviceSecret = randomBytes(32).toString("hex");
  const requested = await gateway({ action: "support_recovery_request", username: ownerUsername, request_id: requestId, device_secret: deviceSecret });
  verify(requested.status === 200 && requested.body.request_id === requestId && /^[a-f0-9]{16}$/.test(requested.body.device_fingerprint), "support_request_failed");
  const unapproved = await gateway({ action: "support_recovery_complete", request_id: requestId, device_secret: deviceSecret, password: supportedPassword, password_confirmation: supportedPassword });
  verify(unapproved.status >= 400, "unapproved_support_reset_succeeded");
  const proofForgery = await gateway({ action: "support_recovery_status", request_id: requestId, device_secret: randomBytes(32).toString("hex") });
  verify(proofForgery.status >= 400 || proofForgery.body.state === "unavailable", "forged_device_proof_accepted");
  const beforeSupport = await idLogin(ownerUsername, recoveredPassword);
  const beforeSupportSession = data(await beforeSupport.auth.getSession(), "before_support_session_missing").session;
  // postgres 승인 권한은 Docker 안의 이 일회용 DB에만 사용합니다. 서비스/익명 RPC로 승인하지 않습니다.
  await sql(`select private.approve_staff_support_recovery(${sqlLiteral(uuid(requestId))}::uuid,${sqlLiteral(owner.id)}::uuid,${sqlLiteral(requested.body.device_fingerprint)},'credential_recovery');`);
  const approved = await gateway({ action: "support_recovery_status", request_id: requestId, device_secret: deviceSecret });
  verify(approved.status === 200 && approved.body.state === "approved", "support_approval_not_visible");
  const completed = await gateway({ action: "support_recovery_complete", request_id: requestId, device_secret: deviceSecret, password: supportedPassword, password_confirmation: supportedPassword });
  verify(completed.status === 200 && completed.body.code === "support_password_updated", "support_password_save_failed");
  const supportOwner = await idLogin(ownerUsername, supportedPassword);
  verify(data(await supportOwner.auth.getUser(), "support_owner_user_failed").user.id === owner.id, "support_owner_uuid_changed");
  const currentToken = data(await supportOwner.auth.getSession(), "support_owner_session_missing").session.access_token;
  const sameRole = await rpc("office_account_state", {}, currentToken);
  verify(sameRole.status === 200 && sameRole.body.role === "owner" && sameRole.body.real_name === unverifiedName &&
    sameRole.body.name_verified_at === null && sameRole.body.approved_real_name === null && sameRole.body.profile_enrollment_pending === true,
    "support_reset_changed_owner_identity");
  const stale = await rpc("office_account_state", {}, beforeSupportSession.access_token);
  verify(stale.status >= 400, "revoked_access_session_retained_staff_access");
  const refreshed = await client(api, publicKey).auth.refreshSession({ refresh_token: beforeSupportSession.refresh_token });
  verify(Boolean(refreshed.error), "revoked_refresh_token_accepted");
  const replay = await gateway({ action: "support_recovery_complete", request_id: requestId, device_secret: deviceSecret, password: replayPassword, password_confirmation: replayPassword });
  verify(replay.status === 200 && replay.body.code === "support_password_already_updated", "support_replay_did_not_report_already_updated");
  const replayLogin = await client(api, publicKey).auth.signInWithPassword({ email: ownerEmail, password: replayPassword });
  verify(Boolean(replayLogin.error), "support_replay_changed_password");
  verify((await gateway({ action: "login", username: ownerUsername, password: supportedPassword })).status === 200, "completed_support_password_no_longer_valid");
  const auditText = await sql("select coalesce(jsonb_agg(jsonb_build_object('actor_id',actor_id,'requested_by',requested_by,'action',action,'executor',executor,'before_values',before_values,'after_values',after_values,'reason',reason)),'[]'::jsonb)::text from public.audit_logs where source='project_admin_recovery';");
  const supportAudit = JSON.parse(auditText);
  verify(supportAudit.length === 4 && supportAudit.every(row => row.actor_id === null && row.requested_by === null), "support_audit_invented_human_actor");
  verify(["requested", "approved", "executing", "succeeded"].every(state => supportAudit.some(row => row.action === "project_admin_recovery_" + state)), "support_audit_state_missing");
  verify(![initialPassword, recoveredPassword, supportedPassword, replayPassword, deviceSecret, beforeSupportSession.access_token, beforeSupportSession.refresh_token].some(secret => auditText.includes(secret)), "support_audit_contains_secret");
  report("approved support changes the same UUID once, preserves Owner, revokes old sessions and rejects proof/replay attacks");

  stage = "native email resend failure is surfaced honestly";
  // 기존 실제 이메일 계정의 복구 호환성은 보존합니다. 새 무메일 가입과 분리한 일회용
  // 주소에서만 제공자 재발송 오류를 검사하며, 기술 식별자에는 복구 메일을 요청하지 않습니다.
  const legacyMailAddress = `legacy-mail-${randomBytes(5).toString("hex")}@example.test`;
  data(await service.auth.admin.createUser({ email: legacyMailAddress, password: randomBytes(24).toString("base64url"), email_confirm: true }), "legacy_mail_fixture_creation_failed");
  const recoveryInput = () => ({ action: "recovery", email: legacyMailAddress,
    code_challenge: createHash("sha256").update(randomBytes(32).toString("hex")).digest("base64url"), code_challenge_method: "s256" });
  // 이 호환성 주소에는 아직 복구 메일을 요청하지 않았습니다. 첫 요청 직후 다시 요청해
  // native max_frequency 60초 제한을 확인합니다. 게이트웨이 3회/시간 한도는 넘지 않습니다.
  const firstPendingMail = await gateway(recoveryInput());
  verify(firstPendingMail.status === 200 && firstPendingMail.body.code === "recovery_received", "first_pending_native_mail_not_accepted");
  const quotaFailure = await gateway(recoveryInput());
  verify(quotaFailure.status === 429 && quotaFailure.body.error === "rate_limited" && !quotaFailure.body.success, "native_email_failure_reported_as_success");
  report("real native email resend limit returns 429 and no false send-success receipt");
  report("all real Auth integration checks passed");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  // 라이브러리 예외/응답 원문을 붙이지 않습니다. 고정된 단계·코드만 CI 진단에 남깁니다.
  process.stderr.write(`Native Auth integration failed at ${stage}: ${error instanceof NativeAuthFailure ? error.code : "unexpected_error"}.\n`);
} finally {
  for (const current of clients) await current.auth.stopAutoRefresh().catch(() => {});
  functionProcess?.kill("SIGTERM");
  if (started && projectId?.startsWith(PROJECT_PREFIX) && temporary) {
    try { await cli(["stop", "--project-id", projectId, "--no-backup"], { timeout: 120000 }); }
    catch { failed = true; process.stderr.write("Native Auth cleanup failed for the disposable stack.\n"); }
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
