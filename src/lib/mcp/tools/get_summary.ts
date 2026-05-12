import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function getSummary(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const doc = idx.docs.find((d) => d.path === String(args.path));
  if (!doc) throw new Error(`no such doc: ${args.path}`);
  return json({ path: doc.path, title: doc.title, summary: doc.summary });
}
