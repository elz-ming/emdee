import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { getVaultStorage } from "@/src/lib/storage";
import { buildIndexFromContents } from "@/src/core/indexer";
import { computeIncludedPaths } from "@/src/lib/publications/scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "auth",
  "share",
  "sign-in",
  "sign-up",
  "vault",
  "me",
  "oauth",
  "public",
]);

interface PublishBody {
  slug: string;
  root_doc_path: string;
  included_paths?: string[]; // optional explicit override (custom picker)
  include_descendants: boolean;
  include_direct_associates: boolean;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: PublishBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const slug = String(body.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    return Response.json({ error: "invalid_slug" }, { status: 400 });
  }

  const rootPath = String(body.root_doc_path ?? "").trim();
  if (!rootPath) return Response.json({ error: "root_required" }, { status: 400 });

  // Owner profile lookup — need the handle for the resulting public URL.
  const admin = adminClient();
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("handle")
    .eq("clerk_id", userId)
    .maybeSingle();
  if (profileErr || !profile?.handle) {
    return Response.json({ error: "handle_not_set" }, { status: 400 });
  }

  // Two paths here, optimized so the common (tree-picker) case avoids
  // downloading every doc + rebuilding the index server-side.
  //
  //  Fast path (modern, ~200ms): client sent explicit included_paths.
  //    Only need to verify paths exist in storage → list() returns names
  //    without content.
  //
  //  Legacy path (~1–2s on large vaults): client sent only flags. Need
  //    the full content + index to walk descendants/associates.
  const { storage, prefix } = getVaultStorage(userId);
  const explicit = Array.isArray(body.included_paths) && body.included_paths.length > 0;

  let computed: string[];
  if (explicit) {
    const listed = await storage.list(prefix || undefined);
    const existing = new Set(
      listed.map((f) => (prefix ? f.path.slice(prefix.length) : f.path))
    );
    if (!existing.has(rootPath)) {
      return Response.json({ error: "root_not_in_vault" }, { status: 400 });
    }
    computed = Array.from(
      new Set([rootPath, ...body.included_paths!.filter((p) => existing.has(p))])
    );
  } else {
    const listed = await storage.listWithContent(prefix || undefined);
    const files = listed.map((f) => ({
      path: prefix ? f.path.slice(prefix.length) : f.path,
      content: f.content,
    }));
    const index = buildIndexFromContents(files);
    if (!index.docs.some((d) => d.path === rootPath)) {
      return Response.json({ error: "root_not_in_vault" }, { status: 400 });
    }
    computed = computeIncludedPaths(index, rootPath, {
      includeDescendants: !!body.include_descendants,
      includeDirectAssociates: !!body.include_direct_associates,
    });
  }

  // Upsert: same (owner, slug) replaces. Lets the owner re-publish to refresh
  // the included set without going through a delete+create dance.
  const { data: row, error: upsertErr } = await admin
    .from("publications")
    .upsert(
      {
        owner_id: userId,
        slug,
        root_doc_path: rootPath,
        included_paths: computed,
        include_descendants: !!body.include_descendants,
        include_direct_associates: !!body.include_direct_associates,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,slug" }
    )
    .select("id")
    .single();
  if (upsertErr || !row) {
    return Response.json({ error: "publish_failed", detail: upsertErr?.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    publication_id: row.id,
    url: `/share/${profile.handle}/${slug}`,
    included_count: computed.length,
  });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const admin = adminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("handle, is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  const handle = profile?.handle ?? null;
  const isAdmin = !!profile?.is_admin;
  const { data: rows } = await admin
    .from("publications")
    .select("id, slug, root_doc_path, included_paths, include_descendants, include_direct_associates, created_at, updated_at")
    .eq("owner_id", userId)
    .order("updated_at", { ascending: false });
  return Response.json({ handle, is_admin: isAdmin, publications: rows ?? [] });
}

export async function DELETE(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id_required" }, { status: 400 });
  const admin = adminClient();
  const { error } = await admin
    .from("publications")
    .delete()
    .eq("id", id)
    .eq("owner_id", userId);
  if (error) return Response.json({ error: "delete_failed" }, { status: 500 });
  return Response.json({ ok: true });
}
