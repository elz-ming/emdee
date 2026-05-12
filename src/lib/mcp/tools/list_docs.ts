import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function listDocs(ctx: ToolContext, _args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  return json(idx.docs.map((d) => ({ path: d.path, title: d.title, summary: d.summary })));
}
