import { auth } from "@clerk/nextjs/server";
import { getVaultStorage } from "@/src/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight version endpoint for change polling. Returns the max
 * `updated_at` in the namespace as a string. Clients call this every few
 * seconds; when the value changes they reload the full index.
 *
 * Cheaper than re-listing/reading docs on every poll — `storage.list()`
 * returns timestamps without downloading bodies.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";
  const { storage, prefix, isLocal } = getVaultStorage(ns);

  if (!isLocal && ns !== "public") {
    const { userId } = await auth();
    if (!userId || userId !== ns) {
      return Response.json({ version: null }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  try {
    // SPRINT-024 Phase 2: listMeta pulls {file_path, updated_at} from the
    // vault_files cache — no recursive Storage walk, no body bytes.
    const listed = await storage.listMeta(prefix || undefined);
    const version = listed.reduce((max, f) => (f.updatedAt > max ? f.updatedAt : max), "");
    return Response.json({ version: version || null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ version: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
