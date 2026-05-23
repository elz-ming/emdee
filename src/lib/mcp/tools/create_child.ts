import path from "node:path";
import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent } from "./lint";
import { buildLintVaultContext } from "./lint_doc";
import { evaluateLintGate, type LintFix } from "./lint_gate";
import type { LintWarning } from "./lint";
import type { ToolContext } from "./types";

const H1_RE = /^#\s+(.+?)\s*$/m;
const H2_RE = /^##\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const SLUG_SAFE = /^[\p{L}\p{N}\s\-_.]+$/u;

function deriveTitle(content: string, fallbackPath: string): string {
  const m = content.match(H1_RE);
  if (m) return m[1].trim();
  return path.basename(fallbackPath, ".md");
}

function sanitizeFilename(title: string): string {
  // Mirror materialize_subgroup: hyphen for em-dash (Supabase Storage key
  // restriction), strip slashes/backslashes to keep the filename within
  // a single directory.
  return title.replace(/\s*—\s*/g, "-").replace(/[/\\]/g, "_");
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
 * Insert `* [[<childTitle>]]` into the parent's `## Parent of` section.
 * If the section is missing, append it at end-of-file. If the bullet is
 * already present (idempotent retry path), return the unchanged content
 * with a flag.
 */
function patchParentParentOf(parentContent: string, childTitle: string): {
  newContent: string;
  alreadyPresent: boolean;
  parentOfBody: string;
} {
  const lines = parentContent.split("\n");
  const sections = parseSections(parentContent);
  const parentOf = findSection(sections, "Parent of");
  const bullet = `* [[${childTitle}]]`;

  if (!parentOf) {
    // No Parent of section — append at end of file.
    const sep = parentContent.endsWith("\n") ? "" : "\n";
    const newContent = parentContent + sep + `\n## Parent of\n\n${bullet}\n`;
    return { newContent, alreadyPresent: false, parentOfBody: bullet };
  }

  // Check existing bullets for an idempotent retry.
  const sectionLines = lines.slice(parentOf.headingLineIdx, parentOf.bodyEndLineIdx);
  const escaped = childTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existsRe = new RegExp(`^\\s*[-*]\\s+\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, "i");
  if (sectionLines.some((l) => existsRe.test(l))) {
    return {
      newContent: parentContent,
      alreadyPresent: true,
      parentOfBody: extractBody(parentContent, parentOf),
    };
  }

  // Insert the bullet after existing content, trimming trailing blanks.
  const newSectionLines = [...sectionLines];
  while (newSectionLines.length > 1 && newSectionLines[newSectionLines.length - 1].trim() === "") newSectionLines.pop();
  newSectionLines.push("", bullet, "");
  const newContent = [
    ...lines.slice(0, parentOf.headingLineIdx),
    ...newSectionLines,
    ...lines.slice(parentOf.bodyEndLineIdx),
  ].join("\n");
  const newSections = parseSections(newContent);
  const newParentOf = findSection(newSections, "Parent of");
  return {
    newContent,
    alreadyPresent: false,
    parentOfBody: newParentOf ? extractBody(newContent, newParentOf) : "",
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
 * Atomic create-and-link: writes a new child doc with the canonical
 * scaffold (H1 + summary placeholder + Child of / Parent of / Associated
 * with / Notes), and patches the parent's `## Parent of` to include the
 * new child bullet. Collapses the typical 5-round-trip add-child flow.
 *
 * Pre-flight refuses if the parent doc is missing, the child path is
 * occupied, or the title collides with another doc / contains
 * non-slug-safe characters.
 *
 * Hard-gates internally on `multiple_child_of` (defensive — the scaffold
 * itself can't trigger it). Caller-supplied `gate_on_warnings` applies
 * to both the proposed child content and the proposed parent content.
 *
 * Failure mid-flight returns `{ error: "partial_write", child_written,
 * parent_written, retry_hint }`. The retry path is idempotent: re-running
 * with the same args detects an existing-and-byte-equal child + an
 * already-present parent bullet and converges to the same state.
 */
export async function createChild(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const parentPath = String(args.parent_path ?? "");
  const titleRaw = String(args.title ?? "").trim();
  const body = args.body !== undefined ? String(args.body) : "";
  const summary = args.summary !== undefined ? String(args.summary).trim() : "";
  const gateCodes = Array.isArray(args.gate_on_warnings)
    ? (args.gate_on_warnings as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  if (!parentPath) return json({ error: "parent_path required" });
  if (!titleRaw) return json({ error: "title required" });
  validatePath(parentPath);

  // Title must be non-empty after sanitization and not contain control chars.
  if (!SLUG_SAFE.test(titleRaw)) return json({ error: "title_not_slug_safe", title: titleRaw, hint: "Use letters, numbers, spaces, hyphens, underscores, periods, or em-dash (—)." });

  const childPath = args.child_path
    ? String(args.child_path)
    : (() => {
        const dir = path.dirname(parentPath);
        const fname = `${sanitizeFilename(titleRaw)}.md`;
        return dir === "." ? fname : `${dir}/${fname}`;
      })();
  validatePath(childPath);

  const parentContent = await readVaultFile(ctx, parentPath);
  if (parentContent === null) return json({ error: "parent_not_found", path: parentPath });
  const parentTitle = deriveTitle(parentContent, parentPath);

  const index = await loadVaultIndex(ctx);

  // Pre-flight: title collision (excluding any pre-existing version of
  // this exact child path, which is the idempotent-retry case).
  const titleConflict = index.docs.find(
    (d) => d.path !== childPath && d.title.toLowerCase() === titleRaw.toLowerCase()
  );
  if (titleConflict) {
    return json({ error: "title_collision", path: titleConflict.path, title: titleConflict.title });
  }

  // Path-collision check — but allow idempotent retry against a
  // byte-equal existing child. Builds the scaffold first, then compares.
  const scaffold = [
    `# ${titleRaw}`,
    "",
    `> ${summary || "_summary pending_"}`,
    "",
    "## Child of",
    "",
    `* [[${parentTitle}]]`,
    "",
    "## Parent of",
    "",
    "## Associated with",
    "",
    "## Notes",
    "",
    body.length > 0 ? body : "",
  ].join("\n").replace(/\n+$/, "\n");

  const existingChild = await readVaultFile(ctx, childPath);
  if (existingChild !== null && existingChild !== scaffold) {
    return json({ error: "child_path_exists", path: childPath });
  }
  const isRetry = existingChild === scaffold;

  // Gate the proposed child + proposed parent content.
  // Hard-gate child on multiple_child_of (impossible by construction, defensive).
  const childWarnings = lintDocContent(scaffold).warnings;
  const hardFailChild = childWarnings.filter((w) => w.code === "multiple_child_of");
  if (hardFailChild.length > 0) {
    return json({ error: "child_scaffold_invalid", fixes: fixesFromWarnings(childWarnings, ["multiple_child_of"]) });
  }

  const { newContent: newParentContent, alreadyPresent, parentOfBody } = patchParentParentOf(parentContent, titleRaw);

  // Soft gate: child content first, then parent content, both against caller codes.
  if (gateCodes.length > 0) {
    const needsVault = gateCodes.some((c) => c === "asymmetric_parent_edge" || c === "asymmetric_child_edge" || c === "sibling_assoc_redundant");
    const childVaultCtx = needsVault ? buildLintVaultContext(index, childPath) : undefined;
    const childGate = evaluateLintGate(scaffold, gateCodes, childVaultCtx);
    if (!childGate.ok) {
      return json({ error: "lint_gate_failed", side: "child", fixes: childGate.fixes, original_warnings: childGate.original_warnings });
    }
    const parentVaultCtx = needsVault ? buildLintVaultContext(index, parentPath) : undefined;
    const parentGate = evaluateLintGate(newParentContent, gateCodes, parentVaultCtx);
    if (!parentGate.ok) {
      return json({ error: "lint_gate_failed", side: "parent", fixes: parentGate.fixes, original_warnings: parentGate.original_warnings });
    }
  }

  // Write child first (so a partial failure leaves a discoverable orphan
  // rather than a dangling parent bullet). On retry against an
  // already-present-and-byte-equal child, skip the write.
  let childWritten = isRetry;
  if (!isRetry) {
    try {
      await writeVaultFile(ctx, childPath, scaffold);
      childWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        child_written: false,
        parent_written: false,
        message: (err as Error).message,
      });
    }
  }

  let parentWritten = alreadyPresent;
  if (!alreadyPresent) {
    try {
      await writeVaultFile(ctx, parentPath, newParentContent);
      parentWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        child_written: childWritten,
        parent_written: false,
        message: (err as Error).message,
        retry_hint: "Re-run create_child with the same args; the child write is detected as byte-equal and the parent patch is idempotent (already-present bullet is skipped).",
      });
    }
  }

  return json({
    ok: true,
    child_path: childPath,
    child_title: titleRaw,
    parent_path: parentPath,
    parent_updated: !alreadyPresent,
    parent_of_content_hash: hashBody(parentOfBody),
    idempotent_retry: isRetry,
  });
}
