/**
 * types.ts
 * Supabase Database type definitions matching our schema.
 */

export type Availability = "available" | "busy" | "offline";
export type TaskStatus =
  | "pending"
  | "active"
  | "completed"
  | "disputed"
  | "expired";
export type NotificationChannelType = "email" | "webhook" | "telegram" | "discord";

export interface Database {
  public: {
    Tables: {
      humans: {
        Row: {
          id: string;
          wallet: string;
          skills: string[];
          rate_usdc: number;
          availability: Availability;
          reputation_score: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          wallet: string;
          skills: string[];
          rate_usdc: number;
          availability?: Availability;
          reputation_score?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          wallet?: string;
          skills?: string[];
          rate_usdc?: number;
          availability?: Availability;
          reputation_score?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          payment_request_id: string;
          from_agent_wallet: string;
          to_human_wallet: string;
          task_description: string;
          amount_usdc: number;
          deadline_unix: number;
          status: TaskStatus;
          tx_hash: string | null;
          escrow_contract: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          payment_request_id: string;
          from_agent_wallet: string;
          to_human_wallet: string;
          task_description: string;
          amount_usdc: number;
          deadline_unix: number;
          status?: TaskStatus;
          tx_hash?: string | null;
          escrow_contract?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          payment_request_id?: string;
          from_agent_wallet?: string;
          to_human_wallet?: string;
          task_description?: string;
          amount_usdc?: number;
          deadline_unix?: number;
          status?: TaskStatus;
          tx_hash?: string | null;
          escrow_contract?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      notification_channels: {
        Row: {
          id: string;
          contractor_id: string;
          type: NotificationChannelType;
          address: string;
          accepts_auto_booking: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          contractor_id: string;
          type: NotificationChannelType;
          address: string;
          accepts_auto_booking?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          contractor_id?: string;
          type?: NotificationChannelType;
          address?: string;
          accepts_auto_booking?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
