// Shared section-parsing primitives used by get_doc / patch_section /
// append_section / read_doc_section. Hoisted in SPRINT-024 Phase 1 to
// keep the H2 parser + content-hash helper in one place; previous
// per-tool copies were drifting at the edges.

import { createHash } from "node:crypto";

const FENCE_RE = /^\s*(?:```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;

export interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number;
}

export function parseSections(content: string): SectionLoc[] {
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

export function extractBody(content: string, loc: SectionLoc): string {
  return content
    .split("\n")
    .slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
}

export function findSectionByHeading(sections: SectionLoc[], heading: string): SectionLoc | undefined {
  const target = heading.replace(/^##\s*/, "").trim().toLowerCase();
  return sections.find((s) => s.heading.toLowerCase() === target);
}

/**
 * sha256-first-16-hex of the input string. Used for both section bodies
 * (the version-guard hash that gates patch_section) and whole-doc raw
 * content (the doc_content_hash returned by get_doc / get_context for
 * hash-conditional reads, SPRINT-024 Phase 1).
 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/**
 * Deterministic short ID for an H2 section. Derived from the lowercased
 * heading text plus the section's 0-indexed ordinal among H2s in the doc,
 * so two sections sharing a heading get distinct IDs. The ordinal also
 * means the ID is stable across rename of the heading IF the section
 * stays at the same position.
 */
export function sectionId(heading: string, ordinalIdx: number): string {
  return createHash("sha256")
    .update(heading.toLowerCase() + ":" + ordinalIdx, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Resolve a section lookup. Shared between patch_section / append_section /
 * read_doc_section so the section_id_heading_mismatch and section_not_found
 * shapes are identical across tools.
 *
 * Precedence:
 *  - section_id alone: derive IDs by ordinal; first match wins.
 *  - heading alone: fuzzy heading match.
 *  - both: resolve each independently; if they pick different sections,
 *    returns { kind: "mismatch" } so the caller emits section_id_heading_mismatch.
 */
export type SectionResolution =
  | { kind: "ok"; loc: SectionLoc; idx: number }
  | {
      kind: "mismatch";
      section_id_resolves_to: string;
      heading_resolves_to: string;
    }
  | { kind: "not_found"; available: Array<{ id: string; heading: string }> };

export function resolveSection(
  sections: SectionLoc[],
  sectionIdArg: string,
  headingArg: string,
): SectionResolution {
  let idTarget: { loc: SectionLoc; idx: number } | undefined;
  let headingTarget: { loc: SectionLoc; idx: number } | undefined;

  if (sectionIdArg) {
    for (let i = 0; i < sections.length; i++) {
      if (sectionId(sections[i].heading, i) === sectionIdArg) {
        idTarget = { loc: sections[i], idx: i };
        break;
      }
    }
  }
  if (headingArg) {
    const loc = findSectionByHeading(sections, headingArg);
    if (loc) {
      const idx = sections.indexOf(loc);
      headingTarget = { loc, idx };
    }
  }

  if (sectionIdArg && headingArg && idTarget && headingTarget && idTarget.loc !== headingTarget.loc) {
    return {
      kind: "mismatch",
      section_id_resolves_to: idTarget.loc.heading,
      heading_resolves_to: headingTarget.loc.heading,
    };
  }

  const picked = idTarget ?? headingTarget;
  if (picked) return { kind: "ok", loc: picked.loc, idx: picked.idx };

  return {
    kind: "not_found",
    available: sections.map((s, i) => ({ id: sectionId(s.heading, i), heading: s.heading })),
  };
}
