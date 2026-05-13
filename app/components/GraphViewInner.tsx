"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { DocIndex, Edge } from "@/src/core/indexer";

export interface Props {
  index: DocIndex;
  activePath: string | null;
  onSelect: (path: string) => void;
  onAddChild?: (focalPath: string, focalTitle: string) => void;
  onAddAssociation?: (focalPath: string, focalTitle: string) => void;
  onDeleteNode?: (focalPath: string, focalTitle: string) => void;
}

const PAGE_SIZE = 8;
const LAYER2_PER_LAYER1 = 2;
const RADIUS_LAYER1 = 240;
const RADIUS_LAYER2 = 400;
const ANIM_MS = 500;

type Role = "parent" | "child" | "assoc";

type Category =
  | "emdee"
  | "vault"
  | "projects"
  | "people"
  | "hackathons"
  | "education"
  | "career"
  | "default";

interface Neighbor {
  id: string;
  role: Role;
  edge: Edge;
}

interface PlacedNode {
  id: string;
  label: string;
  kind: "focal" | "layer1" | "layer2";
  category: Category;
  position: { x: number; y: number };
}

interface PlacedEdge {
  id: string;
  source: string;
  target: string;
  kind: "hierarchy" | "assoc";
  role: Role;
  targetCategory: Category;
  showLabel: boolean;
}

const ROLE_LABEL: Record<Role, string> = {
  parent: "Child of",
  child: "Parent of",
  assoc: "Associated",
};

// Category palette. Base = node border + assoc edges. Hier = hierarchy edges
// (darker variant of base). Fill = soft tint for node interior so labels stay
// readable. Picked from Tailwind 500/600/100 ramps; reasonably colorblind-safe.
const CATEGORY_BASE: Record<Category, string> = {
  emdee: "#4f46e5",
  vault: "#64748b",
  projects: "#3b82f6",
  people: "#10b981",
  hackathons: "#f59e0b",
  education: "#8b5cf6",
  career: "#06b6d4",
  default: "#9ca3af",
};

const CATEGORY_HIER: Record<Category, string> = {
  emdee: "#4338ca",
  vault: "#475569",
  projects: "#2563eb",
  people: "#059669",
  hackathons: "#d97706",
  education: "#7c3aed",
  career: "#0891b2",
  default: "#6b7280",
};

const CATEGORY_FILL: Record<Category, string> = {
  emdee: "#e0e7ff",
  vault: "#e2e8f0",
  projects: "#dbeafe",
  people: "#d1fae5",
  hackathons: "#fef3c7",
  education: "#ede9fe",
  career: "#cffafe",
  default: "#f3f4f6",
};

const CATEGORY_LABEL: Record<Category, string> = {
  emdee: "Emdee",
  vault: "Vault",
  projects: "Projects",
  people: "People",
  hackathons: "Hackathons",
  education: "Education",
  career: "Career",
  default: "Other",
};

// Path-based category detection. Pillars are detected by their root anchor
// filename or by their folder prefix; tier files inherit the parent pillar.
function categoryFor(rawPath: string): Category {
  const p = rawPath.toLowerCase();
  if (p === "emdee.md") return "emdee";
  if (
    p === "vault.md" ||
    p === "info.md" ||
    p === "instructions.md" ||
    p === "brain.md" ||
    p === "workflows.md" ||
    p === "sample.md"
  )
    return "vault";
  if (p.startsWith("sample/") || p.startsWith("workflows/")) return "vault";
  if (p === "projects.md" || p.startsWith("projects/")) return "projects";
  if (p === "people.md" || p.startsWith("people/")) return "people";
  if (p === "hackathons.md" || p.startsWith("hackathons/")) return "hackathons";
  if (p === "education.md" || p.startsWith("education/")) return "education";
  if (p === "career.md" || p.startsWith("career/")) return "career";
  return "default";
}

