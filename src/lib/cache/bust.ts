// SPRINT-024 Phase 3: write-path cache busting.
//
// `revalidateTag` only invalidates the Next.js Data Cache (`unstable_cache`,
// tagged fetch calls). On Vercel, route-handler responses cached at the
// edge via `Cache-Control: s-maxage=…` are purged when the response
// carries a matching `Cache-Tag` header AND `revalidateTag` is invoked
// against that tag. Off Vercel the s-maxage TTL is the only invalidator —
// 60s eventual consistency, which is acceptable for the index/summary
// surfaces this hooks.
//
// Personal namespaces aren't cached (`no-store`), so calling
// `bustVaultCache("<userId>", …)` is effectively a no-op — but invoking
// it unconditionally from the storage write path keeps the call site
// simple and makes the public namespace work without special-casing.

import { revalidateTag } from "next/cache";

export function vaultListTag(ns: string): string {
  return `${ns}:list`;
}

export function vaultPathTag(ns: string, path: string): string {
  return `${ns}:${path}`;
}

/**
 * Bust the index-list tag for `ns` and (optionally) the specific path
 * tag. Wrapped in try/catch by the caller — a revalidation failure must
 * not surface as a 500 on the write that succeeded.
 */
export function bustVaultCache(ns: string, path?: string): void {
  // This Next.js requires a second profile arg to `revalidateTag`. `'max'`
  // uses stale-while-revalidate semantics so reads don't block on the
  // refresh — the doc list / summary will briefly show stale before the
  // fresh response is regenerated. For our editing surfaces that's the
  // right tradeoff (writes complete fast, reads don't stall).
  try {
    if (path) revalidateTag(vaultPathTag(ns, path), "max");
    revalidateTag(vaultListTag(ns), "max");
  } catch {
    // revalidateTag throws when called outside a request scope (e.g.
    // local stdio MCP server, scripts). Swallow — TTL is the fallback.
  }
}
