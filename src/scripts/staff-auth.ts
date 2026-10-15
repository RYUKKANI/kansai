import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import type { StaffAccountState } from "../lib/staff-auth-types";

type AuthResult = {
  session?: { access_token: string; refresh_token: string };
  account?: StaffAccountState;
  success?: boolean;
  code?: string;
  error?: string;
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
  if (!data || data.error) throw new Error(data?.error ?? "service_unavailable");
  return data;
}

export function staffAuthError(error: unknown): string {
  const code = error instanceof Error ? error.message : "service_unavailable";
  if (code === "rate_limited")
    return t("試行回数が制限されています。少し時間をおいてから再度お試しください。");
  if (code === "invalid_credentials")
    return t("ログインIDまたはパスワードをご確認ください。");
  if (code === "invalid_request")
    return t("入力内容をご確認ください。登録済みの場合はログインまたは復旧をご利用ください。");
  if (code === "authentication_required")
    return t("確認済みのログインが必要です。確認メールのリンクを開き直してください。");
  if (code === "enrollment_unavailable")
    return t("登録を完了できませんでした。IDを確認し、必要な場合は運営責任者にご相談ください。");
  if (code === "password_update_failed")
    return t("パスワードを設定できませんでした。新しい確認メールのリンクからお試しください。");
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

export function mountStaffAuth({ client, notice, refresh }: StaffAuthOptions) {
  const root = document.querySelector<HTMLElement>("#staff-auth-portal");
  if (!root) throw new Error("Staff authentication portal is unavailable");
  const portal = root;
  const localNotice = portal.querySelector<HTMLElement>("#staff-auth-message")!;
  let busy = false;
  let viewGeneration = 0;
  let ownState: StaffAccountState | null = null;
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
    const generation = viewGeneration;
    const password = read(element, "password");
    const confirmation = read(element, "password_confirmation");
    if (password !== confirmation) {
      invalid(field(element, "password_confirmation"), "パスワードが一致しません。");
      return;
    }
    const payload = { action: "register", ...identity(element), password, password_confirmation: confirmation, email: read(element, "email").trim() };
    clearStaffPasswords(portal);
    await staffAuthRequest(client, payload);
    if (generation !== viewGeneration) return;
    element.reset();
    show("login", false);
    message(t("登録申請を受け付けました。確認メールをご確認ください。すでに登録済みの場合はログインまたは復旧をご利用ください。"));
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
    notice(t("ログインIDを登録しました。実名の確認状態はアカウント画面で確認できます。"));
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
        [t("メール確認"), t(state.email_confirmed ? "確認済み" : "未確認")],
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
      portal.querySelector<HTMLButtonElement>("#staff-account-enroll")!.hidden = state.identity_enrolled || state.approval_status === "suspended";
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
