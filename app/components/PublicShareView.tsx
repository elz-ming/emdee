"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GraphView } from "./GraphView";
import { DocEditor } from "./DocEditor";
import { DocTree, buildDocTree } from "./DocTree";
import type { DocIndex, DocNode } from "@/src/core/indexer";
import { getPrevNextSiblings } from "@/src/core/siblings";

interface Publication {
  id: string;
  handle: string;
  slug: string;
  root_doc_path: string;
  owner_email: string | null;
}

interface Props {
  publication: Publication;
  index: DocIndex;
  isSignedIn: boolean;
}

/**
 * Anonymous read view of a published subtree, rendered with the same App
 * shell the owner sees: sidebar tree, graph pane, doc pane, mobile drawer.
 * No edit / share / delete callbacks are wired up, so the graph action
 * bar shows nothing and the doc editor stays in read-only rendered mode.
 *
 * Sign-up CTAs surface in (a) the sidebar header where the Claude Code
 * connect block sits for owners, and (b) the mobile header top-right.
 */
export function PublicShareView({ publication, index, isSignedIn }: Props) {
  const [activePath, setActivePath] = useState<string>(publication.root_doc_path);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileDrawerState, setMobileDrawerState] = useState<"closed" | "peek" | "full">("closed");
  const viewLoggedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px), (orientation: portrait) and (max-width: 1024px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const docTree = useMemo(() => buildDocTree(index), [index]);
  const byPath = useMemo(() => {
    const m = new Map<string, DocNode>();
    for (const d of index.docs) m.set(d.path, d);
    return m;
  }, [index]);
  const byTitle = useMemo(() => {
    const m = new Map<string, DocNode>();
    for (const d of index.docs) m.set(d.title.toLowerCase(), d);
    return m;
  }, [index]);

  const activeDoc = byPath.get(activePath) ?? null;

  const logEvent = useCallback(
    (eventType: string, docPath?: string) => {
      fetch("/api/publication-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publication_id: publication.id,
          event_type: eventType,
          doc_path: docPath ?? null,
          referrer: typeof document !== "undefined" ? document.referrer || null : null,
        }),
        keepalive: true,
      }).catch(() => {});
    },
    [publication.id]
  );

  useEffect(() => {
    if (viewLoggedRef.current) return;
    viewLoggedRef.current = true;
    logEvent("view");
  }, [logEvent]);

  const selectDoc = useCallback(
    (path: string) => {
      setActivePath((cur) => {
        if (cur !== path && path !== publication.root_doc_path) {
          logEvent("doc_open", path);
        }
        return path;
      });
      setMobileSidebarOpen(false);
    },
    [logEvent, publication.root_doc_path]
  );

  const onGraphSelect = useCallback(
    (path: string) => {
      selectDoc(path);
      setMobileDrawerState((cur) => (isMobile && cur === "closed" ? "peek" : cur));
    },
    [isMobile, selectDoc]
  );

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleWikiLinkClick = useCallback(
    (title: string) => {
      const doc = byTitle.get(title.toLowerCase());
      if (doc) selectDoc(doc.path);
    },
    [byTitle, selectDoc]
  );

  const { prevSibling, nextSibling } = useMemo<{
    prevSibling: DocNode | null;
    nextSibling: DocNode | null;
  }>(() => {
    if (!activeDoc) return { prevSibling: null, nextSibling: null };
    const { prevPath, nextPath } = getPrevNextSiblings(index, activeDoc.path);
    return {
      prevSibling: prevPath ? byPath.get(prevPath) ?? null : null,
      nextSibling: nextPath ? byPath.get(nextPath) ?? null : null,
    };
  }, [activeDoc, index, byPath]);

  const onSignupClick = useCallback(() => {
    logEvent("signup_click");
    window.location.href = `/sign-up?ref=${encodeURIComponent(`${publication.handle}/${publication.slug}`)}`;
  }, [logEvent, publication.handle, publication.slug]);

  const onSubscribeClick = useCallback(() => {
    logEvent("subscribe_click");
    alert(
      "Subscribe is coming soon — saving this vault to your own VAULT > SHARED so your AI can read it too. We logged your interest; you'll get an email when it ships."
    );
  }, [logEvent]);

  // Direct PDF download via html2pdf.js (same library + options as the
  // owner-side Export PDF). Targets the rendered preview DOM.
  const exportPdf = useCallback(async () => {
    if (!activeDoc) return;
    await new Promise((r) => setTimeout(r, 60));
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

  return (
    <div className="app" data-public-share="true">
      {/* Mobile header — hamburger + brand + sign-up CTA */}
      <header className="mobile-header">
        <button
          className="mobile-hamburger"
          aria-label="Open sidebar"
          onClick={() => setMobileSidebarOpen((v) => !v)}
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <Link href="/" className="mobile-title">EMDEE</Link>
        <button
          className="public-share-mobile-cta"
          onClick={isSignedIn ? onSubscribeClick : onSignupClick}
          type="button"
        >
          {isSignedIn ? "Save" : "Sign up"}
        </button>
      </header>

      <div
        className="sidebar-backdrop"
        data-open={mobileSidebarOpen}
        onClick={() => setMobileSidebarOpen(false)}
      />

      <div className="sidebar-wrap" data-open={mobileSidebarOpen}>
        <aside className="sidebar" data-collapsed={sidebarCollapsed}>
          {/* Brand block where the Claude-Code connect section lives for owners */}
          <div className="public-share-sidebar-brand">
            <Link href="/" className="public-share-logo">
              <span className="public-share-logo-dot" />
              EMDEE
            </Link>
            <div className="public-share-sidebar-attrib">
              <span className="public-share-attrib-owner">{publication.handle}</span>
              <span className="public-share-attrib-sep">/</span>
              <span className="public-share-attrib-slug">{publication.slug}</span>
            </div>
            <p className="public-share-sidebar-pitch">
              A published knowledge graph. Click any node to read.
            </p>
            <button
              type="button"
              className="public-share-sidebar-cta"
              onClick={isSignedIn ? onSubscribeClick : onSignupClick}
            >
              {isSignedIn ? "Save to my vault →" : "Get your own vault →"}
            </button>
            <p className="public-share-sidebar-foot">
              {isSignedIn
                ? "Subscribe to keep this vault visible to your AI."
                : "Free to sign up. Your notes, your graph, your AI's context."}
            </p>
          </div>

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
        <div
          className="main-split"
          data-graph-collapsed={false}
          data-mobile-drawer={mobileDrawerState}
          style={{ "--graph-ratio": 0.5 } as React.CSSProperties}
        >
          <div className="graph-pane">
            <GraphView
              index={index}
              activePath={activePath}
              onSelect={onGraphSelect}
              prevSibling={prevSibling}
              nextSibling={nextSibling}
              forceBranchLayout
            />
          </div>
          <div className="split-divider" role="separator" aria-orientation="vertical" />
          <div className="doc-pane">
            {/* Mobile drawer header */}
            <div className="mobile-drawer-header" aria-hidden={!isMobile}>
              <button
                type="button"
                className="mobile-drawer-handle"
                onClick={() =>
                  setMobileDrawerState((s) =>
                    s === "full" ? "peek" : s === "peek" ? "closed" : "closed"
                  )
                }
                aria-label="Lower drawer"
              >
                <span className="mobile-drawer-handle-bar" />
              </button>
              <div className="mobile-drawer-title">{activeDoc?.title ?? "Doc"}</div>
              <button
                type="button"
                className="mobile-drawer-close"
                onClick={() => setMobileDrawerState("closed")}
                aria-label="Close drawer"
              >
                ×
              </button>
            </div>

            {activeDoc ? (
              <>
                <div className="toolbar">
                  <span className="doc-path">{activeDoc.path}</span>
                  <span className="spacer" />
                  <button
                    className="btn-sibling-nav"
                    onClick={() => prevSibling && selectDoc(prevSibling.path)}
                    disabled={!prevSibling}
                    type="button"
                    title={prevSibling ? `← ${prevSibling.title}` : "No previous sibling"}
                  >
                    ← Prev
                  </button>
                  <button
                    className="btn-sibling-nav"
                    onClick={() => nextSibling && selectDoc(nextSibling.path)}
                    disabled={!nextSibling}
                    type="button"
                    title={nextSibling ? `${nextSibling.title} →` : "No next sibling"}
                  >
                    Next →
                  </button>
                  <button className="btn-export-pdf" onClick={exportPdf} type="button" title="Export as PDF">
                    Export PDF
                  </button>
                </div>
                <div className="editor-host" data-mode="rendered">
                  <DocEditor
                    path={`__public__:${activeDoc.path}`}
                    initialContent={activeDoc.content}
                    mode="rendered"
                    onChange={() => {}}
                    onWikiLinkClick={handleWikiLinkClick}
                    readOnly
                  />
                </div>
              </>
            ) : (
              <div className="empty">Pick a node from the graph to start reading.</div>
            )}
          </div>
        </div>
      </main>

      {/* Mobile FAB — pulls drawer to full state when closed */}
      {isMobile && mobileDrawerState === "closed" && activeDoc && (
        <button
          type="button"
          className="mobile-drawer-fab"
          onClick={() => setMobileDrawerState("full")}
        >
          <span className="mobile-drawer-fab-arrow" aria-hidden="true">↑</span>
          <span className="mobile-drawer-fab-label">{activeDoc.title}</span>
        </button>
      )}
    </div>
  );
}
