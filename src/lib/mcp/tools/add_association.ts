import path from "node:path";
import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent } from "./lint";
import { buildLintVaultContext } from "./lint_doc";
import { evaluateLintGate, type LintFix } from "./lint_gate";
import type { LintWarning, LintVaultContext } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";

const H1_RE = /^#\s+(.+?)\s*$/m;
const H2_RE = /^##\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;

function deriveTitle(content: string, fallbackPath: string): string {
  const m = content.match(H1_RE);
  if (m) return m[1].trim();
  return path.basename(fallbackPath, ".md");
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number;
}

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
  const target = heading.trim().toLowerCase();
  return sections.find((s) => s.heading.toLowerCase() === target);
}

function extractBody(content: string, loc: SectionLoc): string {
  return content.split("\n")
    .slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
}

/**
 * Insert `* [[<otherTitle>]] — <label>` into the doc's `## Associated
 * with` section. Creates the section if missing. Returns { newContent,
 * alreadyPresent } so the caller can short-circuit on idempotent retry.
 */
function patchAssociatedWith(content: string, otherTitle: string, label?: string): {
  newContent: string;
  alreadyPresent: boolean;
  assocBody: string;
} {
  const lines = content.split("\n");
  const sections = parseSections(content);
  const assoc = findSection(sections, "Associated with");
  const bullet = label ? `* [[${otherTitle}]] — ${label}` : `* [[${otherTitle}]]`;

  if (!assoc) {
    const sep = content.endsWith("\n") ? "" : "\n";
    const newContent = content + sep + `\n## Associated with\n\n${bullet}\n`;
    return { newContent, alreadyPresent: false, assocBody: bullet };
  }

  // Idempotency: existing bullet with this target (alias-tolerant).
  const sectionLines = lines.slice(assoc.headingLineIdx, assoc.bodyEndLineIdx);
  const escaped = otherTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existsRe = new RegExp(`^\\s*[-*]\\s+\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, "i");
  if (sectionLines.some((l) => existsRe.test(l))) {
    return {
      newContent: content,
      alreadyPresent: true,
      assocBody: extractBody(content, assoc),
    };
  }

  const newSectionLines = [...sectionLines];
  while (newSectionLines.length > 1 && newSectionLines[newSectionLines.length - 1].trim() === "") newSectionLines.pop();
  newSectionLines.push("", bullet, "");
  const newContent = [
    ...lines.slice(0, assoc.headingLineIdx),
    ...newSectionLines,
    ...lines.slice(assoc.bodyEndLineIdx),
  ].join("\n");
  const newSections = parseSections(newContent);
  const newAssoc = findSection(newSections, "Associated with");
  return {
    newContent,
    alreadyPresent: false,
    assocBody: newAssoc ? extractBody(newContent, newAssoc) : "",
  };
}

function fixesFromWarnings(warnings: LintWarning[], codes: string[]): LintFix[] {
  const codeSet = new Set(codes);
  return warnings.filter((w) => codeSet.has(w.code)).map((w) => ({
    code: w.code,
    line: w.line ?? null,
    fix_suggestion: w.suggestion,
    original_message: w.message,
  }));
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Atomic two-sided assoc. Patches both docs' `## Associated with` to
 * mention the other (with optional shared label, same on both bullets).
 *
 * Hard-gates internally on `associate_duplicates_hierarchy` and
 * `sibling_assoc_redundant` for both sides — these are the exact codes
 * this tool exists to prevent. A pair already linked via Child of /
 * Parent of, or sharing a parent (i.e. siblings), gets refused with a
 * structured `would_duplicate_hierarchy` error.
 *
 * Idempotent: if both docs already declare the other in `## Associated
 * with`, returns ok with `a_updated: false, b_updated: false` and
 * doesn't touch either file.
 *
 * Label drift caveat: if the first call passes label X and the second
 * passes label Y, the second is a no-op (idempotency check fires on
 * presence-of-bullet alone). Use a future `update_association_label` for
 * label edits.
 */
export async function addAssociation(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const aPath = String(args.a_path ?? "");
  const bPath = String(args.b_path ?? "");
  const label = args.label !== undefined ? String(args.label).trim() : "";
  const gateCodes = Array.isArray(args.gate_on_warnings)
    ? (args.gate_on_warnings as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  if (!aPath) return json({ error: "a_path required" });
  if (!bPath) return json({ error: "b_path required" });
  if (aPath === bPath) return json({ error: "self_association", path: aPath });
  validatePath(aPath);
  validatePath(bPath);

  const aContent = await readVaultFile(ctx, aPath);
  if (aContent === null) return json({ error: "a_not_found", path: aPath });
  const bContent = await readVaultFile(ctx, bPath);
  if (bContent === null) return json({ error: "b_not_found", path: bPath });

  const aTitle = deriveTitle(aContent, aPath);
  const bTitle = deriveTitle(bContent, bPath);

  const index = await loadVaultIndex(ctx);
  const aCtx: LintVaultContext = buildLintVaultContext(index, aPath);
  const bCtx: LintVaultContext = buildLintVaultContext(index, bPath);

  // Build proposed contents (insert bullet on each side).
  const aPatch = patchAssociatedWith(aContent, bTitle, label || undefined);
  const bPatch = patchAssociatedWith(bContent, aTitle, label || undefined);

  // Idempotent short-circuit: if both already present, nothing to do.
  if (aPatch.alreadyPresent && bPatch.alreadyPresent) {
    return json({
      ok: true,
      a_path: aPath,
      b_path: bPath,
      label: label || undefined,
      a_updated: false,
      b_updated: false,
      a_associated_with_hash: hashBody(aPatch.assocBody),
      b_associated_with_hash: hashBody(bPatch.assocBody),
    });
  }

  // Hard-gate: lint each proposed side. If associate_duplicates_hierarchy
  // or sibling_assoc_redundant fires for the assoc target we just added,
  // refuse with a structured error.
  const HARD_CODES = ["associate_duplicates_hierarchy", "sibling_assoc_redundant"] as const;
  const checkSide = (
    side: "a" | "b",
    proposed: string,
    selfCtx: LintVaultContext,
    targetTitle: string,
    targetPath: string,
  ): { error: "would_duplicate_hierarchy"; side: "a" | "b"; reason: string; existing_edge: { from: string; to: string; kind: string; shared_parent_path?: string }; fix_suggestion: string } | null => {
    const { warnings } = lintDocContent(proposed, selfCtx);
    const hit = warnings.find((w) =>
      HARD_CODES.includes(w.code as typeof HARD_CODES[number]) &&
      w.title && w.title.toLowerCase() === targetTitle.toLowerCase()
    );
    if (!hit) return null;
    if (hit.code === "associate_duplicates_hierarchy") {
      // Determine which direction (parent_of / child_of) from the linking doc's perspective.
      const selfDoc = index.docs.find((d) => d.path === selfCtx.selfPath);
      const isParent = selfDoc?.children.some((l) => resolveWikiLink(index, l.title, selfCtx.selfPath)?.path === targetPath);
      const isChild = selfDoc?.parents.some((l) => resolveWikiLink(index, l.title, selfCtx.selfPath)?.path === targetPath);
      return {
        error: "would_duplicate_hierarchy",
        side,
        reason: "associate_duplicates_hierarchy",
        existing_edge: {
          from: selfCtx.selfPath,
          to: targetPath,
          kind: isParent ? "parent_of" : isChild ? "child_of" : "hierarchy",
        },
        fix_suggestion: hit.suggestion,
      };
    }
    // sibling_assoc_redundant: pull the shared parent from the warning message format.
    const targetInfo = selfCtx.resolveTarget(targetTitle);
    const sharedParent = targetInfo?.declaredParents.find((p) => selfCtx.selfDeclaredParents.includes(p));
    return {
      error: "would_duplicate_hierarchy",
      side,
      reason: "sibling_assoc_redundant",
      existing_edge: {
        from: selfCtx.selfPath,
        to: targetPath,
        kind: "shared_parent",
        ...(sharedParent ? { shared_parent_path: sharedParent } : {}),
      },
      fix_suggestion: hit.suggestion,
    };
  };

  if (!aPatch.alreadyPresent) {
    const aHardFail = checkSide("a", aPatch.newContent, aCtx, bTitle, bPath);
    if (aHardFail) return json(aHardFail);
  }
  if (!bPatch.alreadyPresent) {
    const bHardFail = checkSide("b", bPatch.newContent, bCtx, aTitle, aPath);
    if (bHardFail) return json(bHardFail);
  }

  // Soft gate: caller-provided codes.
  if (gateCodes.length > 0) {
    if (!aPatch.alreadyPresent) {
      const aGate = evaluateLintGate(aPatch.newContent, gateCodes, aCtx);
      if (!aGate.ok) return json({ error: "lint_gate_failed", side: "a", fixes: aGate.fixes, original_warnings: aGate.original_warnings });
    }
    if (!bPatch.alreadyPresent) {
      const bGate = evaluateLintGate(bPatch.newContent, gateCodes, bCtx);
      if (!bGate.ok) return json({ error: "lint_gate_failed", side: "b", fixes: bGate.fixes, original_warnings: bGate.original_warnings });
    }
  }

  // Write A then B. Partial failure path documents the asymmetry; retry
  // is idempotent because each side's existing-bullet check fires on the
  // re-run.
  let aWritten = aPatch.alreadyPresent;
  if (!aPatch.alreadyPresent) {
    try {
      await writeVaultFile(ctx, aPath, aPatch.newContent);
      aWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        a_written: false,
        b_written: false,
        message: (err as Error).message,
      });
    }
  }

  let bWritten = bPatch.alreadyPresent;
  if (!bPatch.alreadyPresent) {
    try {
      await writeVaultFile(ctx, bPath, bPatch.newContent);
      bWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        a_written: aWritten,
        b_written: false,
        message: (err as Error).message,
        retry_hint: "Re-run add_association with the same args; the A-side write is idempotent (already-declared bullets are detected and skipped).",
      });
    }
  }

  return json({
    ok: true,
    a_path: aPath,
    b_path: bPath,
    label: label || undefined,
    a_updated: !aPatch.alreadyPresent,
    b_updated: !bPatch.alreadyPresent,
    a_associated_with_hash: hashBody(aPatch.assocBody),
    b_associated_with_hash: hashBody(bPatch.assocBody),
  });
}
