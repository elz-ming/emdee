import { ctxFromAuthHeader } from "@/src/lib/rest/auth";
import {
  ok,
  unauthorized,
  serverError,
  corsPreflight,
} from "@/src/lib/rest/responses";
import { listDocs } from "@/src/lib/mcp/tools/list_docs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/rest/docs
 *
 * Thin REST wrapper over the MCP `list_docs` tool. Returns every doc
 * visible to the caller (own vault + any docs shared into the vault via
 * doc_shares) as a flat array of `{ path, title, summary }` entries.
 * The MCP tool returns the array as a JSON string inside the MCP
 * content envelope — we parse that out before emitting under the REST
 * `{ ok, docs }` envelope.
 */
export async function GET(req: Request) {
  const ctx = await ctxFromAuthHeader(req);
  if (!ctx) return unauthorized();

  try {
    const wrapped = (await listDocs(ctx, {})) as {
      content: Array<{ text: string }>;
    };
    const docs = JSON.parse(wrapped.content[0].text);
    return ok({ docs });
  } catch (e) {
    return serverError((e as Error).message);
  }
}
