import type { Database } from "./database.types";
import type { ContentTranslations } from "./content-translations";
type TranslatedTable<
  T extends { Row: object; Insert: object; Update: object },
> = Omit<T, "Row" | "Insert" | "Update"> & {
  Row: T["Row"] & { translations: ContentTranslations };
  Insert: T["Insert"] & { translations?: ContentTranslations };
  Update: T["Update"] & { translations?: ContentTranslations };
};
// [편집 안내] 생성 타입의 JSON을 서버에서 검증한 번역 계약으로 좁힙니다. 공개 일정 조회 계약도 함께 지정합니다.
export type PublicSchedule = {
  resource: "fixtures" | "training_sessions" | "club_events";
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  venue: string;
  schedule_status: string;
  description: string;
};
export type OfficeDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Omit<
      Database["public"]["Tables"],
      "articles" | "site_pages" | "media_assets"
    > & {
      articles: TranslatedTable<Database["public"]["Tables"]["articles"]>;
      site_pages: TranslatedTable<Database["public"]["Tables"]["site_pages"]>;
      media_assets: Database["public"]["Tables"]["media_assets"] & {
        Row: { media_category: string };
      };
      published_schedule: {
        Row: PublicSchedule;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
  };
};
