import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import { initLanguageSwitcher } from "./languages";
import { attachPasswordToggles, clearStaffPasswords, staffAuthError, staffAuthRequest } from "./staff-auth";
import { createStaffRecoveryFetch } from "../lib/staff-auth-recovery";

type HelpOptions = { root: HTMLElement; client: SupabaseClient };
// [편집 안내] 이 컨트롤러는 복구 전용 화면에서만 사용합니다. 쿼리의 type=recovery나
// 브라우저가 보관한 메타데이터로 비밀번호 변경을 허용하지 않습니다. 서버도 복구 AMR을 재검사합니다.
export function mountStaffAuthHelp({ root, client }: HelpOptions) {
  const notice = root.querySelector<HTMLElement>("#staff-help-message")!;
  const recovery = root.querySelector<HTMLFormElement>("#staff-recovery-form")!;
  const passwordForm = root.querySelector<HTMLFormElement>("#staff-new-password-form")!;
  const panel = root.querySelector<HTMLElement>("#staff-new-password-panel")!;
  const options = root.querySelector<HTMLElement>("#staff-help-options")!;
  let busy = false;
  let verifiedRecovery = false;
  let recoveryEvent = false;
  let recoveryUserId: string | null = null;
  let recoveryToken: string | null = null;
  let verificationGeneration = 0;
  function message(value: string, error = false) {
    notice.textContent = value;
    notice.dataset.error = String(error);
    notice.setAttribute("role", error ? "alert" : "status");
    if (value) notice.focus();
  }
  async function run(form: HTMLElement, task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    form.setAttribute("aria-busy", "true");
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    message("");
    try { await task(); }
    catch (error) { message(staffAuthError(error), true); }
    finally {
      busy = false;
      form.removeAttribute("aria-busy");
      for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
    }
  }
  const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
  async function send(action: "recovery" | "legacy_login") {
    if (!recovery.reportValidity()) return;
    await run(recovery, async () => {
      const email = input(recovery, "email").value.trim();
      if (action === "recovery") {
        // SDK가 PKCE challenge와 브라우저 전용 verifier를 생성합니다.
        // global.fetch 어댑터가 메일 요청만 게이트웨이를 거치게 해 반복 제한을 유지합니다.
        const { error } = await client.auth.resetPasswordForEmail(email);
        if (error) throw new Error(error.code ?? "service_unavailable");
      } else await staffAuthRequest(client, { action, email });
      message(t(action === "recovery"
        ? "確認リンクの送信を受け付けました。登録済みの場合は、最新のメールからお手続きください。"
        : "ログインリンクの送信を受け付けました。登録済みの場合はメールをご確認ください。"));
    });
  }
  recovery.addEventListener("submit", (event) => { event.preventDefault(); void send("recovery"); });
  root.querySelector("#staff-help-legacy")?.addEventListener("click", () => void send("legacy_login"));
  attachPasswordToggles(root);
  passwordForm.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement) event.target.removeAttribute("aria-invalid");
  });
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !passwordForm.reportValidity()) return;
    if (!verifiedRecovery) { message(staffAuthError(new Error("authentication_required")), true); return; }
    const password = input(passwordForm, "password").value;
    const confirmation = input(passwordForm, "password_confirmation").value;
    if (password !== confirmation) {
      input(passwordForm, "password_confirmation").setAttribute("aria-invalid", "true");
      message(t("パスワードが一致しません。"), true);
      input(passwordForm, "password_confirmation").focus();
      return;
    }
    clearStaffPasswords(root);
    void run(passwordForm, async () => {
      const generation = verificationGeneration;
      const token = recoveryToken;
      const userId = recoveryUserId;
      if (!token || !userId) throw new Error("authentication_required");
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user || data.user.id !== userId) throw new Error("authentication_required");
      if (generation !== verificationGeneration || !verifiedRecovery) return;
      await staffAuthRequest(client, { action: "set_password", password, password_confirmation: confirmation }, token);
      if (generation !== verificationGeneration) return;
      verifiedRecovery = false;
      recoveryUserId = null;
      recoveryToken = null;
      panel.hidden = true;
      options.hidden = false;
      // 비밀번호 변경 후 복구 세션을 닫고 새 자격으로 로그인하게 해 잘못된 계정 사용을 줄입니다.
      const { error: signOutError } = await client.auth.signOut();
      message(t(signOutError
        ? "パスワードを保存しました。ログイン画面に戻ってください。"
        : "パスワードを保存しました。ログインIDと新しいパスワードでログインしてください。"));
    });
  });
  async function verifyRecovery(generation: number, token: string) {
    const { data, error } = await client.auth.getUser(token);
    if (generation !== verificationGeneration || !recoveryEvent) return;
    verifiedRecovery = !error && Boolean(data.user);
    recoveryUserId = verifiedRecovery ? data.user!.id : null;
    recoveryToken = verifiedRecovery ? token : null;
    panel.hidden = !verifiedRecovery;
    options.hidden = verifiedRecovery;
    // SDK가 콜백 토큰을 읽은 뒤 주소창에서 제거합니다. 언어 값 등 일반 쿼리는 유지합니다.
    const url = new URL(window.location.href);
    url.hash = "";
    for (const key of ["code", "token_hash", "token", "access_token", "refresh_token", "type", "sb_flow_id"]) url.searchParams.delete(key);
    history.replaceState(null, "", url.pathname + url.search);
    if (verifiedRecovery) panel.querySelector<HTMLElement>("h2")?.focus();
    else message(staffAuthError(new Error("authentication_required")), true);
  }
  const { data: listener } = client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session?.access_token) {
      recoveryEvent = true;
      const generation = ++verificationGeneration;
      const token = session.access_token;
      // Auth 이벤트의 동기 콜백 안에서 SDK를 다시 호출하면 잠금이 겹칠 수 있습니다.
      setTimeout(() => { void verifyRecovery(generation, token).catch(() => {
        if (generation === verificationGeneration) message(staffAuthError(null), true);
      }); }, 0);
    } else if (event === "SIGNED_OUT" || event === "SIGNED_IN") {
      verificationGeneration++;
      recoveryEvent = false;
      verifiedRecovery = false;
      recoveryUserId = null;
      recoveryToken = null;
      clearStaffPasswords(root);
      panel.hidden = true;
      options.hidden = false;
    }
  });
  return { destroy() { listener.subscription.unsubscribe(); verificationGeneration++; } };
}

initLanguageSwitcher(true);
const root = document.querySelector<HTMLElement>("#staff-auth-help");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (root?.dataset.enabled === "true" && url && key?.startsWith("sb_publishable_") && ["https:", "http:"].includes(window.location.protocol)) {
  // 메인 페이지와 같은 저장 키를 사용하되, 한 페이지에서 클라이언트를 중복 생성하지 않습니다.
  const client = createClient(url, key, {
    auth: { storageKey: "kansai-admin-session", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    global: { fetch: createStaffRecoveryFetch(url, key) },
  });
  mountStaffAuthHelp({ root, client });
} else if (root?.dataset.enabled === "true") {
  root.querySelector<HTMLElement>("#staff-help-options")!.hidden = true;
  root.querySelector<HTMLElement>("#staff-help-message")!.textContent = t("管理システムの接続は準備中です。");
}
