# CLAUDE.md — EMDEE_OS (repo: `emdee`)

> This file is the bridge between **what the code does** (this repo) and **how we run the project** (the EMDEE vault at `projects/EMDEE_OS/`). Keep both in sync — code changes that imply process changes get logged into EMDEE in the same commit; process changes that imply code changes get reflected here in the same commit.

@AGENTS.md

## Source-of-truth split

| Question | Authority | How to read it |
|---|---|---|
| What does the code do, how do I run it, what file is where | **This repo** | Read the file, run the script |
| Why are we doing it, who's doing what, what's shipped vs queued, what rules govern the process | **EMDEE vault** → `projects/EMDEE_OS/` | Use the EMDEE MCP (`get_doc`, `list_docs`, etc.) |

CLAUDE.md never restates EMDEE's protocol — it points at it. When the answer is "see EMDEE," go to the vault.

## What this is

> Local-first knowledge graph + MCP server. Plain-markdown vault, React renderer for human reading, MCP for LLM consumption. The vault is the source of truth; the renderer is the human's lens onto it; the MCP is the LLM's lens onto the same bytes. (Source: `projects/EMDEE_OS.md` CONTEXT.)

## Stack

- **Next.js 16.2.6 (App Router) + React 19.2.4 + TypeScript 5** — webpack mode (`next dev --webpack`, `next build --webpack`), not turbopack. Heed deprecation notices in `node_modules/next/dist/docs/` before touching APIs that may have changed from your training data (see `AGENTS.md`).
- **Tailwind v4** (PostCSS-based, no `tailwind.config.js`)
- **ESLint 9** with `eslint-config-next`
- **Clerk** (`@clerk/nextjs` v7) for auth
- **Supabase** (`@supabase/supabase-js` v2 + `@supabase/ssr`) — Storage for canonical markdown, Postgres for `vault_files` cache + `doc_edges` materialised graph + OAuth tables + `mcp_activity`
- **MCP** (`@modelcontextprotocol/sdk` v1) — stdio server at `src/mcp/server.ts`, HTTP server at `app/api/mcp/route.ts`
- **Cytoscape.js** for the graph view
- **tsx** for one-off scripts
- **Package manager: npm** (`package-lock.json`). Node `>=20`.

## Commands

```bash
npm run dev        # next dev --webpack    — local renderer at http://localhost:3000
npm run build      # next build --webpack
npm run start      # next start
npm run lint       # eslint                — code-style + Next rules
npm run typecheck  # tsc --noEmit          — must be clean before any commit
npm run mcp        # tsx src/mcp/server.ts — stdio MCP server (for local Claude Code)
```

One-off scripts live in `scripts/` (run with `npx tsx scripts/<name>.ts` or `node scripts/<name>.mjs`). Repair examples:
- `npx tsx scripts/backfill-doc-edges.ts --namespace=<ns>` — rebuild `doc_edges` for one user
- `node scripts/backfill-vault-files.mjs` — repopulate the `vault_files` cache from Storage

<!-- TODO: no test runner found in package.json or repo configs. Definition of done currently relies on typecheck + lint + manual UI verification. Decide whether to adopt Vitest / Playwright before autonomous runs. -->

## 🚨 HARD RULES

Grounded rules an autonomous agent must never break. Each cites where it comes from.

1. **Never skip git hooks or signing** — `--no-verify`, `--no-gpg-sign`, etc. are off-limits unless the user explicitly asks. If a hook fails, fix the root cause and create a NEW commit. (Source: global Claude Code policy in this session.)
2. **Never run destructive git ops without explicit ask** — `git reset --hard`, `git push --force` to `main`, `git branch -D`, `git checkout -- .`. Pre-commit, check `git status` and `git diff` first.
3. **Never commit secrets.** Real env vars in scope (from `.env.example`):
   - `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_URL`
   - `BLOB_READ_WRITE_TOKEN`
   - `EMDEE_DOCS`
   `.gitignore` already excludes `.env*` — never `git add` an env file or hardcode any of these strings.
