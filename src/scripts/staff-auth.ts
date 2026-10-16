import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import type { StaffAccountState } from "../lib/staff-auth-types";

type AuthResult = {
  session?: { access_token: string; refresh_token: string };
  account?: StaffAccountState;
  success?: boolean;
  code?: string;
  error?: string;
  operation_id?: string;
};
type StaffAuthOptions = {
  client: SupabaseClient;
  notice: (message: string, error?: boolean) => void;
  refresh: () => Promise<unknown>;
};

// [편집 안내] 공개 로그인 응답에는 이메일/아이디 존재 여부나 DB 오류를 표시하지 않습니다.
// HTTP 오류의 원문은 로그에도 출력하지 않고, 제한된 오류 코드만 문구로 변환합니다.
export async function staffAuthRequest(
  client: SupabaseClient,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<AuthResult> {
  const { data, error } = await client.functions.invoke<AuthResult>("staff-auth", {
    body,
    ...(accessToken ? { headers: { Authorization: "Bearer " + accessToken } } : {}),
  });
  if (error) {
    let code = "service_unavailable";
    if (error.context instanceof Response) {
      try {
        const value = await error.context.json();
        if (typeof value?.error === "string") code = value.error;
      } catch { /* 오류 응답이 JSON이 아니어도 원문을 노출하지 않습니다. */ }
    }
    throw new Error(code);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error)
    throw new Error(data?.error ?? "service_unavailable");
  // HTTP 200이나 빈 객체만으로 저장 성공을 표시하지 않습니다. 작업별 확정 응답을
  // 검사해 프록시 오류·구버전 배포·잘못된 모의 응답이 비밀번호 저장으로 보이지 않게 합니다.
  const received = (code: string) => data.success === true && data.code === code;
  const confirmed = body.action === "login"
    ? typeof data.session?.access_token === "string" && data.session.access_token.length > 0 &&
      typeof data.session.refresh_token === "string" && data.session.refresh_token.length > 0 && data.success !== false
    : body.action === "register" ? received("registration_received")
    : body.action === "recovery" ? received("recovery_received")
    : body.action === "legacy_login" ? received("legacy_link_received")
    : body.action === "enroll" ? data.success === true && data.account !== null &&
      typeof data.account === "object" && !Array.isArray(data.account) && typeof data.account.user_id === "string"
    : body.action === "set_password" ? received("password_updated")
    : body.action === "owner_reset_password" ? data.success === true &&
      data.operation_id === body.operation_id &&
      ["owner_password_reset_succeeded", "owner_password_reset_already_succeeded"].includes(data.code ?? "")
    : false;
  if (!confirmed) throw new Error("invalid_response");
  return data;
}

export function staffAuthError(error: unknown): string {
  const code = error instanceof Error ? error.message : "service_unavailable";
  if (code === "rate_limited")
    return t("試行回数が制限されています。少し時間をおいてから再度お試しください。");
  if (code === "email_rate_limited")
    return t("メールの送信が制限され、今回は申請を受け付けられませんでした。パスワードは変更されていません。時間をおくか、メールを使わない復旧をご利用ください。");
  if (code === "email_unavailable")
    return t("確認メールの申請を完了できませんでした。パスワードは変更されていません。メールを使わない復旧をご利用いただくか、運営責任者にご相談ください。");
  if (code === "invalid_credentials")
    return t("ログインIDまたはパスワードをご確認ください。");
  if (code === "invalid_request")
    return t("入力内容をご確認ください。登録済みの場合はログインまたは復旧をご利用ください。");
  if (code === "authentication_required")
    return t("ログインを確認できません。もう一度ログインしてください。");
  if (code === "enrollment_unavailable")
    return t("登録を完了できませんでした。IDを確認し、必要な場合は運営責任者にご相談ください。");
  if (code === "registration_unavailable")
    return t("登録を完了できませんでした。同じID・メールを使った申請がある場合は、ログインまたは復旧をご利用ください。登録を繰り返さず、運営責任者にご確認ください。");
  if (code === "registration_uncertain")
    return t("登録結果を確認できません。アカウントが作成された可能性があります。この画面から再申請せず、ログインまたは復旧を確認し、利用できない場合は運営責任者にご相談ください。");
  if (code === "password_update_failed")
    return t("パスワードを設定できませんでした。ログイン状態を確認するか、運営責任者にご相談ください。");
  if (code === "same_password")
    return t("現在と同じパスワードです。別のパスワードを入力するか、入力したパスワードでログインしてください。");
  if (code === "weak_password")
    return t("このパスワードは利用できません。12文字以上で、推測されにくい別のパスワードを入力してください。");
  if (["reauthentication_required", "current_password_required", "current_password_mismatch"].includes(code))
    return t("パスワード変更の認証を確認できません。確認リンクを申請し直すか、運営責任者にご相談ください。");
  if (code === "mfa_required")
    return t("追加の本人確認が必要です。運営責任者に復旧をご相談ください。");
  if (code === "password_update_uncertain")
    return t("保存結果を確認できません。パスワードは変更された可能性があります。再設定を繰り返さず、入力した新しいパスワードでログインを確認し、利用できない場合は運営責任者にご相談ください。");
  if (code === "feature_unavailable")
    return t("新しいログイン方式は移行準備中です。現在のログイン画面をご利用ください。");
  return t("操作を完了できませんでした。時間をおいて再度お試しください。");
}

export function attachPasswordToggles(root: HTMLElement) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-password-toggle]")) {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle ?? "");
      if (!(input instanceof HTMLInputElement)) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.textContent = t(visible ? "非表示" : "表示");
      // 버튼은 키보드 포커스를 유지합니다. 다음 Tab은 자연스럽게 다음 입력란으로 이동합니다.
    });
  }
}

