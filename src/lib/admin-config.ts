import { text as t } from "./i18n";
import type { StaffRole } from "./content-types";
// [편집 안내] 관리자 양식의 필드·라벨을 한곳에서 관리합니다. 실제 권한은 SQL의 RLS가 적용합니다.
export type Resource =
  | "articles"
  | "players"
  | "public_player_profiles"
  | "fixtures"
  | "training_sessions"
  | "club_events"
  | "media_albums"
  | "media_assets"
  | "site_pages"
  | "admin_roles";
export interface Field {
  name: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "number"
    | "date"
    | "datetime-local"
    | "checkbox"
    | "select"
    | "media"
    | "player-photo"
    | "gallery";
  mediaCategory?: "player";
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  min?: number;
  max?: number;
}
export interface ResourceConfig {
  label: string;
  singular: string;
  titleField: string;
  key: "id" | "player_id" | "user_id";
  roles: StaffRole[];
  canPublish: StaffRole[];
  fields: Field[];
}
const contentRoles: StaffRole[] = ["owner", "administrator", "editor"];
const footballRoles: StaffRole[] = ["owner", "administrator", "coach"];
const allContent: StaffRole[] = ["owner", "administrator"];
const options = (...values: string[]) =>
  values.map((value) => ({
    value,
    label: t(
      (
        {
          owner: "Owner",
          administrator: "Administrator",
          editor: "Editor",
          coach: "Coach",
        } as Record<string, string>
      )[value] ?? value,
    ),
  }));
const slug: Field = {
  name: "slug",
  label: t("記事・プロフィールのURL"),
  required: true,
  hint: t("半角英数字とハイフン。初回発行後は変更できません。"),
};
const title: Field = { name: "title", label: t("タイトル"), required: true };
const statusHint = t("発行後、次回のサイト再構築で反映されます。");

