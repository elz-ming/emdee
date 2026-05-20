"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShareTreePicker } from "./ShareTreePicker";
import type { DocIndex } from "@/src/core/indexer";

interface ShareRow {
  id: string;
  kind: "share";
  grantee_id: string;
  email: string | null;
  permission: "read" | "write";
  created_at: string;
  share_root: string;
  doc_count: number;
}

interface InvitationRow {
  id: string;
  kind: "invitation";
  email: string;
  permission: "read" | "write";
  token: string;
  created_at: string;
  share_root: string;
  doc_count: number;
}

type Recipient = ShareRow | InvitationRow;

interface Publication {
  id: string;
  slug: string;
  handle: string | null;
  url: string | null;
  include_descendants: boolean;
  include_direct_associates: boolean;
  included_count: number;
  updated_at: string;
}

interface Props {
  path: string;
  title: string;
  index: DocIndex | null;
  onClose: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[—–]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function ShareModal({ path, title, index, onClose }: Props) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [exactMatchEmail, setExactMatchEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lookupSeq = useRef(0);

  // Public-share state. `publication` mirrors the current row (null when
  // not published). `selectedPaths` is the explicit set the picker maintains;
  // initialized to {focal + all descendants} (associates default OFF).
  const [publication, setPublication] = useState<Publication | null>(null);
  const [ownerHandle, setOwnerHandle] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState(slugify(title));
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set([path]));
  const [publishBusy, setPublishBusy] = useState(false);
  const [publicError, setPublicError] = useState<string | null>(null);

