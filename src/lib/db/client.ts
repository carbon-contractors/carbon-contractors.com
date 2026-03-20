/**
 * client.ts
 * Singleton Supabase clients for server-side use.
 *
 * getSupabase()      — anon key, read-only (RLS enforced)
 * getSupabaseAdmin() — service role key, bypasses RLS (for server-side writes)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { getConfig } from "@/lib/config";

let _client: SupabaseClient<Database> | null = null;
let _adminClient: SupabaseClient<Database> | null = null;

/** Read-only client using anon key (RLS enforced). */
export function getSupabase(): SupabaseClient<Database> {
  if (_client) return _client;

  const config = getConfig();
  _client = createClient<Database>(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  return _client;
}

/** Admin client using service role key (bypasses RLS). Use for server-side writes. */
export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (_adminClient) return _adminClient;

  const config = getConfig();
  _adminClient = createClient<Database>(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  return _adminClient;
}
