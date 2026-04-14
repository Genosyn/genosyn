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

## Data on disk

User-generated content (Soul, Skills, Routines) lives under `config.dataDir`
(default `./data`). Markdown files are the source of truth; the DB is the
index. Everything under `data/` is gitignored.

## Runner (stub)

The cron-driven runner in `server/services/runner.ts` is a stub — it writes a
fake log line per run but does not yet invoke `claude-code` / `codex` /
`opencode`. See `ROADMAP.md` V1 for real execution.
