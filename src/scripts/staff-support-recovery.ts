import { createClient } from "@supabase/supabase-js";
import { currentLocale, text as t } from "../lib/i18n";
import { attachPasswordToggles, clearStaffPasswords, staffAuthError, validNewStaffPassword } from "./staff-auth";

type Reply = Record<string, unknown>;
type StoredRequest = {
  version: 1;
  requestId: string;
  deviceSecret: string;
  fingerprint: string;
  expiresAt: string;
  attempted: boolean;
};
type Options = {
  root: HTMLElement;
  request: (body: Record<string, unknown>) => Promise<Reply>;
  storage: Storage;
};
const STORAGE_KEY = "kansai-owner-recovery-device-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_SECRET = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const STATES = ["requested", "approved", "executing", "succeeded", "failed", "uncertain", "expired"];

// [편집 안내] 기기 비밀값은 본인 확인 증거가 아닙니다. 별도 프로젝트 관리자 승인과 함께만
// 사용할 수 있으며, URL·DOM·로그에 넣지 않고 이 탭의 sessionStorage와 HTTPS 본문에서만 사용합니다.
export function mountStaffSupportRecovery({ root, request, storage }: Options) {
  const requestForm = root.querySelector<HTMLFormElement>("#staff-support-request-form")!;
  const passwordForm = root.querySelector<HTMLFormElement>("#staff-support-password-form")!;
  const panel = root.querySelector<HTMLElement>("#staff-support-request-panel")!;
  const notice = root.querySelector<HTMLElement>("#staff-support-message")!;
  const check = root.querySelector<HTMLButtonElement>("#staff-support-check")!;
  const forget = root.querySelector<HTMLButtonElement>("#staff-support-forget")!;
  let record: StoredRequest | null = null;
  let busy = false;
  let destroyed = false;
  let terminal = false;
  let generation = 0;
  const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const message = (value: string, error = false) => {
    notice.textContent = value;
    notice.dataset.error = String(error);
    notice.setAttribute("role", error ? "alert" : "status");
    if (value) notice.focus();
  };
  function persist(value: StoredRequest) {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  }
  function removeStored() {
    try { storage.removeItem(STORAGE_KEY); } catch { /* 저장소 차단이 서버 작업 결과를 바꾸지는 않습니다. */ }
  }
  function references() {
    const text = (id: string, value: string) => { root.querySelector<HTMLOutputElement>(id)!.textContent = value; };
    text("#staff-support-request-id", record?.requestId ?? "");
    text("#staff-support-fingerprint", record?.fingerprint.toUpperCase().match(/.{1,4}/g)?.join("-") ?? "");
    text("#staff-support-expiry", record ? new Intl.DateTimeFormat(currentLocale(), {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(record.expiresAt)) : "");
  }
  function showRequest() {
    requestForm.hidden = record !== null;
    panel.hidden = record === null;
    passwordForm.hidden = true;
    check.hidden = terminal;
    forget.hidden = !!record?.attempted;
    references();
    if (record) {
      const details = root.closest("details");
      if (details) details.open = true;
    }
  }
  function pendingMessage() {
    message(t("管理者の確認を待っています。申請番号と端末確認番号を確認済みのプロジェクト管理者に伝えてください。"));
  }
  function uncertainMessage() {
    passwordForm.hidden = true;
    clearStaffPasswords(root);
    message(t("変更結果をまだ確認できません。再送せず、申請番号をプロジェクト管理者に伝えて確認してください。"), true);
  }
  function finish() {
    terminal = true;
    clearStaffPasswords(root);
    removeStored();
    passwordForm.hidden = true;
    check.hidden = true;
    forget.hidden = true;
    // 성공 후 이 탭의 기기 증명을 폐기합니다. 표시용 신청 번호는 비밀값이 아닙니다.
    if (record) record.deviceSecret = "";
    message(t("パスワードを保存しました。ログイン画面でIDと新しいパスワードを入力してください。"));
  }
  async function run(task: () => Promise<void>, completing = false) {
    if (busy || destroyed) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    try { await task(); }
    catch (error) {
      if (!destroyed) {
        if (completing && record?.attempted) uncertainMessage();
        else message(staffAuthError(error), true);
      }
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
      if (!destroyed) for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
    }
  }
  function status(value: Reply) {
    if (!record || value.success !== true || value.code !== "support_recovery_status" || value.request_id !== record.requestId ||
      value.device_fingerprint !== record.fingerprint || typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
      typeof value.state !== "string" || !STATES.includes(value.state)) throw new Error("service_unavailable");
    record.expiresAt = value.expires_at;
    persist(record);
    references();
    clearStaffPasswords(root);
    passwordForm.hidden = true;
    if (value.state === "succeeded") { finish(); return; }
    if (value.state === "failed" || value.state === "expired") {
      terminal = true;
      check.hidden = true;
      forget.hidden = false;
      record.attempted = false;
      removeStored();
      message(t("この申請では変更を完了できません。申請を閉じて新しく申請し、管理者に再確認を依頼してください。"), true);
      return;
    }
    if (value.state === "executing" || value.state === "uncertain" || record.attempted) { uncertainMessage(); return; }
    if (value.state === "approved") {
      passwordForm.hidden = false;
      message(t("プロジェクト管理者の確認が完了しました。この端末で新しいパスワードを入力して保存してください。"));
      passwordForm.querySelector<HTMLElement>("h3")?.focus();
    } else if (value.state === "requested") pendingMessage();
    else {
      terminal = true;
      check.hidden = true;
      forget.hidden = false;
      message(t("この申請では変更を完了できません。申請を閉じて新しく申請し、管理者に再確認を依頼してください。"), true);
    }
  }
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      const value = saved as StoredRequest;
      if (value.version === 1 && UUID.test(value.requestId) && HEX_SECRET.test(value.deviceSecret) && FINGERPRINT.test(value.fingerprint) &&
        typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) && typeof value.attempted === "boolean") record = value;
      else removeStored();
    }
  } catch { /* 비밀값을 저장할 수 없으면 요청을 만들 때 명시적으로 중단합니다. */ }
  showRequest();
  if (record?.attempted) uncertainMessage(); else if (record) pendingMessage();
  attachPasswordToggles(root);
  requestForm.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || record || !requestForm.reportValidity()) return;
    const username = field(requestForm, "username").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) { message(staffAuthError(new Error("invalid_request")), true); return; }
    void run(async () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const deviceSecret = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const requestId = crypto.randomUUID();
      // 저장 실패 후 관리자 승인을 잃는 혼동을 막기 위해 네트워크 요청 전에 저장 가능 여부를 확인합니다.
      try { storage.setItem(STORAGE_KEY, "null"); storage.removeItem(STORAGE_KEY); }
      catch { message(t("この端末では復旧情報を保持できません。通常のブラウザーで保存を許可してから申請してください。"), true); return; }
      const value = await request({ action: "support_recovery_request", username, request_id: requestId, device_secret: deviceSecret });
      if (value.success !== true || value.code !== "support_recovery_requested" || value.request_id !== requestId ||
        typeof value.device_fingerprint !== "string" || !FINGERPRINT.test(value.device_fingerprint) ||
        typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))) throw new Error("service_unavailable");
      if (destroyed) return;
      record = { version: 1, requestId, deviceSecret, fingerprint: value.device_fingerprint, expiresAt: value.expires_at, attempted: false };
      persist(record);
      showRequest();
      pendingMessage();
    });
  });
  check.addEventListener("click", () => {
    if (!record || terminal) return;
    const current = record;
    void run(async () => {
      const value = await request({ action: "support_recovery_status", request_id: current.requestId, device_secret: current.deviceSecret });
      if (!destroyed && record === current) status(value);
    });
  });
  forget.addEventListener("click", () => {
    if (busy || record?.attempted) return;
    generation++;
    removeStored();
    record = null;
    terminal = false;
    clearStaffPasswords(root);
    showRequest();
    message("");
    field(requestForm, "username").focus();
  });
  passwordForm.addEventListener("input", event => {
    if (event.target instanceof HTMLInputElement) event.target.removeAttribute("aria-invalid");
  });
  passwordForm.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !record || terminal || record.attempted || passwordForm.hidden || !passwordForm.reportValidity()) return;
    const password = field(passwordForm, "password").value;
    const confirmation = field(passwordForm, "password_confirmation").value;
    if (!validNewStaffPassword(password)) { message(t("パスワードは12文字以上、UTF-8で72バイト以内にしてください。"), true); return; }
    if (password !== confirmation) {
      field(passwordForm, "password_confirmation").setAttribute("aria-invalid", "true");
      message(t("パスワードが一致しません。"), true);
      return;
    }
    const current = record;
    const sequence = generation;
    void run(async () => {
      // 전송 시작을 먼저 저장해 새로고침·연결 단절 뒤 다른 값이 적용됐다고 오해하는 재전송을 막습니다.
      persist({ ...current, attempted: true });
      current.attempted = true;
      clearStaffPasswords(root);
      forget.hidden = true;
      passwordForm.hidden = true;
      const value = await request({ action: "support_recovery_complete", request_id: current.requestId, device_secret: current.deviceSecret,
        password, password_confirmation: confirmation });
      if (destroyed || generation !== sequence || record !== current) return;
      if (value.success === true && value.code === "support_password_updated" && value.request_id === current.requestId) finish();
      else uncertainMessage();
    }, true);
  });
  return {
    destroy() { destroyed = true; generation++; clearStaffPasswords(root); },
  };
}

