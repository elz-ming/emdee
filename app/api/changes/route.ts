import { watch } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const docsDir = process.env.EMDEE_DOCS;
  if (!docsDir) {
    // Cloud: no local files to watch. Return an empty SSE stream so the
    // EventSource on the client opens cleanly and stays idle (no 500 retry storm).
    const stream = new ReadableStream({ start() {} });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  const resolved = path.resolve(docsDir);
  let watcher: ReturnType<typeof watch> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      try {
        watcher = watch(resolved, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith(".md")) return;
          controller.enqueue(new TextEncoder().encode("data: docs-changed\n\n"));
        });
      } catch {
        controller.close();
      }
    },
    cancel() {
      watcher?.close();
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
