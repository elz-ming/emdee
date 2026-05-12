import { validatePath, writeVaultFile } from "./vault";
import type { ToolContext } from "./types";

export async function writeDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  await writeVaultFile(ctx, rel, String(args.content ?? ""));
  return { content: [{ type: "text", text: `wrote ${rel}` }] };
}
