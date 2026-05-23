import { auth } from "@clerk/nextjs/server";
import { getVaultStorage } from "@/src/lib/storage";
import { adminClient } from "@/src/lib/supabase/admin";
import { hashBody } from "@/src/lib/mcp/tools/sections";

export const dynamic = "force-dynamic";

/**
 * Check whether `userId` has a doc_shares row for `path` in `ownerId`'s vault
 * at the given permission level (or higher). Returns null if not authorized.
 * `write` callers pass requireWrite=true; reads accept either permission.
 */
async function shareAccess(
  userId: string,
  ownerId: string,
  path: string,
  requireWrite: boolean
): Promise<"read" | "write" | null> {
  const { data } = await adminClient()
    .from("doc_shares")
    .select("permission")
    .eq("owner_id", ownerId)
    .eq("grantee_id", userId)
    .eq("path_prefix", path)
    .maybeSingle();
  if (!data) return null;
  if (requireWrite && data.permission !== "write") return null;
  return data.permission as "read" | "write";
}

export async function GET(request: Request) {
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
      const access = await shareAccess(userId, ns, rel, false);
      if (!access) return new Response("forbidden", { status: 403 });
    }
  }

  try {
    const content = await storage.read(`${prefix}${rel}`);
    if (content === null) return new Response("not found", { status: 404 });

    // SPRINT-024 Phase 3: ETag mirrors get_doc's `doc_content_hash` so
    // browser/MCP clients can chain `If-None-Match` against the same
    // value they receive from the MCP tools. 304 returns no body.
    const etag = `"${hashBody(content)}"`;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "cache-control": "no-store" },
      });
    }
    return new Response(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
        ETag: etag,
      },
    });
  } catch (err) {
    return new Response(`read failed: ${(err as Error).message}`, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const url = new URL(request.url);
  const rel = url.searchParams.get("path");
  const ns = url.searchParams.get("ns") ?? "public";
  if (!rel) return new Response("missing path", { status: 400 });
  if (!rel.endsWith(".md")) return new Response("invalid path", { status: 400 });

  const body = await request.text();
  const { storage, prefix, isLocal } = getVaultStorage(ns);

  if (!isLocal) {
    const { userId } = await auth();
    if (!userId) return new Response("unauthorized", { status: 401 });
    if (userId !== ns) {
      const access = await shareAccess(userId, ns, rel, true);
      if (!access) return new Response("forbidden", { status: 403 });
    }
  }

  try {
    await storage.write(`${prefix}${rel}`, body);
    return new Response(null, { status: 204 });
  } catch (err) {
    return new Response(`save failed: ${(err as Error).message}`, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const rel = url.searchParams.get("path");
  const ns = url.searchParams.get("ns") ?? "public";
  if (!rel) return new Response("missing path", { status: 400 });
  if (!rel.endsWith(".md")) return new Response("invalid path", { status: 400 });

  const { storage, prefix, isLocal } = getVaultStorage(ns);

  if (!isLocal) {
    const { userId } = await auth();
    // Delete is owner-only — grantees can never remove someone else's doc,
    // even with write permission.
    if (!userId || userId !== ns) return new Response("forbidden", { status: 403 });
  }

  try {
    await storage.delete(`${prefix}${rel}`);
    return new Response(null, { status: 204 });
  } catch (err) {
    return new Response(`delete failed: ${(err as Error).message}`, { status: 500 });
  }
}
