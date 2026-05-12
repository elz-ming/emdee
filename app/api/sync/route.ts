import { put, list } from "@vercel/blob";
import { auth } from "@clerk/nextjs/server";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

async function sha256(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ConflictFile {
  path: string;
  localHash: string;
  cloudUploadedAt: string;
  manifestSyncedAt: string;
}

// POST /api/sync — uploads local docs to Vercel Blob under the user's namespace.
// Namespace is the Clerk userId. Returns { synced, files } or { conflicts }.
// Pass ?force=true to skip conflict detection.
export async function POST(request: Request) {
  const docsDir = process.env.EMDEE_DOCS;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";
  // ns param lets the CLI specify "public" namespace; web app uses the Clerk userId
  const nsParam = url.searchParams.get("ns");

  if (!docsDir) return Response.json({ error: "EMDEE_DOCS not set" }, { status: 400 });
  if (!token) return Response.json({ error: "BLOB_READ_WRITE_TOKEN not set" }, { status: 400 });

  // Resolve namespace: explicit ?ns param (for CLI) or Clerk userId (for web)
  let ns: string;
  if (nsParam) {
    ns = nsParam;
  } else {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "not authenticated" }, { status: 401 });
    ns = userId;
  }

  const resolved = path.resolve(docsDir);
  try { await stat(resolved); } catch {
    return Response.json({ error: "docs directory not found" }, { status: 400 });
  }

  const files = await walk(resolved, resolved);
  const namespacedPaths = files.map((rel) => `${ns}/${rel}`);

  // Read all local files and compute hashes
  const localFiles = await Promise.all(
    files.map(async (rel) => {
      const content = await readFile(path.join(resolved, rel), "utf8");
      const hash = await sha256(content);
      return { rel, namespacedPath: `${ns}/${rel}`, content, hash };
    })
  );

  if (!force) {
    const { data: manifest } = await adminClient()
      .from("sync_manifest")
      .select("file_path, content_hash, synced_at")
      .in("file_path", namespacedPaths);

    const manifestByPath = new Map(
      (manifest ?? []).map((r: { file_path: string; content_hash: string; synced_at: string }) => [r.file_path, r])
    );

    const { blobs } = await list({ token, prefix: `${ns}/` });
    const blobByPath = new Map(blobs.map((b) => [b.pathname, b]));

    const conflicts: ConflictFile[] = [];
    for (const { rel, namespacedPath, hash } of localFiles) {
      const manifest_row = manifestByPath.get(namespacedPath);
      if (!manifest_row) continue;

      const localChanged = hash !== manifest_row.content_hash;
      const blob = blobByPath.get(namespacedPath);
      const cloudChanged = blob
        ? new Date(blob.uploadedAt) > new Date(manifest_row.synced_at)
        : false;

      if (localChanged && cloudChanged) {
        conflicts.push({
          path: rel,
          localHash: hash,
          cloudUploadedAt: blob!.uploadedAt.toISOString(),
          manifestSyncedAt: manifest_row.synced_at,
        });
      }
    }

    if (conflicts.length > 0) return Response.json({ conflicts });
  }

  const now = new Date().toISOString();
  await Promise.all(
    localFiles.map(({ namespacedPath, content }) =>
      put(namespacedPath, content, { access: "private", addRandomSuffix: false, token })
    )
  );

  const upsertRows = localFiles.map(({ namespacedPath, hash }) => ({
    file_path: namespacedPath,
    content_hash: hash,
    synced_at: now,
    clerk_id: ns === "public" ? null : ns,
  }));
  await adminClient()
    .from("sync_manifest")
    .upsert(upsertRows, { onConflict: "file_path" });

  return Response.json({ synced: files.length, files });
}

// GET /api/sync — returns whether sync is available (EMDEE_DOCS + blob token configured)
export async function GET() {
  const canSync = !!(process.env.EMDEE_DOCS && process.env.BLOB_READ_WRITE_TOKEN);
  return Response.json({ canSync });
}
