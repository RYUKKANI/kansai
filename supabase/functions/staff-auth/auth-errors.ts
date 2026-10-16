// [편집 안내] Auth 오류는 허용한 코드와 HTTP 상태만 전달합니다. 제공자 원문에는
// 이메일·토큰 등이 포함될 수 있으므로 응답·감사 기록·로그로 복사하지 않습니다.
export type SafeAuthError = { code: string; status: number };

export function recoveryError(error: any): SafeAuthError | null {
  if (!error) return null;
  if (["email_not_found", "user_not_found"].includes(error.code)) return null;
  return error.status === 429 || ["rate_limited", "over_email_send_rate_limit", "over_request_rate_limit"].includes(error.code)
    ? { code: "rate_limited", status: 429 }
    : { code: "service_unavailable", status: 503 };
}

export function passwordError(error: any): SafeAuthError {
  const code = error?.code;
  if (error?.status === 429 || ["rate_limited", "over_request_rate_limit"].includes(code))
    return { code: "rate_limited", status: 429 };
  if (["same_password", "weak_password"].includes(code)) return { code, status: 422 };
  if (["insufficient_aal", "mfa_required"].includes(code)) return { code: "mfa_required", status: 409 };
  if (["reauthentication_needed", "reauthentication_not_valid", "reauthentication_required"].includes(code))
    return { code: "reauthentication_required", status: 409 };
  if (["current_password_required", "current_password_mismatch"].includes(code)) return { code, status: 400 };
  if (error?.status === 401 || ["bad_jwt", "session_not_found", "session_expired", "jwt_expired", "not_authenticated", "user_not_found", "user_banned", "authentication_required"].includes(code))
    return { code: "authentication_required", status: 401 };
  // PUT이 전송된 뒤 연결이 끊기거나 5xx가 돌아오면 저장 여부를 단정할 수 없습니다.
  // 재시도 버튼을 자동 활성화하지 않도록 일반 입력 오류와 구분합니다.
  if (error?.status === 408 || error?.status >= 500 || code === "password_update_uncertain") return { code: "password_update_uncertain", status: 503 };
  return { code: "password_update_failed", status: 400 };
}

export async function nativeErrorCode(response: Response): Promise<string | undefined> {
  try {
    // 오류 원문을 보관하지 않습니다. 오류 본문 크기가 비정상이면 읽지 않습니다.
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) return undefined;
    const value = await response.json();
    const code = typeof value?.code === "string" ? value.code : value?.error_code;
    return typeof code === "string" ? code : undefined;
  } catch { return undefined; }
}
