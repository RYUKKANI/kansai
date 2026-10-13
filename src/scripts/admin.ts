import { createClient } from "@supabase/supabase-js";
import {
  resources,
  type Field,
  type Resource,
  type ResourceConfig,
} from "../lib/admin-config";
import type { StaffRole } from "../lib/content-types";

// [편집 안내] 로그인 → 역할 확인 → 목록/대시보드 → 양식 저장 순서입니다.
// 화면을 숨기는 것과 별개로 모든 데이터 작업은 Supabase RLS로 다시 제한됩니다.
type Row = Record<string, unknown>;
const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// 저장한 HTML은 화면 검토용입니다. 로그인과 실제 편집은 웹 주소에서만 실행합니다.
const onWeb = ["https:", "http:"].includes(window.location.protocol);
const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("管理画面を読み直してください。");
  return element;
};
const client =
  onWeb && url && key?.startsWith("sb_publishable_")
    ? createClient(url, key, {
        auth: {
          storageKey: "kansai-admin-session",
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;
let role: StaffRole | null = null;
let userId: string | null = null;
let current: Resource | "dashboard" = "dashboard";
let editing: Row | null = null;
let editResource: Resource | null = null;
let removing: Row | null = null;
let removeResource: Resource | null = null;
let rows: Row[] = [];
let pageIndex = 0;
let requestId = 0;
const pageSize = 50;
const editor = $<HTMLDialogElement>("#editor-dialog");
const editorForm = $<HTMLFormElement>("#editor-form");
const statuses: Record<string, string> = {
  draft: "下書き",
  pending: "承認待ち",
  published: "発行済み",
};

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
function action(text: string, className: string, callback?: () => void) {
  const button = node("button", text, className);
  button.type = "button";
  if (callback) button.addEventListener("click", callback);
  return button;
}
function notice(text: string, error = false) {
  const element = $("#admin-notice");
  element.textContent = text;
  element.dataset.error = String(error);
}
// Auth 오류는 code로 구분합니다. DB 권한과 이메일 인증을 건너뛰지 않습니다.
function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error
    ? String(error.code)
    : "";
}
function message(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "操作を完了できませんでした。";
  const code = errorCode(error);
  if (["signup_disabled", "email_not_confirmed"].includes(code))
    return "初回は招待・確認メールのリンクを開いてください。招待されたメールアドレスもご確認ください。";
  if (code === "invalid_credentials")
    return "メールアドレスまたはパスワードをご確認ください。パスワードを設定していない場合はメールリンクをご利用ください。";
  if (["over_email_send_rate_limit", "over_request_rate_limit"].includes(code))
    return "メールの送信回数に制限がかかっています。少し時間をおいてから再度お試しください。";
  if (code === "otp_expired")
    return "メールリンクの有効期限が切れているか、すでに使用されています。最新のメールをご確認ください。";
  if (code === "email_address_not_authorized")
    return "メールを送信できません。運営責任者にメール送信設定をご確認ください。";
  if (/row-level|permission denied|owner role|active staff/i.test(raw))
    return "この操作に必要な権限がありません。運営責任者にご確認ください。";
  if (/last owner/i.test(raw)) return "最後のOwnerは無効化・削除できません。";
  if (/profile consent/i.test(raw))
    return "先に選手登録画面でプロフィールの公開同意を確認してください。";
  if (/photo consent/i.test(raw))
    return "先に選手登録画面で写真の公開同意を確認してください。";
  if (/album must be approved/i.test(raw))
    return "使用するアルバムを先に発行してください。";
  if (/photo upload is required/i.test(raw))
    return "写真をアップロードしてから発行してください。";
  if (/must be approved/i.test(raw))
    return "使用する写真を先に発行してください。";
  if (/approval requires/i.test(raw))
    return "プロフィールの発行はOwnerまたはAdministratorが承認します。";
  if (/published URL|UUID is immutable|record ID/i.test(raw))
    return "発行済みのURLと識別子は変更できません。";
  if (/duplicate key/i.test(raw))
    return "同じURLまたは登録情報がすでにあります。既存の項目を編集してください。";
  if (/foreign key/i.test(raw))
    return "関連するプロフィール・記録があるため削除できません。非公開または活動休止にしてください。";
  if (/check constraint/i.test(raw))
    return "必須項目、写真の掲載確認、得点、日時などの入力を確認してください。";
  if (/future publication/i.test(raw))
    return "未来の日時で発行できません。下書きに保存してください。";
  return raw;
}
async function run(callback: () => Promise<void>) {
  try {
    await callback();
  } catch (error) {
    notice(message(error), true);
  }
}
// 로그인 요청을 중복 전송하지 않도록 두 버튼을 함께 잠그고, 실패 시 다시 사용할 수 있게 합니다.
let loginPending = false;
async function runLogin(callback: () => Promise<void>) {
  if (loginPending) return;
  loginPending = true;
  const form = $("#login-form");
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  form.setAttribute("aria-busy", "true");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await run(callback);
  } finally {
    loginPending = false;
    form.removeAttribute("aria-busy");
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
async function result<T extends { error: unknown }>(
  request: PromiseLike<T>,
): Promise<T> {
  const response = await request;
  if (response.error) throw response.error;
  return response;
}
function resetLogin() {
  role = null;
  userId = null;
  rows = [];
  editing = null;
  removing = null;
  requestId++;
  editResource = null;
  removeResource = null;
  $("#workspace").hidden = true;
  $("#login-panel").hidden = false;
  $("#admin-content").replaceChildren();
  editor.close();
  editorForm.reset();
  $("#editor-fields").replaceChildren();
  $("#account-email").textContent = "";
  $("#account-role").textContent = "";
  $<HTMLFormElement>("#invite-form").reset();
  $<HTMLDialogElement>("#invite-dialog").close();
  $<HTMLDialogElement>("#delete-dialog").close();
}
async function authenticate() {
  if (!client) return;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    resetLogin();
    return;
  }
  const membership = await result(
    client
      .from("admin_roles")
      .select("user_id,email,role,active")
      .eq("user_id", data.user.id)
      .maybeSingle(),
  );
  if (
    !membership.data?.active ||
    !["owner", "administrator", "editor", "coach"].includes(
      membership.data.role,
    )
  ) {
    resetLogin();
    notice("このアカウントには運営メンバーのアクセス権がありません。", true);
    return;
  }
  role = membership.data.role as StaffRole;
  userId = data.user.id;
  $("#account-email").textContent = data.user.email ?? membership.data.email;
  $("#account-role").textContent = role;
  $("#login-panel").hidden = true;
  $("#workspace").hidden = false;
  navigation();
  await show("dashboard");
}
function navigation() {
  const navigation = $("#admin-navigation");
  navigation.replaceChildren();
  const dashboard = action("ダッシュボード", "", () => {
    void run(() => show("dashboard"));
  });
  dashboard.dataset.resource = "dashboard";
  navigation.append(dashboard);
  for (const [name, config] of Object.entries(resources)) {
    if (!role || !config.roles.includes(role)) continue;
    const button = action(config.label, "", () => {
      void run(() => show(name as Resource));
    });
    button.dataset.resource = name;
    navigation.append(button);
  }
}
async function publicationStatus() {
  if (!client) return;
  const state = await result(
    client
      .from("publication_state")
      .select("version,changed_at")
      .eq("id", 1)
      .single(),
  );
  const element = $("#publication-status");
  element.textContent =
    "発行した内容は次のサイト再構築で反映されます（通常15分間隔。処理待ちで遅れる場合があります）。";
  try {
    const response = await fetch(base + "build.json", { cache: "no-store" });
    if (!response.ok) return;
    const deployed = await response.json();
    if (!deployed.fromCms)
      element.textContent =
        "公開サイトはV2検討中です。CMSの発行内容の反映は、公開接続の有効化後に開始します。";
    else if (Number(deployed.version) < Number(state.data?.version))
      element.textContent =
        "発行内容のサイト反映待ちです。次の再構築で更新されます（通常15分間隔。遅れる場合があります）。";
    else
      element.textContent =
        "発行内容は公開サイトに反映済みです。最終更新：" +
        new Date(deployed.builtAt).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });
  } catch {
    /* 배포 상태 조회 실패가 이미 성공한 콘텐츠 저장을 취소하지 않도록 합니다. */
  }
}
async function show(resource: Resource | "dashboard", resetPage = true) {
  if (!client || !role) return;
  if (resource !== "dashboard" && !resources[resource].roles.includes(role))
    return;
  current = resource;
  if (resetPage) pageIndex = 0;
  const version = ++requestId;
  $("#resource-title").textContent =
    resource === "dashboard" ? "ダッシュボード" : resources[resource].label;
  const newButton = $("#new-button");
  newButton.hidden = resource === "dashboard";
  newButton.textContent =
    resource === "admin_roles" ? "メンバーを招待" : "新規登録";
  $("#admin-navigation")
    .querySelectorAll<HTMLElement>("[data-resource]")
    .forEach((button) => {
      if (button.dataset.resource === resource)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  $("#admin-content").replaceChildren(node("p", "読み込み中…", "admin-help"));
  await publicationStatus();
  if (resource === "dashboard") {
    await dashboard(version);
    return;
  }
  const config = resources[resource];
  const response = await result(
    client
      .from(resource)
      .select("*", { count: "exact" })
      .order(resource === "admin_roles" ? "email" : "updated_at", {
        ascending: false,
      })
      .range(pageIndex * pageSize, (pageIndex + 1) * pageSize - 1),
  );
  if (version !== requestId || !role) return;
  rows = (response.data ?? []) as Row[];
  const list = node("div", "", "admin-list");
  if (!rows.length)
    list.append(node("p", "登録された項目はありません。", "content-empty"));
  for (const row of rows) {
    const item = node("article", "", "admin-list-row");
    const copy = node("div");
    if (row.status) {
      const badge = node(
        "span",
        statuses[String(row.status)] ?? String(row.status),
        "content-status",
      );
      badge.dataset.status = String(row.status);
      copy.append(badge);
    }
    copy.append(node("h2", String(row[config.titleField] ?? "")));
    copy.append(
      node(
        "p",
        row.slug
          ? "/" +
              resource
                .replace("public_player_profiles", "team")
                .replace("articles", "news") +
              "/" +
              String(row.slug) +
              "/"
          : String(
              row.updated_at
                ? new Date(String(row.updated_at)).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })
                : "",
            ),
      ),
    );
    if (resource === "admin_roles")
      copy.append(
        node("p", String(row.role) + " / " + (row.active ? "有効" : "無効")),
      );
    if (resource === "players")
      copy.append(
        node(
          "p",
          "選手ID：" +
            String(row.id) +
            " / プロフィール同意：" +
            (row.profile_consent ? "確認済み" : "未確認"),
        ),
      );
    const buttons = node("div", "", "admin-row-actions");
    buttons.append(
      action("編集", "admin-secondary", () => {
        void run(() => openEditor(row));
      }),
    );
    // 선수 식별자·운영진은 삭제 대신 상태를 변경합니다. 관련 기록의 UUID를 보존합니다.
    if (
      ![
        "players",
        "public_player_profiles",
        "admin_roles",
        "site_pages",
      ].includes(resource)
    )
      buttons.append(
        action("削除", "admin-danger", () => {
          removing = row;
          removeResource = resource;
          $("#delete-description").textContent =
            String(row[config.titleField] ?? "") + "を削除します。";
          $<HTMLDialogElement>("#delete-dialog").showModal();
        }),
      );
    item.append(copy, buttons);
    list.append(item);
  }
  if ((response.count ?? 0) > pageSize) {
    const pager = node("div", "", "admin-editor-actions");
    const previous = action("前のページ", "admin-secondary", () => {
      pageIndex--;
      void run(() => show(resource, false));
    });
    previous.disabled = pageIndex === 0;
    const next = action("次のページ", "admin-secondary", () => {
      pageIndex++;
      void run(() => show(resource, false));
    });
    next.disabled = (pageIndex + 1) * pageSize >= (response.count ?? 0);
    pager.append(
      previous,
      node(
        "span",
        String(pageIndex + 1) +
          " / " +
          Math.ceil((response.count ?? 0) / pageSize),
      ),
      next,
    );
    list.append(pager);
  }
  $("#admin-content").replaceChildren(list);
}
async function dashboard(version: number) {
  if (!client || !role) return;
  const visible = (Object.keys(resources) as Resource[]).filter((resource) =>
    resources[resource].roles.includes(role!),
  );
  const stats = node("div", "", "admin-stats");
  let pending = 0;
  for (const resource of [
    "articles",
    "players",
    "fixtures",
    "training_sessions",
  ] as Resource[]) {
    if (!visible.includes(resource)) continue;
    const response = await result(
      client.from(resource).select("*", { head: true, count: "exact" }),
    );
    const card = node("div", "", "admin-stat");
    card.append(
      node("strong", String(response.count ?? 0)),
      node("span", resources[resource].label),
    );
    stats.append(card);
  }
  for (const resource of visible.filter(
    (r) => resources[r].canPublish.length > 0,
  )) {
    const response = await result(
      client
        .from(resource)
        .select("*", { head: true, count: "exact" })
        .in("status", ["draft", "pending"]),
    );
    pending += response.count ?? 0;
  }
  const pendingCard = node("div", "", "admin-stat");
  pendingCard.append(
    node("strong", String(pending)),
    node("span", "公開待ちのコンテンツ"),
  );
  stats.append(pendingCard);
  const schedules = node("section", "", "admin-section");
  schedules.append(node("h2", "これからの試合・練習"));
  for (const resource of ["fixtures", "training_sessions"] as Resource[]) {
    if (!visible.includes(resource)) continue;
    const column = resource === "fixtures" ? "kickoff_at" : "starts_at";
    const response = await result(
      client
        .from(resource)
        .select("*")
        .gte(column, new Date().toISOString())
        .order(column)
        .limit(5),
    );
    for (const row of response.data ?? [])
      schedules.append(
        node(
          "p",
          String(row.opponent ?? row.title) +
            " / " +
            new Date(row[column]).toLocaleString("ja-JP", {
              timeZone: "Asia/Tokyo",
            }),
        ),
      );
  }
  if (schedules.children.length === 1)
    schedules.append(node("p", "今後の予定はまだ登録されていません。"));
  const history = await result(
    client
      .from("audit_logs")
      .select("entity,operation,occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(8),
  );
  const audit = node("section", "", "admin-section");
  audit.append(node("h2", "最近の変更"));
  for (const row of history.data ?? [])
    audit.append(
      node(
        "p",
        (resources[row.entity as Resource]?.label ?? row.entity) +
          " / " +
          row.operation +
          " / " +
          new Date(row.occurred_at).toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
          }),
      ),
    );
  if (!history.data?.length)
    audit.append(node("p", "変更履歴はまだありません。"));
  if (version === requestId && role)
    $("#admin-content").replaceChildren(stats, schedules, audit);
}
function japanInput(value: unknown): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(String(value)));
  const part = (name: string) =>
    parts.find((p) => p.type === name)?.value ?? "";
  return (
    part("year") +
    "-" +
    part("month") +
    "-" +
    part("day") +
    "T" +
    part("hour") +
    ":" +
    part("minute")
  );
}
async function choices(field: Field) {
  if (!client) return [];
  if (field.name === "player_id") {
    const response = await result(
      client.from("players").select("id,internal_name").order("internal_name"),
    );
    return (response.data ?? []).map((p) => ({
      value: p.id,
      label: p.internal_name,
    }));
  }
  if (field.name === "album_id") {
    const response = await result(
      client.from("media_albums").select("id,title").order("title"),
    );
    return [
      { value: "", label: "アルバムなし" },
      ...(response.data ?? []).map((p) => ({ value: p.id, label: p.title })),
    ];
  }
  if (field.type === "media" || field.type === "gallery") {
    const response = await result(
      client
        .from("media_assets")
        .select("storage_path,legacy_path,title")
        .eq("kind", "photo")
        .eq("status", "published"),
    );
    return (response.data ?? []).map((p) => ({
      value: p.storage_path ?? p.legacy_path,
      label: p.title,
    }));
  }
  return field.options ?? [];
}
async function openEditor(row: Row | null) {
  if (!client || !role || current === "dashboard") return;
  const resource = current;
  const config = resources[resource];
  editing = row;
  editResource = resource;
  $("#editor-title").textContent =
    config.singular + (row ? "を編集" : "を登録");
  const fields = $("#editor-fields");
  fields.replaceChildren();
  editorForm.reset();
  if (resource === "media_assets") {
    const upload = node("div", "", "admin-upload");
    const label = node(
      "label",
      "写真をアップロード（JPEG・PNG・WebP、10MBまで）",
    );
    const input = node("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    label.append(input);
    upload.append(
      label,
      node(
        "p",
        "表示用に圧縮して保存します。写真を発行する前に掲載権限を確認してください。",
        "admin-help",
      ),
    );
    input.addEventListener("change", () => {
      void run(() => uploadPhoto(input));
    });
    fields.append(upload);
  }
  for (const field of config.fields) {
    if (row?.legacy_path && field.name === "consent_confirmed") continue;
    const container = node("div", "", "admin-field");
    if (["textarea", "gallery"].includes(field.type ?? ""))
      container.classList.add("admin-field-wide");
    const label = node("label", field.label);
    const id = "field-" + field.name;
    label.htmlFor = id;
    if (field.type === "gallery") {
      const group = node("div", "", "admin-gallery-options");
      const selected = Array.isArray(row?.[field.name])
        ? (row?.[field.name] as string[])
        : [];
      for (const option of await choices(field)) {
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.name = field.name;
        checkbox.value = option.value;
        checkbox.checked = selected.includes(option.value);
        const item = node("label", "", "admin-checkbox");
        item.append(checkbox, node("span", option.label));
        group.append(item);
      }
      if (!group.children.length)
        group.append(
          node("p", "先に写真を登録して発行してください。", "admin-help"),
        );
      container.append(label, group);
    } else {
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (field.type === "textarea") input = node("textarea");
      else if (field.type === "select" || field.type === "media") {
        input = node("select");
        if (field.type === "media") {
          const empty = node("option", "写真なし");
          empty.value = "";
          input.append(empty);
        }
        for (const option of await choices(field)) {
          const item = node("option", option.label);
          item.value = option.value;
          input.append(item);
        }
      } else {
        input = node("input");
        input.type =
          field.type === "checkbox" ? "checkbox" : (field.type ?? "text");
      }
      input.id = id;
      input.name = field.name;
      input.required = Boolean(field.required);
      if (input instanceof HTMLInputElement && field.type === "checkbox") {
        input.checked = Boolean(
          row ? row[field.name] : field.name === "active",
        );
        label.classList.add("admin-checkbox");
        label.prepend(input);
        container.append(label);
      } else {
        input.value =
          field.type === "datetime-local"
            ? japanInput(row?.[field.name])
            : String(
                row?.[field.name] ??
                  (field.name === "display_order"
                    ? "0"
                    : input instanceof HTMLSelectElement
                      ? (input.options[0]?.value ?? "")
                      : ""),
              );
        if (input instanceof HTMLInputElement && field.type === "number") {
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
        }
        if (
          row &&
          (field.name === config.key ||
            (field.name === "slug" && row.published_at))
        )
          input.disabled = true;
        if (field.name === "storage_path" && input instanceof HTMLInputElement)
          input.readOnly = true;
        container.append(label, input);
      }
    }
    if (field.hint) container.append(node("p", field.hint, "admin-help"));
    fields.append(container);
  }
  const actions = $("#editor-actions");
  actions.replaceChildren();
  const save = (label: string, status: string) => {
    const button = action(label, "admin-primary");
    button.type = "submit";
    button.dataset.saveStatus = status;
    actions.append(button);
  };
  if (config.canPublish.length) {
    save("下書き保存", "draft");
    save("承認待ちで保存", "pending");
    if (config.canPublish.includes(role))
      save(
        row?.status === "published" ? "更新して発行" : "発行する",
        "published",
      );
    if (row?.status === "published")
      actions.append(
        node(
          "p",
          "下書き・承認待ちで保存すると公開が取り消されます。サイトへの反映には再構築が必要です。",
          "admin-help",
        ),
      );
  } else save("保存", "");
  if (row && resource === "public_player_profiles") {
    const button = action("非公開にする", "admin-secondary");
    button.type = "submit";
    button.dataset.saveStatus = "draft";
    actions.append(button);
  }
  if (!editor.open) editor.showModal();
}
async function uploadPhoto(input: HTMLInputElement) {
  if (!client || !userId || !input.files?.[0]) return;
  const file = input.files[0];
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 10485760
  )
    throw new Error("JPEG・PNG・WebPの10MB以下の写真を選択してください。");
  input.disabled = true;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("写真を処理できません。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("写真を処理できません。"))),
        "image/jpeg",
        0.88,
      ),
    );
    const path = userId + "/" + crypto.randomUUID() + ".jpg";
    await result(
      client.storage
        .from("kansai-media")
        .upload(path, blob, { contentType: "image/jpeg", upsert: false }),
    );
    $<HTMLInputElement>("#field-storage_path").value = path;
    $<HTMLSelectElement>("#field-kind").value = "photo";
    notice(
      "写真をアップロードしました。説明と掲載確認を入力し、保存してください。",
    );
  } finally {
    input.disabled = false;
  }
}
async function save(event: SubmitEvent) {
  event.preventDefault();
  if (!client || !role || !editResource) return;
  const resource = editResource;
  const config: ResourceConfig = resources[resource];
  const data = new FormData(editorForm);
  const payload: Record<string, unknown> = {};
  for (const field of config.fields) {
    if (editing?.legacy_path && field.name === "consent_confirmed") continue;
    if (
      editing &&
      (field.name === config.key ||
        (field.name === "slug" && editing.published_at))
    )
      continue;
    const text = String(data.get(field.name) ?? "").trim();
    if (field.type === "checkbox") payload[field.name] = data.has(field.name);
    else if (field.type === "gallery")
      payload[field.name] = data.getAll(field.name).map(String);
    else if (field.type === "number")
      payload[field.name] = text ? Number(text) : null;
    else if (field.type === "datetime-local")
      payload[field.name] = text
        ? new Date(text + "+09:00").toISOString()
        : null;
    else if (
      [
        "source_url",
        "photo_path",
        "cover_path",
        "opponent_logo_path",
        "video_url",
        "album_id",
        "storage_path",
        "activity_date",
        "captured_on",
      ].includes(field.name)
    ) {
      if (field.name.endsWith("_url") && text && !/^https:\/\//.test(text))
        throw new Error("URLはHTTPSで入力してください。");
      payload[field.name] = text || null;
    } else payload[field.name] = text;
  }
  const status =
    (event.submitter as HTMLButtonElement | null)?.dataset.saveStatus ?? "";
  if (config.canPublish.length || resource === "public_player_profiles")
    payload.status = status || "draft";
  if (resource === "media_assets") {
    if (payload.kind === "video") {
      payload.storage_path = null;
      payload.legacy_path = null;
    } else {
      payload.video_url = null;
      if (payload.storage_path) payload.legacy_path = null;
    }
  }
  if (editing)
    await result(
      client
        .from(resource)
        .update(payload)
        .eq(config.key, editing[config.key])
        .select(config.key)
        .single(),
    );
  else
    await result(
      client.from(resource).insert(payload).select(config.key).single(),
    );
  editor.close();
  notice(
    status === "published"
      ? "発行しました。公開サイトの反映状態をご確認ください。"
      : "保存しました。",
  );
  await show(resource, false);
}

// Auth 콜백 안에서 다른 Auth 작업을 기다리면 멈출 수 있으므로 다음 이벤트에서 처리합니다.
if (!client) {
  $("#config-warning").hidden = false;
  if (!onWeb)
    $("#config-warning").textContent =
      "このファイルは画面確認用です。ログインと編集は公式サイトの管理画面をご利用ください。";
  $("#login-form")
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
    .forEach((element) => {
      element.disabled = true;
    });
} else {
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void runLogin(async () => {
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const password = String(data.get("password") ?? "");
      if (!password)
        throw new Error(
          "パスワードを入力するか、メールリンクをご利用ください。",
        );
      await result(
        client.auth.signInWithPassword({
          email: String(data.get("email") ?? "")
            .trim()
            .toLowerCase(),
          password,
        }),
      );
      $<HTMLFormElement>("#login-form").reset();
    });
  });
  $("#magic-link-button").addEventListener("click", () => {
    void runLogin(async () => {
      const input = $<HTMLInputElement>('#login-form input[name="email"]');
      if (!input.reportValidity()) return;
      const email = input.value.trim().toLowerCase();
      const emailRedirectTo = new URL(base + "admin/", location.origin).href;
      const response = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo },
      });
      // 미인증 초대 계정은 OTP 요청에서도 signup_disabled가 반환됩니다.
      // resend는 이미 존재하는 계정의 확인 메일만 보냅니다. 회원가입은 계속 차단합니다.
      if (
        ["signup_disabled", "email_not_confirmed"].includes(
          errorCode(response.error),
        )
      ) {
        await result(
          client.auth.resend({
            type: "signup",
            email,
            options: { emailRedirectTo },
          }),
        );
        // 등록 여부를 노출하지 않고, 발송 접수와 실제 로그인 완료를 구분합니다.
        notice(
          "確認メールの送信を受け付けました。招待されたアドレスの受信箱・迷惑メールをご確認ください。メールが届かない場合は運営責任者にご確認ください。",
        );
        return;
      }
      if (response.error) throw response.error;
      notice(
        "ログインリンクを送信しました。招待されたメールの受信箱をご確認ください。",
      );
    });
  });
  $("#logout-button").addEventListener("click", () => {
    void run(async () => {
      await result(client.auth.signOut());
      resetLogin();
      notice("ログアウトしました。");
    });
  });
  let authPending = false;
  const refresh = () => {
    if (authPending) return;
    authPending = true;
    setTimeout(() => {
      void run(authenticate).finally(() => {
        authPending = false;
      });
    }, 0);
  };
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") resetLogin();
    else if (
      [
        "INITIAL_SESSION",
        "SIGNED_IN",
        "TOKEN_REFRESHED",
        "USER_UPDATED",
      ].includes(event)
    )
      refresh();
  });
  refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}
