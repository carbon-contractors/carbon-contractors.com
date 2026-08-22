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
          categories: string[];
          rate_usdc: number;
          availability: Availability;
          reputation_score: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          wallet: string;
          categories: string[];
          rate_usdc: number;
          availability?: Availability;
          reputation_score?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          wallet?: string;
          categories?: string[];
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
          acceptance_spec: string | null;
          spec_hash: string | null;
          spec_schema_version: number | null;
          /** ISO timestamp of the on-chain block when Funded was confirmed (CC-092). Settable once. */
          funded_at: string | null;
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
          acceptance_spec?: string | null;
          spec_hash?: string | null;
          spec_schema_version?: number | null;
          funded_at?: string | null;
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
          // acceptance_spec / spec_hash / spec_schema_version are deliberately absent:
          // migration 016's trigger rejects any change to them, unconditionally. Leaving
          // them out makes that a compile error rather than a runtime exception (CC-084).
          // funded_at IS included here — unlike the spec columns it starts NULL and is
          // legitimately set once by /api/fund-task's confirmation write (CC-092);
          // migration 018's trigger guards the second write, not the first.
          funded_at?: string | null;
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
      used_nonces: {
        Row: {
          nonce: string;
          wallet: string;
          consumed_at: string;
        };
        Insert: {
          nonce: string;
          wallet: string;
          consumed_at?: string;
        };
        Update: {
          nonce?: string;
          wallet?: string;
          consumed_at?: string;
        };
        Relationships: [];
      };
      mcp_challenges: {
        Row: {
          id: string;
          wallet_address: string;
          nonce: string;
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          wallet_address: string;
          nonce: string;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          wallet_address?: string;
          nonce?: string;
          expires_at?: string;
          used_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      tasks_public: {
        Row: {
          id: string;
          payment_request_id: string;
          from_agent_wallet: string;
          to_human_wallet: string;
          amount_usdc: number;
          deadline_unix: number;
          status: TaskStatus;
          tx_hash: string | null;
          escrow_contract: string | null;
          created_at: string;
          updated_at: string;
        };
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
