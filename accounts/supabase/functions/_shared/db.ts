// Service-role Supabase client. Bypasses RLS — the bot is trusted server code.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export function db(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
