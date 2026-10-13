import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  stories as originalStories,
  gallery as originalGallery,
  type Story,
  storyCategories,
} from "./club";
import type {
  ClubPage,
  PublicAlbum,
  PublicFixture,
  PublicMedia,
  PublicPlayer,
} from "../lib/content-types";
import type { Database } from "../lib/database.types";

// [편집 안내] Astro 빌드에서만 실행합니다. 공개 키 + 익명 RLS로 승인된 데이터만 읽습니다.
// CMS 활성화 후에는 조회 실패를 숨기거나 이전 초안을 대신 발행하지 않고 빌드를 중단합니다.
export interface PublicContent {
  stories: Story[];
  players: PublicPlayer[];
  fixtures: PublicFixture[];
  media: PublicMedia[];
  albums: PublicAlbum[];
  pages: ClubPage[];
  fromCms: boolean;
  version: number;
}
const defaultPages: ClubPage[] = [
  {
    id: "club",
    title: "関西ユナイテッドFC",
    introduction: "ピッチでつながる。チームの今を、ここから。",
    paragraphs: [
      "トレーニングの様子や参加に関する情報を、公式Instagramで発信しています。",
      "服部緑地公園での練習風景を紹介しています。選手・スタッフ、活動方針などの詳しいプロフィールは、確認された公式情報を掲載します。",
    ],
  },
  {
    id: "join",
    title: "チームへの参加をお考えの方へ。",
    introduction: "プレーする、教える、運営を支える。",
    paragraphs: [
      "選手・コーチ・運営スタッフとしての参加や見学のご相談は、公式InstagramのDMへ。",
      "初参加はご連絡順にご案内しています。現在の受付状況や参加条件は、DMでご確認ください。",
    ],
  },
];
function localContent(): PublicContent {
  return {
    stories: [...originalStories],
    players: [],
    fixtures: [],
    fromCms: false,
    version: 0,
    pages: defaultPages,
    albums: [
      {
        id: "october-training",
        title: "10月3日 トレーニング",
        description: "攻撃をテーマにした練習の様子。",
        capturedOn: "2026-10-03",
      },
      {
        id: "september-training",
        title: "9月26日 トレーニング",
        description: "雨のピッチで守備に取り組みました。",
        capturedOn: "2026-09-26",
      },
    ],
    media: originalGallery.map((photo, index) => ({
      id: "original-photo-" + index,
      kind: "photo",
      image: photo.image,
      videoUrl: "",
      title: photo.label,
      alt: photo.alt,
      description: photo.alt,
      source: photo.source,
      capturedOn: index < 2 ? "2026-10-03" : "2026-09-26",
      albumId: index < 2 ? "october-training" : "september-training",
    })),
  };
}
export function safeExternalUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function youtubeId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    let id: string | null = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    if (
      ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)
    ) {
      id =
        url.pathname === "/watch"
          ? url.searchParams.get("v")
          : (url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/)?.[1] ?? null);
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
const paragraphs = (value: string | null): string[] =>
  (value ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
let cached: Promise<PublicContent> | undefined;
export function loadPublicContent(): Promise<PublicContent> {
  cached ??= readPublishedContent();
  return cached;
}
async function readPublishedContent(): Promise<PublicContent> {
  if (import.meta.env.PUBLIC_CMS_ENABLED !== "true") return localContent();
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !key.startsWith("sb_publishable_"))
    throw new Error("CMS 공개 연결 설정을 확인하세요.");
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // 읽는 동안 발행이 바뀌면 이전 내용에 새 버전 번호가 붙지 않도록 빌드를 중단합니다.
  const before = await client
    .from("publication_state")
    .select("version")
    .eq("id", 1)
    .single();
  if (before.error || !before.data)
    throw new Error("발행 상태를 읽을 수 없습니다.");
  // 별표 전체 조회를 쓰지 않습니다. 승인 담당자나 내부 기록을 빌드 산출물에 넣지 않습니다.
  const results = await Promise.all([
    client
      .from("articles")
      .select(
        "id,slug,title,summary,category,body,cover_path,cover_alt,gallery_paths,source_url,published_at,featured,activity_date",
      )
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(500),
    client
      .from("public_player_profiles")
      .select(
        "player_id,slug,display_name,romanized_name,jersey_number,position,photo_path,bio,activity_status,display_order",
      )
      .eq("status", "published")
      .order("display_order")
      .limit(500),
    client
      .from("fixtures")
      .select(
        "id,opponent,competition,kickoff_at,venue,home_away,match_status,own_score,opponent_score,opponent_logo_path,report",
      )
      .eq("status", "published")
      .order("kickoff_at")
      .limit(500),
    client
      .from("media_assets")
      .select(
        "id,kind,storage_path,legacy_path,video_url,title,alt_text,description,source_url,captured_on,album_id",
      )
      .eq("status", "published")
      .order("captured_on", { ascending: false })
      .limit(500),
    client
      .from("media_albums")
      .select("id,title,description,captured_on")
      .eq("status", "published")
      .order("captured_on", { ascending: false })
      .limit(500),
    client
      .from("site_pages")
      .select("id,title,introduction,body")
      .eq("status", "published"),
  ]);
  for (const result of results) {
    if (result.error)
      throw new Error("승인된 CMS 콘텐츠 조회 실패: " + result.error.message);
    if (Array.isArray(result.data) && result.data.length === 500)
      throw new Error(
        "CMS 목록이 500개에 도달했습니다. 페이지네이션을 확장한 뒤 배포하세요.",
      );
  }
  const articles = results[0].data ?? [];
  const profiles = results[1].data ?? [];
  const fixtures = results[2].data ?? [];
  const mediaRows = results[3].data ?? [];
  const albumRows = results[4].data ?? [];
  const pageRows = results[5].data ?? [];
  const downloaded = new Map<string, Promise<string>>();
  function image(reference: string | null): Promise<string> {
    if (!reference) return Promise.resolve("");
    if (/^assets\/[a-z0-9-]+\.(jpg|png|webp)$/.test(reference))
      return Promise.resolve(reference);
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/.test(reference))
      throw new Error("허용되지 않은 사진 경로");
    if (!downloaded.has(reference))
      downloaded.set(
        reference,
        (async () => {
          const { data, error } = await client.storage
            .from("kansai-media")
            .download(reference);
          if (error || !data)
            throw new Error(
              "공개 승인을 받은 사진을 읽을 수 없습니다: " + reference,
            );
          if (!["image/jpeg", "image/png", "image/webp"].includes(data.type))
            throw new Error("지원하지 않는 사진 형식");
          const bytes = Buffer.from(await data.arrayBuffer());
          const name =
            createHash("sha256").update(bytes).digest("hex").slice(0, 24) +
            "." +
            reference.split(".").pop();
          await mkdir("public/cms-assets", { recursive: true });
          await writeFile("public/cms-assets/" + name, bytes);
          return "cms-assets/" + name;
        })(),
      );
    return downloaded.get(reference)!;
  }
  const stories: Story[] = await Promise.all(
    (articles ?? []).map(async (row) => {
      if (!(row.category in storyCategories))
        throw new Error("알 수 없는 기사 분류");
      return {
        id: row.slug,
        category: row.category as keyof typeof storyCategories,
        label:
          storyCategories[row.category as keyof typeof storyCategories].badge,
        title: row.title,
        summary: row.summary,
        paragraphs: paragraphs(row.body),
        published: row.published_at?.slice(0, 10).replaceAll("-", ".") ?? "",
        activityDate: row.activity_date ?? undefined,
        image: await image(row.cover_path),
        alt: row.cover_alt,
        source: safeExternalUrl(row.source_url),
        gallery: await Promise.all(
          (row.gallery_paths ?? []).map((path: string) => image(path)),
        ),
        featured: row.featured,
      };
    }),
  );
  const content: PublicContent = {
    fromCms: true,
    version: Number(before.data.version),
    stories,
    players: await Promise.all(
      (profiles ?? []).map(async (row) => ({
        playerId: row.player_id,
        slug: row.slug,
        name: row.display_name,
        romanizedName: row.romanized_name,
        number: row.jersey_number,
        position: row.position as PublicPlayer["position"],
        photo: await image(row.photo_path),
        bio: row.bio,
        activityStatus: row.activity_status as PublicPlayer["activityStatus"],
        displayOrder: row.display_order,
      })),
    ),
    fixtures: await Promise.all(
      (fixtures ?? []).map(async (row) => ({
        id: row.id,
        opponent: row.opponent,
        competition: row.competition,
        kickoff: row.kickoff_at,
        venue: row.venue,
        homeAway: row.home_away as PublicFixture["homeAway"],
        status: row.match_status as PublicFixture["status"],
        ownScore: row.own_score,
        opponentScore: row.opponent_score,
        opponentLogo: await image(row.opponent_logo_path),
        report: paragraphs(row.report),
      })),
    ),
    media: await Promise.all(
      (mediaRows ?? []).map(async (row) => ({
        id: row.id,
        kind: row.kind as PublicMedia["kind"],
        image: await image(row.storage_path || row.legacy_path),
        videoUrl: safeExternalUrl(row.video_url),
        title: row.title,
        alt: row.alt_text,
        description: row.description,
        source: safeExternalUrl(row.source_url),
        capturedOn: row.captured_on,
        albumId: row.album_id,
      })),
    ),
    albums: (albumRows ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      capturedOn: row.captured_on,
    })),
    pages: (pageRows ?? []).map((row) => ({
      id: row.id as ClubPage["id"],
      title: row.title,
      introduction: row.introduction,
      paragraphs: paragraphs(row.body),
    })),
  };
  const after = await client
    .from("publication_state")
    .select("version")
    .eq("id", 1)
    .single();
  if (after.error || after.data?.version !== before.data.version)
    throw new Error("빌드 중 공개 내용이 변경되었습니다. 다시 빌드하세요.");
  return content;
}
