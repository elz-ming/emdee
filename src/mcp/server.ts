import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import {
  listDocs,
  getSummary,
  getNeighbors,
  getContext,
  getDoc,
  readDocSection,
  search,
  appendSection,
  patchSection,
  writeDocPreview,
  writeDoc,
  createChild,
  addAssociation,
} from "../lib/mcp/tools/index.js";
import type { ToolContext } from "../lib/mcp/tools/types.js";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));
const ctx: ToolContext = { mode: "local", docsDir };

const server = new Server(
  {
    name: "emdee",
    version: "0.0.1",
  },
  {
    capabilities: { tools: {} },
    instructions: `You are working inside a Emdee vault — a plain-markdown knowledge graph.

BEFORE writing or editing any doc:
1. Call get_doc("INFO.md") to load vault conventions (doc structure, naming rules, relationship sections).
2. If working on a specific project, call get_doc on that project's INSTRUCTIONS.md first (e.g. get_doc("projects/ATLAS/INSTRUCTIONS.md")).
3. Use patch_section for incremental edits — never write_doc for single-section changes.

Key conventions:
- Every doc starts with one H1 + one > blockquote summary immediately below it. No summary = invisible to get_summary.
- Sprints: Child of [[PROJECT — BUILD]] if active/spec, Child of [[PROJECT — LOGS]] if shipped. Change this when a sprint closes.
- Learnings: individual files under learnings/, Child of [[PROJECT — LEARNINGS]]. LEARNINGS.md is a thin index only.
- Relationships: Parent of / Child of = taxonomy. Associated with = everything else.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_docs",
      description:
        "Enumerate every doc in the vault as {path, title, summary}. Cheap entry point — call this first when starting cold to see what exists.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_summary",
      description:
        "Return {path, title, summary} for one doc. Use this when you know which doc to look at but don't want to spend tokens on the full body yet.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path of the doc, e.g. people/KIRAN.md" } },
        required: ["path"],
      },
    },
    {
      name: "get_neighbors",
      description:
        "Return the doc plus its 1-hop neighborhood, categorized by relationship type. Each neighbor is {path, title, summary, note}. `note` is the prose written next to the wiki-link on the declaring side — read it for relationship context. Also returns `mentioned_in`: docs that reference this one in prose without declaring a relationship.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "get_context",
      description:
        "Return the focal doc plus its multi-hop neighbourhood within a token budget. Focal + 1-hop neighbours get full bodies (when include_full=true); deeper hops get summary only. Response includes `doc_content_hash` (hash of the FOCAL doc raw content). Pass `expected_content_hash` from a prior call to short-circuit when the focal hasn't changed (returns `{ unchanged: true, path, doc_content_hash }` — note that neighbourhood changes don't bust this; refetch unconditionally if you're chasing a structural change). Nodes that don't fit in budget_tokens land in budget.dropped_paths. Use this instead of chaining get_doc + get_neighbors when you need a coherent local view of one doc and what surrounds it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          hops: { type: "number", description: "Max BFS depth, 1–3. Default 2." },
          budget_tokens: { type: "number", description: "Rough token cap (chars÷4). Default 8000." },
          include_full: { type: "boolean", description: "Inline focal + hop-1 bodies. Default true." },
          include_associates: { type: "boolean", description: "Include assoc edges in the walk. Default true." },
          expected_content_hash: { type: "string", description: "Hash from a prior get_context. If matches focal doc, returns { unchanged: true }." },
        },
        required: ["path"],
      },
    },
    {
      name: "get_doc",
      description:
        "Returns title + summary + preamble + section headings + `doc_content_hash` (sha256 of raw content, first 16 hex). Each section in `sections` carries `{ id, heading, content_hash }` — `id` is a stable short string for patch_section / append_section lookup (preferred over `heading` when the heading text is fuzzy or may collide), `content_hash` is the version guard for patch_section. Pass `full=true` for the body. Pass `expected_content_hash` from a prior get_doc response to short-circuit: when matching, returns `{ unchanged: true, path, doc_content_hash }` and skips section parsing entirely. Use `get_context` instead when you need the focal + its neighbourhood.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          full: { type: "boolean", description: "Include the full markdown content. Default false — light envelope only." },
          expected_content_hash: { type: "string", description: "Hash from a prior get_doc response. If matches current doc, returns { unchanged: true }." },
        },
        required: ["path"],
      },
    },
    {
      name: "read_doc_section",
      description:
        "Read one H2 section's body without paying for the whole doc. Returns `{ path, section_id, heading, body, content_hash }`. Either `heading` or `section_id` (from get_doc.sections[].id) must be provided — `section_id` is preferred when available because it's an exact match instead of a fuzzy heading-name lookup. Mismatch returns `section_id_heading_mismatch`. Pass `expected_content_hash` from a prior read to short-circuit: when matching, returns `{ unchanged: true, section_id, content_hash }`. Use this instead of get_doc(full=true) when you only need one section.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          heading: { type: "string" },
          section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." },
          expected_content_hash: { type: "string", description: "Hash from a prior read. If matches, returns { unchanged: true }." },
        },
        required: ["path"],
      },
    },
    {
      name: "search",
      description:
        "Case-insensitive substring search over titles, summaries, and full content. Returns top matches as {path, title, summary, snippet}. Use this for cold starts when there is no known path.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "append_section",
      description:
        "Append markdown content to the end of an existing H2 section. Section-scoped — safer than write_doc for incremental edits. Either `heading` or `section_id` (from get_doc.sections[].id) must be provided — `section_id` is the preferred exact-match lookup. Pass create_if_missing=true (with `heading`) to add a new H2 at the end of the file if not found (default false, returns section_not_found). Returns the new section_id + content_hash for follow-up patches. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content. Edge convention: `## Associated with` is for cross-tree links only (e.g. project↔person, sprint↔learning). Do NOT add an associate that's already a parent/child OR a sibling (shares a parent) of this doc — the hierarchy already conveys that relationship and duplicate edges get suppressed in the graph.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          heading: { type: "string", description: "H2 heading text without the `## ` prefix" },
          section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." },
          body: { type: "string", description: "Markdown body to append to the section" },
          create_if_missing: {
            type: "boolean",
            description: "If true, create the section at end of file when heading is not found. Default false.",
          },
          gate_on_warnings: {
            type: "array", items: { type: "string" },
            description: "Lint codes that hard-block the write when they would fire on the proposed content. Default [].",
          },
        },
        required: ["path", "body"],
      },
    },
    {
      name: "patch_section",
      description:
        "Replace the body of an existing H2 section. Version-guarded: pass expected_content_hash from a prior get_doc, append_section, or patch_section response. Either `heading` or `section_id` (from get_doc.sections[].id) must be provided — `section_id` is the preferred exact-match lookup. If both are provided and resolve to different sections, returns `section_id_heading_mismatch`. Mismatch on the hash returns a structured version_conflict error with the actual hash so you can re-read and reconcile. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content. This is the ONLY safe path for destructive section edits — never use write_doc for incremental edits, it replaces the entire file and silently loses content. Edge convention: `## Associated with` is for cross-tree links only. Do NOT add an associate that's already a parent/child OR a sibling (shares a parent) — the hierarchy already conveys that relationship and duplicate edges get suppressed in the graph.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          heading: { type: "string", description: "H2 heading text without the `## ` prefix" },
          section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." },
          body: { type: "string", description: "New body content for the section" },
          expected_content_hash: {
            type: "string",
            description: "Short hash of the section's current body (from get_doc.sections or a previous mutation's response).",
          },
          gate_on_warnings: {
            type: "array", items: { type: "string" },
            description: "Lint codes that hard-block the write when they would fire on the proposed content. Default [].",
          },
        },
        required: ["path", "body", "expected_content_hash"],
      },
    },
    {
      name: "write_doc_preview",
      description:
        "Preview the diff that write_doc would produce. ALWAYS call this before write_doc — write_doc replaces the entire file and silently destroys sections not present in the new payload. If the change is section-scoped, prefer append_section or patch_section instead.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Proposed new content for the entire file" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "write_doc",
      description:
        "Create or overwrite a markdown doc at the given relative path. DESTRUCTIVE — full-file replacement, silently deletes any content not in the new payload. Use append_section or patch_section for incremental edits. Always run write_doc_preview first to see what would be lost. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content. Edge convention: `## Associated with` is for cross-tree links only. Do NOT add an associate that's already a parent/child OR a sibling (shares a parent) — the hierarchy already conveys that relationship and duplicate edges get suppressed in the graph.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          gate_on_warnings: {
            type: "array", items: { type: "string" },
            description: "Lint codes that hard-block the write when they would fire on the proposed content. Default [].",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "create_child",
      description:
        "Atomic create-and-link: writes a new doc with the canonical scaffold (H1 + summary placeholder + Child of / Parent of / Associated with / Notes) AND patches the parent's `## Parent of` to add the new bullet. Collapses the 5-round-trip add-child flow into one call. Use this instead of write_doc + patch_section for adding child nodes. `child_path` defaults to `<parent dir>/<sanitized title>.md`. Pass `gate_on_warnings` to hard-block on lint codes; multiple_child_of is always hard-gated internally.",
      inputSchema: {
        type: "object",
        properties: {
          parent_path: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "Optional body content appended after ## Notes." },
          summary: { type: "string", description: "Optional blockquote summary; placeholder if omitted." },
          child_path: { type: "string", description: "Optional path override. Default: <parent dir>/<sanitized title>.md." },
          gate_on_warnings: {
            type: "array", items: { type: "string" },
            description: "Lint codes to hard-block on. Default [].",
          },
        },
        required: ["parent_path", "title"],
      },
    },
    {
      name: "add_association",
      description:
        "Atomic two-sided assoc: patches both docs' `## Associated with` to include the other (with optional shared label, identical on both bullets). Hard-refuses if the pair is already linked hierarchically OR if they share a parent (siblings) — returns `would_duplicate_hierarchy` with the existing edge info. Idempotent: if both sides already declare the assoc, returns ok with `a_updated: false, b_updated: false`. Use this instead of two patch_section calls for cross-tree links.",
      inputSchema: {
        type: "object",
        properties: {
          a_path: { type: "string" },
          b_path: { type: "string" },
          label: { type: "string", description: "Optional shared label appended as ` — <label>` to both bullets." },
          gate_on_warnings: {
            type: "array", items: { type: "string" },
            description: "Lint codes to hard-block on (in addition to associate_duplicates_hierarchy and sibling_assoc_redundant which are always hard-gated). Default [].",
          },
        },
        required: ["a_path", "b_path"],
      },
    },
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
    case "read_doc_section":  return await readDocSection(ctx, a) as CallToolResult;
    case "search":            return await search(ctx, a) as CallToolResult;
    case "append_section":    return await appendSection(ctx, a) as CallToolResult;
    case "patch_section":     return await patchSection(ctx, a) as CallToolResult;
    case "write_doc_preview": return await writeDocPreview(ctx, a) as CallToolResult;
    case "write_doc":         return await writeDoc(ctx, a) as CallToolResult;
    case "create_child":      return await createChild(ctx, a) as CallToolResult;
    case "add_association":   return await addAssociation(ctx, a) as CallToolResult;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
