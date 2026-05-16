import { ctxFromAuthHeader } from "@/src/lib/rest/auth";
import {
  ok,
  fail,
  unauthorized,
  badRequest,
  notFound,
  forbidden,
  serverError,
  corsPreflight,
} from "@/src/lib/rest/responses";
import { getDoc } from "@/src/lib/mcp/tools/get_doc";
import { writeDoc } from "@/src/lib/mcp/tools/write_doc";
import { patchSection } from "@/src/lib/mcp/tools/patch_section";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHARED_PREFIX = "__shared__/";

type RouteCtx = { params: Promise<{ path: string[] }> };

function unwrap<T = unknown>(wrapped: unknown): T {
  const text = (wrapped as { content: Array<{ text: string }> }).content[0]
    .text;
  return JSON.parse(text) as T;
}

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/rest/docs/{...path}
 *
 * Reads one doc by relative vault path (including __shared__/<owner>/...
 * when the caller has a doc_shares grant). Returns the markdown content
 * plus a parsed view of each H2 section with content hashes for the
 * PATCH version-guard, and the H1+blockquote preamble region.
 *
 * The underlying MCP `get_doc` tool throws `no such doc: <path>` when
 * the path is absent from the caller's index. For paths under
 * `__shared__/` that fall through to the same error path (the listing
 * only includes shares the caller has access to), we re-map to 403
 * since the resource exists in the namespace but the grant is missing.
 */
export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await ctxFromAuthHeader(req);
  if (!auth) return unauthorized();

  const { path: segments } = await ctx.params;
  const path = segments.join("/");

  try {
    const wrapped = await getDoc(auth, { path });
    const payload = unwrap<{
      path: string;
      title: string;
      summary: string;
      content: string;
      preamble?: { body: string; content_hash: string };
      sections: Array<{ heading: string; content_hash: string }>;
    }>(wrapped);
    return ok({
      path: payload.path,
      title: payload.title,
      summary: payload.summary,
      content: payload.content,
      sections: payload.sections,
      preamble: payload.preamble ?? null,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.startsWith("no such doc")) {
      if (path.startsWith(SHARED_PREFIX)) return forbidden();
      return notFound("doc");
    }
    return serverError(msg);
  }
}

/**
 * POST /api/rest/docs/{...path}
 *
 * Whole-doc write. Body shape: `{ content: string }`. Writes against
 * the caller's own namespace; `__shared__/` paths are refused by
 * `writeVaultFile` and surfaced here as 403 (shared docs are read-only
 * via this endpoint — edits must go through the owner).
 */
export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await ctxFromAuthHeader(req);
  if (!auth) return unauthorized();

  const { path: segments } = await ctx.params;
  const path = segments.join("/");

  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof (body as { content?: unknown }).content !== "string"
  ) {
    return badRequest("Body must be { content: string }.");
  }
  const content = (body as { content: string }).content;

  try {
    await writeDoc(auth, { path, content });
    return ok({ path });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("shared docs are read-only")) return forbidden();
    return badRequest(msg);
  }
}

/**
 * PATCH /api/rest/docs/{...path}?section={heading}&expected_content_hash={hash}
 *
 * Replace the body of one H2 section, guarded by the section's last-seen
 * content hash. Body shape: `{ body: string }`. The MCP `patch_section`
 * tool returns its error states (`version_conflict`, `section_not_found`,
 * `doc_not_found`) inside the wrapped JSON envelope; we map each to the
 * appropriate HTTP status here.
 */
export async function PATCH(req: Request, ctx: RouteCtx) {
  const auth = await ctxFromAuthHeader(req);
  if (!auth) return unauthorized();

  const { path: segments } = await ctx.params;
  const path = segments.join("/");

  const url = new URL(req.url);
  const section = url.searchParams.get("section");
  const expected = url.searchParams.get("expected_content_hash");
  if (!section) return badRequest("Missing required query parameter: section");
  if (!expected) {
    return badRequest(
      "Missing required query parameter: expected_content_hash"
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof (body as { body?: unknown }).body !== "string") {
    return badRequest("Body must be { body: string }.");
  }
  const sectionBody = (body as { body: string }).body;

  try {
    const wrapped = await patchSection(auth, {
      path,
      heading: section,
      body: sectionBody,
      expected_content_hash: expected,
    });
    const payload = unwrap<
      | { ok: true; content_hash: string }
      | { error: string; message?: string; [k: string]: unknown }
    >(wrapped);

    if ("error" in payload) {
      switch (payload.error) {
        case "version_conflict":
          return fail("version_conflict", 409, payload);
        case "section_not_found":
          return fail("section_not_found", 404, payload);
        case "doc_not_found":
          return notFound("doc");
        default:
          return badRequest(payload.message ?? payload.error, payload);
      }
    }

    return ok({ content_hash: payload.content_hash });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("shared docs are read-only")) return forbidden();
    return badRequest(msg);
  }
}
