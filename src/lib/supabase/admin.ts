import { createClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS, only used in server-side API routes.
export function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve a PAT token (from Authorization: Bearer header) to a clerk_id. */
export async function clerkIdFromPat(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const hash = await hashToken(token);
  const { data } = await adminClient()
    .from("pat_tokens")
    .select("clerk_id")
    .eq("token_hash", hash)
    .maybeSingle();
  return data?.clerk_id ?? null;
}
