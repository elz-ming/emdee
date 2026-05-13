import { adminClient } from "@/src/lib/supabase/admin";
import type { VaultFile, VaultStorage } from "./VaultStorage";

const BUCKET = "vaults";

export class SupabaseStorage implements VaultStorage {
  private bucket() {
    return adminClient().storage.from(BUCKET);
  }

  async list(prefix?: string): Promise<VaultFile[]> {
    const folder = prefix ? prefix.replace(/\/$/, "") : "";
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

  async read(filePath: string): Promise<string | null> {
    const { data, error } = await this.bucket().download(filePath);
    if (error || !data) return null;
    return await data.text();
  }

  async write(filePath: string, content: string): Promise<void> {
    const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
    const { error } = await this.bucket().upload(filePath, blob, {
      upsert: true,
      contentType: "text/markdown; charset=utf-8",
    });
    if (error) throw new Error(`storage write failed: ${error.message}`);
  }

  async delete(filePath: string): Promise<void> {
    await this.bucket().remove([filePath]);
  }

  async exists(filePath: string): Promise<boolean> {
    const parts = filePath.split("/");
    const name = parts.pop()!;
    const folder = parts.join("/");
    const { data } = await this.bucket().list(folder || undefined, { search: name, limit: 1 });
    return (data ?? []).some((f) => f.name === name && f.id !== null);
  }
}
