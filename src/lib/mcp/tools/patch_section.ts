import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile } from "./vault";
import { lintDocContent } from "./lint";
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

export async function patchSection(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const headingArg = args.heading !== undefined ? String(args.heading).trim() : "";
  const sectionIdArg = args.section_id !== undefined ? String(args.section_id).trim() : "";
  const body = String(args.body ?? "");
  const expected = String(args.expected_content_hash ?? "");
  if (!headingArg && !sectionIdArg) throw new Error("heading or section_id required");
  if (!expected) throw new Error("expected_content_hash required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const sections = parseSections(content);

  // Resolve target. Precedence:
  //  - section_id alone: derive IDs by ordinal; first match wins.
  //  - heading alone: legacy fuzzy heading match.
  //  - both: resolve each independently; if they pick different sections,
  //    return section_id_heading_mismatch so the caller can reconcile
  //    rather than letting the lookup silently prefer one over the other.
  let target: SectionLoc | undefined;
  let idTarget: { loc: SectionLoc; idx: number } | undefined;
  let headingTarget: SectionLoc | undefined;
  if (sectionIdArg) {
    for (let i = 0; i < sections.length; i++) {
      if (sectionId(sections[i].heading, i) === sectionIdArg) {
        idTarget = { loc: sections[i], idx: i };
        break;
      }
    }
  }
  if (headingArg) {
    headingTarget = findSection(sections, headingArg);
  }
  if (sectionIdArg && headingArg) {
    if (!idTarget && !headingTarget) {
      return json({
        error: "section_not_found",
        heading: headingArg,
        section_id: sectionIdArg,
        available: sections.map((s, i) => ({ id: sectionId(s.heading, i), heading: s.heading })),
      });
    }
    if (idTarget && headingTarget && idTarget.loc !== headingTarget) {
      return json({
        error: "section_id_heading_mismatch",
        section_id_resolves_to: idTarget.loc.heading,
        heading_resolves_to: headingTarget.heading,
      });
    }
    target = idTarget?.loc ?? headingTarget;
  } else if (sectionIdArg) {
    target = idTarget?.loc;
  } else {
    target = headingTarget;
  }

  if (!target) {
    return json({
      error: "section_not_found",
      heading: headingArg || undefined,
      section_id: sectionIdArg || undefined,
      available: sections.map((s, i) => ({ id: sectionId(s.heading, i), heading: s.heading })),
    });
  }

  const currentBody = extractBody(content, target);
  const currentHash = hashBody(currentBody);
  if (currentHash !== expected) {
    return json({ error: "version_conflict", heading: target.heading, expected_content_hash: expected, actual_content_hash: currentHash, message: "Section was modified since you last read it. Call get_doc again and reconcile." });
  }

  const lines = content.split("\n");
  const newContent = [
    ...lines.slice(0, target.headingLineIdx + 1),
    "",
    ...body.split("\n"),
    "",
    ...lines.slice(target.bodyEndLineIdx),
  ].join("\n");
  await writeVaultFile(ctx, rel, newContent);

  // Re-derive ordinal under the new content so the returned section_id
  // remains stable for chained edits (the section may have shifted
  // position if the body insertion grew it). In practice patch_section
  // never reshuffles H2 order — included defensively.
  const newSections = parseSections(newContent);
  const newIdx = newSections.findIndex((s) => s.heading === target!.heading);
  const newId = newIdx >= 0 ? sectionId(target!.heading, newIdx) : undefined;

  const lint = lintDocContent(newContent);
  const payload: Record<string, unknown> = {
    ok: true,
    content_hash: hashBody(body.trim()),
    section_id: newId,
  };
  if (lint.warnings.length > 0) payload.warnings = lint.warnings;
  return json(payload);
}
