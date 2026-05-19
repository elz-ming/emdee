"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { DocIndex, DocNode, Edge } from "@/src/core/indexer";

export interface Props {
  index: DocIndex;
  activePath: string | null;
  onSelect: (path: string) => void;
  onAddChild?: (focalPath: string, focalTitle: string) => void;
  onAddAssociation?: (focalPath: string, focalTitle: string) => void;
  onDeleteNode?: (focalPath: string, focalTitle: string) => void;
  onShareNode?: (focalPath: string, focalTitle: string) => void;
  onRenameNode?: (focalPath: string, focalTitle: string) => void;
  // Prev/next sibling for the active doc — computed in App so the doc-pane
  // toolbar and the graph-pane controls stay in lockstep. When the user
  // taps a graph node, App's activePath updates and this memo recomputes.
  prevSibling?: DocNode | null;
  nextSibling?: DocNode | null;
}

// 8 angular slots around the focal at 45° each, numbered ANTICLOCKWISE
// from 12 o'clock. The numbering mirrors the navigation: slot 1 is "back"
// (prev sibling, smaller index), slot 7 is "forward" (next sibling,
// larger index), and the rotatable middle 2…6 reads as "child 1 through
// child 5" in the same anticlockwise direction.
//
// Lineage slots — reserved, never backfilled with children/associates:
//   slot 0 (12)    = parent
//   slot 1 (10:30) = prev sibling
//   slot 7 (1:30)  = next sibling
//
// Rotatable slots — focal's children/associates. For a focal with a parent,
// rotatable occupies the bottom half (slots 2…6) and pages 5 at a time. For
// a root focal (no parent, hence no siblings), all 8 slots are available
// and the page size opens up to 8 since there's no lineage to reserve.
const SLOT_COUNT = 8;
const PARENT_SLOT = 0;
const PREV_SIBLING_SLOT = 1;
const NEXT_SIBLING_SLOT = 7;
const ROTATABLE_SLOTS_WITH_PARENT = [2, 3, 4, 5, 6];
const ROTATABLE_SLOTS_ROOT = [0, 1, 2, 3, 4, 5, 6, 7];
const LAYER2_PER_LAYER1 = 2;
const RADIUS_LAYER1 = 240;
const RADIUS_LAYER2 = 400;
const ANIM_MS = 500;

type Role = "parent" | "child" | "assoc" | "sibling";

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
  // "sibling" is the navigational prev/next slot — rendered smaller and
  // dimmer than "layer1" so the eye reads it as a nav hint, not a primary
  // relationship. Same category palette, just toned down.
  kind: "focal" | "layer1" | "sibling" | "layer2";
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
  sibling: "",
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
  // Layout order:  parent (placed at 12 o'clock) → children alpha by title,
  // clockwise → associates alpha by title, clockwise. Sorting by title (what
  // the user sees in the sidebar/graph) rather than path is more intuitive
  // when docs live in subfolders like `sample/`.
  const titleFor = (p: string) => index.docs.find((d) => d.path === p)?.title ?? p;
  return [...seen.values()].sort((a, b) => {
    const order: Record<Role, number> = { parent: 0, child: 1, assoc: 2, sibling: 3 };
    if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
    return titleFor(a.id).localeCompare(titleFor(b.id));
  });
}

function angleForSlot(slot: number): number {
  // Anticlockwise on the visible clock face. Slot 0 at 12, slot 1 at 10:30,
  // slot 2 at 9, …, slot 7 at 1:30. (Math y-axis flipped on screen, so the
  // formula negates the slot fraction to walk CCW visually.)
  return -Math.PI / 2 - (slot / SLOT_COUNT) * Math.PI * 2;
}

