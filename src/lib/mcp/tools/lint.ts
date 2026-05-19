// Shared lint engine — one implementation, three callsites: the standalone
// lint_doc MCP tool, and the post-write response paths of write_doc and
// patch_section. Returns warnings + structural info; never throws on a
// "bad" doc. Lint is signal, not gate.
//
// Single-doc rules (always run): missing_preamble,
// inline_mention_without_declared_edge, multiple_child_of.
// Cross-doc rules (run only when a vault context is passed):
// asymmetric_parent_edge, asymmetric_child_edge. These need the vault's
// title→doc map to check that every declared edge has a reciprocal
// declaration in the target doc.

const FENCE_RE = /^\s*(?:```|~~~)/;
const H1_RE = /^#\s+(.+?)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+/;
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/;
const DECLARED_EDGE_HEADINGS = new Set(["child of", "parent of", "associated with"]);
const INLINE_MENTION_THRESHOLD = 3;

export interface LintWarning {
  code:
    | "missing_preamble"
    | "inline_mention_without_declared_edge"
    | "multiple_child_of"
    | "asymmetric_parent_edge"
    | "asymmetric_child_edge";
  message: string;
  suggestion: string;
  title?: string;
  count?: number;
  asymmetric_target?: string;
}

export interface LintInfo {
  has_preamble: boolean;
  preamble_word_count: number;
  has_child_of: boolean;
  child_of_count: number;
  declared_edges_total: number;
  inline_mentions: Array<{ title: string; count: number }>;
  section_count: number;
}

export interface LintResult {
  warnings: LintWarning[];
  info: LintInfo;
}

/** Minimal vault context the cross-doc rules need. */
export interface LintVaultContext {
  /** Path of the doc being linted, so cross-doc checks can locate "me" by path. */
  selfPath: string;
  /** Every doc in the vault, by title-lowercased — used to resolve wiki-link targets. */
  docsByTitle: Map<string, { path: string; title: string; declaredParents: string[]; declaredChildren: string[] }>;
}

function stripFences(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    out.push(line);
  }
  return out.join("\n");
}

function findPreambleBlock(content: string): { body: string } | null {
  const lines = content.split("\n");
  let inFence = false;
  let h1Idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (H1_RE.test(lines[i])) { h1Idx = i; break; }
  }
  if (h1Idx === -1) return null;

  let firstH2Idx = lines.length;
  inFence = false;
  for (let i = h1Idx + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (H2_RE.test(lines[i])) { firstH2Idx = i; break; }
  }
  const body = lines.slice(h1Idx + 1, firstH2Idx).join("\n").trim();
  return { body };
}

/**
 * Collect titles referenced under each declared-edge section, with bullet
 * counts per section so we can detect `multiple_child_of` precisely. The
 * bullet count is what matters for the lint, not the number of links —
 * `* [[A]] — collaborated with [[B]]` is one declared edge to A, even
 * though two wiki-links appear.
 */
function collectDeclaredEdges(content: string): {
  titlesByHeading: Map<string, Set<string>>;
  bulletCountByHeading: Map<string, number>;
  allTitles: Set<string>;
} {
  const lines = content.split("\n");
  const titlesByHeading = new Map<string, Set<string>>();
  const bulletCountByHeading = new Map<string, number>();
  const allTitles = new Set<string>();
  let inFence = false;
  let currentHeading: string | null = null;

  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h2 = line.match(H2_RE);
    if (h2) {
      currentHeading = h2[1].trim().toLowerCase();
      if (DECLARED_EDGE_HEADINGS.has(currentHeading)) {
        if (!titlesByHeading.has(currentHeading)) titlesByHeading.set(currentHeading, new Set());
        if (!bulletCountByHeading.has(currentHeading)) bulletCountByHeading.set(currentHeading, 0);
      }
      continue;
    }
    if (!currentHeading || !DECLARED_EDGE_HEADINGS.has(currentHeading)) continue;

    if (BULLET_RE.test(line)) {
      // Only count bullets whose leading link is a wiki-link — defensive
      // against random "*" lines that aren't edge declarations.
      const leading = line.replace(BULLET_RE, "").match(WIKI_LINK_RE);
      if (leading) {
        bulletCountByHeading.set(currentHeading, (bulletCountByHeading.get(currentHeading) ?? 0) + 1);
      }
    }

    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)) {
      const title = m[1].trim().toLowerCase();
      titlesByHeading.get(currentHeading)!.add(title);
      allTitles.add(title);
    }
  }
  return { titlesByHeading, bulletCountByHeading, allTitles };
}

function collectInlineMentions(content: string): Map<string, number> {
  const lines = content.split("\n");
  const counts = new Map<string, number>();
  let inFence = false;
  let currentHeading: string | null = null;
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h2 = line.match(H2_RE);
    if (h2) {
      currentHeading = h2[1].trim().toLowerCase();
      continue;
    }
    if (currentHeading && DECLARED_EDGE_HEADINGS.has(currentHeading)) continue;

    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)) {
      const title = m[1].trim().toLowerCase();
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  return counts;
}

function countSections(content: string): number {
  const lines = content.split("\n");
  let count = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (H2_RE.test(line)) count++;
  }
  return count;
}

export function lintDocContent(content: string, ctx?: LintVaultContext): LintResult {
  const noFenceContent = stripFences(content);

  const preamble = findPreambleBlock(content);
  const has_preamble = !!preamble && preamble.body.length > 0 && !/^>\s*$/m.test(preamble.body)
    ? /^>\s*\S/.test(preamble.body)
    : false;
  const preamble_word_count = preamble
    ? preamble.body.replace(/^>\s*/gm, "").trim().split(/\s+/).filter(Boolean).length
    : 0;

  const { titlesByHeading, bulletCountByHeading } = collectDeclaredEdges(content);
  const declaredTitles = new Set<string>();
  for (const titles of titlesByHeading.values()) for (const t of titles) declaredTitles.add(t);

  const declared_edges_total = Array.from(bulletCountByHeading.values()).reduce((a, b) => a + b, 0);
  const child_of_count = bulletCountByHeading.get("child of") ?? 0;
  const has_child_of = child_of_count > 0;

  const inlineCounts = collectInlineMentions(noFenceContent);

  const warnings: LintWarning[] = [];

  if (!has_preamble && preamble !== null) {
    warnings.push({
      code: "missing_preamble",
      message:
        "No `>` blockquote summary found directly under the H1. The MCP `get_summary` tool returns empty for this doc — it'll be invisible to cheap retrieval.",
      suggestion:
        "Add a `> one-line summary` line immediately after the H1, then a blank line, then the body. Keep it to 1–3 sentences.",
    });
  }

  if (child_of_count > 1) {
    warnings.push({
      code: "multiple_child_of",
      message: `\`## Child of\` declares ${child_of_count} parents. The vault convention is single-parent — a doc lives under one canonical parent and uses \`## Associated with\` for cross-cutting connections.`,
      suggestion:
        "Keep one parent in `## Child of` (the canonical hierarchy placement) and move the others to `## Associated with` with a short prose note explaining the connection.",
      count: child_of_count,
    });
  }

  // Cross-doc rules — only run when caller provided vault context.
  if (ctx) {
    const declaredChildrenTitles = titlesByHeading.get("parent of") ?? new Set<string>();
    for (const childTitle of declaredChildrenTitles) {
      const child = ctx.docsByTitle.get(childTitle);
      if (!child) continue; // dangling link — separate concern, not asymmetric
      const childDeclaresMe = child.declaredParents.some((p) => p === ctx.selfPath);
      if (!childDeclaresMe) {
        warnings.push({
          code: "asymmetric_parent_edge",
          message: `This doc lists \`[[${childTitle}]]\` in Parent of, but [[${child.title}]] doesn't declare this doc back in its Child of. The edge is one-sided.`,
          suggestion: `Either remove \`[[${childTitle}]]\` from this doc's Parent of, or add this doc to ${child.title}'s Child of so the edge is reciprocal.`,
          asymmetric_target: child.title,
        });
      }
    }

    const declaredParentTitles = titlesByHeading.get("child of") ?? new Set<string>();
    for (const parentTitle of declaredParentTitles) {
      const parent = ctx.docsByTitle.get(parentTitle);
      if (!parent) continue;
      const parentDeclaresMe = parent.declaredChildren.some((c) => c === ctx.selfPath);
      if (!parentDeclaresMe) {
        warnings.push({
          code: "asymmetric_child_edge",
          message: `This doc lists \`[[${parentTitle}]]\` in Child of, but [[${parent.title}]] doesn't list this doc back in its Parent of. The edge is one-sided.`,
          suggestion: `Either remove \`[[${parentTitle}]]\` from this doc's Child of, or add this doc to ${parent.title}'s Parent of so the edge is reciprocal.`,
          asymmetric_target: parent.title,
        });
      }
    }
  }

  const inline_mentions: Array<{ title: string; count: number }> = [];
  for (const [title, count] of inlineCounts) {
    inline_mentions.push({ title, count });
    if (count >= INLINE_MENTION_THRESHOLD && !declaredTitles.has(title)) {
      warnings.push({
        code: "inline_mention_without_declared_edge",
        message: `\`[[${title}]]\` is mentioned ${count} times inline but is not declared in Child of / Parent of / Associated with.`,
        suggestion: `Consider adding \`* [[${title}]]\` to the Associated with section if this is a real cross-cutting connection.`,
        title,
        count,
      });
    }
  }
  inline_mentions.sort((a, b) => b.count - a.count);

  return {
    warnings,
    info: {
      has_preamble,
      preamble_word_count,
      has_child_of,
      child_of_count,
      declared_edges_total,
      inline_mentions,
      section_count: countSections(content),
    },
  };
}
