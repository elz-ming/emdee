import { validatePath, readVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent, type LintVaultContext } from "./lint";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Audit a doc for known quality defects. Returns warnings + structural info.
 * Never throws on a "bad" doc — lint is a signal, not a gate.
 *
 * Single-doc rules (missing preamble, undeclared inline mentions,
 * multi-parent) and cross-doc rules (asymmetric Parent/Child edges) both
 * run here — this tool loads the full vault index, so the cross-doc
 * checks have the context they need. The post-write fast paths in
 * write_doc and patch_section skip the cross-doc rules to stay cheap.
 */
export async function lintDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const index = await loadVaultIndex(ctx);
  const docsByTitle = new Map<string, { path: string; title: string; declaredParents: string[]; declaredChildren: string[] }>();
  // Build a path-set per title so we can resolve "did doc X declare doc Y as
  // a parent/child?" without re-parsing markdown. The indexer already gave
  // us parents[] and children[] as Link[] — we map those titles back to
  // paths in the same pass.
  const pathByTitle = new Map<string, string>();
  for (const d of index.docs) pathByTitle.set(d.title.toLowerCase(), d.path);
  for (const d of index.docs) {
    const declaredParents = d.parents
      .map((l) => pathByTitle.get(l.title.toLowerCase()))
      .filter((p): p is string => !!p);
    const declaredChildren = d.children
      .map((l) => pathByTitle.get(l.title.toLowerCase()))
      .filter((p): p is string => !!p);
    docsByTitle.set(d.title.toLowerCase(), {
      path: d.path,
      title: d.title,
      declaredParents,
      declaredChildren,
    });
  }

  const lintCtx: LintVaultContext = { selfPath: rel, docsByTitle };
  const result = lintDocContent(content, lintCtx);
  return json({ path: rel, ...result });
}