$("#new-button").addEventListener("click", () => {
  if (current === "admin_roles")
    $<HTMLDialogElement>("#invite-dialog").showModal();
  else void run(() => openEditor(null));
});
editorForm.addEventListener("submit", (event) => {
  const buttons = editorForm.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => {
    b.disabled = true;
  });
  void run(() => save(event)).finally(() =>
    buttons.forEach((b) => {
      b.disabled = false;
    }),
  );
});
$("#editor-close").addEventListener("click", () => editor.close());
$("#delete-cancel").addEventListener("click", () =>
  $<HTMLDialogElement>("#delete-dialog").close(),
);
$("#delete-confirm").addEventListener("click", () => {
  void run(async () => {
    if (!client || !removeResource || !removing) return;
    const config = resources[removeResource];
    await result(
      client
        .from(removeResource)
        .delete()
        .eq(config.key, removing[config.key])
        .select(config.key)
        .single(),
    );
    $<HTMLDialogElement>("#delete-dialog").close();
    removing = null;
    notice("削除しました。");
    await show(removeResource, false);
  });
});
$("#invite-cancel").addEventListener("click", () =>
  $<HTMLDialogElement>("#invite-dialog").close(),
);
$("#invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    if (!client || role !== "owner") return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    await result(
      client.functions.invoke("invite-staff", {
        body: {
          email: String(data.get("email") ?? ""),
          role: String(data.get("role") ?? ""),
        },
      }),
    );
    $<HTMLDialogElement>("#invite-dialog").close();
    form.reset();
    notice("運営メンバーを招待しました。");
    await show("admin_roles");
  });
});
