import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import { initLanguageSwitcher } from "./languages";
import { attachPasswordToggles, clearStaffPasswords, staffAuthError, staffAuthRequest, validNewStaffPassword } from "./staff-auth";
import { createStaffRecoveryFetch } from "../lib/staff-auth-recovery";

type RecoveryCallback = { hasCode: boolean; hasError: boolean };
type HelpOptions = { root: HTMLElement; client: SupabaseClient; callback?: RecoveryCallback };
// 콜백 값은 복사하거나 기록하지 않습니다. SDK가 주소를 정리하기 전에 오류 안내에 필요한 존재 여부만 보관합니다.
export function recoveryCallbackState(address: string): RecoveryCallback {
  const url = new URL(address);
  const fragment = new URLSearchParams(url.hash.slice(1));
  return {
    hasCode: ["code", "access_token", "refresh_token", "token_hash", "token", "id_token"].some(key => url.searchParams.has(key) || fragment.has(key)),
    hasError: ["error", "error_code", "error_description"].some(key => url.searchParams.has(key) || fragment.has(key)),
  };
}
// [편집 안내] 이 컨트롤러는 복구 전용 화면에서만 사용합니다. 쿼리의 type=recovery나
// 브라우저가 보관한 메타데이터로 비밀번호 변경을 허용하지 않습니다. 서버도 복구 AMR을 재검사합니다.
export function mountStaffAuthHelp({ root, client, callback = recoveryCallbackState(window.location.href) }: HelpOptions) {
  const notice = root.querySelector<HTMLElement>("#staff-help-message")!;
  const passwordForm = root.querySelector<HTMLFormElement>("#staff-new-password-form")!;
  const panel = root.querySelector<HTMLElement>("#staff-new-password-panel")!;
  const options = root.querySelector<HTMLElement>("#staff-help-options")!;
  let busy = false;
  let verifiedRecovery = false;
  let recoveryUserId: string | null = null;
  let recoveryToken: string | null = null;
  let verificationGeneration = 0;
  // 인증 검증 세대와 저장 작업은 별개입니다. 같은 계정의 토큰 갱신이 저장 성공을
  // 지워서는 안 되며, 다른 계정으로 전환된 뒤에는 그 계정을 로그아웃시키지 않습니다.
  let authContextVersion = 0;
  let passwordOutcome: "idle" | "saving" | "saved" | "uncertain" = "idle";
  let savingUserId: string | null = null;
  let checkingRecovery = false;
  let destroyed = false;
  const callbackPresent = callback.hasCode || callback.hasError;
  // URL에 세션 토큰이 있어도 SDK는 읽지 않습니다. 복구 중에는 초기 저장 세션 이벤트를
  // 보류하고, 이 브라우저 verifier로 코드 교환을 마친 세션만 복구 검증에 넘깁니다.
  const callbackUrl = new URL(window.location.href);
  let callbackInitializing = callbackPresent;
  const callbackFailure = () => message(t("確認リンクを読み取れませんでした。リンクを申請したブラウザーで開くか、統括に復旧をご相談ください。"), true);
  function message(value: string, error = false) {
    if (destroyed) return;
    notice.textContent = value;
    notice.dataset.error = String(error);
    notice.setAttribute("role", error ? "alert" : "status");
    if (value) notice.focus();
  }
  function syncButtons() {
    // 기기 기반 지원 복구는 별도 컨트롤러가 관리합니다. 기존 링크의 비밀번호 양식만 잠급니다.
    for (const button of panel.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  }
  async function run(form: HTMLElement, task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    form.setAttribute("aria-busy", "true");
    syncButtons();
    message("");
    try { await task(); }
    catch (error) { message(staffAuthError(error), true); }
    finally {
      busy = false;
      form.removeAttribute("aria-busy");
      if (!destroyed) syncButtons();
    }
  }
  const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
  // 이메일 발송은 제공하지 않습니다. 이미 발급된 링크의 안전한 만료·복구 처리는 유지합니다.
  attachPasswordToggles(panel);
  passwordForm.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement) event.target.removeAttribute("aria-invalid");
  });
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || checkingRecovery || !passwordForm.reportValidity()) return;
    if (passwordOutcome !== "idle") return;
    if (!verifiedRecovery) { message(staffAuthError(new Error("authentication_required")), true); return; }
    const password = input(passwordForm, "password").value;
    const confirmation = input(passwordForm, "password_confirmation").value;
    if (password !== confirmation) {
      input(passwordForm, "password_confirmation").setAttribute("aria-invalid", "true");
      message(t("パスワードが一致しません。"), true);
      input(passwordForm, "password_confirmation").focus();
      return;
    }
    // 기존 복구 AMR 검사를 유지하면서 새 비밀번호의 native Auth 바이트 상한을 확인합니다.
    if (!validNewStaffPassword(password)) {
      input(passwordForm, "password").setAttribute("aria-invalid", "true");
      message(t("パスワードは12文字以上、UTF-8で72バイト以内にしてください。"), true);
      input(passwordForm, "password").focus();
      return;
    }
    clearStaffPasswords(panel);
    passwordOutcome = "saving";
    savingUserId = recoveryUserId;
    void run(passwordForm, async () => {
      const context = authContextVersion;
      const token = recoveryToken;
      const userId = recoveryUserId;
      let dispatched = false;
      try {
        if (!token || !userId) throw new Error("authentication_required");
        const { data, error } = await client.auth.getUser(token);
        if (error || !data.user || data.user.id !== userId || context !== authContextVersion || !verifiedRecovery)
          throw new Error("authentication_required");
        dispatched = true;
        await staffAuthRequest(client, { action: "set_password", password, password_confirmation: confirmation }, token);
        // 확정된 서버 결과는 토큰 갱신·다른 탭 로그아웃으로 버리지 않습니다.
        passwordOutcome = "saved";
        invalidateRecovery();
        // 현재 브라우저가 여전히 같은 계정일 때만 로컬 세션을 닫습니다. 저장 이후
        // 정리 실패는 이미 확정된 비밀번호 변경을 실패로 바꾸지 않습니다.
        try {
          if (context === authContextVersion) {
            const current = await client.auth.getUser();
            if (!destroyed && context === authContextVersion && !current.error && current.data.user?.id === userId)
              await client.auth.signOut({ scope: "local" });
          }
        } catch { /* 인증 정리와 비밀번호 저장 결과를 분리합니다. */ }
        message(t("パスワードを保存しました。ログインIDと新しいパスワードでログインしてください。"));
      } catch (error) {
        const code = error instanceof Error ? error.message : "service_unavailable";
        const rejected = ["same_password", "weak_password", "authentication_required", "mfa_required", "reauthentication_required", "current_password_required", "current_password_mismatch", "password_update_failed", "invalid_request", "rate_limited", "feature_unavailable"];
        if (dispatched && !rejected.includes(code)) {
          // 전송 뒤 응답 유실은 저장 실패의 증거가 아닙니다. 새 비밀번호를 자동으로
          // 재전송하지 않고 이 화면의 입력 양식을 닫아 중복 변경을 막습니다.
          passwordOutcome = "uncertain";
          invalidateRecovery();
          message(staffAuthError(new Error("password_update_uncertain")), true);
          return;
        }
        passwordOutcome = "idle";
        throw error;
      } finally { savingUserId = null; }
    });
  });
  function cleanCallbackAddress() {
    // 코드 교환·거절 후 주소창의 인증 값을 제거합니다. 언어 값 등 일반 쿼리는 유지합니다.
    const url = new URL(window.location.href);
    url.hash = "";
    for (const key of ["code", "token_hash", "token", "access_token", "refresh_token", "id_token", "type", "sb_flow_id", "error", "error_code", "error_description"]) url.searchParams.delete(key);
    history.replaceState(null, "", url.pathname + url.search);
  }
  function invalidateRecovery() {
    verificationGeneration++;
    checkingRecovery = false;
    verifiedRecovery = false;
    recoveryUserId = null;
    recoveryToken = null;
    clearStaffPasswords(panel);
    panel.hidden = true;
    options.hidden = false;
  }
  async function verifyRecovery(generation: number, token: string, previousUserId: string | null) {
    if (destroyed || passwordOutcome !== "idle" || generation !== verificationGeneration) return;
    // 새로고침·다른 탭의 같은 계정 이벤트도 Auth가 검증한 최근 복구 인증이면 이어 갑니다.
    // PASSWORD_RECOVERY 이벤트나 URL의 type 값만으로는 입력 양식을 열지 않습니다.
    const [userResult, claimsResult] = await Promise.all([client.auth.getUser(token), client.auth.getClaims(token)]);
    if (destroyed || passwordOutcome !== "idle" || generation !== verificationGeneration) return;
    checkingRecovery = false;
    const userId = userResult.data?.user?.id;
    const claims = claimsResult.data?.claims;
    const now = Date.now() / 1000;
    const methods = claims?.amr;
    const allowed = !userResult.error && !claimsResult.error && typeof userId === "string" && claims?.sub === userId && Array.isArray(methods) &&
      methods.some(method => method !== null && typeof method === "object" && ["recovery", "invite"].includes(method.method) && typeof method.timestamp === "number" &&
        Number.isFinite(method.timestamp) && method.timestamp <= now + 60 && now - method.timestamp <= 900);
    if (!allowed) {
      const showFailure = callbackPresent || previousUserId !== null;
      invalidateRecovery();
      if (callbackPresent) cleanCallbackAddress();
      if (showFailure) callbackFailure();
      return;
    }
    const preserveInput = previousUserId === userId;
    if (!preserveInput) clearStaffPasswords(panel);
    verifiedRecovery = true;
    recoveryUserId = userId;
    recoveryToken = token;
    panel.hidden = false;
    options.hidden = true;
    cleanCallbackAddress();
    message("");
    if (!preserveInput) panel.querySelector<HTMLElement>("h2")?.focus();
  }
  const { data: listener } = client.auth.onAuthStateChange((event, session) => {
    if (callbackInitializing) return;
    if (passwordOutcome !== "idle") {
      if (event === "SIGNED_OUT" || (["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(event) && session?.user?.id !== savingUserId)) {
        authContextVersion++;
        invalidateRecovery();
      }
      return;
    }
    if (["PASSWORD_RECOVERY", "INITIAL_SESSION", "TOKEN_REFRESHED", "SIGNED_IN"].includes(event) && session?.access_token) {
      const previousUserId = recoveryUserId;
      const generation = ++verificationGeneration;
      const token = session.access_token;
      checkingRecovery = true;
      verifiedRecovery = false;
      if (previousUserId && session.user?.id && session.user.id !== previousUserId) {
        authContextVersion++;
        clearStaffPasswords(panel);
        panel.hidden = true;
        options.hidden = false;
      }
      // Auth 이벤트의 동기 콜백 안에서 SDK를 다시 호출하면 잠금이 겹칠 수 있습니다.
      setTimeout(() => { void verifyRecovery(generation, token, previousUserId).catch(() => {
        if (!destroyed && generation === verificationGeneration) {
          invalidateRecovery();
          callbackFailure();
        }
      }); }, 0);
    } else if (event === "SIGNED_OUT" || event === "SIGNED_IN") { authContextVersion++; invalidateRecovery(); }
  });
  // [편집 안내] URL 자동 세션 채택은 생성 옵션에서 차단합니다. PKCE는 공식 SDK의
  // 명시 교환만 사용합니다. 선택한 flow의 로컬 verifier가 없으면 SDK가 네트워크 요청 전에 거절합니다.
  // flow ID 없는 예전 단일 verifier 링크와 개별 flow ID 링크를 모두 유지합니다.
  void client.auth.initialize().then(async ({ error }) => {
    if (destroyed) return;
    if (error) {
      invalidateRecovery();
      cleanCallbackAddress();
      callbackFailure();
      return;
    }
    if (callbackPresent) {
      const fragment = new URLSearchParams(callbackUrl.hash.slice(1));
      const codes = callbackUrl.searchParams.getAll("code");
      const flows = callbackUrl.searchParams.getAll("sb_flow_id");
      const implicitToken = ["access_token", "refresh_token", "token_hash", "token", "id_token"]
        .some(key => callbackUrl.searchParams.has(key) || fragment.has(key));
      if (callback.hasError || implicitToken || fragment.has("code") || codes.length !== 1 ||
          !codes[0]?.trim() || codes[0].length > 4096 || flows.length > 1 ||
          flows.length === 1 && !/^[A-Za-z0-9_-]{8,64}$/.test(flows[0] ?? "")) {
        invalidateRecovery();
        cleanCallbackAddress();
        callbackFailure();
        return;
      }
      const exchange = await client.auth.exchangeCodeForSession(codes[0], flows[0] ? { flowId: flows[0] } : undefined);
      if (destroyed) return;
      cleanCallbackAddress();
      if (exchange.error || !exchange.data.session?.access_token) {
        invalidateRecovery();
        callbackFailure();
        return;
      }
      callbackInitializing = false;
      const generation = ++verificationGeneration;
      checkingRecovery = true;
      await verifyRecovery(generation, exchange.data.session.access_token, null);
    }
  }).catch(() => {
    if (!destroyed) { invalidateRecovery(); cleanCallbackAddress(); callbackFailure(); }
  });
  return { destroy() {
    destroyed = true;
    listener.subscription.unsubscribe();
    verificationGeneration++;
    authContextVersion++;
    clearStaffPasswords(panel);
  } };
}

initLanguageSwitcher(true, t);
const root = document.querySelector<HTMLElement>("#staff-auth-help");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (root?.dataset.enabled === "true" && url && key?.startsWith("sb_publishable_") && ["https:", "http:"].includes(window.location.protocol)) {
  const callback = recoveryCallbackState(window.location.href);
  // 메인 페이지와 같은 저장 키를 사용하되, 한 페이지에서 클라이언트를 중복 생성하지 않습니다.
  const client = createClient(url, key, {
    auth: {
      storageKey: "kansai-admin-session", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce",
      // 이전에 발급된 링크의 개별 verifier를 계속 읽습니다. 새 이메일 발송 양식은 제공하지 않습니다.
      experimental: { appendPkceFlowIdToRedirects: true },
    },
    global: { fetch: createStaffRecoveryFetch(url, key) },
  });
  mountStaffAuthHelp({ root, client, callback });
} else if (root?.dataset.enabled === "true") {
  root.querySelector<HTMLElement>("#staff-help-options")!.hidden = true;
  root.querySelector<HTMLElement>("#staff-help-message")!.textContent = t("管理システムの接続は準備中です。");
}
