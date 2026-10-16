import type { Result } from "./gateway.ts";
import { nativeErrorCode, recoveryError } from "./auth-errors.ts";

// [편집 안내] PKCE 검증기는 브라우저의 Supabase SDK에 남겨 두고 challenge만 Auth에 전달합니다.
// 서버 SDK가 새 검증기를 만들면 브라우저가 복구 코드를 교환할 수 없으므로 공식 /recover API를 사용합니다.
export async function recoverAuthEmail(
  url: string,
  apiKey: string,
  email: string,
  options: Record<string, unknown>,
  forwardedIp: string | null = null,
  request: typeof fetch = fetch,
): Promise<Result> {
  const headers: Record<string, string> = { apikey: apiKey, "Content-Type": "application/json" };
  if (forwardedIp) headers["Sb-Forwarded-For"] = forwardedIp;
  const endpoint = new URL(`${url.replace(/\/$/, "")}/auth/v1/recover`);
  endpoint.searchParams.set("redirect_to", String(options.redirectTo));
  try {
    const response = await request(endpoint.toString(), {
      method: "POST", headers, cache: "no-store", body: JSON.stringify({
        email, code_challenge: options.codeChallenge, code_challenge_method: options.codeChallengeMethod,
        gotrue_meta_security: { captcha_token: options.captchaToken },
      }),
    });
    if (response.ok) return { data: {}, error: null };
    const error = recoveryError({ code: await nativeErrorCode(response), status: response.status });
    return error ? { data: null, error } : { data: {}, error: null };
  } catch { return { data: null, error: { code: "service_unavailable", status: 503 } }; }
}
