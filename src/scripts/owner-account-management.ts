import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t, format, currentLocale, localizedDate } from "../lib/i18n";
import { staffAuthRequest, validNewStaffPassword } from "./staff-auth";
import { isInitialOwnerNameRegistration, staffNameVerificationLabel, staffNameVerifierLabel } from "../lib/staff-name-verification";

// [편집 안내] Owner의 계정 편집은 별도 대화상자로 분리합니다. 현재 비밀번호·해시는
// 요청하거나 표시하지 않으며, 실제 권한·자기 실명 확인 제한은 RPC와 Edge가 다시 검사합니다.
type Row = Record<string, unknown>;
type Options = {
  client: SupabaseClient;
  userId: string;
  targetUserId: string;
  onChanged: () => void | Promise<void>;
  onOwnIdentityChanged?: () => void | Promise<void>;
  isCurrent: () => boolean;
  notice: (message: string, error?: boolean) => void;
};
export type OwnerAccountManagement = { element: HTMLElement; dispose(): void };
let nextDialog = 0;
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return text((error as Row).code);
  return "";
}
function inputField(
  form: HTMLFormElement,
  title: string,
  name: string,
  id: string,
  multiline = false,
) {
  const label = node("label", title, "staff-field owner-account-field");
  const input = multiline ? node("textarea") : node("input");
  input.name = name;
  input.id = id;
  input.required = true;
  input.maxLength = name === "reason" ? 500 : 150;
  label.htmlFor = id;
  label.append(input);
  form.append(label);
  return input;
}
function submit(form: HTMLFormElement, label: string, action: string) {
  const button = node("button", label, "staff-button owner-account-button");
  button.type = "submit";
  button.dataset.ownerAction = action;
  form.append(button);
  return button;
}
function safeIdentityError(error: unknown): string {
  const code = errorCode(error);
  const detail =
    error && typeof error === "object" ? text((error as Row).message) : code;
  if (code === "23505" || /username.*(unavailable|duplicate)/i.test(code))
    return t("このログインIDは利用できません。別のIDをご確認ください。");
  if (/self_verified_name_requires_review/.test(detail))
    return t("確認済みの自分の実名は、別の統括に訂正を依頼してください。");
  if (detail === "owner_mfa_required")
    return t(
      "ログインし直してからお試しください。多要素認証を設定している場合は、その認証も完了してください。",
    );
  if (code === "identity_save_uncertain")
    return t(
      "保存結果を確認できませんでした。一覧を更新して現在の情報を確認してから、再度操作してください。",
    );
  if (code === "42501")
    return t(
      "統括の権限を確認できません。この画面を閉じ、ログインし直してください。",
    );
  return t(
    "アカウント情報を保存できませんでした。入力内容と現在の権限をご確認ください。",
  );
}

