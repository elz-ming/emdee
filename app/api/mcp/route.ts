import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clerkIdFromOAuthToken } from "@/src/lib/supabase/oauth";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import {
  listDocs, getSummary, getNeighbors, getDoc, search,
  appendSection, patchSection, writeDocPreview, writeDoc,
} from "@/src/lib/mcp/tools/index";

export const dynamic = "force-dynamic";

// Browser-side MCP clients (claude.ai's tool widget) hit this endpoint from a
// different origin, so every response needs CORS headers and OPTIONS preflights
// must succeed before the real request is sent.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}

function bearerChallenge(origin: string): Response {
  return withCors(new Response(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  }));
}

function buildMcpServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: "emdee", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      instructions: `You are working inside an Emdee vault — a plain-markdown knowledge graph.

BEFORE writing or editing any doc:
1. Call get_doc("INFO.md") to load vault conventions.
2. Use patch_section for incremental edits — never write_doc for single-section changes.

Key conventions:
- Every doc starts with one H1 + one > blockquote summary immediately below it.
- Sprints: Child of [[PROJECT — BUILD]] if active/spec, Child of [[PROJECT — LOGS]] if shipped.`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "list_docs", description: "Enumerate every doc in the vault as {path, title, summary}.", inputSchema: { type: "object", properties: {} } },
      { name: "get_summary", description: "Return {path, title, summary} for one doc.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "get_neighbors", description: "Return the doc plus its 1-hop neighborhood.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "get_doc", description: "Return full markdown content of one doc plus sections with content_hash.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "search", description: "Case-insensitive search over titles, summaries, and content.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
      { name: "append_section", description: "Append markdown content to an existing H2 section.", inputSchema: { type: "object", properties: { path: { type: "string" }, heading: { type: "string" }, body: { type: "string" }, create_if_missing: { type: "boolean" } }, required: ["path", "heading", "body"] } },
      { name: "patch_section", description: "Replace the body of an existing H2 section (version-guarded).", inputSchema: { type: "object", properties: { path: { type: "string" }, heading: { type: "string" }, body: { type: "string" }, expected_content_hash: { type: "string" } }, required: ["path", "heading", "body", "expected_content_hash"] } },
      { name: "write_doc_preview", description: "Preview the diff that write_doc would produce.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "write_doc", description: "Create or overwrite a markdown doc. DESTRUCTIVE — always run write_doc_preview first.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    const a = args ?? {};
    switch (name) {
      case "list_docs":         return await listDocs(ctx, a) as CallToolResult;
      case "get_summary":       return await getSummary(ctx, a) as CallToolResult;
      case "get_neighbors":     return await getNeighbors(ctx, a) as CallToolResult;
      case "get_doc":           return await getDoc(ctx, a) as CallToolResult;
      case "search":            return await search(ctx, a) as CallToolResult;
      case "append_section":    return await appendSection(ctx, a) as CallToolResult;
      case "patch_section":     return await patchSection(ctx, a) as CallToolResult;
      case "write_doc_preview": return await writeDocPreview(ctx, a) as CallToolResult;
      case "write_doc":         return await writeDoc(ctx, a) as CallToolResult;
      default: throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}

async function handleMcp(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;

  // Local dev: skip OAuth, use EMDEE_DOCS
  const docsDir = process.env.EMDEE_DOCS;
  if (docsDir) {
    const path = await import("node:path");
    const ctx: ToolContext = { mode: "local", docsDir: path.resolve(docsDir) };
    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  }

  // Cloud: require OAuth bearer token
  const clerkId = await clerkIdFromOAuthToken(request);
  if (!clerkId) return bearerChallenge(origin);

  const storage = new SupabaseStorage();
  const ctx: ToolContext = { mode: "cloud", storage, userId: clerkId };
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
