import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VaultFile, VaultStorage } from "./VaultStorage";

/**
 * Filesystem-backed vault used in local development. Paths are relative to
 * `rootDir`. Used by /api/index, /api/doc, etc. when `EMDEE_DOCS` is set so
 * the dev experience reads/writes ./docs directly instead of round-tripping
 * through Supabase.
 */
export class FilesystemStorage implements VaultStorage {
  constructor(private rootDir: string) {}

  async list(prefix?: string): Promise<VaultFile[]> {
    const start = prefix
      ? path.join(this.rootDir, prefix.replace(/\/$/, ""))
      : this.rootDir;
    try {
      await stat(start);
    } catch {
      return [];
    }
    const collected: VaultFile[] = [];
    await this.walk(start, collected);
    return collected;
  }

  private async walk(dir: string, out: VaultFile[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.walk(full, out);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const s = await stat(full);
        out.push({
          path: path.relative(this.rootDir, full),
          content: "",
          updatedAt: s.mtime.toISOString(),
        });
      }
    }
  }

  /** FS already lists metadata without bodies — listMeta is an alias. */
  async listMeta(prefix?: string): Promise<VaultFile[]> {
    return this.list(prefix);
  }

  async listWithContent(prefix?: string): Promise<VaultFile[]> {
    const listed = await this.list(prefix);
    return Promise.all(
      listed.map(async (f) => ({
        path: f.path,
        content: (await this.read(f.path)) ?? "",
        updatedAt: f.updatedAt,
      }))
    );
  }

  async read(filePath: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.rootDir, filePath), "utf8");
    } catch {
      return null;
    }
  }

  async write(filePath: string, content: string): Promise<void> {
    const full = path.join(this.rootDir, filePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async delete(filePath: string): Promise<void> {
    await rm(path.join(this.rootDir, filePath), { force: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(path.join(this.rootDir, filePath));
      return true;
    } catch {
      return false;
    }
  }
}
