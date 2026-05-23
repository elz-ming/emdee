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
const H3_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+/;
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/;
const DECLARED_EDGE_HEADINGS = new Set(["child of", "parent of", "associated with"]);
const INLINE_MENTION_THRESHOLD = 3;

// Distillation thresholds. A doc with 4+ H3 sub-sections each carrying
// substantive content (~150 words = roughly one solid paragraph) is a
// candidate for split_doc — each H3 is competing to be its own atomic
// concept node. A `## Parent of` H3 subgroup with 3+ items is a
// candidate for materialize_subgroup — the user has already done the
// semantic grouping, we just need to promote it to a real intermediate
// parent doc.
const SPLIT_SUBSECTION_MIN_WORDS = 150;
const SPLIT_SUBSECTION_COUNT_THRESHOLD = 4;
const SUBGROUP_BULLET_THRESHOLD = 3;

export interface LintWarning {
  code:
    | "missing_preamble"
    | "inline_mention_without_declared_edge"
    | "multiple_child_of"
    | "asymmetric_parent_edge"
    | "asymmetric_child_edge"
    | "associate_duplicates_hierarchy"
    | "sibling_assoc_redundant"
    | "split_candidate"
    | "subgroup_materialization_candidate";
  message: string;
  suggestion: string;
  title?: string;
  count?: number;
  asymmetric_target?: string;
  /** For split_candidate / subgroup_materialization_candidate — the
   *  subsection/subgroup headings that triggered the warning. */
  candidates?: string[];
  /** 1-indexed source line where the violation lives. Null for
   *  doc-level codes (split_candidate, subgroup_materialization_candidate)
   *  that don't have a single anchoring line. */
  line: number | null;
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

export interface LintDocInfo {
  path: string;
  title: string;
  declaredParents: string[];
  declaredChildren: string[];
}

/** Minimal vault context the cross-doc rules need. */
export interface LintVaultContext {
  /** Path of the doc being linted, so cross-doc checks can locate "me" by path. */
  selfPath: string;
  /** This doc's resolved parent paths (from `## Child of`). Used by the
   *  sibling-assoc check to detect when an assoc target is actually a sibling
   *  (i.e. shares one of these parents). */
  selfDeclaredParents: string[];
  /** Resolve a wiki-link target (raw title or slug text) to a doc info entry
   *  using the locality-aware resolver. Returns null for dangling links.
   *  Cross-doc checks (asymmetric edges, sibling assoc) MUST use this
   *  rather than a title-only map so that links like `[[GBI-DAY3]]` —
   *  where the slug matches but the title is "GBI — DAY3" — resolve
   *  correctly, and so that ambiguous titles get disambiguated by the
   *  linking doc's path. */
  resolveTarget: (target: string) => LintDocInfo | null;
}

function findPreambleBlock(content: string): { body: string; h1LineIdx: number } | null {
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
  return { body, h1LineIdx: h1Idx };
}

/**
 * Collect titles referenced under each declared-edge section, with bullet
 * counts per section so we can detect `multiple_child_of` precisely. The
 * bullet count is what matters for the lint, not the number of links —
 * `* [[A]] — collaborated with [[B]]` is one declared edge to A, even
 * though two wiki-links appear.
 *
 * For each declared-edge heading we also track:
 *  - `bulletLines`: 1-indexed line numbers of every leading-wiki-link bullet,
 *    in source order, so callers (notably the `multiple_child_of` rule) can
 *    point at the offending line.
 *  - `titleLines`: first-seen 1-indexed line for each lowercase title
 *    appearing under the heading, so per-title warnings (assoc-duplicates,
 *    sibling-assoc, asymmetric edges) can anchor on the actual bullet.
 */
function collectDeclaredEdges(content: string): {
  titlesByHeading: Map<string, Set<string>>;
  bulletCountByHeading: Map<string, number>;
  bulletLinesByHeading: Map<string, number[]>;
  titleLinesByHeading: Map<string, Map<string, number>>;
  allTitles: Set<string>;
} {
  const lines = content.split("\n");
  const titlesByHeading = new Map<string, Set<string>>();
  const bulletCountByHeading = new Map<string, number>();
  const bulletLinesByHeading = new Map<string, number[]>();
  const titleLinesByHeading = new Map<string, Map<string, number>>();
  const allTitles = new Set<string>();
  let inFence = false;
  let currentHeading: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h2 = line.match(H2_RE);
    if (h2) {
      currentHeading = h2[1].trim().toLowerCase();
      if (DECLARED_EDGE_HEADINGS.has(currentHeading)) {
        if (!titlesByHeading.has(currentHeading)) titlesByHeading.set(currentHeading, new Set());
        if (!bulletCountByHeading.has(currentHeading)) bulletCountByHeading.set(currentHeading, 0);
        if (!bulletLinesByHeading.has(currentHeading)) bulletLinesByHeading.set(currentHeading, []);
        if (!titleLinesByHeading.has(currentHeading)) titleLinesByHeading.set(currentHeading, new Map());
      }
      continue;
    }
    if (!currentHeading || !DECLARED_EDGE_HEADINGS.has(currentHeading)) continue;

    let isBullet = false;
    if (BULLET_RE.test(line)) {
      // Only count bullets whose leading link is a wiki-link — defensive
      // against random "*" lines that aren't edge declarations.
      const leading = line.replace(BULLET_RE, "").match(WIKI_LINK_RE);
      if (leading) {
        bulletCountByHeading.set(currentHeading, (bulletCountByHeading.get(currentHeading) ?? 0) + 1);
        bulletLinesByHeading.get(currentHeading)!.push(i + 1);
        isBullet = true;
      }
    }

    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)) {
      const title = m[1].trim().toLowerCase();
      titlesByHeading.get(currentHeading)!.add(title);
      allTitles.add(title);
      // Track the first line we saw this title on, so warnings can anchor
      // on the original source line even if the title repeats.
      const titleLines = titleLinesByHeading.get(currentHeading)!;
      if (!titleLines.has(title) && isBullet) titleLines.set(title, i + 1);
      else if (!titleLines.has(title)) titleLines.set(title, i + 1);
    }
  }
  return { titlesByHeading, bulletCountByHeading, bulletLinesByHeading, titleLinesByHeading, allTitles };
}

