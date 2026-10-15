import { text as t, format } from "../lib/i18n";
import { initLanguageSwitcher } from "./languages";
// 서버 HTML은 일본어 기본 화면입니다. 세션을 읽기 전에 선택한 언어의 안내를 적용합니다.
initLanguageSwitcher(true);
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
  selectFields,
  isStaffOfficePage,
  staffOfficePages,
  staffOfficeTitle,
  type StaffOfficePage,
} from "../lib/admin-ui";
import { mountStaffAuth } from "./staff-auth";
import type { StaffAccountState } from "../lib/staff-auth-types";
import { renderStaffOffice } from "./admin-staff";
import { buildDashboard } from "./admin-dashboard";
import { attachPlayerEditor, type PlayerEditor } from "./admin-player";
import { uploadOfficePhoto } from "./admin-photo";
import { createList, type ListController } from "./admin-list";
import { createSchedule, recurrenceControls } from "./admin-schedule";
import {
  attachContentEditor,
  contentResources,
  type ContentEditor,
} from "./admin-content";
import { clearUserDrafts } from "../lib/content-drafts";
import { attachTranslationEditor } from "./admin-translations";
import {
  readTranslations,
  translationComplete,
  contentForLanguage,
  contentLanguageNames,
  type ContentTranslations,
} from "../lib/content-translations";
import type { Locale } from "../lib/i18n";
import { contentEnabled, publisherEnabled } from "../lib/office-features";
import {
  configureOffice,
  resourceAvailable,
  scheduleEnabled,
  staffIdentityDatabaseEnabled,
} from "../lib/office-features";

