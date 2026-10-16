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
    hasCode: ["code", "access_token", "refresh_token", "token_hash"].some(key => url.searchParams.has(key) || fragment.has(key)),
    hasError: ["error", "error_code", "error_description"].some(key => url.searchParams.has(key) || fragment.has(key)),
  };
}
// [편집 안내] 이 컨트롤러는 복구 전용 화면에서만 사용합니다. 쿼리의 type=recovery나
// 브라우저가 보관한 메타데이터로 비밀번호 변경을 허용하지 않습니다. 서버도 복구 AMR을 재검사합니다.
export function mountStaffAuthHelp({ root, client, callback = recoveryCallbackState(window.location.href) }: HelpOptions) {
  const notice = root.querySelector<HTMLElement>("#staff-help-message")!;
  const recovery = root.querySelector<HTMLFormElement>("#staff-recovery-form")!;
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
  let resendAt = 0;
  let cooldownTimer: number | undefined;
  const requestStatus = root.querySelector<HTMLElement>("#staff-help-request-status");
  const callbackPresent = callback.hasCode || callback.hasError;
  const callbackFailure = () => message(t("確認リンクを読み取れませんでした。最新のリンクを、メールを申請した同じブラウザーで開いてください。別のブラウザーを使う場合は、ここで新しい確認メールを申請してください。"), true);
  function message(value: string, error = false) {
    if (destroyed) return;
    notice.textContent = value;
    notice.dataset.error = String(error);
    notice.setAttribute("role", error ? "alert" : "status");
    if (value) notice.focus();
  }
  function syncButtons() {
    // 이메일 복구와 별도로 동작하는 관리자 지원 양식은 해당 컨트롤러가 잠급니다.
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      if (button.closest("#staff-support-recovery")) continue;
      const mailButton = recovery.contains(button) || button.id === "staff-help-legacy";
      button.disabled = busy || (mailButton && Date.now() < resendAt);
    }
  }
  function beginCooldown() {
    resendAt = Date.now() + 60_000;
    if (cooldownTimer !== undefined) window.clearTimeout(cooldownTimer);
    if (requestStatus) requestStatus.textContent = t("再申請は60秒ほどお待ちください。新しい申請は以前のリンクを無効にする場合があります。");
    cooldownTimer = window.setTimeout(() => {
      if (destroyed) return;
      resendAt = 0;
      if (requestStatus) requestStatus.textContent = "";
      syncButtons();
    }, 60_000);
    syncButtons();
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
  async function send(action: "recovery" | "legacy_login") {
    if (Date.now() < resendAt || busy) return;
    if (!recovery.reportValidity()) return;
    await run(recovery, async () => {
      const email = input(recovery, "email").value.trim();
      if (action === "recovery") {
        // SDK가 PKCE challenge와 브라우저 전용 verifier를 생성합니다.
        // global.fetch 어댑터가 메일 요청만 게이트웨이를 거치게 해 반복 제한을 유지합니다.
        const redirectTo = new URL(import.meta.env.BASE_URL.replace(/\/?$/, "/") + "admin/help/", window.location.origin).href;
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) {
          if (error.code === "rate_limited") beginCooldown();
          throw new Error(error.code === "rate_limited" ? "email_rate_limited" : error.code === "service_unavailable" ? "email_unavailable" : error.code ?? "email_unavailable");
        }
      } else {
        try { await staffAuthRequest(client, { action, email }); }
        catch (error) {
          if (error instanceof Error && error.message === "rate_limited") { beginCooldown(); throw new Error("email_rate_limited"); }
          if (error instanceof Error && ["service_unavailable", "invalid_response"].includes(error.message)) throw new Error("email_unavailable");
          throw error;
        }
      }
      beginCooldown();
      message(t(action === "recovery"
        ? "確認リンクの送信を受け付けました。パスワードはまだ変更されていません。登録済みの場合は、最新のメールのリンクをこのブラウザーで開き、新しいパスワードを保存してください。"
        : "ログインリンクの送信を受け付けました。登録済みの場合はメールをご確認ください。"));
    });
  }
  recovery.addEventListener("submit", (event) => { event.preventDefault(); void send("recovery"); });
  root.querySelector("#staff-help-legacy")?.addEventListener("click", () => void send("legacy_login"));
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
    // SDK가 콜백 토큰을 읽은 뒤 주소창에서 제거합니다. 언어 값 등 일반 쿼리는 유지합니다.
    const url = new URL(window.location.href);
    url.hash = "";
    for (const key of ["code", "token_hash", "token", "access_token", "refresh_token", "type", "sb_flow_id", "error", "error_code", "error_description"]) url.searchParams.delete(key);
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
  // SDK의 자동 콜백 오류는 일반 getSession 응답에 남지 않을 수 있으므로 초기화 결과를 별도로 확인합니다.
  // 검증기가 없는 ?code 콜백은 SDK가 교환 자체를 생략합니다. 이 경우에도 빈 메일 양식으로 조용히 돌아가지 않습니다.
  void client.auth.initialize().then(({ error }) => {
    if (destroyed) return;
    if (error) {
      invalidateRecovery();
      cleanCallbackAddress();
      callbackFailure();
      return;
    }
    setTimeout(() => {
      if (!destroyed && passwordOutcome === "idle" && callbackPresent && !verifiedRecovery && !checkingRecovery) {
        cleanCallbackAddress();
        callbackFailure();
      }
    }, 0);
  }).catch(() => {
    if (!destroyed) { invalidateRecovery(); cleanCallbackAddress(); callbackFailure(); }
  });
  return { destroy() {
    destroyed = true;
    if (cooldownTimer !== undefined) window.clearTimeout(cooldownTimer);
    listener.subscription.unsubscribe();
    verificationGeneration++;
    authContextVersion++;
    clearStaffPasswords(panel);
  } };
}

initLanguageSwitcher(true);
const root = document.querySelector<HTMLElement>("#staff-auth-help");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (root?.dataset.enabled === "true" && url && key?.startsWith("sb_publishable_") && ["https:", "http:"].includes(window.location.protocol)) {
  const callback = recoveryCallbackState(window.location.href);
  // 메인 페이지와 같은 저장 키를 사용하되, 한 페이지에서 클라이언트를 중복 생성하지 않습니다.
  const client = createClient(url, key, {
    auth: {
      storageKey: "kansai-admin-session", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce",
      // 여러 재신청의 verifier를 SDK가 개별 보관합니다. 게이트웨이는 이 흐름 ID만
      // 허용된 복귀 주소에 전달하며 인증 토큰·임의 redirect 주소는 전달하지 않습니다.
      experimental: { appendPkceFlowIdToRedirects: true },
    },
    global: { fetch: createStaffRecoveryFetch(url, key) },
  });
  mountStaffAuthHelp({ root, client, callback });
} else if (root?.dataset.enabled === "true") {
  root.querySelector<HTMLElement>("#staff-help-options")!.hidden = true;
  root.querySelector<HTMLElement>("#staff-help-message")!.textContent = t("管理システムの接続は準備中です。");
}