function collectInlineMentions(content: string): Map<string, { count: number; firstLine: number }> {
  const lines = content.split("\n");
  const counts = new Map<string, { count: number; firstLine: number }>();
  let inFence = false;
  let currentHeading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      const prev = counts.get(title);
      if (prev) prev.count++;
      else counts.set(title, { count: 1, firstLine: i + 1 });
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

/**
 * Collect H3 sub-sections living under non-edge H2s (Notes, free-form
 * body sections), with a word count of each sub-section's body. Used by
 * the `split_candidate` rule — H3s carrying substantive content are
 * effectively atomic concepts waiting to be extracted.
 */
function collectSubstantiveSubsections(content: string): Array<{ heading: string; wordCount: number }> {
  const lines = content.split("\n");
  const out: Array<{ heading: string; wordCount: number }> = [];
  let inFence = false;
  let inEdgeSection = false;
  let currentH3: { heading: string; words: string[] } | null = null;
  const flush = () => {
    if (currentH3) {
      out.push({ heading: currentH3.heading, wordCount: currentH3.words.filter(Boolean).length });
      currentH3 = null;
    }
  };
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) {
      // Code-fenced content counts toward the word total of the open H3.
      if (currentH3) currentH3.words.push(...line.split(/\s+/));
      continue;
    }
    const h2 = line.match(H2_RE);
    if (h2) {
      flush();
      inEdgeSection = DECLARED_EDGE_HEADINGS.has(h2[1].trim().toLowerCase());
      continue;
    }
    if (inEdgeSection) continue;
    const h3 = line.match(H3_RE);
    if (h3) {
      flush();
      currentH3 = { heading: h3[1].trim(), words: [] };
      continue;
    }
    if (currentH3) currentH3.words.push(...line.split(/\s+/));
  }
  flush();
  return out;
}

/**
 * Collect H3 subgroups inside the `## Parent of` section, with the
 * bullet count per subgroup. Used by `subgroup_materialization_candidate`
 * and (eventually) the `materialize_subgroup` MCP tool.
 */
function collectParentOfSubgroups(content: string): Array<{ heading: string; bulletCount: number }> {
  const lines = content.split("\n");
  const out: Array<{ heading: string; bulletCount: number }> = [];
  let inFence = false;
  let inParentOf = false;
  let currentSubgroup: { heading: string; bulletCount: number } | null = null;
  const flush = () => {
    if (currentSubgroup) {
      out.push(currentSubgroup);
      currentSubgroup = null;
    }
  };
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h2 = line.match(H2_RE);
    if (h2) {
      flush();
      inParentOf = h2[1].trim().toLowerCase() === "parent of";
      continue;
    }
    if (!inParentOf) continue;
    const h3 = line.match(H3_RE);
    if (h3) {
      flush();
      currentSubgroup = { heading: h3[1].trim(), bulletCount: 0 };
      continue;
    }
    if (!currentSubgroup) continue;
    if (BULLET_RE.test(line)) {
      const leading = line.replace(BULLET_RE, "").match(WIKI_LINK_RE);
      if (leading) currentSubgroup.bulletCount++;
    }
  }
  flush();
  return out;
}

