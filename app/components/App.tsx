"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./GraphView";
import { DocEditor } from "./DocEditor";
import type { DocIndex, DocNode } from "@/src/web/types";
import { useDocsChanged } from "./useDocsChanged";

interface TreeNode {
  doc: DocNode;
  depth: number;
  children: TreeNode[];
}

function buildDocTree(index: DocIndex): TreeNode[] {
  // childrenOf: parent path → child paths (from hierarchy edges)
  // hasParent: child path → true (so we can find roots)
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

  // Roots = docs without a parent in hierarchy. Sort: entry doc first, then by title.
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

  // Append any orphaned docs that didn't get visited (e.g., cycles).
  for (const d of index.docs) {
    if (!visited.has(d.path)) {
      roots.push({ doc: d, depth: 0, children: [] });
      visited.add(d.path);
    }
  }
  return roots;
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

function displayTitle(title: string, parentTitle: string | null): string {
  if (!parentTitle) return title;
  const segments = parentTitle.split(" — ");
  for (let i = segments.length; i > 0; i--) {
    const prefix = segments.slice(0, i).join(" — ") + " — ";
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
}

function DocTree({ nodes, parentPath, parentTitle, activePath, collapsed, onSelect, onToggle }: DocTreeProps) {
  if (nodes.length === 0) return null;
  const isRoot = parentPath === null;
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
                className="doc-tree-row"
                onClick={() => {
                  onSelect(n.doc.path);
                  if (hasChildren && isCollapsed) onToggle(n.doc.path);
                }}
                data-active={n.doc.path === activePath}
                type="button"
              >
                {displayTitle(n.doc.title, parentTitle)}
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

type View = "doc" | "graph";
type DocMode = "raw" | "rendered";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function generatePat(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function App() {
  const [index, setIndex] = useState<DocIndex | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<View>("doc");
  const [docMode, setDocMode] = useState<DocMode>("rendered");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<number | null>(null);
  const localEdit = useRef(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const collapsedInitialized = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [patToken, setPatToken] = useState<string | null>(null);
  const [patCopied, setPatCopied] = useState(false);

  useEffect(() => {
    let token = localStorage.getItem("emdee_pat");
    if (!token) {
      token = generatePat();
      localStorage.setItem("emdee_pat", token);
    }
    setPatToken(token);
  }, []);

  const rotatePat = useCallback(() => {
    const token = generatePat();
    localStorage.setItem("emdee_pat", token);
    setPatToken(token);
  }, []);

  const copyPat = useCallback(() => {
    if (!patToken) return;
    navigator.clipboard.writeText(patToken).then(() => {
      setPatCopied(true);
      setTimeout(() => setPatCopied(false), 2000);
    });
  }, [patToken]);

  const toggleCollapsed = useCallback((p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const loadIndex = useCallback(async (preserveActive: boolean) => {
    try {
      const res = await fetch("/api/index", { cache: "no-store" });
      if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
      const data: DocIndex = await res.json();
      setIndex(data);
      setActivePath((current) => {
        if (preserveActive && current && data.docs.some((d) => d.path === current)) {
          return current;
        }
        return data.entry ?? data.docs?.[0]?.path ?? null;
      });
    } catch {
      setIndex({ docs: [], edges: [], entry: null });
    }
  }, []);

  useEffect(() => {
    loadIndex(false);
  }, [loadIndex]);

  useDocsChanged(useCallback(() => {
    if (!localEdit.current) loadIndex(true);
    else localEdit.current = false;
  }, [loadIndex]));

  const activeDoc = useMemo<DocNode | null>(
    () => index?.docs.find((d) => d.path === activePath) ?? null,
    [index, activePath]
  );

  const docTree = useMemo(
    () => (index ? buildDocTree(index) : []),
    [index]
  );

  // Collapse all parent nodes on first load; leave user-driven toggles alone after that.
  useEffect(() => {
    if (collapsedInitialized.current || docTree.length === 0) return;
    collapsedInitialized.current = true;
    const parents = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          parents.add(n.doc.path);
          collect(n.children);
        }
      }
    };
    collect(docTree);
    setCollapsed(parents);
  }, [docTree]);

  // Sidebar click sets the active path but preserves the current view —
  // in graph view it navigates the graph focus, in doc view it loads the doc.
  // Explicit Docs/Graph buttons (and "Open doc" inside the graph) switch views.
  const selectDoc = useCallback((p: string) => {
    setActivePath(p);
  }, []);

  useEffect(() => {
    setSaveState("idle");
  }, [activeDoc?.path]);

  const save = useCallback(async (path: string, content: string) => {
    setSaveState("saving");
    try {
      localEdit.current = true;
      const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: content,
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveState("saved");
    } catch {
      setSaveState("error");
      localEdit.current = false;
    }
  }, []);

  const handleWikiLinkClick = useCallback((title: string) => {
    const match = index?.docs.find((d) => d.title.toLowerCase() === title.toLowerCase());
    if (match) selectDoc(match.path);
  }, [index, selectDoc]);

  const handleEdit = useCallback((next: string) => {
    if (!activePath) return;
    setSaveState("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(activePath, next), 600);
  }, [activePath, save]);

  return (
    <div className="app">
      <div className="sidebar-wrap">
        <aside className="sidebar" data-collapsed={sidebarCollapsed}>
          <h1>EMDEE</h1>
          <div className="pat-section">
            <span className="pat-label">PAT Token</span>
            <code className="pat-value">{patToken ? `${patToken.slice(0, 8)}…` : "—"}</code>
            <div className="pat-actions">
              <button className="pat-btn" onClick={copyPat} type="button" title="Copy token">
                {patCopied ? "✓" : "Copy"}
              </button>
              <button className="pat-btn" onClick={rotatePat} type="button" title="Rotate token">
                Rotate
              </button>
            </div>
          </div>
          <nav>
            <button onClick={() => setView("doc")} data-active={view === "doc"}>Docs</button>
            <button onClick={() => setView("graph")} data-active={view === "graph"}>Graph</button>
          </nav>
          <DocTree
            nodes={docTree}
            parentPath={null}
            parentTitle={null}
            activePath={activePath}
            collapsed={collapsed}
            onSelect={selectDoc}
            onToggle={toggleCollapsed}
          />
        </aside>
        <button
          className="sidebar-rail"
          onClick={() => setSidebarCollapsed((v) => !v)}
          aria-label={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
          type="button"
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
      </div>
      <main className="content">
        {view === "doc" && activeDoc && (
          <>
            <div className="toolbar">
              <button onClick={() => setDocMode("rendered")} data-active={docMode === "rendered"}>Rendered</button>
              <button onClick={() => setDocMode("raw")} data-active={docMode === "raw"}>Raw</button>
              <span className="doc-path">{activeDoc.path}</span>
              <span className="spacer" />
              <span className="save-state">{labelFor(saveState)}</span>
            </div>
            <div className="editor-host">
              <DocEditor
                path={activeDoc.path}
                initialContent={activeDoc.content}
                mode={docMode}
                onChange={handleEdit}
                onWikiLinkClick={handleWikiLinkClick}
              />
            </div>
          </>
        )}
        {view === "doc" && !activeDoc && (
          <div className="empty">
            <p>No docs found. Run <code>mane init</code> in a directory to get started.</p>
          </div>
        )}
        {view === "graph" && index && (
          <GraphView
            index={index}
            activePath={activePath}
            onSelect={(p) => { setActivePath(p); setView("doc"); }}
          />
        )}
      </main>
    </div>
  );
}

function labelFor(s: SaveState): string {
  switch (s) {
    case "idle": return "";
    case "dirty": return "Editing…";
    case "saving": return "Saving…";
    case "saved": return "Saved";
    case "error": return "Save failed";
  }
}
