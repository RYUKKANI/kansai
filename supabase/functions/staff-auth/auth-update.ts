import type { Result } from "./gateway.ts";
import { nativeErrorCode, passwordError } from "./auth-errors.ts";

// [편집 안내] SDK 2.117.3의 updateUser는 클라이언트 내부 refresh session을 요구합니다.
// 서버는 브라우저 refresh token을 수집하지 않으므로 Auth 공식 REST API에 검증된 bearer를 전달합니다.
// 이 경로도 해싱·현재 비밀번호 검사·복구 정책을 전부 Supabase Auth에 맡깁니다.
export async function updateAuthUser(
  url: string,
  apiKey: string,
  token: string,
  attributes: Record<string, unknown>,
  forwardedIp: string | null = null,
  request: typeof fetch = fetch,
): Promise<Result> {
  const headers: Record<string, string> = {
    apikey: apiKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (forwardedIp) headers["Sb-Forwarded-For"] = forwardedIp;
  try {
    const response = await request(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      method: "PUT", headers, body: JSON.stringify(attributes), cache: "no-store",
    });
    if (!response.ok) return { data: null, error: passwordError({ code: await nativeErrorCode(response), status: response.status }) };
    const value = await response.json();
    const user = value?.user ?? value;
    return user?.id ? { data: { user }, error: null } : { data: null, error: { code: "password_update_uncertain", status: 503 } };
  } catch { return { data: null, error: { code: "password_update_uncertain", status: 503 } }; }
}
