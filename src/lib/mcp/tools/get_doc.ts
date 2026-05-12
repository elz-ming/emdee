import { createHash } from "node:crypto";
import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number;
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;

function parseSections(content: string): SectionLoc[] {
  const lines = content.split("\n");
  const sections: SectionLoc[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(H2_RE);
    if (!m) continue;
    if (sections.length > 0) sections[sections.length - 1].bodyEndLineIdx = i;
    sections.push({ heading: m[1].trim(), headingLineIdx: i, bodyStartLineIdx: i + 1, bodyEndLineIdx: lines.length });
  }
  return sections;
}

function extractBody(content: string, loc: SectionLoc): string {
  return content.split("\n").slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx).join("\n").replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

export async function getDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const doc = idx.docs.find((d) => d.path === String(args.path));
  if (!doc) throw new Error(`no such doc: ${args.path}`);
  const sections = parseSections(doc.content).map((s) => ({
    heading: s.heading,
    content_hash: hashBody(extractBody(doc.content, s)),
  }));
  return json({ path: doc.path, title: doc.title, summary: doc.summary, content: doc.content, sections });
}