4. **Migration discipline.** Every schema change lives in a new file under `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` — never edit a shipped migration in place. Migrations are applied via the Supabase MCP `apply_migration` or the CLI; do not rewrite tables ad-hoc.
5. **Never run destructive DB ops without explicit ask** — `DROP TABLE`, `TRUNCATE`, mass `DELETE` without a `WHERE`. For pg_cron / RLS / extension changes, check `list_extensions` / `get_advisors` first.
6. **Pagination is mandatory for any `.select()` that could exceed 1000 rows.** Supabase / PostgREST enforces a server-side 1000-row cap that `.range()` cannot lift. The fix is explicit pagination — see `projects/EMDEE_OS/LEARNINGS.md` H2 *"Supabase enforces a 1000-row cap server-side that client `.range()` cannot override — paginate explicitly"*. Violating this re-introduces SPRINT-027 / SPRINT-028.
7. **Reciprocal edges in the vault.** When you write vault content via the MCP, use `create_child` / `add_association` / `materialize_subgroup` for new edges (they reciprocate both sides). If you're forced to use `patch_section` on a `## Child of`, also patch the new parent's `## Parent of` in the same turn. See LEARNINGS H2 *"When moving a child between parents, patch both sides."*
8. **One worktree per agent.** When parallelising work across agents, isolate via `git worktree add` so concurrent edits don't race on the same files. Don't share a checkout.
9. **Stay in the assigned module.** Sprint specs name a single primary module (e.g. `app/components/GraphViewInner.tsx`, `src/core/syncDocEdges.ts`). Don't drift into unrelated areas mid-sprint; if you find a real bug, log it to EMDEE (LEARNINGS or a new sprint stub) and continue the primary task.
10. **Write to the vault, not the chat.** Anything durable — a decision, a pattern, a hard-won fact — goes into a named doc in EMDEE immediately. Chat is ephemeral. (Source: LEARNINGS H2 *"Write to the vault, not to the chat."*)

### Deploy ceiling

**Autonomous agents push to the `agents` branch only.** Vercel ignores it by config (`vercel.json` → `git.deploymentEnabled.agents = false`), so an agent commit cannot reach production until a human reviews + merges `agents → main` (or `agents → dev → main`).

- **`main`** — production. Auto-deploys to emdee.vercel.app. Human-gated.
- **`dev`** — optional staging branch. Human-gated.
- **`agents`** — agent workspace. Vercel-ignored. Agents may push here freely; the deploy ceiling holds because no production traffic ever sees it.

Attended sessions (a human is in the loop, like this one) may still push to `main` directly when the user explicitly asks.

## Branch & commit conventions

- **Branches:** `main` (production, Vercel-deployed, human-gated), `dev` (optional staging, human-gated), `agents` (agent workspace, Vercel-ignored via `vercel.json`). `uat` is retired (memory `feedback_git_workflow.md`, 2026-05-14) — do not push to it.
- **Default agent target: `agents`.** Unattended runs commit + push there. A human reviews and promotes `agents → main` (or `agents → dev → main`) when ready.
- **Attended sessions** may push to `main` when the user explicitly asks (this session is one such case).
- **Deploy:** `main` auto-deploys to `emdee.vercel.app` via Vercel (no `.github/workflows/` — Vercel handles CI). `vercel.json` skips `agents`.
- **Commit messages:** present-tense, what + why. Each commit ends with a `Co-Authored-By: <model>` line when authored by an agent (see recent `git log` for the established style).
- **Commit cadence:** prefer new commits over `--amend`. Per-task atomic commits; multi-file refactors get one bundled commit if cohesive (see SPRINT-027 / SPRINT-028 for the established granularity).

## Sprint workflow

The authoritative protocol lives in EMDEE. CLAUDE.md only summarises:

- `projects/EMDEE_OS/BUILD.md` `## Active sprints` — what's in flight
- `projects/EMDEE_OS/BUILD.md` `## Next sprint backlog` — what's queued (currently SPRINT-020, 022, 023)
- `projects/EMDEE_OS/sprints/SPRINT-NNN.md` — full spec per sprint
- `projects/EMDEE_OS/LOGS.md` — shipped sprints (most recent: SPRINT-028 on 2026-05-26)
- `projects/EMDEE_OS/LEARNINGS.md` — distilled rules; read before starting work in a new area
- `projects/EMDEE_OS/INSTRUCTIONS.md` — *project-scoped operating protocol; read this first when starting a session*

<!-- TODO: projects/EMDEE_OS/INSTRUCTIONS.md is currently a stub — its sections contain placeholder text like `<How an agent should orient at the start of a session…>` rather than real protocol. Fill in Session start protocol / Writing discipline / Communication conventions / Roles before pointing autonomous runs at it. -->

When a sprint ships: move its bullet from BUILD's Active to LOGS, update BUILD's Status section, append any new LEARNINGS entry.

## Autonomous agent / Ralph protocol

### Preconditions

Before any unattended run:

