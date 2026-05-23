import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent } from "./lint";
import { evaluateLintGate } from "./lint_gate";
import { buildLintVaultContext } from "./lint_doc";
import {
  parseSections,
  extractBody,
  hashBody,
  sectionId,
  resolveSection,
  type SectionLoc,
} from "./sections";
import type { ToolContext } from "./types";

const CROSS_DOC_CODES = new Set([
  "asymmetric_parent_edge",
  "asymmetric_child_edge",
  "sibling_assoc_redundant",
]);

function parseGateCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
  const target: SectionLoc = resolved.loc;

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

  const gateCodes = parseGateCodes(args.gate_on_warnings);
  if (gateCodes.length > 0) {
    const needsVault = gateCodes.some((c) => CROSS_DOC_CODES.has(c));
    const vaultCtx = needsVault ? buildLintVaultContext(await loadVaultIndex(ctx), rel) : undefined;
    const gate = evaluateLintGate(newContent, gateCodes, vaultCtx);
    if (!gate.ok) {
      return json({ error: "lint_gate_failed", fixes: gate.fixes, original_warnings: gate.original_warnings });
    }
  }

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
