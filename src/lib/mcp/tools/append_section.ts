import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile } from "./vault";
import { sectionId } from "./get_doc";
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
  const headingArg = args.heading !== undefined ? String(args.heading).trim() : "";
  const sectionIdArg = args.section_id !== undefined ? String(args.section_id).trim() : "";
  const body = String(args.body ?? "");
  const createIfMissing = Boolean(args.create_if_missing ?? false);
  if (!headingArg && !sectionIdArg) throw new Error("heading or section_id required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const sections = parseSections(content);

  // Resolve target. Same precedence as patch_section.
  let target: SectionLoc | undefined;
  let idTarget: SectionLoc | undefined;
  let headingTarget: SectionLoc | undefined;
  if (sectionIdArg) {
    for (let i = 0; i < sections.length; i++) {
      if (sectionId(sections[i].heading, i) === sectionIdArg) {
        idTarget = sections[i];
        break;
      }
    }
  }
  if (headingArg) {
    headingTarget = findSection(sections, headingArg);
  }
  if (sectionIdArg && headingArg && idTarget && headingTarget && idTarget !== headingTarget) {
    return json({
      error: "section_id_heading_mismatch",
      section_id_resolves_to: idTarget.heading,
      heading_resolves_to: headingTarget.heading,
    });
  }
  target = idTarget ?? headingTarget;

  if (!target) {
    if (!createIfMissing || !headingArg) {
      return json({
        error: "section_not_found",
        heading: headingArg || undefined,
        section_id: sectionIdArg || undefined,
        available: sections.map((s, i) => ({ id: sectionId(s.heading, i), heading: s.heading })),
        hint: headingArg
          ? "Pass create_if_missing=true to create the section at end of file."
          : "Pass a heading (not just section_id) plus create_if_missing=true to create a new section.",
      });
    }
    const sep = content.endsWith("\n") ? "" : "\n";
    const newContent = content + sep + `\n## ${headingArg}\n\n${body}\n`;
    await writeVaultFile(ctx, rel, newContent);
    const newSections = parseSections(newContent);
    const newIdx = newSections.findIndex((s) => s.heading === headingArg);
    return json({
      ok: true,
      created: true,
      content_hash: hashBody(body.trim()),
      section_id: newIdx >= 0 ? sectionId(headingArg, newIdx) : undefined,
    });
  }

  const lines = content.split("\n");
  const sectionLines = lines.slice(target.headingLineIdx, target.bodyEndLineIdx);
  while (sectionLines.length > 1 && sectionLines[sectionLines.length - 1].trim() === "") sectionLines.pop();
  sectionLines.push("", ...body.split("\n"), "");
  const newContent = [...lines.slice(0, target.headingLineIdx), ...sectionLines, ...lines.slice(target.bodyEndLineIdx)].join("\n");
  await writeVaultFile(ctx, rel, newContent);

  const newSections = parseSections(newContent);
  const newIdx = newSections.findIndex((s) => s.heading === target!.heading);
  const newTarget = newIdx >= 0 ? newSections[newIdx] : undefined;
  const newBody = newTarget ? extractBody(newContent, newTarget) : "";
  return json({
    ok: true,
    content_hash: hashBody(newBody),
    section_id: newIdx >= 0 ? sectionId(target.heading, newIdx) : undefined,
  });
}
