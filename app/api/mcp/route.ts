import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clerkIdFromOAuthToken } from "@/src/lib/supabase/oauth";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import {
  listDocs, getSummary, getNeighbors, getContext, getDoc, search,
  appendSection, patchSection, writeDocPreview, writeDoc, deleteDoc, splitDoc, renameDoc, patchPreamble, appendDoc,
  lintDoc, distillDoc, materializeSubgroup, createChild, addAssociation,
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
1. Call get_doc("INFO.md", full=true) to load vault conventions — get_doc now returns the light envelope by default; pass full=true when you actually need the body.
2. Use patch_section for incremental edits — never write_doc for single-section changes.

Read-side defaults (SPRINT-018):
- get_doc returns title + summary + preamble + section headings only. Pass full=true for the body.
- get_context is the multi-hop big sibling of get_neighbors — returns the focal + neighbourhood within a token budget. Prefer it over chaining get_doc + get_neighbors when you need a coherent local view.

Write-side atomics (SPRINT-019):
- create_child(parent_path, title, body?, summary?) — atomic write + parent patch. Use this instead of write_doc + patch_section for adding child nodes.
- add_association(a_path, b_path, label?) — atomic two-sided assoc patch. Hard-refuses sibling or hierarchy-duplicating pairs. Use this instead of two patch_section calls for cross-tree links.
- Every write tool accepts gate_on_warnings: [lint_codes]. Recommended for routine writes: ["multiple_child_of", "associate_duplicates_hierarchy", "sibling_assoc_redundant"]. Gating refuses the write and returns { error: "lint_gate_failed", fixes: [{ line, fix_suggestion }] } so you can correct and retry inside the same turn.
- get_doc returns a stable section_id per H2. Pass section_id to patch_section / append_section instead of heading whenever heading text might drift.

Key conventions:
- Every doc starts with one H1 + one > blockquote summary immediately below it.
- Sprints: Child of [[PROJECT — BUILD]] if active/spec, Child of [[PROJECT — LOGS]] if shipped.

Edge discipline (lint_doc warns on violations):
- One parent per doc: \`## Child of\` should have exactly one bullet. Multiple parents → demote the secondary ones to \`## Associated with\`.
- No sibling associations: docs that share a parent are already related through it. \`## Associated with\` is for cross-tree connections (project↔person, sprint↔learning), not for linking two day-notes under the same event.
- Reciprocal edges: if A's \`## Parent of\` lists [[B]], B's \`## Child of\` must list [[A]]. One-sided edges fire asymmetric_parent_edge / asymmetric_child_edge.
- Sibling order is derived from the parent's \`## Parent of\` bullet order — never declare \`[[next-node]]\` / \`[[prev-node]]\` edges in markdown. \`get_neighbors\` returns \`prev_sibling\` / \`next_sibling\` automatically.

Shared docs:
- Paths starting with "__shared__/<owner_id>/" are docs another user has
  shared into this vault. They appear in list_docs and are readable via
  get_doc / get_summary / search, but every write tool (write_doc,
  patch_section, append_section, delete_doc, split_doc) will refuse them.
  If you need to edit one, ask the user to talk to the owner.`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "list_docs", description: "Enumerate every doc in the vault as {path, title, summary}.", inputSchema: { type: "object", properties: {} } },
      { name: "get_summary", description: "Return {path, title, summary} for one doc.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "get_neighbors", description: "Return the doc plus its 1-hop neighborhood.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "get_context", description: "Return the focal doc plus its multi-hop neighbourhood within a token budget. Focal + 1-hop neighbours get full bodies (when include_full); deeper hops get summary only. Nodes that don't fit in budget_tokens land in budget.dropped_paths. Use this instead of chaining get_doc + get_neighbors when you need a coherent local view.", inputSchema: { type: "object", properties: { path: { type: "string" }, hops: { type: "number", description: "Max BFS depth, 1–3. Default 2." }, budget_tokens: { type: "number", description: "Rough token cap (chars÷4). Default 8000." }, include_full: { type: "boolean", description: "Inline focal + hop-1 bodies. Default true." }, include_associates: { type: "boolean", description: "Include assoc edges in the walk. Default true." } }, required: ["path"] } },
      { name: "get_doc", description: "Returns title + summary + preamble + section headings. Each section in the `sections` array has `{ id, heading, content_hash }` — `id` is a stable short string for patch_section / append_section lookup (preferred over `heading` when the heading text is fuzzy or may collide), `content_hash` is the version guard for patch_section. Pass `full=true` for the body. Use `get_context` instead when you need the focal + its neighbourhood — that's cheaper than chaining get_doc + get_neighbors.", inputSchema: { type: "object", properties: { path: { type: "string" }, full: { type: "boolean", description: "Include the full markdown content. Default false — light envelope only." } }, required: ["path"] } },
      { name: "search", description: "Case-insensitive search over titles, summaries, and content.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
      { name: "append_section", description: "Append markdown content to the END of an existing H2 section's body. NOTE: when the section isn't the doc's last, this lands mid-doc. For chronological note-taking that should always land at the bottom of the page, use append_doc instead. Either `heading` or `section_id` (from get_doc.sections[].id) must be provided — `section_id` is preferred when available because it's an exact match instead of a fuzzy heading-name lookup. If both are provided and resolve to different sections, returns `section_id_heading_mismatch`. Response includes `section_id` for chained edits. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content (defaults to no gate; warnings still surface in the response envelope).", inputSchema: { type: "object", properties: { path: { type: "string" }, heading: { type: "string" }, section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." }, body: { type: "string" }, create_if_missing: { type: "boolean" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body"] } },
      { name: "append_doc", description: "Append content to the very end of a doc (after every existing section). For chronological note-taking — LOGS, daily notes, anywhere new content should land at the bottom of the page regardless of section structure. The body may include its own `##` headings to introduce new sections at the end. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", properties: { path: { type: "string" }, body: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body"] } },
      { name: "lint_doc", description: "Audit a doc for quality defects. Returns warnings (missing preamble blockquote, inline wiki-link mentions ≥3× without a declared edge) and structural info. Signal, not gate — never throws on a 'bad' doc.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "distill_doc", description: "READ-ONLY intake for splitting a notes doc into standalone knowledge nodes. Returns the source + section boundaries + vault context (existing titles for collision check, BRAIN/PATTERN/LEARNINGS rubrics quoted from live canonical docs) + a plan template. Use this to construct a split plan, then call `split_doc` to execute. Does NOT write anything itself. The plan template's instructions REQUIRE verbatim copy of source content — never reword.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "patch_section", description: "Replace the body of an existing H2 section (version-guarded). Either `heading` or `section_id` (from get_doc.sections[].id) must be provided — `section_id` is preferred when available because it's an exact match instead of a fuzzy heading-name lookup. If both are provided and resolve to different sections, returns `section_id_heading_mismatch`. Response includes `section_id` for chained edits. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", properties: { path: { type: "string" }, heading: { type: "string" }, section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." }, body: { type: "string" }, expected_content_hash: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body", "expected_content_hash"] } },
      { name: "write_doc_preview", description: "Preview the diff that write_doc would produce.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "write_doc", description: "Create or overwrite a markdown doc. DESTRUCTIVE — always run write_doc_preview first. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "content"] } },
      { name: "delete_doc", description: "Permanently delete a doc. DESTRUCTIVE — no undo. Returns inbound_edges (docs whose wiki-links will dangle) and title_conflicts (duplicate-title siblings). Call get_neighbors first if unsure.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "split_doc", description: "Atomically refactor a doc into concept nodes. Use when a doc has grown into multiple distinct reusable ideas — extract each into its own node with proper Child of / Parent of sections, then rewrite the source to wiki-link to them. Pre-flight checks block path and H1-title collisions before any writes. Build the extraction plan first (call get_doc to read, then design the new nodes), then call split_doc once to execute.", inputSchema: { type: "object", properties: { source_path: { type: "string" }, rewrite_source_content: { type: "string" }, extracts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }, required: ["source_path", "rewrite_source_content", "extracts"] } },
      { name: "rename_doc", description: "Rename a doc: rewrite its H1, move it to a new path (default: same directory, filename derived from the new title), and update every `[[old_title]]` wiki-link across the vault to point at the new title. Pre-flight checks block title and path collisions. DESTRUCTIVE — rewrites many docs in one call.", inputSchema: { type: "object", properties: { old_path: { type: "string" }, new_title: { type: "string" }, new_path: { type: "string" } }, required: ["old_path", "new_title"] } },
      { name: "patch_preamble", description: "Replace the body region between the H1 and the first H2 (the blockquote summary + any intro paragraphs). The H1 itself is untouched — use rename_doc to change the title. Version-guarded with expected_content_hash from a recent get_doc.preamble. Use this when load-bearing wiki-links sit in the summary or intro and patch_section can't reach them. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", properties: { path: { type: "string" }, body: { type: "string" }, expected_content_hash: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body", "expected_content_hash"] } },
      { name: "materialize_subgroup", description: "Promote an H3 subgroup inside a doc's `## Parent of` to a real intermediate parent doc. Use when a parent has accumulated too many children and they're already grouped semantically with H3 headings (lint surfaces these as `subgroup_materialization_candidate`). Atomically: creates the new intermediate doc with the subgroup's bullets as its `## Parent of`, replaces the H3 region in the source with a single bullet pointing at the intermediate, and rewires each affected child's `## Child of` from the old parent to the new intermediate. `new_doc_title` defaults to `<source title> — <subgroup heading>`; `new_doc_path` defaults to `<source dir>/<sanitized title>.md`.", inputSchema: { type: "object", properties: { source_path: { type: "string" }, subgroup_heading: { type: "string" }, new_doc_title: { type: "string" }, new_doc_path: { type: "string" }, summary: { type: "string" } }, required: ["source_path", "subgroup_heading"] } },
      { name: "create_child", description: "Atomic create-and-link: writes a new doc with the canonical scaffold (H1 + summary placeholder + Child of / Parent of / Associated with / Notes) AND patches the parent's `## Parent of` to add the new bullet. Collapses the 5-round-trip add-child flow into one call. Use this instead of write_doc + patch_section for adding child nodes. `child_path` defaults to `<parent dir>/<sanitized title>.md`. `summary` becomes `_summary pending_` placeholder if omitted. Pre-flight refuses if parent missing, child path occupied (with non-byte-equal content), or title collides. Pass `gate_on_warnings: [\"code\", ...]` to hard-block on lint codes; multiple_child_of is always hard-gated internally.", inputSchema: { type: "object", properties: { parent_path: { type: "string" }, title: { type: "string" }, body: { type: "string", description: "Optional body content appended after the scaffold's ## Notes header." }, summary: { type: "string", description: "Optional blockquote summary. Falls back to a placeholder." }, child_path: { type: "string", description: "Optional override for the new doc's path. Default: <parent_dir>/<sanitized_title>.md." }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["parent_path", "title"] } },
      { name: "add_association", description: "Atomic two-sided assoc: patches both docs' `## Associated with` to include the other (with optional shared label, identical on both bullets). Hard-refuses if the pair is already linked hierarchically (parent/child) OR if they share a parent (siblings) — returns `would_duplicate_hierarchy` with the existing edge info. Idempotent: if both sides already declare the assoc, returns ok with `a_updated: false, b_updated: false`. Use this instead of two patch_section calls for cross-tree links. Pass `gate_on_warnings: [\"code\", ...]` to hard-block on additional lint codes.", inputSchema: { type: "object", properties: { a_path: { type: "string" }, b_path: { type: "string" }, label: { type: "string", description: "Optional shared label appended as ` — <label>` to both bullets." }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on (in addition to associate_duplicates_hierarchy and sibling_assoc_redundant which are always hard-gated). Default []." } }, required: ["a_path", "b_path"] } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    const a = args ?? {};
    switch (name) {
      case "list_docs":         return await listDocs(ctx, a) as CallToolResult;
      case "get_summary":       return await getSummary(ctx, a) as CallToolResult;
      case "get_neighbors":     return await getNeighbors(ctx, a) as CallToolResult;
      case "get_context":       return await getContext(ctx, a) as CallToolResult;
      case "get_doc":           return await getDoc(ctx, a) as CallToolResult;
      case "search":            return await search(ctx, a) as CallToolResult;
      case "append_section":    return await appendSection(ctx, a) as CallToolResult;
      case "patch_section":     return await patchSection(ctx, a) as CallToolResult;
      case "write_doc_preview": return await writeDocPreview(ctx, a) as CallToolResult;
      case "write_doc":         return await writeDoc(ctx, a) as CallToolResult;
      case "delete_doc":        return await deleteDoc(ctx, a) as CallToolResult;
      case "split_doc":         return await splitDoc(ctx, a) as CallToolResult;
      case "rename_doc":        return await renameDoc(ctx, a) as CallToolResult;
      case "patch_preamble":    return await patchPreamble(ctx, a) as CallToolResult;
      case "append_doc":        return await appendDoc(ctx, a) as CallToolResult;
      case "lint_doc":          return await lintDoc(ctx, a) as CallToolResult;
      case "distill_doc":       return await distillDoc(ctx, a) as CallToolResult;
      case "materialize_subgroup": return await materializeSubgroup(ctx, a) as CallToolResult;
      case "create_child":      return await createChild(ctx, a) as CallToolResult;
      case "add_association":   return await addAssociation(ctx, a) as CallToolResult;
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
