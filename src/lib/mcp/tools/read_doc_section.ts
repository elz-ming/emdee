// SPRINT-024 Phase 1: per-section read. Returns one section's body +
// content_hash + section_id without paying for the entire doc body.
// Supports the same hash-conditional short-circuit as get_doc: pass
// `expected_content_hash` from a prior read and we'll short-return
// `{ unchanged: true, ... }` when the section body is byte-equal.
//
// Lookup precedence mirrors patch_section / append_section exactly
// (see resolveSection in ./sections.ts) so the section_id flow is
// uniform across read and write tools.

import { validatePath, readVaultFile } from "./vault";
import {
  parseSections,
  extractBody,
  hashBody,
  sectionId,
  resolveSection,
} from "./sections";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function readDocSection(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const headingArg = args.heading !== undefined ? String(args.heading).trim() : "";
  const sectionIdArg = args.section_id !== undefined ? String(args.section_id).trim() : "";
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : "";
  if (!headingArg && !sectionIdArg) throw new Error("heading or section_id required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const sections = parseSections(content);
  const resolved = resolveSection(sections, sectionIdArg, headingArg);
  if (resolved.kind === "mismatch") {
    return json({
      error: "section_id_heading_mismatch",
      section_id_resolves_to: resolved.section_id_resolves_to,
      heading_resolves_to: resolved.heading_resolves_to,
    });
  }
  if (resolved.kind === "not_found") {
    return json({
      error: "section_not_found",
      heading: headingArg || undefined,
      section_id: sectionIdArg || undefined,
      available: resolved.available,
    });
  }

  const { loc, idx } = resolved;
  const body = extractBody(content, loc);
  const contentHash = hashBody(body);
  const id = sectionId(loc.heading, idx);

  if (expected && expected === contentHash) {
    return json({ unchanged: true, section_id: id, content_hash: contentHash });
  }

  return json({
    path: rel,
    section_id: id,
    heading: loc.heading,
    body,
    content_hash: contentHash,
  });
}
