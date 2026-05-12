import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function makeSnippet(content: string, query: string, radius = 60): string {
  const i = content.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - radius);
  const end = Math.min(content.length, i + query.length + radius);
  return (start > 0 ? "…" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "…" : "");
}

export async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? "").trim();
  if (!query) return json([]);
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
  const idx = await loadVaultIndex(ctx);
  const q = query.toLowerCase();
  const hits = idx.docs
    .map((d) => {
      const titleHit = d.title.toLowerCase().includes(q);
      const summaryHit = d.summary.toLowerCase().includes(q);
      const contentHit = d.content.toLowerCase().includes(q);
      if (!titleHit && !summaryHit && !contentHit) return null;
      const score = (titleHit ? 3 : 0) + (summaryHit ? 2 : 0) + (contentHit ? 1 : 0);
      return { score, ref: { path: d.path, title: d.title, summary: d.summary, snippet: titleHit ? "" : makeSnippet(d.content, query) } };
    })
    .filter((x): x is { score: number; ref: { path: string; title: string; summary: string; snippet: string } } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.ref);
  return json(hits);
}