function neighborsOf(index: DocIndex, focal: string): Neighbor[] {
  const seen = new Map<string, Neighbor>();
  for (const e of index.edges) {
    if (e.kind === "hierarchy") {
      if (e.from === focal && !seen.has(e.to)) seen.set(e.to, { id: e.to, role: "child", edge: e });
      if (e.to === focal && !seen.has(e.from)) seen.set(e.from, { id: e.from, role: "parent", edge: e });
    } else {
      const other = e.from === focal ? e.to : e.to === focal ? e.from : null;
      if (other && !seen.has(other)) seen.set(other, { id: other, role: "assoc", edge: e });
    }
  }
  return [...seen.values()].sort((a, b) => {
    const order: Record<Role, number> = { parent: 0, child: 1, assoc: 2 };
    if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
    return a.id.localeCompare(b.id);
  });
}

function placeLayout(
  index: DocIndex,
  focalId: string,
  page: number
): { nodes: PlacedNode[]; edges: PlacedEdge[]; totalLayer1: number } {
  const titleFor = (p: string) => index.docs.find((d) => d.path === p)?.title ?? p;
  const focalTitle = titleFor(focalId);
  const shortLabel = (p: string) => {
    const t = titleFor(p);
    const prefix = focalTitle + " — ";
    return t.startsWith(prefix) ? t.slice(prefix.length) : t;
  };

  const allLayer1 = neighborsOf(index, focalId);
  const totalLayer1 = allLayer1.length;
  const start = page * PAGE_SIZE;
  const layer1 = allLayer1.slice(start, start + PAGE_SIZE);

  const placed = new Map<string, PlacedNode>();
  placed.set(focalId, {
    id: focalId,
    label: titleFor(focalId),
    kind: "focal",
    category: categoryFor(focalId),
    position: { x: 0, y: 0 },
  });

  const layer1AnglesById = new Map<string, number>();
  layer1.forEach((n, i) => {
    const angle = (i / Math.max(layer1.length, 1)) * Math.PI * 2 - Math.PI / 2;
    layer1AnglesById.set(n.id, angle);
    placed.set(n.id, {
      id: n.id,
      label: shortLabel(n.id),
      kind: "layer1",
      category: categoryFor(n.id),
      position: { x: Math.cos(angle) * RADIUS_LAYER1, y: Math.sin(angle) * RADIUS_LAYER1 },
    });
  });

  const reservedIds = new Set<string>([focalId, ...layer1.map((n) => n.id)]);
  const edges: PlacedEdge[] = [];
  const layer2Pairs: { layer1Id: string; neighbor: Neighbor }[] = [];

  for (const l1 of layer1) {
    edges.push({
      id: `e:${focalId}|${l1.id}`,
      source: l1.role === "parent" ? l1.id : focalId,
      target: l1.role === "parent" ? focalId : l1.id,
      kind: l1.role === "assoc" ? "assoc" : "hierarchy",
      role: l1.role,
      // Edge color always reflects the outer (non-focal) node's category, so
      // when looking at a focal you see its neighbors' types painted onto the
      // edges that connect them.
      targetCategory: categoryFor(l1.id),
      showLabel: true,
    });

    // Layer-2 rule: never show "Child of" relationships (role === "parent" from
    // the layer-1's view), and prioritize "Parent of" (role === "child") over
    // "Associated with" (role === "assoc"). neighborsOf already returns
    // parent → child → assoc; after filtering parents out, child comes first.
    const candidates = neighborsOf(index, l1.id)
      .filter((n) => !reservedIds.has(n.id))
      .filter((n) => n.role !== "parent");
    let added = 0;
    for (const cand of candidates) {
      if (added >= LAYER2_PER_LAYER1) break;
      if (placed.has(cand.id)) continue;
      reservedIds.add(cand.id);
      layer2Pairs.push({ layer1Id: l1.id, neighbor: cand });
      added++;
    }
  }

  // Place layer-2 around their parent layer-1 angle
  const offsetSpread = Math.PI / 13; // ~14° between the two layer-2 sprouts
  const groupedByL1 = new Map<string, Neighbor[]>();
  for (const { layer1Id, neighbor } of layer2Pairs) {
    const arr = groupedByL1.get(layer1Id) ?? [];
    arr.push(neighbor);
    groupedByL1.set(layer1Id, arr);
  }

  for (const [l1Id, neighbors] of groupedByL1) {
    const baseAngle = layer1AnglesById.get(l1Id)!;
    neighbors.forEach((n, i) => {
      const offset =
        neighbors.length === 1
          ? 0
          : i === 0
          ? -offsetSpread
          : offsetSpread;
      const angle = baseAngle + offset;
      placed.set(n.id, {
        id: n.id,
        label: shortLabel(n.id),
        kind: "layer2",
        category: categoryFor(n.id),
        position: { x: Math.cos(angle) * RADIUS_LAYER2, y: Math.sin(angle) * RADIUS_LAYER2 },
      });
      edges.push({
        id: `e:${l1Id}:${n.id}`,
        source: n.role === "parent" ? n.id : l1Id,
        target: n.role === "parent" ? l1Id : n.id,
        kind: n.role === "assoc" ? "assoc" : "hierarchy",
        role: n.role,
        // Edge color = the deeper (layer-2) node's category.
        targetCategory: categoryFor(n.id),
        showLabel: false,
      });
    });
  }

  return { nodes: [...placed.values()], edges, totalLayer1 };
}