export function clearStaffPasswords(root: HTMLElement) {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[autocomplete="current-password"], input[autocomplete="new-password"]')) {
    input.value = "";
    input.type = "password";
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-password-toggle]")) {
    button.setAttribute("aria-pressed", "false");
    button.textContent = t("表示");
  }
}

// 새 비밀번호는 native Auth의 바이트 상한과 맞춥니다. 기존 로그인 비밀번호에는 적용하지 않습니다.
export function validNewStaffPassword(value: string): boolean {
  return value.length >= 12 && new Blob([value]).size <= 72;
}

export function mountStaffAuth({ client, notice, refresh }: StaffAuthOptions) {
  const root = document.querySelector<HTMLElement>("#staff-auth-portal");
  if (!root) throw new Error("Staff authentication portal is unavailable");
  const portal = root;
  const localNotice = portal.querySelector<HTMLElement>("#staff-auth-message")!;
  let busy = false;
  let viewGeneration = 0;
  let ownState: StaffAccountState | null = null;
  let registrationUncertain = false;
  const form = (name: string) => portal.querySelector<HTMLFormElement>("#staff-" + name + "-form")!;
  const field = (element: HTMLFormElement, name: string) => element.elements.namedItem(name) as HTMLInputElement;
  const read = (element: HTMLFormElement, name: string) => field(element, name).value;
  function message(value: string, error = false) {
    notice("");
    localNotice.textContent = value;
    localNotice.dataset.error = String(error);
    localNotice.setAttribute("role", error ? "alert" : "status");
    if (value) localNotice.focus();
  }
  function show(name: string, focus = true) {
    viewGeneration++;
    portal.hidden = false;
    for (const panel of portal.querySelectorAll<HTMLElement>("[data-staff-panel]"))
      panel.hidden = panel.dataset.staffPanel !== name;
    clearStaffPasswords(portal);
    message("");
    if (focus) {
      const panel = portal.querySelector<HTMLElement>('[data-staff-panel="' + name + '"]');
      (panel?.querySelector<HTMLElement>("h2, input") ?? portal.querySelector<HTMLElement>("h1"))?.focus();
    }
  }
  async function run(element: HTMLFormElement | HTMLElement, task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    const generation = viewGeneration;
    element.setAttribute("aria-busy", "true");
    for (const button of portal.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    message("");
    try { await task(); }
    catch (error) { if (generation === viewGeneration) message(staffAuthError(error), true); }
    finally {
      busy = false;
      element.removeAttribute("aria-busy");
      for (const button of portal.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
      if (registrationUncertain)
        form("signup").querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
    }
  }
  function invalid(element: HTMLInputElement, value: string) {
    element.setAttribute("aria-invalid", "true");
    message(t(value), true);
    element.focus();
  }
  function identity(element: HTMLFormElement) {
    return {
      username: read(element, "username").trim().toLowerCase(),
      real_name: read(element, "real_name").normalize("NFC").trim(),
      department: read(element, "department").normalize("NFC").trim(),
      notice_accepted: field(element, "notice_accepted").checked,
    };
  }
  function bind(name: string, task: (element: HTMLFormElement) => Promise<void>) {
    const element = form(name);
    element.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement) event.target.removeAttribute("aria-invalid");
    });
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!busy && element.reportValidity()) void run(element, () => task(element));
    });
  }
  attachPasswordToggles(portal);
  for (const button of portal.querySelectorAll<HTMLButtonElement>("[data-staff-show]"))
    button.addEventListener("click", () => { if (!busy) show(button.dataset.staffShow!); });
  bind("login", async (element) => {
    const generation = viewGeneration;
    const username = read(element, "username").trim().toLowerCase();
    const password = read(element, "password");
    clearStaffPasswords(portal);
    const result = await staffAuthRequest(client, { action: "login", username, password });
    // 다른 탭의 로그아웃이나 계정 전환 뒤 도착한 응답으로 다시 로그인하지 않습니다.
    if (generation !== viewGeneration) return;
    if (!result.session?.access_token || !result.session.refresh_token) throw new Error("invalid_credentials");
    // 서버가 실제 Supabase Auth로 검증한 세션만 사용하며 UUID를 변경하거나 별도 세션을 만들지 않습니다.
    const { error } = await client.auth.setSession(result.session);
    if (error) throw new Error("invalid_credentials");
    await refresh();
  });
  bind("signup", async (element) => {
    if (registrationUncertain) { message(staffAuthError(new Error("registration_uncertain")), true); return; }
    const generation = viewGeneration;
    const password = read(element, "password");
    const confirmation = read(element, "password_confirmation");
    if (!validNewStaffPassword(password)) {
      invalid(field(element, "password"), "パスワードは12文字以上、UTF-8で72バイト以内にしてください。");
      return;
    }
    if (password !== confirmation) {
      invalid(field(element, "password_confirmation"), "パスワードが一致しません。");
      return;
    }
    const payload = { action: "register", ...identity(element), password, password_confirmation: confirmation, email: read(element, "email").trim() };
    clearStaffPasswords(portal);
    try { await staffAuthRequest(client, payload); }
    catch (error) {
      const code = error instanceof Error ? error.message : "service_unavailable";
      if (!["registration_unavailable", "weak_password", "invalid_request", "rate_limited", "feature_unavailable"].includes(code)) {
        // 생성 API 이후 응답이 유실되면 계정 생성 여부를 단정할 수 없습니다.
        // 기존 UUID와 중복 연결을 피하도록 같은 화면의 재신청을 잠급니다.
        registrationUncertain = true;
        throw new Error("registration_uncertain");
      }
      throw error;
    }
    if (generation !== viewGeneration) return;
    element.reset();
    show("login", false);
    message(t("アカウントを作成しました。メールの確認は不要です。入力したIDとパスワードでログインして承認状態をご確認ください。"));
  });
  bind("enroll", async (element) => {
    const generation = viewGeneration;
    const expectedUserId = ownState?.user_id;
    // 저장 세션은 토큰을 가져오는 용도로만 사용하고 같은 토큰의 사용자를 Auth 서버에서 확인합니다.
    // 확인 중 다른 탭에서 계정이 바뀌어도 다른 UUID에 실명을 등록하지 않게 bearer를 고정합니다.
    const session = await client.auth.getSession();
    const token = session.data.session?.access_token;
    if (session.error || !token) throw new Error("authentication_required");
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user || data.user.id !== expectedUserId) throw new Error("authentication_required");
    if (generation !== viewGeneration) return;
    const result = await staffAuthRequest(client, { action: "enroll", ...identity(element) }, token);
    if (generation !== viewGeneration) return;
    element.reset();
    if (result.account) ownState = result.account;
    await refresh();
    notice(t("関係者情報を登録しました。実名の確認状態はアカウント画面で確認できます。"));
  });
  portal.querySelector("#staff-account-refresh")?.addEventListener("click", () => void run(portal, async () => { await refresh(); }));
  portal.querySelector("#staff-account-signout")?.addEventListener("click", () => void run(portal, async () => {
    const { error } = await client.auth.signOut();
    if (error) throw new Error("service_unavailable");
    ownState = null;
    await refresh();
  }));
  portal.querySelector("#staff-account-enroll")?.addEventListener("click", () => { if (ownState) controller.showMigration(ownState); });
  portal.querySelector("#staff-enroll-back")?.addEventListener("click", () => void run(portal, async () => { await refresh(); }));
  const controller = {
    showLogin() { ownState = null; show("login", false); },
    showAccount(state: StaffAccountState) {
      ownState = state;
      show("account", false);
      const list = portal.querySelector<HTMLDListElement>("#staff-account-state")!;
      list.replaceChildren();
      const status = {
        legacy: "移行前のアカウント", pending: "承認待ち", approved: "承認済み", rejected: "申請見送り", suspended: "利用停止",
      } as const;
      const rows = [
        [t("ログインID"), state.username ?? t("未登録")],
        [t("実名"), state.real_name ?? t("未登録")],
        [t("所属・担当業務"), state.department ?? t("未登録")],
        [t("メール確認"), t(state.email_confirmation_required === false || state.email_verification_status === "not_required" ? "確認不要（メール所有未確認）" : state.email_confirmed ? "確認済み" : "未確認")],
        [t("承認状態"), t(status[state.approval_status] ?? "承認待ち")],
        [t("実名確認"), t(state.name_verified_at ? "確認済み" : "未確認")],
      ];
      for (const [label, value] of rows) {
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label!;
        detail.textContent = value!;
        list.append(term, detail);
      }
      portal.querySelector<HTMLButtonElement>("#staff-account-enroll")!.hidden = state.identity_enrolled || !state.legacy_account || state.approval_status === "suspended";
    },
    showMigration(state: StaffAccountState) {
      ownState = state;
      show("migration");
      const element = form("enroll");
      field(element, "username").value = state.username ?? "";
      // 기존 계정에 연결된 아이디는 다시 배정하지 않습니다. 미등록 실명·업무·안내 확인만 받습니다.
      field(element, "username").readOnly = Boolean(state.username);
      field(element, "real_name").value = state.real_name ?? "";
      field(element, "department").value = state.department ?? "";
      field(element, "notice_accepted").checked = false;
    },
    hide() { viewGeneration++; portal.hidden = true; clearStaffPasswords(portal); },
  };
  return controller;
}
