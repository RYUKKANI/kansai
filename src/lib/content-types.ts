// [편집 안내] 공개 홈페이지에 전달할 항목만 정의합니다. 연락처·출석·평가·건강 정보는 추가하지 않습니다.
import type { ContentTranslations } from "./content-translations";
export type Position = "GK" | "DF" | "MF" | "FW";
export type ContentStatus = "draft" | "pending" | "published";
export type StaffRole = import("./member-grades").MemberGrade;
export interface PublicPlayer {
  playerId: string; // 이름이나 등번호가 바뀌어도 유지하는 UUID
  slug: string;
  name: string;
  romanizedName: string;
  number: number | null;
  position: Position;
  photo: string;
  bio: string;
  activityStatus: "active" | "inactive" | "former";
  displayOrder: number;
}
export interface PublicFixture {
  id: string;
  opponent: string;
  competition: string;
  kickoff: string | null;
  venue: string;
  homeAway: "home" | "away" | "neutral";
  status: "scheduled" | "completed" | "postponed" | "cancelled";
  ownScore: number | null;
  opponentScore: number | null;
  opponentLogo: string;
  report: string[];
}
export interface PublicMedia {
  id: string;
  kind: "photo" | "video";
  image: string;
  videoUrl: string;
  title: string;
  alt: string;
  description: string;
  source: string;
  capturedOn: string | null;
  albumId: string | null;
  category?: "general" | "player" | "match" | "training";
}
export interface PublicAlbum {
  id: string;
  title: string;
  description: string;
  capturedOn: string | null;
}
export interface ClubPage {
  id: "club" | "join";
  title: string;
  introduction: string;
  paragraphs: string[];
  translations?: ContentTranslations;
}
export const positions: { id: Position; english: string; japanese: string }[] =
  [
    { id: "GK", english: "GOALKEEPERS", japanese: "ゴールキーパー" },
    { id: "DF", english: "DEFENDERS", japanese: "ディフェンダー" },
    { id: "MF", english: "MIDFIELDERS", japanese: "ミッドフィルダー" },
    { id: "FW", english: "FORWARDS", japanese: "フォワード" },
  ];
