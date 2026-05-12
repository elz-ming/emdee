import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number;
}

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

function findSection(sections: SectionLoc[], heading: string): SectionLoc | undefined {
  const target = heading.replace(/^##\s*/, "").trim().toLowerCase();
  return sections.find((s) => s.heading.toLowerCase() === target);
}

function extractBody(content: string, loc: SectionLoc): string {
  return content.split("\n").slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx).join("\n").replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

export async function appendSection(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const heading = String(args.heading ?? "").trim();
  const body = String(args.body ?? "");
  const createIfMissing = Boolean(args.create_if_missing ?? false);
  if (!heading) throw new Error("heading required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const sections = parseSections(content);
  const target = findSection(sections, heading);

  if (!target) {
    if (!createIfMissing) {
      return json({ error: "section_not_found", heading, available: sections.map((s) => s.heading), hint: "Pass create_if_missing=true to create the section at end of file." });
    }
    const sep = content.endsWith("\n") ? "" : "\n";
    const newContent = content + sep + `\n## ${heading}\n\n${body}\n`;
    await writeVaultFile(ctx, rel, newContent);
    return json({ ok: true, created: true, content_hash: hashBody(body.trim()) });
  }

  const lines = content.split("\n");
  const sectionLines = lines.slice(target.headingLineIdx, target.bodyEndLineIdx);
  while (sectionLines.length > 1 && sectionLines[sectionLines.length - 1].trim() === "") sectionLines.pop();
  sectionLines.push("", ...body.split("\n"), "");
  const newContent = [...lines.slice(0, target.headingLineIdx), ...sectionLines, ...lines.slice(target.bodyEndLineIdx)].join("\n");
  await writeVaultFile(ctx, rel, newContent);

  const newSections = parseSections(newContent);
  const newTarget = findSection(newSections, heading);
  const newBody = newTarget ? extractBody(newContent, newTarget) : "";
  return json({ ok: true, content_hash: hashBody(newBody) });
}
