import type { SupabaseClient } from "@supabase/supabase-js";
import { currentLocale, format, localizedDate, text as t } from "../lib/i18n";
import { badge, node } from "../lib/admin-ui";
import type { ListController } from "./admin-list";
import "../styles/training-attendance.css";

type AttendanceStatus = "present" | "late" | "absent" | "excused";
type Role = "owner" | "staff" | "player";
type Attendance = {
  player_id: string;
  player_name: string;
  status: AttendanceStatus | null;
  recorded_at: string | null;
  self_checked_at: string | null;
};
type Training = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  venue: string;
  session_status: "scheduled" | "completed" | "cancelled";
  can_check_in: boolean;
  attendance: Attendance[];
};
type Today = {
  user_id: string;
  role: Role;
  today: string;
  player_id: string | null;
  linked: boolean;
  trainings: Training[];
};
type Draft = { status: AttendanceStatus; reason: string };
type Row = Record<string, unknown>;
const attendanceStatuses: AttendanceStatus[] = ["present", "late", "absent", "excused"];
const statusLabels = { present: "出席", late: "遅刻", absent: "欠席", excused: "公欠" } as const;

function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
  return value as Row;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("invalid_response");
  return value;
}
function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  const result = requiredString(value);
  if (Number.isNaN(Date.parse(result))) throw new Error("invalid_response");
  return result;
}
function attendanceStatus(value: unknown): AttendanceStatus | null {
  if (value === null) return null;
  if (!attendanceStatuses.includes(value as AttendanceStatus)) throw new Error("invalid_response");
  return value as AttendanceStatus;
}
function attendanceRow(value: unknown): Attendance {
  const row = record(value);
  return {
    player_id: requiredString(row.player_id),
    player_name: typeof row.player_name === "string" ? row.player_name : "",
    status: attendanceStatus(row.status),
    recorded_at: nullableDate(row.recorded_at),
    self_checked_at: nullableDate(row.self_checked_at),
  };
}
function parseToday(value: unknown, userId: string): Today {
  const row = record(value);
  if (row.user_id !== userId || !["owner", "staff", "player"].includes(String(row.role)) ||
    typeof row.today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.today) ||
    Number.isNaN(Date.parse(`${row.today}T00:00:00Z`)) ||
    new Date(`${row.today}T00:00:00Z`).toISOString().slice(0, 10) !== row.today ||
    typeof row.linked !== "boolean" || !Array.isArray(row.trainings)) throw new Error("invalid_response");
  const playerId = row.player_id === null ? null : requiredString(row.player_id);
  if (row.role === "player" && row.linked && !playerId) throw new Error("invalid_response");
  const trainings = row.trainings.map((value) => {
    const item = record(value);
    if (!["scheduled", "completed", "cancelled"].includes(String(item.session_status)) ||
      typeof item.title !== "string" || typeof item.venue !== "string" ||
      typeof item.can_check_in !== "boolean" || !Array.isArray(item.attendance)) throw new Error("invalid_response");
    const startsAt = nullableDate(item.starts_at);
    if (!startsAt) throw new Error("invalid_response");
    const attendance = item.attendance.map(attendanceRow);
    // 선수 응답에 타인의 출석이 섞이면 화면 전체를 폐기합니다. 실제 접근 제어는 RPC가 담당합니다.
    if (row.role === "player" && (attendance.length > 1 || attendance.some((entry) => entry.player_id !== playerId)))
      throw new Error("invalid_response");
    return {
      id: requiredString(item.id), title: item.title, venue: item.venue,
      starts_at: startsAt, ends_at: nullableDate(item.ends_at),
      session_status: item.session_status as Training["session_status"],
      can_check_in: item.can_check_in, attendance,
    };
  });
  return { user_id: userId, role: row.role as Role, today: row.today, player_id: playerId, linked: row.linked, trainings };
}
function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const row = error as Row;
    return [row.code, row.message].filter((value) => typeof value === "string").join(" ");
  }
  return "";
}
function denied(error: unknown): boolean {
  return /42501|PGRST30[12]|authentication_required|permission_denied|not_authorized|forbidden|JWT|invalid_response/i.test(errorDetail(error));
}
function statusLabel(value: AttendanceStatus | null): string {
  return value ? t(statusLabels[value]) : t("未記録");
}

