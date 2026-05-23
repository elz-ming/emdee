// SPRINT-019 Phase A — pre-write lint gate. The write tools call
// evaluateLintGate against proposed-but-not-yet-persisted content, with a
// caller-supplied list of warning codes that should HARD-BLOCK the write.
// If any of those codes fire, the gate returns the structured fixes and
// the write is skipped. With an empty gate list (the default everywhere),
// every write proceeds and warnings remain advisory — the existing
// post-write lint envelope behaviour is unchanged.
//
// The shape `{ ok: true } | { ok: false; ... }` is deliberately the same
// envelope each write tool serialises into its response so the caller
// can branch on `ok` alone.

import { lintDocContent, type LintVaultContext, type LintWarning } from "./lint";

export interface LintFix {
  code: LintWarning["code"];
  line: number | null;
  fix_suggestion: string;
  original_message: string;
}

export type LintGateResult =
  | { ok: true }
  | { ok: false; fixes: LintFix[]; original_warnings: LintWarning[] };

/**
 * Run the lint engine on `proposedContent` and decide whether the write
 * should proceed. Cross-doc rules (asymmetric_*, sibling_assoc_redundant)
 * only fire when `vaultCtx` is supplied — callers that want to gate on
 * those must pass it in. Single-doc codes work without a vault context.
 */
export function evaluateLintGate(
  proposedContent: string,
  gateOnCodes: string[],
  vaultCtx?: LintVaultContext,
): LintGateResult {
  if (gateOnCodes.length === 0) return { ok: true };
  const { warnings } = lintDocContent(proposedContent, vaultCtx);
  const gateSet = new Set(gateOnCodes);
  const offending = warnings.filter((w) => gateSet.has(w.code));
  if (offending.length === 0) return { ok: true };
  const fixes: LintFix[] = offending.map((w) => ({
    code: w.code,
    line: w.line ?? null,
    fix_suggestion: w.suggestion,
    original_message: w.message,
  }));
  return { ok: false, fixes, original_warnings: offending };
}