1. **A written spec** at `projects/EMDEE_OS/sprints/SPRINT-NNN.md` with **explicit, testable acceptance criteria** (the SPRINT-028 spec is the current reference for shape: Why / Scope / Locked decisions / Technical breakdown / Acceptance / Risks / Dependencies).
2. **A single named module** the agent owns for the sprint duration (one file or one cohesive folder).
3. **Agent commits land on the `agents` branch only** (deploy ceiling — see Branch & commit conventions). Vercel ignores it; humans promote to `main`.
4. **`projects/EMDEE_OS/INSTRUCTIONS.md` is non-stub** — see TODO in Sprint Workflow.

### Definition of done (every autonomous iteration)

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm run build` — clean (catches Next-config + runtime issues `tsc` doesn't)
- No files changed outside the assigned module (`git diff --name-only` matches the spec's scope)
- Migrations, if any, exist as new files under `supabase/migrations/` (never edited in place)
- Vault state: BUILD/LOGS/LEARNINGS updated if the change earns it
- Commit on the agent-allowed branch (see deploy-ceiling TODO), never on the protected one

<!-- TODO: add a test-runner gate to Definition of Done once tests exist. -->

### Safety rails

- Mandatory `--max-iterations` on Ralph-style loops. Bail early if the same file is rewritten twice with no diff convergence.
- STOP on any HARD-RULE collision. Don't try to work around a rule — flag it instead.
- Don't run `npm install`, `npx supabase migration apply`, or any other state-changing command without explicit go-ahead unless it's already in the sprint spec.

### Flagging blockers

When unattended work hits a wall, surface it loudly in EMDEE — silent failure is worse than loud:

- For *in-flight sprint blockers:* patch `projects/EMDEE_OS/BUILD.md` `## Status` with `BLOCKED — <one-line cause>` and a wiki-link to the sprint file. The sprint file itself gets a `## Blockers` section appended with what was attempted, what's blocking, what would unblock, current branch + commit SHA.
- For *new bugs discovered mid-sprint that aren't the primary task:* append a one-line entry to `projects/EMDEE_OS/LEARNINGS.md` (if a generalisable rule) OR create a stub sprint file under `sprints/` and add it to BUILD's `## Next sprint backlog` (if it needs its own work).
- For *vault-shape problems* (asymmetric edges, missing parents, etc.): run `lint_doc` first and capture the warning codes in the flag.

## Directory map

```
app/                         Next.js App Router
├── [userId]/                Per-user vault renderer (catch-all route)
├── admin/                   Admin tools (gated)
├── api/                     Route handlers — /api/index, /api/mcp, /api/shared, etc.
├── components/              GraphViewInner.tsx, DocTree.tsx, App.tsx, etc.
├── cloud-link/              "Connect to Claude.ai" landing page
├── me/                      Personal namespace shortcut
├── oauth/                   /oauth/authorize page (PKCE flow for claude.ai connector)
├── share/                   Public share-link landing pages
├── sign-in/                 Clerk sign-in
├── globals.css              Tailwind v4 + sidebar/graph styles
├── layout.tsx               Root layout (Clerk provider)
└── page.tsx                 Public vault entry (/)

src/
├── core/                    Pure logic — indexer, parseEdges, resolveLink, syncDocEdges, siblings
├── lib/
│   ├── storage/             VaultStorage interface + FilesystemStorage + SupabaseStorage
│   ├── supabase/            adminClient, oauth helpers, cache-bust
│   ├── mcp/                 MCP tool implementations (get_doc, patch_section, create_child, lint, etc.)
│   └── cache/               bustVaultCache + tags
└── mcp/                     server.ts — stdio MCP server entrypoint

scripts/                     One-off ops: backfills, renames, seeds (npx tsx <file>.ts)
supabase/migrations/         7 migrations, numbered chronologically (never edit in place)
templates/                   Doc templates seeded into new vaults (PROJECT, NOVEL, PERSON, etc.)
public/                      Seeded vault content copied into every new user namespace
bin/emdee.js                 CLI entry (`emdee init`, `emdee serve`, `emdee mcp`)
docs/                        Local-dev vault (gitignored)
```

## Definition of done — every change

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run build` clean (skip only for vault-only changes that don't touch code)
- [ ] Manual UI verification of the changed surface (run `npm run dev`, exercise the feature)
- [ ] Migrations, if any, are new files under `supabase/migrations/`
- [ ] Vault updated in the same commit: BUILD/LOGS/LEARNINGS as appropriate
- [ ] `git diff --name-only` matches the intent (no accidental drift)
- [ ] Commit message states what + why; co-author trailer if agent-authored
- [ ] Pushed to the right branch — `agents` for unattended runs, `main` for attended human-approved commits (see Branch & commit conventions)
