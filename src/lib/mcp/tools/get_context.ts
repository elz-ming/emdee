// SPRINT-018 Phase 4: multi-hop context loader. Given a focal doc, walk
// the edge graph up to `hops` away and return the focal + neighbourhood
// with bodies inlined within a token budget.
//
// Why not a SQL recursive CTE: loadVaultIndex already gives us the full
// edge set in both local and cloud modes (Phase 3 wired cloud's edges
// from doc_edges). BFS in JS is mode-agnostic — no new SQL migration
// needed, and the post-Phase-3 cloud path still benefits from the
// materialized table because the index load itself is cheap.

import { loadVaultIndex } from "./vault";
import { hashBody } from "./sections";
import type { ToolContext } from "./types";
import type { DocNode } from "../../../core/indexer";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type ContextKind = "focal" | "parent" | "child" | "assoc";

interface ContextNode {
  path: string;
  title: string;
  summary: string;
  hop: number;
  kind: ContextKind;
  content?: string;
  truncated?: boolean;
}

interface ContextResult {
  focal: ContextNode;
  neighbors: ContextNode[];
  doc_content_hash: string;
  budget: { used: number; limit: number; dropped_paths: string[] };
}

const DEFAULT_HOPS = 2;
const MAX_HOPS = 3;
const DEFAULT_BUDGET = 8000;
// rough char-to-token ratio used elsewhere in the spec
const CHARS_PER_TOKEN = 4;

/**
 * BFS the edge graph from `focalPath` out to `maxHops`. For each visited
 * doc record its hop depth and the relationship kind that brought us
 * there (parent / child / assoc) — when multiple paths lead to the same
 * doc, the first arrival wins (shortest hop, and within a hop the kind
 * priority parent < child < assoc via the edge iteration order below).
 */