// Walk the focal's first declared parent to find prev/next siblings in
// declared order. Same derivation as App's prevSibling/nextSibling memo
// and the get_neighbors MCP tool — the parent's `## Parent of` bullet
// order is the single source of truth for sibling sequencing.
function getPrevNextSiblings(index: DocIndex, focalId: string): {
  prevPath: string | null;
  nextPath: string | null;
} {
  const focalDoc = index.docs.find((d) => d.path === focalId);
  if (!focalDoc) return { prevPath: null, nextPath: null };
  const primaryParent = focalDoc.parents[0];
  if (!primaryParent) return { prevPath: null, nextPath: null };
  const byTitle = new Map<string, typeof index.docs[number]>();
  for (const d of index.docs) byTitle.set(d.title.toLowerCase(), d);
  const parentDoc = byTitle.get(primaryParent.title.toLowerCase());
  if (!parentDoc) return { prevPath: null, nextPath: null };
  const siblingPaths = parentDoc.children
    .map((l) => byTitle.get(l.title.toLowerCase())?.path)
    .filter((p): p is string => !!p);
  const idx = siblingPaths.findIndex((p) => p === focalId);
  if (idx === -1) return { prevPath: null, nextPath: null };
  return {
    prevPath: siblingPaths[idx - 1] ?? null,
    nextPath: siblingPaths[idx + 1] ?? null,
  };
}

