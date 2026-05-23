import { loadVaultIndex } from "./vault";
import { extractPreamble } from "./patch_preamble";
import { parseSections, extractBody, hashBody, sectionId } from "./sections";
import type { ToolContext } from "./types";

// Re-export sectionId so historic call sites (`import { sectionId } from "./get_doc"`)
// keep compiling without an audit-the-world rename.
export { sectionId } from "./sections";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Return doc metadata. SPRINT-018 Phase 5: the body is opt-in via
 * `full=true`. The default response is light — title + summary +
 * preamble + section headings.
 *
 * SPRINT-024 Phase 1: every response now carries `doc_content_hash`
 * (sha256 first 16 hex of the raw file content). Pass it back via
 * `expected_content_hash` on the next get_doc; if the doc hasn't
 * changed we return `{ unchanged: true, path, doc_content_hash }` and
 * skip the section-parse / preamble work entirely. Cheaper than fetching
 * the doc just to discover nothing moved.
 */
export async function getDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const doc = idx.docs.find((d) => d.path === String(args.path));
  if (!doc) throw new Error(`no such doc: ${args.path}`);

  const docHash = hashBody(doc.content);

  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : "";
  if (expected && expected === docHash) {
    return json({ unchanged: true, path: doc.path, doc_content_hash: docHash });
  }

  const full = Boolean(args.full);
  const sections = parseSections(doc.content).map((s, idx) => ({
    id: sectionId(s.heading, idx),
    heading: s.heading,
    content_hash: hashBody(extractBody(doc.content, s)),
  }));
  const preamble = extractPreamble(doc.content);
  const payload: Record<string, unknown> = {
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    doc_content_hash: docHash,
    preamble: preamble ?? undefined,
    sections,
  };
  if (full) payload.content = doc.content;
  return json(payload);
}
