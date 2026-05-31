"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShareTreePicker } from "./ShareTreePicker";
import { filenameSlug } from "@/src/core/resolveLink";
import type { DocIndex } from "@/src/core/indexer";

interface Props {
  path: string;
  title: string;
  /** Owner namespace (clerk userId) — passed to /api/pdf so the server
   *  reads from the correct vault. */
  namespace: string;
  index: DocIndex | null;
  onClose: () => void;
}

type Format = "pdf" | "md";

function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return cleaned || "untitled";
}

function zipFilename(title: string, path: string): string {
  const base = sanitizeSegment(title).slice(0, 80);
  if (base && base !== "untitled") return `${base}.zip`;
  const last = path.split("/").pop() ?? "vault";
  return `${sanitizeSegment(last.replace(/\.md$/i, ""))}.zip`;
}

function buildSlugToTitle(index: DocIndex): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of index.docs) {
    const slug = filenameSlug(d.path).toLowerCase();
    if (!m.has(slug)) m.set(slug, d.title);
  }
  return m;
}

/**
 * Longest common directory prefix across all selected paths. Used to
 * re-root the zip at the focal's branch instead of the vault root, so a
 * download of `events/.../GBI/.../DAY1-CN/YOUJI-CAIFU-ZHANSHU.md` plus
 * its siblings doesn't bury everything under six empty parent dirs.
 */
function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const idx = paths[0].lastIndexOf("/");
    return idx >= 0 ? paths[0].slice(0, idx + 1) : "";
  }
  const first = paths[0].split("/");
  let common = first.length - 1; // drop filename
  for (let i = 1; i < paths.length; i++) {
    const other = paths[i].split("/");
    const max = Math.min(common, other.length - 1);
    let k = 0;
    while (k < max && first[k] === other[k]) k++;
    common = k;
  }
  if (common === 0) return "";
  return first.slice(0, common).join("/") + "/";
}

/**
 * Rewrite a vault-relative path to use H1 titles for every segment.
 * Directory segments resolve via the slug→title map; leaf filenames use
 * the focal doc's title. `usedByDir` tracks claimed filenames per
 * output directory so colliding siblings get `-2`, `-3` suffixes.
 */
function rewriteZipPath(
  relPath: string,
  ext: string,
  slugToTitle: Map<string, string>,
  usedByDir: Map<string, Set<string>>
): string {
  const parts = relPath.split("/");
  const file = parts.pop() ?? "";
  const fileBase = file.replace(/\.md$/i, "");

  const renamedDirs = parts.map((seg) => {
    const titled = slugToTitle.get(seg.toLowerCase());
    return titled ? sanitizeSegment(titled) : sanitizeSegment(seg);
  });

  const titled = slugToTitle.get(fileBase.toLowerCase());
  const baseCandidate = titled ? sanitizeSegment(titled) : sanitizeSegment(fileBase);

  const dirKey = renamedDirs.join("/");
  const used = usedByDir.get(dirKey) ?? new Set<string>();
  let candidate = baseCandidate;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${baseCandidate}-${i++}`;
  }
  used.add(candidate.toLowerCase());
  usedByDir.set(dirKey, used);

  return [...renamedDirs, `${candidate}${ext}`].join("/");
}

export function DownloadModal({ path, title, namespace, index, onClose }: Props) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set([path]));
  const [format, setFormat] = useState<Format>("pdf");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seededForPathRef = useRef<string | null>(null);

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
    setProgress({ done: 0, total: selectedPaths.size });
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const slugToTitle = buildSlugToTitle(index);
      const usedByDir = new Map<string, Set<string>>();
      const sorted = [...selectedPaths].sort();
      const prefix = commonDirPrefix(sorted);

      if (format === "md") {
        let added = 0;
        for (const p of sorted) {
          const content = contentByPath.get(p);
          if (typeof content !== "string") continue;
          const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
          const zipPath = rewriteZipPath(rel, ".md", slugToTitle, usedByDir);
          zip.file(zipPath, content);
          added++;
          setProgress({ done: added, total: sorted.length });
        }
        if (added === 0) throw new Error("No content available to download.");
      } else {
        // SPRINT-034: server-side PDF via /api/pdf. Each doc is one POST;
        // Puppeteer prints to a vector PDF with clickable link
        // annotations (the prior html2pdf raster pipeline lost them).
        // Sequential to keep memory bounded — concurrent Puppeteer pages
        // would balloon Vercel function memory on large vaults.
        const titleByPath = new Map<string, string>();
        if (index) for (const d of index.docs) titleByPath.set(d.path, d.title);

        let added = 0;
        for (const p of sorted) {
          if (!contentByPath.has(p)) continue;
          const res = await fetch("/api/pdf", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: p,
              ns: namespace,
              title: titleByPath.get(p) ?? p,
            }),
          });
          if (!res.ok) throw new Error(`PDF generation failed for ${p}: HTTP ${res.status}`);
          const pdfBlob = await res.blob();
          const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
          const zipPath = rewriteZipPath(rel, ".pdf", slugToTitle, usedByDir);
          zip.file(zipPath, pdfBlob);
          added++;
          setProgress({ done: added, total: sorted.length });
        }
        if (added === 0) throw new Error("No content available to download.");
      }

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
      setProgress(null);
    }
  };

  const buttonLabel = busy
    ? progress
      ? `Building ${progress.done}/${progress.total}…`
      : "Zipping…"
    : `Download ${selectedPaths.size} doc${selectedPaths.size === 1 ? "" : "s"}`;

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

        <div className="download-format">
          <span className="download-format-label">Format</span>
          <label className={`download-format-pill ${format === "pdf" ? "is-active" : ""}`}>
            <input
              type="radio"
              name="download-format"
              value="pdf"
              checked={format === "pdf"}
              onChange={() => setFormat("pdf")}
              disabled={busy}
            />
            PDF
          </label>
          <label className={`download-format-pill ${format === "md" ? "is-active" : ""}`}>
            <input
              type="radio"
              name="download-format"
              value="md"
              checked={format === "md"}
              onChange={() => setFormat("md")}
              disabled={busy}
            />
            Markdown
          </label>
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
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
