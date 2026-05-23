import { adminClient } from "@/src/lib/supabase/admin";
import { syncDocEdges, deleteDocEdges } from "@/src/core/syncDocEdges";
import type { VaultFile, VaultStorage } from "./VaultStorage";

const BUCKET = "vaults";
const CACHE_TABLE = "vault_files";

/**
 * Split a full storage path ("user_X/foo/bar.md") into the cache table's
 * composite key (namespace, file_path). Returns null for unprefixed paths
 * which shouldn't happen in practice but we tolerate.
 */
function splitNs(p: string): { namespace: string; file_path: string } | null {
  const i = p.indexOf("/");
  if (i === -1) return null;
  return { namespace: p.slice(0, i), file_path: p.slice(i + 1) };
}

export class SupabaseStorage implements VaultStorage {
  private bucket() {
    return adminClient().storage.from(BUCKET);
  }

  async list(prefix?: string): Promise<VaultFile[]> {
    const folder = prefix ? prefix.replace(/\/$/, "") : "";
    return this.walkFolder(folder);
  }

  /**
   * Metadata-only list. SPRINT-024 Phase 2 — selects only the columns the
   * caller needs (namespace, file_path, updated_at) so the wire payload is
   * a fraction of `listWithContent`'s. Used by change-polling and other
   * surfaces that just want "what files exist + when did they last move".
   *
   * Like `listWithContent`, the fast path requires a single-segment
   * namespace prefix; deeper prefixes fall back to walking Storage and
   * stamping empty bodies.
   */
  async listMeta(prefix?: string): Promise<VaultFile[]> {
    const folder = prefix ? prefix.replace(/\/$/, "") : "";
    if (!folder || folder.includes("/")) {
      return this.walkFolder(folder);
    }
    const { data, error } = await adminClient()
      .from(CACHE_TABLE)
      .select("file_path, updated_at")
      .eq("namespace", folder);
    if (!error && data) {
      return data.map((r) => ({
        path: `${folder}/${r.file_path}`,
        content: "",
        updatedAt: r.updated_at as string,
      }));
    }
    return this.walkFolder(folder);
  }

  private async walkFolder(folder: string): Promise<VaultFile[]> {
    const { data, error } = await this.bucket().list(folder || undefined, { limit: 1000 });
    if (error || !data) return [];

    const results: VaultFile[] = [];
    await Promise.all(
      data.map(async (item) => {
        const itemPath = folder ? `${folder}/${item.name}` : item.name;
        if (item.id === null) {
          results.push(...(await this.walkFolder(itemPath)));
        } else if (item.name.endsWith(".md")) {
          results.push({
            path: itemPath,
            content: "",
            updatedAt: item.updated_at ?? new Date(0).toISOString(),
          });
        }
      })
    );
    return results;
  }

  /**
   * Bulk-fetch every file under `prefix` via the vault_files cache. The
   * cache is a derived index of Storage — if it's empty for a namespace
   * we fall back to listing Storage and downloading each file, then
   * repopulate the cache so subsequent reads are fast.
   */
  async listWithContent(prefix?: string): Promise<VaultFile[]> {
    const folder = prefix ? prefix.replace(/\/$/, "") : "";
    // Cache is keyed by namespace; only fast-path when we have one.
    if (!folder || folder.includes("/")) {
      return this.bulkReadFromStorage(folder);
    }

    const admin = adminClient();
    const { data, error } = await admin
      .from(CACHE_TABLE)
      .select("file_path, content, updated_at")
      .eq("namespace", folder);

    if (!error && data && data.length > 0) {
      return data.map((r) => ({
        path: `${folder}/${r.file_path}`,
        content: r.content,
        updatedAt: r.updated_at,
      }));
    }

    // Cache miss (or error) — pay the slow path once and repopulate.
    const files = await this.bulkReadFromStorage(folder);
    if (files.length > 0) {
      const rows = files
        .map((f) => {
          const split = splitNs(f.path);
          if (!split) return null;
          return { namespace: split.namespace, file_path: split.file_path, content: f.content };
        })
        .filter((r): r is { namespace: string; file_path: string; content: string } => r !== null);
      if (rows.length > 0) {
        await admin.from(CACHE_TABLE).upsert(rows, { onConflict: "namespace,file_path" });
      }
    }
    return files;
  }

