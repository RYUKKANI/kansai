// 간사이 프로젝트에서 생성한 스키마 타입입니다. 직접 편집하지 않고 DB 변경 후 다시 생성합니다.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // 프로젝트의 PostgREST 버전에 맞는 클라이언트 타입을 제공합니다.
  // 스키마가 바뀌면 생성 도구로 다시 갱신합니다.
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      admin_roles: {
        Row: {
          active: boolean;
          created_at: string;
          email: string;
          role: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          email: string;
          role: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          email?: string;
          role?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      articles: {
        Row: {
          activity_date: string | null;
          body: string;
          category: string;
          cover_alt: string;
          cover_path: string | null;
          featured: boolean;
          gallery_paths: string[];
          id: string;
          published_at: string | null;
          slug: string;
          source_url: string | null;
          status: string;
          summary: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          activity_date?: string | null;
          body?: string;
          category?: string;
          cover_alt?: string;
          cover_path?: string | null;
          featured?: boolean;
          gallery_paths?: string[];
          id?: string;
          published_at?: string | null;
          slug: string;
          source_url?: string | null;
          status?: string;
          summary?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          activity_date?: string | null;
          body?: string;
          category?: string;
          cover_alt?: string;
          cover_path?: string | null;
          featured?: boolean;
          gallery_paths?: string[];
          id?: string;
          published_at?: string | null;
          slug?: string;
          source_url?: string | null;
          status?: string;
          summary?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: {
          actor_id: string | null;
          actor_role: string | null;
          changed_fields: string[];
          entity: string;
          id: number;
          occurred_at: string;
          operation: string;
          record_id: string | null;
        };
        Insert: {
          actor_id?: string | null;
          actor_role?: string | null;
          changed_fields?: string[];
          entity: string;
          id?: never;
          occurred_at?: string;
          operation: string;
          record_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          actor_role?: string | null;
          changed_fields?: string[];
          entity?: string;
          id?: never;
          occurred_at?: string;
          operation?: string;
          record_id?: string | null;
        };
        Relationships: [];
      };
      fixtures: {
        Row: {
          competition: string;
          home_away: string;
          id: string;
          kickoff_at: string | null;
          match_status: string;
          opponent: string;
          opponent_logo_path: string | null;
          opponent_score: number | null;
          own_score: number | null;
          published_at: string | null;
          report: string;
          status: string;
          updated_at: string;
          venue: string;
        };
        Insert: {
          competition?: string;
          home_away?: string;
          id?: string;
          kickoff_at?: string | null;
          match_status?: string;
          opponent: string;
          opponent_logo_path?: string | null;
          opponent_score?: number | null;
          own_score?: number | null;
          published_at?: string | null;
          report?: string;
          status?: string;
          updated_at?: string;
          venue?: string;
        };
        Update: {
          competition?: string;
          home_away?: string;
          id?: string;
          kickoff_at?: string | null;
          match_status?: string;
          opponent?: string;
          opponent_logo_path?: string | null;
          opponent_score?: number | null;
          own_score?: number | null;
          published_at?: string | null;
          report?: string;
          status?: string;
          updated_at?: string;
          venue?: string;
        };
        Relationships: [];
      };
      match_events: {
        Row: {
          details: Json;
          event_type: string;
          fixture_id: string;
          id: string;
          minute: number | null;
          player_id: string | null;
          updated_at: string;
        };
        Insert: {
          details?: Json;
          event_type: string;
          fixture_id: string;
          id?: string;
          minute?: number | null;
          player_id?: string | null;
          updated_at?: string;
        };
        Update: {
          details?: Json;
          event_type?: string;
          fixture_id?: string;
          id?: string;
          minute?: number | null;
          player_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "match_events_fixture_id_fkey";
            columns: ["fixture_id"];
            isOneToOne: false;
            referencedRelation: "fixtures";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "match_events_player_id_fkey";
            columns: ["player_id"];
            isOneToOne: false;
            referencedRelation: "players";
            referencedColumns: ["id"];
          },
        ];
      };
      media_albums: {
        Row: {
          captured_on: string | null;
          description: string;
          id: string;
          published_at: string | null;
          status: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          captured_on?: string | null;
          description?: string;
          id?: string;
          published_at?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          captured_on?: string | null;
          description?: string;
          id?: string;
          published_at?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      media_assets: {
        Row: {
          album_id: string | null;
          alt_text: string;
          captured_on: string | null;
          consent_confirmed: boolean;
          description: string;
          id: string;
          kind: string;
          legacy_path: string | null;
          public_approved: boolean | null;
          published_at: string | null;
          source_url: string | null;
          status: string;
          storage_path: string | null;
          title: string;
          updated_at: string;
          video_url: string | null;
        };
        Insert: {
          album_id?: string | null;
          alt_text?: string;
          captured_on?: string | null;
          consent_confirmed?: boolean;
          description?: string;
          id?: string;
          kind?: string;
          legacy_path?: string | null;
          public_approved?: boolean | null;
          published_at?: string | null;
          source_url?: string | null;
          status?: string;
          storage_path?: string | null;
          title: string;
          updated_at?: string;
          video_url?: string | null;
        };
        Update: {
          album_id?: string | null;
          alt_text?: string;
          captured_on?: string | null;
          consent_confirmed?: boolean;
          description?: string;
          id?: string;
          kind?: string;
          legacy_path?: string | null;
          public_approved?: boolean | null;
          published_at?: string | null;
          source_url?: string | null;
          status?: string;
          storage_path?: string | null;
          title?: string;
          updated_at?: string;
          video_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "media_assets_album_id_fkey";
            columns: ["album_id"];
            isOneToOne: false;
            referencedRelation: "media_albums";
            referencedColumns: ["id"];
          },
        ];
      };
      players: {
        Row: {
          activity_status: string;
          consent_note: string;
          created_at: string;
          id: string;
          internal_name: string;
          photo_consent: boolean;
          profile_consent: boolean;
          updated_at: string;
        };
        Insert: {
          activity_status?: string;
          consent_note?: string;
          created_at?: string;
          id?: string;
          internal_name: string;
          photo_consent?: boolean;
          profile_consent?: boolean;
          updated_at?: string;
        };
        Update: {
          activity_status?: string;
          consent_note?: string;
          created_at?: string;
          id?: string;
          internal_name?: string;
          photo_consent?: boolean;
          profile_consent?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      public_player_profiles: {
        Row: {
          activity_status: string;
          approved_by: string | null;
          bio: string;
          display_name: string;
          display_order: number;
          jersey_number: number | null;
          photo_path: string | null;
          player_id: string;
          position: string;
          published_at: string | null;
          romanized_name: string;
          slug: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          activity_status?: string;
          approved_by?: string | null;
          bio?: string;
          display_name: string;
          display_order?: number;
          jersey_number?: number | null;
          photo_path?: string | null;
          player_id: string;
          position: string;
          published_at?: string | null;
          romanized_name?: string;
          slug: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          activity_status?: string;
          approved_by?: string | null;
          bio?: string;
          display_name?: string;
          display_order?: number;
          jersey_number?: number | null;
          photo_path?: string | null;
          player_id?: string;
          position?: string;
          published_at?: string | null;
          romanized_name?: string;
          slug?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "public_player_profiles_player_id_fkey";
            columns: ["player_id"];
            isOneToOne: true;
            referencedRelation: "players";
            referencedColumns: ["id"];
          },
        ];
      };
      publication_state: {
        Row: {
          changed_at: string;
          id: number;
          version: number;
        };
        Insert: {
          changed_at?: string;
          id: number;
          version?: number;
        };
        Update: {
          changed_at?: string;
          id?: number;
          version?: number;
        };
        Relationships: [];
      };
      site_pages: {
        Row: {
          body: string;
          id: string;
          introduction: string;
          published_at: string | null;
          status: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          body?: string;
          id: string;
          introduction?: string;
          published_at?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          id?: string;
          introduction?: string;
          published_at?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      training_sessions: {
        Row: {
          ends_at: string | null;
          id: string;
          notes: string;
          session_status: string;
          starts_at: string;
          title: string;
          updated_at: string;
          venue: string;
        };
        Insert: {
          ends_at?: string | null;
          id?: string;
          notes?: string;
          session_status?: string;
          starts_at: string;
          title: string;
          updated_at?: string;
          venue?: string;
        };
        Update: {
          ends_at?: string | null;
          id?: string;
          notes?: string;
          session_status?: string;
          starts_at?: string;
          title?: string;
          updated_at?: string;
          venue?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
