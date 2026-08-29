export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      licenses: {
        Row: {
          created_at: string
          current_period_end: string | null
          id: string
          status: string
          tier: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          status: string
          tier: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          status?: string
          tier?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          stripe_customer_id: string | null
          subscription_status: string | null
          tier: string | null
          updated_at: string
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          tier?: string | null
          updated_at?: string
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          tier?: string | null
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      project_shares: {
        Row: {
          access_level: string
          created_at: string | null
          created_by: string | null
          id: string
          invited_email: string | null
          project_id: string | null
          token: string
        }
        Insert: {
          access_level: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          invited_email?: string | null
          project_id?: string | null
          token?: string
        }
        Update: {
          access_level?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          invited_email?: string | null
          project_id?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_shares_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          bpm: number
          created_at: string
          data: Json | null
          id: string
          is_public: boolean
          name: string
          sample_rate: number
          updated_at: string
          workspace_id: string
          yjs_room_id: string
        }
        Insert: {
          bpm?: number
          created_at?: string
          data?: Json | null
          id?: string
          is_public?: boolean
          name: string
          sample_rate?: number
          updated_at?: string
          workspace_id: string
          yjs_room_id?: string
        }
        Update: {
          bpm?: number
          created_at?: string
          data?: Json | null
          id?: string
          is_public?: boolean
          name?: string
          sample_rate?: number
          updated_at?: string
          workspace_id?: string
          yjs_room_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notifications: {
        Row: {
          created_at: string | null
          id: string
          message: string | null
          project_id: string | null
          sender_id: string | null
          status: string
          team_id: string | null
          type: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          message?: string | null
          project_id?: string | null
          sender_id?: string | null
          status?: string
          team_id?: string | null
          type: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          message?: string | null
          project_id?: string | null
          sender_id?: string | null
          status?: string
          team_id?: string | null
          type?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_notifications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_notifications_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_notifications_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          joined_at: string
          role: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          joined_at?: string
          role?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          joined_at?: string
          role?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          category: string | null
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_project_with_limit: {
        Args: {
          p_bpm?: number
          p_is_public?: boolean
          p_name: string
          p_data?: Json
          p_sample_rate?: number
          p_workspace_id: string
        }
        Returns: string
      }
      create_project_snapshot_with_limit: {
        Args: {
          p_data?: Json
          p_label?: string | null
          p_project_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          data: Json
          id: string
          label: string | null
          project_id: string
          schema_version: string
          size_bytes: number
          workspace_id: string
        }[]
      }
      create_render_job_with_limit: {
        Args: {
          p_bit_depth?: number
          p_format?: string
          p_input?: Json
          p_kind?: string
          p_project_id: string
          p_sample_rate?: number
        }
        Returns: {
          bit_depth: number
          completed_at: string | null
          created_at: string
          error: string | null
          format: string
          id: string
          input: Json
          kind: string
          output_asset_id: string | null
          project_id: string
          requested_by: string
          sample_rate: number
          started_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
      }
      get_active_sessions: {
        Args: never
        Returns: {
          created_at: string
          id: string
          ip: unknown
          last_active: string
          user_agent: string
        }[]
      }
      get_active_sessions_v2: {
        Args: never
        Returns: {
          created_at: string
          id: string
          ip: string | null
          last_active: string
          tag: string | null
          user_agent: string | null
          is_current: boolean
        }[]
      }
      get_project_by_share_token: {
        Args: { p_token: string }
        Returns: {
          access_level: string
          bpm: number
          data: Json | null
          name: string
          project_id: string
          sample_rate: number
          yjs_room_id: string
        }[]
      }
      get_project_os_usage: {
        Args: {
          p_period_start?: string
          p_workspace_id?: string | null
        }
        Returns: {
          metric: string
          quantity: number
        }[]
      }
      register_project_asset_with_limit: {
        Args: {
          p_bucket: string
          p_duration_seconds?: number | null
          p_format?: string | null
          p_hash?: string | null
          p_license_state?: string
          p_metadata?: Json
          p_path: string
          p_project_id?: string | null
          p_sample_rate?: number | null
          p_size_bytes?: number
          p_workspace_id?: string | null
        }
        Returns: {
          bucket: string
          created_at: string
          duration_seconds: number | null
          format: string | null
          hash: string | null
          id: string
          license_state: string
          metadata: Json
          owner_id: string
          path: string
          project_id: string | null
          sample_rate: number | null
          size_bytes: number
          updated_at: string
          workspace_id: string | null
        }[]
      }
      revoke_device_session: {
        Args: { target_session_id: string }
        Returns: boolean
      }
      revoke_device_session_v2: {
        Args: { target_session_id: string }
        Returns: {
          reason: string
          revoked: boolean
        }[]
      }
      update_render_job_status_with_scope: {
        Args: {
          p_error?: string | null
          p_output_asset_id?: string | null
          p_render_job_id: string
          p_status: string
        }
        Returns: {
          bit_depth: number
          completed_at: string | null
          created_at: string
          error: string | null
          format: string
          id: string
          input: Json
          kind: string
          output_asset_id: string | null
          project_id: string
          requested_by: string
          sample_rate: number
          started_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

/* ── Convenience types derived from the generated schema ────────── */

export type Profile = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  updated_at: string | null;
  tier: string | null;
};

export type Project = {
  id: string;
  name: string;
  bpm: number;
  sample_rate: number;
  data: Json;
  created_at: string;
  updated_at: string;
  is_public: boolean;
  workspace_id: string;
  yjs_room_id: string;
};

export type ProjectShare = {
  id: string;
  project_id: string | null;
  access_level: string;
  invited_email: string | null;
  token: string;
  created_at: string | null;
  created_by: string | null;
};
