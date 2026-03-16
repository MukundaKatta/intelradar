import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type Database = {
  public: {
    Tables: {
      workspaces: { Row: import("./types").Workspace };
      workspace_members: { Row: import("./types").WorkspaceMember };
      competitors: { Row: import("./types").Competitor };
      signals: { Row: import("./types").Signal };
      intelligence_briefs: { Row: import("./types").IntelligenceBrief };
      battlecards: { Row: import("./types").Battlecard };
      alert_rules: { Row: import("./types").AlertRule };
      alert_history: { Row: import("./types").AlertHistory };
      pricing_snapshots: { Row: import("./types").PricingSnapshot };
      job_postings: { Row: import("./types").JobPosting };
      website_snapshots: { Row: import("./types").WebsiteSnapshot };
    };
  };
};

let browserClient: SupabaseClient<Database> | null = null;
let serverClient: SupabaseClient<Database> | null = null;

/**
 * Get a Supabase client for browser/client-side use (anon key).
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  browserClient = createClient<Database>(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  return browserClient;
}

/**
 * Get a Supabase client for server-side use (service role key).
 * Bypasses RLS. Use only in trusted server contexts.
 */
export function getSupabaseServerClient(): SupabaseClient<Database> {
  if (serverClient) return serverClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  serverClient = createClient<Database>(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return serverClient;
}

/**
 * Create a one-off Supabase client with specific credentials.
 */
export function createSupabaseClient(
  url: string,
  key: string
): SupabaseClient<Database> {
  return createClient<Database>(url, key);
}
