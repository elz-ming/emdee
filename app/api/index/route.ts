import { buildIndex, buildIndexFromContents } from "@/src/core/indexer";
import { list, get } from "@vercel/blob";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";
  const docsDir = process.env.EMDEE_DOCS;

  // Local dev: read from filesystem (ignore namespace — single user)
  if (docsDir) {
    const index = await buildIndex(path.resolve(docsDir));
    return Response.json(index, { headers: { "Cache-Control": "no-store" } });
  }

  // Cloud: read from Vercel Blob under the given namespace prefix
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return Response.json({ docs: [], edges: [], entry: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const prefix = ns.endsWith("/") ? ns : `${ns}/`;
  const { blobs } = await list({ token, prefix });
  const mdBlobs = blobs.filter((b) => b.pathname.endsWith(".md"));

  const files = await Promise.all(
    mdBlobs.map(async (b) => {
      const result = await get(b.pathname, { token, access: "private" });
      const content = result ? await new Response(result.stream).text() : "";
      return {
        // Strip the namespace prefix so paths are relative (e.g. "userId/EMDEE.md" → "EMDEE.md")
        path: b.pathname.slice(prefix.length),
        content,
      };
    })
  );

  const index = buildIndexFromContents(files);
  return Response.json(index, { headers: { "Cache-Control": "no-store" } });
}