export function lintDocContent(content: string, ctx?: LintVaultContext): LintResult {
  const preamble = findPreambleBlock(content);
  const has_preamble = !!preamble && preamble.body.length > 0 && !/^>\s*$/m.test(preamble.body)
    ? /^>\s*\S/.test(preamble.body)
    : false;
  const preamble_word_count = preamble
    ? preamble.body.replace(/^>\s*/gm, "").trim().split(/\s+/).filter(Boolean).length
    : 0;

  const { titlesByHeading, bulletCountByHeading, bulletLinesByHeading, titleLinesByHeading } =
    collectDeclaredEdges(content);
  const declaredTitles = new Set<string>();
  for (const titles of titlesByHeading.values()) for (const t of titles) declaredTitles.add(t);

  const declared_edges_total = Array.from(bulletCountByHeading.values()).reduce((a, b) => a + b, 0);
  const child_of_count = bulletCountByHeading.get("child of") ?? 0;
  const has_child_of = child_of_count > 0;

  // Pass the original content (not noFenceContent) so reported line numbers
  // match the source. collectInlineMentions handles fences internally.
  const inlineCounts = collectInlineMentions(content);

  const warnings: LintWarning[] = [];

  if (!has_preamble && preamble !== null) {
    warnings.push({
      code: "missing_preamble",
      message:
        "No `>` blockquote summary found directly under the H1. The MCP `get_summary` tool returns empty for this doc — it'll be invisible to cheap retrieval.",
      suggestion:
        "Add a `> one-line summary` line immediately after the H1, then a blank line, then the body. Keep it to 1–3 sentences.",
      line: preamble.h1LineIdx + 1,
    });
  }

  // Hierarchy beats associate: a target that appears in `## Child of` or
  // `## Parent of` shouldn't also appear in `## Associated with` for the
  // same doc — the hierarchy edge already conveys the connection, and
  // duplicating it as an associate just clutters the graph and the
  // neighbours list. Suppressed at the edge-building layer; surfaced
  // here so the user can clean the markdown when convenient.
  const childOfTitles = titlesByHeading.get("child of") ?? new Set<string>();
  const parentOfTitles = titlesByHeading.get("parent of") ?? new Set<string>();
  const assocTitles = titlesByHeading.get("associated with") ?? new Set<string>();
  const assocTitleLines = titleLinesByHeading.get("associated with") ?? new Map<string, number>();
  for (const t of assocTitles) {
    if (childOfTitles.has(t) || parentOfTitles.has(t)) {
      warnings.push({
        code: "associate_duplicates_hierarchy",
        message: `\`[[${t}]]\` appears in both \`## Associated with\` and the hierarchy (Child of / Parent of). The hierarchy edge already covers it.`,
        suggestion: `Remove \`[[${t}]]\` from \`## Associated with\` — the parent/child relationship is the canonical link and the assoc bullet is being suppressed in the graph anyway.`,
        title: t,
        line: assocTitleLines.get(t) ?? null,
      });
    }
  }

  // Sibling assoc redundancy: when an associate target shares one of
  // this doc's parents, the two are siblings. The shared-parent edge
  // already implies the relationship — `## Associated with` is for
  // cross-tree links (e.g. project↔person), not for linking peers under
  // the same parent. Indexer suppresses these in the graph; this lint
  // surfaces them so the markdown can be cleaned.
  if (ctx && ctx.selfDeclaredParents.length > 0) {
    const selfParents = new Set(ctx.selfDeclaredParents);
    for (const t of assocTitles) {
      // Skip pairs already flagged by the hierarchy-overlap rule above.
      if (childOfTitles.has(t) || parentOfTitles.has(t)) continue;
      const target = ctx.resolveTarget(t);
      if (!target) continue;
      const sharedParent = target.declaredParents.find((p) => selfParents.has(p));
      if (sharedParent) {
        warnings.push({
          code: "sibling_assoc_redundant",
          message: `\`[[${t}]]\` is listed in \`## Associated with\` but shares the parent \`${sharedParent}\` with this doc — the two are siblings, already related through their common parent.`,
          suggestion: `Remove \`[[${t}]]\` from \`## Associated with\`. \`## Associated with\` is for cross-tree links (e.g. project↔person, sprint↔learning), not for connecting docs that share a parent.`,
          title: t,
          line: assocTitleLines.get(t) ?? null,
        });
      }
    }
  }

  if (child_of_count > 1) {
    // Anchor on the SECOND bullet — that's the violating one (the first
    // bullet is the legitimate canonical parent).
    const childOfBulletLines = bulletLinesByHeading.get("child of") ?? [];
    warnings.push({
      code: "multiple_child_of",
      message: `\`## Child of\` declares ${child_of_count} parents. The vault convention is single-parent — a doc lives under one canonical parent and uses \`## Associated with\` for cross-cutting connections.`,
      suggestion:
        "Keep one parent in `## Child of` (the canonical hierarchy placement) and move the others to `## Associated with` with a short prose note explaining the connection.",
      count: child_of_count,
      line: childOfBulletLines[1] ?? null,
    });
  }

  // Distillation candidates. Detection-only — execution lives in the
  // split_doc and materialize_subgroup MCP tools, run by a human.
  const substantiveSubsections = collectSubstantiveSubsections(content)
    .filter((s) => s.wordCount >= SPLIT_SUBSECTION_MIN_WORDS);
  if (substantiveSubsections.length >= SPLIT_SUBSECTION_COUNT_THRESHOLD) {
    warnings.push({
      code: "split_candidate",
      message: `This doc has ${substantiveSubsections.length} H3 sub-sections with substantive content (≥${SPLIT_SUBSECTION_MIN_WORDS} words each). Each one is large enough to live as its own atomic concept node.`,
      suggestion: `Plan an extraction with the \`distill_doc\` MCP, then execute with \`split_doc\`. Each H3 → its own doc, with the source rewritten as a thin index of wiki-links.`,
      count: substantiveSubsections.length,
      candidates: substantiveSubsections.map((s) => s.heading),
      line: null,
    });
  }

  const subgroups = collectParentOfSubgroups(content);
  const materializable = subgroups.filter((g) => g.bulletCount >= SUBGROUP_BULLET_THRESHOLD);
  if (materializable.length > 0) {
    warnings.push({
      code: "subgroup_materialization_candidate",
      message: `\`## Parent of\` contains ${materializable.length} H3 subgroup(s) with ≥${SUBGROUP_BULLET_THRESHOLD} items: ${materializable.map((g) => `"${g.heading}" (${g.bulletCount})`).join(", ")}. Each is large enough to become its own intermediate parent doc.`,
      suggestion: `Run \`materialize_subgroup\` per subgroup. Each promoted H3 becomes a real intermediate node; its bullets move under it and their \`## Child of\` rewires from this doc to the new intermediate.`,
      count: materializable.length,
      candidates: materializable.map((g) => g.heading),
      line: null,
    });
  }

  // Cross-doc rules — only run when caller provided vault context.
  if (ctx) {
    const parentOfTitleLines = titleLinesByHeading.get("parent of") ?? new Map<string, number>();
    const childOfTitleLines = titleLinesByHeading.get("child of") ?? new Map<string, number>();

    const declaredChildrenTitles = titlesByHeading.get("parent of") ?? new Set<string>();
    for (const childTitle of declaredChildrenTitles) {
      const child = ctx.resolveTarget(childTitle);
      if (!child) continue; // dangling link — separate concern, not asymmetric
      const childDeclaresMe = child.declaredParents.some((p) => p === ctx.selfPath);
      if (!childDeclaresMe) {
        warnings.push({
          code: "asymmetric_parent_edge",
          message: `This doc lists \`[[${childTitle}]]\` in Parent of, but [[${child.title}]] doesn't declare this doc back in its Child of. The edge is one-sided.`,
          suggestion: `Either remove \`[[${childTitle}]]\` from this doc's Parent of, or add this doc to ${child.title}'s Child of so the edge is reciprocal.`,
          asymmetric_target: child.title,
          line: parentOfTitleLines.get(childTitle) ?? null,
        });
      }
    }

    const declaredParentTitles = titlesByHeading.get("child of") ?? new Set<string>();
    for (const parentTitle of declaredParentTitles) {
      const parent = ctx.resolveTarget(parentTitle);
      if (!parent) continue;
      const parentDeclaresMe = parent.declaredChildren.some((c) => c === ctx.selfPath);
      if (!parentDeclaresMe) {
        warnings.push({
          code: "asymmetric_child_edge",
          message: `This doc lists \`[[${parentTitle}]]\` in Child of, but [[${parent.title}]] doesn't list this doc back in its Parent of. The edge is one-sided.`,
          suggestion: `Either remove \`[[${parentTitle}]]\` from this doc's Child of, or add this doc to ${parent.title}'s Parent of so the edge is reciprocal.`,
          asymmetric_target: parent.title,
          line: childOfTitleLines.get(parentTitle) ?? null,
        });
      }
    }
  }

  const inline_mentions: Array<{ title: string; count: number }> = [];
  for (const [title, { count, firstLine }] of inlineCounts) {
    inline_mentions.push({ title, count });
    if (count >= INLINE_MENTION_THRESHOLD && !declaredTitles.has(title)) {
      warnings.push({
        code: "inline_mention_without_declared_edge",
        message: `\`[[${title}]]\` is mentioned ${count} times inline but is not declared in Child of / Parent of / Associated with.`,
        suggestion: `Consider adding \`* [[${title}]]\` to the Associated with section if this is a real cross-cutting connection.`,
        title,
        count,
        line: firstLine,
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
