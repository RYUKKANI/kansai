import type { Database } from "./database.types";
// [편집 안내] 운영 DB 생성 타입은 유지하고, 검토 중인 추가 마이그레이션의 공개 계약만 확장합니다.
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
    Tables: Database["public"]["Tables"] & {
      published_schedule: {
        Row: PublicSchedule;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
  };
};
