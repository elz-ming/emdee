import { auth } from "@clerk/nextjs/server";
import { buildIndexFromContents, type Edge } from "@/src/core/indexer";
import { getVaultStorage } from "@/src/lib/storage";
import type { VaultStorage } from "@/src/lib/storage";
import { adminClient } from "@/src/lib/supabase/admin";
import { ensureProfile } from "@/src/lib/supabase/oauth";
import { vaultListTag } from "@/src/lib/cache/bust";

// SPRINT-024 Phase 3: dropped `dynamic = "force-dynamic"` so the public
// namespace can sit behind Vercel's edge cache. Personal namespaces are
// still gated by Clerk auth and emit `no-store`; only `?ns=public` gets
// `s-maxage` + a Cache-Tag so `bustVaultCache("public", …)` can purge it
// on writes.
export const runtime = "nodejs";

const EMPTY = { docs: [], edges: [], entry: null };
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function publicCacheHeaders(ns: string): Record<string, string> {
  return {
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
    // Vercel-specific: when present, `revalidateTag(tag)` purges any
    // edge entry carrying this tag. Off Vercel this header is ignored
    // and the s-maxage TTL is the only invalidator (60s eventual).
    "Cache-Tag": vaultListTag(ns),
  };
}

/**
 * Copy every file under `public/` into `{ns}/` as a starter set. Called once
 * the first time an authenticated user opens their own empty workspace, so
 * they see the same intro tree visitors see at `/`.
 */
async function seedFromPublic(storage: VaultStorage, ns: string): Promise<void> {
  const seeds = await storage.listWithContent("public/");
  await Promise.all(
    seeds.map(async (f) => {
      const relative = f.path.slice("public/".length);
      await storage.write(`${ns}/${relative}`, f.content);
    })
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";

  const { storage, prefix, isLocal } = getVaultStorage(ns);

  // Cloud-mode prerequisites: Supabase credentials must be present.
  if (
    !isLocal &&
    (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY))
  ) {
    return Response.json(EMPTY, NO_STORE);
  }

  // Auth gate for personal namespaces. `public` is open; everything else must
  // be owned by the requester. Local mode is single-tenant — skip the gate.
  let canSeedIfEmpty = false;
  if (!isLocal && ns !== "public") {
    const { userId } = await auth();
    if (!userId || userId !== ns) {
      return Response.json(EMPTY, NO_STORE);
    }
    canSeedIfEmpty = true;
    // Backfill email + claim any pending share invitations on first index load.
    ensureProfile(userId).catch(() => {});
  }

  let listed: Awaited<ReturnType<typeof storage.listWithContent>>;
  try {
    listed = await storage.listWithContent(prefix || undefined);
  } catch {
    listed = [];
  }

  // First-visit seed: copy public/ → {userId}/ once (cloud only). Seed
  // writes go through storage.write which dual-updates the cache, so the
  // re-list after seeding hits the fast path.
  if (listed.length === 0 && canSeedIfEmpty) {
    await seedFromPublic(storage, ns);
    try {
      listed = await storage.listWithContent(prefix);
    } catch {
      listed = [];
    }
  }

  if (listed.length === 0) {
    return Response.json(EMPTY, NO_STORE);
  }

  const files = listed.map((f) => ({
    path: prefix ? f.path.slice(prefix.length) : f.path,
    content: f.content,
  }));

  const index = buildIndexFromContents(files);

  // SPRINT-018 Phase 3: in cloud mode, override the indexer's parsed
  // edges with the materialized doc_edges rows. Same suppression rules
  // (the backfill + write hooks apply them at insert time), but no
  // markdown re-parse cost here. Local dev keeps the indexer's edges so
  // EMDEE_DOCS workflows don't need a database round-trip.
  if (!isLocal) {
    const { data: rows, error } = await adminClient()
      .from("doc_edges")
      .select("from_path, to_path, kind")
      .eq("namespace", ns);
    if (!error && rows) {
      // Assoc rows are stored once per direction in doc_edges (two rows
      // per pair); the indexer's Edge[] expects one row per pair with
      // from < to. Dedupe accordingly so the graph renderer doesn't
      // double-draw associates.
      const seen = new Set<string>();
      const edges: Edge[] = [];
      for (const r of rows) {
        const from = r.from_path as string;
        const to = r.to_path as string;
        const kind = r.kind as "hierarchy" | "assoc";
        if (kind === "assoc") {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const key = `A:${lo}::${hi}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: lo, to: hi, kind });
        } else {
          const key = `H:${from}::${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from, to, kind });
        }
      }
      index.edges = edges;
    }
  }

  const headers = ns === "public" ? publicCacheHeaders(ns) : NO_STORE.headers;
  return Response.json(index, { headers });
}
