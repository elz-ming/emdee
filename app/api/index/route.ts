import { buildIndex, buildIndexFromContents } from "@/src/core/indexer";
import { list } from "@vercel/blob";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Paths shown in the public namespace (product docs only, no personal content).
// Matches EMDEE.md, VAULT.md, and the vault-meta subtree + sample branch.
function isPublicPath(p: string): boolean {
  const top = p.split("/")[0];
  const publicRoots = new Set(["EMDEE.md", "VAULT.md", "INFO.md", "INSTRUCTIONS.md", "BRAIN.md", "WORKFLOWS.md", "SAMPLE.md"]);
  const publicDirs = new Set(["sample", "workflows"]);
  return publicRoots.has(p) || publicDirs.has(top);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";
  const docsDir = process.env.EMDEE_DOCS;

  // Local dev: read from filesystem; filter to public-safe docs when ns=public
  if (docsDir) {
    const index = await buildIndex(path.resolve(docsDir));
    if (ns === "public") {
      const filtered = {
        ...index,
        docs: index.docs.filter((d) => isPublicPath(d.path)),
        edges: index.edges.filter((e) => {
          const fromPublic = index.docs.some((d) => d.path === e.from && isPublicPath(d.path));
          const toPublic = index.docs.some((d) => d.path === e.to && isPublicPath(d.path));
          return fromPublic && toPublic;
        }),
      };
      return Response.json(filtered, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(index, { headers: { "Cache-Control": "no-store" } });
  }

  // Cloud: read from Vercel Blob under the given namespace prefix
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    const envKeys = Object.keys(process.env).filter(k => k.includes("BLOB") || k.includes("TOKEN")).join(",");
    return Response.json({ docs: [], edges: [], entry: null, _debug: `no token; blob-related keys: ${envKeys || "none"}` }, { headers: { "Cache-Control": "no-store" } });
  }

  const prefix = ns.endsWith("/") ? ns : `${ns}/`;
  const { blobs } = await list({ token, prefix });
  const mdBlobs = blobs.filter((b) => b.pathname.endsWith(".md"));

  // Public namespace with no Blob docs: fall back to bundled templates
  if (mdBlobs.length === 0 && ns === "public") {
    const templatesDir = path.join(process.cwd(), "templates");
    try {
      const templateIndex = await buildIndex(templatesDir);
      const filtered = {
        ...templateIndex,
        docs: templateIndex.docs.filter((d) => isPublicPath(d.path)),
        edges: templateIndex.edges.filter((e) => {
          const fromPublic = templateIndex.docs.some((d) => d.path === e.from && isPublicPath(d.path));
          const toPublic = templateIndex.docs.some((d) => d.path === e.to && isPublicPath(d.path));
          return fromPublic && toPublic;
        }),
      };
      return Response.json(filtered, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ docs: [], edges: [], entry: null }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  const files = await Promise.all(
    mdBlobs.map(async (b) => {
      const res = await fetch(b.url, { headers: { Authorization: `Bearer ${token}` } });
      const content = res.ok ? await res.text() : "";
      return {
        path: b.pathname.slice(prefix.length),
        content,
      };
    })
  );

  const index = buildIndexFromContents(files);

  if (ns === "public") {
    const filtered = {
      ...index,
      docs: index.docs.filter((d) => isPublicPath(d.path)),
      edges: index.edges.filter((e) => {
        const fromPublic = index.docs.some((d) => d.path === e.from && isPublicPath(d.path));
        const toPublic = index.docs.some((d) => d.path === e.to && isPublicPath(d.path));
        return fromPublic && toPublic;
      }),
    };
    return Response.json(filtered, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json(index, { headers: { "Cache-Control": "no-store" } });
}
