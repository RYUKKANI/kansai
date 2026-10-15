// [편집 안내] Admin createUser는 Auth의 CAPTCHA 검증을 거치지 않습니다. 가입 생성 전에 별도로 검증합니다.
// disabled는 배포자가 기존 CAPTCHA 정책을 확인한 뒤 명시해야 하며, 토큰·provider 오류 원문은 기록하지 않습니다.
export function createRegistrationCaptchaVerifier(options: {
  mode: "unconfigured" | "disabled" | "hcaptcha" | "turnstile";
  secret: string;
  sitekey: string;
  allowedOrigins: string[];
  request?: typeof fetch;
}) {
  const expectedHosts = options.allowedOrigins.map(origin => new URL(origin).hostname);
  return async ({ token, ip }: { token: string; ip: string | null }): Promise<"passed" | "failed" | "unavailable"> => {
    if (!["hcaptcha", "turnstile"].includes(options.mode) || !options.secret || !options.sitekey || !expectedHosts.length) return "unavailable";
    if (!token || token.length > 2048) return "failed";
    const parameters = new URLSearchParams({ secret: options.secret, response: token });
    if (ip) parameters.set("remoteip", ip);
    if (options.mode === "hcaptcha") parameters.set("sitekey", options.sitekey);
    try {
      const response = await (options.request ?? fetch)(options.mode === "hcaptcha"
        ? "https://api.hcaptcha.com/siteverify" : "https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: parameters.toString(), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return "unavailable";
      const result = await response.json();
      if (result.success !== true || typeof result.hostname !== "string" || !expectedHosts.includes(result.hostname)) return "failed";
      // 다른 업무에서 발급한 Turnstile 토큰을 가입용으로 가져올 수 없도록 UI도 같은 action을 지정해야 합니다.
      if (options.mode === "turnstile" && result.action !== "staff-register") return "failed";
      return "passed";
    } catch { return "unavailable"; }
  };
}
