/**
 * Browser client — uses the public anon key, so every query runs under the
 * RLS policies in supabase/migrations/0001_init.sql for whoever is signed
 * in. Never import this from server-fn code; use ./server.ts there instead.
 */
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fails loudly at import time rather than silently returning empty data —
  // a missing env var should never look like "the district is balanced."
  throw new Error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. Copy .env.example to .env and fill in your Supabase project's values.",
  );
}

export const supabaseBrowser = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
