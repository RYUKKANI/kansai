// [편집 안내] PKCE verifier는 공식 SDK가 이 브라우저에 보관합니다. 복구 메일 요청만
// 제한 게이트웨이로 보내며, 비밀번호 해싱/인증 코드 교환은 Supabase Auth가 담당합니다.
// 서버는 복귀 주소를 고정합니다. 브라우저가 임의의 redirect_to를 전달하지 않습니다.
export function createStaffRecoveryFetch(
  supabaseUrl: string,
  publishableKey: string,
  upstream: typeof fetch = fetch,
): typeof fetch {
  const origin = new URL(supabaseUrl).origin;
  const recoveryUrl = new URL("/auth/v1/recover", origin).href;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.origin + url.pathname !== recoveryUrl)
      return upstream(input, init);
    try {
      const body = await request.json();
      const gatewayBody: Record<string, unknown> = {
        action: "recovery",
        email: body.email,
        code_challenge: body.code_challenge,
        code_challenge_method: body.code_challenge_method,
      };
      // SDK 2.117.3은 요청마다 별도 verifier 슬롯을 만듭니다. 주소 전체는
      // 전달하지 않고 슬롯 선택용 opaque ID만 보존해 실패한 재전송이 앞선 링크를 깨지 않게 합니다.
      const redirect = url.searchParams.get("redirect_to");
      if (redirect) {
        const values = new URL(redirect).searchParams.getAll("sb_flow_id");
        if (values.length > 1 || values.length === 1 && !/^[A-Za-z0-9_-]{8,64}$/.test(values[0] ?? "")) throw new Error("Invalid flow ID");
        if (values.length === 1) gatewayBody.flow_id = values[0];
      }
      if (typeof body.gotrue_meta_security?.captcha_token === "string")
        gatewayBody.captcha_token = body.gotrue_meta_security.captcha_token;
      const response = await upstream(origin + "/functions/v1/staff-auth", {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(gatewayBody),
        cache: "no-store",
      });
      const value = await response.json().catch(() => ({}));
      // 익명 접수는 이메일 소유나 배송 완료를 증명하지 않습니다. 게이트웨이가 실제
      // 접수를 확인한 경우만 SDK 성공으로 바꾸며, 빈 200 응답은 전송 성공으로 취급하지 않습니다.
      if (response.ok && value?.success === true && value?.code === "recovery_received")
        return Response.json({}, { headers: { "Cache-Control": "no-store" } });
      // SDK가 읽는 제한된 코드만 재구성합니다. Auth/DB의 원문 오류를 표시하지 않습니다.
      const code = ["rate_limited", "invalid_request", "feature_unavailable"].includes(value?.error)
        ? value.error : "service_unavailable";
      return Response.json({ code, msg: "Recovery request could not be completed" }, {
        status: response.ok ? 503 : response.status, headers: { "Cache-Control": "no-store", "x-supabase-api-version": "2024-01-01" },
      });
    } catch {
      return Response.json({ code: "service_unavailable", msg: "Recovery request could not be completed" }, {
        status: 503, headers: { "Cache-Control": "no-store", "x-supabase-api-version": "2024-01-01" },
      });
    }
  };
}
