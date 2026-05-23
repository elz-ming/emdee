"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { GraphView } from "./GraphView";
import { DocEditor } from "./DocEditor";
import { ShareModal } from "./ShareModal";
import { DownloadModal } from "./DownloadModal";
import { DocTree, buildDocTree, type TreeNode } from "./DocTree";
import type { DocIndex, DocNode } from "@/src/core/indexer";
import { getPrevNextSiblings } from "@/src/core/siblings";
import { resolveWikiLink } from "@/src/core/resolveLink";
import { useDrawerDrag } from "./useDrawerDrag";
import { useDocsChanged } from "./useDocsChanged";
import { useDocLog } from "./useDocLog";
import { useMcpActivity, type McpActivityEvent } from "./useMcpActivity";

interface SharedDocItem {
  shareId: string;
  path: string;
  title: string;
  content: string;
}

interface SharedShare {
  ownerId: string;
  ownerEmail: string | null;
  shareRoot: string;
  permission: "read" | "write";
  docs: SharedDocItem[];
  edges: { from: string; to: string }[];
}

// Flattened view used by the editor — one row per shared doc with the
// share-level metadata copied in for convenience.
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
const sharedActiveKey = (ownerId: string, path: string) => `${SHARED_PREFIX}${ownerId}:${path}`;


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
  // Mobile drawer for the doc pane. Three states: closed (graph full,
  // FAB visible), peek (drawer shows title + summary blockquote, ~32svh),
  // full (drawer covers ~90svh, scrollable). Tapping a node bumps closed
  // → peek so the user never needs two taps to see the content.
  const [isMobile, setIsMobile] = useState(false);
  const [mobileDrawerState, setMobileDrawerState] = useState<"closed" | "peek" | "full">("closed");
  const docPaneRef = useRef<HTMLDivElement | null>(null);
  const drawerDrag = useDrawerDrag({
    drawerRef: docPaneRef,
    state: mobileDrawerState,
    setState: setMobileDrawerState,
  });
  const [canSync, setCanSync] = useState(false);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [llmPromptCopied, setLlmPromptCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Track viewport — drives whether the doc-pane renders as a fixed-bottom
  // drawer or the side-by-side split. Mirrors the mobile media query.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px), (orientation: portrait) and (max-width: 1024px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
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
  const [downloadCtx, setDownloadCtx] = useState<GraphModalContext | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sharedShares, setSharedShares] = useState<SharedShare[]>([]);
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
      setSharedShares([]);
      return;
    }
    fetch("/api/shared")
      .then((r) => r.json())
      .then((d) => setSharedShares(d.shares ?? []))
      .catch(() => setSharedShares([]));
  }, [isOwnNamespace]);
  useEffect(() => { refreshShared(); }, [refreshShared]);

  // is_admin is fetched once on mount for signed-in owners — gates the
  // Admin link in the sidebar footer. /api/publish GET returns it as a
  // free byproduct of the profile lookup that already powers the
  // publications list.
  useEffect(() => {
    if (!isOwnNamespace) {
      setIsAdmin(false);
      return;
    }
    fetch("/api/publish", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setIsAdmin(!!d?.is_admin))
      .catch(() => setIsAdmin(false));
  }, [isOwnNamespace]);

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

  // SPRINT-021: live MCP-activity pulse on the graph. Only owners
  // subscribe — the SSE route returns an empty stream for non-owners
  // anyway, but skipping the EventSource avoids a needless reconnect
  // loop on the public-vault view.
  //
  // We push events into a ref-queue + bump a counter so bursty multi-
  // event ticks (e.g. split_doc emitting several writes) don't collapse
  // into a single render. GraphView drains the queue on each counter
  // bump. The counter alone would re-render constantly; the queue alone
  // would never trigger an effect — both together preserve every pulse.
  const activityQueueRef = useRef<McpActivityEvent[]>([]);
  const [activityTick, setActivityTick] = useState(0);
  const handleActivity = useCallback((e: McpActivityEvent) => {
    activityQueueRef.current.push(e);
    setActivityTick((t) => t + 1);
  }, []);
  useMcpActivity(isOwnNamespace ? namespace : "", handleActivity);

  // Flatten shared shares into a per-doc lookup keyed by activation path
  // (`__shared:<ownerId>:<path>`). Used by activeSharedDoc + the synthetic
  // doc tree below.
  const sharedDocsByKey = useMemo<Map<string, SharedDoc>>(() => {
    const m = new Map<string, SharedDoc>();
    for (const s of sharedShares) {
      for (const d of s.docs) {
        m.set(sharedActiveKey(s.ownerId, d.path), {
          shareId: d.shareId,
          ownerId: s.ownerId,
          ownerEmail: s.ownerEmail,
          path: d.path,
          title: d.title,
          content: d.content,
          permission: s.permission,
        });
      }
    }
    return m;
  }, [sharedShares]);

  const activeSharedDoc = useMemo<SharedDoc | null>(() => {
    if (!activePath || !activePath.startsWith(SHARED_PREFIX)) return null;
    return sharedDocsByKey.get(activePath) ?? null;
  }, [activePath, sharedDocsByKey]);

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

  // Prev/Next sibling for the active doc — shared helper so the renderer,
  // the graph view, and the get_neighbors MCP tool all derive the same
  // sequence. Tolerant of asymmetric edges: a doc that declares
  // `Child of [parent]` but isn't listed in the parent's `Parent of` still
  // gets siblings (declared first, asymmetric appended alphabetically).
  const { prevSibling, nextSibling } = useMemo<{
    prevSibling: DocNode | null;
    nextSibling: DocNode | null;
  }>(() => {
    if (!activeDoc || !index || activePath?.startsWith(SHARED_PREFIX)) {
      return { prevSibling: null, nextSibling: null };
    }
    const { prevPath, nextPath } = getPrevNextSiblings(index, activeDoc.path);
    const byPath = new Map(index.docs.map((d) => [d.path, d]));
    return {
      prevSibling: prevPath ? byPath.get(prevPath) ?? null : null,
      nextSibling: nextPath ? byPath.get(nextPath) ?? null : null,
    };
  }, [activeDoc, activePath, index]);

  const rawDocTree = useMemo(
    () => (index ? buildDocTree(index) : []),
    [index]
  );

  // SHARED.md is a real doc seeded into every vault (see
  // scripts/seed-shared-doc.mjs) — the indexer puts it under VAULT
  // naturally. Here we attach synthetic children to it: one branch per
  // share group, rooted at the owner's share_root and rebuilding the
  // owner-side hierarchy from the edges we fetched. Each node carries the
  // "__shared:<owner>:<path>" sentinel so the doc pane resolves content
  // from the right owner namespace.
  const docTree = useMemo<TreeNode[]>(() => {
    if (sharedShares.length === 0) return rawDocTree;

    const buildShareTree = (s: SharedShare): TreeNode | null => {
      const docByPath = new Map(s.docs.map((d) => [d.path, d]));
      const childrenOf = new Map<string, string[]>();
      const hasParent = new Set<string>();
      for (const e of s.edges) {
        if (!docByPath.has(e.from) || !docByPath.has(e.to)) continue;
        const arr = childrenOf.get(e.from) ?? [];
        arr.push(e.to);
        childrenOf.set(e.from, arr);
        hasParent.add(e.to);
      }

      const visited = new Set<string>();
      const walk = (p: string): TreeNode | null => {
        if (visited.has(p)) return null;
        visited.add(p);
        const d = docByPath.get(p);
        if (!d) return null;
        const childPaths = (childrenOf.get(p) ?? []).slice().sort((a, b) => {
          const ta = docByPath.get(a)?.title ?? a;
          const tb = docByPath.get(b)?.title ?? b;
          return ta.localeCompare(tb);
        });
        const children = childPaths
          .map(walk)
          .filter((n): n is TreeNode => n !== null);
        return {
          doc: {
            path: sharedActiveKey(s.ownerId, d.path),
            title: d.title,
            content: d.content,
            summary: "",
            parents: [],
            children: [],
            associates: [],
            mentions: [],
          },
          depth: 0,
          children,
        };
      };

      // Prefer the declared share root; if it's missing (descendants-only
      // share), fall back to any doc without a parent within the group.
      const rootPath = docByPath.has(s.shareRoot)
        ? s.shareRoot
        : s.docs.map((d) => d.path).find((p) => !hasParent.has(p)) ?? null;
      const root = rootPath ? walk(rootPath) : null;

      // Catch any docs the edges didn't cover (asymmetric data) so nothing
      // silently disappears — they get appended as siblings of the root.
      const orphans: TreeNode[] = [];
      for (const d of s.docs) {
        if (visited.has(d.path)) continue;
        orphans.push({
          doc: {
            path: sharedActiveKey(s.ownerId, d.path),
            title: d.title,
            content: d.content,
            summary: "",
            parents: [],
            children: [],
            associates: [],
            mentions: [],
          },
          depth: 0,
          children: [],
        });
        visited.add(d.path);
      }
      if (root) {
        if (orphans.length > 0) root.children = [...root.children, ...orphans];
        return root;
      }
      // No root at all (degenerate) — fall back to a flat list.
      return orphans.length > 0
        ? { ...orphans[0], children: orphans.slice(1) }
        : null;
    };

    const sharedChildren = sharedShares
      .map(buildShareTree)
      .filter((n): n is TreeNode => n !== null);

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
  }, [rawDocTree, sharedShares]);

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
    if (sharedShares.length === 0) return;
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
  }, [sharedShares, rawDocTree]);

  // Sidebar click sets the active path but preserves the current view —
  // in graph view it navigates the graph focus, in doc view it loads the doc.
  // Explicit Docs/Graph buttons (and "Open doc" inside the graph) switch views.
  const selectDoc = useCallback((p: string) => {
    setActivePath(p);
    setView("main");
    setMobileSidebarOpen(false);
  }, []);

  // Graph-node taps on mobile auto-open the drawer to peek so the user
  // doesn't need a second action to see the content. If the drawer is
  // already peek/full, just change focus — preserves "skim multiple
  // nodes while reading" once the drawer is up.
  const onGraphSelect = useCallback((p: string) => {
    setActivePath(p);
    setMobileDrawerState((cur) => (isMobile && cur === "closed" ? "peek" : cur));
  }, [isMobile]);

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

  const save = useCallback(async (path: string, content: string, opts?: { ns?: string; skipIndexUpdate?: boolean }) => {
    const targetNs = opts?.ns ?? namespace;
    const shouldLog = !loggedInSession.current.has(path);
    const previousContent = shouldLog
      ? (prevContentRef.current.get(path) ?? indexRef.current?.docs.find(d => d.path === path)?.content)
      : undefined;
    setSaveState("saving");
    try {
      localEdit.current = true;
      const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}&ns=${encodeURIComponent(targetNs)}`, {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: content,
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveState("saved");
      // Splice the new content into local state so navigating away and
      // back doesn't show stale (pre-edit) content. Shared docs live in
      // sharedShares (owner namespace, off-vault), everything else in the
      // user's own index.
      if (opts?.ns && opts.ns !== namespace) {
        setSharedShares((cur) =>
          cur.map((s) =>
            s.ownerId === opts.ns
              ? { ...s, docs: s.docs.map((d) => (d.path === path ? { ...d, content } : d)) }
              : s
          )
        );
      } else {
        setIndex((cur) =>
          cur
            ? {
                ...cur,
                docs: cur.docs.map((d) => (d.path === path ? { ...d, content } : d)),
              }
            : cur
        );
      }
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

  const openDownloadNode = useCallback((focalPath: string, focalTitle: string) => {
    setDownloadCtx({ focalPath, focalTitle });
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
    if (!index) return;
    // Pass the currently-viewed doc as the link origin so ambiguous
    // targets (e.g. two DAY1s in different folders) resolve to the
    // candidate closest to where the user is reading from.
    const fromPath = activeSharedDoc?.path ?? activePath ?? undefined;
    const match = resolveWikiLink(index, title, fromPath);
    if (match) selectDoc(match.path);
  }, [index, selectDoc, activePath, activeSharedDoc]);

  // PDF export — flips to rendered mode, captures the markdown preview
  // DOM via html2pdf.js, and triggers a direct download of "<title>.pdf".
  // No browser print dialog. Dynamic import keeps the ~200KB lib out of
  // the initial bundle; only loaded when the user hits Export.
  const exportPdf = useCallback(async () => {
    if (!activeDoc) return;
    setDocMode("rendered");
    // Wait a frame for the editor to re-layout in rendered mode.
    await new Promise((r) => setTimeout(r, 150));
    const previewEl = document.querySelector<HTMLElement>(".toastui-editor-md-preview");
    if (!previewEl) return;
    const safeFilename =
      (activeDoc.title || "doc").replace(/[/\\:*?"<>|]/g, "_").trim() || "doc";
    try {
      const html2pdf = (await import("html2pdf.js")).default;
      await html2pdf()
        .set({
          margin: [12, 14, 14, 14],
          filename: `${safeFilename}.pdf`,
          image: { type: "jpeg", quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"] },
        })
        .from(previewEl)
        .save();
    } catch (e) {
      console.error("PDF export failed:", e);
    }
  }, [activeDoc]);

  // Copy a ready-made LLM prompt that points Claude/ChatGPT at this doc
  // via the EMDEE MCP. Ends with "Then:" + blank lines so the cursor
  // lands where the user types their actual request.
  //
  // When the focal is a doc shared INTO this vault (subscriber side),
  // the MCP serves it at __shared__/<ownerId>/<owner-side-path>. Using
  // that path in the prompt lets the recipient's LLM read collaborator
  // content the same way as their own docs.
  const copyLlmPrompt = useCallback(() => {
    if (!activeDoc) return;
    const pathForPrompt = activeSharedDoc
      ? `__shared__/${activeSharedDoc.ownerId}/${activeSharedDoc.path}`
      : activeDoc.path;
    const prompt =
      `Use the EMDEE MCP to load ${pathForPrompt} and its directly related nodes ` +
      `(parents, children, associates) so you have the full context.\n\nThen:\n\n`;
    navigator.clipboard.writeText(prompt).then(() => {
      setLlmPromptCopied(true);
      window.setTimeout(() => setLlmPromptCopied(false), 2000);
    });
  }, [activeDoc, activeSharedDoc]);

  const handleEdit = useCallback((next: string) => {
    if (!activePath) return;
    // Shared-branch writes are routed to the owner's namespace when the
    // grantee has write permission; read-only shares (and the synthetic
    // SHARED root itself) drop the save event. (DocEditor also drops
    // onChange when readOnly is set; this is belt-and-suspenders.)
    if (activePath.startsWith(SHARED_PREFIX)) {
      if (!activeSharedDoc || activeSharedDoc.permission !== "write") return;
      setSaveState("dirty");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      const ownerNs = activeSharedDoc.ownerId;
      const ownerPath = activeSharedDoc.path;
      saveTimer.current = window.setTimeout(() => save(ownerPath, next, { ns: ownerNs }), 600);
      return;
    }
    setSaveState("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(activePath, next), 600);
  }, [activePath, save, activeSharedDoc]);

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
            {isAdmin && (
              <a
                className="sidebar-footer-btn"
                href="/admin/publications"
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M6.5 1.5L10.5 3V6.5C10.5 8.5 8.7 10.4 6.5 11C4.3 10.4 2.5 8.5 2.5 6.5V3L6.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                  <path d="M5 6.5L6 7.5L8.5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Admin
              </a>
            )}
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
            data-mobile-drawer={mobileDrawerState}
            style={{ "--graph-ratio": splitRatio } as React.CSSProperties}
          >
            <div className="graph-pane">
              {index && (
                <GraphView
                  index={index}
                  activePath={activePath}
                  onSelect={onGraphSelect}
                  onAddChild={isOwnNamespace ? openAddChild : undefined}
                  onAddAssociation={isOwnNamespace ? openAddAssoc : undefined}
                  onDeleteNode={isOwnNamespace ? openDeleteNode : undefined}
                  onShareNode={isOwnNamespace ? openShareNode : undefined}
                  onDownloadNode={isOwnNamespace ? openDownloadNode : undefined}
                  onRenameNode={isOwnNamespace ? openRenameNode : undefined}
                  prevSibling={prevSibling}
                  nextSibling={nextSibling}
                  activityQueue={activityQueueRef.current}
                  activityTick={activityTick}
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
            <div className="doc-pane" ref={docPaneRef}>
              <button
                className="graph-collapse-toggle"
                onClick={toggleGraphCollapsed}
                type="button"
                aria-expanded={!graphCollapsed}
              >
                {graphCollapsed ? "▼ Show graph" : "▲ Hide graph"}
              </button>
              {/* Mobile drawer header — drag to flick between closed / peek /
                  full. The × button still works as an explicit close. The
                  whole bar is the drag target except the close button. */}
              <div
                className="mobile-drawer-header"
                aria-hidden={!isMobile}
                onPointerDown={drawerDrag.onPointerDown}
                onPointerMove={drawerDrag.onPointerMove}
                onPointerUp={drawerDrag.onPointerUp}
                onPointerCancel={drawerDrag.onPointerUp}
              >
                <span className="mobile-drawer-handle" aria-hidden="true">
                  <span className="mobile-drawer-handle-bar" />
                </span>
                <div className="mobile-drawer-title">
                  {activeDoc?.title ?? "Doc"}
                </div>
                <button
                  type="button"
                  className="mobile-drawer-close"
                  onClick={() => setMobileDrawerState("closed")}
                  aria-label="Close drawer"
                >
                  ×
                </button>
              </div>
              {activeDoc ? (() => {
                const isSharedView = activePath?.startsWith(SHARED_PREFIX) ?? false;
                const isSharedDoc = !!activeSharedDoc;
                // Synthetic SHARED branch nodes (the root and any non-doc
                // sentinels) have no underlying SharedDoc, so they stay
                // read-only. Real shared docs honour the granted permission.
                const isReadOnly = isSharedView && (!activeSharedDoc || activeSharedDoc.permission !== "write");
                const displayPath = isSharedDoc
                  ? `${activeSharedDoc.ownerEmail ?? activeSharedDoc.ownerId.slice(0, 12)} / ${activeSharedDoc.path}`
                  : activeDoc.path;
                return (
                  <>
                    {isSharedDoc && (
                      <div className="shared-banner">
                        <span>📎</span>
                        <span>
                          Shared by <strong>{activeSharedDoc.ownerEmail ?? activeSharedDoc.ownerId.slice(0, 12)}</strong>
                          {activeSharedDoc.permission === "write" ? " — you can edit" : " — read-only"}
                        </span>
                      </div>
                    )}
                    <div className="toolbar">
                      <button onClick={() => setDocMode("rendered")} data-active={docMode === "rendered"}>Rendered</button>
                      {!isReadOnly && (
                        <button onClick={() => setDocMode("raw")} data-active={docMode === "raw"}>Raw</button>
                      )}
                      <span className="doc-path">{displayPath}</span>
                      <span className="spacer" />
                      {!isReadOnly && <span className="save-state">{labelFor(saveState)}</span>}
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
                    <div className="llm-prompt-bar">
                      <span className="llm-prompt-hint">
                        {isSharedDoc
                          ? "Use this shared doc as context in Claude or ChatGPT"
                          : "Use this doc as context in Claude or ChatGPT"}
                      </span>
                      <button
                        type="button"
                        className="llm-prompt-copy"
                        onClick={copyLlmPrompt}
                        title="Copy a ready-made prompt that loads this doc + its neighbors via the EMDEE MCP"
                        data-copied={llmPromptCopied ? "true" : undefined}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="4" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                          <path d="M7 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                        </svg>
                        {llmPromptCopied ? "Copied" : "Copy LLM prompt"}
                      </button>
                    </div>
                    <div className="editor-host">
                      <DocEditor
                        path={isSharedDoc ? `${activeSharedDoc.ownerId}:${activeDoc.path}` : activeDoc.path}
                        initialContent={activeDoc.content}
                        mode={isReadOnly ? "rendered" : docMode}
                        onChange={handleEdit}
                        onWikiLinkClick={handleWikiLinkClick}
                        readOnly={isReadOnly}
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

      {/* Mobile drawer FAB — only renders on mobile when drawer is closed.
          Tapping it pulls the doc-pane up to full state. */}
      {isMobile && view === "main" && mobileDrawerState === "closed" && activeDoc && (
        <button
          type="button"
          className="mobile-drawer-fab"
          onClick={() => setMobileDrawerState("full")}
        >
          <span className="mobile-drawer-fab-arrow" aria-hidden="true">↑</span>
          <span className="mobile-drawer-fab-label">{activeDoc.title}</span>
        </button>
      )}

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
          index={index}
          onClose={() => { setShareCtx(null); refreshShared(); }}
        />
      )}

      {/* Download modal */}
      {downloadCtx && (
        <DownloadModal
          path={downloadCtx.focalPath}
          title={downloadCtx.focalTitle}
          index={index}
          onClose={() => setDownloadCtx(null)}
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
