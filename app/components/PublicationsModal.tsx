"use client";
import { useCallback, useEffect, useState } from "react";

interface Publication {
  id: string;
  slug: string;
  root_doc_path: string;
  included_paths: string[];
  include_descendants: boolean;
  include_direct_associates: boolean;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  handle: string | null;
  is_admin?: boolean;
  publications: Publication[];
}

interface Props {
  onClose: () => void;
}

function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function PublicationsModal({ onClose }: Props) {
  const [handle, setHandle] = useState<string | null>(null);
  const [items, setItems] = useState<Publication[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return fetch("/api/publish", { cache: "no-store" })
      .then((r) => r.json() as Promise<ListResponse>)
      .then((data) => {
        setHandle(data.handle);
        setItems(data.publications ?? []);
      })
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm("Unpublish this share? The public URL will stop working immediately.")) return;
      setBusy(true);
      try {
        await fetch(`/api/publish?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publications-modal" onClick={(e) => e.stopPropagation()}>
        <div className="publications-modal-head">
          <h2>My publications</h2>
          <button type="button" className="publications-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="publications-modal-sub">
          Public links that anyone with the URL can read. Updates each time you re-publish from the same root with the same slug.
        </p>

        {items === null ? (
          <div className="publications-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="publications-empty">
            No publications yet. Pick a node in your graph, click <strong>Publish</strong> in the action bar, and it&rsquo;ll appear here.
          </div>
        ) : (
          <ul className="publications-list">
            {items.map((p) => {
              const url = handle ? `/share/${handle}/${p.slug}` : null;
              return (
                <li key={p.id} className="publications-item">
                  <div className="publications-item-main">
                    <div className="publications-item-slug">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          /{handle}/{p.slug}
                        </a>
                      ) : (
                        <span>{p.slug}</span>
                      )}
                    </div>
                    <div className="publications-item-meta">
                      {p.root_doc_path.replace(/\.md$/, "")} · {p.included_paths.length} doc
                      {p.included_paths.length === 1 ? "" : "s"} · updated {fmtRelative(p.updated_at)}
                    </div>
                    <div className="publications-item-flags">
                      {p.include_descendants && <span className="publications-flag">descendants</span>}
                      {p.include_direct_associates && <span className="publications-flag">associates</span>}
                    </div>
                  </div>
                  <div className="publications-item-actions">
                    {url && (
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}${url}`);
                        }}
                      >
                        Copy URL
                      </button>
                    )}
                    <button
                      type="button"
                      className="publications-danger"
                      onClick={() => onDelete(p.id)}
                      disabled={busy}
                    >
                      Unpublish
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
