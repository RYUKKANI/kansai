import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffRole } from "../lib/content-types";
import { resources, type Field } from "../lib/admin-config";
import {
  action,
  node,
  badge,
  dateLabel,
  imageSources,
  selectFields,
  type Row,
} from "../lib/admin-ui";
import { text as t } from "../lib/i18n";
import { uploadOfficePhoto } from "./admin-photo";

export type PlayerEditor = {
  save(status: string): Promise<Row>;
  updateApproval(): void;
  dispose(): void;
};
type Options = {
  client: SupabaseClient;
  role: StaffRole;
  userId: string;
  base: string;
  player: Row | null;
  form: HTMLFormElement;
  fields: HTMLElement;
  meta: HTMLElement;
  actions: HTMLElement;
  changed(): void;
  isCurrent(): boolean;
};
async function data<T>(
  request: PromiseLike<{ data: T; error: unknown }>,
): Promise<T> {
  const response = await request;
  if (response.error) throw response.error;
  return response.data;
}

// [편집 안내] 화면만 하나로 합칩니다. 내부 선수/공개 프로필/사진의 저장 영역과 권한은 분리해서 유지합니다.
// 새로운 선수는 양식을 여는 동안 같은 UUID를 유지하므로 저장 재시도가 새 선수를 중복 생성하지 않습니다.
export async function attachPlayerEditor(
  o: Options,
): Promise<PlayerEditor | null> {
  const { client, role, form, fields, meta, actions, changed } = o;
  let active = true;
  const isCurrent = () => active && o.isCurrent();
  async function read<T>(request: PromiseLike<{ data: T; error: unknown }>) {
    try {
      return await data(request);
    } catch (error) {
      // 폐기된 편집기의 늦은 조회 오류로 새 계정의 화면을 덮지 않습니다.
      if (isCurrent()) throw error;
      return null;
    }
  }
  function assertCurrent() {
    if (!isCurrent()) throw new Error("player_editor_inactive");
  }
  const player = o.player
    ? ((await read(
        client
          .from("players")
          .select(selectFields("players"))
          .eq("id", o.player.id)
          .single(),
      )) as unknown as Row)
    : null;
  if (!isCurrent()) return null;
  const id = String(player?.id ?? crypto.randomUUID());
  const profile = player
    ? ((await read(
        client
          .from("public_player_profiles")
          .select(selectFields("public_player_profiles"))
          .eq("player_id", id)
          .maybeSingle(),
      )) as Row | null)
    : null;
  if (!isCurrent()) return null;
  const canApprove = ["owner", "administrator"].includes(role);
  let query = client
    .from("media_assets")
    .select(
      "id,title,kind,media_category,storage_path,legacy_path,alt_text,status,public_approved,published_at,updated_at,album_id",
    )
    .eq("kind", "photo")
    .eq("media_category", "player")
    .order("title");
  // 코치는 기존 사진 승인 권한을 얻지 않습니다. 기존 RLS와 함께 선택 후보도 공개 자료로 제한합니다.
  if (!canApprove)
    query = query
      .eq("status", "published")
      .eq("public_approved", true)
      .lte("published_at", new Date().toISOString());
  const photos = ((await read(query)) ?? []) as Row[];
  if (!isCurrent()) return null;
  const albumIds = [
    ...new Set(photos.map((photo) => photo.album_id).filter(Boolean)),
  ];
  const albums = albumIds.length
    ? await read(
        client
          .from("media_albums")
          .select("id")
          .in("id", albumIds)
          .eq("status", "published"),
      )
    : [];
  if (!isCurrent()) return null;
  const publicAlbums = new Set(albums?.map((album) => album.id));
  const availablePhotos = canApprove
    ? photos
    : photos.filter(
        (photo) => !photo.album_id || publicAlbums.has(photo.album_id),
      );
  let profilePhoto = profile?.photo_path
    ? photos.find(
        (photo) =>
          (photo.storage_path ?? photo.legacy_path) === profile.photo_path,
      )
    : null;
  if (profile?.photo_path && !profilePhoto) {
    // 예전 프로필의 사진이 다른 카테고리여도 기존 승인 사진과 갱신 시각을 보존합니다.
    profilePhoto = (await read(
      client
        .from("media_assets")
        .select("id,storage_path,legacy_path,alt_text,updated_at")
        .eq(
          String(profile.photo_path).startsWith("assets/")
            ? "legacy_path"
            : "storage_path",
          profile.photo_path,
        )
        .maybeSingle(),
    )) as Row | null;
    if (!isCurrent()) return null;
  }
  const registeredPhoto = photos.find(
    (photo) => photo.id === player?.photo_asset_id,
  );
  // 기존 공개 사진과 내부 사진이 다르면 공개 사진을 보여주되, 사진을 바꾸기 전에는 어느 연결도 덮어쓰지 않습니다.
  const initialPhoto = profile?.photo_path
    ? String(
        availablePhotos.find((photo) => photo.id === profilePhoto?.id)?.id ??
          "_existing",
      )
    : String(
        registeredPhoto?.id ?? (player?.photo_asset_id ? "_existing" : ""),
      );
  const initialPath =
    profile?.photo_path ??
    registeredPhoto?.storage_path ??
    registeredPhoto?.legacy_path;
  let sources: Map<string, string>;
  try {
    sources = await imageSources(
      client,
      [
        ...photos.map((photo) => photo.storage_path ?? photo.legacy_path),
        initialPath,
      ],
      o.base,
    );
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  }
  // 다른 선수를 열거나 로그아웃한 뒤 늦게 도착한 응답으로 양식을 다시 만들지 않습니다.
  if (!isCurrent()) return null;
  const controls = new Map<
    string,
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >();
  function section(title: string, hint?: string): HTMLElement {
    const section = node("section", "", "office-field-group");
    section.append(node("h3", title));
    if (hint) section.append(node("p", hint, "admin-help"));
    const body = node("div", "", "office-field-group-body");
    section.append(body);
    fields.append(section);
    return body;
  }
  function add(body: HTMLElement, field: Field, value: unknown) {
    const wrap = node("div", "", "admin-field");
    if (
      ["textarea"].includes(field.type ?? "") ||
      ["internal_name", "display_name", "photo_alt_text"].includes(field.name)
    )
      wrap.classList.add("admin-field-wide");
    const label = node("label", field.label);
    const input =
      field.type === "textarea"
        ? node("textarea")
        : field.type === "select"
          ? node("select")
          : node("input");
    input.name = field.name;
    input.id = "field-" + field.name;
    label.htmlFor = input.id;
    if (input instanceof HTMLSelectElement) {
      if (field.name === "position") {
        const option = node("option", t("選択してください"));
        option.value = "";
        input.append(option);
      }
      for (const option of field.options ?? []) {
        const item = node("option", option.label);
        item.value = option.value;
        input.append(item);
      }
    }
    if (input instanceof HTMLInputElement) {
      input.type = field.type ?? "text";
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (["internal_name", "display_name"].includes(field.name))
        input.maxLength = 150;
      if (field.name === "photo_title") input.maxLength = 200;
      if (field.name === "slug") {
        input.pattern = "[a-z0-9]+(-[a-z0-9]+)*";
        input.maxLength = 120;
      }
    }
    input.required = Boolean(field.required);
    input.value = String(value ?? "");
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      input.checked = value === true;
      label.classList.add("admin-checkbox");
      label.prepend(input);
      wrap.append(label);
    } else wrap.append(label, input);
    if (field.hint) wrap.append(node("p", field.hint, "admin-help"));
    body.append(wrap);
    controls.set(field.name, input);
    return input;
  }
  const registration = section(
    t("選手の登録情報"),
    t(
      "内部の選手名は運営専用です。公開する名前は下のプロフィールで入力します。",
    ),
  );
  for (const name of ["internal_name", "activity_status"]) {
    const field = resources.players.fields.find(
      (field) => field.name === name,
    )!;
    add(
      registration,
      { ...field, hint: undefined },
      player?.[name] ?? (name === "activity_status" ? "active" : ""),
    );
  }
  const profileFields = section(
    t("公開するプロフィール"),
    t(
      "プロフィールを入力すると、選手登録・写真と一緒に保存します。空欄なら登録情報だけを保存できます。",
    ),
  );
  for (const name of [
    "display_name",
    "romanized_name",
    "jersey_number",
    "position",
    "bio",
    "slug",
    "display_order",
  ]) {
    const field = resources.public_player_profiles.fields.find(
      (field) => field.name === name,
    )!;
    const value =
      profile?.[name] ??
      (name === "slug" ? "player-" + id : name === "display_order" ? 0 : "");
    const input = add(profileFields, { ...field, required: false }, value);
    if (name === "slug" && profile?.published_at) {
      (input as HTMLInputElement).readOnly = true;
    }
  }
  add(
    profileFields,
    {
      ...resources.public_player_profiles.fields.find(
        (field) => field.name === "activity_status",
      )!,
      name: "public_activity_status",
    },
    profile?.activity_status ?? player?.activity_status ?? "active",
  );

  const photoFields = section(
    t("選手写真"),
    t(
      "この画面で写真を追加できます。新しい写真は「選手写真」に自動分類し、プロフィールにも設定します。",
    ),
  );
  const photoWrap = node("div", "", "admin-field admin-field-wide");
  const photoLabel = node("label", t("登録済みの選手写真"));
  const photo = node("select");
  photo.name = "photo_asset_id";
  photo.id = "field-photo_asset_id";
  photoLabel.htmlFor = photo.id;
  const empty = node("option", t("写真なし"));
  empty.value = "";
  photo.append(empty);
  for (const row of availablePhotos) {
    const option = node(
      "option",
      String(row.title) +
        (row.status === "published" ? "" : " · " + t("下書き")),
    );
    option.value = String(row.id);
    photo.append(option);
  }
  if (initialPhoto === "_existing") {
    const current = node("option", t("現在の写真（変更せず保持）"));
    current.value = "_existing";
    photo.append(current);
  }
  photo.value = initialPhoto;
  const preview = node("div", "", "office-player-photo-preview");
  const uploadState = node("p", "", "admin-help");
  uploadState.setAttribute("aria-live", "polite");
  photoWrap.append(photoLabel, photo, preview, uploadState);
  photoFields.append(photoWrap);
  let fileInput: HTMLInputElement | null = null;
  let file: File | null = null;
  let objectUrl: string | null = null;
  let uploaded: { id: string; path: string; file: File } | null = null;
  function revokePreview() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  function refreshPhoto() {
    revokePreview();
    preview.replaceChildren();
    const selected = photos.find((row) => row.id === photo.value);
    const path =
      photo.value === "_existing"
        ? initialPath
        : (selected?.storage_path ?? selected?.legacy_path);
    const src = file
      ? (objectUrl = URL.createObjectURL(file))
      : sources.get(String(path ?? ""));
    if (src) {
      const img = node("img");
      img.src = src;
      img.alt = file?.name ?? String(selected?.alt_text ?? "");
      preview.append(img);
    }
    uploadState.textContent = file
      ? t(
          "写真を選択しました。下の保存ボタンで登録情報・プロフィールと一緒に保存します。",
        )
      : "";
  }
  if (canApprove) {
    const upload = node("div", "", "admin-field admin-field-wide");
    const label = node(
      "label",
      t("写真をアップロード（JPEG・PNG・WebP、10MBまで）"),
    );
    fileInput = node("input");
    fileInput.type = "file";
    fileInput.name = "_player_photo_file";
    fileInput.id = "player-photo-upload";
    fileInput.accept = "image/jpeg,image/png,image/webp";
    label.htmlFor = fileInput.id;
    const uploadInfo = node("div", "", "office-player-upload-details");
    uploadInfo.hidden = true;
    add(uploadInfo, { name: "photo_title", label: t("写真タイトル") }, "");
    add(
      uploadInfo,
      { name: "photo_alt_text", label: t("写真の説明（代替テキスト）") },
      "",
    );
    add(
      uploadInfo,
      { name: "photo_captured_on", label: t("撮影日"), type: "date" },
      "",
    );
    upload.append(label, fileInput, uploadInfo);
    photoFields.append(upload);
    fileInput.addEventListener("change", () => {
      file = fileInput?.files?.[0] ?? null;
      if (
        file &&
        (!["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
          file.size > 10485760)
      ) {
        fileInput!.setCustomValidity(
          t("JPEG・PNG・WebPの10MB以下の写真を選択してください。"),
        );
      } else fileInput!.setCustomValidity("");
      uploaded = null;
      uploadInfo.hidden = !file;
      controls.get("photo_title")!.required = Boolean(file);
      controls.get("photo_alt_text")!.required = Boolean(file);
      if (file) {
        // 공개 이름으로만 제목·대체 텍스트를 제안합니다. 운영진 전용 이름을 공개 사진 정보에 복제하지 않습니다.
        const name = controls.get("display_name")!.value.trim();
        if (!controls.get("photo_title")!.value)
          controls.get("photo_title")!.value = name || t("選手写真");
        if (!controls.get("photo_alt_text")!.value)
          controls.get("photo_alt_text")!.value = name;
        if (![...photo.options].some((option) => option.value === "_upload")) {
          const option = node("option", t("新しい写真（保存待ち）"));
          option.value = "_upload";
          photo.append(option);
        }
        photo.value = "_upload";
      } else {
        if (photo.value === "_upload") photo.value = initialPhoto;
        photo.querySelector('option[value="_upload"]')?.remove();
      }
      refreshPhoto();
      updateApproval();
      changed();
    });
    photo.addEventListener("change", () => {
      if (photo.value === "_upload") return;
      file = null;
      uploaded = null;
      fileInput!.value = "";
      fileInput!.setCustomValidity("");
      uploadInfo.hidden = true;
      controls.get("photo_title")!.required = false;
      controls.get("photo_alt_text")!.required = false;
      // 파일 입력을 비우면 이전 업로드 옵션도 제거해 빈 사진이 새 파일처럼 표시되지 않게 합니다.
      photo.querySelector('option[value="_upload"]')?.remove();
      refreshPhoto();
      updateApproval();
      changed();
    });
  } else
    photoFields.append(
      node(
        "p",
        t(
          "コーチは公開承認済みの選手写真を選べます。新しい写真の登録・承認はOwnerまたはAdministratorが行います。",
        ),
        "admin-help",
      ),
    );
  photo.addEventListener("change", () => {
    refreshPhoto();
    updateApproval();
  });
  refreshPhoto();
  const consent = section(
    t("公開同意の確認"),
    t("公開プロフィールと写真の同意を個別に確認します。"),
  );
  for (const name of ["profile_consent", "photo_consent"]) {
    const field = resources.players.fields.find(
      (field) => field.name === name,
    )!;
    add(
      consent,
      {
        ...field,
        hint:
          name === "photo_consent"
            ? t("写真・動画の掲載権限と本人の同意を確認済み")
            : undefined,
      },
      player?.[name] ?? false,
    );
  }
  meta.append(node("h3", t("保存と発行")), badge(profile?.status ?? "draft"));
  const consentState = node("p", "", "admin-help");
  consentState.id = "profile-consent-state";
  meta.append(
    node("p", t("選手UUID：") + id, "admin-help"),
    consentState,
    node(
      "p",
      t("選手登録・公開プロフィール・写真をまとめて保存します。"),
      "admin-help",
    ),
    node(
      "p",
      t("保存・発行後、公開サイトの反映状態を別途ご確認ください。"),
      "admin-help",
    ),
  );
  if (player?.updated_at)
    meta.append(
      node(
        "p",
        t("最終更新：") + dateLabel(player.updated_at, true),
        "admin-help",
      ),
    );
  const submit = (label: string, status: string, css = "admin-primary") => {
    const button = action(label, css);
    button.type = "submit";
    button.dataset.saveStatus = status;
    actions.append(button);
  };
  if (profile?.status === "published" && canApprove) {
    submit(t("更新して発行"), "published");
    submit(t("非公開で保存"), "draft", "admin-secondary");
  } else {
    submit(t("選手・プロフィール・写真を保存"), "draft");
    submit(t("承認待ちで保存"), "pending", "admin-secondary");
    if (canApprove) submit(t("発行する"), "published");
  }
  if (profile?.status === "published")
    actions.append(
      node(
        "p",
        t(
          "下書き・承認待ちで保存すると公開が取り消されます。サイトへの反映には再構築が必要です。",
        ),
        "admin-help",
      ),
    );
  function updateApproval() {
    const needsPhoto = Boolean(file || photo.value);
    const approved =
      (controls.get("profile_consent") as HTMLInputElement).checked &&
      (!needsPhoto ||
        (controls.get("photo_consent") as HTMLInputElement).checked);
    consentState.textContent = approved
      ? t("選手の公開同意は確認済みです。公開内容をご確認ください。")
      : t(
          "この画面でプロフィールと写真の公開同意を確認すると発行できます。保存だけでは公開されません。",
        );
    const publish = actions.querySelector<HTMLButtonElement>(
      '[data-save-status="published"]',
    );
    if (publish) publish.disabled = !approved;
  }
  async function save(status: string): Promise<Row> {
    assertCurrent();
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? "").trim();
    const person = {
      internal_name: text("internal_name"),
      activity_status: text("activity_status"),
      profile_consent: values.has("profile_consent"),
      photo_consent: values.has("photo_consent"),
    };
    const hasProfile = Boolean(
      profile ||
        [
          "display_name",
          "romanized_name",
          "jersey_number",
          "position",
          "bio",
        ].some((name) => text(name)),
    );
    if (!hasProfile && status !== "draft")
      throw new Error(t("公開する名前とポジションを入力してください。"));
    if (hasProfile && (!text("display_name") || !text("position")))
      throw new Error(t("公開する名前とポジションを入力してください。"));
    const profileValues = hasProfile
      ? {
          slug: text("slug"),
          display_name: text("display_name"),
          romanized_name: text("romanized_name"),
          jersey_number: text("jersey_number")
            ? Number(text("jersey_number"))
            : null,
          position: text("position"),
          bio: text("bio"),
          activity_status: text("public_activity_status"),
          display_order: Number(text("display_order") || 0),
        }
      : null;
    if (
      status === "published" &&
      (!canApprove ||
        !person.profile_consent ||
        ((file || photo.value) && !person.photo_consent))
    )
      throw new Error(t("プロフィールと写真の公開同意を確認してください。"));
    // 파일은 저장할 때 업로드합니다. DB 저장이 실패하면 재시도 시 같은 비공개 파일을 재사용합니다.
    if (file && uploaded?.file !== file) {
      const uploadingFile = file;
      const uploadingId = crypto.randomUUID();
      let path: string;
      try {
        path = await uploadOfficePhoto(client, o.userId, uploadingFile);
      } catch (error) {
        assertCurrent();
        throw error;
      }
      // 업로드는 Auth와 별도 요청입니다. 그 사이 계정·편집 화면이 바뀌었다면
      // 새 세션을 사용하는 저장 RPC를 보내지 않고 이전 편집기를 중단합니다.
      assertCurrent();
      if (file !== uploadingFile)
        throw new Error(t("選手写真の最新情報を確認してください。写真を選び直して保存してください。"));
      uploaded = {
        id: uploadingId,
        path,
        file: uploadingFile,
      };
    }
    assertCurrent();
    const selected = photos.find((row) => row.id === photo.value);
    const publishedPhoto = profilePhoto ?? registeredPhoto;
    const response = await data(
      client.rpc("save_player_office", {
        p_player_id: id,
        p_expected_player: player?.updated_at ?? null,
        p_expected_profile: profile?.updated_at ?? null,
        p_player: person,
        p_profile: profileValues,
        p_status: status || "draft",
        p_photo_changed: Boolean(file) || photo.value !== initialPhoto,
        p_photo_id:
          file || photo.value === "_existing" ? null : photo.value || null,
        p_expected_photo:
          selected?.updated_at ?? publishedPhoto?.updated_at ?? null,
        p_upload:
          file && uploaded
            ? {
                id: uploaded.id,
                storage_path: uploaded.path,
                title: text("photo_title"),
                alt_text: text("photo_alt_text"),
                captured_on: text("photo_captured_on") || null,
              }
            : null,
      }),
    );
    assertCurrent();
    return response as Row;
  }
  updateApproval();
  return {
    save,
    updateApproval,
    dispose() {
      active = false;
      revokePreview();
    },
  };
}
