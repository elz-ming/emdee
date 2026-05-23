// SPRINT-018 Phase 2: incremental doc_edges sync triggered by the
// storage write hook. Given the new content of one doc, compute the
// desired set of edge rows that touch this doc (outgoing AND inbound,
// since editing a child's `## Child of` can flip a hierarchy edge that
// lives as a row on the parent) and diff against what's currently in
// the table — minimum-churn DELETE/UPSERT.
//
// Suppression mirrors src/core/indexer.ts: hierarchy first; then assocs
// drop pairs that are already linked hierarchically or share a parent
// (siblings). Resolution mirrors src/core/resolveLink.ts → pickByLocality.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseEdges } from "./parseEdges";
import { pickByLocality, filenameSlug } from "./resolveLink";

interface EdgeRow {
  namespace: string;
  from_path: string;
  to_path: string;
  kind: "hierarchy" | "assoc";
  label: string | null;
  position: number;
}

interface DocMeta {
  path: string;
  title: string;
  content: string;
}

function deriveTitle(rel: string, content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const last = rel.split("/").pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

/**
 * Build a title-or-slug resolver across the namespace. Same precedence
 * order as buildIndexFromContents: H1 title first, filename slug as
 * fallback; ambiguous matches broken by pickByLocality(fromPath).
 */
function makeResolver(docs: DocMeta[]) {
  const titleMap = new Map<string, string[]>();
  const slugMap = new Map<string, string[]>();
  for (const d of docs) {
    const tKey = d.title.toLowerCase();
    const sKey = filenameSlug(d.path).toLowerCase();
    const tArr = titleMap.get(tKey) ?? [];
    tArr.push(d.path);
    titleMap.set(tKey, tArr);
    const sArr = slugMap.get(sKey) ?? [];
    sArr.push(d.path);
    slugMap.set(sKey, sArr);
  }
  return (target: string, fromPath: string): string | undefined => {
    const lower = target.toLowerCase();
    const titles = titleMap.get(lower);
    if (titles && titles.length > 0) {
      return titles.length === 1 ? titles[0] : pickByLocality(titles.map((path) => ({ path })), fromPath).path;
    }
    const slugs = slugMap.get(lower);
    if (slugs && slugs.length > 0) {
      return slugs.length === 1 ? slugs[0] : pickByLocality(slugs.map((path) => ({ path })), fromPath).path;
    }
    return undefined;
  };
}

interface DesiredEdges {
  /** Hierarchy rows keyed by `from::to`. */
  hierMap: Map<string, EdgeRow>;
  /** Assoc rows keyed by `from::to` (already expanded to two rows per pair). */
  assocMap: Map<string, EdgeRow>;
}

/**
 * Recompute every hierarchy + assoc row in the namespace whose `from_path`
 * OR `to_path` equals `affectedPath`. This is the set of rows that could
 * have changed as a result of editing `affectedPath`. Returns rows the
 * caller will diff against the current DB state.
 *
 * Edges originating from other docs (e.g. another doc's `## Parent of`
 * still mentioning this doc) need to be evaluated against this doc's new
 * title in case it changed — that's why we re-derive all edges touching
 * affectedPath, not just edges declared in its own bullets.
 */
function computeDesired(
  namespace: string,
  docs: DocMeta[],
  affectedPath: string,
): DesiredEdges {
  const resolve = makeResolver(docs);
  const hierMap = new Map<string, EdgeRow>();

  // Pass 1a: parent_of bullets across all docs (authoritative for position).
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "parent_of") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      hierMap.set(`${d.path}::${target}`, {
        namespace,
        from_path: d.path,
        to_path: target,
        kind: "hierarchy",
        label: b.label,
        position: pos++,
      });
    }
  }
  // Pass 1b: child_of bullets fill in asymmetric stragglers.
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    for (const b of bullets) {
      if (b.kind !== "child_of") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const key = `${target}::${d.path}`;
      if (hierMap.has(key)) continue;
      hierMap.set(key, {
        namespace,
        from_path: target,
        to_path: d.path,
        kind: "hierarchy",
        label: b.label,
        position: 9999,
      });
    }
  }

  // Build pair-set + parents-of for assoc suppression.
  const hierPairs = new Set<string>();
  const parentsOf = new Map<string, Set<string>>();
  for (const r of hierMap.values()) {
    const [lo, hi] = r.from_path < r.to_path ? [r.from_path, r.to_path] : [r.to_path, r.from_path];
    hierPairs.add(`${lo}::${hi}`);
    const set = parentsOf.get(r.to_path) ?? new Set<string>();
    set.add(r.from_path);
    parentsOf.set(r.to_path, set);
  }
  const shareParent = (a: string, b: string) => {
    const pa = parentsOf.get(a);
    const pb = parentsOf.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

  // Pass 2: assocs, deduped per pair, suppressed by hierarchy + siblings.
  interface AssocPair { a: string; b: string; label: string | null; position: number; }
  const assocPairs = new Map<string, AssocPair>();
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "associated") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const [lo, hi] = d.path < target ? [d.path, target] : [target, d.path];
      const key = `${lo}::${hi}`;
      if (hierPairs.has(key)) continue;
      if (shareParent(d.path, target)) continue;
      if (!assocPairs.has(key)) {
        assocPairs.set(key, { a: d.path, b: target, label: b.label, position: pos });
        pos++;
      }
    }
  }

  const assocMap = new Map<string, EdgeRow>();
  for (const { a, b, label, position } of assocPairs.values()) {
    assocMap.set(`${a}::${b}`, { namespace, from_path: a, to_path: b, kind: "assoc", label, position });
    assocMap.set(`${b}::${a}`, { namespace, from_path: b, to_path: a, kind: "assoc", label, position });
  }

  // Filter down to rows that touch affectedPath. This keeps the diff
  // window small — we never DELETE/UPSERT a row that has nothing to do
  // with this edit. Renames/cross-edits invalidate other rows but those
  // are handled by their own write hooks.
  const filterTouching = <T extends EdgeRow>(map: Map<string, T>) => {
    const out = new Map<string, T>();
    for (const [k, r] of map) {
      if (r.from_path === affectedPath || r.to_path === affectedPath) out.set(k, r);
    }
    return out;
  };

  return {
    hierMap: filterTouching(hierMap),
    assocMap: filterTouching(assocMap),
  };
}

