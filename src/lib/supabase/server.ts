/**
 * Server-only client — uses the SERVICE ROLE key, which bypasses RLS.
 * This file must only ever be imported from src/server-fn/*.ts (TanStack
 * Start server functions), never from a route or component, or the service
 * key would be bundled into client JS.
 */
import { createClient } from "@supabase/supabase-js";

let cached: ReturnType<typeof createClient> | undefined;

export function supabaseServer() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the server. Add them as secrets (Lovable Cloud: Project Settings > Secrets; standalone: your .env).",
    );
  }
  cached = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cached;
}