  private async bulkReadFromStorage(folder: string): Promise<VaultFile[]> {
    const listed = await this.walkFolder(folder);
    return Promise.all(
      listed.map(async (f) => ({
        path: f.path,
        content: (await this.read(f.path)) ?? "",
        updatedAt: f.updatedAt,
      }))
    );
  }

  async read(filePath: string): Promise<string | null> {
    const split = splitNs(filePath);
    if (split) {
      const { data: cacheRow } = await adminClient()
        .from(CACHE_TABLE)
        .select("content")
        .match({ namespace: split.namespace, file_path: split.file_path })
        .maybeSingle();
      if (cacheRow) return (cacheRow.content as string) ?? "";
    }
    // Fall back to Storage for unsplit paths or cache misses; repopulate
    // the cache on success so subsequent reads stay fast.
    const { data, error } = await this.bucket().download(filePath);
    if (error || !data) return null;
    const content = await data.text();
    if (split) {
      try {
        await adminClient()
          .from(CACHE_TABLE)
          .upsert(
            { namespace: split.namespace, file_path: split.file_path, content, updated_at: new Date().toISOString() },
            { onConflict: "namespace,file_path" }
          );
      } catch {}
    }
    return content;
  }

  async write(filePath: string, content: string): Promise<void> {
    // Storage is canonical — fail here propagates.
    const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
    const { error } = await this.bucket().upload(filePath, blob, {
      upsert: true,
      contentType: "text/markdown; charset=utf-8",
    });
    if (error) throw new Error(`storage write failed: ${error.message}`);

    // Cache mirror — best-effort. If this fails the cache is stale; on
    // next read we'd return stale content, but a rebuild script
    // (scripts/backfill-vault-files.mjs) restores parity.
    const split = splitNs(filePath);
    if (!split) return;
    try {
      const { error: cacheErr } = await adminClient()
        .from(CACHE_TABLE)
        .upsert(
          { namespace: split.namespace, file_path: split.file_path, content, updated_at: new Date().toISOString() },
          { onConflict: "namespace,file_path" }
        );
      if (cacheErr) console.error(`vault_files cache write failed for ${filePath}:`, cacheErr.message);
    } catch (e) {
      console.error(`vault_files cache write threw for ${filePath}:`, e);
    }

    // SPRINT-018 Phase 2: keep doc_edges in sync after the cache mirror.
    // Sync errors propagate — the bucket + cache have already committed
    // (documented asymmetry), but a failed sync means the edges are
    // wrong and the caller should know about it (HTTP 500).
    await syncDocEdges(adminClient(), split.namespace, split.file_path, content);
  }

  async delete(filePath: string): Promise<void> {
    await this.bucket().remove([filePath]);
    const split = splitNs(filePath);
    if (!split) return;
    try {
      const { error: cacheErr } = await adminClient()
        .from(CACHE_TABLE)
        .delete()
        .match({ namespace: split.namespace, file_path: split.file_path });
      if (cacheErr) console.error(`vault_files cache delete failed for ${filePath}:`, cacheErr.message);
    } catch (e) {
      console.error(`vault_files cache delete threw for ${filePath}:`, e);
    }

    // SPRINT-018 Phase 2: drop every edge touching this doc. Sync errors
    // propagate — see comment on write() above for the asymmetry note.
    await deleteDocEdges(adminClient(), split.namespace, split.file_path);
  }

  async exists(filePath: string): Promise<boolean> {
    const parts = filePath.split("/");
    const name = parts.pop()!;
    const folder = parts.join("/");
    const { data } = await this.bucket().list(folder || undefined, { search: name, limit: 1 });
    return (data ?? []).some((f) => f.name === name && f.id !== null);
  }
}
