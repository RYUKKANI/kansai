import type { GatewayConfig } from "./gateway.ts";
// [편집 안내] 운영 주소는 서버 환경에서만 읽습니다. 이전 GitHub Pages 경로나 프로젝트 ID를 기본값으로 복사하지 않습니다.
export type Environment = (name: string) => string | undefined;
export function serverKey(env: Environment, collection: string, legacy: string): string {
  const raw = env(collection);
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      const values = Object.values(keys);
      const selected = keys.default ?? (values.length === 1 ? values[0] : undefined);
      if (typeof selected === "string" && selected) return selected;
    } catch { /* 여러 키 중 임의의 키를 선택하지 않고 명시한 기본키만 사용합니다. */ }
    throw new Error("Server credentials unavailable");
  }
  const value = env(legacy);
  if (!value) throw new Error("Server credentials unavailable");
  return value;
}
export function readGatewayConfig(env: Environment, secretKey: string): GatewayConfig {
  let allowedOrigins: string[] = [];
  try {
    const values = JSON.parse(env("STAFF_AUTH_ALLOWED_ORIGINS") ?? "[]");
    if (Array.isArray(values) && values.length <= 10 && values.every(value => {
      if (typeof value !== "string") return false;
      const url = new URL(value);
      return value === url.origin && (url.protocol === "https:" ||
        url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    })) allowedOrigins = [...new Set(values)];
  } catch { /* 잘못된 CORS 설정은 모두 차단합니다. */ }
  return {
    enabled: env("STAFF_AUTH_ENABLED") === "true",
    registrationEnabled: env("STAFF_AUTH_REGISTRATION_ENABLED") === "true",
    registrationCaptchaMode: ["disabled", "hcaptcha", "turnstile"].includes(env("STAFF_AUTH_REGISTRATION_CAPTCHA_MODE") ?? "")
      ? env("STAFF_AUTH_REGISTRATION_CAPTCHA_MODE") as GatewayConfig["registrationCaptchaMode"] : "unconfigured",
    legacyEmailEnabled: env("STAFF_AUTH_LEGACY_EMAIL_ENABLED") === "true",
    allowedOrigins,
    emailRedirectTo: env("STAFF_AUTH_LOGIN_REDIRECT_URL") ?? "",
    recoveryRedirectTo: env("STAFF_AUTH_RECOVERY_REDIRECT_URL") ?? "",
    hmacSecret: env("STAFF_AUTH_RATE_HMAC_SECRET") ?? "",
    ipMode: env("STAFF_AUTH_IP_MODE") === "attested-header" ? "attested-header" : "disabled",
    ipHeader: (env("STAFF_AUTH_TRUSTED_IP_HEADER") ?? "").toLowerCase(),
    ipHeaderAttested: env("STAFF_AUTH_IP_SOURCE_ATTESTED") === "overwrites-client-input",
    forwardAuthIp: env("STAFF_AUTH_FORWARD_AUTH_IP") === "true",
    forwardedForOptIn: env("STAFF_AUTH_SB_FORWARDED_FOR_ENABLED") === "true",
    authSecretKey: secretKey,
  };
}
