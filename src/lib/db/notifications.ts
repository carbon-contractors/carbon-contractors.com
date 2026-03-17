/**
 * notifications.ts
 * Notification channel registry for contractors.
 * Stores how and where to reach a worker when a task is assigned.
 * The accepts_auto_booking flag enables agent-to-agent hiring without
 * human approval — the orchestrator can book directly.
 */

import { getSupabase } from "./client";

export interface NotificationChannel {
  id: string;
  contractor_id: string;
  type: "email" | "webhook" | "telegram" | "discord";
  address: string;
  accepts_auto_booking: boolean;
  created_at: string;
}

export interface RegisterChannelInput {
  contractor_id: string;
  type: NotificationChannel["type"];
  address: string;
  accepts_auto_booking: boolean;
}

/**
 * Upsert a notification channel for a contractor.
 * One channel per type per contractor — re-registering overwrites.
 */
export async function registerNotificationChannel(
  input: RegisterChannelInput
): Promise<NotificationChannel> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("notification_channels")
    .upsert(
      {
        contractor_id: input.contractor_id,
        type: input.type,
        address: input.address,
        accepts_auto_booking: input.accepts_auto_booking,
      },
      { onConflict: "contractor_id,type" }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`registerNotificationChannel failed: ${error.message}`);
  }
  return data as NotificationChannel;
}

/**
 * Get all notification channels for a contractor.
 */
export async function getChannelsForContractor(
  contractorId: string
): Promise<NotificationChannel[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("notification_channels")
    .select()
    .eq("contractor_id", contractorId);

  if (error) {
    throw new Error(`getChannelsForContractor failed: ${error.message}`);
  }
  return (data ?? []) as NotificationChannel[];
}

/**
 * Find all contractors who accept auto-booking.
 * Used by orchestrator agents to find workers they can hire directly.
 */
export async function getAutoBookableContractors(): Promise<
  NotificationChannel[]
> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("notification_channels")
    .select()
    .eq("accepts_auto_booking", true);

  if (error) {
    throw new Error(`getAutoBookableContractors failed: ${error.message}`);
  }
  return (data ?? []) as NotificationChannel[];
}
