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
(AES-256-GCM) in the DB — never on disk — so the filesystem side of
`config.dataDir` only holds any artifacts an employee writes into its working
directory. Everything under `data/` is gitignored.

## Runner

The cron-driven runner in `server/services/runner.ts` drives an in-process
agent loop that talks directly to the employee's model API (Anthropic, OpenAI,
or any OpenAI-compatible custom endpoint) with a prompt composed from the
employee's Soul + Skills + Routine. The loop hands the model tools directly:
built-in coding tools (bash, read_file, write_file, edit_file, glob, grep),
the genosyn MCP tools (routines/todos/journal/memory/bases/attachments),
browser tools when enabled, and any company-configured MCP servers. The agent
transcript is written to `Run.logContent` (capped at 256KB). When no model or
API key is configured, the run is marked `skipped` with an explanatory log.
