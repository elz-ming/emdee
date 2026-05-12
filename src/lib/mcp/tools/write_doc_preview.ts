import { validatePath, readVaultFile } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface SectionLoc { heading: string; headingLineIdx: number; bodyStartLineIdx: number; bodyEndLineIdx: number; }
const FENCE_RE = /^\s*(?:```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;

function parseSections(content: string): SectionLoc[] {
  const lines = content.split("\n");
  const sections: SectionLoc[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(H2_RE);
    if (!m) continue;
    if (sections.length > 0) sections[sections.length - 1].bodyEndLineIdx = i;
    sections.push({ heading: m[1].trim(), headingLineIdx: i, bodyStartLineIdx: i + 1, bodyEndLineIdx: lines.length });
  }
  return sections;
}

function simpleDiff(before: string, after: string): string {
  const bl = before.split("\n"), al = after.split("\n");
  let cp = 0, cs = 0;
  while (cp < bl.length && cp < al.length && bl[cp] === al[cp]) cp++;
  while (cs < bl.length - cp && cs < al.length - cp && bl[bl.length - 1 - cs] === al[al.length - 1 - cs]) cs++;
  const out = [`--- before (${bl.length} lines)`, `+++ after  (${al.length} lines)`];
  if (cp > 0) out.push(`  … ${cp} unchanged …`);
  for (let i = cp; i < bl.length - cs; i++) out.push(`- ${bl[i]}`);
  for (let i = cp; i < al.length - cs; i++) out.push(`+ ${al[i]}`);
  if (cs > 0) out.push(`  … ${cs} unchanged …`);
  return out.join("\n");
}

export async function writeDocPreview(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const newContent = String(args.content ?? "");
  const before = await readVaultFile(ctx, rel);
  if (before === null) return json({ action: "create", path: rel, new_size_lines: newContent.split("\n").length });
  if (before === newContent) return json({ action: "no_change", path: rel });
  const beforeSections = parseSections(before).map((s) => s.heading);
  const afterSections = parseSections(newContent).map((s) => s.heading);
  const removed = beforeSections.filter((h) => !afterSections.includes(h));
  return json({ action: "replace", path: rel, sections_removed: removed, sections_before: beforeSections, sections_after: afterSections, diff: simpleDiff(before, newContent) });
}
