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
    | "gallery";
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
  values.map((value) => ({ value, label: value }));
const slug: Field = {
  name: "slug",
  label: "記事・プロフィールのURL",
  required: true,
  hint: "半角英数字とハイフン。初回発行後は変更できません。",
};
const title: Field = { name: "title", label: "タイトル", required: true };
const statusHint = "発行後、次回のサイト再構築で反映されます。";

export const resources: Record<Resource, ResourceConfig> = {
  articles: {
    label: "ニュース",
    singular: "ニュース",
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      slug,
      { name: "summary", label: "概要", type: "textarea", required: true },
      {
        name: "category",
        label: "カテゴリー",
        type: "select",
        options: [
          { value: "training", label: "トレーニング" },
          { value: "club", label: "クラブ" },
          { value: "match", label: "試合" },
          { value: "announcement", label: "お知らせ" },
        ],
      },
      {
        name: "body",
        label: "本文",
        type: "textarea",
        required: true,
        hint: "空行で段落を分けます。HTMLは文字として扱います。",
      },
      { name: "cover_path", label: "代表写真", type: "media" },
      {
        name: "cover_alt",
        label: "写真の説明（代替テキスト）",
        required: true,
      },
      {
        name: "gallery_paths",
        label: "記事内の写真",
        type: "gallery",
        hint: "公開された写真を選択できます。",
      },
      {
        name: "source_url",
        label: "出典URL",
        hint: "HTTPSで始まる公式情報のURL",
      },
      { name: "activity_date", label: "活動日", type: "date" },
      { name: "published_at", label: "掲載日", type: "datetime-local" },
      { name: "featured", label: "トップの注目記事にする", type: "checkbox" },
    ],
  },
  players: {
    label: "選手の登録・同意",
    singular: "選手",
    titleField: "internal_name",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      {
        name: "internal_name",
        label: "管理用の選手名",
        required: true,
        hint: "内部専用です。公開プロフィールは別の画面で承認します。",
      },
      {
        name: "activity_status",
        label: "活動状態",
        type: "select",
        options: [
          { value: "active", label: "活動中" },
          { value: "inactive", label: "活動休止" },
          { value: "former", label: "以前在籍" },
        ],
      },
      {
        name: "profile_consent",
        label: "プロフィールの公開同意を確認済み",
        type: "checkbox",
      },
      {
        name: "photo_consent",
        label: "写真の公開同意を確認済み",
        type: "checkbox",
      },
    ],
  },
  public_player_profiles: {
    label: "公開プロフィール",
    singular: "プロフィール",
    titleField: "display_name",
    key: "player_id",
    roles: footballRoles,
    canPublish: allContent,
    fields: [
      {
        name: "player_id",
        label: "選手UUID",
        type: "select",
        required: true,
        hint: "登録済み選手の変わらない識別子です。",
      },
      slug,
      { name: "display_name", label: "公開する名前", required: true },
      { name: "romanized_name", label: "ローマ字表記" },
      {
        name: "jersey_number",
        label: "背番号",
        type: "number",
        min: 0,
        max: 99,
      },
      {
        name: "position",
        label: "ポジション",
        type: "select",
        options: options("GK", "DF", "MF", "FW"),
      },
      { name: "photo_path", label: "プロフィール写真", type: "media" },
      { name: "bio", label: "選手紹介", type: "textarea" },
      {
        name: "activity_status",
        label: "公開する活動状態",
        type: "select",
        options: [
          { value: "active", label: "活動中" },
          { value: "inactive", label: "活動休止" },
          { value: "former", label: "以前在籍" },
        ],
      },
      {
        name: "display_order",
        label: "表示順（小さい順）",
        type: "number",
        min: 0,
      },
    ],
  },
  fixtures: {
    label: "試合",
    singular: "試合",
    titleField: "opponent",
    key: "id",
    roles: footballRoles,
    canPublish: footballRoles,
    fields: [
      { name: "opponent", label: "対戦相手", required: true },
      { name: "competition", label: "大会名" },
      {
        name: "kickoff_at",
        label: "キックオフ（日本時間）",
        type: "datetime-local",
      },
      { name: "venue", label: "会場" },
      {
        name: "home_away",
        label: "ホーム・アウェイ",
        type: "select",
        options: [
          { value: "home", label: "ホーム" },
          { value: "away", label: "アウェイ" },
          { value: "neutral", label: "中立地" },
        ],
      },
      {
        name: "match_status",
        label: "試合の状態",
        type: "select",
        options: [
          { value: "scheduled", label: "開催予定" },
          { value: "completed", label: "試合終了" },
          { value: "postponed", label: "延期" },
          { value: "cancelled", label: "中止" },
        ],
      },
      { name: "own_score", label: "得点（関西）", type: "number", min: 0 },
      { name: "opponent_score", label: "得点（相手）", type: "number", min: 0 },
      { name: "opponent_logo_path", label: "相手エンブレム", type: "media" },
      {
        name: "report",
        label: "試合レポート",
        type: "textarea",
        hint: "空行で段落を分けます。",
      },
    ],
  },
  training_sessions: {
    label: "練習予定",
    singular: "練習",
    titleField: "title",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      title,
      {
        name: "starts_at",
        label: "開始（日本時間）",
        type: "datetime-local",
        required: true,
      },
      { name: "ends_at", label: "終了（日本時間）", type: "datetime-local" },
      { name: "venue", label: "場所" },
      {
        name: "session_status",
        label: "状態",
        type: "select",
        options: [
          { value: "scheduled", label: "開催予定" },
          { value: "completed", label: "実施済み" },
          { value: "cancelled", label: "中止" },
        ],
      },
      { name: "notes", label: "運営メモ（内部専用）", type: "textarea" },
    ],
  },
  club_events: {
    label: "クラブ行事",
    singular: "行事",
    titleField: "title",
    key: "id",
    roles: footballRoles,
    canPublish: [],
    fields: [
      title,
      {
        name: "starts_at",
        label: "開始（日本時間）",
        type: "datetime-local",
        required: true,
      },
      { name: "ends_at", label: "終了（日本時間）", type: "datetime-local" },
      { name: "venue", label: "場所" },
      {
        name: "session_status",
        label: "状態",
        type: "select",
        options: [
          { value: "scheduled", label: "開催予定" },
          { value: "completed", label: "実施済み" },
          { value: "cancelled", label: "中止" },
        ],
      },
      {
        name: "is_public",
        label: "公式サイトに日程を公開する",
        type: "checkbox",
      },
      { name: "public_description", label: "公開する案内", type: "textarea" },
      { name: "notes", label: "運営メモ（内部専用）", type: "textarea" },
    ],
  },
  media_albums: {
    label: "アルバム",
    singular: "アルバム",
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      { name: "description", label: "説明", type: "textarea" },
      { name: "captured_on", label: "撮影日", type: "date" },
    ],
  },
  media_assets: {
    label: "写真・動画",
    singular: "メディア",
    titleField: "title",
    key: "id",
    roles: contentRoles,
    canPublish: contentRoles,
    fields: [
      title,
      {
        name: "kind",
        label: "種類",
        type: "select",
        options: [
          { value: "photo", label: "写真" },
          { value: "video", label: "動画URL" },
        ],
      },
      {
        name: "storage_path",
        label: "アップロードした写真",
        hint: "上の写真アップロードで自動入力します。",
      },
      { name: "video_url", label: "動画URL（YouTube対応）" },
      { name: "album_id", label: "アルバム", type: "select" },
      { name: "alt_text", label: "写真の説明（代替テキスト）", required: true },
      { name: "description", label: "説明", type: "textarea" },
      { name: "captured_on", label: "撮影日", type: "date" },
      { name: "source_url", label: "出典URL" },
      {
        name: "consent_confirmed",
        label: "写真・動画の掲載権限と本人の同意を確認済み",
        type: "checkbox",
        hint: "確認前の素材は発行できません。",
      },
    ],
  },
  site_pages: {
    label: "クラブ・参加案内",
    singular: "案内ページ",
    titleField: "title",
    key: "id",
    roles: allContent,
    canPublish: allContent,
    fields: [
      {
        name: "id",
        label: "ページ",
        type: "select",
        options: [
          { value: "club", label: "クラブ紹介" },
          { value: "join", label: "参加案内" },
        ],
        required: true,
      },
      title,
      { name: "introduction", label: "導入文", required: true },
      { name: "body", label: "本文", type: "textarea", required: true },
    ],
  },
  admin_roles: {
    label: "運営メンバー",
    singular: "メンバー",
    titleField: "email",
    key: "user_id",
    roles: ["owner"],
    canPublish: [],
    fields: [
      {
        name: "role",
        label: "権限",
        type: "select",
        options: [
          { value: "owner", label: "Owner" },
          { value: "administrator", label: "Administrator" },
          { value: "editor", label: "Editor" },
          { value: "coach", label: "Coach" },
        ],
      },
      { name: "active", label: "管理者アクセスを有効にする", type: "checkbox" },
    ],
  },
};
export { statusHint };