// [편집 안내] 로그인 → 역할 확인 → 목록/대시보드 → 양식 저장 순서입니다.
// 화면을 숨기는 것과 별개로 모든 데이터 작업은 Supabase RLS로 다시 제한됩니다.
const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// 화면 전환은 배포 변수로 제어하고, 실제 승인·권한 제한은 항상 DB가 검사합니다.
const staffIdentityUiEnabled = import.meta.env.PUBLIC_STAFF_IDENTITY_ENABLED === "true";
// 저장한 HTML은 화면 검토용입니다. 로그인과 실제 편집은 웹 주소에서만 실행합니다.
const onWeb = ["https:", "http:"].includes(window.location.protocol);
const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(t("管理画面を読み直してください。"));
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
let currentStaff: Awaited<ReturnType<typeof renderStaffOffice>> | null = null;
let staffAuth: ReturnType<typeof mountStaffAuth> | null = null;
let ownIdentity: StaffAccountState | null = null;
let staffIdentityAvailable = false;
let authenticationVersion = 0;
let editorBaseline = "";
let editorDirty = false;
let editorSaving = false;
let contentEditor: ContentEditor | null = null;
let playerEditor: PlayerEditor | null = null;
let playerEditorRequest = 0;
let drawerOpen = false;
const playerConsents = new Map<string, Row>();
let editing: Row | null = null;
type EditorContext = {
  resource: Resource;
  defaults?: Row;
  locked?: Row;
};
let editorContext: EditorContext | null = null;
let pendingEditorAction: (() => Promise<void>) | null = null;
let editResource: Resource | null = null;
let removing: Row | null = null;
let removeResource: Resource | null = null;
let requestId = 0;
const editor = $<HTMLDialogElement>("#editor-dialog");
const editorForm = $<HTMLFormElement>("#editor-form");
function notice(text: string, error = false) {
  // 열린 대화상자 안에서도 저장 실패와 업로드 안내를 읽을 수 있게 합니다.
  const localNotice = document.querySelector<HTMLElement>("#editor-notice");
  if (localNotice) {
    localNotice.textContent = editor.open ? text : "";
    localNotice.dataset.error = String(error);
  }
  const element = $("#admin-notice");
  element.replaceChildren();
  if (text) {
    const close = action(t("閉じる"), "office-notice-close", () =>
      element.replaceChildren(),
    );
    close.setAttribute("aria-label", t("通知を閉じる"));
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
        : t("操作を完了できませんでした。");
  const code = errorCode(error);
  if (["signup_disabled", "email_not_confirmed"].includes(code))
    return t(
      "初回は招待・確認メールのリンクを開いてください。招待されたメールアドレスもご確認ください。",
    );
  if (code === "invalid_credentials")
    return t(
      "メールアドレスまたはパスワードをご確認ください。パスワードを設定していない場合はメールリンクをご利用ください。",
    );
  if (["over_email_send_rate_limit", "over_request_rate_limit"].includes(code))
    return t(
      "メールの送信回数に制限がかかっています。少し時間をおいてから再度お試しください。",
    );
  if (code === "otp_expired")
    return t(
      "メールリンクの有効期限が切れているか、すでに使用されています。最新のメールをご確認ください。",
    );
  if (code === "email_address_not_authorized")
    return t(
      "メールを送信できません。運営責任者にメール送信設定をご確認ください。",
    );
  if (
    code === "42501" ||
    /row-level|permission denied|owner role|active staff/i.test(raw)
  )
    return t("この操作に必要な権限がありません。運営責任者にご確認ください。");
  if (/last owner/i.test(raw))
    return t("最後のOwnerは無効化・削除できません。");
  if (code === "40001" || /content changed|schedule changed/i.test(raw))
    return t(
      "ほかの操作で内容が更新されています。編集画面を閉じて最新の内容を開き直してください。一時保存の内容は復元時に照合できます。",
    );
  if (/scheduled publisher is not enabled/i.test(raw))
    return t(
      "予約発行はまだ有効になっていません。下書き保存をご利用ください。",
    );
  if (/schedule must be in the next year/i.test(raw))
    return t("予約日時は現在より後、1年以内で指定してください。");
  if (/future series occurrence/i.test(raw))
    return t("全体変更は未来の未実施回を選んで行ってください。");
  if (/profile consent/i.test(raw))
    return t("先に選手登録画面でプロフィールの公開同意を確認してください。");
  if (/photo consent/i.test(raw))
    return t("先に選手登録画面で写真の公開同意を確認してください。");
  if (/incomplete translation/i.test(raw))
    return t(
      "入力途中の翻訳があります。全項目を完成させるか、その言語を空欄にしてから発行してください。",
    );
  if (/invalid translation/i.test(raw))
    return t("翻訳の入力内容を確認してください。");
  if (/player photo must/i.test(raw))
    return t("選手カテゴリーの公開承認済み写真を選択してください。");
  if (/photo description is required/i.test(raw))
    return t("写真の説明を入力してください。");
  if (/player photo is unavailable|player category photo required/i.test(raw))
    return t(
      "選手写真の最新情報を確認してください。写真を選び直して保存してください。",
    );
  if (/album must be approved/i.test(raw))
    return t("使用するアルバムを先に発行してください。");
  if (/photo upload is required/i.test(raw))
    return t("写真をアップロードしてから発行してください。");
  if (/must be approved/i.test(raw))
    return t("使用する写真を先に発行してください。");
  if (/approval requires/i.test(raw))
    return t("プロフィールの発行はOwnerまたはAdministratorが承認します。");
  if (/published URL|UUID is immutable|record ID/i.test(raw))
    return t("発行済みのURLと識別子は変更できません。");
  if (/duplicate key/i.test(raw))
    return t(
      "同じURLまたは登録情報がすでにあります。既存の項目を編集してください。",
    );
  if (/foreign key/i.test(raw))
    return t(
      "関連するプロフィール・記録があるため削除できません。非公開または活動休止にしてください。",
    );
  if (/check constraint/i.test(raw))
    return t(
      "必須項目、写真の掲載確認、得点、日時などの入力を確認してください。",
    );
  if (/future publication/i.test(raw))
    return t("未来の日時で発行できません。下書きに保存してください。");
  return raw;
}
async function run(callback: () => Promise<void>) {
  try {
    await callback();
  } catch (error) {
    notice(message(error), true);
    if (role && errorCode(error) === "42501") {
      resetLogin();
      void authenticate().catch(() => resetLogin());
    }
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
function resetLogin(invalidateRequests = true) {
  // 로그아웃 직전에 시작한 비동기 권한 조회가 비공개 화면을 다시 열지 못하게 합니다.
  if (invalidateRequests) authenticationVersion++;
  currentStaff?.dispose();
  currentStaff = null;
  ownIdentity = null;
  staffIdentityAvailable = false;
  staffAuth?.showLogin();
  playerEditorRequest++;
  playerEditor?.dispose();
  playerEditor = null;
  contentEditor?.dispose();
  contentEditor = null;
  if (userId) {
    try {
      clearUserDrafts(localStorage, userId);
    } catch {
      /* 저장소 접근이 차단돼도 로그아웃은 완료합니다. */
    }
  }
  configureOffice({});
  role = null;
  userId = null;
  editing = null;
  removing = null;
  requestId++;
  currentList?.dispose();
  currentList = null;
  editResource = null;
  editorContext = null;
  pendingEditorAction = null;
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
  const attempt = ++authenticationVersion;
  const { data, error } = await client.auth.getUser();
  if (attempt !== authenticationVersion) return;
  if (error || !data.user) {
    resetLogin();
    return;
  }
  let identity: StaffAccountState | null = null;
  if (staffIdentityUiEnabled) {
    // 가입 대기자는 역할·선수·콘텐츠를 조회하기 전에 본인 상태만 받습니다.
    const response = await client.rpc("office_account_state");
    if (attempt !== authenticationVersion) return;
    const value = response.data;
    if (response.error || !value || typeof value !== "object" || Array.isArray(value) || value.user_id !== data.user.id) {
      resetLogin();
      notice(t("アカウントの確認を完了できません。時間をおいて再度お試しください。"), true);
      return;
    }
    identity = value as unknown as StaffAccountState;
    // 메일 확인 생략도 서버가 정한 정책입니다. 이 경우에도 현재 승인·활성 역할이 모두 필요합니다.
    const allowed = identity.active === true && Boolean(identity.role) &&
      (identity.legacy_account === true || (identity.approval_status === "approved" &&
        (identity.email_confirmation_required === false || identity.email_confirmed === true)));
    if (!allowed) {
      resetLogin();
      ownIdentity = identity;
      staffAuth?.showAccount(identity);
      return;
    }
  }
  const membership = await result(
    client
      .from("admin_roles")
      .select("user_id,email,role,active")
      .eq("user_id", data.user.id)
      .maybeSingle(),
  );
  if (attempt !== authenticationVersion) return;
  if (
    !membership.data?.active ||
    !["owner", "administrator", "editor", "coach"].includes(
      membership.data.role,
    )
  ) {
    resetLogin();
    notice(t("このアカウントには運営メンバーのアクセス権がありません。"), true);
    return;
  }
  const unchanged =
    role === membership.data.role &&
    userId === data.user.id &&
    !$("#workspace").hidden;
  if (role && role !== membership.data.role) resetLogin(false);
  role = membership.data.role as StaffRole;
  userId = data.user.id;
  ownIdentity = identity;
  const approvedName = identity?.approved_real_name;
  $("#account-email").textContent = staffIdentityUiEnabled
    ? (approvedName || t("実名確認前のアカウント"))
    : (data.user.email ?? membership.data.email);
  $("#account-role").textContent = roleLabels[role] ?? role;
  $("#account-avatar").textContent = (approvedName || (staffIdentityUiEnabled ? "KU" : data.user.email) || "KU")
    .slice(0, 2)
    .toUpperCase();
  $("#header-account").hidden = false;
  $("#office-breadcrumb").hidden = false;
  document.body.dataset.authenticated = "true";
  $("#login-panel").hidden = true;
  $("#workspace").hidden = false;
  staffAuth?.hide();
  syncSidebar();
  // 토큰 갱신 때 진행 중인 검색·달력·편집 화면을 덮어쓰지 않습니다.
  if (unchanged) return;
  const capabilities = await client.rpc("office_capabilities");
  if (attempt !== authenticationVersion) return;
  configureOffice(
    !capabilities.error &&
      capabilities.data &&
      !Array.isArray(capabilities.data)
      ? capabilities.data
      : {},
  );
  staffIdentityAvailable = staffIdentityUiEnabled && staffIdentityDatabaseEnabled;
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
      ...(staffIdentityAvailable ? staffOfficePages : []),
      ...Object.keys(resources),
    ] as OfficePage[]) {
      const info = officePages[name];
      const staffPage = isStaffOfficePage(name);
      const permitted = staffPage
        ? Boolean(role) && (name !== "staff_applications" || role === "owner")
        : name === "dashboard"
          ? Boolean(role)
          : name === "schedule"
            ? Boolean(role) && ["owner", "administrator", "coach"].includes(role!)
            : Boolean(role) && resourceAvailable(name) && resources[name].roles.includes(role!);
      if (
        name === "public_player_profiles" ||
        (staffIdentityDatabaseEnabled && name === "admin_roles") ||
        info.group !== group ||
        !permitted
      )
        continue;
      const label =
        staffPage
          ? staffOfficeTitle(name)
          : name === "dashboard"
          ? t("ダッシュボード")
          : name === "schedule"
            ? t("統合カレンダー")
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
  let text = t(
    "発行した内容は次のサイト再構築で反映されます（通常15分間隔。処理待ちで遅れる場合があります）。",
  );
  let status = "unknown";
  try {
    const response = await fetch(base + "build.json", { cache: "no-store" });
    if (response.ok) {
      const deployed = await response.json();
      if (
        !Number.isFinite(Number(deployed.version)) ||
        !Number.isFinite(Number(state.data?.version))
      )
        throw new Error(t("発行版を確認できません。"));
      if (!deployed.fromCms)
        text = t(
          "公開サイトへの接続は準備中です。発行した内容はまだ反映されていません。",
        );
      else if (scheduleEnabled && deployed.schedulesEnabled !== true) {
        status = "waiting";
        text = t(
          "公開予定のサイト連携は準備中です。保存した予定はまだホームページに表示されません。運営責任者に連携設定をご確認ください。",
        );
      } else if (Number(deployed.version) < Number(state.data?.version)) {
        status = "waiting";
        text = t(
          "発行内容のサイト反映待ちです。次の再構築で更新されます（通常15分間隔。遅れる場合があります）。",
        );
      } else {
        status = "synced";
        text =
          t("発行内容は公開サイトに反映済みです。最終更新：") +
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
  const archive = node(
    "a",
    t("公開資料の保存先：kansai-sub ↗"),
    "office-repository-link",
  );
  archive.href = "https://github.com/RYUKKANI/kansai-sub";
  archive.target = "_blank";
  archive.rel = "noopener noreferrer";
  element.append(archive);
}
async function show(
  resource: OfficePage,
  resetPage = true,
  initialFilter?: ListFilter,
) {
  if (isStaffOfficePage(resource)) {
    await showStaffPage(resource);
    return;
  }
  // 공개 프로필의 기존 대시보드 진입점도 선수 관리에 모읍니다. 저장 테이블과 권한은 분리해 유지합니다.
  if (resource === "public_player_profiles") {
    initialFilter = {
      ...initialFilter,
      profileStatus: initialFilter?.status,
      status: undefined,
    };
    resource = "players";
  }
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
  currentStaff?.dispose();
  currentStaff = null;
  currentList?.dispose();
  currentList = null;
  current = resource;
  const version = ++requestId;
  const info = officePages[resource];
  const title =
    resource === "dashboard"
      ? t("ダッシュボード")
      : resource === "schedule"
        ? t("統合カレンダー")
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
        ? t("メンバーを招待")
        : resource === "articles"
          ? t("ニュースを書く")
          : t("新規登録"),
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
      t("ダッシュボードを読み込み中…"),
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
          await openEditor(row, { resource: next });
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
        $("#delete-description").textContent = format(
          "{0}を削除します。",
          String(row[resources[resource].titleField] ?? ""),
        );
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
    if (resource === "players") {
      const help = node("div", "", "office-player-guide");
      help.append(
        node("strong", "PLAYER OFFICE"),
        node(
          "p",
          t(
            "選手登録の画面で、公開プロフィールと写真も一緒に入力・保存できます。",
          ),
        ),
      );
      list.element.prepend(help);
    }
    await list.refresh();
  }
  if (version !== requestId || !role) return;
  await publicationStatus(version);
  $("#resource-title").focus();
}
async function showStaffPage(page: StaffOfficePage) {
  if (!client || !role || !userId || !staffIdentityAvailable ||
      (page === "staff_applications" && role !== "owner")) return;
  currentList?.dispose();
  currentList = null;
  currentStaff?.dispose();
  currentStaff = null;
  const version = ++requestId;
  current = page;
  const title = staffOfficeTitle(page);
  const info = officePages[page];
  $("#resource-title").textContent = title;
  $("#header-page-title").textContent = title;
  $("#page-eyebrow").textContent = info.group + " / " + info.english;
  $("#page-description").textContent = info.description;
  $("#new-button").hidden = true;
  $("#publication-status").replaceChildren();
  $("#admin-navigation").querySelectorAll<HTMLElement>("[data-resource]").forEach((button) => {
    if (button.dataset.resource === page) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const controller = await renderStaffOffice({
    client, container: $("#admin-content"), page, role, userId,
    notice,
    isCurrent: () => version === requestId && Boolean(role) && current === page,
    refresh: authenticate,
  });
  if (version !== requestId || !role) { controller.dispose(); return; }
  currentStaff = controller;
  if (page === "staff_account" && ownIdentity && !ownIdentity.identity_enrolled) {
    const identity = ownIdentity;
    $("#admin-content").prepend(action(t("既存のアカウントにログインIDを登録"), "admin-primary", () => {
      // 기존 UUID·역할을 유지한 채 본인 확인 세션에서만 아이디를 연결합니다.
      requestId++;
      currentStaff?.dispose();
      currentStaff = null;
      $("#workspace").hidden = true;
      $("#login-panel").hidden = false;
      staffAuth?.showMigration(identity);
    }));
  }
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
        .select("id,internal_name,profile_consent,photo_consent,photo_asset_id")
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
      { value: "", label: t("アルバムなし") },
      ...(response.data ?? []).map((p) => ({ value: p.id, label: p.title })),
    ];
  }
  if (["media", "gallery", "player-photo"].includes(field.type ?? "")) {
    let query = client
      .from("media_assets")
      .select("id,storage_path,legacy_path,title,album_id")
      .eq("kind", "photo")
      .eq("status", "published")
      .eq("public_approved", true)
      .lte("published_at", new Date().toISOString());
    if (field.mediaCategory)
      query = query.eq("media_category", field.mediaCategory);
    const response = await result(query);
    const albumIds = [
      ...new Set((response.data ?? []).map((p) => p.album_id).filter(Boolean)),
    ];
    const albums = albumIds.length
      ? await result(
          client
            .from("media_albums")
            .select("id")
            .in("id", albumIds)
            .eq("status", "published"),
        )
      : null;
    const approvedAlbums = new Set(albums?.data?.map((album) => album.id));
    return (response.data ?? [])
      .filter((p) => !p.album_id || approvedAlbums.has(p.album_id))
      .map((p) => ({
        value:
          field.type === "player-photo"
            ? p.id
            : (p.storage_path ?? p.legacy_path),
        label: p.title,
        path: p.storage_path ?? p.legacy_path,
        assetId: p.id,
      }));
  }
  return field.options ?? [];
}
// 선수 등록·사진·프로필은 같은 창과 하나의 저장 처리를 사용합니다.
async function openUnifiedPlayer(row: Row | null) {
  if (!client || !role || !userId) return;
  const version = ++playerEditorRequest;
  playerEditor?.dispose();
  playerEditor = null;
  contentEditor?.dispose();
  contentEditor = null;
  editorContext = null;
  pendingEditorAction = null;
  editing = row;
  editResource = "players";
  editor.dataset.resource = "players";
  $("#editor-title").textContent = format(
    row ? "{0}を編集" : "{0}を登録",
    resources.players.singular,
  );
  $("#editor-notice").textContent = "";
  $("#editor-fields").replaceChildren();
  $("#editor-meta").replaceChildren();
  $("#editor-actions").replaceChildren();
  $("#editor-content-tools").replaceChildren();
  $("#editor-preview-actions").replaceChildren();
  editorForm.reset();
  const prepared = await attachPlayerEditor({
    client,
    role,
    userId,
    base,
    player: row,
    form: editorForm,
    fields: $("#editor-fields"),
    meta: $("#editor-meta"),
    actions: $("#editor-actions"),
    changed: markEditorDirty,
    isCurrent: () =>
      version === playerEditorRequest &&
      Boolean(role) &&
      editResource === "players",
  });
  if (!prepared) return;
  playerEditor = prepared;
  if (!editor.open) editor.showModal();
  editorBaseline = editorSnapshot();
  editorDirty = false;
}
// 타입 가드는 사용하지 않습니다. 공통 양식의 Resource 타입을 유지하면서 선수만 전용 편집기에 연결합니다.
function isPlayerResource(resource: Resource): boolean {
  return resource === "players" || resource === "public_player_profiles";
}
async function openEditor(
  row: Row | null,
  context: EditorContext | null = null,
) {
  if (!client || !role || current === "dashboard" || current === "schedule" || isStaffOfficePage(current))
    return;
  const resource = context?.resource ?? current;
  if (!resources[resource].roles.includes(role)) return;
  if (isPlayerResource(resource)) {
    // 대시보드의 프로필 승인 항목도 같은 선수 양식으로 연결합니다.
    const selected =
      resource === "public_player_profiles" && row
        ? await result(
            client
              .from("players")
              .select(selectFields("players"))
              .eq("id", row.player_id)
              .single(),
          )
        : null;
    await openUnifiedPlayer(selected ? (selected.data as unknown as Row) : row);
    return;
  }
  playerEditorRequest++;
  playerEditor?.dispose();
  playerEditor = null;
  editorContext = context;
  pendingEditorAction = null;
  const values = { ...context?.defaults, ...row };
  $("#editor-notice").textContent = "";
  contentEditor?.dispose();
  contentEditor = null;
  const config = resources[resource];
  editor.dataset.resource = resource;
  editing = row;
  editResource = resource;
  $("#editor-title").textContent = format(
    row ? "{0}を編集" : "{0}を登録",
    config.singular,
  );
  const fields = $("#editor-fields");
  fields.replaceChildren();
  editorForm.reset();
  if (resource === "media_assets") {
    const upload = node("div", "", "admin-upload");
    const label = node(
      "label",
      t("写真をアップロード（JPEG・PNG・WebP、10MBまで）"),
    );
    const input = node("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    label.append(input);
    upload.append(
      label,
      node(
        "p",
        t(
          "表示用に圧縮して保存します。写真を発行する前に掲載権限を確認してください。",
        ),
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
    const key = ["media", "gallery", "player-photo"].includes(field.type ?? "")
      ? "approved-photos-" + field.type + "-" + (field.mediaCategory ?? "all")
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
        "photo_asset_id",
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
        ? (values[field.name] as string[])
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
          node("p", t("先に写真を登録して発行してください。"), "admin-help"),
        );
      container.append(label, group);
    } else {
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (field.type === "textarea") input = node("textarea");
      else if (["select", "media", "player-photo"].includes(field.type ?? "")) {
        input = node("select");
        if (field.type === "media" || field.type === "player-photo") {
          const empty = node("option", t("写真なし"));
          empty.value = "";
          input.append(empty);
        }
        for (const option of await editorChoices(field)) {
          const item = node("option", option.label);
          item.value = option.value;
          if ("assetId" in option)
            item.dataset.assetId = String(option.assetId);
          if ("path" in option) item.dataset.photoPath = String(option.path);
          input.append(item);
        }
        if (
          row?.[field.name] &&
          ![...input.options].some((item) => item.value === row[field.name])
        ) {
          const existing = node("option", t("現在の写真（選択候補外）"));
          existing.value = String(row[field.name]);
          input.append(existing);
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
            ? japanInput(values[field.name])
            : String(
                values[field.name] ??
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
      if (context?.locked && field.name in context.locked) {
        input.value = String(context.locked[field.name]);
        input.disabled = true;
        const locked = node("input");
        locked.type = "hidden";
        locked.name = field.name;
        locked.value = input.value;
        container.append(locked);
      }
    }
    if (field.hint) container.append(node("p", field.hint, "admin-help"));
    (groupByField.get(field.name) ?? fields).append(container);
    if (
      field.type === "player-photo" ||
      (field.name === "photo_path" && field.type === "media")
    ) {
      const select = container.querySelector<HTMLSelectElement>("select")!;
      const preview = node("div", "", "office-selected-photo");
      const selectedOptions = await editorChoices(field);
      const sources = await imageSources(
        client,
        selectedOptions.map((option) =>
          "path" in option ? option.path : option.value,
        ),
        base,
      );
      function refreshPhoto() {
        preview.replaceChildren();
        const option = select.selectedOptions[0];
        const source = sources.get(option?.dataset.photoPath ?? select.value);
        if (source) {
          const image = node("img");
          image.src = source;
          image.alt = option?.textContent ?? "";
          preview.append(image);
        }
        if (!selectedOptions.length)
          preview.append(
            node(
              "p",
              t(
                "選手写真がありません。写真・動画で「選手写真」を選び、写真を登録して発行してください。",
              ),
              "admin-help",
            ),
          );
      }
      select.addEventListener("change", refreshPhoto);
      container.append(preview);
      refreshPhoto();
    }
  }
  attachTranslationEditor(editorForm, fields, resource, row);
  let suggestInitialPhoto: (() => void) | null = null;
  if (resource === "public_player_profiles") {
    const player =
      fields.querySelector<HTMLSelectElement>('[name="player_id"]')!;
    const photo = fields.querySelector<HTMLSelectElement>(
      '[name="photo_path"]',
    )!;
    // 선수 등록에서 지정한 사진을 새 공개 프로필에 제안합니다. 기존 사진과 수동 선택은 덮어쓰지 않습니다.
    let suggestedPath: string | null = null;
    let applyingSuggestion = false;
    photo.addEventListener("change", () => {
      if (!applyingSuggestion) suggestedPath = null;
    });
    const suggestPhoto = () => {
      if (photo.value && photo.value !== suggestedPath) return;
      const assetId = playerConsents.get(player.value)?.photo_asset_id;
      const option = [...photo.options].find(
        (item) => item.dataset.assetId === assetId,
      );
      // 자동 제안 사진만 선수 변경에 맞춰 바꿉니다. 다른 선수를 선택했을 때 이전 선수의 사진을 남기지 않습니다.
      photo.value = option?.value ?? "";
      suggestedPath = photo.value || null;
      applyingSuggestion = true;
      photo.dispatchEvent(new Event("change", { bubbles: true }));
      applyingSuggestion = false;
    };
    player.addEventListener("change", suggestPhoto);
    if (!row) suggestInitialPhoto = suggestPhoto;
  }
  const meta = $("#editor-meta");
  if (scheduleEnabled && resource === "training_sessions")
    fields.append(recurrenceControls(row));
  meta.replaceChildren(
    node(
      "h3",
      config.canPublish.length || resource === "public_player_profiles"
        ? t("保存と発行")
        : t("保存設定"),
    ),
  );
  meta.append(
    badge(
      row?.status ??
        (config.canPublish.length || resource === "public_player_profiles"
          ? "draft"
          : t("内部専用")),
    ),
  );
  if (row?.updated_at)
    meta.append(
      node(
        "p",
        t("最終更新：") + dateLabel(row.updated_at, true),
        "admin-help",
      ),
    );
  if (resource === "players" || resource === "public_player_profiles")
    meta.append(
      node(
        "p",
        row
          ? t("選手UUID：") + String(row[config.key])
          : t("選手の識別子は登録後も維持されます。"),
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
        t("保存・発行後、公開サイトの反映状態を別途ご確認ください。"),
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
    save(t("下書き保存"), "draft");
    save(t("承認待ちで保存"), "pending");
    if (config.canPublish.includes(role))
      save(
        row?.status === "published" ? t("更新して発行") : t("発行する"),
        "published",
      );
    if (row?.status === "published")
      actions.append(
        node(
          "p",
          t(
            "下書き・承認待ち・予約で保存すると公開が取り消されます。サイトへの反映には再構築が必要です。",
          ),
          "admin-help",
        ),
      );
  } else save(t("保存"), "");
  if (row && resource === "public_player_profiles") {
    const button = action(t("非公開にする"), "admin-secondary");
    button.type = "submit";
    button.dataset.saveStatus = "draft";
    actions.append(button);
  }
  if (!editor.open) editor.showModal();
  if (contentEnabled && userId && contentResources.includes(resource)) {
    contentEditor = attachContentEditor({
      client,
      userId,
      resource,
      row,
      form: editorForm,
      container: $("#editor-content-tools"),
      publisher: publisherEnabled,
      changed: markEditorDirty,
      error: (error) => notice(message(error), true),
      restore: async (restored) => {
        editorDirty = false;
        await show(resource, false);
        await openEditor(restored);
        notice(
          t(
            "履歴から下書きとして復元しました。公開する内容を再確認してください。",
          ),
        );
      },
    });
  }
  $("#editor-preview-actions").replaceChildren();
  if (resource === "articles")
    $("#editor-preview-actions").append(
      action(
        t("公開前プレビュー"),
        "admin-secondary",
        () => {
          void run(previewArticle);
        },
        "preview",
      ),
    );
  suggestInitialPhoto?.();
  editorBaseline = editorSnapshot();
  editorDirty = false;
  updateProfileApproval();
}
async function uploadPhoto(input: HTMLInputElement) {
  if (!client || !userId || !input.files?.[0]) return;
  input.disabled = true;
  try {
    const path = await uploadOfficePhoto(client, userId, input.files[0]);
    $<HTMLInputElement>("#field-storage_path").value = path;
    $<HTMLSelectElement>("#field-kind").value = "photo";
    markEditorDirty();
    notice(
      t(
        "写真をアップロードしました。説明と掲載確認を入力し、保存してください。",
      ),
    );
  } finally {
    input.disabled = false;
  }
}
async function save(event: SubmitEvent) {
  event.preventDefault();
  if (!client || !role || !editResource) return;
  const resource = editResource;
  const status =
    (event.submitter as HTMLButtonElement | null)?.dataset.saveStatus ?? "";
  if (resource === "players") {
    if (!playerEditor) throw new Error(t("管理画面を読み直してください。"));
    await playerEditor.save(status);
    editorDirty = false;
    playerEditor.dispose();
    playerEditor = null;
    editor.close();
    notice(
      status === "published"
        ? t(
            "選手・プロフィール・写真を保存して発行しました。公開サイトの反映状態をご確認ください。",
          )
        : t(
            "選手・プロフィール・写真を保存しました。公開前の情報は内部専用です。",
          ),
    );
    await show("players", false);
    return;
  }
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
        "photo_asset_id",
        "captured_on",
      ].includes(field.name)
    ) {
      if (field.name.endsWith("_url") && text && !/^https:\/\//.test(text))
        throw new Error(t("URLはHTTPSで入力してください。"));
      payload[field.name] = text || null;
    } else payload[field.name] = text;
  }
  if (resource === "articles" || resource === "site_pages") {
    payload.translations = readTranslations(data, resource);
    if (["published", "scheduled"].includes(status))
      for (const value of Object.values(
        payload.translations as ContentTranslations,
      ))
        if (!translationComplete(value, resource))
          throw new Error(
            t(
              "入力途中の翻訳があります。全項目を完成させるか、その言語を空欄にしてから発行してください。",
            ),
          );
  }
  if (config.canPublish.length || resource === "public_player_profiles")
    payload.status = status === "scheduled" ? "draft" : status || "draft";
  if (resource === "media_assets") {
    if (payload.kind === "video") {
      payload.storage_path = null;
      payload.legacy_path = null;
    } else {
      payload.video_url = null;
      if (payload.storage_path) payload.legacy_path = null;
    }
  }
  if (contentEnabled && contentResources.includes(resource)) {
    const scheduled = String(data.get("_publish_at") || "");
    if (
      status === "scheduled" &&
      (!scheduled || new Date(scheduled + "+09:00").getTime() <= Date.now())
    )
      throw new Error(
        t("予約発行する未来の日時を日本時間で入力してください。"),
      );
    await result(
      client.rpc("save_office_content", {
        p_entity: resource,
        p_id: editing ? String(editing[config.key]) : null,
        p_expected: editing?.updated_at ?? null,
        p_values: payload,
        p_publish_at:
          status === "scheduled"
            ? new Date(scheduled + "+09:00").toISOString()
            : null,
      }),
    );
  } else if (
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
  } else if (editing) {
    await result(
      client
        .from(resource)
        .update(payload)
        .eq(config.key, editing[config.key])
        .select(selectFields(resource))
        .single(),
    );
  } else {
    await result(
      client
        .from(resource)
        .insert(payload)
        .select(selectFields(resource))
        .single(),
    );
  }
  editorDirty = false;
  contentEditor?.clear();
  editor.close();
  notice(
    status === "published"
      ? t("発行しました。公開サイトの反映状態をご確認ください。")
      : status === "scheduled"
        ? t(
            "予約を保存しました。予約時刻以降の発行と、公開サイトの反映は別に確認できます。",
          )
        : t("保存しました。"),
  );
  await show(editorContext ? current : resource, false);
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
    collapsed ? t("サイドバーを展開する") : t("サイドバーを折りたたむ"),
  );
  button.replaceChildren(
    icon("collapse"),
    node("span", t("サイドバーを折りたたむ"), "button-label"),
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
  node("span", t("ログアウト"), "button-label"),
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
  if (playerEditor && editResource === "players") {
    playerEditor.updateApproval();
    return;
  }
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
    ? t("選手の公開同意は確認済みです。公開内容をご確認ください。")
    : t(
        "発行には選手のプロフィール公開同意と、写真を使用する場合は写真の公開同意が必要です。選手登録画面でご確認ください。",
      );
  const publish = editorForm.querySelector<HTMLButtonElement>(
    '[data-save-status="published"]',
  );
  if (publish) publish.disabled = !approved;
}
function closeEditor() {
  if (editorSaving) {
    notice(t("保存中です。完了までお待ちください。"));
    return;
  }
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
editor.addEventListener("close", () => {
  playerEditor?.dispose();
  playerEditor = null;
});
$("#unsaved-continue").addEventListener("click", () => {
  pendingEditorAction = null;
  $<HTMLDialogElement>("#unsaved-dialog").close();
});
$("#unsaved-discard").addEventListener("click", () => {
  contentEditor?.clear();
  editorDirty = false;
  $<HTMLDialogElement>("#unsaved-dialog").close();
  editor.close();
  const next = pendingEditorAction;
  pendingEditorAction = null;
  if (next) void run(next);
});
window.addEventListener("beforeunload", (event) => {
  if (!editorDirty || !editor.open) return;
  event.preventDefault();
});
$("#preview-close").addEventListener("click", () =>
  $<HTMLDialogElement>("#article-preview-dialog").close(),
);
async function previewArticle(
  locale: Locale = (editorForm.dataset.contentLanguage as Locale) ?? "ja",
) {
  if (!client || editResource !== "articles") return;
  const data = new FormData(editorForm);
  const content = contentForLanguage(data, "articles", locale);
  const paths = [data.get("cover_path"), ...data.getAll("gallery_paths")];
  const sources = await imageSources(client, paths, base);
  const article = node("article", "", "office-news-preview");
  article.lang = locale;
  const languageLabel = node(
    "label",
    t("プレビューの言語"),
    "office-preview-language",
  );
  const languages = node("select");
  for (const language of ["ja", "ko", "en"] as const) {
    const option = node("option", contentLanguageNames[language]);
    option.value = language;
    languages.append(option);
  }
  languages.value = locale;
  languages.addEventListener("change", () => {
    void run(() => previewArticle(languages.value as Locale));
  });
  languageLabel.append(languages);
  const category =
    resources.articles.fields
      .find((field) => field.name === "category")
      ?.options?.find((option) => option.value === data.get("category"))
      ?.label ?? "";
  article.append(
    node("p", category, "office-kicker"),
    node("h1", content.title || t("タイトル未入力")),
    node("p", content.summary ?? "", "office-preview-summary"),
  );
  const cover = sources.get(String(data.get("cover_path") ?? ""));
  if (cover) {
    const image = node("img");
    image.src = cover;
    image.alt = content.cover_alt ?? "";
    article.append(image);
  }
  for (const paragraph of String(content.body ?? "")
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
  $("#article-preview-content").replaceChildren(languageLabel, article);
  const preview = $<HTMLDialogElement>("#article-preview-dialog");
  if (!preview.open) preview.showModal();
}

// Auth 콜백 안에서 다른 Auth 작업을 기다리면 멈출 수 있으므로 다음 이벤트에서 처리합니다.
if (!client) {
  $("#config-warning").hidden = false;
  if (!onWeb)
    $("#config-warning").textContent = t(
      "このファイルは画面確認用です。ログインと編集は公式サイトの管理画面をご利用ください。",
    );
  $("#login-panel")
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
    .forEach((element) => {
      element.disabled = true;
    });
} else {
  if (staffIdentityUiEnabled) {
    staffAuth = mountStaffAuth({ client, notice, refresh: authenticate });
    staffAuth.showLogin();
  } else {
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void runLogin(async () => {
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const password = String(data.get("password") ?? "");
      if (!password)
        throw new Error(
          t("パスワードを入力するか、メールリンクをご利用ください。"),
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
      // 이메일 인증의 기존 허용 주소는 유지하고, 언어 선택은 브라우저에서 기억합니다.
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
          t(
            "確認メールの送信を受け付けました。招待されたアドレスの受信箱・迷惑メールをご確認ください。メールが届かない場合は運営責任者にご確認ください。",
          ),
        );
        return;
      }
      if (response.error) throw response.error;
      notice(
        t(
          "ログインリンクを送信しました。招待されたメールの受信箱をご確認ください。",
        ),
      );
    });
  });
  }
  $("#logout-button").addEventListener("click", () => {
    void run(async () => {
      await result(client.auth.signOut());
      resetLogin();
      notice(t("ログアウトしました。"));
    });
  });
  let authPending = false;
  let authRefreshQueued = false;
  const refresh = () => {
    if (authPending) {
      authRefreshQueued = true;
      return;
    }
    authPending = true;
    setTimeout(() => {
      void run(authenticate).finally(() => {
        authPending = false;
        if (authRefreshQueued) {
          authRefreshQueued = false;
          refresh();
        }
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
  if (isStaffOfficePage(current)) return;
  if (current === "admin_roles" && staffIdentityDatabaseEnabled) return;
  if (current === "admin_roles")
    $<HTMLDialogElement>("#invite-dialog").showModal();
  else void run(() => openEditor(null));
});
editorForm.addEventListener("submit", (event) => {
  if (editorSaving) {
    event.preventDefault();
    return;
  }
  editorSaving = true;
  editorForm.inert = true;
  editorForm.setAttribute("aria-busy", "true");
  const buttons = editorForm.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => {
    b.disabled = true;
  });
  void run(() => save(event)).finally(() => {
    editorSaving = false;
    editorForm.inert = false;
    editorForm.removeAttribute("aria-busy");
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
    notice(t("削除しました。"));
    await show(removeResource, false);
  });
});
$("#invite-cancel").addEventListener("click", () =>
  $<HTMLDialogElement>("#invite-dialog").close(),
);
$("#invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    if (!client || role !== "owner" || staffIdentityDatabaseEnabled) return;
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
    notice(t("運営メンバーを招待しました。"));
    await show("admin_roles");
  });
});
