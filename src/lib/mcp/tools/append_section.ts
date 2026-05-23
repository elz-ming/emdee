import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
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

async function runGateOrError(
  ctx: ToolContext,
  rel: string,
  proposed: string,
  gateCodes: string[],
): Promise<{ error: "lint_gate_failed"; fixes: unknown; original_warnings: unknown } | null> {
  if (gateCodes.length === 0) return null;
  const needsVault = gateCodes.some((c) => CROSS_DOC_CODES.has(c));
  const vaultCtx = needsVault ? buildLintVaultContext(await loadVaultIndex(ctx), rel) : undefined;
  const gate = evaluateLintGate(proposed, gateCodes, vaultCtx);
  if (gate.ok) return null;
  return { error: "lint_gate_failed", fixes: gate.fixes, original_warnings: gate.original_warnings };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
  const resolved = resolveSection(sections, sectionIdArg, headingArg);
  if (resolved.kind === "mismatch") {
    return json({
      error: "section_id_heading_mismatch",
      section_id_resolves_to: resolved.section_id_resolves_to,
      heading_resolves_to: resolved.heading_resolves_to,
    });
  }
  let target: SectionLoc | undefined = resolved.kind === "ok" ? resolved.loc : undefined;

  if (!target) {
    if (!createIfMissing || !headingArg) {
      return json({
        error: "section_not_found",
        heading: headingArg || undefined,
        section_id: sectionIdArg || undefined,
        available: resolved.kind === "not_found" ? resolved.available : [],
        hint: headingArg
          ? "Pass create_if_missing=true to create the section at end of file."
          : "Pass a heading (not just section_id) plus create_if_missing=true to create a new section.",
      });
    }
    const sep = content.endsWith("\n") ? "" : "\n";
    const newContent = content + sep + `\n## ${headingArg}\n\n${body}\n`;
    const gateCodes = parseGateCodes(args.gate_on_warnings);
    const gateErr = await runGateOrError(ctx, rel, newContent, gateCodes);
    if (gateErr) return json(gateErr);
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
  const gateCodes = parseGateCodes(args.gate_on_warnings);
  const gateErr = await runGateOrError(ctx, rel, newContent, gateCodes);
  if (gateErr) return json(gateErr);
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
