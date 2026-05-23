import { createHash } from "node:crypto";
import { loadVaultIndex } from "./vault";
import { extractPreamble } from "./patch_preamble";
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

function extractBody(content: string, loc: SectionLoc): string {
  return content.split("\n").slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx).join("\n").replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/**
 * Deterministic short ID for an H2 section. Derived from the lowercased
 * heading text plus the section's 0-indexed ordinal among H2s in the doc,
 * so two sections that happen to share a heading (rare but valid) get
 * distinct IDs. No DB persistence — the value re-derives on every read.
 *
 * SPRINT-019 Phase B: stable lookup key for patch_section / append_section,
 * complements the existing fuzzy heading-name match. The ordinal also
 * means the ID is stable across rename of the heading IF the section
 * stays at the same position — which is the right behaviour for the
 * "I just got these IDs from get_doc, now patch one of them" flow.
 */
export function sectionId(heading: string, ordinalIdx: number): string {
  return createHash("sha256")
    .update(heading.toLowerCase() + ":" + ordinalIdx, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Return doc metadata. SPRINT-018 Phase 5: the body is now opt-in via
 * `full=true`. The default response is light — title + summary +
 * preamble + section headings — and is intended as the staple
 * navigation primitive. Callers that need the full markdown body must
 * either pass `full: true` or (preferred for graph-aware queries) use
 * `get_context` to get the focal + its neighbourhood in one call.
 */
export async function getDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const doc = idx.docs.find((d) => d.path === String(args.path));
  if (!doc) throw new Error(`no such doc: ${args.path}`);
  const full = Boolean(args.full);
  const sections = parseSections(doc.content).map((s, idx) => ({
    id: sectionId(s.heading, idx),
    heading: s.heading,
    content_hash: hashBody(extractBody(doc.content, s)),
  }));
  const preamble = extractPreamble(doc.content);
  const payload: Record<string, unknown> = {
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    preamble: preamble ?? undefined,
    sections,
  };
  if (full) payload.content = doc.content;
  return json(payload);
}
