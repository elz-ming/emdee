import { auth } from "@clerk/nextjs/server";
import { marked } from "marked";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { adminClient } from "@/src/lib/supabase/admin";
import { getVaultStorage } from "@/src/lib/storage";

// SPRINT-034: server-side PDF generation with clickable link annotations.
// Replaces the client html2pdf.js raster pipeline (which lost <a href> to
// bitmap rasterisation). Markdown is parsed by `marked` (GFM autolinks
// enabled), then Chromium prints the HTML through `page.pdf()` — vector
// output with link annotations preserved.
export const runtime = "nodejs";
export const maxDuration = 60;

interface PdfRequest {
  /** Path of the doc within its owner namespace, e.g. "projects/DOUBLELEAD.md". */
  path: string;
  /** The viewing namespace — usually the requester's clerk userId, or "public". */
  ns?: string;
  /** Set when this is a doc shared INTO ns; the markdown lives in ownerId's namespace. */
  sharedOwnerId?: string;
  /** Publication handle (set when exporting from /share/<handle>/<slug>). */
  publicationHandle?: string;
  /** Publication slug (set alongside publicationHandle). */
  publicationSlug?: string;
  /** Optional override for the H1 title used in filename + page metadata. */
  title?: string;
}

const LOCAL_CHROME_DARWIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Minimal print CSS. Goal: legible PDF that matches the read-view's general
// feel; clickable <a> in blue. Pixel-perfect parity with Toast UI's
// preview pane is explicitly out of scope (see SPRINT-034 spec).
const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
    color: #111827;
    line-height: 1.6;
    font-size: 13px;
  }
  .doc { padding: 24px; max-width: 760px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 16px; color: #111827;
       background: #fef9c3; padding: 8px 12px; border-radius: 4px; }
  h2 { font-size: 18px; margin: 24px 0 8px; border-bottom: 1px solid #e5e7eb;
       padding-bottom: 4px; color: #111827; }
  h3 { font-size: 15px; margin: 18px 0 6px; color: #111827; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
  li { margin: 2px 0; }
  blockquote { border-left: 3px solid #d1d5db; margin: 8px 0; padding: 4px 12px;
               color: #4b5563; background: #f9fafb; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  a { color: #2563eb; text-decoration: underline; }
  a:visited { color: #2563eb; }
  .wiki-link { color: #6b21a8; text-decoration: underline dotted; cursor: pointer; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f9fafb; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Rewrite [[wiki-link]] occurrences to styled spans. Mirrors
// DocEditorInner.tsx:43-54 / DownloadModal.tsx:204-215. Runs on the parsed
// HTML output so any [[X]] surviving inside text nodes (marked doesn't
// process the syntax) get the same visual treatment as the in-app render.
function rewriteWikiLinks(html: string): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_, t: string) =>
    `<span class="wiki-link">${escapeHtml(t)}</span>`
  );
}

function safeFilename(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_").trim() || "doc";
}

async function fetchMarkdown(ns: string, path: string): Promise<string | null> {
  const { storage, prefix } = getVaultStorage(ns);
  return storage.read(`${prefix}${path}`);
}

async function hasShareAccess(granteeId: string, ownerId: string, relPath: string): Promise<boolean> {
  // Direct row match; mirrors the read-side gate from
  // src/lib/mcp/tools/vault.ts. Ancestor / cascade rows are still per-path
  // in doc_shares, so a direct equality is the right check here.
  const { data } = await adminClient()
    .from("doc_shares")
    .select("id")
    .eq("grantee_id", granteeId)
    .eq("owner_id", ownerId)
    .eq("path_prefix", relPath)
    .maybeSingle();
  return !!data;
}

async function launchBrowser() {
  // Vercel + similar Lambda runtimes: use the bundled @sparticuz/chromium
  // binary. Locally (macOS dev) we fall back to system Chrome to avoid
  // shipping a 50MB binary into the local dev install.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  return puppeteer.launch({
    executablePath: process.platform === "darwin" ? LOCAL_CHROME_DARWIN : undefined,
    headless: true,
  });
}

export async function POST(request: Request) {
  let body: PdfRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const path = String(body.path ?? "").trim();
  if (!path) return Response.json({ error: "path_required" }, { status: 400 });

  // Auth + namespace resolution. Four cases:
  //   1. publicationHandle/Slug set — anonymous-readable, verify path is
  //      in the publication's included_paths, read from owner namespace
  //   2. sharedOwnerId set — verify the requester has share access to
  //      this exact path, then read from the owner's namespace
  //   3. ns = "public" — no auth, read from public namespace
  //   4. otherwise — requester must own ns
  let readNs: string;
  if (body.publicationHandle && body.publicationSlug) {
    const admin = adminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("clerk_id")
      .eq("handle", body.publicationHandle.toLowerCase())
      .maybeSingle();
    if (!profile) return Response.json({ error: "not_found" }, { status: 404 });
    const { data: pub } = await admin
      .from("publications")
      .select("included_paths")
      .eq("owner_id", profile.clerk_id)
      .eq("slug", body.publicationSlug.toLowerCase())
      .maybeSingle();
    if (!pub) return Response.json({ error: "not_found" }, { status: 404 });
    const included = (pub.included_paths as string[]) ?? [];
    if (!included.includes(path)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    readNs = profile.clerk_id;
  } else if (body.sharedOwnerId) {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const allowed = await hasShareAccess(userId, body.sharedOwnerId, path);
    if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
    readNs = body.sharedOwnerId;
  } else {
    const ns = body.ns ?? "public";
    if (ns !== "public") {
      const { userId } = await auth();
      if (!userId || userId !== ns) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
    }
    readNs = ns;
  }

  const markdown = await fetchMarkdown(readNs, path);
  if (!markdown) return Response.json({ error: "not_found" }, { status: 404 });

  // GFM + autolinks on; breaks off so soft line breaks don't become <br>.
  marked.setOptions({ gfm: true, breaks: false });
  const bodyHtml = rewriteWikiLinks(await marked.parse(markdown));
  const titleForFile = body.title?.trim() || extractTitle(markdown, path);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(titleForFile)}</title>
<style>${PRINT_CSS}</style>
</head><body><div class="doc">${bodyHtml}</div></body></html>`;

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // setContent + waitUntil:networkidle0 is overkill for inline HTML —
    // there are no network requests. domcontentloaded is enough.
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "14mm", bottom: "14mm", left: "14mm" },
    });
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFilename(titleForFile)}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("PDF generation failed:", e);
    return Response.json({ error: "pdf_failed" }, { status: 500 });
  } finally {
    try { await browser?.close(); } catch {}
  }
}

function extractTitle(markdown: string, fallbackPath: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return fallbackPath.split("/").pop()?.replace(/\.md$/, "") ?? "doc";
}
