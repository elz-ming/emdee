"use client";
import { useEffect, useRef } from "react";
import type { DocIndex, DocNode } from "@/src/core/indexer";

export interface TreeNode {
  doc: DocNode;
  depth: number;
  children: TreeNode[];
}

/**
 * Build a hierarchical TreeNode list from a DocIndex via the indexer's
 * hierarchy edges. Roots are docs with no parent; cycles are broken by a
 * visited-set so each path appears at most once.
 */
export function buildDocTree(index: DocIndex): TreeNode[] {
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of index.edges) {
    if (e.kind !== "hierarchy") continue;
    const arr = childrenOf.get(e.from) ?? [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
    hasParent.add(e.to);
  }

  const byPath = new Map<string, DocNode>();
  for (const d of index.docs) byPath.set(d.path, d);

  const sortPaths = (paths: string[]) =>
    [...paths].sort((a, b) => {
      const ta = byPath.get(a)?.title ?? a;
      const tb = byPath.get(b)?.title ?? b;
      return ta.localeCompare(tb);
    });

  const visited = new Set<string>();
  const walk = (path: string, depth: number): TreeNode | null => {
    if (visited.has(path)) return null;
    visited.add(path);
    const doc = byPath.get(path);
    if (!doc) return null;
    const childPaths = sortPaths(childrenOf.get(path) ?? []);
    const children = childPaths
      .map((c) => walk(c, depth + 1))
      .filter((n): n is TreeNode => n !== null);
    return { doc, depth, children };
  };

  const rootPaths = sortPaths(
    index.docs.map((d) => d.path).filter((p) => !hasParent.has(p))
  );
  if (index.entry && rootPaths.includes(index.entry)) {
    const i = rootPaths.indexOf(index.entry);
    rootPaths.splice(i, 1);
    rootPaths.unshift(index.entry);
  }

  const roots: TreeNode[] = [];
  for (const p of rootPaths) {
    const node = walk(p, 0);
    if (node) roots.push(node);
  }
  for (const d of index.docs) {
    if (!visited.has(d.path)) {
      roots.push({ doc: d, depth: 0, children: [] });
      visited.add(d.path);
    }
  }
  return roots;
}

/**
 * Longest "X — " prefix shared by every title in a sibling group, computed
 * segment-by-segment. Strips noise like "ATLAS — " from a flat list of
 * ["ATLAS", "ATLAS — BUILD", "ATLAS — CONTEXT"] so the tree shows
 * ["ATLAS", "BUILD", "CONTEXT"].
 */
function siblingsCommonPrefix(titles: string[]): string | null {
  if (titles.length < 2) return null;
  const segs = titles.map((t) => t.split(" — "));
  let i = 0;
  while (true) {
    const first = segs[0][i];
    if (first === undefined) break;
    if (!segs.every((s) => s[i] === first)) break;
    i++;
  }
  if (i === 0) return null;
  return segs[0].slice(0, i).join(" — ") + " — ";
}

function displayTitle(title: string, parentTitle: string | null, siblingPrefix: string | null): string {
  let out = title;
  if (parentTitle) {
    const segments = parentTitle.split(" — ");
    for (let i = segments.length; i > 0; i--) {
      const prefix = segments.slice(0, i).join(" — ") + " — ";
      if (out.startsWith(prefix)) { out = out.slice(prefix.length); break; }
    }
  }
  if (siblingPrefix && out.startsWith(siblingPrefix)) {
    out = out.slice(siblingPrefix.length);
  }
  return out;
}

interface DocTreeProps {
  nodes: TreeNode[];
  parentPath: string | null;
  parentTitle: string | null;
  activePath: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

export function DocTree({ nodes, parentPath, parentTitle, activePath, collapsed, onSelect, onToggle }: DocTreeProps) {
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  // When the active doc changes (graph click, prev/next, deep link),
  // scroll the matching row into view. `inline: "nearest"` also brings
  // deeply-nested rows into the horizontal viewport so the leaf label is
  // visible past the indent.
  useEffect(() => {
    if (!activeRowRef.current) return;
    activeRowRef.current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  if (nodes.length === 0) return null;
  const isRoot = parentPath === null;
  const siblingPrefix = siblingsCommonPrefix(nodes.map((n) => n.doc.title));
  return (
    <ul className="doc-tree" data-root={isRoot}>
      {!isRoot && (
        <button
          className="tree-vline"
          onClick={() => onToggle(parentPath!)}
          aria-label="Collapse branch"
          type="button"
        />
      )}
      {nodes.map((n, i) => {
        const hasChildren = n.children.length > 0;
        const isCollapsed = collapsed.has(n.doc.path);
        const isActive = n.doc.path === activePath;
        return (
          <li
            key={n.doc.path}
            className={`doc-tree-item${i === nodes.length - 1 ? " is-last" : ""}`}
          >
            {!isRoot && (
              <button
                className="tree-hline"
                onClick={() => onToggle(parentPath!)}
                aria-label="Collapse branch"
                type="button"
              />
            )}
            <div className="doc-tree-row-wrap">
              <button
                ref={isActive ? activeRowRef : undefined}
                className="doc-tree-row"
                onClick={() => {
                  onSelect(n.doc.path);
                  if (hasChildren && isCollapsed) onToggle(n.doc.path);
                }}
                data-active={isActive}
                type="button"
              >
                {displayTitle(n.doc.title, parentTitle, siblingPrefix)}
              </button>
              {hasChildren && (
                <button
                  className="doc-tree-chevron"
                  onClick={() => onToggle(n.doc.path)}
                  aria-label={isCollapsed ? "Expand" : "Collapse"}
                  type="button"
                  data-collapsed={isCollapsed}
                >
                  ›
                </button>
              )}
            </div>
            {hasChildren && !isCollapsed && (
              <DocTree
                nodes={n.children}
                parentPath={n.doc.path}
                parentTitle={n.doc.title}
                activePath={activePath}
                collapsed={collapsed}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
