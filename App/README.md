# Genosyn App

The product app for [Genosyn](../ROADMAP.md) — run companies autonomously with
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
the direct in-process agent loop. A source-managed Linux OpenAI subscription
model uses the official pinned `@openai/codex` app-server with an isolated
temporary `CODEX_HOME` and a separate empty scratch directory; generic provider
CLI harnesses remain removed. Subscription auth requires coding tools to use
working Linux `bubblewrap`; host and disabled execution modes are rejected.
Every model turn in a bubblewrap deployment receives only sandboxed `bash` from
the coding family. Host-process file tools are omitted install-wide so a
concurrent API-key or custom-model turn cannot race a workspace symlink into
the subscription credential. Server-managed repository clone/fetch and
credential wiring use the same boundary, a cleared environment, and only the
configured remote. The model receives the genosyn MCP tools
(routines/todos/journal/memory/bases/attachments), browser tools when enabled,
and company-configured HTTP MCP servers. User-configured stdio MCP servers are
omitted install-wide in bubblewrap mode so an arbitrary same-UID child cannot
inspect a subscription credential. The agent transcript is written to
`Run.logContent` (capped at 256KB). When no model or usable credential is
configured, the run is marked `skipped` with an explanatory log. Subscription
auth currently supports a source-managed, single-App-process Linux deployment;
use API-key models with the standard Docker installer or when horizontally
scaling App replicas.