function syncGraph(
  cy: cytoscape.Core,
  layout: { nodes: PlacedNode[]; edges: PlacedEdge[] }
) {
  const desiredNodeIds = new Set(layout.nodes.map((n) => n.id));

  // Remove ALL edges — they're cheap and they auto-follow node positions, so
  // there's no point trying to diff them. Diffing was buggy because edge IDs
  // built from a "focal" placeholder collided across focus changes.
  cy.edges().remove();

  // Fade out + remove vanishing nodes
  cy.nodes().forEach((n) => {
    if (!desiredNodeIds.has(n.id())) {
      n.animate(
        { style: { opacity: 0 } },
        { duration: ANIM_MS / 2, complete: () => n.remove() }
      );
    }
  });

  // Add or update nodes
  for (const nd of layout.nodes) {
    let node = cy.getElementById(nd.id);
    if (node.empty()) {
      // place the new node at the focal position so it appears to "fly out"
      const focal = layout.nodes.find((x) => x.kind === "focal");
      const startPos = focal ? focal.position : nd.position;
      node = cy.add({
        group: "nodes",
        data: { id: nd.id, label: nd.label, kind: nd.kind, category: nd.category },
        position: { ...startPos },
      });
      node.style("opacity", 0);
      node.animate(
        { position: nd.position, style: { opacity: 1 } },
        { duration: ANIM_MS, easing: "ease-out" }
      );
    } else {
      node.data("kind", nd.kind);
      node.data("label", nd.label);
      node.data("category", nd.category);
      node.animate(
        { position: nd.position, style: { opacity: 1 } },
        { duration: ANIM_MS, easing: "ease-in-out" }
      );
    }
  }

  // Add fresh edges
  for (const ed of layout.edges) {
    cy.add({
      group: "edges",
      data: {
        id: ed.id,
        source: ed.source,
        target: ed.target,
        kind: ed.kind,
        role: ed.role,
        targetCategory: ed.targetCategory,
        label: ed.showLabel ? ROLE_LABEL[ed.role] : "",
      },
    });
  }

  // Re-center on the focal node's TARGET world position, not its current
  // position. The focal node has just been queued to animate to (0, 0); using
  // cy.center on the live element would read its old (pre-animation) position
  // and pan there instead — which broke layer-2 clicks because the new focal
  // started at the outer ring.
  const focalNode = layout.nodes.find((n) => n.kind === "focal");
  if (focalNode) {
    const w = cy.width();
    const h = cy.height();
    const z = cy.zoom();
    cy.animate(
      {
        pan: {
          x: w / 2 - focalNode.position.x * z,
          y: h / 2 - focalNode.position.y * z,
        },
      },
      { duration: ANIM_MS, easing: "ease-out" }
    );
  }
}