const root = document.querySelector<HTMLElement>("#staff-support-recovery-root");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (root && root.closest<HTMLElement>("[data-enabled]")?.dataset.enabled === "true" && url && key?.startsWith("sb_publishable_")) {
  // 지원 요청은 로그인 세션을 만들거나 읽지 않습니다. 다른 탭의 Owner 인증 상태도 바꾸지 않습니다.
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const request = async (body: Record<string, unknown>): Promise<Reply> => {
    const result = await client.functions.invoke<Reply>("staff-auth", { body });
    if (result.error) {
      let code = "service_unavailable";
      if (result.error.context instanceof Response) {
        const value = await result.error.context.json().catch(() => ({}));
        if (value?.error === "rate_limited") code = "rate_limited";
      }
      throw new Error(code);
    }
    if (!result.data || result.data.error) throw new Error("service_unavailable");
    return result.data;
  };
  try {
    const controller = mountStaffSupportRecovery({ root, request, storage: window.sessionStorage });
    window.addEventListener("pagehide", event => {
      if (event.persisted) clearStaffPasswords(root);
      else controller.destroy();
    });
  } catch {
    const notice = root.querySelector<HTMLElement>("#staff-support-message");
    if (notice) { notice.textContent = t("この端末では復旧情報を保持できません。通常のブラウザーで保存を許可してから申請してください。"); notice.setAttribute("role", "alert"); }
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  }
}