export function renderOwnerAccountManagement(
  options: Options,
): OwnerAccountManagement {
  const { client, userId, targetUserId, notice } = options;
  const suffix = String(++nextDialog);
  const element = node("div", "", "owner-account-management");
  element.dataset.ownerAccount = targetUserId;
  const trigger = node(
    "button",
    t("アカウントを管理"),
    "staff-button owner-account-button owner-account-trigger",
  );
  trigger.type = "button";
  trigger.dataset.ownerAccountTarget = targetUserId;
  const dialog = node("dialog", "", "admin-dialog owner-account-dialog");
  dialog.id = "owner-account-dialog-" + suffix;
  trigger.setAttribute("aria-controls", dialog.id);
  trigger.setAttribute("aria-haspopup", "dialog");
  const header = node("div", "", "owner-account-header");
  const heading = node("h2", t("アカウント管理"));
  heading.id = "owner-account-title-" + suffix;
  heading.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", heading.id);
  const close = node("button", t("閉じる"), "owner-account-close");
  close.type = "button";
  const message = node("p", "", "owner-account-notice");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.tabIndex = -1;
  const content = node("div", "", "owner-account-body");
  header.append(heading, close);
  dialog.append(header, message, content);
  element.append(trigger, dialog);
  let disposed = false;
  let invalidated = false;
  let sequence = 0;
  let busy = false;
  let resetBlocked = false;
  let uncertainOperation = "";
  const live = () => !disposed && !invalidated && options.isCurrent();
  const visible = (version: number) =>
    live() && dialog.open && version === sequence;
  function clearPasswords() {
    for (const input of dialog.querySelectorAll<HTMLInputElement>(
      '[autocomplete="new-password"]',
    )) {
      input.value = "";
      input.type = "password";
    }
    for (const toggle of dialog.querySelectorAll<HTMLButtonElement>(
      "[data-owner-password-toggle]",
    )) {
      toggle.textContent = t("表示");
      toggle.setAttribute("aria-pressed", "false");
    }
    const acknowledgment = dialog.querySelector<HTMLInputElement>(
      '[name="reset_acknowledged"]',
    );
    if (acknowledgment) acknowledgment.checked = false;
  }
  function closeDialog(restoreFocus = true) {
    sequence++;
    clearPasswords();
    if (dialog.open) dialog.close();
    if (restoreFocus && live() && trigger.isConnected) trigger.focus();
  }
  function showMessage(value: string, error = false, focus = false) {
    if (!live() || !dialog.open) return;
    message.textContent = value;
    message.dataset.error = String(error);
    message.setAttribute("role", error ? "alert" : "status");
    if (focus) message.focus();
  }
  function controlsDisabled(value: boolean) {
    trigger.disabled = value;
    dialog.setAttribute("aria-busy", String(value));
    for (const control of content.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
    >("input,textarea,button")) {
      control.disabled =
        value ||
        (resetBlocked &&
          control.closest('[data-owner-form="password"]') !== null);
    }
  }
  async function changed() {
    if (!live()) return;
    try {
      await options.onChanged();
    } catch {
      if (live())
        notice(
          t(
            "変更は保存されましたが、一覧を更新できませんでした。画面を開き直してください。",
          ),
          true,
        );
    }
  }
  async function ownIdentityChanged() {
    if (!live() || targetUserId !== userId || !options.onOwnIdentityChanged)
      return;
    try {
      await options.onOwnIdentityChanged();
    } catch {
      if (live())
        notice(
          t(
            "変更は保存されましたが、アカウント表示を更新できませんでした。画面を再読み込みしてください。",
          ),
          true,
        );
    }
  }
  async function readAccount(): Promise<Row> {
    const result = await client.rpc("office_owner_account", {
      p_user_id: targetUserId,
    });
    if (result.error) throw result.error;
    if (
      !result.data ||
      typeof result.data !== "object" ||
      Array.isArray(result.data) ||
      result.data.user_id !== targetUserId
    )
      throw new Error("invalid_response");
    return result.data as Row;
  }
  function passwordInput(form: HTMLFormElement, title: string, name: string) {
    const input = inputField(
      form,
      title,
      name,
      "owner-account-" + name + "-" + suffix,
    ) as HTMLInputElement;
    input.type = "password";
    input.autocomplete = "new-password";
    input.minLength = 12;
    input.maxLength = 72;
    const toggle = node("button", t("表示"), "owner-account-reveal");
    toggle.type = "button";
    toggle.dataset.ownerPasswordToggle = name;
    toggle.setAttribute("aria-controls", input.id);
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = t(show ? "非表示" : "表示");
      toggle.setAttribute("aria-pressed", String(show));
    });
    input.parentElement?.append(toggle);
    return input;
  }
  function renderAccount(account: Row) {
    const information = node("dl", "", "staff-details owner-account-details");
    information.dataset.nameVerificationSource = text(account.name_verification_source);
    for (const [label, value] of [
      [t("アカウント識別番号"), targetUserId],
      [t("ログインID"), text(account.username) || "—"],
      [t("実名"), text(account.real_name) || "—"],
      [t("実名確認"), staffNameVerificationLabel(account)],
      [t("確認者"), staffNameVerifierLabel(account)],
      [t("確認日時"), text(account.name_verified_at) ? localizedDate(text(account.name_verified_at), currentLocale(), true) : "—"],
      [
        t("パスワードの設定状態"),
        resetBlocked
          ? t("確認不可")
          : account.password_is_set === true
            ? t("設定済み")
            : account.password_is_set === false
              ? t("未設定")
              : t("確認不可"),
      ],
    ] as const) {
      const item = node("div", "", "staff-detail");
      const detail = node("dd", value);
      if (label === t("パスワードの設定状態"))
        detail.dataset.ownerPasswordState = "true";
      if (label === t("実名確認")) detail.dataset.ownerNameState = "true";
      item.append(node("dt", label), detail);
      information.append(item);
    }
    const warning = node(
      "p",
      t(
        "現在のパスワードは表示・取得できません。必要な場合は新しいパスワードに再設定します。",
      ),
      "owner-account-help",
    );
    const privateReasonHelp = node(
      "p",
      t("変更理由にパスワード・認証情報や連絡先を記入しないでください。"),
      "owner-account-help",
    );
    const identity = node("form", "", "staff-form owner-account-form");
    identity.dataset.ownerForm = "identity";
    identity.append(node("h3", t("ログインIDと実名を編集")));
    if (isInitialOwnerNameRegistration(account))
      identity.append(node("p", t("初代統括としての登録を確認した記録です。他の関係者が本人確認した記録ではありません。"), "owner-account-help"));
    if (account.profile_enrollment_pending === true)
      identity.append(node("p", t("本人による関係者情報の登録と案内の確認を完了してから、実名確認を記録してください。"), "owner-account-help"));
    const username = inputField(
      identity,
      t("ログインID"),
      "username",
      "owner-account-username-" + suffix,
    ) as HTMLInputElement;
    username.value = text(account.username);
    username.autocomplete = "username";
    username.autocapitalize = "none";
    username.spellcheck = false;
    username.minLength = 3;
    username.maxLength = 32;
    username.pattern = "[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,31}";
    const realName = inputField(
      identity,
      t("実名"),
      "real_name",
      "owner-account-real-name-" + suffix,
    ) as HTMLInputElement;
    realName.value = text(account.real_name);
    realName.autocomplete = "name";
    // 미완료된 기존 계정은 실명을 아직 등록하지 않았어도 아이디만 정정할 수 있습니다.
    // 이미 등록한 실명을 지우는 동작은 UI와 서버 양쪽에서 계속 막습니다.
    const originalName = text(account.real_name).trim();
    realName.required = Boolean(originalName) || account.profile_enrollment_pending !== true;
    if (
      account.can_edit_real_name === false ||
      (targetUserId === userId && account.name_verified_at)
    ) {
      realName.readOnly = true;
      identity.append(
        node(
          "p",
          t("確認済みの自分の実名は、別の統括に訂正を依頼してください。"),
          "owner-account-help",
        ),
      );
    }
    else if (targetUserId === userId)
      identity.append(
        node(
          "p",
          t("未確認の実名は編集できます。保存しても実名確認済みにはなりません。"),
          "owner-account-help",
        ),
      );
    const confirmsOtherName = () =>
      targetUserId !== userId &&
      account.profile_enrollment_pending !== true &&
      realName.value.trim() !== originalName;
    const nameAckLabel = node(
      "label",
      t(
        "変更後の実名を本人に確認し、実名確認として記録することを確認しました。",
      ),
      "staff-checkbox owner-account-acknowledgment",
    );
    const nameAcknowledgment = node("input");
    nameAcknowledgment.type = "checkbox";
    nameAcknowledgment.name = "name_change_acknowledged";
    nameAckLabel.prepend(nameAcknowledgment);
    nameAckLabel.hidden = true;
    if (targetUserId !== userId && account.profile_enrollment_pending !== true)
      identity.append(
        node(
          "p",
          t(
            "他の関係者の実名を変更すると、あなたを確認者として記録します。変更後の実名を本人に確認してください。",
          ),
          "owner-account-help",
        ),
      );
    identity.append(nameAckLabel);
    realName.addEventListener("input", () => {
      nameAckLabel.hidden = !confirmsOtherName();
      nameAcknowledgment.required = confirmsOtherName();
      nameAcknowledgment.checked = false;
    });
    const identityReason = inputField(
      identity,
      t("変更理由"),
      "reason",
      "owner-account-identity-reason-" + suffix,
      true,
    );
    submit(identity, t("アカウント情報を保存"), "save-identity");
    identity.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || !live() || !identity.reportValidity()) return;
      if (confirmsOtherName() && !nameAcknowledgment.checked) {
        nameAckLabel.hidden = false;
        nameAcknowledgment.required = true;
        showMessage(
          t("変更後の実名を本人に確認してから保存してください。"),
          true,
        );
        nameAcknowledgment.focus();
        return;
      }
      const normalized = username.value.trim().toLowerCase();
      const submittedName = realName.value.trim() || null;
      const submittedReason = identityReason.value.trim();
      if (
        !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized) ||
        (realName.required && !submittedName) ||
        !submittedReason
      ) {
        showMessage(
          t("ログインID・実名・変更理由を確認してください。"),
          true,
          true,
        );
        return;
      }
      const version = sequence;
      busy = true;
      controlsDisabled(true);
      showMessage(t("保存中です。完了までお待ちください。"));
      void (async () => {
        try {
          const result = await client.rpc("office_owner_update_identity", {
            p_user_id: targetUserId,
            p_username: normalized,
            p_real_name: submittedName,
            p_reason: submittedReason,
          });
          if (result.error) throw result.error;
          // 이 RPC는 저장된 계정을 반환합니다. 빈 응답이나 다른 계정 결과를
          // 성공으로 처리하면 이름은 그대로인데 저장됐다는 알림만 남게 됩니다.
          const saved = result.data;
          if (
            !saved ||
            typeof saved !== "object" ||
            Array.isArray(saved) ||
            saved.success === false ||
            saved.user_id !== targetUserId ||
            saved.username !== normalized ||
            !Object.hasOwn(saved, "real_name") ||
            (saved.real_name ?? null) !== submittedName
          )
            throw new Error("identity_save_uncertain");
          if (!live()) return;
          // 이름을 저장한 사실과 확인 완료를 구분합니다. 아이디만 바꿔도 미확인 상태는 그대로입니다.
          notice(saved.name_verified_at
            ? t("アカウント情報を保存しました。")
            : t("アカウント情報を保存しました。実名確認は未完了です。"));
          // 저장 확인과 재조회 실패를 구분하며, 자기 계정의 상단 표시도 따로 갱신합니다.
          // 성공 응답을 바로 그리므로 후속 목록 조회가 실패해도 예전 이름이 남지 않습니다.
          if (visible(version)) renderAccount(saved as Row);
          await ownIdentityChanged();
          await changed();
        } catch (error) {
          if (visible(version))
            showMessage(
              safeIdentityError(
                /^[0-9A-Z]{5}$/.test(errorCode(error))
                  ? error
                  : new Error("identity_save_uncertain"),
              ),
              true,
              true,
            );
        } finally {
          busy = false;
          if (live()) controlsDisabled(false);
        }
      })();
    });
    const password = node("form", "", "staff-form owner-account-form");
    password.dataset.ownerForm = "password";
    password.append(
      node("h3", t("新しいパスワードに再設定")),
      node(
        "p",
        t("パスワードは12文字以上、UTF-8で72バイト以内にしてください。"),
        "owner-account-help",
      ),
    );
    const newPassword = passwordInput(
      password,
      t("新しいパスワード"),
      "password",
    );
    const confirmation = passwordInput(
      password,
      t("パスワードの確認"),
      "password_confirmation",
    );
    const passwordReason = inputField(
      password,
      t("再設定の理由"),
      "reason",
      "owner-account-password-reason-" + suffix,
      true,
    );
    const ackLabel = node(
      "label",
      t(
        "対象アカウントを確認し、本人の依頼に基づくパスワード再設定を行います。",
      ),
      "staff-checkbox owner-account-acknowledgment",
    );
    const acknowledgment = node("input");
    acknowledgment.type = "checkbox";
    acknowledgment.name = "reset_acknowledged";
    acknowledgment.required = true;
    ackLabel.prepend(acknowledgment);
    password.append(ackLabel);
    submit(password, t("パスワードを再設定"), "reset-password");
    if (resetBlocked)
      password.append(
        node(
          "p",
          format(
            "変更結果を確認できません。再設定を繰り返さず、統括に確認してください。操作番号: {0}",
            uncertainOperation,
          ),
          "owner-account-help",
        ),
      );
    password.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement)
        event.target.removeAttribute("aria-invalid");
    });
    password.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || resetBlocked || !live() || !password.reportValidity()) return;
      if (!validNewStaffPassword(newPassword.value)) {
        newPassword.setAttribute("aria-invalid", "true");
        showMessage(
          t("パスワードは12文字以上、UTF-8で72バイト以内にしてください。"),
          true,
        );
        newPassword.focus();
        return;
      }
      if (newPassword.value !== confirmation.value) {
        confirmation.setAttribute("aria-invalid", "true");
        showMessage(t("パスワードが一致しません。"), true);
        confirmation.focus();
        return;
      }
      if (!passwordReason.value.trim() || !acknowledgment.checked) return;
      let secret = newPassword.value;
      let repeated = confirmation.value;
      const reason = passwordReason.value.trim();
      const version = sequence;
      const operationId = crypto.randomUUID();
      clearPasswords();
      busy = true;
      controlsDisabled(true);
      showMessage(
        t("再設定中です。結果が表示されるまで再実行しないでください。"),
      );
      void (async () => {
        let dispatched = false;
        try {
          const session = await client.auth.getSession();
          if (!visible(version)) return;
          const current = session.data?.session;
          if (
            session.error ||
            !current?.access_token ||
            current.user?.id !== userId
          )
            throw new Error("authentication_required");
          dispatched = true;
          const result = (await staffAuthRequest(
            client,
            {
              action: "owner_reset_password",
              operation_id: operationId,
              user_id: targetUserId,
              password: secret,
              password_confirmation: repeated,
              reason,
            },
            current.access_token,
          )) as unknown as Row;
          if (
            result.success !== true ||
            result.operation_id !== operationId ||
            ![
              "owner_password_reset_succeeded",
              "owner_password_reset_already_succeeded",
            ].includes(text(result.code))
          )
            throw new Error("owner_password_reset_uncertain");
          if (!live()) return;
          const replay =
            result.code === "owner_password_reset_already_succeeded";
          notice(
            replay
              ? t(
                  "この操作はすでに処理されています。今回入力したパスワードで再変更していません。",
                )
              : t("新しいパスワードへの再設定を確認しました。"),
          );
          if (targetUserId === userId) {
            closeDialog(false);
            try {
              await client.auth.signOut({ scope: "local" });
            } catch {
              /* 비밀번호 저장 결과와 로그아웃 응답은 구분합니다. */
            }
            notice(
              replay
                ? t(
                    "この操作はすでに処理されています。再変更はしていません。有効なパスワードでログインし直してください。",
                  )
                : t(
                    "自分のパスワードを再設定しました。既存のログインIDと新しいパスワードでログインし直してください。",
                  ),
            );
            return;
          }
          if (visible(version)) await load();
          await changed();
        } catch (error) {
          if (!live()) return;
          const code = errorCode(error);
          const uncertain =
            dispatched &&
            ![
              "owner_password_reset_failed",
              "owner_password_reset_denied",
              "authentication_required",
              "reauthentication_required",
              "invalid_request",
              "rate_limited",
            ].includes(code);
          if (uncertain) {
            resetBlocked = true;
            uncertainOperation = operationId;
            const state = information.querySelector<HTMLElement>(
              "[data-owner-password-state]",
            );
            if (state) state.textContent = t("確認不可");
          }
          const explanation = uncertain
            ? format(
                "変更結果を確認できません。再設定を繰り返さず、統括に確認してください。操作番号: {0}",
                operationId,
              )
            : code === "owner_password_reset_failed"
              ? t(
                  "パスワードを再設定できませんでした。入力条件を確認してから、もう一度お試しください。",
                )
              : code === "reauthentication_required"
                ? t(
                    "ログインし直してからお試しください。多要素認証を設定している場合は、その認証も完了してください。",
                  )
                : code === "rate_limited"
                  ? t(
                      "試行回数が制限されています。少し時間をおいてから再度お試しください。",
                    )
                  : t(
                      "統括の権限を確認できません。この画面を閉じ、ログインし直してください。",
                    );
          notice(explanation, true);
          if (visible(version)) showMessage(explanation, true, true);
        } finally {
          secret = "";
          repeated = "";
          clearPasswords();
          busy = false;
          if (live()) controlsDisabled(false);
        }
      })();
    });
    content.replaceChildren(
      information,
      warning,
      privateReasonHelp,
      identity,
      password,
    );
    controlsDisabled(busy);
  }
  async function load() {
    const version = ++sequence;
    content.replaceChildren(
      node("p", t("アカウント情報を読み込んでいます。"), "owner-account-help"),
    );
    try {
      const account = await readAccount();
      if (!visible(version)) return;
      renderAccount(account);
    } catch (error) {
      if (!visible(version)) return;
      content.replaceChildren();
      const detail =
        error && typeof error === "object" ? text((error as Row).message) : "";
      showMessage(
        detail === "owner_mfa_required"
          ? safeIdentityError(error)
          : t("アカウント情報を取得できません。統括の権限を確認し、画面を開き直してください。"),
        true,
        true,
      );
    }
  }
  trigger.addEventListener("click", () => {
    if (!live() || busy) return;
    showMessage("");
    dialog.showModal();
    message.textContent = "";
    void load();
    heading.focus();
  });
  close.addEventListener("click", () => closeDialog());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener("close", () => {
    sequence++;
    clearPasswords();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const candidates = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ),
    ].filter((item) => !item.hidden && !item.closest("[hidden]"));
    const first = candidates[0];
    const last = candidates.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  const { data: subscription } = client.auth.onAuthStateChange(
    (event, session) => {
      if (
        event === "SIGNED_OUT" ||
        (session?.user?.id && session.user.id !== userId)
      ) {
        invalidated = true;
        closeDialog(false);
      }
    },
  );
  return {
    element,
    dispose() {
      disposed = true;
      closeDialog(false);
      content.replaceChildren();
      subscription.subscription.unsubscribe();
    },
  };
}
