import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel function timeout cap. Pro plan tops out at 60s by default; if
// the project is on Hobby (10s), the stream just reconnects sooner —
// EventSource handles that automatically and seenIdsRef dedupes the
// brief replay window. STREAM_MAX_MS below stays a hair under so we
// close the stream cleanly before the runtime kills it.
export const maxDuration = 60;

const POLL_INTERVAL_MS = 1200;
// Cap: how far back we look on the very first poll. The pulse is 2s
// long; surfacing rows much older than that would just flash stale
// events at a freshly-mounted client.
const INITIAL_LOOKBACK_MS = 3000;
// Safety: end the stream after this long so Vercel's serverless function
// timeout doesn't kill it mid-write. The EventSource on the client
// reconnects automatically.
const STREAM_MAX_MS = 50_000;

interface ActivityRow {
  id: string;
  tool_name: string;
  doc_path: string | null;
  action_kind: string;
  clerk_id: string;
  created_at: string;
}

/**
 * SSE stream of mcp_activity rows for the caller's namespace.
 *
 * Why SSE + DB poll instead of supabase-realtime: the project has no
 * Clerk→Supabase JWT bridging, so a client-side subscription with an
 * RLS-scoped policy would see zero rows (auth.jwt() is null). The MCP
 * tool-call wrappers insert with the service role; this route reads
 * with the same role and authenticates the caller via Clerk before
 * filtering on namespace.
 *
 * Auth model mirrors /api/changes-version: only the namespace's owner
 * can subscribe. "public" namespace isn't supported here — there's no
 * meaningful pulse to render against shared public content.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns");
  if (!ns || ns === "public") {
    return emptyStream();
  }

  const { userId } = await auth();
  if (!userId || userId !== ns) {
    return emptyStream();
  }

  const startedAt = Date.now();
  let lastSeen = new Date(startedAt - INITIAL_LOOKBACK_MS).toISOString();
  let cancelled = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Controller closed mid-write (client disconnected). Pulled
          // back into the polling loop's cancellation check below.
          cancelled = true;
        }
      };

      // Opening comment so the browser's EventSource resolves the
      // connection event immediately even when no rows are pending.
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        cancelled = true;
      }

      while (!cancelled && Date.now() - startedAt < STREAM_MAX_MS) {
        try {
          const { data, error } = await adminClient()
            .from("mcp_activity")
            .select("id, tool_name, doc_path, action_kind, clerk_id, created_at")
            .eq("namespace", ns)
            .gt("created_at", lastSeen)
            .order("created_at", { ascending: true })
            .limit(50);
          if (!error && data && data.length > 0) {
            for (const row of data as ActivityRow[]) {
              send(JSON.stringify(row));
              if (row.created_at > lastSeen) lastSeen = row.created_at;
            }
          }
        } catch {
          // Transient supabase blip — keep polling.
        }
        await sleep(POLL_INTERVAL_MS);
      }

      try { controller.close(); } catch {}
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

function emptyStream(): Response {
  const stream = new ReadableStream({ start(controller) { controller.close(); } });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
