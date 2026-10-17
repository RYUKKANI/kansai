import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffRole } from "../lib/content-types";
import { text as t, format, localizedDate, currentLocale } from "../lib/i18n";
import { renderOwnerAccountManagement } from "./owner-account-management";
import { memberGrades, memberGradeLabel, normalizeMemberGrade } from "../lib/member-grades";
import { roleLabels } from "../lib/admin-ui";
import { isInitialOwnerNameRegistration, staffNameVerificationLabel, staffNameVerifierLabel } from "../lib/staff-name-verification";

// [편집 안내] 관계자 화면은 비공개 매핑 테이블을 직접 읽지 않습니다. RPC가 현재 세션의
// 승인·활동·업무 권한을 매번 확인하고 반환한 최소 정보만 텍스트 노드로 표시합니다.
export type StaffOfficePage =
  "staff_directory" | "staff_applications" | "staff_account" | "staff_audit";
type Row = Record<string, unknown>;
interface Options {
  client: SupabaseClient;
  container: HTMLElement;
  page: StaffOfficePage;
  role: StaffRole;
  userId: string;
  notice: (message: string, error?: boolean) => void;
  isCurrent: () => boolean;
  refresh: () => void | Promise<void>;
}
export interface StaffOfficeController {
  dispose: () => void;
  refresh: () => Promise<void>;
}
let officeInstance = 0;
const roles: StaffRole[] = [...memberGrades];
const roleText = memberGradeLabel;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response");
  return value as Row;
}
function records(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("invalid_response");
  return value.map(record);
}
const string = (value: unknown) => (typeof value === "string" ? value : "");
const valueOrDash = (value: unknown) => string(value) || "—";
const date = (value: unknown) =>
  string(value) ? localizedDate(string(value), currentLocale(), true) : "—";
function state(value: unknown): string {
  return (
    {
      pending: t("承認待ち"),
      approved: t("承認済み"),
      rejected: t("承認見送り"),
      active: t("活動中"),
      inactive: t("活動休止"),
      suspended: t("利用停止"),
      withdrawn: t("取下げ済み"),
    }[String(value) as "pending"] ?? t("未設定")
  );
}
function status(value: string, kind: string): HTMLElement {
  const node = element("span", value, "staff-status");
  node.dataset.kind = kind;
  return node;
}
function note(text: string): HTMLElement {
  return element("p", text, "staff-help");
}
function title(text: string): HTMLElement {
  return element("h2", text, "staff-section-title");
}
function labelValue(label: string, value: string): HTMLElement {
  const item = element("div", "", "staff-detail");
  item.append(element("dt", label), element("dd", value));
  return item;
}
function details(items: [string, string][]): HTMLElement {
  const list = element("dl", "", "staff-details");
  for (const [label, value] of items) list.append(labelValue(label, value));
  return list;
}
function field(
  form: HTMLFormElement,
  label: string,
  name: string,
  options: {
    value?: string;
    required?: boolean;
    multiline?: boolean;
    maxLength?: number;
  } = {},
) {
  const wrap = element("label", label, "staff-field");
  const input = options.multiline ? element("textarea") : element("input");
  input.name = name;
  input.value = options.value ?? "";
  input.required = options.required ?? true;
  input.maxLength = options.maxLength ?? 150;
  if (name === "real_name") input.autocomplete = "name";
  wrap.append(input);
  form.append(wrap);
  return input;
}
function selectRole(
  form: HTMLFormElement,
  name: string,
  current: unknown,
  owner: boolean,
): HTMLSelectElement {
  const label = element("label", t("付与する所属等級"), "staff-field");
  const select = element("select");
  select.name = name;
  for (const role of roles.filter((value) => owner || value !== "owner")) {
    const option = element("option", roleText(role));
    option.value = role;
    select.append(option);
  }
  const grade = normalizeMemberGrade(current);
  select.value = grade && (owner || grade !== "owner") ? grade : "player";
  label.append(select);
  form.append(label);
  return select;
}
function submit(
  form: HTMLFormElement,
  text: string,
  key: string,
): HTMLButtonElement {
  const button = element("button", text, "staff-button");
  button.type = "submit";
  button.dataset.staffAction = key;
  form.append(button);
  return button;
}
function safeError(error: unknown): string {
  const value = error && typeof error === "object" ? (error as Row) : {};
  const raw = string(value.message);
  if (string(value.code) === "response_unconfirmed")
    return t("保存結果を確認できませんでした。一覧を更新して現在の情報を確認してから、再度操作してください。");
  if (raw === "self_verified_name_requires_review")
    return t("確認済みの自分の実名は、別の統括に訂正を依頼してください。");
  if (raw === "owner_mfa_required")
    return t("多要素認証を完了してから、もう一度お試しください。");
  if (raw === "invalid_real_name")
    return t("実名は空白だけにせず、150文字以内で入力してください。");
  if (raw === "identity_change_reason_required")
    return t("変更理由を入力してください。");
  if (/last.*owner|final.*owner/i.test(raw))
    return t("最後の有効な統括は、利用停止や権限の引き下げができません。");
  if (/self|own.*(approv|role|identity)/i.test(raw))
    return t("自分自身の承認・本人確認・権限変更はできません。");
  if (raw === "manual_contact_check_required" || /email.*confirm/i.test(raw))
    return t("実名・ログインID・所属を確認してから承認してください。");
  if (/verif|real.name/i.test(raw))
    return t("先に実名と関係者であることを確認してください。");
  if (/rate|too.many/i.test(raw))
    return t("操作回数が上限に達しました。少し待ってからお試しください。");
  if (
    string(value.code) === "42501" ||
    /permission|denied|active staff/i.test(raw)
  )
    return t(
      "この操作に必要な権限がありません。最新の承認状況を確認してください。",
    );
  return t(
    "操作の完了を確認できません。一覧を更新して現在の状態を確認してください。",
  );
}

