"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShareTreePicker } from "./ShareTreePicker";
import type { DocIndex } from "@/src/core/indexer";

interface Props {
  path: string;
  title: string;
  index: DocIndex | null;
  onClose: () => void;
}

function zipFilename(title: string, path: string): string {
  const base = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (base) return `${base}.zip`;
  const last = path.split("/").pop() ?? "vault";
  return `${last.replace(/\.md$/i, "")}.zip`;
}

export function DownloadModal({ path, title, index, onClose }: Props) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set([path]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seededForPathRef = useRef<string | null>(null);

  // Seed picker with focal + all descendants (mirrors ShareModal).
  useEffect(() => {
    if (!index || seededForPathRef.current === path) return;
    seededForPathRef.current = path;
    const initial = new Set<string>([path]);
    const childrenByParent = new Map<string, string[]>();
    for (const e of index.edges) {
      if (e.kind === "hierarchy") {
        const arr = childrenByParent.get(e.from) ?? [];
        arr.push(e.to);
        childrenByParent.set(e.from, arr);
      }
    }
    const stack = [path];
    while (stack.length) {
      const p = stack.pop()!;
      for (const c of childrenByParent.get(p) ?? []) {
        if (initial.has(c)) continue;
        initial.add(c);
        stack.push(c);
      }
    }
    setSelectedPaths(initial);
  }, [index, path]);

  const contentByPath = useMemo(() => {
    const m = new Map<string, string>();
    if (!index) return m;
    for (const d of index.docs) m.set(d.path, d.content);
    return m;
  }, [index]);

  const onDownload = async () => {
    if (!index || selectedPaths.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      let added = 0;
      for (const p of selectedPaths) {
        const content = contentByPath.get(p);
        if (typeof content !== "string") continue;
        zip.file(p, content);
        added++;
      }
      if (added === 0) throw new Error("No content available to download.");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipFilename(title, path);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to build zip.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal">
        <div className="share-header">
          <div>
            <p className="modal-title">Download zip</p>
            <p className="modal-subtitle">{title}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">×</button>
        </div>

        {index ? (
          <ShareTreePicker
            index={index}
            focalPath={path}
            selectedPaths={selectedPaths}
            onChange={setSelectedPaths}
          />
        ) : (
          <div className="share-tree-empty">Loading index…</div>
        )}

        {error && <p className="share-error">{error}</p>}

        <div className="share-actions">
          <button className="btn-ghost" onClick={onClose} type="button" disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            onClick={onDownload}
            type="button"
            disabled={busy || selectedPaths.size === 0 || !index}
          >
            {busy ? "Zipping…" : `Download ${selectedPaths.size} doc${selectedPaths.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
