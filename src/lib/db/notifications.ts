/**
 * notifications.ts
 * Notification channel registry for contractors.
 * Stores how and where to reach a worker when a task is assigned.
 * The accepts_auto_booking flag enables agent-to-agent hiring without
 * human approval — the orchestrator can book directly.
 */

import { getSupabaseAdmin } from "./client";

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
  const supabase = getSupabaseAdmin();

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
  const supabase = getSupabaseAdmin();

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
 * Get a single channel by ID, or null if not found.
 * Used by /api/channels to check ownership before removing (CC-073).
 */
export async function getChannelById(
  channelId: string
): Promise<NotificationChannel | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("notification_channels")
    .select()
    .eq("id", channelId)
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`getChannelById failed: ${error.message}`);
  }
  return (data as NotificationChannel) ?? null;
}

/**
 * Delete a notification channel by ID.
 * Returns true if a row was removed, false if it did not exist (CC-073).
 */
export async function removeNotificationChannel(
  channelId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("notification_channels")
    .delete()
    .eq("id", channelId)
    .select();

  if (error) {
    throw new Error(`removeNotificationChannel failed: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

/**
 * Flip `accepts_auto_booking` across every channel a contractor owns.
 *
 * Used by the CC-075 AWOL auto-disable: the flag is per-channel, so an AWOL
 * trigger must reach all of them — leaving one channel live would keep
 * auto-booking the worker against the very silence that triggered it.
 * Reversible: the worker re-enables per channel from the dashboard (CC-073/CC-074),
 * which lands here or in `registerNotificationChannel` as a plain upsert.
 *
 * Returns the number of channels updated.
 */
export async function setAcceptsAutoBookingForContractor(
  contractorId: string,
  acceptsAutoBooking: boolean
): Promise<number> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("notification_channels")
    .update({
      accepts_auto_booking: acceptsAutoBooking,
      updated_at: new Date().toISOString(),
    })
    .eq("contractor_id", contractorId)
    .select("id");

  if (error) {
    throw new Error(`setAcceptsAutoBookingForContractor failed: ${error.message}`);
  }
  return (data ?? []).length;
}

/**
 * Find all contractors who accept auto-booking.
 * Used by orchestrator agents to find workers they can hire directly.
 */
export async function getAutoBookableContractors(): Promise<
  NotificationChannel[]
> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("notification_channels")
    .select()
    .eq("accepts_auto_booking", true);

  if (error) {
    throw new Error(`getAutoBookableContractors failed: ${error.message}`);
  }
  return (data ?? []) as NotificationChannel[];
}
