import path from "node:path";
import { auth } from "@clerk/nextjs/server";
import { getVaultStorage } from "@/src/lib/storage";
import { adminClient } from "@/src/lib/supabase/admin";
import { vaultPathTag } from "@/src/lib/cache/bust";

// SPRINT-024 Phase 3: thin metadata endpoint for client UI consumers
// (sidebar previews, link-hover cards). Returns `{path, title, summary}`.
// The MCP `get_summary` tool runs in-process and does NOT call this — it
// reads through `loadVaultIndex` like the rest of the read tools.
//
// Caching: personal namespaces stay `private` (Clerk-gated; never share
// across users); the public namespace gets `public, s-maxage=60`. Both
// carry `Cache-Tag: <ns>:<path>` so `bustVaultCache` invalidates the
// edge entry on the next write through SupabaseStorage.

export const runtime = "nodejs";

const HEADING_H1_RE = /^#\s+(.+)$/m;
const FENCE_RE = /^\s*(?:```|~~~)/;
const H_RE = /^(#{1,6})\s+/;
const BQ_RE = /^>\s?(.*)$/;

function deriveTitle(rel: string, content: string): string {
  const m = content.match(HEADING_H1_RE);
  if (m) return m[1].trim();
  return path.basename(rel, ".md");
}

function deriveSummary(content: string): string {
  let inFence = false;
  let seenH1 = false;
  for (const line of content.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(H_RE);
    if (h) {
      if (!seenH1 && h[1] === "#") { seenH1 = true; continue; }
      if (seenH1) return "";
    }
    if (!seenH1) continue;
    const bq = line.match(BQ_RE);
    if (bq) return bq[1].trim();
  }
  return "";
}

async function shareAccess(userId: string, ownerId: string, p: string): Promise<boolean> {
  const { data } = await adminClient()
    .from("doc_shares")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("grantee_id", userId)
    .eq("path_prefix", p)
    .maybeSingle();
  return !!data;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rel = url.searchParams.get("path");
  const ns = url.searchParams.get("ns") ?? "public";
  if (!rel) return new Response("missing path", { status: 400 });
  if (!rel.endsWith(".md")) return new Response("invalid path", { status: 400 });

  const { storage, prefix, isLocal } = getVaultStorage(ns);

  if (!isLocal && ns !== "public") {
    const { userId } = await auth();
    if (!userId) return new Response("unauthorized", { status: 401 });
    if (userId !== ns) {
      const ok = await shareAccess(userId, ns, rel);
      if (!ok) return new Response("forbidden", { status: 403 });
    }
  }

  let content: string | null;
  try {
    content = await storage.read(`${prefix}${rel}`);
  } catch (err) {
    return new Response(`read failed: ${(err as Error).message}`, { status: 500 });
  }
  if (content === null) return new Response("not found", { status: 404 });

  const body = JSON.stringify({
    path: rel,
    title: deriveTitle(rel, content),
    summary: deriveSummary(content),
  });

  // Cache scope:
  //  - `public` is anonymous-readable → shared CDN entry is fine.
  //  - Personal namespaces are Clerk-gated → `private` so no shared cache
  //    can serve another user this user's content.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control":
      ns === "public"
        ? "public, s-maxage=60, stale-while-revalidate=600"
        : "private, s-maxage=60, stale-while-revalidate=600",
    "Cache-Tag": vaultPathTag(ns, rel),
  };
  return new Response(body, { headers });
}