  // Seed the picker with focal + all descendants the first time the index
  // becomes available (or path changes). After that, the user's edits
  // own the set until they unpublish + restart.
  const seededForPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!index || seededForPathRef.current === path) return;
    seededForPathRef.current = path;
    const initial = new Set<string>([path]);
    const childrenByParent = new Map<string, string[]>();
    for (const e of index.edges) {
      if (e.kind !== "hierarchy") continue;
      const arr = childrenByParent.get(e.from) ?? [];
      arr.push(e.to);
      childrenByParent.set(e.from, arr);
    }
    const stack = [path];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const c of childrenByParent.get(cur) ?? []) {
        if (initial.has(c)) continue;
        initial.add(c);
        stack.push(c);
      }
    }
    setSelectedPaths(initial);
  }, [index, path]);

  const refreshShares = useCallback(async () => {
    const data = await fetch(`/api/share?path=${encodeURIComponent(path)}`).then((r) => r.json());
    setRecipients((data.shares ?? []).concat(data.invitations ?? []));
    setPublication(data.publication ?? null);
    setOwnerHandle(data.owner_handle ?? null);
    if (data.publication) {
      setSlugDraft(data.publication.slug);
    }
  }, [path]);

  useEffect(() => {
    (async () => {
      const [, sugg] = await Promise.all([
        refreshShares(),
        fetch(`/api/share/suggestions`).then((r) => r.json()),
      ]);
      setSuggestions(sugg.emails ?? []);
    })().catch(() => {});
  }, [refreshShares]);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!EMAIL_RE.test(q)) {
      setExactMatchEmail(null);
      return;
    }
    const mySeq = ++lookupSeq.current;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/share/lookup?email=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (lookupSeq.current !== mySeq) return;
        setExactMatchEmail(data.user?.email ?? null);
      } catch {}
    }, 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const trimmed = query.trim().toLowerCase();
  const alreadySharedEmails = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipients) if (r.email) set.add(r.email.toLowerCase());
    return set;
  }, [recipients]);

  const visibleSuggestions = useMemo(() => {
    if (!trimmed) return [] as string[];
    return suggestions
      .filter((s) => s.startsWith(trimmed) && s !== trimmed && !alreadySharedEmails.has(s))
      .slice(0, 5);
  }, [trimmed, suggestions, alreadySharedEmails]);

  useEffect(() => { setHighlightIdx(0); }, [visibleSuggestions.length, query]);

  const isPublic = !!publication;

  const isCompleteEmail = EMAIL_RE.test(trimmed);
  const isRegisteredUser = isCompleteEmail && exactMatchEmail !== null;
  const isSelfOrDuplicate = alreadySharedEmails.has(trimmed);
  const canSubmit = !busy && !isSelfOrDuplicate && (isRegisteredUser || (isCompleteEmail && !isRegisteredUser));

  const submitEmail = useCallback(async (emailArg?: string) => {
    const email = (emailArg ?? trimmed).toLowerCase();
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      const effectivePermission = isPublic ? "write" : permission;
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, email, permission: effectivePermission }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "failed");
        return;
      }
      await refreshShares();
      setSuggestions((s) => Array.from(new Set([...s, email])).sort());
      setQuery("");
      setExactMatchEmail(null);
      inputRef.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [path, permission, trimmed, isPublic, refreshShares]);

  const revoke = useCallback(async (r: Recipient) => {
    const kind = r.kind === "invitation" ? "invitation" : "share";
    const ok = await fetch(`/api/share/${r.id}?kind=${kind}`, { method: "DELETE" }).then((r) => r.ok).catch(() => false);
    if (ok) setRecipients((list) => list.filter((x) => x.id !== r.id));
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && visibleSuggestions.length > 0) {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, visibleSuggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp" && visibleSuggestions.length > 0) {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (visibleSuggestions.length > 0 && highlightIdx >= 0) {
        submitEmail(visibleSuggestions[highlightIdx]);
      } else if (canSubmit) {
        submitEmail();
      }
    }
  }, [visibleSuggestions, highlightIdx, canSubmit, submitEmail]);

  const submitLabel = (() => {
    if (busy) return "Sharing…";
    if (!trimmed) return "Share";
    if (isRegisteredUser) return `Share with ${trimmed}`;
    if (isCompleteEmail) return `Invite ${trimmed}`;
    return "Share";
  })();

  const publishPublic = useCallback(async () => {
    setPublishBusy(true);
    setPublicError(null);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: slugDraft,
          root_doc_path: path,
          included_paths: [...selectedPaths],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPublicError(data.error ?? "publish failed");
        return;
      }
      await refreshShares();
    } catch (e) {
      setPublicError((e as Error).message);
    } finally {
      setPublishBusy(false);
    }
  }, [slugDraft, path, selectedPaths, refreshShares]);

  const disablePublic = useCallback(async () => {
    if (!publication) return;
    if (!confirm("Stop sharing publicly? The link will return 404 immediately.")) return;
    setPublishBusy(true);
    setPublicError(null);
    try {
      const res = await fetch(`/api/publish?id=${encodeURIComponent(publication.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPublicError(data.error ?? "unpublish failed");
        return;
      }
      await refreshShares();
    } catch (e) {
      setPublicError((e as Error).message);
    } finally {
      setPublishBusy(false);
    }
  }, [publication, refreshShares]);

  const publicUrl = useMemo(() => {
    if (!publication?.url) return null;
    if (typeof window === "undefined") return publication.url;
    return `${window.location.origin}${publication.url}`;
  }, [publication]);

  const handleMissing = !ownerHandle;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-modal="true">
        <p className="modal-title">Share</p>
        <p className="modal-subtitle">
          Share <strong>{title}</strong> with others by email, or open it to the public web.
        </p>

        {/* Public-share toggle block. Visual state is *optimistic* — during
            the publish/unpublish round-trip (~1–2s loading the vault on
            the server) the toggle slides immediately to its target state
            with a busy stripe, then reconciles with the server response. */}
        <div className={`share-public ${isPublic ? "is-on" : ""}`}>
          <div className="share-public-head">
            <div className="share-public-text">
              <div className="share-public-title">
                Share to public
                {publishBusy && (
                  <span className="share-public-spinner" aria-label="Working…" />
                )}
              </div>
              <div className="share-public-sub">
                {publishBusy
                  ? isPublic
                    ? "Stopping…"
                    : "Publishing…"
                  : isPublic
                  ? "Anyone with the link can read. Search engines may index it."
                  : "Off — only people you add by email can access."}
              </div>
            </div>
            <button
              type="button"
              className={`share-toggle ${(publishBusy ? !isPublic : isPublic) ? "on" : ""} ${publishBusy ? "is-busy" : ""}`}
              role="switch"
              aria-checked={publishBusy ? !isPublic : isPublic}
              disabled={publishBusy || handleMissing}
              onClick={() => (isPublic ? disablePublic() : publishPublic())}
            >
              <span className="share-toggle-knob" />
            </button>
          </div>

          {handleMissing && !isPublic && (
            <div className="share-public-error">
              Set a handle on your profile to enable public sharing.
            </div>
          )}

          {!isPublic && !handleMissing && (
            <div className="share-public-config">
              <label className="share-public-field">
                <span>URL slug</span>
                <div className="share-public-slug-row">
                  <span className="share-public-slug-prefix">/share/{ownerHandle}/</span>
                  <input
                    type="text"
                    value={slugDraft}
                    onChange={(e) => setSlugDraft(slugify(e.target.value))}
                    placeholder="my-notes"
                    disabled={publishBusy}
                  />
                </div>
              </label>
              {index && (
                <ShareTreePicker
                  index={index}
                  focalPath={path}
                  selectedPaths={selectedPaths}
                  onChange={setSelectedPaths}
                />
              )}
              <div className="share-public-hint">
                Toggle <strong>Share to public</strong> on to publish with these settings.
              </div>
            </div>
          )}

          {isPublic && publication && publicUrl && (
            <div className="share-public-live">
              <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="share-public-url">
                {publicUrl}
              </a>
              <button
                type="button"
                className="share-public-copy"
                onClick={() => navigator.clipboard.writeText(publicUrl)}
              >
                Copy
              </button>
              <div className="share-public-meta">
                {publication.included_count} doc{publication.included_count === 1 ? "" : "s"} ·
                {publication.include_descendants ? " descendants" : " root only"}
                {publication.include_direct_associates && " · associates"}
              </div>
            </div>
          )}

          {publicError && <div className="share-public-error">{publicError}</div>}
        </div>

        <div className="modal-field share-input-wrap">
          <label className="modal-label" htmlFor="share-email">
            {isPublic ? "Add people who can edit" : "Add people"}
          </label>
          <div className="share-input-row">
            <input
              id="share-email"
              ref={inputRef}
              className="modal-input"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
            />
            {isPublic ? (
              <span className="share-permission-locked" title="Public read is already granted by the link">
                Write
              </span>
            ) : (
              <select
                className="share-permission"
                value={permission}
                onChange={(e) => setPermission(e.target.value as "read" | "write")}
                aria-label="Permission"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
            )}
          </div>

          {visibleSuggestions.length > 0 && (
            <div className="share-suggestions" role="listbox">
              {visibleSuggestions.map((s, i) => (
                <div
                  key={s}
                  className="share-suggestion"
                  data-highlight={i === highlightIdx}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => submitEmail(s)}
                  role="option"
                  aria-selected={i === highlightIdx}
                >
                  <span className="share-suggestion-email">{s}</span>
                  <span className="share-suggestion-meta">previously shared</span>
                </div>
              ))}
            </div>
          )}

          {trimmed && visibleSuggestions.length === 0 && (
            <div className="share-hint">
              {isSelfOrDuplicate ? (
                <span className="share-hint-error">Already shared with {trimmed}</span>
              ) : isRegisteredUser ? (
                <span>↩ Press Enter to {isPublic ? "give write access to" : "share with"} <strong>{trimmed}</strong></span>
              ) : isCompleteEmail ? (
                <span>↩ Press Enter to invite <strong>{trimmed}</strong></span>
              ) : (
                <span>Keep typing the full email — no match yet</span>
              )}
            </div>
          )}
        </div>

        {recipients.length > 0 && (
          <div className="share-list">
            <p className="share-list-title">People with access</p>
            {recipients.map((r) => (
              <div key={r.id} className="share-list-row">
                <div className="share-list-info">
                  <span className="share-list-email">{r.email ?? "(no email)"}</span>
                  <span className="share-list-meta">
                    {r.kind === "invitation" ? "pending invitation" : "active"}
                    {" · "}{r.permission}
                    {r.doc_count > 1 && ` · ${r.doc_count} docs`}
                  </span>
                </div>
                <button
                  className="btn-ghost share-revoke"
                  onClick={() => revoke(r)}
                  type="button"
                  title="Revoke access"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="share-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} type="button">Done</button>
          <button
            className="btn-primary"
            onClick={() => submitEmail()}
            disabled={!canSubmit}
            type="button"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
