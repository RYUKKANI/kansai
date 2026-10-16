// [편집 안내] HTTP 입력 검증과 인증 흐름은 런타임과 분리해 같은 코드를 적대적 요청 검사에 사용합니다.
// 비밀번호는 이 요청에서 Supabase Auth로만 전달하며 DB RPC, 오류 응답, 로그에는 넣지 않습니다.
import { resetOwnerManagedPassword } from "./owner-password-reset.ts";
import { supportRecoveryRequest, supportRecoveryStatus, completeSupportRecovery } from "./support-recovery.ts";
import { passwordError, recoveryError } from "./auth-errors.ts";
export type Result = { data: any; error: any };
export type Client = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<Result>;
  auth: {
    getUser(token: string): Promise<Result>;
    getClaims(token: string): Promise<Result>;
    signInWithPassword(input: Record<string, unknown>): Promise<Result>;
    admin: {
      createUser(input: Record<string, unknown>): Promise<Result>;
      updateUserById(userId: string, input: Record<string, unknown>): Promise<Result>;
    };
    resetPasswordForEmail(email: string, options: Record<string, unknown>): Promise<Result>;
    signInWithOtp(input: Record<string, unknown>): Promise<Result>;
    signOut(input: Record<string, unknown>): Promise<Result>;
    updateUser(input: Record<string, unknown>): Promise<Result>;
  };
};
export type GatewayConfig = {
  enabled: boolean;
  registrationEnabled: boolean;
  registrationCaptchaMode: "unconfigured" | "disabled" | "hcaptcha" | "turnstile";
  legacyEmailEnabled: boolean;
  allowedOrigins: string[];
  emailRedirectTo: string;
  recoveryRedirectTo: string;
  hmacSecret: string;
  ipMode: "attested-header" | "disabled";
  ipHeader: string;
  ipHeaderAttested: boolean;
  forwardAuthIp: boolean;
  forwardedForOptIn: boolean;
  authSecretKey: string;
};
export type GatewayDependencies = {
  service: Client;
  authClient(ip: string | null): Client;
  userClient(token: string, ip: string | null): Client;
  verifyRegistrationCaptcha(input: { token: string; ip: string | null }): Promise<"passed" | "failed" | "unavailable">;
  config: GatewayConfig;
  now?: () => number;
};

const encoder = new TextEncoder();
const MAX_BODY = 8192;
const ACTIONS = ["login", "register", "recovery", "enroll", "set_password", "legacy_login", "owner_reset_password",
  "support_recovery_request", "support_recovery_status", "support_recovery_complete"] as const;