// 개인정보를 DB에서 이미 마스킹해도 화면에서 한 번 더 제한합니다. 새 업무 필드를 노출하려면
// 서버 allowlist와 이 목록을 함께 검토해야 합니다. 비밀·연락처·건강 값은 절대 펼치지 않습니다.
const visibleAuditFields = new Set([
  "self_checked_at",
  "title",
  "slug",
  "summary",
  "body",
  "category",
  "status",
  "published_at",
  "featured",
  "activity_date",
  "opponent",
  "competition",
  "home_away",
  "kickoff_at",
  "venue",
  "match_status",
  "own_score",
  "opponent_score",
  "report",
  "starts_at",
  "ends_at",
  "session_status",
  "is_public",
  "public_description",
  "cover_path",
  "cover_alt",
  "gallery_paths",
  "album_id",
  "image_path",
  "video_url",
  "kind",
  "alt",
  "caption",
  "description",
  "player_id",
  "display_name",
  "romanized_name",
  "jersey_number",
  "position",
  "photo_path",
  "bio",
  "display_order",
  "activity_status",
  "profile_consent",
  "photo_consent",
  "approval_status",
  "role",
  "active",
  "real_name",
  "department",
  "verified_at",
  "name_verified_at",
  "name_verified_by",
  "name_verification_source",
  "approved_at",
  "rejected_at",
]);
// 기록의 필드 이름은 업무 화면과 같은 문구로만 바꿔 표시합니다. 공개 허용 목록과 민감 정보 마스킹은 위 규칙을 그대로 따릅니다.
const auditFieldLabels: Record<string, string> = {
  self_checked_at: "本人の出席確認日時",
  title: "タイトル",
  slug: "記事・プロフィールのURL",
  summary: "概要",
  body: "本文",
  category: "カテゴリー",
  status: "公開状態",
  published_at: "掲載日",
  featured: "トップの注目記事にする",
  activity_date: "活動日",
  opponent: "対戦相手",
  competition: "大会名",
  home_away: "ホーム・アウェイ",
  kickoff_at: "キックオフ（日本時間）",
  venue: "会場",
  match_status: "試合の状態",
  own_score: "得点（関西）",
  opponent_score: "得点（相手）",
  report: "試合レポート",
  starts_at: "開始（日本時間）",
  ends_at: "終了（日本時間）",
  session_status: "状態",
  is_public: "公式サイトに日程を公開する",
  public_description: "公開する案内",
  cover_path: "代表写真",
  cover_alt: "写真の説明（代替テキスト）",
  gallery_paths: "記事内の写真",
  album_id: "アルバム",
  image_path: "写真",
  video_url: "動画URL",
  kind: "種類",
  alt: "写真の説明（代替テキスト）",
  caption: "写真のキャプション",
  description: "説明",
  player_id: "選手の識別番号",
  display_name: "公開する名前",
  romanized_name: "ローマ字表記",
  jersey_number: "背番号",
  position: "ポジション",
  photo_path: "プロフィール写真",
  bio: "選手紹介",
  display_order: "表示順（小さい順）",
  activity_status: "活動状態",
  profile_consent: "プロフィールの公開同意を確認済み",
  photo_consent: "写真の公開同意を確認済み",
  approval_status: "承認状況",
  role: "権限",
  active: "利用を許可",
  real_name: "実名",
  department: "所属・担当業務",
  verified_at: "本人確認日時",
  name_verified_at: "実名確認日時",
  name_verified_by: "実名の確認者",
  name_verification_source: "実名確認の方法",
  approved_at: "承認日時",
  rejected_at: "見送り日時",
};
const forbiddenField =
  /password|token|secret|key|email|phone|address|health|medical|injur|contact|notes|metadata/i;
function auditValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string")
    return value.length > 500 ? value.slice(0, 500) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return t("複合データを変更");
}
function auditFieldValue(name: string, value: unknown): string {
  if (name === "name_verification_source") {
    if (value === "initial_owner_setup") return t("初代統括の登録確認");
    if (value === "staff_review") return t("関係者による実名確認");
    return "—";
  }
  return auditValue(value);
}
export function staffAuditActor(row: Row): string {
  const source = string(row.source);
  if (source === "initial_owner_setup") return t("初代統括の登録設定");
  if (source === "scheduled") return t("予約処理");
  if (source === "system_support") return t("管理者支援 / 実行者確認不可");
  if (source === "database_unattributed")
    return t("DB直接操作 / 実行者確認不可");
  if (source === "legacy_unknown") return t("以前の記録 / 作業者確認不可");
  // 과거 로그를 현재 명부의 이름으로 덮어 쓰거나 미확인 이름을 승인된 실명처럼 표시하지 않습니다.
  if (row.actor_name_status === "verified" && string(row.actor_name))
    return string(row.actor_name);
  return ["human", "owner_password_reset"].includes(source) && string(row.actor_id)
    ? t("実名確認前のアカウント")
    : t("以前の記録 / 作業者確認不可");
}
function auditAction(row: Row): string {
  const value = string(row.action || row.operation).toLowerCase();
  const labels: Record<string, string> = {
    insert: t("作成"),
    update: t("変更"),
    delete: t("削除"),
    training_self_checked_in: t("本人による出席チェック"),
    training_attendance_changed: t("練習出席の変更"),
    chat_message_removed: t("チャットメッセージの削除"),
    publish: t("公開"),
    unpublish: t("公開取消"),
    support_password_reset_requested: t("パスワード支援の受付"),
    support_password_reset_succeeded: t("パスワード支援の完了"),
    support_password_reset_failed: t("パスワード支援の失敗"),
    support_password_reset_indeterminate: t("パスワード支援の結果未確認"),
    owner_identity_updated: t("統括によるID・実名の変更"),
    owner_password_reset_requested: t("統括によるパスワード再設定の受付"),
    owner_password_reset_succeeded: t("統括によるパスワード再設定の完了"),
    owner_password_reset_failed: t("統括によるパスワード再設定の失敗"),
    owner_password_reset_uncertain: t("統括によるパスワード再設定の結果未確認"),
    application_approved: t("加入申請の承認"),
    application_rejected: t("加入申請の見送り"),
    access_changed: t("権限・アクセスの変更"),
    player_link_changed: t("選手情報との紐付けを変更"),
    identity_verified: t("実名の確認"),
    initial_owner_identity_initialized: t("初代統括の登録を確定"),
    name_change_requested: t("実名訂正の申請"),
    name_change_approved: t("実名訂正の承認"),
    name_change_rejected: t("実名訂正の見送り"),
    unverified_name_updated: t("未確認の実名を変更"),
    name_request_withdrawn: t("実名訂正の申請を取下げ"),
  };
  return labels[value] ?? valueOrDash(row.action || row.operation);
}
function auditEntity(value: unknown): string {
  const labels: Record<string, string> = {
    articles: t("ニュース"),
    players: t("選手情報"),
    public_player_profiles: t("公開プロフィール"),
    fixtures: t("試合"),
    training_sessions: t("練習"),
    attendance: t("練習出席"),
    office_chat_messages: t("チームチャット"),
    training_series: t("定期練習"),
    match_events: t("試合記録"),
    club_events: t("クラブ行事"),
    media_assets: t("写真・動画"),
    media_albums: t("アルバム"),
    site_pages: t("クラブ情報"),
    staff_accounts: t("関係者アカウント"),
    staff_name_requests: t("実名訂正"),
    admin_roles: t("運営権限"),
  };
  return labels[string(value)] ?? valueOrDash(value);
}
export function renderStaffAuditEntry(row: Row): HTMLElement {
  const card = element("article", "", "staff-audit-entry");
  const header = element("div", "", "staff-card-heading");
  header.append(
    element("strong", staffAuditActor(row)),
    element("time", date(row.occurred_at)),
  );
  const time = header.querySelector("time");
  if (time && string(row.occurred_at)) time.dateTime = string(row.occurred_at);
  const source = string(row.source);
  card.append(
    header,
    details([
      [t("作業者のアカウント識別番号"), valueOrDash(row.actor_id)],
      [t("作業時の権限"), roleLabels[string(row.actor_role)] ?? roleText(row.actor_role)],
      [t("実行主体"), valueOrDash(row.executor)],
      [
        t("処理区分"),
        source === "owner_password_reset"
          ? t("統括によるアカウント管理")
          : source === "initial_owner_setup"
          ? t("初代統括の登録設定")
          : source === "human"
          ? t("認証済みアカウントの操作")
          : source === "system_support"
            ? t("管理者支援 / 実行者確認不可")
          : source === "scheduled"
            ? t("予約処理")
            : source === "database_unattributed"
              ? t("DB直接操作 / 実行者確認不可")
              : t("確認不可"),
      ],
      [t("操作"), auditAction(row)],
      [t("対象"), auditEntity(row.entity)],
      [t("対象ID"), valueOrDash(row.record_id)],
    ]),
  );
  if (string(row.requested_by))
    card.append(
      note(format("確認済みの依頼者の識別番号: {0}", string(row.requested_by))),
    );
  if (string(row.reason))
    card.append(note(format("理由: {0}", string(row.reason))));
  const fields = Array.isArray(row.changed_fields)
    ? row.changed_fields.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (fields.length) {
    const list = element("ul", "", "staff-audit-fields");
    const before =
      row.before_values &&
      typeof row.before_values === "object" &&
      !Array.isArray(row.before_values)
        ? (row.before_values as Row)
        : {};
    const after =
      row.after_values &&
      typeof row.after_values === "object" &&
      !Array.isArray(row.after_values)
        ? (row.after_values as Row)
        : {};
    for (const name of fields) {
      const item = element("li");
      if (!visibleAuditFields.has(name) || forbiddenField.test(name)) {
        item.textContent = t("非公開項目を変更（値は表示しません）");
      } else {
        const attendanceStatus = name === "status" && row.entity === "attendance";
        item.append(element("strong", t(attendanceStatus ? "出席状況" : auditFieldLabels[name] ?? name)));
        const fieldValue = (value: unknown) => attendanceStatus
          ? t(({ present: "出席", late: "遅刻", absent: "欠席", excused: "公欠" } as Record<string, string>)[string(value)] ?? "未記録")
          : auditFieldValue(name, value);
        if (Object.hasOwn(before, name) || Object.hasOwn(after, name)) {
          item.append(
            element(
              "span",
              format(
                "{0} → {1}",
                fieldValue(before[name]),
                fieldValue(after[name]),
              ),
            ),
          );
        } else item.append(element("span", t("項目を変更")));
      }
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

export async function renderStaffOffice(
  options: Options,
): Promise<StaffOfficeController> {
  const { client, container, page, userId, notice } = options;
  let disposed = false;
  let sequence = 0;
  let busy = false;
  const instance = ++officeInstance;
  // 검색어와 선택은 화면 상태이며 권한의 근거가 아닙니다. 저장 후 이름이 바뀌어도 UUID로 선택을 유지합니다.
  let memberSearchQuery = "";
  let hasMemberSearch = false;
  let selectedMemberId = "";
  let managementRevision = 0;
  let syncMemberNavigation: (() => void) | null = null;
  // 대화창이 닫히거나 업무 화면·계정이 바뀌면 비밀번호 입력과 Auth 구독도 폐기합니다.
  const accountWindows: { dispose: () => void }[] = [];
  function disposeAccountWindows() {
    for (const window of accountWindows.splice(0)) window.dispose();
  }
  const current = () => !disposed && options.isCurrent();
  async function rpc(name: string, args: Row = {}): Promise<unknown> {
    const result = await client.rpc(name, args);
    if (result.error) throw result.error;
    // void RPC의 확정 응답은 null입니다. 빈 배열·거짓 성공 응답을 저장 완료로 표시하지 않습니다.
    if (["office_request_name_change", "office_verify_staff_identity", "office_review_staff",
      "office_set_staff_access", "office_review_name_change"].includes(name) && result.data !== null)
      throw { code: "response_unconfirmed" };
    return result.data;
  }
  function formAction(
    form: HTMLFormElement,
    operation: () => Promise<unknown>,
    success: string,
    isFormCurrent: () => boolean = current,
  ) {
    const localNotice = element("p", "", "staff-form-notice");
    localNotice.setAttribute("role", "status");
    localNotice.setAttribute("aria-live", "polite");
    form.append(localNotice);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || !isFormCurrent() || !form.isConnected || !form.reportValidity()) return;
      busy = true;
      syncMemberNavigation?.();
      const controls = [
        ...form.querySelectorAll<
          | HTMLInputElement
          | HTMLButtonElement
          | HTMLSelectElement
          | HTMLTextAreaElement
        >("input,button,select,textarea"),
      ];
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => {
        control.disabled = true;
      });
      form.setAttribute("aria-busy", "true");
      localNotice.textContent = t("保存中です。完了までお待ちください。");
      void (async () => {
        try {
          await operation();
          if (!isFormCurrent()) return;
          notice(success);
          // DB 확정 뒤 화면 재조회가 실패해도, 이미 저장한 변경을 실패라고 되돌려 안내하지 않습니다.
          try {
            await load(page === "staff_applications");
            if (current()) await options.refresh();
          } catch {
            if (current()) notice(t("変更は保存されましたが、アカウント表示を更新できませんでした。画面を再読み込みしてください。"), true);
          }
        } catch (error) {
          if (!isFormCurrent()) return;
          localNotice.textContent = safeError(error);
          localNotice.dataset.error = "true";
          notice(safeError(error), true);
        } finally {
          busy = false;
          syncMemberNavigation?.();
          controls.forEach((control, index) => {
            control.disabled = disabled[index] ?? false;
          });
          form.removeAttribute("aria-busy");
          if (isFormCurrent() && form.isConnected && localNotice.dataset.error === "true")
            form.querySelector<HTMLElement>("button[type=submit]")?.focus();
        }
      })();
    });
  }
  function ownState(account: Row, only = false): HTMLElement {
    const section = element("section", "", "staff-card");
    section.dataset.nameVerificationSource = string(account.name_verification_source);
    section.append(
      title(t("自分の申請とアカウント")),
      details([
        [t("アカウント識別番号"), string(account.user_id) || userId],
        [t("ログインID"), valueOrDash(account.login_id ?? account.username)],
        [t("実名"), valueOrDash(account.real_name)],
        [t("所属等級"), roleText(account.member_grade ?? account.role)],
        [t("担当業務"), valueOrDash(account.department)],
        [t("承認状況"), state(account.approval_status)],
        [t("活動状態"), account.active === true ? t("活動中") : t("利用停止")],
        [t("現在の権限"), roleText(account.role)],
        [t("本人確認"), staffNameVerificationLabel(account)],
        [t("確認者"), staffNameVerifierLabel(account)],
        [t("確認日時"), date(account.verified_at ?? account.name_verified_at)],
      ]),
    );
    if (isInitialOwnerNameRegistration(account))
      section.append(note(t("初代統括としての登録を確認した記録です。他の関係者が本人確認した記録ではありません。")));
    section.append(
      note(
        t(
          "内部の実名登録と、公開ホームページへの名前・写真の掲載同意は別の手続きです。",
        ),
      ),
    );
    if (only) {
      section.append(
        note(
          t(
            "運営責任者の承認後にご利用いただけます。承認前は自分の承認状況のみ確認できます。",
          ),
        ),
      );
      return section;
    }
    section.append(note(t("実名とログインIDは別の情報です。実名の確認状態は、表示名や権限とは別に管理します。")));
    if (account.profile_enrollment_pending === true || account.identity_enrolled === false)
      section.append(note(t("関係者情報の登録と案内の確認が未完了です。登録を完了しても、現在のアカウントと権限は変わりません。")));
    if (account.name_edit_mode === "unverified_edit") {
      // 미확인 이름의 수정은 본인 확인 승인이 아닙니다. 확인된 이름의 변경은 별도로 심사합니다.
      section.append(title(t("未確認の実名を編集")), note(t("未確認の実名は編集できます。保存しても実名確認済みにはなりません。")));
      const form = element("form", "", "staff-form");
      const name = field(form, t("実名"), "real_name", { value: string(account.real_name), maxLength: 150 });
      const reason = field(form, t("変更理由"), "reason", { multiline: true, maxLength: 500 });
      submit(form, t("実名を保存"), "update-unverified-name");
      formAction(form, async () => {
        const updated = record(await rpc("office_update_unverified_name", {
          p_real_name: name.value.normalize("NFC").trim(), p_reason: reason.value.trim(),
        }));
        if (updated.success === false || updated.user_id !== userId || updated.real_name !== name.value.normalize("NFC").trim()
          || updated.active !== true || updated.approval_status !== "approved"
          || updated.approved_real_name != null || updated.name_verified_at != null
          || updated.name_verified_by != null
          || updated.name_edit_mode !== "unverified_edit") throw { code: "response_unconfirmed" };
      }, t("実名を保存しました。実名確認は別途必要です。"));
      section.append(form);
    } else if (account.name_edit_mode === "review_required" || account.name_verified_at) {
    section.append(
      note(
        t(
          "確認済みの実名を変更する場合は、正しい氏名と理由を入力して訂正を申請してください。過去の作業記録とアカウントのつながりは維持されます。",
        ),
      ),
    );
    const form = element("form", "", "staff-form");
    const name = field(form, t("訂正後の実名"), "real_name", {
      value: string(account.real_name),
      maxLength: 150,
    });
    const reason = field(form, t("訂正理由"), "reason", {
      multiline: true,
      maxLength: 500,
    });
    submit(form, t("実名の訂正を申請"), "request-name");
    formAction(
      form,
      () =>
        rpc("office_request_name_change", {
          p_real_name: name.value.trim(),
          p_reason: reason.value.trim(),
        }),
      t("実名の訂正を申請しました。承認まで現在の確認済み氏名を使用します。"),
    );
    section.append(form);
    } else {
      section.append(note(t("実名の編集可否を確認できません。再読み込みして現在の状態を確認してください。")));
    }
    const requests =
      account.name_request && typeof account.name_request === "object"
        ? [record(account.name_request)]
        : [];
    for (const request of requests)
      section.append(
        note(
          format(
            "実名訂正: {0} / {1}",
            valueOrDash(request.requested_real_name ?? request.real_name),
            state(request.status),
          ),
        ),
      );
    return section;
  }
  function directory(rows: Row[]): HTMLElement {
    const section = element("section", "", "staff-directory");
    section.append(
      title(t("関係者名簿")),
      note(
        t(
          "承認された関係者の実名・担当業務・活動状態を表示します。氏名は翻訳しません。",
        ),
      ),
    );
    if (!rows.length) section.append(note(t("表示できる関係者はいません。")));
    for (const member of rows) {
      const card = element("article", "", "staff-card");
      const header = element("div", "", "staff-card-heading");
      header.append(
        element("h3", valueOrDash(member.real_name)),
        status(
          member.activity_status === "inactive" ? t("活動休止") : t("活動中"),
          member.activity_status === "inactive" ? "inactive" : "active",
        ),
      );
      card.append(header, element("p", roleText(member.member_grade ?? member.role)), element("p", valueOrDash(member.department)));
      section.append(card);
    }
    return section;
  }
  function management(
    rows: Row[],
    requests: Row[],
    owner: boolean,
    players: Row[],
  ): HTMLElement {
    const section = element("section", "", "staff-management member-search");
    const viewToken = sequence;
    const isManagementCurrent = () => current() && sequence === viewToken && section.isConnected;
    const members = rows.filter((member) => string(member.user_id));
    const header = element("header", "", "member-search-header");
    header.append(title(t("メンバー管理")), note(t("一覧から管理するアカウントを選択してください。ログインIDまたは実名で絞り込めます。")));
    const search = element("form", "", "member-search-form");
    search.setAttribute("role", "search");
    search.setAttribute("aria-label", t("メンバーを検索"));
    const searchLabel = element("label", "", "staff-field member-search-field");
    searchLabel.append(element("span", t("ログインID・実名")));
    const input = element("input");
    input.type = "search";
    input.name = "member_query";
    input.value = memberSearchQuery;
    input.placeholder = t("ログインIDまたは実名を入力");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 150;
    input.setAttribute("enterkeyhint", "search");
    searchLabel.append(input);
    const actions = element("div", "", "member-search-actions");
    const searchButton = element("button", t("検索"), "staff-button member-search-submit");
    searchButton.type = "submit";
    searchButton.dataset.memberSearchAction = "search";
    const clearButton = element("button", t("クリア"), "staff-button member-search-clear");
    clearButton.type = "button";
    clearButton.dataset.memberSearchAction = "clear";
    actions.append(searchButton, clearButton);
    search.append(searchLabel, actions);
    const results = element("section", "", "member-search-results");
    const resultsHeading = element("div", "", "member-search-results-heading");
    const resultsTitle = element("h3", t("メンバー一覧"));
    resultsTitle.id = `member-search-results-title-${instance}`;
    results.setAttribute("aria-labelledby", resultsTitle.id);
    const resultStatus = element("p", "", "member-search-status");
    resultStatus.setAttribute("role", "status");
    resultStatus.setAttribute("aria-live", "polite");
    resultStatus.setAttribute("aria-atomic", "true");
    resultsHeading.append(resultsTitle, resultStatus);
    const columns = element("div", "", "member-list-columns");
    columns.setAttribute("aria-hidden", "true");
    for (const label of [t("実名"), t("ログインID"), t("所属等級"), t("承認状況")])
      columns.append(element("span", label));
    let matchingCount = 0;
    const resultList = element("ul", "", "member-search-results-list");
    const empty = element("p", t("一致するアカウントがありません。ログインIDまたは実名を確認してください。"), "member-search-guidance");
    results.append(resultsHeading, columns, resultList, empty);
    const workspaceHost = element("div", "", "member-workspace-host");
    section.append(header, search, results, workspaceHost);

    // 검색은 정규화한 사본으로만 수행합니다. 실제 표시 이름·아이디는 RPC 원문을 유지하고,
    // 이름이 같아도 선택과 모든 변경 요청은 변하지 않는 계정 UUID로만 연결합니다.
    const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
    function resetWorkspace() {
      // 닫힌 계정 폼의 지연 응답은 새로 선택한 계정의 알림·초점·재조회를 바꾸지 못합니다.
      ++managementRevision;
      disposeAccountWindows();
      workspaceHost.replaceChildren();
    }
    function renderWorkspace(focus = false) {
      resetWorkspace();
      const member = members.find((value) => string(value.user_id) === selectedMemberId);
      if (!member) {
        selectedMemberId = "";
        return;
      }
      const revision = managementRevision;
      const target = selectedMemberId;
      const isWorkspaceCurrent = () => current() && sequence === viewToken &&
        managementRevision === revision && selectedMemberId === target;
      const workspace = managementWorkspace(member, requests, owner, players, isWorkspaceCurrent, () => {
        selectedMemberId = "";
        resetWorkspace();
        for (const button of resultList.querySelectorAll<HTMLButtonElement>("[data-member-target]"))
          button.setAttribute("aria-pressed", "false");
        const resultButton = [...resultList.querySelectorAll<HTMLButtonElement>("[data-member-target]")]
          .find((button) => button.dataset.memberTarget === target);
        (resultButton ?? input).focus();
      });
      workspaceHost.append(workspace);
      syncNavigation();
      if (focus) workspace.querySelector<HTMLElement>(".member-workspace-title")?.focus();
    }
    function syncNavigation() {
      // 업무 저장의 결과를 확인하기 전에 다른 계정으로 이동하지 않게 합니다.
      // 화면이 외부에서 폐기되는 경우에도 아래 선택 revision 검사가 지연 응답을 차단합니다.
      const controls = [input, searchButton, clearButton,
        ...resultList.querySelectorAll<HTMLButtonElement>("[data-member-target]"),
        ...workspaceHost.querySelectorAll<HTMLButtonElement>("[data-member-search-action=close], .owner-account-trigger")];
      for (const control of controls) control.disabled = busy;
      resultStatus.textContent = busy ? t("保存中です。完了までお待ちください。") :
        format(hasMemberSearch ? "検索結果: {0}件" : "全{0}件", String(matchingCount));
    }
    syncMemberNavigation = syncNavigation;
    function renderResults() {
      const query = normalized(memberSearchQuery);
      // 처음부터 전체 목록을 표시하고 검색은 그 목록을 좁히는 용도로만 사용합니다.
      // 빈 검색·초기화는 전체 목록으로 돌아가며 관리 폼은 계정을 선택할 때만 만듭니다.
      const matches = query ? members.filter((member) =>
        normalized(string(member.login_id ?? member.username)).includes(query) ||
        normalized(string(member.real_name)).includes(query)) : members;
      resultsTitle.textContent = t(hasMemberSearch ? "検索結果" : "メンバー一覧");
      matchingCount = matches.length;
      resultList.replaceChildren();
      empty.hidden = matches.length > 0;
      empty.textContent = t(hasMemberSearch
        ? "一致するアカウントがありません。ログインIDまたは実名を確認してください。"
        : "表示できるメンバーはいません。");
      columns.hidden = matches.length === 0;
      for (const member of matches) {
        const id = string(member.user_id);
        const item = element("li", "", "member-result-item");
        const button = element("button", "", "member-result");
        button.type = "button";
        button.dataset.memberTarget = id;
        button.setAttribute("aria-pressed", String(id === selectedMemberId));
        button.append(
          element("span", string(member.real_name) || t("実名未登録"), "member-result-name"),
          element("span", valueOrDash(member.login_id ?? member.username), "member-result-id"),
          element("span", roleText(member.member_grade ?? member.role), "member-result-meta"),
          status(state(member.approval_status), string(member.approval_status)),
        );
        const openMark = element("span", "›", "member-result-open");
        openMark.setAttribute("aria-hidden", "true");
        button.append(openMark);
        button.addEventListener("click", () => {
          if (busy || !isManagementCurrent()) return;
          selectedMemberId = id;
          for (const result of resultList.querySelectorAll<HTMLButtonElement>("[data-member-target]"))
            result.setAttribute("aria-pressed", String(result.dataset.memberTarget === id));
          renderWorkspace(true);
        });
        item.append(button);
        resultList.append(item);
      }
      syncNavigation();
    }
    function newSearch(clear = false) {
      if (busy || !isManagementCurrent()) return;
      selectedMemberId = "";
      resetWorkspace();
      memberSearchQuery = clear ? "" : input.value.normalize("NFC").trim().replace(/\s+/gu, " ");
      hasMemberSearch = Boolean(memberSearchQuery);
      input.value = memberSearchQuery;
      renderResults();
      if (clear || !hasMemberSearch) input.focus();
    }
    search.addEventListener("submit", (event) => {
      event.preventDefault();
      newSearch();
    });
    clearButton.addEventListener("click", () => newSearch(true));
    // 기존 UUID가 조회 결과에서 사라지면 오래된 권한·폼을 다시 열지 않습니다.
    if (!members.some((member) => string(member.user_id) === selectedMemberId)) selectedMemberId = "";
    renderResults();
    renderWorkspace();
    return section;
  }
  function managementWorkspace(
    member: Row,
    requests: Row[],
    owner: boolean,
    players: Row[],
    isWorkspaceCurrent: () => boolean,
    close: () => void,
  ): HTMLElement {
    const section = element("section", "", "member-workspace");
    section.dataset.memberWorkspace = string(member.user_id);
    const heading = element("h3", t("アカウント管理"), "member-workspace-title");
    heading.id = `member-workspace-title-${instance}`;
    heading.tabIndex = -1;
    section.setAttribute("aria-labelledby", heading.id);
    const header = element("header", "", "member-workspace-heading");
    const closeButton = element("button", t("一覧に戻る"), "staff-button member-workspace-close");
    closeButton.type = "button";
    closeButton.dataset.memberSearchAction = "close";
    closeButton.addEventListener("click", () => {
      if (!busy && isWorkspaceCurrent()) close();
    });
    header.append(heading, closeButton);
    section.append(header, note(t("希望する所属は申請内容です。実際の所属等級は統括が承認時に設定します。自分自身の承認・本人確認・所属等級の変更はできません。")));
    {
      const id = string(member.user_id);
      const self = id === userId;
      const incompleteProfile = member.profile_enrollment_pending === true ||
        member.identity_enrolled === false || !string(member.real_name).trim();
      const card = element("article", "", "staff-card member-workspace-summary");
      card.dataset.staffId = id;
      card.dataset.nameVerificationSource = string(member.name_verification_source);
      const header = element("div", "", "staff-card-heading");
      header.append(
        element("h4", valueOrDash(member.real_name)),
        status(state(member.approval_status), string(member.approval_status)),
      );
      card.append(
        header,
        details([
          [t("ログインID"), valueOrDash(member.login_id ?? member.username)],
          [t("担当業務"), valueOrDash(member.department)],
          [t("希望する所属"), roleText(member.requested_grade)],
          [t("所属等級"), roleText(member.member_grade ?? member.role)],
          [t("活動状態"), member.active === true ? t("活動中") : t("利用停止")],
          [t("アカウント識別番号"), id || "—"],
          [t("本人確認"), staffNameVerificationLabel(member)],
          [t("確認者"), staffNameVerifierLabel(member)],
          [t("確認日時"), date(member.verified_at ?? member.name_verified_at)],
        ]),
      );
      if (isInitialOwnerNameRegistration(member))
        card.append(note(t("初代統括としての登録を確認した記録です。他の関係者が本人確認した記録ではありません。")));
      // 가입·승인은 아이디·실명·소속으로 심사합니다. 기존 연락처와 내부 인증 주소는 표시하지 않습니다.
      if (self)
        card.append(
          note(t("自分自身の承認・本人確認・権限変更は、別の統括に依頼してください。")),
        );
      else if (
        id &&
        owner
      ) {
        // 미완료 레거시 프로필은 DB 제약상 실명 확인을 기록할 수 없습니다.
        // 먼저 본인이 안내 확인을 마치도록 안내하고 실행 불가능한 양식은 표시하지 않습니다.
        if (member.approval_status === "approved" && !member.name_verified_at && incompleteProfile)
          card.append(note(t("本人による関係者情報の登録と案内の確認を完了してから、実名確認を記録してください。")));
        if (member.approval_status === "approved" && (!member.name_verified_at || isInitialOwnerNameRegistration(member)) && !incompleteProfile) {
          const verify = element("form", "", "staff-form");
          verify.append(element("h4", t("実名と関係者であることを確認")));
          const realName = field(verify, t("確認した実名"), "real_name", {
            value: string(member.real_name),
          });
          const verifyReason = field(verify, t("確認根拠・理由"), "reason", {
            multiline: true,
            maxLength: 500,
          });
          submit(verify, t("本人確認を記録"), "verify");
          formAction(
            verify,
            () =>
              rpc("office_verify_staff_identity", {
                p_user_id: id,
                p_real_name: realName.value.trim(),
                p_reason: verifyReason.value.trim(),
              }),
            t("実名と関係者の確認を記録しました。"),
            isWorkspaceCurrent,
          );
          card.append(verify);
        }
        if (member.approval_status === "pending") {
          const manual = member.email_confirmation_required === false || member.email_verification_status === "not_required";
          const approval = element("form", "", "staff-form");
          approval.append(element("h4", t("加入申請を審査")));
          const role = selectRole(approval, "role", "player", owner);
          const choiceLabel = element("label", t("審査結果"), "staff-field");
          const choice = element("select");
          choice.name = "decision";
          for (const [value, label] of [
            ["approved", t("承認")],
            ["rejected", t("承認しない")],
          ] as const) {
            if (manual && !owner && value === "approved") continue;
            const option = element("option", label);
            option.value = value;
            choice.append(option);
          }
          choiceLabel.append(choice);
          approval.append(choiceLabel);
          const confirmationLabel = element(
            "label",
            t("実名・ログインID・関係者であることを確認しました。"),
            "staff-checkbox",
          );
          const confirmed = element("input");
          confirmed.type = "checkbox";
          confirmed.name = "identity_confirmed";
          confirmed.required = choice.value === "approved";
          confirmationLabel.prepend(confirmed);
          approval.append(confirmationLabel);
          const reason = field(approval, t("審査理由"), "reason", {
            multiline: true,
            maxLength: 500,
          });
          const save = submit(approval, t("審査結果を保存"), "review");
          const updateDecision = () => {
            confirmed.required = choice.value === "approved";
            confirmationLabel.hidden = !confirmed.required;
            save.disabled = busy;
          };
          updateDecision();
          choice.addEventListener("change", updateDecision);
          formAction(
            approval,
            () => {
              if (choice.value === "approved" && !confirmed.checked)
                throw new Error("manual_contact_check_required");
              return rpc("office_review_staff", {
                p_user_id: id,
                p_decision: choice.value,
                p_role: role.value,
                p_reason: reason.value.trim(),
              });
            },
            t("加入申請の審査結果を保存しました。"),
            isWorkspaceCurrent,
          );
          card.append(approval);
        } else if (
          ["approved", "suspended"].includes(string(member.approval_status))
        ) {
          const access = element("form", "", "staff-form");
          access.append(element("h4", t("権限とアクセスを管理")));
          const role = selectRole(access, "role", member.role, owner);
          const activityLabel = element(
            "label",
            t("利用を許可"),
            "staff-checkbox",
          );
          const active = element("input");
          active.type = "checkbox";
          active.name = "active";
          active.checked = member.active === true;
          activityLabel.prepend(active);
          access.append(activityLabel);
          const reason = field(access, t("変更理由"), "reason", {
            multiline: true,
            maxLength: 500,
          });
          submit(access, t("権限とアクセスを保存"), "access");
          formAction(
            access,
            () =>
              rpc("office_set_staff_access", {
                p_user_id: id,
                p_role: role.value,
                p_active: active.checked,
                p_reason: reason.value.trim(),
              }),
            t(
              "権限とアクセスを更新しました。既存のセッションにも適用されます。",
            ),
            isWorkspaceCurrent,
          );
          card.append(access);
        }
      }
      if (owner && id && ["approved", "suspended"].includes(string(member.approval_status)) &&
          (normalizeMemberGrade(member.member_grade ?? member.role) === "player" || member.player_id)) {
        // 계정 UUID와 선수 UUID는 별개입니다. 총괄이 기존 선수만 선택하며 가입 시 선수를 만들지 않습니다.
        const link = element("form", "", "staff-form");
        link.append(element("h4", t("選手情報との紐付け")), note(t("本人の選手情報だけを閲覧できるよう、既存の選手を選択してください。新しい選手は作成されません。")));
        const label = element("label", t("紐付ける選手"), "staff-field");
        const choice = element("select");
        choice.name = "player_id";
        const empty = element("option", t("紐付けなし"));
        empty.value = "";
        choice.append(empty);
        for (const player of players) {
          const option = element("option", `${valueOrDash(player.internal_name)} (${string(player.id)})`);
          option.value = string(player.id);
          choice.append(option);
        }
        choice.value = string(member.player_id);
        label.append(choice);
        link.append(label);
        const reason = field(link, t("変更理由"), "reason", { multiline: true, maxLength: 500 });
        submit(link, t("選手の紐付けを保存"), "player-link");
        formAction(link, async () => {
          const updated = record(await rpc("office_owner_set_player_link", {
            p_user_id: id, p_player_id: choice.value || null, p_reason: reason.value.trim(),
          }));
          if (updated.user_id !== id || (updated.player_id ?? null) !== (choice.value || null)) throw { code: "response_unconfirmed" };
        }, t("選手情報との紐付けを保存しました。"), isWorkspaceCurrent);
        card.append(link);
      }
      if (owner && id) {
        const accountWindow = renderOwnerAccountManagement({
          client, userId, targetUserId: id, isCurrent: isWorkspaceCurrent, notice,
          onOwnIdentityChanged: options.refresh,
          onChanged: async () => {
            if (!isWorkspaceCurrent()) return;
            await load(true);
            if (current()) await options.refresh();
          },
        });
        accountWindows.push(accountWindow);
        card.append(accountWindow.element);
      }
      section.append(card);
    }
    const memberRequests = requests.filter((row) => string(row.user_id) === string(member.user_id));
    const corrections = element("section", "", "staff-name-requests member-workspace-corrections");
    corrections.append(element("h4", t("実名訂正の申請"), "staff-section-title"));
    if (!memberRequests.length)
      corrections.append(note(t("審査待ちの実名訂正はありません。")));
    for (const request of memberRequests) {
      const card = element("article", "", "staff-card");
      card.append(
        details([
          [t("現在の実名"), valueOrDash(request.current_real_name)],
          [
            t("訂正後の実名"),
            valueOrDash(request.requested_real_name ?? request.real_name),
          ],
          [t("訂正理由"), valueOrDash(request.reason)],
          [t("申請日時"), date(request.created_at)],
          [t("アカウント識別番号"), valueOrDash(request.user_id)],
          [t("承認状況"), state(request.status)],
        ]),
      );
      if (request.status !== "pending") {
        if (string(request.review_reason))
          card.append(note(format("理由: {0}", string(request.review_reason))));
      } else if (string(request.user_id) === userId)
        card.append(note(t("自分自身の訂正申請は承認できません。")));
      else {
        const form = element("form", "", "staff-form");
        const resultLabel = element("label", t("審査結果"), "staff-field");
        const result = element("select");
        result.name = "approve";
        for (const [value, label] of [
          ["true", t("承認")],
          ["false", t("承認しない")],
        ] as const) {
          const option = element("option", label);
          option.value = value;
          result.append(option);
        }
        resultLabel.append(result);
        form.append(resultLabel);
        const reason = field(form, t("審査理由"), "reason", {
          multiline: true,
          maxLength: 500,
        });
        submit(form, t("訂正の審査結果を保存"), "review-name");
        formAction(
          form,
          () =>
            rpc("office_review_name_change", {
              p_request_id: request.id,
              p_approve: result.value === "true",
              p_reason: reason.value.trim(),
            }),
          t(
            "実名訂正の審査結果を保存しました。過去の作業記録とアカウントのつながりは維持されます。",
          ),
          isWorkspaceCurrent,
        );
        card.append(form);
      }
      corrections.append(card);
    }
    section.append(corrections);
    return section;
  }
  async function load(focusSelected = false) {
    const token = ++sequence;
    if (!current()) return;
    ++managementRevision;
    syncMemberNavigation = null;
    disposeAccountWindows();
    container.setAttribute("aria-busy", "true");
    container.replaceChildren(note(t("関係者情報を読み込んでいます。")));
    try {
      const account = record(await rpc("office_account_state"));
      if (account.user_id !== userId) throw { code: "response_unconfirmed" };
      if (normalizeMemberGrade(account.role) === "player" && page !== "staff_account") throw { code: "42501" };
      if (!current() || token !== sequence) return;
      const approved =
        account.approval_status === "approved" && account.active === true;
      let view: HTMLElement;
      if (!approved || page === "staff_account") {
        selectedMemberId = "";
        view = ownState(account, !approved);
      }
      else if (page === "staff_directory")
        view = directory(records(await rpc("office_staff_directory")));
      else if (page === "staff_applications") {
        const role = string(account.role);
        if (role !== "owner") throw { code: "42501" };
        const [members, requests, players] = await Promise.all([
          rpc("office_staff_applications"),
          rpc("office_staff_name_requests"),
          client.from("players").select("id,internal_name").order("internal_name"),
        ]);
        if (players.error) throw players.error;
        if (!current() || token !== sequence) return;
        view = management(
          records(members),
          records(requests),
          role === "owner",
          records(players.data),
        );
      } else {
        const data = await rpc("office_staff_audit", { p_limit: 100 });
        view = element("section", "", "staff-audit");
        view.append(
          title(t("実名の作業履歴")),
          note(
            t(
              "業務権限の範囲でサーバーが確認した履歴のみ表示します。自動処理の実行主体と依頼者は分けて記録します。",
            ),
          ),
        );
        const rows = records(data);
        if (!rows.length)
          view.append(note(t("表示できる作業履歴はありません。")));
        for (const row of rows) view.append(renderStaffAuditEntry(row));
        if (rows.length === 100)
          view.append(
            note(
              t(
                "最新100件を表示しています。保管・削除は運営責任者が定める方針に従います。",
              ),
            ),
          );
      }
      if (current() && token === sequence) {
        container.replaceChildren(view);
        if (focusSelected && selectedMemberId)
          view.querySelector<HTMLElement>(".member-workspace-title")?.focus();
      }
    } catch (error) {
      if (!current() || token !== sequence) return;
      selectedMemberId = "";
      const failure = element("section", "", "staff-card");
      const permission =
        error &&
        typeof error === "object" &&
        string((error as Row).code) === "42501";
      const message = element(
        "p",
        permission
          ? safeError(error)
          : t(
              "関係者情報を取得できませんでした。再読み込みして最新の状態を確認してください。",
            ),
      );
      message.setAttribute("role", "alert");
      const retry = element("button", t("再読み込み"), "staff-button");
      retry.type = "button";
      retry.addEventListener("click", () => {
        if (!busy) void load();
      });
      failure.append(message, retry);
      container.replaceChildren(failure);
    } finally {
      if (current() && token === sequence)
        container.removeAttribute("aria-busy");
    }
  }
  await load();
  return {
    dispose() {
      disposed = true;
      ++sequence;
      ++managementRevision;
      memberSearchQuery = "";
      hasMemberSearch = false;
      selectedMemberId = "";
      syncMemberNavigation = null;
      disposeAccountWindows();
    },
    refresh: load,
  };
}
