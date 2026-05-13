import { auth } from "@clerk/nextjs/server";
import { buildIndexFromContents } from "@/src/core/indexer";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMPTY = { docs: [], edges: [], entry: null };
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * Copy every file under `public/` into `{ns}/` as a starter set. Called once
 * the first time an authenticated user opens their own empty workspace, so
 * they see the same intro tree visitors see at `/`.
 */
async function seedFromPublic(storage: SupabaseStorage, ns: string): Promise<void> {
  const seeds = await storage.list("public/");
  await Promise.all(
    seeds.map(async (f) => {
      const content = await storage.read(f.path);
      if (content === null) return;
      const relative = f.path.slice("public/".length);
      await storage.write(`${ns}/${relative}`, content);
    })
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    return Response.json(EMPTY, NO_STORE);
  }

  // Auth gate for personal namespaces. `public` is open; everything else must
  // be owned by the requester.
  let canSeedIfEmpty = false;
  if (ns !== "public") {
    const { userId } = await auth();
    if (!userId || userId !== ns) {
      return Response.json(EMPTY, NO_STORE);
    }
    canSeedIfEmpty = true;
  }

  const storage = new SupabaseStorage();
  const prefix = `${ns}/`;
  let listed: Awaited<ReturnType<typeof storage.list>>;
  try {
    listed = await storage.list(prefix);
  } catch {
    listed = [];
  }

  // First-visit seed: copy public/ → {userId}/ once.
  if (listed.length === 0 && canSeedIfEmpty) {
    await seedFromPublic(storage, ns);
    try {
      listed = await storage.list(prefix);
    } catch {
      listed = [];
    }
  }

  if (listed.length === 0) {
    return Response.json(EMPTY, NO_STORE);
  }

  const files = await Promise.all(
    listed.map(async (f) => ({
      path: f.path.slice(prefix.length),
      content: (await storage.read(f.path)) ?? "",
    }))
  );

  const index = buildIndexFromContents(files);
  return Response.json(index, NO_STORE);
}
