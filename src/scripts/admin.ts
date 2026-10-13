import { createClient } from "@supabase/supabase-js";
import {
  resources,
  type Field,
  type Resource,
  type ResourceConfig,
} from "../lib/admin-config";
import type { StaffRole } from "../lib/content-types";
import {
  action,
  node,
  icon,
  badge,
  dateLabel,
  japanInput,
  imageSources,
  editorGroups,
  officeGroups,
  officePages,
  roleLabels,
  type Row,
  type OfficePage,
  type ListFilter,
} from "../lib/admin-ui";
import { buildDashboard } from "./admin-dashboard";
import { createList, type ListController } from "./admin-list";
import { createSchedule, recurrenceControls } from "./admin-schedule";
import {
  configureOffice,
  resourceAvailable,
  scheduleEnabled,
} from "../lib/office-features";

// [편집 안내] 로그인 → 역할 확인 → 목록/대시보드 → 양식 저장 순서입니다.
// 화면을 숨기는 것과 별개로 모든 데이터 작업은 Supabase RLS로 다시 제한됩니다.
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
let current: OfficePage = "dashboard";
let currentList: ListController | null = null;
let editorBaseline = "";
let editorDirty = false;
let drawerOpen = false;
const playerConsents = new Map<string, Row>();
let editing: Row | null = null;
let editResource: Resource | null = null;
let removing: Row | null = null;
let removeResource: Resource | null = null;
let requestId = 0;
const editor = $<HTMLDialogElement>("#editor-dialog");
const editorForm = $<HTMLFormElement>("#editor-form");
function notice(text: string, error = false) {
  const element = $("#admin-notice");
  element.replaceChildren();
  if (text) {
    const close = action("閉じる", "office-notice-close", () =>
      element.replaceChildren(),
    );
    close.setAttribute("aria-label", "通知を閉じる");
    element.append(node("span", text), close);
  }
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
// 로그아웃·권한 상실 시 비공개 DOM과 열린 편집 화면을 함께 정리합니다.
function resetLogin() {
  role = null;
  userId = null;
  editing = null;
  removing = null;
  requestId++;
  currentList?.dispose();
  currentList = null;
  editResource = null;
  removeResource = null;
  editorDirty = false;
  editorBaseline = "";
  playerConsents.clear();
  $("#workspace").hidden = true;
  $("#login-panel").hidden = false;
  $("#header-account").hidden = true;
  $("#office-breadcrumb").hidden = true;
  document.body.dataset.authenticated = "false";
  $("#admin-content").replaceChildren();
  $("#publication-status").replaceChildren();
  $("#admin-navigation").replaceChildren();
  editor.close();
  editorForm.reset();
  $("#editor-fields").replaceChildren();
  $("#account-email").textContent = "";
  $("#account-role").textContent = "";
  $<HTMLFormElement>("#invite-form").reset();
  for (const name of [
    "invite-dialog",
    "delete-dialog",
    "unsaved-dialog",
    "article-preview-dialog",
  ])
    $<HTMLDialogElement>("#" + name).close();
  drawerOpen = false;
  syncSidebar();
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
  const unchanged =
    role === membership.data.role &&
    userId === data.user.id &&
    !$("#workspace").hidden;
  if (role && role !== membership.data.role) resetLogin();
  role = membership.data.role as StaffRole;
  userId = data.user.id;
  $("#account-email").textContent = data.user.email ?? membership.data.email;
  $("#account-role").textContent = roleLabels[role] ?? role;
  $("#account-avatar").textContent = (data.user.email ?? "KU")
    .slice(0, 2)
    .toUpperCase();
  $("#header-account").hidden = false;
  $("#office-breadcrumb").hidden = false;
  document.body.dataset.authenticated = "true";
  $("#login-panel").hidden = true;
  $("#workspace").hidden = false;
  syncSidebar();
  // 토큰 갱신 때 진행 중인 검색·달력·편집 화면을 덮어쓰지 않습니다.
  if (unchanged) return;
  const capabilities = await client.rpc("office_capabilities");
  configureOffice(
    !capabilities.error &&
      capabilities.data &&
      !Array.isArray(capabilities.data)
      ? capabilities.data
      : {},
  );
  navigation();
  await show("dashboard");
}
function navigation() {
  const navigation = $("#admin-navigation");
  navigation.replaceChildren();
  for (const group of officeGroups) {
    const section = node("div", "", "office-nav-group");
    section.append(node("p", group));
    for (const name of [
      "dashboard",
      ...(scheduleEnabled ? ["schedule"] : []),
      ...Object.keys(resources),
    ] as OfficePage[]) {
      const info = officePages[name];
      if (
        info.group !== group ||
        (name === "schedule"
          ? !role || !["owner", "administrator", "coach"].includes(role)
          : name !== "dashboard" &&
            (!role ||
              !resourceAvailable(name) ||
              !resources[name].roles.includes(role)))
      )
        continue;
      const label =
        name === "dashboard"
          ? "ダッシュボード"
          : name === "schedule"
            ? "統合カレンダー"
            : resources[name].label;
      const button = action(
        label,
        "",
        () => {
          closeDrawer(false);
          void run(() => show(name));
        },
        info.icon,
      );
      button.dataset.resource = name;
      button.title = label;
      button.setAttribute("aria-label", label);
      section.append(button);
    }
    if (section.children.length > 1) navigation.append(section);
  }
}
async function publicationStatus(version = requestId) {
  if (!client) return;
  const state = await result(
    client
      .from("publication_state")
      .select("version,changed_at")
      .eq("id", 1)
      .single(),
  );
  let text =
    "発行した内容は次のサイト再構築で反映されます（通常15分間隔。処理待ちで遅れる場合があります）。";
  let status = "unknown";
  try {
    const response = await fetch(base + "build.json", { cache: "no-store" });
    if (response.ok) {
      const deployed = await response.json();
      if (!deployed.fromCms)
        text =
          "公開サイトへの接続は準備中です。発行した内容はまだ反映されていません。";
      else if (Number(deployed.version) < Number(state.data?.version)) {
        status = "waiting";
        text =
          "発行内容のサイト反映待ちです。次の再構築で更新されます（通常15分間隔。遅れる場合があります）。";
      } else {
        status = "synced";
        text =
          "発行内容は公開サイトに反映済みです。最終更新：" +
          dateLabel(deployed.builtAt, true);
      }
    }
  } catch {
    /* 배포 상태 조회 실패가 성공한 저장 작업을 취소하지 않도록 합니다. */
  }
  if (version !== requestId || !role) return;
  const element = $("#publication-status");
  element.dataset.state = status;
  element.replaceChildren(
    icon(status === "synced" ? "check" : "clock"),
    node("span", text),
  );
}
async function show(
  resource: OfficePage,
  resetPage = true,
  initialFilter?: ListFilter,
) {
  if (
    !client ||
    !role ||
    (resource === "schedule"
      ? !scheduleEnabled || !["owner", "administrator", "coach"].includes(role)
      : resource !== "dashboard" &&
        (!resourceAvailable(resource) ||
          !resources[resource].roles.includes(role)))
  )
    return;
  if (!resetPage && resource === current && currentList) {
    await Promise.all([publicationStatus(), currentList.refresh()]);
    return;
  }
  currentList?.dispose();
  currentList = null;
  current = resource;
  const version = ++requestId;
  const info = officePages[resource];
  const title =
    resource === "dashboard"
      ? "ダッシュボード"
      : resource === "schedule"
        ? "統合カレンダー"
        : resources[resource].label;
  $("#resource-title").textContent = title;
  $("#header-page-title").textContent = title;
  $("#page-eyebrow").textContent = info.group + " / " + info.english;
  $("#page-description").textContent = info.description;
  const newButton = $("#new-button");
  newButton.hidden = resource === "dashboard" || resource === "schedule";
  newButton.replaceChildren(
    icon("plus"),
    node(
      "span",
      resource === "admin_roles"
        ? "メンバーを招待"
        : resource === "articles"
          ? "ニュースを書く"
          : "新規登録",
    ),
  );
  $("#admin-navigation")
    .querySelectorAll<HTMLElement>("[data-resource]")
    .forEach((button) => {
      if (button.dataset.resource === resource)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  if (resource === "dashboard") {
    const loading = node(
      "div",
      "ダッシュボードを読み込み中…",
      "office-loading",
    );
    loading.prepend(icon("clock"));
    $("#admin-content").replaceChildren(loading);
    const content = await buildDashboard({
      client,
      role,
      userId: userId ?? "",
      email: $("#account-email").textContent ?? "",
      go: (next, filter) => {
        void run(() => show(next, true, filter));
      },
      create: (next) => {
        void run(() => createResource(next));
      },
      open: (next, row) => {
        void run(async () => {
          await show(next);
          await openEditor(row);
        });
      },
    });
    if (version !== requestId || !role) return;
    $("#admin-content").replaceChildren(content);
  } else if (resource === "schedule") {
    const calendar = createSchedule({
      client,
      isCurrent: () => version === requestId && Boolean(role),
      create: (next) => {
        void run(() => createResource(next));
      },
      open: (next, row) => {
        void run(async () => {
          await show(next);
          await openEditor(row);
        });
      },
    });
    currentList = calendar;
    $("#admin-content").replaceChildren(calendar.element);
    await calendar.refresh();
  } else {
    const list = createList({
      client,
      resource,
      base,
      initialFilter,
      isCurrent: () =>
        version === requestId && Boolean(role) && current === resource,
      open: (row) => {
        void run(() => openEditor(row));
      },
      remove: (row) => {
        removing = row;
        removeResource = resource;
        $("#delete-description").textContent =
          String(row[resources[resource].titleField] ?? "") + "を削除します。";
        $<HTMLDialogElement>("#delete-dialog").showModal();
      },
      create: () => {
        if (resource === "admin_roles")
          $<HTMLDialogElement>("#invite-dialog").showModal();
        else void run(() => openEditor(null));
      },
      onError: (error) => notice(message(error), true),
    });
    currentList = list;
    $("#admin-content").replaceChildren(list.element);
    await list.refresh();
  }
  if (version !== requestId || !role) return;
  await publicationStatus(version);
  $("#resource-title").focus();
}
async function createResource(resource: Resource) {
  await show(resource);
  if (current !== resource || !role) return;
  if (resource === "admin_roles")
    $<HTMLDialogElement>("#invite-dialog").showModal();
  else await openEditor(null);
}
async function choices(field: Field) {
  if (!client) return [];
  if (field.name === "player_id") {
    const response = await result(
      client
        .from("players")
        .select("id,internal_name,profile_consent,photo_consent")
        .order("internal_name"),
    );
    for (const player of response.data ?? [])
      playerConsents.set(String(player.id), player);
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
  if (!client || !role || current === "dashboard" || current === "schedule")
    return;
  const resource = current;
  const config = resources[resource];
  editor.dataset.resource = resource;
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
  const groupByField = new Map<string, HTMLElement>();
  const orderedFields: Field[] = [];
  for (const group of editorGroups[resource]) {
    if (
      !group.fields.some((name) =>
        config.fields.some((field) => field.name === name),
      )
    )
      continue;
    const section = node("section", "", "office-field-group");
    section.append(node("h3", group.label));
    if (group.hint) section.append(node("p", group.hint, "admin-help"));
    const body = node("div", "", "office-field-group-body");
    section.append(body);
    fields.append(section);
    for (const name of group.fields) {
      groupByField.set(name, body);
      const field = config.fields.find((item) => item.name === name);
      if (field) orderedFields.push(field);
    }
  }
  // 새 양식 필드를 추가해도 그룹을 빠뜨려 화면에서 사라지지 않게 합니다.
  orderedFields.push(
    ...config.fields.filter((field) => !groupByField.has(field.name)),
  );
  const choiceCache = new Map<string, ReturnType<typeof choices>>();
  const editorChoices = (field: Field) => {
    const key =
      field.type === "media" || field.type === "gallery"
        ? "approved-photos"
        : field.name;
    if (!choiceCache.has(key)) choiceCache.set(key, choices(field));
    return choiceCache.get(key)!;
  };
  for (const field of orderedFields) {
    if (row?.legacy_path && field.name === "consent_confirmed") continue;
    const container = node("div", "", "admin-field");
    if (
      ["textarea", "gallery"].includes(field.type ?? "") ||
      [
        "title",
        "internal_name",
        "display_name",
        "storage_path",
        "video_url",
        "source_url",
        "cover_path",
        "photo_path",
      ].includes(field.name)
    )
      container.classList.add("admin-field-wide");
    const label = node("label", field.label);
    const id = "field-" + field.name;
    label.htmlFor = id;
    if (field.type === "gallery") {
      const group = node("div", "", "admin-gallery-options");
      group.id = id;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", field.label);
      const selected = Array.isArray(row?.[field.name])
        ? (row?.[field.name] as string[])
        : [];
      for (const option of await editorChoices(field)) {
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
        for (const option of await editorChoices(field)) {
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
    (groupByField.get(field.name) ?? fields).append(container);
  }
  const meta = $("#editor-meta");
  if (scheduleEnabled && resource === "training_sessions")
    fields.append(recurrenceControls(row));
  meta.replaceChildren(
    node(
      "h3",
      config.canPublish.length || resource === "public_player_profiles"
        ? "保存と発行"
        : "保存設定",
    ),
  );
  meta.append(
    badge(
      row?.status ??
        (config.canPublish.length || resource === "public_player_profiles"
          ? "draft"
          : "内部専用"),
    ),
  );
  if (row?.updated_at)
    meta.append(
      node("p", "最終更新：" + dateLabel(row.updated_at, true), "admin-help"),
    );
  if (resource === "players" || resource === "public_player_profiles")
    meta.append(
      node(
        "p",
        row
          ? "選手UUID：" + String(row[config.key])
          : "選手の識別子は登録後も維持されます。",
        "admin-help",
      ),
    );
  if (resource === "public_player_profiles") {
    const hint = node("p", "", "admin-help");
    hint.id = "profile-consent-state";
    meta.append(hint);
  }
  if (config.canPublish.length || resource === "public_player_profiles")
    meta.append(
      node(
        "p",
        "保存・発行後、公開サイトの反映状態を別途ご確認ください。",
        "admin-help",
      ),
    );
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
  $("#editor-preview-actions").replaceChildren();
  if (resource === "articles")
    $("#editor-preview-actions").append(
      action(
        "公開前プレビュー",
        "admin-secondary",
        () => {
          void run(previewArticle);
        },
        "preview",
      ),
    );
  editorBaseline = editorSnapshot();
  editorDirty = false;
  updateProfileApproval();
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
    markEditorDirty();
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
  if (
    scheduleEnabled &&
    resource === "training_sessions" &&
    !editing &&
    Number(data.get("_repeat_count")) > 1
  ) {
    await result(
      client.rpc("create_training_series", {
        p_template: payload,
        p_interval_weeks: Number(data.get("_repeat_weeks")),
        p_occurrences: Number(data.get("_repeat_count")),
      }),
    );
  } else if (scheduleEnabled && resource === "training_sessions" && editing) {
    await result(
      client.rpc("update_training_occurrences", {
        p_id: editing.id,
        p_expected: editing.updated_at,
        p_patch: payload,
        p_scope: String(data.get("_repeat_scope") || "single"),
      }),
    );
  } else if (editing)
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
  editorDirty = false;
  editor.close();
  notice(
    status === "published"
      ? "発行しました。公開サイトの反映状態をご確認ください。"
      : "保存しました。",
  );
  await show(resource, false);
}

// 접기 설정은 이 브라우저에만 보관합니다. 모바일 드로어는 별도의 열린 상태와 포커스 범위를 사용합니다.
const smallScreen = window.matchMedia?.("(max-width: 767px)");
function syncSidebar() {
  const mobile = smallScreen?.matches ?? window.innerWidth <= 767;
  const sidebar = $("#admin-sidebar");
  const open = Boolean(role) && mobile && drawerOpen;
  sidebar.inert = !role || (mobile && !open);
  sidebar.setAttribute("aria-hidden", String(sidebar.inert));
  $("#sidebar-open").hidden = !role || !mobile;
  $("#sidebar-open").setAttribute("aria-expanded", String(open));
  $("#sidebar-backdrop").hidden = !open;
  document.body.dataset.drawerOpen = String(open);
}
function closeDrawer(restoreFocus = true) {
  drawerOpen = false;
  syncSidebar();
  if (restoreFocus && !$("#sidebar-open").hidden) $("#sidebar-open").focus();
}
function setSidebarCollapsed(collapsed: boolean) {
  document.body.dataset.sidebarCollapsed = String(collapsed);
  const button = $("#sidebar-collapse");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute(
    "aria-label",
    collapsed ? "サイドバーを展開する" : "サイドバーを折りたたむ",
  );
  button.replaceChildren(
    icon("collapse"),
    node("span", "サイドバーを折りたたむ", "button-label"),
  );
}
try {
  setSidebarCollapsed(
    localStorage.getItem("kansai-office-sidebar") === "collapsed",
  );
} catch {
  setSidebarCollapsed(false);
}
$("#sidebar-collapse").addEventListener("click", () => {
  const collapsed = document.body.dataset.sidebarCollapsed !== "true";
  setSidebarCollapsed(collapsed);
  try {
    localStorage.setItem(
      "kansai-office-sidebar",
      collapsed ? "collapsed" : "expanded",
    );
  } catch {
    /* 개인 모드에서도 메뉴는 정상 동작합니다. */
  }
});
$("#sidebar-open").addEventListener("click", () => {
  drawerOpen = true;
  syncSidebar();
  $("#sidebar-close").focus();
});
$("#sidebar-close").addEventListener("click", () => closeDrawer());
$("#sidebar-backdrop").addEventListener("click", () => closeDrawer());
smallScreen?.addEventListener("change", () => {
  drawerOpen = false;
  syncSidebar();
});
document.addEventListener("keydown", (event) => {
  if (!drawerOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== "Tab") return;
  const buttons = [
    ...$("#admin-sidebar").querySelectorAll<HTMLElement>(
      "button:not([disabled]),a[href]",
    ),
  ].filter((element) => getComputedStyle(element).display !== "none");
  const first = buttons[0],
    last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});
syncSidebar();
$("#logout-button").replaceChildren(
  icon("logout"),
  node("span", "ログアウト", "button-label"),
);

// 양식 값이 실제로 달라진 경우만 경고합니다. 미리보기·닫기·발행 처리는 모두 같은 편집 화면을 사용합니다.
function editorSnapshot(): string {
  return JSON.stringify(
    [...new FormData(editorForm).entries()].map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.name,
    ]),
  );
}
function markEditorDirty() {
  editorDirty = editor.open && editorSnapshot() !== editorBaseline;
}
function updateProfileApproval() {
  if (editResource !== "public_player_profiles") return;
  const playerId = $<HTMLSelectElement>("#field-player_id").value;
  const player = playerConsents.get(playerId);
  const needsPhotoConsent = Boolean(
    $<HTMLSelectElement>("#field-photo_path").value,
  );
  const approved = Boolean(
    player?.profile_consent && (!needsPhotoConsent || player.photo_consent),
  );
  $("#profile-consent-state").textContent = approved
    ? "選手の公開同意は確認済みです。公開内容をご確認ください。"
    : "発行には選手のプロフィール公開同意と、写真を使用する場合は写真の公開同意が必要です。選手登録画面でご確認ください。";
  const publish = editorForm.querySelector<HTMLButtonElement>(
    '[data-save-status="published"]',
  );
  if (publish) publish.disabled = !approved;
}
function closeEditor() {
  if (editorDirty) $<HTMLDialogElement>("#unsaved-dialog").showModal();
  else editor.close();
}
editorForm.addEventListener("input", markEditorDirty);
editorForm.addEventListener("change", () => {
  markEditorDirty();
  updateProfileApproval();
});
editor.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeEditor();
});
$("#unsaved-continue").addEventListener("click", () =>
  $<HTMLDialogElement>("#unsaved-dialog").close(),
);
$("#unsaved-discard").addEventListener("click", () => {
  editorDirty = false;
  $<HTMLDialogElement>("#unsaved-dialog").close();
  editor.close();
});
window.addEventListener("beforeunload", (event) => {
  if (!editorDirty || !editor.open) return;
  event.preventDefault();
});
$("#preview-close").addEventListener("click", () =>
  $<HTMLDialogElement>("#article-preview-dialog").close(),
);
async function previewArticle() {
  if (!client || editResource !== "articles") return;
  const data = new FormData(editorForm);
  const paths = [data.get("cover_path"), ...data.getAll("gallery_paths")];
  const sources = await imageSources(client, paths, base);
  const article = node("article", "", "office-news-preview");
  const category =
    resources.articles.fields
      .find((field) => field.name === "category")
      ?.options?.find((option) => option.value === data.get("category"))
      ?.label ?? "";
  article.append(
    node("p", category, "office-kicker"),
    node("h1", String(data.get("title") || "タイトル未入力")),
    node("p", String(data.get("summary") ?? ""), "office-preview-summary"),
  );
  const cover = sources.get(String(data.get("cover_path") ?? ""));
  if (cover) {
    const image = node("img");
    image.src = cover;
    image.alt = String(data.get("cover_alt") ?? "");
    article.append(image);
  }
  for (const paragraph of String(data.get("body") ?? "")
    .split(/\n\s*\n/)
    .filter(Boolean))
    article.append(node("p", paragraph));
  const gallery = node("div", "", "office-preview-gallery");
  for (const path of data.getAll("gallery_paths")) {
    const source = sources.get(String(path));
    if (!source) continue;
    const image = node("img");
    image.src = source;
    image.alt = "";
    gallery.append(image);
  }
  article.append(gallery);
  $("#article-preview-content").replaceChildren(article);
  $<HTMLDialogElement>("#article-preview-dialog").showModal();
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
  void run(() => save(event)).finally(() => {
    buttons.forEach((b) => {
      b.disabled = false;
    });
    updateProfileApproval();
  });
});
$("#editor-close").addEventListener("click", closeEditor);
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
