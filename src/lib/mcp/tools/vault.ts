import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildIndex, buildIndexFromContents, type DocIndex } from "../../../core/indexer";
import type { ToolContext } from "./types";

export function validatePath(rel: string): void {
  if (!rel || rel.includes("..")) throw new Error("invalid path");
  if (!rel.endsWith(".md")) throw new Error("path must end in .md");
}

function localSafePath(docsDir: string, rel: string): string {
  const resolved = path.resolve(docsDir, rel);
  if (!resolved.startsWith(docsDir + path.sep) && resolved !== docsDir) {
    throw new Error("path escapes docs directory");
  }
  return resolved;
}

export async function loadVaultIndex(ctx: ToolContext): Promise<DocIndex> {
  if (ctx.mode === "local") return buildIndex(ctx.docsDir);
  const prefix = `${ctx.userId}/`;
  const files = await ctx.storage.list(prefix);
  const withContent = await Promise.all(
    files.map(async (f) => ({
      path: f.path.slice(prefix.length),
      content: (await ctx.storage.read(f.path)) ?? "",
    }))
  );
  return buildIndexFromContents(withContent);
}

export async function readVaultFile(ctx: ToolContext, rel: string): Promise<string | null> {
  if (ctx.mode === "local") {
    try {
      return await readFile(localSafePath(ctx.docsDir, rel), "utf8");
    } catch {
      return null;
    }
  }
  return ctx.storage.read(`${ctx.userId}/${rel}`);
}

export async function writeVaultFile(ctx: ToolContext, rel: string, content: string): Promise<void> {
  if (ctx.mode === "local") {
    const file = localSafePath(ctx.docsDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return;
  }
  await ctx.storage.write(`${ctx.userId}/${rel}`, content);
}