function rowKey(r: { from_path: string; to_path: string; kind: string }): string {
  return `${r.kind}::${r.from_path}::${r.to_path}`;
}

function rowEqual(a: EdgeRow, b: EdgeRow): boolean {
  return a.label === b.label && a.position === b.position;
}

/**
 * Sync the doc_edges rows that touch `docPath` in `namespace` to match
 * the post-write state implied by `newContent`. Loads every other doc
 * in the namespace from `vault_files` (title + path only — no body for
 * those) so the resolver can resolve cross-doc wiki-links.
 *
 * Throws on database errors — the caller (SupabaseStorage.write) lets
 * this propagate so the API PUT returns 500 and the user knows the
 * bucket+cache succeeded but the edges did not.
 */
export async function syncDocEdges(
  admin: SupabaseClient,
  namespace: string,
  docPath: string,
  newContent: string,
): Promise<void> {
  // Pull every doc in the namespace from vault_files. Bodies of OTHER
  // docs aren't needed for edge derivation off this doc's content, but
  // we DO need them: a parent's `## Parent of` bullet declaring [[B]]
  // produces a hierarchy row even when B itself was just edited.
  // Cheapest correct path is to read content for every doc and re-run
  // the whole namespace's edge derivation, filtered down to rows that
  // touch docPath.
  const { data: rows, error: readErr } = await admin
    .from("vault_files")
    .select("file_path, content")
    .eq("namespace", namespace);
  if (readErr) throw new Error(`syncDocEdges: vault_files read failed: ${readErr.message}`);

  const docs: DocMeta[] = (rows ?? []).map((r) => {
    const content = (r.content as string) ?? "";
    return {
      path: r.file_path as string,
      title: deriveTitle(r.file_path as string, content),
      content,
    };
  });

  // If docPath is missing from vault_files (deletion path), drop it from
  // the doc set so resolution doesn't pin to a vanished target.
  const filteredDocs = docs.filter((d) => d.path !== docPath || newContent !== "");
  // Ensure the doc we're syncing reflects the new content (vault_files
  // mirror may or may not have been updated yet depending on call order).
  if (newContent) {
    const existing = filteredDocs.find((d) => d.path === docPath);
    if (existing) {
      existing.content = newContent;
      existing.title = deriveTitle(docPath, newContent);
    } else {
      filteredDocs.push({ path: docPath, title: deriveTitle(docPath, newContent), content: newContent });
    }
  }

  const desired = computeDesired(namespace, filteredDocs, docPath);
  const desiredRows: EdgeRow[] = [...desired.hierMap.values(), ...desired.assocMap.values()];

  // Load current rows that touch docPath (outgoing + inbound).
  // SPRINT-024 Phase 2 audit: doc_edges reads MUST stay independent of
  // vault_files — never JOIN them. Any "I need the linked doc's body
  // alongside the edge" caller should fetch the body separately through
  // SupabaseStorage.read so a future Postgres-only edge store can drop
  // the vault_files dependency entirely.
  const { data: curFrom, error: e1 } = await admin
    .from("doc_edges")
    .select("from_path, to_path, kind, label, position")
    .eq("namespace", namespace)
    .eq("from_path", docPath);
  if (e1) throw new Error(`syncDocEdges: doc_edges read (from) failed: ${e1.message}`);
  const { data: curTo, error: e2 } = await admin
    .from("doc_edges")
    .select("from_path, to_path, kind, label, position")
    .eq("namespace", namespace)
    .eq("to_path", docPath);
  if (e2) throw new Error(`syncDocEdges: doc_edges read (to) failed: ${e2.message}`);

  const currentMap = new Map<string, EdgeRow>();
  for (const r of [...(curFrom ?? []), ...(curTo ?? [])]) {
    const row: EdgeRow = {
      namespace,
      from_path: r.from_path as string,
      to_path: r.to_path as string,
      kind: r.kind as "hierarchy" | "assoc",
      label: (r.label as string | null) ?? null,
      position: (r.position as number) ?? 0,
    };
    currentMap.set(rowKey(row), row);
  }

  const desiredMap = new Map<string, EdgeRow>();
  for (const r of desiredRows) desiredMap.set(rowKey(r), r);

  // Compute diff: rows to delete (in current, not in desired) and rows
  // to upsert (in desired and either missing or changed in current).
  const toDelete: EdgeRow[] = [];
  for (const [k, r] of currentMap) {
    if (!desiredMap.has(k)) toDelete.push(r);
  }
  const toUpsert: EdgeRow[] = [];
  for (const [k, r] of desiredMap) {
    const cur = currentMap.get(k);
    if (!cur || !rowEqual(cur, r)) toUpsert.push(r);
  }

  // Apply deletes one at a time (PK = composite, .delete().match() per row).
  // Volume is typically <10 — not worth a stored-proc round trip.
  for (const r of toDelete) {
    const { error } = await admin
      .from("doc_edges")
      .delete()
      .match({ namespace: r.namespace, from_path: r.from_path, to_path: r.to_path, kind: r.kind });
    if (error) throw new Error(`syncDocEdges: delete failed: ${error.message}`);
  }
  if (toUpsert.length > 0) {
    const { error } = await admin.from("doc_edges").upsert(toUpsert);
    if (error) throw new Error(`syncDocEdges: upsert failed: ${error.message}`);
  }
}

/**
 * Delete every edge touching `docPath` in the namespace. Called from
 * SupabaseStorage.delete to keep doc_edges in sync with file removals.
 */
export async function deleteDocEdges(
  admin: SupabaseClient,
  namespace: string,
  docPath: string,
): Promise<void> {
  // OR-conditional delete: rows where from_path = X OR to_path = X.
  const { error: e1 } = await admin
    .from("doc_edges")
    .delete()
    .eq("namespace", namespace)
    .eq("from_path", docPath);
  if (e1) throw new Error(`deleteDocEdges: from delete failed: ${e1.message}`);
  const { error: e2 } = await admin
    .from("doc_edges")
    .delete()
    .eq("namespace", namespace)
    .eq("to_path", docPath);
  if (e2) throw new Error(`deleteDocEdges: to delete failed: ${e2.message}`);
}
