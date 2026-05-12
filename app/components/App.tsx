"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { GraphView } from "./GraphView";
import { DocEditor } from "./DocEditor";
import type { DocIndex, DocNode } from "@/src/web/types";
import { useDocsChanged } from "./useDocsChanged";
import { useDocLog } from "./useDocLog";

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

type View = "doc" | "graph" | "log";
type DocMode = "raw" | "rendered";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface GraphModalContext {
  focalPath: string;
  focalTitle: string;
}

function slugify(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

function appendToSection(content: string, heading: string, line: string): string {
  const idx = content.search(new RegExp(`^${heading}\\s*$`, "im"));
  if (idx === -1) return content.trimEnd() + `\n\n${heading}\n${line}\n`;
  const after = content.slice(idx + heading.length);
  const nextSection = after.search(/^## /m);
  if (nextSection === -1) return content.trimEnd() + "\n" + line + "\n";
  const insertAt = idx + heading.length + nextSection;
  return content.slice(0, insertAt).trimEnd() + "\n" + line + "\n\n" + content.slice(insertAt);
}

interface ConflictFile {
  path: string;
  localHash: string;
  cloudUploadedAt: string;
  manifestSyncedAt: string;
}

function generatePat(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function App({ namespace }: { namespace: string }) {
  const { user, isSignedIn } = useUser();
  const isOwnNamespace = isSignedIn && user?.id === namespace;
  const isPublicNamespace = namespace === "public";

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
  const [canSync, setCanSync] = useState(false);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [addChildCtx, setAddChildCtx] = useState<GraphModalContext | null>(null);
  const [addChildTitle, setAddChildTitle] = useState("");
  const [addChildBusy, setAddChildBusy] = useState(false);
  const [addAssocCtx, setAddAssocCtx] = useState<GraphModalContext | null>(null);
  const [assocQuery, setAssocQuery] = useState("");
  const [assocTarget, setAssocTarget] = useState<string | null>(null);
  const [assocLabel, setAssocLabel] = useState("");
  const [assocBusy, setAssocBusy] = useState(false);
  const [deleteCtx, setDeleteCtx] = useState<GraphModalContext | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const docLog = useDocLog(namespace);
  const prevContentRef = useRef<Map<string, string>>(new Map());
  const loggedInSession = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/sync").then((r) => r.json()).then((d) => setCanSync(d.canSync)).catch(() => {});
    fetch("/api/mcp-info").then((r) => r.json()).then((d) => setMcpCommand(d.command ?? null)).catch(() => {});
  }, []);

  const copyMcpCommand = useCallback(() => {
    const cmd = mcpCommand ?? (isOwnNamespace && patToken
      ? `claude mcp add emdee --transport http-sse ${window.location.origin}/api/mcp`
      : null);
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2500);
    });
  }, [mcpCommand, isOwnNamespace, patToken]);

  const handleSync = useCallback(async (force = false) => {
    setSyncState("syncing");
    try {
      const url = force ? "/api/sync?force=true" : "/api/sync";
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.conflicts && data.conflicts.length > 0) {
        setConflicts(data.conflicts);
        setConflictModalOpen(true);
        setSyncState("idle");
      } else {
        setConflicts([]);
        setSyncState("done");
        setTimeout(() => setSyncState("idle"), 3000);
      }
    } catch {
      setSyncState("error");
      setTimeout(() => setSyncState("idle"), 3000);
    }
  }, []);

  const handleResolve = useCallback(async (filePath: string, action: "keep-local" | "keep-cloud") => {
    setResolvingPath(filePath);
    try {
      await fetch("/api/sync/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, path: filePath }),
      });
      setConflicts((prev) => prev.filter((c) => c.path !== filePath));
    } finally {
      setResolvingPath(null);
    }
  }, []);

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
      const res = await fetch(`/api/index?ns=${encodeURIComponent(namespace)}`, { cache: "no-store" });
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
  }, [namespace]);

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
    setMobileSidebarOpen(false);
  }, []);

  useEffect(() => {
    setSaveState("idle");
    // When switching docs, clear prev-content tracking for this new path so the
    // next edit session captures the freshly-loaded version as previousContent.
    if (activePath) prevContentRef.current.delete(activePath);
  }, [activePath]);

  const indexRef = useRef<DocIndex | null>(null);
  useEffect(() => { indexRef.current = index; }, [index]);

  const save = useCallback(async (path: string, content: string) => {
    const shouldLog = !loggedInSession.current.has(path);
    const previousContent = shouldLog
      ? (prevContentRef.current.get(path) ?? indexRef.current?.docs.find(d => d.path === path)?.content)
      : undefined;
    setSaveState("saving");
    try {
      localEdit.current = true;
      const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}&ns=${encodeURIComponent(namespace)}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: content,
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveState("saved");
      if (shouldLog && previousContent !== undefined && previousContent !== content) {
        const title = indexRef.current?.docs.find(d => d.path === path)?.title ?? path;
        docLog.push({ path, title, action: "edit", previousContent });
        loggedInSession.current.add(path);
      }
    } catch {
      setSaveState("error");
      localEdit.current = false;
    }
  }, [namespace, docLog]);

  const openDeleteNode = useCallback((focalPath: string, focalTitle: string) => {
    setDeleteCtx({ focalPath, focalTitle });
  }, []);

  const submitDeleteNode = useCallback(async () => {
    if (!deleteCtx) return;
    const { focalPath, focalTitle } = deleteCtx;
    setDeleteBusy(true);
    try {
      const previousContent = index?.docs.find((d) => d.path === focalPath)?.content;
      await fetch(`/api/doc?path=${encodeURIComponent(focalPath)}&ns=${encodeURIComponent(namespace)}`, {
        method: "DELETE",
      });
      docLog.push({ path: focalPath, title: focalTitle, action: "delete", previousContent });
      if (activePath === focalPath) {
        setActivePath(index?.entry ?? index?.docs.find(d => d.path !== focalPath)?.path ?? null);
      }
      await loadIndex(false);
      setDeleteCtx(null);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteCtx, namespace, index, activePath, loadIndex, docLog]);

  const handleRevertLog = useCallback(async (entry: import("./useDocLog").LogEntry) => {
    if (entry.action === "create") {
      await fetch(`/api/doc?path=${encodeURIComponent(entry.path)}&ns=${encodeURIComponent(namespace)}`, {
        method: "DELETE",
      });
    } else {
      if (!entry.previousContent) return;
      await fetch(`/api/doc?path=${encodeURIComponent(entry.path)}&ns=${encodeURIComponent(namespace)}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: entry.previousContent,
      });
    }
    await loadIndex(false);
    docLog.remove(entry.id);
  }, [namespace, loadIndex, docLog]);

  const openAddChild = useCallback((focalPath: string, focalTitle: string) => {
    setAddChildCtx({ focalPath, focalTitle });
    setAddChildTitle("");
  }, []);

  const openAddAssoc = useCallback((focalPath: string, focalTitle: string) => {
    setAddAssocCtx({ focalPath, focalTitle });
    setAssocQuery("");
    setAssocTarget(null);
    setAssocLabel("");
  }, []);

  const submitAddChild = useCallback(async () => {
    if (!addChildCtx || !addChildTitle.trim()) return;
    const slug = slugify(addChildTitle);
    if (!slug) return;
    setAddChildBusy(true);
    try {
      const focalDir = addChildCtx.focalPath.includes("/")
        ? addChildCtx.focalPath.slice(0, addChildCtx.focalPath.lastIndexOf("/") + 1)
        : "";
      const newPath = `${focalDir}${slug}.md`;
      const content = `# ${addChildTitle.trim()}\n\n> Add a summary here.\n\n## Child of\n- [[${addChildCtx.focalTitle}]]\n`;
      await fetch(`/api/doc?path=${encodeURIComponent(newPath)}&ns=${encodeURIComponent(namespace)}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: content,
      });
      await loadIndex(false);
      setActivePath(newPath);
      docLog.push({ path: newPath, title: addChildTitle.trim(), action: "create" });
      setAddChildCtx(null);
    } finally {
      setAddChildBusy(false);
    }
  }, [addChildCtx, addChildTitle, namespace, loadIndex, docLog]);

  const submitAddAssoc = useCallback(async () => {
    if (!addAssocCtx || !assocTarget) return;
    setAssocBusy(true);
    try {
      const focalDoc = index?.docs.find((d) => d.path === addAssocCtx.focalPath);
      const targetDoc = index?.docs.find((d) => d.path === assocTarget);
      if (!focalDoc || !targetDoc) return;
      const newLine = assocLabel.trim()
        ? `- [[${targetDoc.title}]] (${assocLabel.trim()})`
        : `- [[${targetDoc.title}]]`;
      const updatedContent = appendToSection(focalDoc.content, "## Associated with", newLine);
      await fetch(
        `/api/doc?path=${encodeURIComponent(addAssocCtx.focalPath)}&ns=${encodeURIComponent(namespace)}`,
        { method: "PUT", headers: { "content-type": "text/markdown" }, body: updatedContent }
      );
      await loadIndex(true);
      setAddAssocCtx(null);
    } finally {
      setAssocBusy(false);
    }
  }, [addAssocCtx, assocTarget, assocLabel, namespace, loadIndex, index]);

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

  const assocFilteredDocs = useMemo(() => {
    if (!index || !addAssocCtx) return [];
    const q = assocQuery.toLowerCase();
    return index.docs.filter(
      (d) => d.path !== addAssocCtx.focalPath && (q === "" || d.title.toLowerCase().includes(q))
    );
  }, [index, addAssocCtx, assocQuery]);

  return (
    <div className="app">
      <div
        className="sidebar-backdrop"
        data-open={mobileSidebarOpen}
        onClick={() => setMobileSidebarOpen(false)}
        aria-hidden="true"
      />
      <div className="mobile-header">
        <button
          className="mobile-hamburger"
          onClick={() => setMobileSidebarOpen((v) => !v)}
          aria-label="Toggle sidebar"
          type="button"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <span className="mobile-title">EMDEE</span>
      </div>
      <div className="sidebar-wrap" data-open={mobileSidebarOpen}>
        <aside className="sidebar" data-collapsed={sidebarCollapsed}>
          <h1>EMDEE</h1>
          {isOwnNamespace ? (
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
          ) : null}
          {isOwnNamespace && (
            <div className="connect-section">
              <span className="pat-label">Connect to Claude Code</span>
              {mcpCommand ? (
                <div className="connect-cmd-row">
                  <code className="pat-value connect-cmd" title={mcpCommand}>
                    {mcpCommand.length > 28 ? mcpCommand.slice(0, 28) + "…" : mcpCommand}
                  </code>
                  <button
                    className={`connect-copy-icon${mcpCopied ? " copied" : ""}`}
                    onClick={copyMcpCommand}
                    type="button"
                    title="Copy MCP command"
                    aria-label="Copy MCP command"
                  >
                    {mcpCopied ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <rect x="4.5" y="1.5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                        <path d="M2.5 4.5H2A1.5 1.5 0 0 0 .5 6v6A1.5 1.5 0 0 0 2 13.5h5.5A1.5 1.5 0 0 0 9 12v-.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      </svg>
                    )}
                  </button>
                </div>
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Loading…</span>
              )}
            </div>
          )}
          {isPublicNamespace && !isSignedIn && (
            <div className="connect-section">
              <a href="/sign-in" className="signin-btn">Sign in</a>
              <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
                to create and manage your vault
              </span>
            </div>
          )}
          {isPublicNamespace && isSignedIn && !isOwnNamespace && (
            <div className="connect-section">
              <a href={`/${user?.id}`} className="signin-btn">Go to my workspace</a>
            </div>
          )}
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
          <div className="sidebar-footer">
            <button
              className="sidebar-footer-btn"
              onClick={() => setView("log")}
              data-active={view === "log"}
              type="button"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M6.5 3.5V6.5L8.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              History
            </button>
          </div>
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
        {canSync && (
          <div className="content-topbar">
            <span className="spacer" />
            <button
              className={`sync-inline-btn${conflicts.length > 0 ? " has-conflicts" : ""}`}
              onClick={() => conflicts.length > 0 ? setConflictModalOpen(true) : handleSync(false)}
              disabled={syncState === "syncing"}
              type="button"
            >
              {syncState === "syncing" ? "Syncing…" : syncState === "done" ? "✓ Synced" : syncState === "error" ? "⚠ Sync failed" : conflicts.length > 0 ? `${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}` : "Push to Cloud"}
            </button>
          </div>
        )}
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
            onAddChild={isOwnNamespace ? openAddChild : undefined}
            onAddAssociation={isOwnNamespace ? openAddAssoc : undefined}
            onDeleteNode={isOwnNamespace ? openDeleteNode : undefined}
          />
        )}
        {view === "log" && (
          <div className="log-view">
            <div className="log-header">
              <span className="log-header-title">History</span>
              <span className="log-header-note">Edits by you in this browser. MCP edits not yet tracked.</span>
              <span className="spacer" />
              {docLog.entries.length > 0 && (
                <button className="btn-ghost" onClick={docLog.clear} type="button" style={{ fontSize: 11 }}>Clear all</button>
              )}
            </div>
            {docLog.entries.length === 0 ? (
              <div className="empty"><p>No changes recorded yet.</p></div>
            ) : (
              <div className="log-list">
                {docLog.entries.map((entry) => (
                  <div key={entry.id} className="log-entry">
                    <span className={`log-badge log-badge-${entry.action}`}>
                      {entry.action}
                    </span>
                    <div className="log-entry-info">
                      <span className="log-entry-title">{entry.title}</span>
                      <span className="log-entry-path">{entry.path}</span>
                    </div>
                    <span className="log-entry-time">{relativeTime(entry.timestamp)}</span>
                    {(entry.action === "delete" || (entry.action === "create") || (entry.action === "edit" && entry.previousContent)) && (
                      <button
                        className="btn-ghost log-revert-btn"
                        onClick={() => handleRevertLog(entry)}
                        type="button"
                        title={entry.action === "create" ? "Delete this doc" : "Restore previous content"}
                      >
                        ↩ Revert
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Add child modal */}
      {addChildCtx && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setAddChildCtx(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-title">New child doc</p>
            <p className="modal-subtitle">Will be linked as a child of <strong>{addChildCtx.focalTitle}</strong></p>
            <div className="modal-field">
              <label className="modal-label" htmlFor="add-child-title">Title</label>
              <input
                id="add-child-title"
                className="modal-input"
                type="text"
                placeholder="e.g. My New Doc"
                value={addChildTitle}
                onChange={(e) => setAddChildTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitAddChild()}
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setAddChildCtx(null)} type="button">Cancel</button>
              <button
                className="btn-primary"
                onClick={submitAddChild}
                disabled={!addChildTitle.trim() || addChildBusy}
                type="button"
              >
                {addChildBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add association modal */}
      {addAssocCtx && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setAddAssocCtx(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-title">Associate with…</p>
            <p className="modal-subtitle">Add a link from <strong>{addAssocCtx.focalTitle}</strong></p>
            <div className="modal-field">
              <label className="modal-label" htmlFor="assoc-search">Search docs</label>
              <input
                id="assoc-search"
                className="modal-input"
                type="text"
                placeholder="Filter by title…"
                value={assocQuery}
                onChange={(e) => setAssocQuery(e.target.value)}
                autoFocus
              />
              <div className="assoc-list">
                {assocFilteredDocs.length === 0 ? (
                  <div className="assoc-list-empty">No docs found</div>
                ) : assocFilteredDocs.map((d) => (
                  <div
                    key={d.path}
                    className="assoc-item"
                    data-selected={assocTarget === d.path}
                    onClick={() => setAssocTarget(d.path)}
                    role="option"
                    aria-selected={assocTarget === d.path}
                  >
                    <span className="assoc-item-check">
                      {assocTarget === d.path && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1.5 4L3.5 6L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </span>
                    {d.title}
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-field">
              <label className="modal-label" htmlFor="assoc-label">Relationship <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></label>
              <input
                id="assoc-label"
                className="modal-input"
                type="text"
                placeholder="e.g. collaborated on, mentored by…"
                value={assocLabel}
                onChange={(e) => setAssocLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitAddAssoc()}
              />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setAddAssocCtx(null)} type="button">Cancel</button>
              <button
                className="btn-primary"
                onClick={submitAddAssoc}
                disabled={!assocTarget || assocBusy}
                type="button"
              >
                {assocBusy ? "Saving…" : "Associate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteCtx && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setDeleteCtx(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-title">Delete doc?</p>
            <p className="modal-subtitle">
              <strong>{deleteCtx.focalTitle}</strong> will be permanently deleted. This can be reverted from History.
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDeleteCtx(null)} type="button">Cancel</button>
              <button
                className="btn-destructive"
                onClick={submitDeleteNode}
                disabled={deleteBusy}
                type="button"
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conflict resolution modal */}
      {conflictModalOpen && conflicts.length > 0 && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setConflictModalOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-title">Sync conflicts</p>
            <p className="modal-subtitle">Both sides were changed. Choose which version to keep for each file.</p>
            <div className="conflict-panel" style={{ marginTop: 12 }}>
              <div className="conflict-header">
                <span>Conflicts — both sides changed</span>
                <button className="conflict-force-btn" onClick={() => { handleSync(true); setConflictModalOpen(false); }} type="button">
                  Keep all local
                </button>
              </div>
              {conflicts.map((c) => (
                <div key={c.path} className="conflict-row">
                  <span className="conflict-path" title={c.path}>{c.path}</span>
                  <div className="conflict-actions">
                    <button
                      className="conflict-btn"
                      onClick={() => handleResolve(c.path, "keep-local")}
                      disabled={resolvingPath === c.path}
                      type="button"
                    >Mine</button>
                    <button
                      className="conflict-btn"
                      onClick={() => handleResolve(c.path, "keep-cloud")}
                      disabled={resolvingPath === c.path}
                      type="button"
                    >Cloud</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setConflictModalOpen(false)} type="button">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
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
