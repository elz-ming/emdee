"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { GraphView } from "./GraphView";
import { DocEditor } from "./DocEditor";
import { ShareModal } from "./ShareModal";
import type { DocIndex, DocNode } from "@/src/core/indexer";
import { useDocsChanged } from "./useDocsChanged";
import { useDocLog } from "./useDocLog";

interface SharedDoc {
  shareId: string;
  ownerId: string;
  ownerEmail: string | null;
  path: string;
  title: string;
  content: string;
  permission: "read" | "write";
}

const SHARED_PREFIX = "__shared:";
const sharedActiveKey = (s: SharedDoc) => `${SHARED_PREFIX}${s.ownerId}:${s.path}`;

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

/**
 * Longest "X — " prefix shared by every title in a sibling group, computed
 * segment-by-segment. Returns null when there's no shared prefix or only
 * one sibling. Lets us strip "ATLAS — " from a flat list of
 * ["ATLAS", "ATLAS — BUILD", "ATLAS — CONTEXT", …] so the tree renders as
 * ["ATLAS", "BUILD", "CONTEXT", …]. (Used for synthetic SHARED children
 * whose declared parent doesn't match the rendering parent — the existing
 * parentTitle strip can't see it.)
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

function DocTree({ nodes, parentPath, parentTitle, activePath, collapsed, onSelect, onToggle }: DocTreeProps) {
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

type View = "main" | "log";
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

export function App({ namespace }: { namespace: string }) {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const isOwnNamespace = isSignedIn && user?.id === namespace;
  const isPublicNamespace = namespace === "public";

  const [index, setIndex] = useState<DocIndex | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<View>("main");
  const [docMode, setDocMode] = useState<DocMode>("rendered");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<number | null>(null);
  const localEdit = useRef(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const collapsedInitialized = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [canSync, setCanSync] = useState(false);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Desktop: draggable split ratio between graph (left) and doc (right), 0.15-0.85.
  // Mobile/portrait: graph stacks above doc with a collapse toggle.
  // Both states persist to localStorage so the layout sticks across refreshes.
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
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
  const [shareCtx, setShareCtx] = useState<GraphModalContext | null>(null);
  const [sharedDocs, setSharedDocs] = useState<SharedDoc[]>([]);
  const [renameCtx, setRenameCtx] = useState<GraphModalContext | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renamePath, setRenamePath] = useState("");
  const [renamePathDirty, setRenamePathDirty] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const docLog = useDocLog(namespace);
  const prevContentRef = useRef<Map<string, string>>(new Map());
  const loggedInSession = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/sync").then((r) => r.json()).then((d) => setCanSync(d.canSync)).catch(() => {});
    fetch("/api/mcp-info").then((r) => r.json()).then((d) => setMcpCommand(d.command ?? null)).catch(() => {});
  }, []);

  // Docs shared with me — only meaningful when viewing my own workspace.
  // Refetched whenever the share modal closes so newly-revoked entries
  // disappear without a manual reload.
  const refreshShared = useCallback(() => {
    if (!isOwnNamespace) {
      setSharedDocs([]);
      return;
    }
    fetch("/api/shared")
      .then((r) => r.json())
      .then((d) => setSharedDocs(d.docs ?? []))
      .catch(() => setSharedDocs([]));
  }, [isOwnNamespace]);
  useEffect(() => { refreshShared(); }, [refreshShared]);

  // Load the linked cloud userId (set by /cloud-link/callback) and stay in
  // sync if the user re-links in another tab.
  useEffect(() => {
    setCloudUserId(localStorage.getItem("emdee_cloud_user_id"));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "emdee_cloud_user_id") setCloudUserId(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Opens the prod handshake in a new tab. After Clerk auth, it bounces back
  // to /cloud-link/callback which writes localStorage.emdee_cloud_user_id.
  const cloudOrigin = process.env.NEXT_PUBLIC_CLOUD_ORIGIN ?? "https://emdee.vercel.app";
  const linkCloudAccount = useCallback(() => {
    const returnUrl = `${window.location.origin}/cloud-link/callback`;
    const url = `${cloudOrigin}/cloud-link?return=${encodeURIComponent(returnUrl)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [cloudOrigin]);

  const unlinkCloudAccount = useCallback(() => {
    localStorage.removeItem("emdee_cloud_user_id");
    setCloudUserId(null);
  }, []);

  // Rehydrate the user's preferred desktop split ratio and mobile graph-collapse
  // state on mount.
  useEffect(() => {
    const ratio = parseFloat(localStorage.getItem("emdee_split_ratio") ?? "");
    if (Number.isFinite(ratio) && ratio >= 0.15 && ratio <= 0.85) setSplitRatio(ratio);
    setGraphCollapsed(localStorage.getItem("emdee_graph_collapsed") === "true");
  }, []);

  // Pointer-driven resize of the .main-split divider. Listens on document so
  // dragging works even when the pointer leaves the divider's thin hit box.
  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    const container = splitContainerRef.current;
    if (!container) return;
    e.preventDefault();
    setDraggingSplit(true);
    document.body.dataset.resizingSplit = "true";
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const x = ev.clientX - rect.left;
      const ratio = Math.max(0.15, Math.min(0.85, x / rect.width));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      delete document.body.dataset.resizingSplit;
      setDraggingSplit(false);
      // Persist whatever ratio we ended at.
      setSplitRatio((r) => {
        localStorage.setItem("emdee_split_ratio", r.toFixed(4));
        return r;
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const toggleGraphCollapsed = useCallback(() => {
    setGraphCollapsed((v) => {
      const next = !v;
      localStorage.setItem("emdee_graph_collapsed", String(next));
      return next;
    });
  }, []);

  const copyMcpCommand = useCallback(() => {
    if (!mcpCommand) return;
    navigator.clipboard.writeText(mcpCommand).then(() => {
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2500);
    });
  }, [mcpCommand]);

  // URL for adding this server as a Claude.ai Custom Connector. The OAuth
  // flow at /oauth/* handles auth on first connect — no token in the URL.
  const mcpUrl = typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "";
  const copyMcpUrl = useCallback(() => {
    if (!mcpUrl) return;
    navigator.clipboard.writeText(mcpUrl).then(() => {
      setMcpUrlCopied(true);
      setTimeout(() => setMcpUrlCopied(false), 2500);
    });
  }, [mcpUrl]);

  const handleSync = useCallback(async (force = false) => {
    if (!cloudUserId) {
      setSyncState("error");
      setTimeout(() => setSyncState("idle"), 3000);
      return;
    }
    setSyncState("syncing");
    try {
      const params = new URLSearchParams({ ns: cloudUserId });
      if (force) params.set("force", "true");
      const res = await fetch(`/api/sync?${params.toString()}`, { method: "POST" });
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
  }, [cloudUserId]);

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

  const toggleCollapsed = useCallback((p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // Personal namespaces get sticky focus across reloads — public visitors
  // always land on the entry doc (INFO) so the intro experience is consistent.
  // Keyed by namespace alone so we don't have to wait for Clerk hydration;
  // the focus state is just UI, not sensitive content.
  const focusKey = namespace !== "public" ? `emdee_focus_${namespace}` : null;

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
        if (focusKey) {
          const stored = localStorage.getItem(focusKey);
          if (stored && data.docs.some((d) => d.path === stored)) return stored;
        }
        return data.entry ?? data.docs?.[0]?.path ?? null;
      });
    } catch {
      setIndex({ docs: [], edges: [], entry: null });
    }
  }, [namespace, focusKey]);

  // Persist the focused doc for authenticated users so a refresh lands them
  // back where they left off.
  useEffect(() => {
    if (!focusKey || !activePath) return;
    localStorage.setItem(focusKey, activePath);
  }, [focusKey, activePath]);

  useEffect(() => {
    loadIndex(false);
  }, [loadIndex]);

  useDocsChanged(namespace, useCallback(() => {
    if (!localEdit.current) loadIndex(true);
    else localEdit.current = false;
  }, [loadIndex]));

  const activeSharedDoc = useMemo<SharedDoc | null>(() => {
    if (!activePath || !activePath.startsWith(SHARED_PREFIX)) return null;
    return sharedDocs.find((s) => sharedActiveKey(s) === activePath) ?? null;
  }, [activePath, sharedDocs]);

  const activeDoc = useMemo<DocNode | null>(() => {
    if (activeSharedDoc) {
      return {
        path: activeSharedDoc.path,
        title: activeSharedDoc.title,
        content: activeSharedDoc.content,
        summary: "",
        parents: [],
        children: [],
        associates: [],
        mentions: [],
      };
    }
    return index?.docs.find((d) => d.path === activePath) ?? null;
  }, [index, activePath, activeSharedDoc]);

  // Prev/Next sibling derived from the active doc's first declared parent's
  // `Parent of` order. Mirrors the server-side computation in
  // src/lib/mcp/tools/get_neighbors.ts so the renderer and any MCP client
  // see the same sequence. Null when there's no parent, the parent isn't
  // resolvable, or focal isn't in the parent's bullet list.
  const { prevSibling, nextSibling } = useMemo<{
    prevSibling: DocNode | null;
    nextSibling: DocNode | null;
  }>(() => {
    if (!activeDoc || !index || activePath?.startsWith(SHARED_PREFIX)) {
      return { prevSibling: null, nextSibling: null };
    }
    const primaryParent = activeDoc.parents[0];
    if (!primaryParent) return { prevSibling: null, nextSibling: null };
    const byTitle = new Map(index.docs.map((d) => [d.title.toLowerCase(), d]));
    const parentDoc = byTitle.get(primaryParent.title.toLowerCase());
    if (!parentDoc) return { prevSibling: null, nextSibling: null };
    const siblings = parentDoc.children
      .map((l) => byTitle.get(l.title.toLowerCase()))
      .filter((d): d is DocNode => !!d);
    const idx = siblings.findIndex((d) => d.path === activeDoc.path);
    if (idx === -1) return { prevSibling: null, nextSibling: null };
    return {
      prevSibling: siblings[idx - 1] ?? null,
      nextSibling: siblings[idx + 1] ?? null,
    };
  }, [activeDoc, activePath, index]);

  const rawDocTree = useMemo(
    () => (index ? buildDocTree(index) : []),
    [index]
  );

  // SHARED.md is a real doc seeded into every vault (see
  // scripts/seed-shared-doc.mjs) — the indexer puts it under VAULT
  // naturally. Here we attach synthetic, read-only children to it
  // pointing at docs other users have shared in. The children carry the
  // "__shared:<owner>:<path>" sentinel so the doc pane treats them as
  // read-only and routes reads to the owner's namespace.
  const docTree = useMemo<TreeNode[]>(() => {
    if (sharedDocs.length === 0) return rawDocTree;
    const sharedChildren: TreeNode[] = sharedDocs.map((s) => ({
      doc: {
        path: sharedActiveKey(s),
        title: s.title,
        content: s.content,
        summary: "",
        parents: [],
        children: [],
        associates: [],
        mentions: [],
      },
      depth: 0,
      children: [],
    }));

    const attachToShared = (nodes: TreeNode[]): TreeNode[] | null => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.doc.title.toUpperCase() === "SHARED") {
          const next = nodes.slice();
          next[i] = { ...n, children: [...n.children, ...sharedChildren] };
          return next;
        }
        const inChild = attachToShared(n.children);
        if (inChild) {
          const next = nodes.slice();
          next[i] = { ...n, children: inChild };
          return next;
        }
      }
      return null;
    };

    return attachToShared(rawDocTree) ?? rawDocTree;
  }, [rawDocTree, sharedDocs]);

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

  // When shared docs arrive, expand the path from the root down to SHARED
  // so the user actually sees them. One-shot — if they later collapse,
  // we don't fight them.
  const sharedExpandedRef = useRef(false);
  useEffect(() => {
    if (sharedExpandedRef.current) return;
    if (sharedDocs.length === 0) return;
    sharedExpandedRef.current = true;
    const ancestors: string[] = [];
    const findPathTo = (nodes: TreeNode[], targetTitle: string, trail: string[]): string[] | null => {
      for (const n of nodes) {
        const nextTrail = [...trail, n.doc.path];
        if (n.doc.title.toUpperCase() === targetTitle) return nextTrail;
        const r = findPathTo(n.children, targetTitle, nextTrail);
        if (r) return r;
      }
      return null;
    };
    const trail = findPathTo(rawDocTree, "SHARED", []);
    if (trail) ancestors.push(...trail);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of ancestors) next.delete(p);
      return next;
    });
  }, [sharedDocs, rawDocTree]);

  // Sidebar click sets the active path but preserves the current view —
  // in graph view it navigates the graph focus, in doc view it loads the doc.
  // Explicit Docs/Graph buttons (and "Open doc" inside the graph) switch views.
  const selectDoc = useCallback((p: string) => {
    setActivePath(p);
    setView("main");
    setMobileSidebarOpen(false);
  }, []);

  // Keyboard shortcuts: `[` / `]` jump to prev / next sibling. Skipped when
  // an input or contentEditable has focus so we don't hijack typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (e.key === "[" && prevSibling) {
        e.preventDefault();
        selectDoc(prevSibling.path);
      } else if (e.key === "]" && nextSibling) {
        e.preventDefault();
        selectDoc(nextSibling.path);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prevSibling, nextSibling, selectDoc]);

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

  const openShareNode = useCallback((focalPath: string, focalTitle: string) => {
    setShareCtx({ focalPath, focalTitle });
  }, []);

  const openRenameNode = useCallback((focalPath: string, focalTitle: string) => {
    setRenameCtx({ focalPath, focalTitle });
    setRenameTitle(focalTitle);
    setRenamePath(focalPath);
    setRenamePathDirty(false);
    setRenameError(null);
  }, []);

  // Auto-derive the path from the title (same directory, sanitized filename)
  // until the user manually edits the path field — then we leave their
  // version alone.
  useEffect(() => {
    if (!renameCtx || renamePathDirty) return;
    const dir = renameCtx.focalPath.includes("/")
      ? renameCtx.focalPath.slice(0, renameCtx.focalPath.lastIndexOf("/"))
      : "";
    const safe = renameTitle.trim().replace(/[/\\]/g, "_");
    if (!safe) return;
    setRenamePath(dir ? `${dir}/${safe}.md` : `${safe}.md`);
  }, [renameTitle, renameCtx, renamePathDirty]);

  const submitRename = useCallback(async () => {
    if (!renameCtx) return;
    const newTitle = renameTitle.trim();
    const newPath = renamePath.trim();
    if (!newTitle || !newPath) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const res = await fetch("/api/doc/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldPath: renameCtx.focalPath, newTitle, newPath }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setRenameError(data.error ?? "rename failed");
        return;
      }
      // Reload the index, then point activePath at the new file so the
      // doc pane doesn't lose context.
      setActivePath(newPath);
      await loadIndex(false);
      refreshShared();
      setRenameCtx(null);
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  }, [renameCtx, renameTitle, renamePath, loadIndex, refreshShared]);

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

  // PDF export — flip to rendered mode, tag <body> so print CSS scopes
  // the print view to just the doc preview, then trigger the browser's
  // Save as PDF dialog. No new deps; the user picks the destination.
  const exportPdf = useCallback(() => {
    if (!activeDoc) return;
    setDocMode("rendered");
    setTimeout(() => {
      document.body.classList.add("printing-doc");
      window.print();
      // afterprint fires once the dialog closes (cancel or save).
      const cleanup = () => {
        document.body.classList.remove("printing-doc");
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup);
    }, 120);
  }, [activeDoc]);

  const handleEdit = useCallback((next: string) => {
    if (!activePath) return;
    // Anything under the SHARED branch (the synthetic root or a per-doc
    // sentinel) is read-only in MVP — drop save events. (DocEditor also
    // drops onChange when readOnly is set; this is belt-and-suspenders.)
    if (activePath.startsWith(SHARED_PREFIX)) return;
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
          {canSync && (
            <div className="connect-section">
              <span className="pat-label">Cloud Account</span>
              {cloudUserId ? (
                <>
                  <code className="pat-value connect-cmd" title={cloudUserId}>
                    {cloudUserId.length > 28 ? cloudUserId.slice(0, 28) + "…" : cloudUserId}
                  </code>
                  <button
                    className={`signin-btn${conflicts.length > 0 ? " has-conflicts" : ""}`}
                    onClick={() => (conflicts.length > 0 ? setConflictModalOpen(true) : handleSync(false))}
                    disabled={syncState === "syncing"}
                    type="button"
                  >
                    {syncState === "syncing"
                      ? "Syncing…"
                      : syncState === "done"
                      ? "✓ Synced"
                      : syncState === "error"
                      ? "⚠ Sync failed"
                      : conflicts.length > 0
                      ? `${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}`
                      : "Push to Cloud"}
                  </button>
                  <button className="signin-btn" onClick={unlinkCloudAccount} type="button" style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" }}>
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <button className="signin-btn" onClick={linkCloudAccount} type="button">
                    Connect Cloud Account
                  </button>
                  <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
                    Required to push your local docs to the cloud
                  </span>
                </>
              )}
            </div>
          )}
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
          {isOwnNamespace && (
            <div className="connect-section">
              <span className="pat-label">Connect to Claude.ai</span>
              <div className="connect-cmd-row">
                <code className="pat-value connect-cmd" title={mcpUrl}>
                  {mcpUrl.length > 28 ? mcpUrl.slice(0, 28) + "…" : mcpUrl}
                </code>
                <button
                  className={`connect-copy-icon${mcpUrlCopied ? " copied" : ""}`}
                  onClick={copyMcpUrl}
                  type="button"
                  title="Copy Claude.ai connector URL"
                  aria-label="Copy Claude.ai connector URL"
                >
                  {mcpUrlCopied ? (
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
              <a
                href="https://claude.ai/settings/connectors"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", marginTop: 4 }}
              >
                Open Claude.ai connectors →
              </a>
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
              onClick={() => { setView(view === "log" ? "main" : "log"); setMobileSidebarOpen(false); }}
              data-active={view === "log"}
              type="button"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M6.5 3.5V6.5L8.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              History
            </button>
            {isSignedIn && (
              <button
                className="sidebar-footer-btn"
                onClick={() => signOut({ redirectUrl: "/" })}
                type="button"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M5 2H2.5C2.22386 2 2 2.22386 2 2.5V10.5C2 10.7761 2.22386 11 2.5 11H5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <path d="M8 4L10.5 6.5L8 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M10 6.5H5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Sign out
              </button>
            )}
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
        {view === "main" && (
          <div
            className="main-split"
            ref={splitContainerRef}
            data-graph-collapsed={graphCollapsed}
            style={{ "--graph-ratio": splitRatio } as React.CSSProperties}
          >
            <div className="graph-pane">
              {index && (
                <GraphView
                  index={index}
                  activePath={activePath}
                  onSelect={setActivePath}
                  onAddChild={isOwnNamespace ? openAddChild : undefined}
                  onAddAssociation={isOwnNamespace ? openAddAssoc : undefined}
                  onDeleteNode={isOwnNamespace ? openDeleteNode : undefined}
                  onShareNode={isOwnNamespace ? openShareNode : undefined}
                  onRenameNode={isOwnNamespace ? openRenameNode : undefined}
                />
              )}
            </div>
            <div
              className="split-divider"
              onPointerDown={onDividerPointerDown}
              data-dragging={draggingSplit}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panes"
            />
            <div className="doc-pane">
              <button
                className="graph-collapse-toggle"
                onClick={toggleGraphCollapsed}
                type="button"
                aria-expanded={!graphCollapsed}
              >
                {graphCollapsed ? "▼ Show graph" : "▲ Hide graph"}
              </button>
              {activeDoc ? (() => {
                const isSharedView = activePath?.startsWith(SHARED_PREFIX) ?? false;
                const isSharedDoc = !!activeSharedDoc;
                const displayPath = isSharedDoc
                  ? `${activeSharedDoc.ownerEmail ?? activeSharedDoc.ownerId.slice(0, 12)} / ${activeSharedDoc.path}`
                  : activeDoc.path;
                return (
                  <>
                    {isSharedDoc && (
                      <div className="shared-banner">
                        <span>📎</span>
                        <span>
                          Shared by <strong>{activeSharedDoc.ownerEmail ?? activeSharedDoc.ownerId.slice(0, 12)}</strong> — read-only
                        </span>
                      </div>
                    )}
                    <div className="toolbar">
                      <button onClick={() => setDocMode("rendered")} data-active={docMode === "rendered"}>Rendered</button>
                      {!isSharedView && (
                        <button onClick={() => setDocMode("raw")} data-active={docMode === "raw"}>Raw</button>
                      )}
                      <span className="doc-path">{displayPath}</span>
                      <span className="spacer" />
                      {!isSharedView && <span className="save-state">{labelFor(saveState)}</span>}
                      <button
                        className="btn-sibling-nav"
                        onClick={() => prevSibling && selectDoc(prevSibling.path)}
                        disabled={!prevSibling}
                        type="button"
                        title={prevSibling ? `← ${prevSibling.title}  [` : "No previous sibling  ["}
                      >
                        ← Prev
                      </button>
                      <button
                        className="btn-sibling-nav"
                        onClick={() => nextSibling && selectDoc(nextSibling.path)}
                        disabled={!nextSibling}
                        type="button"
                        title={nextSibling ? `${nextSibling.title} →  ]` : "No next sibling  ]"}
                      >
                        Next →
                      </button>
                      <button className="btn-export-pdf" onClick={exportPdf} type="button" title="Export as PDF">
                        Export PDF
                      </button>
                    </div>
                    <div className="editor-host">
                      <DocEditor
                        path={isSharedDoc ? `${activeSharedDoc.ownerId}:${activeDoc.path}` : activeDoc.path}
                        initialContent={activeDoc.content}
                        mode={isSharedView ? "rendered" : docMode}
                        onChange={handleEdit}
                        onWikiLinkClick={handleWikiLinkClick}
                        readOnly={isSharedView}
                      />
                    </div>
                  </>
                );
              })() : (
                <div className="empty">
                  <p>Select a doc from the sidebar or graph to view it here.</p>
                </div>
              )}
            </div>
          </div>
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

      {/* Rename modal */}
      {renameCtx && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setRenameCtx(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-title">Rename doc</p>
            <p className="modal-subtitle">
              Renames <strong>{renameCtx.focalTitle}</strong>, moves it to the new path, and updates every <code>[[wiki-link]]</code> pointing at it across the vault.
            </p>
            <div className="modal-field">
              <label className="modal-label" htmlFor="rename-title">New title</label>
              <input
                id="rename-title"
                className="modal-input"
                type="text"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitRename()}
                autoFocus
              />
            </div>
            <div className="modal-field">
              <label className="modal-label" htmlFor="rename-path">New path</label>
              <input
                id="rename-path"
                className="modal-input"
                type="text"
                value={renamePath}
                onChange={(e) => { setRenamePath(e.target.value); setRenamePathDirty(true); }}
                onKeyDown={(e) => e.key === "Enter" && submitRename()}
              />
            </div>
            {renameError && <p className="share-error" style={{ marginTop: 0 }}>{renameError}</p>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setRenameCtx(null)} type="button" disabled={renameBusy}>Cancel</button>
              <button
                className="btn-primary"
                onClick={submitRename}
                disabled={renameBusy || !renameTitle.trim() || !renamePath.trim()}
                type="button"
              >
                {renameBusy ? "Renaming…" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {shareCtx && (
        <ShareModal
          path={shareCtx.focalPath}
          title={shareCtx.focalTitle}
          onClose={() => { setShareCtx(null); refreshShared(); }}
        />
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