function buildNeighborhood(
  focalPath: string,
  edges: Array<{ from: string; to: string; kind: "hierarchy" | "assoc" }>,
  maxHops: number,
  includeAssociates: boolean,
): Map<string, { hop: number; kind: ContextKind }> {
  // For each doc, what edges leave/enter it. We pre-classify directed
  // hierarchy edges as "child" (focal points away) or "parent" (focal
  // points back), and assoc edges as undirected pair-mates.
  interface Neighbor { other: string; kind: "parent" | "child" | "assoc"; }
  const adj = new Map<string, Neighbor[]>();
  const push = (from: string, n: Neighbor) => {
    const arr = adj.get(from) ?? [];
    arr.push(n);
    adj.set(from, arr);
  };
  for (const e of edges) {
    if (e.kind === "hierarchy") {
      // from = parent, to = child.
      push(e.from, { other: e.to, kind: "child" });
      push(e.to, { other: e.from, kind: "parent" });
    } else {
      if (!includeAssociates) continue;
      // Assoc in our Edge[] (post-Phase-3 dedup) is single-row lo→hi;
      // treat as undirected.
      push(e.from, { other: e.to, kind: "assoc" });
      push(e.to, { other: e.from, kind: "assoc" });
    }
  }

  const visited = new Map<string, { hop: number; kind: ContextKind }>();
  visited.set(focalPath, { hop: 0, kind: "focal" });

  let frontier: string[] = [focalPath];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: string[] = [];
    for (const path of frontier) {
      const neighbors = adj.get(path) ?? [];
      // Stable order: parents first, then children, then assocs (mirrors
      // the spec's `(hop ASC, kind ASC, position ASC)`).
      const sorted = neighbors.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
      for (const n of sorted) {
        if (visited.has(n.other)) continue;
        visited.set(n.other, { hop, kind: n.kind });
        next.push(n.other);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return visited;
}

function kindRank(k: "parent" | "child" | "assoc"): number {
  if (k === "parent") return 0;
  if (k === "child") return 1;
  return 2;
}

export async function getContext(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const focalPath = String(args.path);
  const hops = Math.max(1, Math.min(MAX_HOPS, Number(args.hops ?? DEFAULT_HOPS)));
  const budget = Math.max(0, Number(args.budget_tokens ?? DEFAULT_BUDGET));
  const includeFull = args.include_full === undefined ? true : Boolean(args.include_full);
  const includeAssociates = args.include_associates === undefined ? true : Boolean(args.include_associates);

  const idx = await loadVaultIndex(ctx);
  const focal = idx.docs.find((d) => d.path === focalPath);
  if (!focal) throw new Error(`no such doc: ${focalPath}`);

  // SPRINT-024 Phase 1: hash-conditional short-circuit. The hash is over the
  // FOCAL doc's raw content — neighbourhood changes don't bust the cache,
  // matching `get_doc`'s scope. Callers chasing a structural change must
  // refetch unconditionally.
  const docHash = hashBody(focal.content);
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : "";
  if (expected && expected === docHash) {
    return json({ unchanged: true, path: focal.path, doc_content_hash: docHash });
  }

  const visited = buildNeighborhood(focalPath, idx.edges, hops, includeAssociates);
  const byPath = new Map<string, DocNode>(idx.docs.map((d) => [d.path, d]));

  // Order: focal, then by (hop ASC, kind ASC, path ASC) for determinism.
  const sortedEntries = [...visited.entries()]
    .filter(([p]) => byPath.has(p))
    .sort((a, b) => {
      if (a[0] === focalPath) return -1;
      if (b[0] === focalPath) return 1;
      const ha = a[1].hop;
      const hb = b[1].hop;
      if (ha !== hb) return ha - hb;
      const ka = kindRank(a[1].kind as "parent" | "child" | "assoc");
      const kb = kindRank(b[1].kind as "parent" | "child" | "assoc");
      if (ka !== kb) return ka - kb;
      return a[0].localeCompare(b[0]);
    });

  // Budget walk: focal + hop-1 docs get full body when include_full,
  // hop-2+ get summary-only. As budget exhausts, body is dropped first;
  // if even the summary-line overflows, the node is dropped entirely
  // and surfaced in dropped_paths.
  const limit = budget;
  let used = 0;
  const dropped: string[] = [];
  let focalNode: ContextNode | null = null;
  const neighbors: ContextNode[] = [];

  for (const [p, meta] of sortedEntries) {
    const doc = byPath.get(p)!;
    const wantBody = includeFull && meta.hop <= 1;
    // Always reserve cost for the summary line so dropped nodes are rare.
    const summaryCost = Math.ceil((doc.summary.length + doc.title.length + p.length) / CHARS_PER_TOKEN);
    if (used + summaryCost > limit && p !== focalPath) {
      dropped.push(p);
      continue;
    }
    const node: ContextNode = {
      path: doc.path,
      title: doc.title,
      summary: doc.summary,
      hop: meta.hop,
      kind: meta.kind,
    };
    used += summaryCost;

    if (wantBody) {
      const bodyCost = Math.ceil(doc.content.length / CHARS_PER_TOKEN);
      if (used + bodyCost <= limit) {
        node.content = doc.content;
        used += bodyCost;
      } else {
        // Out of budget for the body — flag truncation and leave the
        // summary-only entry. Focal is the one exception: we always try
        // to ship its body, truncating if necessary so the caller at
        // least sees the head of the doc.
        if (p === focalPath) {
          const remaining = Math.max(0, limit - used);
          const charBudget = remaining * CHARS_PER_TOKEN;
          if (charBudget > 0) {
            node.content = doc.content.slice(0, charBudget);
            node.truncated = true;
            used += Math.ceil(node.content.length / CHARS_PER_TOKEN);
          } else {
            node.truncated = true;
          }
        } else {
          node.truncated = true;
        }
      }
    }

    if (p === focalPath) focalNode = node;
    else neighbors.push(node);
  }

  // Edge case: the focal somehow got dropped (shouldn't happen — we
  // skip the drop branch when p === focalPath above — but be defensive).
  if (!focalNode) {
    focalNode = {
      path: focal.path,
      title: focal.title,
      summary: focal.summary,
      hop: 0,
      kind: "focal",
    };
  }

  const result: ContextResult = {
    focal: focalNode,
    neighbors,
    doc_content_hash: docHash,
    budget: { used, limit, dropped_paths: dropped },
  };
  return json(result);
}