type Action = typeof ACTIONS[number];
const fields: Record<Action, string[]> = {
  login: ["action", "username", "password", "captcha_token"],
  register: ["action", "username", "password", "password_confirmation", "real_name", "department", "email", "notice_accepted", "captcha_token"],
  recovery: ["action", "email", "captcha_token", "code_challenge", "code_challenge_method", "flow_id"],
  enroll: ["action", "username", "real_name", "department", "notice_accepted"],
  set_password: ["action", "password", "password_confirmation", "current_password"],
  legacy_login: ["action", "email", "captcha_token"],
  owner_reset_password: ["action", "user_id", "password", "password_confirmation", "reason", "operation_id"],
  support_recovery_request: ["action", "username", "request_id", "device_secret"],
  support_recovery_status: ["action", "request_id", "device_secret"],
  support_recovery_complete: ["action", "request_id", "device_secret", "password", "password_confirmation"],
};
class GatewayError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
const fail = (code: string, status = 400): never => { throw new GatewayError(code, status); };
export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return fail("invalid_request");
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized) ? normalized : fail("invalid_request");
}
function email(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_request");
  const result = value.trim().toLowerCase();
  return result.length <= 254 && /^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+\.[^@\s\x00-\x1f\x7f]+$/.test(result)
    ? result : fail("invalid_request");
}
function displayText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_request");
  const text = value.normalize("NFC").trim();
  // 실명은 임의의 문자권·공백·하이픈을 허용합니다. 문자권에 필요한 결합·연결 문자까지 일괄 거부하지 않습니다.
  return text.length > 0 && text.length <= maximum && !/[\p{Cc}]/u.test(text)
    ? text : fail("invalid_request");
}
function password(value: unknown, newPassword = false): string {
  return typeof value === "string" && value.length >= (newPassword ? 12 : 1) && value.length <= 128
    ? value : fail("invalid_request");
}
function captcha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    ? value : fail("invalid_request");
}
function newPassword(body: Record<string, unknown>): string {
  const result = password(body.password, true);
  if (result !== body.password_confirmation) return fail("invalid_request");
  // 새 비밀번호만 Auth의 UTF-8 72바이트 제한에 맞춥니다. 기존 로그인 비밀번호를 임의로 정규화·변경하지 않습니다.
  if (encoder.encode(result).byteLength > 72) return fail("invalid_request");
  return result;
}
export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export function normalizeIp(value: string): string | null {
  if (!value || value.length > 45 || /[\s,\[\]%;]/.test(value)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split(".");
    if (octets.some(part => Number(part) > 255 || String(Number(part)) !== part)) return null;
    return value;
  }
  if (!/^[a-f0-9:]+$/i.test(value) || !value.includes(":")) return null;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase(); }
  catch { return null; }
}
export function trustedClientIp(request: Request, config: GatewayConfig): string | null {
  if (config.ipMode === "attested-header") {
    // 배포자가 앞단에서 이 단일 IP 헤더의 덮어쓰기를 실제 확인해야만 설정합니다. XFF 체인은 받지 않습니다.
    if (!config.ipHeaderAttested || !["cf-connecting-ip", "x-real-ip"].includes(config.ipHeader)) return fail("service_unavailable", 503);
    const ip = normalizeIp(request.headers.get(config.ipHeader) ?? "");
    return ip ?? fail("service_unavailable", 503);
  }
  // 확인되지 않은 IP는 사용하지 않습니다. 공통·식별자 제한은 IP 유무와 관계없이 항상 DB에서 적용합니다.
  return null;
}
async function limitedBody(request: Request): Promise<string> {
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) return fail("invalid_request", 413);
  const reader = request.body?.getReader();
  if (!reader) return fail("invalid_request");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BODY) { await reader.cancel(); return fail("invalid_request", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("invalid_request"); }
}
function validRedirect(value: string, origins: string[]): boolean {
  try {
    const url = new URL(value);
    return origins.includes(url.origin) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
async function rateLimit(deps: GatewayDependencies, action: Action, ip: string | null, identifiers: string[]): Promise<void> {
  const parameters = action === "login" ? { ip: 20, id: 8, window: 900 }
    : action === "register" ? { ip: 5, id: 3, window: 3600 }
    : action === "support_recovery_status" ? { ip: 60, id: 20, window: 60 }
    : action === "support_recovery_request" || action === "support_recovery_complete" ? { ip: 6, id: 3, window: 3600 }
    : action === "recovery" || action === "legacy_login" ? { ip: 6, id: 3, window: 3600 }
    : { ip: 12, id: 6, window: 3600 };
  const rules = [
    ...(ip ? [{ bucket: `${action}:ip`, input: ip, limit: parameters.ip, window: parameters.window }] : []),
    ...identifiers.map(input => ({ bucket: `${action}:identifier`, input, limit: parameters.id, window: parameters.window })),
  ];
  for (const rule of rules) {
    const digest = await hmacHex(deps.config.hmacSecret, `${rule.bucket}\0${rule.input}`);
    const result = await deps.service.rpc("staff_auth_rate_limit", { p_key_hash: digest, p_bucket: rule.bucket, p_limit: rule.limit, p_window_seconds: rule.window });
    if (result.error || typeof result.data !== "boolean") return fail("service_unavailable", 503);
    if (!result.data) return fail("rate_limited", 429);
  }
}
async function globalLimit(deps: GatewayDependencies): Promise<void> {
  const digest = await hmacHex(deps.config.hmacSecret, "all\0shared-gateway");
  const result = await deps.service.rpc("staff_auth_rate_limit", { p_key_hash: digest, p_bucket: "all", p_limit: 200, p_window_seconds: 60 });
  if (result.error || typeof result.data !== "boolean") return fail("service_unavailable", 503);
  if (!result.data) return fail("rate_limited", 429);
}
async function registrationCreationLimit(deps: GatewayDependencies): Promise<void> {
  // 서비스 Auth 생성은 원래 signup/IP 제한을 거치지 않습니다. CAPTCHA를 통과한 생성 시도를 별도로 제한합니다.
  // 잘못된 CAPTCHA만으로 구단 전체의 생성 한도를 소진하지 않도록 검증 이후에 호출합니다.
  const digest = await hmacHex(deps.config.hmacSecret, "register:shared\0shared-registration");
  const result = await deps.service.rpc("staff_auth_rate_limit", { p_key_hash: digest, p_bucket: "register:shared", p_limit: 10, p_window_seconds: 3600 });
  if (result.error || typeof result.data !== "boolean") return fail("service_unavailable", 503);
  if (!result.data) return fail("rate_limited", 429);
}
function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return /^Bearer [A-Za-z0-9._-]+$/.test(header) && header.length <= 8192 ? header.slice(7) : fail("authentication_required", 401);
}
function sessionOnly(session: any) {
  if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") return fail("invalid_credentials", 401);
  return { access_token: session.access_token, refresh_token: session.refresh_token,
    expires_in: session.expires_in, expires_at: session.expires_at, token_type: session.token_type };
}
const unavailableReservation = (error: any) => ["23505", "P0001", "22023"].includes(error?.code);

export function createGateway(deps: GatewayDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("Origin") ?? "";
    const allowedOrigin = deps.config.allowedOrigins.includes(origin) ? origin : "";
    const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache", "Vary": "Origin", "X-Content-Type-Options": "nosniff" };
    if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Headers"] = "authorization,apikey,content-type,x-client-info";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !allowedOrigin) return reply({ error: "origin_denied" }, 403);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (!deps.config.enabled) return reply({ error: "feature_unavailable" }, 503);
      if (!deps.config.allowedOrigins.length || deps.config.hmacSecret.length < 32 ||
        !validRedirect(deps.config.emailRedirectTo, deps.config.allowedOrigins) ||
        !validRedirect(deps.config.recoveryRedirectTo, deps.config.allowedOrigins)) return fail("service_unavailable", 503);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) return fail("invalid_request", 415);
      const rawBody = await limitedBody(request);
      const ip = trustedClientIp(request, deps.config);
      if (deps.config.forwardAuthIp && (!ip || !deps.config.forwardedForOptIn || !deps.config.authSecretKey.startsWith("sb_secret_"))) return fail("service_unavailable", 503);
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody); } catch { return fail("invalid_request"); }
      if (!body || typeof body !== "object" || Array.isArray(body) || !ACTIONS.includes(body.action as Action)) return fail("invalid_request");
      const action = body.action as Action;
      if (Object.keys(body).some(key => !fields[action].includes(key))) return fail("invalid_request");
      // 잘못된 bearer도 Auth 검증 API를 무제한 호출하지 못하도록 공통 제한을 먼저 소비합니다.
      await globalLimit(deps);
      const auth = deps.authClient(ip);
      if (action === "support_recovery_request" || action === "support_recovery_status" || action === "support_recovery_complete") {
        const requestId = uuid(body.request_id);
        if (typeof body.device_secret !== "string" || !/^[0-9a-f]{64}$/.test(body.device_secret)) return fail("invalid_request");
        // 이 값은 요청한 브라우저만 연결합니다. 신원 확인이나 승인 권한의 근거가 아닙니다.
        // 독립 목적 HMAC을 사용해 표시용 확인 번호에서 DB 검증값을 유추할 수 없게 합니다.
        const proofHash = await hmacHex(deps.config.hmacSecret, "support-recovery:proof\0" + body.device_secret);
        const fingerprint = (await hmacHex(deps.config.hmacSecret, "support-recovery:fingerprint\0" + body.device_secret)).slice(0, 16);
        const proof = { service: deps.service, requestId, proofHash };
        if (action === "support_recovery_request") {
          const username = normalizeUsername(body.username);
          await rateLimit(deps, action, ip, ["username:" + username, "proof:" + proofHash]);
          const result = await supportRecoveryRequest({ ...proof, username, fingerprint });
          return reply(result.body, result.status);
        }
        await rateLimit(deps, action, ip, [requestId]);
        const result = action === "support_recovery_status"
          ? await supportRecoveryStatus(proof)
          : await completeSupportRecovery({ ...proof, password: newPassword(body) });
        return reply(result.body, result.status);
      }
      if (action === "login") {
        const username = normalizeUsername(body.username);
        const secret = password(body.password);
        const captchaToken = captcha(body.captcha_token);
        await rateLimit(deps, action, ip, [username]);
        const identity = await deps.service.rpc("staff_auth_identity", { p_username: username });
        if (identity.error) return fail("service_unavailable", 503);
        if (!identity.data || !identity.data.user_id || !identity.data.email || ["suspended", "rejected"].includes(identity.data.approval_status)) return fail("invalid_credentials", 401);
        const result = await auth.auth.signInWithPassword({ email: identity.data.email, password: secret, options: { captchaToken } });
        if (result.error) {
          // 잘못된 자격과 Auth의 제한·통신 장애를 구분합니다. 공급자 원문이나
          // 계정 정보를 반환하지 않고, 장애 때문에 올바른 비밀번호를 재설정하게 하지 않습니다.
          const error = result.error;
          if (error.status === 429 || ["rate_limited", "over_request_rate_limit", "over_email_send_rate_limit"].includes(error.code))
            return fail("rate_limited", 429);
          if (error.status === 0 || error.status === 408 || error.status >= 500 ||
            ["AuthRetryableFetchError", "AuthUnknownError"].includes(error.name))
            return fail("service_unavailable", 503);
          return fail("invalid_credentials", 401);
        }
        if (result.data?.user?.id !== identity.data.user_id) return fail("invalid_credentials", 401);
        return reply({ session: sessionOnly(result.data.session) });
      }
      if (action === "register") {
        if (!deps.config.registrationEnabled) return fail("feature_unavailable", 503);
        const username = normalizeUsername(body.username);
        const secret = newPassword(body);
        const realName = displayText(body.real_name, 150);
        const department = displayText(body.department, 200);
        const recoveryEmail = email(body.email);
        const captchaToken = captcha(body.captcha_token);
        if (body.notice_accepted !== true) return fail("invalid_request");
        await rateLimit(deps, action, ip, [`username:${username}`, `email:${recoveryEmail}`]);
        if (deps.config.registrationCaptchaMode === "unconfigured") return fail("service_unavailable", 503);
        if (deps.config.registrationCaptchaMode !== "disabled") {
          if (!captchaToken) return fail("invalid_request");
          const verification = await deps.verifyRegistrationCaptcha({ token: captchaToken, ip });
          if (verification === "unavailable") return fail("service_unavailable", 503);
          if (verification !== "passed") return fail("invalid_request");
        }
        await registrationCreationLimit(deps);
        // 이메일 소유 확인 생략은 서버가 정한 가입 정책입니다. 브라우저가 역할·확인 여부를 지정할 수 없습니다.
        const reservation = await deps.service.rpc("staff_auth_reserve", { p_username: username, p_email: recoveryEmail, p_real_name: realName, p_department: department, p_notice_accepted: true, p_email_confirmation_required: false });
        if (reservation.error) { if (unavailableReservation(reservation.error)) return fail("registration_unavailable", 409); return fail("service_unavailable", 503); }
        if (typeof reservation.data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservation.data)) return fail("service_unavailable", 503);
        const rejectedRegistration = async (code: string, status: number): Promise<never> => {
          // 확실한 Auth 거절 뒤에는 이름 예약을 돌려주어 비밀번호를 고친 재시도가
          // 15분간 막히지 않게 합니다. 새 Auth 존재/정리 실패는 자동 재시도하지 않습니다.
          let released: Result;
          try { released = await deps.service.rpc("staff_auth_release_reservation", { p_reservation: reservation.data }); }
          catch { return fail("registration_uncertain", 503); }
          if (released.error || released.data !== true) return fail("registration_uncertain", 503);
          return fail(code, status);
        };
        // 공식 Admin API는 확인 메일과 로그인 세션을 발급하지 않습니다. 비밀번호 해싱은 계속 Auth가 담당합니다.
        // Auth의 기술적 email_confirm은 이메일 소유 확인이나 구단 승인이 아닙니다. DB는 별도 정책과 pending을 저장합니다.
        let result: Result;
        try { result = await deps.service.auth.admin.createUser({
          email: recoveryEmail, password: secret, email_confirm: true,
          // DB 확정 전 세션을 얻더라도 이전 운영진 enrollment로 정책을 우회할 수 없도록 Auth 생성과 함께 기록합니다.
          // 사용자 수정이 가능한 user_metadata나 클라이언트 인자로 이 표식을 받지 않습니다.
          app_metadata: { staff_signup_policy: "manual_approval_no_email_v1" },
        }); } catch { return fail("registration_uncertain", 503); }
        if (result.error) {
          // 가입 존재 여부의 상세 구분은 노출하지 않습니다. 다만 확정된 거절과
          // 응답을 잃어 이미 Auth가 생성되었을 수 있는 경우를 성공 영수증으로 덮지 않습니다.
          const error = result.error;
          if (error.status === 408 || error.status >= 500) return fail("registration_uncertain", 503);
          if (error.code === "weak_password") return await rejectedRegistration("weak_password", 422);
          if (error.status === 429 || ["rate_limited", "over_request_rate_limit"].includes(error.code)) return await rejectedRegistration("rate_limited", 429);
          if (["email_exists", "user_already_exists"].includes(error.code) || [400, 422].includes(error.status)) return await rejectedRegistration("registration_unavailable", 409);
          if ([401, 403].includes(error.status)) return await rejectedRegistration("service_unavailable", 503);
          return fail("registration_uncertain", 503);
        }
        const created = result.data?.user;
        if (result.data?.session || typeof created?.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(created.id) ||
          typeof created.email !== "string" || created.email.trim().toLowerCase() !== recoveryEmail) return fail("registration_uncertain", 503);
        let finalized: Result;
        try { finalized = await deps.service.rpc("staff_auth_finalize", { p_reservation: reservation.data, p_user_id: created.id }); }
        catch { return fail("registration_uncertain", 503); }
        // 이 RPC는 동일한 새 UUID·예약 이메일·서버 가입 표식을 DB에서 확인한 뒤
        // pending 계정 저장을 커밋하며, void 계약은 JSON null만 반환합니다.
        if (finalized.error || finalized.data !== null) return fail("registration_uncertain", 503);
        return reply({ success: true, code: "registration_received" });
      }
      if (action === "recovery" || action === "legacy_login") {
        if (action === "legacy_login" && !deps.config.legacyEmailEnabled) return fail("feature_unavailable", 503);
        const recoveryEmail = email(body.email);
        const captchaToken = captcha(body.captcha_token);
        if (action === "recovery" && (typeof body.code_challenge !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge) || body.code_challenge_method !== "s256")) return fail("invalid_request");
        if (action === "recovery" && body.flow_id !== undefined &&
          (typeof body.flow_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.flow_id))) return fail("invalid_request");
        await rateLimit(deps, action, ip, [recoveryEmail]);
        // SDK가 만든 비밀이 아닌 flow ID만 고정 복구 주소에 붙입니다. 임의의
        // 브라우저 redirect URL은 받지 않아 외부 사이트로 코드가 전달되지 않습니다.
        const recoveryRedirect = new URL(deps.config.recoveryRedirectTo);
        if (action === "recovery" && typeof body.flow_id === "string") recoveryRedirect.searchParams.set("sb_flow_id", body.flow_id);
        const sent = action === "recovery"
          ? await auth.auth.resetPasswordForEmail(recoveryEmail, { redirectTo: recoveryRedirect.href, captchaToken, codeChallenge: body.code_challenge, codeChallengeMethod: "s256" })
          : await auth.auth.signInWithOtp({ email: recoveryEmail, options: { shouldCreateUser: false, emailRedirectTo: deps.config.emailRedirectTo, captchaToken } });
        const sendError = recoveryError(sent.error);
        if (sendError) return fail(sendError.code, sendError.status);
        // 계정 존재 여부는 일반화하되 실제 전송 제한·장애를 접수 성공으로 표시하지 않습니다.
        return reply({ success: true, code: action === "recovery" ? "recovery_received" : "legacy_link_received" });
      }
      const token = bearer(request);
      const client = deps.userClient(token, ip);
      const verified = await client.auth.getUser(token);
      if (verified.error || !verified.data?.user?.id) return fail("authentication_required", 401);
      await rateLimit(deps, action, ip, [verified.data.user.id]);
      if (action === "owner_reset_password") {
        const target = uuid(body.user_id);
        const operation = uuid(body.operation_id);
        const secret = newPassword(body);
        const reason = displayText(body.reason, 1000);
        // 사유는 감사 기록에 남습니다. 이번 요청의 새 비밀번호가 사유로 복사된 경우에는 저장 전에 거절합니다.
        if (reason.includes(secret) || reason.includes(secret.normalize("NFC"))) return fail("invalid_request");
        const claimsResult = await client.auth.getClaims(token);
        const claims = claimsResult.data?.claims;
        const now = (deps.now ?? Date.now)() / 1000;
        const methods = claims?.amr;
        const fresh = Array.isArray(methods) && methods.some((method: any) => method !== null && typeof method === "object" &&
          ["password", "otp", "magiclink", "totp", "webauthn"].includes(method.method) && typeof method.timestamp === "number" &&
          Number.isFinite(method.timestamp) && method.timestamp <= now + 60 && now - method.timestamp <= 900);
        const factors = verified.data.user.factors;
        const invalidFactors = factors !== undefined && (!Array.isArray(factors) || factors.some((factor: any) =>
          factor === null || typeof factor !== "object" || !["verified", "unverified"].includes(factor.status)));
        const requiresMfa = Array.isArray(factors) && factors.some((factor: any) => factor !== null && typeof factor === "object" && factor.status === "verified");
        // Admin API는 본인 비밀번호 변경의 재인증/MFA를 대신 검사하지 않으므로 실행한 Owner에게 적용합니다.
        // refresh 시각이나 브라우저가 보낸 AAL/확인 표시를 새 인증으로 인정하지 않습니다.
        if (claimsResult.error || claims?.sub !== verified.data.user.id || !fresh || invalidFactors || requiresMfa && claims?.aal !== "aal2")
          return reply({ error: "reauthentication_required", operation_id: operation }, 409);
        const result = await resetOwnerManagedPassword({ client, service: deps.service, actorId: verified.data.user.id, targetId: target, operationId: operation, password: secret, reason });
        return reply(result.body, result.status);
      }
      if (action === "enroll") {
        const username = normalizeUsername(body.username);
        const realName = displayText(body.real_name, 150);
        const department = displayText(body.department, 200);
        if (body.notice_accepted !== true) return fail("invalid_request");
        const result = await client.rpc("office_enroll_identity", { p_username: username, p_real_name: realName, p_department: department, p_notice_accepted: true });
        if (result.error) return fail("enrollment_unavailable", 409);
        return reply({ success: true, account: result.data });
      }
      const secret = newPassword(body);
      const update: Record<string, unknown> = { password: secret };
      let updateClient = client;
      let cleanupReauthentication = false;
      if (body.current_password !== undefined) {
        const current = password(body.current_password);
        const address = verified.data.user.email;
        if (!address || typeof address !== "string") return fail("password_update_failed", 400);
        // Auth 설정이 current_password 필드를 선택적으로 검사하는 경우에도 현재 비밀번호를 반드시 확인합니다.
        const factors = verified.data.user.factors;
        const invalidFactors = factors !== undefined && (!Array.isArray(factors) || factors.some((factor: any) =>
          factor === null || typeof factor !== "object" || !["verified", "unverified"].includes(factor.status)));
        const requiresMfa = Array.isArray(factors) && factors.some((factor: any) => factor?.status === "verified");
        if (invalidFactors) return fail("mfa_required", 409);
        if (requiresMfa) {
          const claims = await client.auth.getClaims(token);
          if (claims.error || claims.data?.claims?.sub !== verified.data.user.id || claims.data?.claims?.aal !== "aal2") return fail("mfa_required", 409);
        }
        const reauthenticated = await auth.auth.signInWithPassword({ email: address, password: current });
        if (reauthenticated.error) {
          const error = passwordError(reauthenticated.error);
          if (reauthenticated.error.code === "invalid_credentials") return fail("current_password_mismatch", 400);
          return fail(error.code === "password_update_failed" ? "service_unavailable" : error.code, error.code === "password_update_failed" ? 503 : error.status);
        }
        const freshToken = reauthenticated.data?.session?.access_token;
        if (reauthenticated.data?.user?.id !== verified.data.user.id || typeof freshToken !== "string" || !freshToken) return fail("authentication_required", 401);
        cleanupReauthentication = true;
        // MFA가 없으면 방금 확인한 세션으로 변경하여 24시간 이상 된 원래 세션의
        // native nonce 제한에 걸리지 않게 합니다. MFA 사용자는 기존 AAL2를 유지합니다.
        if (!requiresMfa) updateClient = deps.userClient(freshToken, ip);
        update.current_password = current;
      }
      else {
        // URL type=recovery나 브라우저 이벤트가 아닌 Auth가 서명한 최신 복구/초대 인증만 인정합니다.
        const claims = await client.auth.getClaims(token);
        const now = (deps.now ?? Date.now)() / 1000;
        const methods = claims.data?.claims?.amr;
        if (claims.error || claims.data?.claims?.sub !== verified.data.user.id || !Array.isArray(methods) ||
          !methods.some((method: any) => method !== null && typeof method === "object" && ["recovery", "invite"].includes(method.method) &&
            typeof method.timestamp === "number" && Number.isFinite(method.timestamp) && method.timestamp <= now + 60 && now - method.timestamp <= 900)) return fail("password_update_failed", 400);
      }
      let updated: Result;
      try { updated = await updateClient.auth.updateUser(update); }
      catch { updated = { data: null, error: { code: "password_update_uncertain", status: 503 } }; }
      finally {
        if (cleanupReauthentication) {
          // 별도 재인증 세션의 정리 실패가 이미 확정된 비밀번호 저장을 실패로 바꾸지 않습니다.
          try { await auth.auth.signOut({ scope: "local" }); } catch { /* 비밀값·제공자 원문을 기록하지 않습니다. */ }
        }
      }
      if (updated.error) { const error = passwordError(updated.error); return fail(error.code, error.status); }
      if (updated.data?.user?.id !== verified.data.user.id) return fail("password_update_uncertain", 503);
      return reply({ success: true, code: "password_updated" });
    } catch (error) {
      if (error instanceof GatewayError) return reply({ error: error.code }, error.status);
      // 라이브러리 오류 원문에는 이메일·토큰 등이 들어갈 수 있으므로 기록하거나 그대로 전달하지 않습니다.
      return reply({ error: "service_unavailable" }, 503);
    }
  };
}

function uuid(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : fail("invalid_request");
}
