# Genosyn App

The product app for [Genosyn](../README.md) — run companies autonomously with
AI employees. Self-hostable. Open source.

Stack: Express + TypeORM (SQLite by default, Postgres via a config flip) on the
backend; React 18 + Vite + Tailwind on the frontend. No Next.js, no JWT libs,
no `.env` — runtime settings live in `config.ts`.

## How to run

```bash
npm install
npm run dev
```

- App runs on `http://localhost:8471` (API + UI, Vite mounted as Express
  middleware in dev — same process, same port as prod)

Open http://localhost:8471 and sign up.

## Production build

```bash
npm run build
npm start
```

The server serves the built client from `dist/client/` at `http://localhost:8471`.

## Required scripts

- `npm run dev` — tsx watch on server, Vite mounted as middleware in-process
- `npm run build` — tsc server + vite build client
- `npm run start` — run compiled `dist/server/index.js`
- `npm run lint` — ESLint over `server/` and `client/`
- `npm run typecheck` — tsc no-emit for server and client

## Config

Edit `config.ts` directly. No `.env` files. To switch to Postgres, change
`config.db.driver` to `"postgres"` and fill `config.db.postgresUrl`.

## SMTP fallback

If `config.smtp.host` is empty, Genosyn does **not** send emails. Instead,
welcome / password-reset / invitation messages are logged to the server
console with the prefix `[email:skipped]`. Use this for local development.

## Data storage

User-generated content (Soul, Skills, Routines, Run logs) lives in the DB.
With the default driver that's `./data/app.sqlite`; flip
`config.db.driver` to `postgres` and everything (entities + migrations) moves
with you. Model credentials are entered in the app and stored encrypted
(AES-256-GCM) in the DB — never in an employee working directory or a
persistent provider directory. OpenAI subscription device login and Runs use a
locked temporary `CODEX_HOME` required by the official Codex app-server. A
managed ChatGPT session is materialized there; an access token is injected only
into the child process environment. The directory is removed afterward. The
filesystem side of `config.dataDir` only holds artifacts an employee writes
into its working directory. Everything under `data/` is gitignored.

## Runner

The cron-driven runner in `server/services/runner.ts` drives the employee's
active model with a prompt composed from their Soul + Skills + Routine.
Anthropic and OpenAI API keys, plus OpenAI-compatible custom endpoints, use
the pinned OpenCode 1.18.31 binary and SDK. OpenCode manages model turns,
tool execution, and context compaction; Genosyn supplies the company context,
Grants, Approvals, and domain tools and persists the transcript and work state.
The default `host` execution mode enables OpenCode's native coding tools for
ordinary employee work, including shell commands. AI Employee commands —
OpenCode's native coding tools, Genosyn's command tools, Repository
work-session commands, command Checks, and server-managed Git — run directly on
the host (inside the App container when using Docker) with the App process
user's filesystem and network authority. A working directory, tool permission,
command allowlist, or Grant is not an OS sandbox, and no Docker security
options are required. `disabled` exposes no coding tools and materializes no
employee repositories. A config that still selects the removed `bubblewrap`
mode starts with command execution disabled and logs a warning. Restricted
review turns also omit native coding. Repository work sessions receive only
`repository_*` tools, retaining their own worktrees, command policy, review,
and delivery lifecycle.

An OpenAI subscription model continues to use the official pinned
`@openai/codex` app-server with a locked temporary `CODEX_HOME` and a separate
empty scratch directory, in host or disabled mode. Subscription coding uses
Genosyn's coding wrappers in host mode. Model credentials remain encrypted on
the AI Model row. API-key requests pass through a per-turn Genosyn proxy, so
OpenCode receives only a disposable proxy token. Runtime authentication and state are temporary and never
stored in employee working directories. Genosyn provides the product tools
(Routines/Todos/Journal/Memory/Bases/attachments), browser tools when enabled,
and company-configured HTTP MCP servers. User-configured stdio MCP servers run
in host mode and are omitted in disabled mode. The agent transcript is written
to `Run.logContent` (capped at 256KB). When no model or usable credential
is configured, the run is marked `skipped` with an explanatory log. Subscription
auth supports one App process; use API-key models when horizontally scaling App
replicas.
