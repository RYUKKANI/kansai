import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "./admin-config";

// [편집 안내] 공통 DOM, 아이콘, 상태, 메뉴·양식 그룹입니다. DB에 저장할 필드와 화면 표시를 분리합니다.
export type Row = Record<string, unknown>;
export type OfficePage = Resource | "dashboard";
export type ListFilter = {
  search?: string;
  status?: string;
  category?: string;
  consent?: string;
  schedule?: string;
  after?: string;
};
export const officeGroups = [
  "OVERVIEW",
  "CONTENT",
  "TEAM",
  "OPERATIONS",
  "SYSTEM",
] as const;
type OfficeGroup = (typeof officeGroups)[number];
export const officePages: Record<
  OfficePage,
  { group: OfficeGroup; english: string; icon: string; description: string }
> = {
  dashboard: {
    group: "OVERVIEW",
    english: "DASHBOARD",
    icon: "grid",
    description: "クラブの公開状況と、今日の運営業務を確認できます。",
  },
  articles: {
    group: "CONTENT",
    english: "NEWSROOM",
    icon: "news",
    description: "ニュースの作成・編集と発行状況を管理します。",
  },
  media_albums: {
    group: "CONTENT",
    english: "ALBUMS",
    icon: "album",
    description: "活動写真をアルバムにまとめ、公開する内容を管理します。",
  },
  media_assets: {
    group: "CONTENT",
    english: "MEDIA LIBRARY",
    icon: "image",
    description:
      "写真・動画と掲載確認を管理します。未確認の素材は発行できません。",
  },
  players: {
    group: "TEAM",
    english: "PLAYER REGISTER",
    icon: "users",
    description:
      "内部の選手登録と公開同意を管理します。登録だけでプロフィールは公開されません。",
  },
  public_player_profiles: {
    group: "TEAM",
    english: "PUBLIC PROFILES",
    icon: "profile",
    description:
      "公式サイトに掲載するプロフィールです。登録・同意の確認後に公開を承認します。",
  },
  fixtures: {
    group: "OPERATIONS",
    english: "MATCHES",
    icon: "ball",
    description: "試合の日時・会場・結果と公開状態を管理します。",
  },
  training_sessions: {
    group: "OPERATIONS",
    english: "TRAINING",
    icon: "calendar",
    description:
      "練習予定と運営メモを管理します。練習の運営記録は内部専用です。",
  },
  site_pages: {
    group: "SYSTEM",
    english: "CLUB INFORMATION",
    icon: "club",
    description: "クラブ紹介と参加案内の掲載内容を管理します。",
  },
  admin_roles: {
    group: "SYSTEM",
    english: "STAFF & ACCESS",
    icon: "shield",
    description: "運営メンバーの招待、権限、アクセス状態を管理します。",
  },
};
export const stateLabels: Record<string, string> = {
  draft: "下書き",
  pending: "承認待ち",
  published: "発行済み",
  active: "活動中",
  inactive: "活動休止",
  former: "以前在籍",
  scheduled: "開催予定",
  completed: "終了",
  postponed: "延期",
  cancelled: "中止",
  confirmed: "確認済み",
  unconfirmed: "未確認",
  enabled: "有効",
  disabled: "無効",
};
export const roleLabels: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  coach: "Coach",
};

