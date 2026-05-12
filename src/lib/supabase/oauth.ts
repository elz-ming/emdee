import { adminClient, hashToken } from "./admin";

const TOKEN_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 10;

export async function registerClient(clientName: string | null, redirectUris: string[]): Promise<string> {
  const { data, error } = await adminClient()
    .from("oauth_clients")
    .insert({ client_name: clientName, redirect_uris: redirectUris })
    .select("client_id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to register client");
  return data.client_id;
}

export async function getClient(clientId: string): Promise<{ client_id: string; redirect_uris: string[] } | null> {
  const { data } = await adminClient()
    .from("oauth_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  return data ?? null;
}

function generateCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function storeAuthCode(params: {
  clientId: string;
  clerkId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const { error } = await adminClient().from("oauth_codes").insert({
    code,
    client_id: params.clientId,
    clerk_id: params.clerkId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    scope: params.scope,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return code;
}

async function verifyPkce(codeChallenge: string, codeVerifier: string): Promise<boolean> {
  const encoded = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url === codeChallenge;
}

export async function exchangeCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string | null> {
  const supabase = adminClient();
  const { data: row } = await supabase
    .from("oauth_codes")
    .select("*")
    .eq("code", params.code)
    .eq("client_id", params.clientId)
    .maybeSingle();

  if (!row) return null;
  if (row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.redirect_uri !== params.redirectUri) return null;
  if (!(await verifyPkce(row.code_challenge, params.codeVerifier))) return null;

  // Mark code as used (single-use)
  await supabase.from("oauth_codes").update({ used: true }).eq("code", params.code);

  // Issue access token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from("oauth_tokens").insert({
    token_hash: hash,
    client_id: params.clientId,
    clerk_id: row.clerk_id,
    scope: row.scope,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return token;
}

/** Resolve an OAuth bearer token to a clerk_id. Returns null if invalid/expired. */
export async function clerkIdFromOAuthToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const hash = await hashToken(token);
  const { data } = await adminClient()
    .from("oauth_tokens")
    .select("clerk_id, expires_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data.clerk_id;
}