export const resources: Record<Resource, ResourceConfig> = {
  articles: {
    label: t("ニュース"),
    singular: t("ニュース"),
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      slug,
      { name: "summary", label: t("概要"), type: "textarea", required: true },
      {
        name: "category",
        label: t("カテゴリー"),
        type: "select",
        options: [
          { value: "training", label: t("トレーニング") },
          { value: "club", label: t("クラブ") },
          { value: "match", label: t("試合") },
          { value: "announcement", label: t("お知らせ") },
        ],
      },
      {
        name: "body",
        label: t("本文"),
        type: "textarea",
        required: true,
        hint: t("空行で段落を分けます。HTMLは文字として扱います。"),
      },
      { name: "cover_path", label: t("代表写真"), type: "media" },
      {
        name: "cover_alt",
        label: t("写真の説明（代替テキスト）"),
        required: true,
      },
      {
        name: "gallery_paths",
        label: t("記事内の写真"),
        type: "gallery",
        hint: t("公開された写真を選択できます。"),
      },
      {
        name: "source_url",
        label: t("出典URL"),
        hint: t("HTTPSで始まる公式情報のURL"),
      },
      { name: "activity_date", label: t("活動日"), type: "date" },
      { name: "published_at", label: t("掲載日"), type: "datetime-local" },
      {
        name: "featured",
        label: t("トップの注目記事にする"),
        type: "checkbox",
      },
    ],
  },
  players: {
    label: t("選手の登録・同意"),
    singular: t("選手"),
    titleField: "internal_name",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      {
        name: "internal_name",
        label: t("管理用の選手名"),
        required: true,
        hint: t("内部専用です。公開プロフィールは別の画面で承認します。"),
      },
      {
        name: "activity_status",
        label: t("活動状態"),
        type: "select",
        options: [
          { value: "active", label: t("活動中") },
          { value: "inactive", label: t("活動休止") },
          { value: "former", label: t("以前在籍") },
        ],
      },
      {
        name: "photo_asset_id",
        label: t("選手写真"),
        type: "player-photo",
        mediaCategory: "player",
        hint: t(
          "選手カテゴリーの公開承認済み写真を選びます。公開プロフィール作成時に自動入力します。登録だけではプロフィールは公開されません。",
        ),
      },
      {
        name: "profile_consent",
        label: t("プロフィールの公開同意を確認済み"),
        type: "checkbox",
      },
      {
        name: "photo_consent",
        label: t("写真の公開同意を確認済み"),
        type: "checkbox",
      },
    ],
  },
  public_player_profiles: {
    label: t("公開プロフィール"),
    singular: t("プロフィール"),
    titleField: "display_name",
    key: "player_id",
    roles: footballRoles,
    canPublish: allContent,
    fields: [
      {
        name: "player_id",
        label: t("選手UUID"),
        type: "select",
        required: true,
        hint: t("登録済み選手の変わらない識別子です。"),
      },
      slug,
      { name: "display_name", label: t("公開する名前"), required: true },
      { name: "romanized_name", label: t("ローマ字表記") },
      {
        name: "jersey_number",
        label: t("背番号"),
        type: "number",
        min: 0,
        max: 99,
      },
      {
        name: "position",
        label: t("ポジション"),
        type: "select",
        options: options("GK", "DF", "MF", "FW"),
      },
      {
        name: "photo_path",
        label: t("プロフィール写真"),
        type: "media",
        mediaCategory: "player",
      },
      { name: "bio", label: t("選手紹介"), type: "textarea" },
      {
        name: "activity_status",
        label: t("公開する活動状態"),
        type: "select",
        options: [
          { value: "active", label: t("活動中") },
          { value: "inactive", label: t("活動休止") },
          { value: "former", label: t("以前在籍") },
        ],
      },
      {
        name: "display_order",
        label: t("表示順（小さい順）"),
        type: "number",
        min: 0,
      },
    ],
  },
  fixtures: {
    label: t("試合"),
    singular: t("試合"),
    titleField: "opponent",
    key: "id",
    roles: footballRoles,
    canPublish: footballRoles,
    fields: [
      { name: "opponent", label: t("対戦相手"), required: true },
      { name: "competition", label: t("大会名") },
      {
        name: "kickoff_at",
        label: t("キックオフ（日本時間）"),
        type: "datetime-local",
      },
      { name: "venue", label: t("会場") },
      {
        name: "home_away",
        label: t("ホーム・アウェイ"),
        type: "select",
        options: [
          { value: "home", label: t("ホーム") },
          { value: "away", label: t("アウェイ") },
          { value: "neutral", label: t("中立地") },
        ],
      },
      {
        name: "match_status",
        label: t("試合の状態"),
        type: "select",
        options: [
          { value: "scheduled", label: t("開催予定") },
          { value: "completed", label: t("試合終了") },
          { value: "postponed", label: t("延期") },
          { value: "cancelled", label: t("中止") },
        ],
      },
      { name: "own_score", label: t("得点（関西）"), type: "number", min: 0 },
      {
        name: "opponent_score",
        label: t("得点（相手）"),
        type: "number",
        min: 0,
      },
      { name: "opponent_logo_path", label: t("相手エンブレム"), type: "media" },
      {
        name: "report",
        label: t("試合レポート"),
        type: "textarea",
        hint: t("空行で段落を分けます。"),
      },
    ],
  },
  training_sessions: {
    label: t("練習予定"),
    singular: t("練習"),
    titleField: "title",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      title,
      {
        name: "starts_at",
        label: t("開始（日本時間）"),
        type: "datetime-local",
        required: true,
      },
      { name: "ends_at", label: t("終了（日本時間）"), type: "datetime-local" },
      { name: "venue", label: t("場所") },
      {
        name: "session_status",
        label: t("状態"),
        type: "select",
        options: [
          { value: "scheduled", label: t("開催予定") },
          { value: "completed", label: t("実施済み") },
          { value: "cancelled", label: t("中止") },
        ],
      },
      { name: "notes", label: t("運営メモ（内部専用）"), type: "textarea" },
    ],
  },
  club_events: {
    label: t("クラブ行事"),
    singular: t("行事"),
    titleField: "title",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      title,
      {
        name: "starts_at",
        label: t("開始（日本時間）"),
        type: "datetime-local",
        required: true,
      },
      { name: "ends_at", label: t("終了（日本時間）"), type: "datetime-local" },
      { name: "venue", label: t("場所") },
      {
        name: "session_status",
        label: t("状態"),
        type: "select",
        options: [
          { value: "scheduled", label: t("開催予定") },
          { value: "completed", label: t("実施済み") },
          { value: "cancelled", label: t("中止") },
        ],
      },
      {
        name: "is_public",
        label: t("公式サイトに日程を公開する"),
        type: "checkbox",
      },
      {
        name: "public_description",
        label: t("公開する案内"),
        type: "textarea",
      },
      { name: "notes", label: t("運営メモ（内部専用）"), type: "textarea" },
    ],
  },
  media_albums: {
    label: t("アルバム"),
    singular: t("アルバム"),
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      { name: "description", label: t("説明"), type: "textarea" },
      { name: "captured_on", label: t("撮影日"), type: "date" },
    ],
  },
  media_assets: {
    label: t("写真・動画"),
    singular: t("メディア"),
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      {
        name: "media_category",
        label: t("写真カテゴリー"),
        type: "select",
        options: [
          { value: "general", label: t("その他") },
          { value: "player", label: t("選手写真") },
          { value: "match", label: t("試合写真") },
          { value: "training", label: t("練習写真") },
        ],
      },
      {
        name: "kind",
        label: t("種類"),
        type: "select",
        options: [
          { value: "photo", label: t("写真") },
          { value: "video", label: t("動画URL") },
        ],
      },
      {
        name: "storage_path",
        label: t("アップロードした写真"),
        hint: t("上の写真アップロードで自動入力します。"),
      },
      { name: "video_url", label: t("動画URL（YouTube対応）") },
      { name: "album_id", label: t("アルバム"), type: "select" },
      {
        name: "alt_text",
        label: t("写真の説明（代替テキスト）"),
        required: true,
      },
      { name: "description", label: t("説明"), type: "textarea" },
      { name: "captured_on", label: t("撮影日"), type: "date" },
      { name: "source_url", label: t("出典URL") },
      {
        name: "consent_confirmed",
        label: t("写真・動画の掲載権限と本人の同意を確認済み"),
        type: "checkbox",
        hint: t("確認前の素材は発行できません。"),
      },
    ],
  },
  site_pages: {
    label: t("クラブ・参加案内"),
    singular: t("案内ページ"),
    titleField: "title",
    key: "id",
    roles: allContent,
    canPublish: allContent,
    fields: [
      {
        name: "id",
        label: t("ページ"),
        type: "select",
        options: [
          { value: "club", label: t("クラブ紹介") },
          { value: "join", label: t("参加案内") },
        ],
        required: true,
      },
      title,
      { name: "introduction", label: t("導入文"), required: true },
      { name: "body", label: t("本文"), type: "textarea", required: true },
    ],
  },
  admin_roles: {
    label: t("運営メンバー"),
    singular: t("メンバー"),
    titleField: "email",
    key: "user_id",
    roles: ["owner"],
    canPublish: [],
    fields: [
      {
        name: "role",
        label: t("権限"),
        type: "select",
        options: [
          { value: "owner", label: "Owner" },
          { value: "administrator", label: "Administrator" },
          { value: "editor", label: "Editor" },
          { value: "coach", label: "Coach" },
        ],
      },
      {
        name: "active",
        label: t("管理者アクセスを有効にする"),
        type: "checkbox",
      },
    ],
  },
};
export { statusHint };