// 경로는 구단 UI 안에서만 쓰는 고정 SVG입니다. 사용자 입력을 SVG나 HTML로 해석하지 않습니다.
const iconPaths: Record<string, string[]> = {
  grid: ["M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"],
  news: [
    "M5 4h15v15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h2v12 M8 8h9 M8 12h9 M8 16h5",
  ],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.87",
    "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M16 3a4 4 0 0 1 0 8",
  ],
  profile: [
    "M4 3h16v18H4z M8 16h8 M8 19h5",
    "M14.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M8 13c1-2 7-2 8 0",
  ],
  ball: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    "M12 8l4 3-2 5h-4l-2-5z M12 3v5 M21 10l-5 1 M17 19l-3-3 M7 19l3-3 M3 10l5 1",
  ],
  calendar: ["M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 18h2"],
  album: ["M3 6h18v15H3z M6 3h12 M3 16l5-5 5 5 3-3 5 5", "M16 10h.01"],
  image: ["M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5", "M16 7h.01"],
  club: ["M4 21V7l8-4 8 4v14 M8 21v-5h8v5 M8 8h2 M14 8h2 M8 12h2 M14 12h2"],
  shield: ["M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6"],
  arrow: ["M5 12h14 M13 6l6 6-6 6"],
  plus: ["M12 5v14 M5 12h14"],
  search: ["M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l5 5"],
  menu: ["M4 6h16 M4 12h16 M4 18h16"],
  close: ["M6 6l12 12 M6 18L18 6"],
  collapse: ["M4 3h16v18H4z M9 3v18 M16 9l-3 3 3 3"],
  external: ["M14 3h7v7 M21 3L11 13 M10 3H3v18h18v-7"],
  logout: ["M9 4H4v16h5 M12 12h9 M17 8l4 4-4 4"],
  check: ["M4 12l5 5L20 6"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2"],
  warning: ["M12 3l10 18H2z M12 9v5 M12 17h.01"],
  list: ["M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01"],
  preview: [
    "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
};
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "20",
    height: "20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  for (const d of iconPaths[name] ?? iconPaths.grid ?? []) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
export function action(
  text: string,
  className: string,
  callback?: () => void,
  iconName?: string,
): HTMLButtonElement {
  const button = node("button", "", className);
  button.type = "button";
  if (iconName) button.append(icon(iconName));
  button.append(node("span", text, "button-label"));
  if (callback) button.addEventListener("click", callback);
  return button;
}
export function badge(status: unknown): HTMLElement {
  const value = String(status ?? "draft");
  const element = node("span", stateLabels[value] ?? value, "content-status");
  element.dataset.status = value;
  return element;
}
export function emptyState(
  title: string,
  description: string,
  link?: HTMLButtonElement,
): HTMLElement {
  const block = node("div", "", "office-empty");
  block.append(node("strong", title), node("p", description));
  if (link) block.append(link);
  return block;
}
export function panel(
  english: string,
  japanese: string,
  iconName: string,
): { section: HTMLElement; body: HTMLElement } {
  const section = node("section", "", "office-panel");
  const heading = node("header", "", "office-panel-heading");
  const title = node("div");
  title.append(node("p", english, "office-kicker"), node("h2", japanese));
  heading.append(title, icon(iconName));
  const body = node("div", "", "office-panel-body");
  section.append(heading, body);
  return { section, body };
}
export function dateLabel(value: unknown, time = false): string {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(time
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
  }).format(date);
}
export function japanInput(value: unknown): string {
  if (!value || Number.isNaN(new Date(String(value)).getTime())) return "";
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
export function selectFields(resource: Resource): string {
  const config = resources[resource];
  // 내부 연락처나 평가 항목을 목록에 추가하지 않습니다. 현재 양식에 필요한 필드만 읽습니다.
  return [
    ...new Set([
      config.key,
      ...config.fields.map((field) => field.name),
      "updated_at",
      ...(resource === "players" || resource === "admin_roles"
        ? ["created_at"]
        : resource === "training_sessions"
          ? []
          : ["status", "published_at"]),
      ...(resource === "media_assets" ? ["legacy_path"] : []),
    ]),
  ].join(",");
}
export async function imageSources(
  client: SupabaseClient,
  paths: unknown[],
  base: string,
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const storagePaths: string[] = [];
  for (const path of new Set(
    paths.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  )) {
    if (/^assets\/[a-z0-9-]+\.(jpg|png|webp)$/.test(path))
      sources.set(path, base + path);
    else if (/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/.test(path))
      storagePaths.push(path);
  }
  if (storagePaths.length) {
    // 비공개 버킷을 공개하지 않습니다. 현재 사용자의 RLS로 10분짜리 표시 URL을 일괄 발급합니다.
    const { data, error } = await client.storage
      .from("kansai-media")
      .createSignedUrls(storagePaths, 600);
    if (!error)
      for (const image of data ?? [])
        if (image.path && image.signedUrl && !image.error)
          sources.set(image.path, image.signedUrl);
  }
  return sources;
}

// 양식 묶음의 순서·라벨은 여기서 편집합니다. 실제 저장 항목은 admin-config.ts를 유지합니다.
export const editorGroups: Record<
  Resource,
  { label: string; fields: string[]; hint?: string }[]
> = {
  articles: [
    {
      label: "記事の内容",
      fields: ["title", "slug", "category", "summary", "body"],
    },
    {
      label: "写真・ギャラリー",
      fields: ["cover_path", "cover_alt", "gallery_paths"],
    },
    {
      label: "掲載設定",
      fields: ["activity_date", "published_at", "source_url", "featured"],
    },
  ],
  players: [
    {
      label: "内部の選手登録",
      fields: ["internal_name", "activity_status"],
      hint: "この登録情報は運営専用です。",
    },
    {
      label: "公開同意の確認",
      fields: ["profile_consent", "photo_consent"],
      hint: "公開プロフィールと写真の同意を個別に確認します。",
    },
  ],
  public_player_profiles: [
    {
      label: "登録選手との連携",
      fields: ["player_id", "slug"],
      hint: "既存の選手UUIDを維持して公開用の情報を管理します。",
    },
    {
      label: "公開するプロフィール",
      fields: [
        "display_name",
        "romanized_name",
        "jersey_number",
        "position",
        "photo_path",
        "bio",
      ],
    },
    { label: "掲載設定", fields: ["activity_status", "display_order"] },
  ],
  fixtures: [
    {
      label: "対戦カード",
      fields: ["opponent", "competition", "home_away", "opponent_logo_path"],
    },
    {
      label: "開催日時・会場",
      fields: ["kickoff_at", "venue", "match_status"],
    },
    {
      label: "試合結果・レポート",
      fields: ["own_score", "opponent_score", "report"],
    },
  ],
  training_sessions: [
    { label: "練習内容", fields: ["title", "session_status"] },
    { label: "日時・場所", fields: ["starts_at", "ends_at", "venue"] },
    { label: "内部の運営メモ", fields: ["notes"] },
  ],
  media_albums: [
    { label: "アルバム情報", fields: ["title", "description", "captured_on"] },
  ],
  media_assets: [
    {
      label: "写真・動画",
      fields: ["title", "kind", "storage_path", "video_url", "album_id"],
    },
    {
      label: "説明と撮影情報",
      fields: ["alt_text", "description", "captured_on", "source_url"],
    },
    { label: "掲載確認", fields: ["consent_confirmed"] },
  ],
  site_pages: [
    { label: "掲載するページ", fields: ["id", "title"] },
    { label: "ページの内容", fields: ["introduction", "body"] },
  ],
  admin_roles: [
    {
      label: "メンバーのアクセス",
      fields: ["role", "active"],
      hint: "最後のOwnerは無効化できません。退任時は削除せずアクセスを無効にします。",
    },
  ],
};