// [편집 안내] 오늘의 기준일과 본인 선수 연결은 서버 응답만 사용합니다. 공개 일정이나
// 브라우저 시계로 출석 가능 여부를 추측하거나, 미체크 선수를 자동 결석 처리하지 않습니다.
export function createTrainingAttendance(options: {
  client: SupabaseClient;
  userId: string;
  isCurrent: () => boolean;
}): ListController {
  const element = node("section", "", "training-attendance");
  element.dataset.trainingAttendance = "true";
  const toolbar = node("div", "", "training-attendance-toolbar");
  const day = node("time", "", "training-attendance-day");
  const refreshButton = node("button", t("更新"), "training-attendance-button training-attendance-button-secondary");
  refreshButton.type = "button";
  const message = node("p", "", "training-attendance-message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const content = node("div", "", "training-attendance-content");
  toolbar.append(day, refreshButton);
  element.append(toolbar, message, content);
  const drafts = new Map<string, Draft>();
  let disposed = false;
  let blocked = false;
  let sequence = 0;
  let loading = false;
  let mutationPending = false;
  let data: Today | null = null;
  const current = () => !disposed && options.isCurrent();
  const key = (trainingId: string, playerId: string) => `${trainingId}:${playerId}`;
  function showMessage(text: string, error = false) {
    message.textContent = text;
    message.dataset.kind = error ? "error" : "success";
    message.setAttribute("role", error ? "alert" : "status");
  }
  function controls() {
    element.setAttribute("aria-busy", String(loading || mutationPending));
    refreshButton.disabled = loading || mutationPending || blocked;
    refreshButton.textContent = t(loading ? "更新中…" : "更新");
    for (const control of element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-attendance-control]"))
      control.disabled = loading || mutationPending || blocked || control.dataset.locked === "true";
  }
  function invalidate() {
    blocked = true;
    sequence++;
    loading = false;
    mutationPending = false;
    data = null;
    drafts.clear();
    content.replaceChildren();
    day.textContent = "";
    day.removeAttribute("datetime");
    showMessage(t("この操作の権限を確認できません。再読み込みしてログイン状態をご確認ください。"), true);
    controls();
  }
  function trackControl<T extends HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(control: T, locked = false): T {
    control.dataset.attendanceControl = "true";
    control.dataset.locked = String(locked);
    return control;
  }
  function recordDetails(entry: Attendance): HTMLElement {
    const details = node("div", "", "training-attendance-record");
    const status = node("span", statusLabel(entry.status), "training-attendance-status");
    status.dataset.attendanceStatus = entry.status ?? "unrecorded";
    details.append(status);
    if (entry.self_checked_at) details.append(node("span", t("自分で出席確認済み"), "training-attendance-note"));
    else if (entry.recorded_at) details.append(node("span", t("運営メンバーが記録"), "training-attendance-note"));
    if (entry.recorded_at) details.append(node("p", `${t("最終記録（日本時間）")}：${localizedDate(entry.recorded_at, currentLocale(), true)}`, "training-attendance-note"));
    return details;
  }
  function validateSaved(value: unknown, trainingId: string, playerId: string, expectedStatus?: AttendanceStatus): Omit<Attendance, "player_name"> {
    const result = record(value);
    const status = attendanceStatus(result.status);
    if (result.user_id !== options.userId || result.training_id !== trainingId || result.player_id !== playerId || !status ||
      (expectedStatus && status !== expectedStatus)) throw new Error("invalid_response");
    // 이전 출석의 기록 시각을 알 수 없을 때는 NULL을 유지합니다. 본인 확인 시각과 구분하며
    // 같은 상태의 재저장 응답에도 임의의 과거 작업 시각을 채워 넣지 않습니다.
    return { player_id: playerId, status, recorded_at: nullableDate(result.recorded_at), self_checked_at: nullableDate(result.self_checked_at) };
  }
  async function save(training: Training, playerId: string, button: HTMLButtonElement, draft?: Draft) {
    if (!current() || blocked || loading || mutationPending || !data) return;
    const version = ++sequence;
    mutationPending = true;
    showMessage("");
    controls();
    button.textContent = t(draft ? "保存中…" : "出席を記録中…");
    let confirmed = false;
    try {
      const response = draft
        ? await options.client.rpc("office_training_set_attendance", {
          p_training_id: training.id, p_player_id: playerId, p_status: draft.status, p_reason: draft.reason.trim(),
        })
        : await options.client.rpc("office_training_check_in", { p_training_id: training.id });
      if (!current() || blocked || version !== sequence) return;
      if (response.error) throw response.error;
      const saved = validateSaved(response.data, training.id, playerId, draft?.status);
      if (!draft && saved.status !== "present" && saved.status !== "late") throw new Error("invalid_response");
      confirmed = true;
      drafts.delete(key(training.id, playerId));
      const previous = training.attendance.find((entry) => entry.player_id === playerId);
      if (previous) Object.assign(previous, saved);
      else training.attendance.push({ ...saved, player_name: "" });
      render();
      showMessage(t(draft ? "出席の記録を保存しました。" : "出席を記録しました。"));
    } catch (error) {
      if (!current() || blocked || version !== sequence) return;
      if (errorDetail(error).includes("attendance_managed_by_staff"))
        showMessage(t("出席は運営メンバーが管理しています。変更は統括またはスタッフにご相談ください。"), true);
      else if (denied(error)) invalidate();
      else if (/today_training_unavailable|training_not_today|training_not_scheduled|training_cancelled|training_unavailable/.test(errorDetail(error)))
        showMessage(t("当日の予定が変わりました。更新して確認してください。"), true);
      else showMessage(t("保存できませんでした。入力内容を確認してもう一度お試しください。"), true);
    } finally {
      if (current() && !blocked && version === sequence) {
        mutationPending = false;
        button.textContent = t(draft ? "出席を保存" : "出席チェック");
        controls();
        if (confirmed) await refresh();
      }
    }
  }
  function staffRow(training: Training, entry: Attendance): HTMLElement {
    const row = node("article", "", "training-attendance-player");
    row.dataset.playerId = entry.player_id;
    row.append(node("h4", entry.player_name || t("選手")), recordDetails(entry));
    if (training.session_status === "cancelled") return row;
    const form = node("form", "", "training-attendance-form");
    const statusWrap = node("label", t("出席状況"), "training-attendance-field");
    const select = trackControl(node("select"));
    select.name = "status";
    for (const status of attendanceStatuses) {
      const option = node("option", t(statusLabels[status]));
      option.value = status;
      select.append(option);
    }
    const draftKey = key(training.id, entry.player_id);
    const draft = drafts.get(draftKey);
    select.value = draft?.status ?? entry.status ?? "present";
    statusWrap.append(select);
    const reasonWrap = node("label", t("変更理由"), "training-attendance-field training-attendance-reason");
    const reason = trackControl(node("input"));
    reason.name = "reason";
    reason.type = "text";
    reason.required = true;
    reason.maxLength = 500;
    reason.autocomplete = "off";
    reason.value = draft?.reason ?? "";
    reasonWrap.append(reason);
    const button = trackControl(node("button", t("出席を保存"), "training-attendance-button"));
    button.type = "submit";
    button.dataset.attendanceAction = "save";
    form.append(statusWrap, reasonWrap, button);
    const remember = () => drafts.set(draftKey, { status: select.value as AttendanceStatus, reason: reason.value });
    select.addEventListener("change", remember);
    reason.addEventListener("input", remember);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!current() || blocked || mutationPending || loading) return;
      remember();
      if (!reason.value.trim()) {
        showMessage(t("変更理由を入力してください。"), true);
        reason.focus();
        return;
      }
      if (!form.reportValidity()) return;
      void save(training, entry.player_id, button, { status: select.value as AttendanceStatus, reason: reason.value });
    });
    row.append(form);
    return row;
  }
  function render() {
    if (!data || !current() || blocked) return;
    day.textContent = format("日本時間の今日：{0}", data.today);
    day.dateTime = data.today;
    const fragment = document.createDocumentFragment();
    fragment.append(node("p", t("未チェックでも自動で欠席にはなりません。"), "training-attendance-help"));
    if (data.role !== "player") fragment.append(node("p", t("個人の連絡先や健康情報、認証情報は投稿しないでください。"), "training-attendance-help"));
    if (data.role === "player" && !data.linked)
      fragment.append(node("p", t("選手情報はまだアカウントに紐付けられていません。統括にご相談ください。"), "training-attendance-help"));
    if (!data.trainings.length) fragment.append(node("p", t("今日の練習はありません。"), "training-attendance-empty"));
    for (const training of data.trainings) {
      const card = node("section", "", "training-attendance-session");
      card.dataset.trainingId = training.id;
      const heading = node("div", "", "training-attendance-heading");
      heading.append(node("h3", training.title), badge(training.session_status));
      card.append(heading);
      const details = node("dl", "", "training-attendance-details");
      for (const [label, value] of [
        [t("開始（日本時間）"), localizedDate(training.starts_at, currentLocale(), true)],
        [t("終了（日本時間）"), training.ends_at ? localizedDate(training.ends_at, currentLocale(), true) : "—"],
        [t("会場"), training.venue || "—"],
      ]) {
        const pair = node("div");
        pair.append(node("dt", label), node("dd", value));
        details.append(pair);
      }
      card.append(details);
      if (data.role === "player") {
        const own = training.attendance[0];
        const ownCard = node("div", "", "training-attendance-own");
        if (data.player_id) ownCard.dataset.playerId = data.player_id;
        if (own) ownCard.append(recordDetails(own));
        if (own?.status === "absent" || own?.status === "excused") {
          ownCard.append(node("p", t("出席は運営メンバーが管理しています。変更は統括またはスタッフにご相談ください。"), "training-attendance-help"));
        } else if (data.linked && data.player_id && training.can_check_in && training.session_status === "scheduled" && !own?.self_checked_at) {
          const button = trackControl(node("button", t("出席チェック"), "training-attendance-button"));
          button.type = "button";
          button.dataset.attendanceAction = "check-in";
          button.addEventListener("click", () => {
            if (data?.player_id) void save(training, data.player_id, button);
          });
          ownCard.append(button);
        } else if (data.linked && !own?.self_checked_at) {
          ownCard.append(node("p", t("出席は開催予定の当日練習で記録できます。"), "training-attendance-help"));
        }
        card.append(ownCard);
      } else {
        if (training.session_status === "cancelled")
          card.append(node("p", t("中止の練習は出席を変更できません。"), "training-attendance-help"));
        for (const entry of training.attendance) card.append(staffRow(training, entry));
      }
      fragment.append(card);
    }
    content.replaceChildren(fragment);
    controls();
  }
  async function refresh() {
    if (!current() || blocked || loading || mutationPending) return;
    const version = ++sequence;
    loading = true;
    controls();
    if (!data) content.replaceChildren(node("p", t("当日の練習と出席を読み込み中…"), "training-attendance-help"));
    try {
      const response = await options.client.rpc("office_training_attendance_today");
      if (!current() || blocked || version !== sequence) return;
      if (response.error) throw response.error;
      const next = parseToday(response.data, options.userId);
      // 등급·일자가 바뀌면 이전 명단의 입력값을 새 권한이나 다음 날 훈련에 넘기지 않습니다.
      if (data && (data.role !== next.role || data.today !== next.today)) drafts.clear();
      data = next;
      render();
      if (message.dataset.kind === "error") showMessage("");
    } catch (error) {
      if (!current() || blocked || version !== sequence) return;
      if (denied(error)) invalidate();
      else if (data) showMessage(t("出席記録を更新できませんでした。保存済みの表示を保っています。"), true);
      else {
        content.replaceChildren();
        showMessage(t("出席を読み込めませんでした。もう一度お試しください。"), true);
      }
    } finally {
      if (current() && version === sequence) {
        loading = false;
        controls();
      }
    }
  }
  refreshButton.addEventListener("click", () => { showMessage(""); void refresh(); });
  function backgroundRefresh() {
    // 입력 중인 정정 사유를 주기 갱신으로 지우거나 키보드 포커스를 옮기지 않습니다.
    if (document.visibilityState === "hidden" || element.querySelector("form")?.contains(document.activeElement) ||
      document.activeElement?.closest(".training-attendance-form")) return;
    void refresh();
  }
  const timer = window.setInterval(backgroundRefresh, 45_000);
  document.addEventListener("visibilitychange", backgroundRefresh);
  const { data: authListener } = options.client.auth.onAuthStateChange((event, session) => {
    if (!current()) return;
    if (event === "SIGNED_OUT" ||
      (["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED"].includes(event) && !session?.user?.id) ||
      (session?.user?.id && session.user.id !== options.userId)) invalidate();
  });
  return {
    element, refresh,
    dispose() {
      disposed = true;
      sequence++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", backgroundRefresh);
      authListener.subscription.unsubscribe();
      data = null;
      drafts.clear();
      element.replaceChildren();
    },
  };
}