export function GraphViewInner({ index, activePath, onSelect, onAddChild, onAddAssociation, onDeleteNode }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const focalIdRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Prefer the doc the user was just looking at; fall back to the vault entry.
  const initialFocal =
    (activePath && index.docs.some((d) => d.path === activePath) ? activePath : null) ??
    index.entry ??
    index.docs[0]?.path ??
    null;
  const [focalId, setFocalId] = useState<string | null>(initialFocal);
  const [page, setPage] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  focalIdRef.current = focalId;

  // Reset focal if the active doc disappears from the index
  useEffect(() => {
    if (!focalId || !index.docs.some((d) => d.path === focalId)) {
      setFocalId(initialFocal);
      setPage(0);
      setHistory([]);
    }
  }, [index, focalId, initialFocal]);

  // External activePath changes (e.g. user clicks a sidebar item while
  // staying in graph view) navigate the graph focus here.
  useEffect(() => {
    if (!activePath) return;
    if (activePath === focalIdRef.current) return;
    if (!index.docs.some((d) => d.path === activePath)) return;
    if (focalIdRef.current) setHistory((h) => [...h, focalIdRef.current!]);
    setFocalId(activePath);
    setPage(0);
  }, [activePath, index]);

  // Mount cytoscape once
  useEffect(() => {
    if (!ref.current) return;
    const cy = cytoscape({
      container: ref.current,
      elements: [],
      maxZoom: 4,
      minZoom: 0.15,
      wheelSensitivity: 0.2,
      style: [
        // --- Nodes: fill + border by category, size by depth (kind) ---
        {
          selector: "node",
          style: {
            "background-color": (ele: cytoscape.NodeSingular) =>
              CATEGORY_FILL[(ele.data("category") as Category) ?? "default"],
            "border-width": 2,
            "border-color": (ele: cytoscape.NodeSingular) =>
              CATEGORY_BASE[(ele.data("category") as Category) ?? "default"],
            label: "data(label)",
            color: "#1f2937",
            "font-weight": 500,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 6,
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: "node[kind = 'focal']",
          style: {
            "background-color": (ele: cytoscape.NodeSingular) =>
              CATEGORY_BASE[(ele.data("category") as Category) ?? "default"],
            "border-color": (ele: cytoscape.NodeSingular) =>
              CATEGORY_HIER[(ele.data("category") as Category) ?? "default"],
            "border-width": 3,
            width: 60,
            height: 60,
            "font-size": 14,
            "font-weight": 700,
            color: "#111827",
          },
        },
        {
          selector: "node[kind = 'layer1']",
          style: {
            width: 36,
            height: 36,
            "font-size": 12,
          },
        },
        {
          selector: "node[kind = 'layer2']",
          style: {
            width: 22,
            height: 22,
            "font-size": 10,
            color: "#4b5563",
          },
        },
        // --- Edges: color by TARGET node's category; hierarchy edges use the
        // darker "hier" shade with an arrowhead, assoc edges use the base shade
        // with no arrowhead. Arrowhead size bumped so direction is visible at
        // any reasonable zoom level. ---
        {
          selector: "edge",
          style: {
            width: 3,
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 10,
            color: "#4b5563",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-rotation": "autorotate",
            "line-color": (ele: cytoscape.EdgeSingular) => {
              const cat = (ele.data("targetCategory") as Category) ?? "default";
              const kind = ele.data("kind") as "hierarchy" | "assoc";
              return kind === "hierarchy" ? CATEGORY_HIER[cat] : CATEGORY_BASE[cat];
            },
          },
        },
        {
          selector: "edge[kind = 'hierarchy']",
          style: {
            "target-arrow-shape": "triangle",
            "target-arrow-color": (ele: cytoscape.EdgeSingular) =>
              CATEGORY_HIER[(ele.data("targetCategory") as Category) ?? "default"],
            "arrow-scale": 2,
          },
        },
        {
          selector: "edge[kind = 'assoc']",
          style: {
            "target-arrow-shape": "none",
          },
        },
      ],
    });

    cy.on("tap", "node", (e) => {
      const id = e.target.id();
      const currentFocal = focalIdRef.current;
      if (id === currentFocal) {
        onSelectRef.current(id);
      } else {
        if (currentFocal) setHistory((h) => [...h, currentFocal]);
        setFocalId(id);
        setPage(0);
      }
    });

    cy.on("zoom", () => {
      setZoomPct(Math.round(cy.zoom() * 100));
    });

    cy.zoom(1);
    cy.center();

    cyRef.current = cy;
    setZoomPct(100);
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Sync layout whenever focal / page / index changes
  const layout = useMemo(() => {
    if (!focalId || !index.docs.some((d) => d.path === focalId)) {
      return null;
    }
    return placeLayout(index, focalId, page);
  }, [focalId, page, index]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !layout) return;
    syncGraph(cy, layout);
  }, [layout]);

  const focalDoc = focalId ? index.docs.find((d) => d.path === focalId) ?? null : null;
  const totalLayer1 = layout?.totalLayer1 ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalLayer1 / PAGE_SIZE));
  const pageStart = page * PAGE_SIZE;

  const goBack = () => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const next = [...h];
      const prev = next.pop()!;
      setFocalId(prev);
      setPage(0);
      return next;
    });
  };

  const zoomTo = (level: number, animate = true) => {
    const cy = cyRef.current;
    if (!cy) return;
    const w = cy.width();
    const h = cy.height();
    const target = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), level));
    if (animate) {
      cy.animate(
        { zoom: { level: target, renderedPosition: { x: w / 2, y: h / 2 } } },
        { duration: 200, easing: "ease-out" }
      );
    } else {
      cy.zoom({ level: target, renderedPosition: { x: w / 2, y: h / 2 } });
    }
  };

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    zoomTo(cy.zoom() * factor);
  };

  const fitToView = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 80 } }, { duration: 250 });
  };

  if (!focalDoc) {
    return (
      <div className="graph-wrap">
        <div ref={ref} className="graph" />
      </div>
    );
  }

  const presets = [50, 75, 100, 125, 150, 200];

  return (
    <div className="graph-wrap">
      <div className="graph-bar">
        <button onClick={goBack} disabled={history.length === 0}>← Back</button>
        <span className="graph-focal">Focus: <strong>{focalDoc.title}</strong></span>
        <button onClick={() => onSelect(focalId!)}>Open doc</button>
        {onAddChild && (
          <button className="btn-action" onClick={() => onAddChild(focalId!, focalDoc.title)}>+ Child</button>
        )}
        {onAddAssociation && (
          <button className="btn-action" onClick={() => onAddAssociation(focalId!, focalDoc.title)}>Associate</button>
        )}
        {onDeleteNode && (
          <button className="btn-danger" onClick={() => onDeleteNode(focalId!, focalDoc.title)}>Delete</button>
        )}
        <span className="legend">
          {(["projects", "people", "hackathons", "education", "career", "vault"] as Category[]).map((c) => (
            <span key={c} className="legend-item">
              <span className="dot" style={{ backgroundColor: CATEGORY_BASE[c] }} />
              {CATEGORY_LABEL[c]}
            </span>
          ))}
          <span className="legend-note">→ parent → child</span>
        </span>
        <span className="spacer" />
        <span className="graph-page">
          {totalLayer1 === 0
            ? "No connections"
            : `${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, totalLayer1)} of ${totalLayer1}`}
        </span>
        <button
          onClick={() => setPage((p) => (p - 1 + totalPages) % totalPages)}
          disabled={totalPages <= 1}
        >Prev</button>
        <button
          onClick={() => setPage((p) => (p + 1) % totalPages)}
          disabled={totalPages <= 1}
        >Next</button>
      </div>
      <div className="graph-stage">
        <div ref={ref} className="graph" />
        <div className="zoom-control" onMouseLeave={() => setZoomMenuOpen(false)}>
          <button
            className="zoom-btn"
            onClick={() => zoomBy(1 / 1.25)}
            aria-label="Zoom out"
            title="Zoom out"
          >−</button>
          <button
            className="zoom-pct"
            onClick={() => setZoomMenuOpen((v) => !v)}
            title="Zoom level"
          >
            {zoomPct}%
          </button>
          <button
            className="zoom-btn"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >+</button>
          {zoomMenuOpen && (
            <div className="zoom-menu">
              <button onClick={() => { fitToView(); setZoomMenuOpen(false); }}>Fit</button>
              {presets.map((p) => (
                <button
                  key={p}
                  data-active={p === zoomPct}
                  onClick={() => { zoomTo(p / 100); setZoomMenuOpen(false); }}
                >
                  {p}%
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
