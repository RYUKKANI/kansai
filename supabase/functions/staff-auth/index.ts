import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { createGateway, type Client } from "./gateway.ts";
import { readGatewayConfig, serverKey } from "./configuration.ts";
import { updateAuthUser } from "./auth-update.ts";
import { recoverAuthEmail } from "./auth-recovery.ts";
import { createRegistrationCaptchaVerifier } from "./registration-captcha.ts";

// [편집 안내] JWT 검증을 꺼서 공개 로그인·가입을 받는 대신 각 작업에서 인증 경계를 직접 검사합니다.
// 서비스 키는 비공개 RPC, 새 Auth 생성, DB가 승인한 Owner 비밀번호 초기화에만 사용합니다. 로그인 클라이언트와 분리합니다.
const env = (name: string) => Deno.env.get(name);
const options = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
let serve: (request: Request) => Promise<Response>;
try {
  const url = env("SUPABASE_URL") ?? "";
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "kong", "host.docker.internal"].includes(parsed.hostname)) throw new Error("Invalid server URL");
  const secret = serverKey(env, "SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  const publishable = serverKey(env, "SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const config = readGatewayConfig(env, secret);
  const service = createClient(url, secret, { auth: options }) as unknown as Client;
  const userClient = (token: string | null, ip: string | null) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    // 공식 문서의 forwarding은 새 secret key + Auth의 별도 opt-in + 검증된 IP를 모두 요구합니다.
    // 기본 구성은 아무 IP도 전달하지 않아 브라우저 XFF 위조가 Auth의 제한을 바꾸지 못합니다.
    if (config.forwardAuthIp && ip) headers["Sb-Forwarded-For"] = ip;
    const apiKey = config.forwardAuthIp ? secret : publishable;
    const client = createClient(url, apiKey, { global: { headers }, auth: options });
    client.auth.resetPasswordForEmail = (email, recoveryOptions = {}) => recoverAuthEmail(url, apiKey, email, recoveryOptions, config.forwardAuthIp ? ip : null);
    if (token) {
      client.auth.updateUser = attributes => updateAuthUser(url, apiKey, token, attributes as Record<string, unknown>, config.forwardAuthIp ? ip : null);
    }
    return client as unknown as Client;
  };
  const verifyRegistrationCaptcha = createRegistrationCaptchaVerifier({
    mode: config.registrationCaptchaMode,
    secret: env("STAFF_AUTH_REGISTRATION_CAPTCHA_SECRET") ?? "",
    sitekey: env("STAFF_AUTH_REGISTRATION_CAPTCHA_SITEKEY") ?? "",
    allowedOrigins: config.allowedOrigins,
  });
  serve = createGateway({ service, config, authClient: ip => userClient(null, ip), userClient, verifyRegistrationCaptcha });
} catch {
  // 초기화 실패에도 환경값/비밀키를 출력하지 않습니다.
  serve = async () => new Response(JSON.stringify({ error: "service_unavailable" }), {
    status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
Deno.serve(serve);