function placeLayout(
  index: DocIndex,
  focalId: string,
  page: number
): { nodes: PlacedNode[]; edges: PlacedEdge[]; totalRotatable: number; pageSize: number } {
  const titleFor = (p: string) => index.docs.find((d) => d.path === p)?.title ?? p;
  const focalTitle = titleFor(focalId);
  // Strip a parent's title prefix from a child label, including any
  // segmented variants — "PROJECTS — WHATELZ-AI" under parent "PROJECTS"
  // becomes "WHATELZ-AI". Used for layer-1 (parent = focal) and layer-2
  // (parent = the layer-1 node above it) so a deep node like
  // "WHATELZ-AI — BUILD" displays as just "BUILD" beneath its parent.
  const shortLabelForParent = (parentTitle: string, p: string) => {
    const t = titleFor(p);
    const segments = parentTitle.split(" — ");
    for (let i = segments.length; i > 0; i--) {
      const prefix = segments.slice(0, i).join(" — ") + " — ";
      if (t.startsWith(prefix)) return t.slice(prefix.length);
    }
    return t;
  };
  const shortLabel = (p: string) => shortLabelForParent(focalTitle, p);

  const all = neighborsOf(index, focalId);
  const parent = all.find((n) => n.role === "parent") ?? null;
  // Rotatable = children + associates. Siblings are 2-hop and aren't in `all`
  // (no direct edge focal↔sibling), so no exclusion needed here.
  const rotatable = all.filter((n) => n.role !== "parent");

  const { prevPath, nextPath } = getPrevNextSiblings(index, focalId);
  // Sibling slots only get filled if the sibling actually exists as a doc.
  const nextSiblingId =
    nextPath && index.docs.some((d) => d.path === nextPath) ? nextPath : null;
  const prevSiblingId =
    prevPath && index.docs.some((d) => d.path === prevPath) ? prevPath : null;

  // Rotatable nodes fill a fixed list of slot positions in declared order.
  // With a parent: only the bottom-half slots (lineage slots 0/1/7 stay
  // reserved). At root: all 8 slots — no lineage to reserve.
  const rotatableSlots = parent ? ROTATABLE_SLOTS_WITH_PARENT : ROTATABLE_SLOTS_ROOT;
  const pageSize = rotatableSlots.length;
  const totalRotatable = rotatable.length;
  const totalPages = Math.max(1, Math.ceil(totalRotatable / pageSize));
  const safePage = ((page % totalPages) + totalPages) % totalPages;
  const pageStart = safePage * pageSize;
  const onPage = rotatable.slice(pageStart, pageStart + pageSize);

  // Strip the parent prefix from the focal label too — "POKEAI — LOGS"
  // under parent POKEAI reads as just "LOGS". Picks the first declared
  // parent's title; if there's no parent we fall back to the full title.
  const focalLabel = parent
    ? shortLabelForParent(titleFor(parent.id), focalId)
    : titleFor(focalId);

  const placed = new Map<string, PlacedNode>();
  placed.set(focalId, {
    id: focalId,
    label: focalLabel,
    kind: "focal",
    category: categoryFor(focalId),
    position: { x: 0, y: 0 },
  });

  const layer1AnglesById = new Map<string, number>();
  const layer1Real: Neighbor[] = []; // parent + on-page rotatable; siblings excluded

  // Place parent at slot 0 (always 12 o'clock when present)
  if (parent) {
    const angle = angleForSlot(PARENT_SLOT);
    layer1AnglesById.set(parent.id, angle);
    placed.set(parent.id, {
      id: parent.id,
      label: shortLabel(parent.id),
      kind: "layer1",
      category: categoryFor(parent.id),
      position: { x: Math.cos(angle) * RADIUS_LAYER1, y: Math.sin(angle) * RADIUS_LAYER1 },
    });
    layer1Real.push(parent);
  }

  // Next sibling at slot 1 (1:30). Empty slot when none — no backfill.
  if (nextSiblingId) {
    const angle = angleForSlot(NEXT_SIBLING_SLOT);
    layer1AnglesById.set(nextSiblingId, angle);
    placed.set(nextSiblingId, {
      id: nextSiblingId,
      label: shortLabel(nextSiblingId),
      kind: "sibling",
      category: categoryFor(nextSiblingId),
      position: { x: Math.cos(angle) * RADIUS_LAYER1, y: Math.sin(angle) * RADIUS_LAYER1 },
    });
  }

  // Prev sibling at slot 7 (10:30). Empty slot when none — no backfill.
  if (prevSiblingId) {
    const angle = angleForSlot(PREV_SIBLING_SLOT);
    layer1AnglesById.set(prevSiblingId, angle);
    placed.set(prevSiblingId, {
      id: prevSiblingId,
      label: shortLabel(prevSiblingId),
      kind: "sibling",
      category: categoryFor(prevSiblingId),
      position: { x: Math.cos(angle) * RADIUS_LAYER1, y: Math.sin(angle) * RADIUS_LAYER1 },
    });
  }

  // Rotatable neighbors fill the slot list in declared order. Bottom-half
  // anticlockwise for non-root focals (9 → 3 o'clock); full ring for root.
  onPage.forEach((n, i) => {
    const slot = rotatableSlots[i];
    if (slot === undefined) return;
    const angle = angleForSlot(slot);
    layer1AnglesById.set(n.id, angle);
    placed.set(n.id, {
      id: n.id,
      label: shortLabel(n.id),
      kind: "layer1",
      category: categoryFor(n.id),
      position: { x: Math.cos(angle) * RADIUS_LAYER1, y: Math.sin(angle) * RADIUS_LAYER1 },
    });
    layer1Real.push(n);
  });

  const reservedIds = new Set<string>([focalId]);
  for (const n of layer1Real) reservedIds.add(n.id);
  if (nextSiblingId) reservedIds.add(nextSiblingId);
  if (prevSiblingId) reservedIds.add(prevSiblingId);
  const edges: PlacedEdge[] = [];
  const layer2Pairs: { layer1Id: string; neighbor: Neighbor }[] = [];

  // Sibling edges: parent → prev sibling, parent → next sibling. These
  // are real hierarchy declarations in the parent's `Parent of` list, so
  // we draw them with the standard hierarchy style. They visibly connect
  // the lineage cluster (parent + siblings) at the top of the ring.
  if (parent && nextSiblingId) {
    edges.push({
      id: `e:${parent.id}|${nextSiblingId}`,
      source: parent.id,
      target: nextSiblingId,
      kind: "hierarchy",
      role: "child",
      targetCategory: categoryFor(nextSiblingId),
      showLabel: false,
    });
  }
  if (parent && prevSiblingId) {
    edges.push({
      id: `e:${parent.id}|${prevSiblingId}`,
      source: parent.id,
      target: prevSiblingId,
      kind: "hierarchy",
      role: "child",
      targetCategory: categoryFor(prevSiblingId),
      showLabel: false,
    });
  }

  for (const l1 of layer1Real) {
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

    // Layer-2 extends lineage in the same direction as the layer-1 hop, so
    // the picture stays a coherent chain rather than introducing siblings.
    //  - layer-1 is the focal's parent → layer-2 is its parent (grandparent
    //    of focal). At 12 o'clock this gives two ancestor levels stacked
    //    above the focal.
    //  - layer-1 is a child or associate → layer-2 is its child (one level
    //    deeper toward the leaves).
    // Sibling-of-focal nodes (which would appear here if we walked the
    // "child" side of a parent l1) are deliberately excluded — that was
    // the bug that put MMI above GBI in image 46.
    const desiredRole: Role = l1.role === "parent" ? "parent" : "child";
    const candidates = neighborsOf(index, l1.id)
      .filter((n) => !reservedIds.has(n.id))
      .filter((n) => n.role === desiredRole);
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
    const l1Title = titleFor(l1Id);
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
        label: shortLabelForParent(l1Title, n.id),
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

  return { nodes: [...placed.values()], edges, totalRotatable, pageSize };
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

export function GraphViewInner({ index, activePath, onSelect, onAddChild, onAddAssociation, onDeleteNode, onShareNode, onRenameNode, prevSibling, nextSibling }: Props) {
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
      // Disable Cytoscape's built-in wheel-zoom so our wheel listener (below)
      // can split trackpad scrolls (pan) from pinches (zoom) by ctrlKey.
      userZoomingEnabled: false,
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
        // "sibling" — prev/next nav hint. Same category family colors, but
        // smaller and softer so it reads as auxiliary, not as a child or
        // associate of the focal.
        {
          selector: "node[kind = 'sibling']",
          style: {
            width: 28,
            height: 28,
            "font-size": 11,
            "border-width": 1.5,
            "border-style": "dashed",
            opacity: 0.7,
            color: "#6b7280",
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
      // Clicking any node both refocuses the graph and opens it in the
      // doc pane on the right. (Doc + graph are visible simultaneously
      // now, so keeping their selection in sync is the desired behavior.)
      if (id !== currentFocal) {
        if (currentFocal) setHistory((h) => [...h, currentFocal]);
        setFocalId(id);
        setPage(0);
      }
      onSelectRef.current(id);
    });

    cy.on("zoom", () => {
      setZoomPct(Math.round(cy.zoom() * 100));
    });

    cy.zoom(1);
    cy.center();

    cyRef.current = cy;
    setZoomPct(100);

    // Trackpad-friendly wheel handling. Mac trackpads emit `wheel` events
    // with `ctrlKey: true` during pinch gestures (browser convention,
    // same signal Maps libs use). So:
    //   - wheel + ctrlKey  → pinch zoom, anchored to the cursor
    //   - wheel no ctrlKey → two-finger scroll, pan by the delta
    // Click-drag panning is unchanged (Cytoscape's built-in stays on).
    // For users on a scroll-wheel mouse, hold ⌃ to zoom — same convention.
    const container = ref.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        const next = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
        const rect = container.getBoundingClientRect();
        cy.zoom({
          level: next,
          renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        });
        setZoomPct(Math.round(cy.zoom() * 100));
      } else {
        const pan = cy.pan();
        cy.pan({ x: pan.x - e.deltaX, y: pan.y - e.deltaY });
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", onWheel);
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
  const totalRotatable = layout?.totalRotatable ?? 0;
  const layoutPageSize = layout?.pageSize ?? SLOT_COUNT;
  const totalPages = Math.max(1, Math.ceil(totalRotatable / layoutPageSize));

  // Lineage path from a root ancestor down to the focal. Walks parent
  // hierarchy edges (kind === "hierarchy", to === current) one step at
  // a time. Stops at any cycle and caps length so the breadcrumb stays
  // a single horizontal line. Last entry is always the focal itself.
  const lineage = useMemo<{ path: string; title: string }[]>(() => {
    if (!focalId) return [];
    const MAX = 6;
    const visited = new Set<string>([focalId]);
    const chain: string[] = [focalId];
    let cur = focalId;
    while (chain.length < MAX) {
      const parentEdge = index.edges.find(
        (e) => e.kind === "hierarchy" && e.to === cur && !visited.has(e.from)
      );
      if (!parentEdge) break;
      visited.add(parentEdge.from);
      chain.unshift(parentEdge.from);
      cur = parentEdge.from;
    }
    const titleByPath = new Map<string, string>();
    for (const d of index.docs) titleByPath.set(d.path, d.title);
    return chain.map((p) => ({ path: p, title: titleByPath.get(p) ?? p }));
  }, [index, focalId]);

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
        {onAddChild && (
          <button className="btn-action" onClick={() => onAddChild(focalId!, focalDoc.title)}>+ Child</button>
        )}
        {onAddAssociation && (
          <button className="btn-action" onClick={() => onAddAssociation(focalId!, focalDoc.title)}>Associate</button>
        )}
        {onRenameNode && (
          <button className="btn-action" onClick={() => onRenameNode(focalId!, focalDoc.title)}>Rename</button>
        )}
        <span className="spacer" />
        {onShareNode && (
          <button
            className="btn-icon btn-icon-share"
            onClick={() => onShareNode(focalId!, focalDoc.title)}
            aria-label="Share"
            title="Share"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="3.2" cy="7" r="1.7" stroke="currentColor" strokeWidth="1.2"/>
              <circle cx="10.8" cy="3" r="1.7" stroke="currentColor" strokeWidth="1.2"/>
              <circle cx="10.8" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="4.6" y1="6.3" x2="9.4" y2="3.9" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="4.6" y1="7.7" x2="9.4" y2="10.1" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        )}
        {onDeleteNode && (
          <button
            className="btn-icon btn-icon-danger"
            onClick={() => onDeleteNode(focalId!, focalDoc.title)}
            aria-label="Delete"
            title="Delete"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 4H12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M5 4V2.6C5 2.32 5.22 2.1 5.5 2.1H8.5C8.78 2.1 9 2.32 9 2.6V4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M3.2 4.5L3.9 11.9C3.94 12.45 4.4 12.9 4.95 12.9H9.05C9.6 12.9 10.06 12.45 10.1 11.9L10.8 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M6 6.5V10.5M8 6.5V10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </div>
      <div className="graph-stage">
        <div ref={ref} className="graph" />
        <div className="graph-controls">
          <div className="graph-controls-focal">
            Focus: <strong>{focalDoc.title}</strong>
          </div>
          <div className="graph-controls-row">
            <button
              className="graph-controls-btn"
              onClick={() => prevSibling && onSelect(prevSibling.path)}
              disabled={!prevSibling}
              title={prevSibling ? `← ${prevSibling.title}  [` : "No previous sibling  ["}
              type="button"
            >← Prev Node</button>
            <button
              className="graph-controls-btn"
              onClick={() => nextSibling && onSelect(nextSibling.path)}
              disabled={!nextSibling}
              title={nextSibling ? `${nextSibling.title} →  ]` : "No next sibling  ]"}
              type="button"
            >Next Node →</button>
          </div>
          <div className="graph-controls-row">
            <button
              className="graph-controls-btn"
              onClick={() => setPage((p) => (p - 1 + totalPages) % totalPages)}
              disabled={totalPages <= 1}
              aria-label="Previous page"
              title="Previous page"
              type="button"
            >‹ Prev Page</button>
            <span className="graph-controls-page">
              {totalRotatable === 0
                ? "No connections"
                : totalPages === 1
                ? `${totalRotatable} connection${totalRotatable === 1 ? "" : "s"}`
                : `Page ${page + 1} / ${totalPages}`}
            </span>
            <button
              className="graph-controls-btn"
              onClick={() => setPage((p) => (p + 1) % totalPages)}
              disabled={totalPages <= 1}
              aria-label="Next page"
              title="Next page"
              type="button"
            >Next Page ›</button>
          </div>
          {lineage.length > 1 && (
            <nav className="graph-controls-breadcrumb" aria-label="Lineage">
              {lineage.map((crumb, i) => {
                const isFocal = i === lineage.length - 1;
                return (
                  <span key={crumb.path} className="graph-breadcrumb-cell">
                    {i > 0 && <span className="graph-breadcrumb-sep" aria-hidden="true">›</span>}
                    <button
                      className="graph-breadcrumb-crumb"
                      data-focal={isFocal}
                      onClick={() => !isFocal && onSelect(crumb.path)}
                      title={crumb.title}
                      type="button"
                      disabled={isFocal}
                    >
                      {crumb.title}
                    </button>
                  </span>
                );
              })}
            </nav>
          )}
        </div>
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
