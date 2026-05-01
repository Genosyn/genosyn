# AGENTS.md — Guide for AI coding agents working on Genosyn

> If you are Claude Code, Codex, opencode, goose, Cursor, Aider, or any
> other AI agent touching this repo, read this file first. It is the single
> source of truth for how to work here.

---

## 1. What Genosyn is

Genosyn is an **open-source, self-hostable platform for running companies
autonomously with AI employees**.

- A **Company** has human **Members** and **AI Employees**.
- Every **AI Employee** has a **Soul** (the employee's constitution), a set of
  **Skills** (playbooks), and **Routines** (scheduled cron-driven work). All
  three are plain markdown stored on the employee / skill / routine DB rows —
  there are no `SOUL.md` / `README.md` files on disk any more.
- Each company can register multiple **AI Models** (`claude-code`, `codex`,
  `opencode`, `goose`, `openclaw` with custom model) and assign them to
  employees.

Read `ROADMAP.md` for the full vocabulary, milestones, and backlog. **Do not
duplicate content from ROADMAP.md here** — link to it.

---

## 2. Repo layout

```
genosyn/
├── App/         # Product app: Express + TypeORM + React + Vite + Tailwind
├── Home/        # Standalone marketing site (React + Vite + Tailwind)
├── CLI/         # `genosyn` cluster-maintainer CLI (bash). Served from the
│                # Home site at /install.sh and /genosyn via a sync step in
│                # Home's predev/prebuild scripts.
├── ROADMAP.md   # The plan. Edit freely.
├── AGENTS.md    # This file.
└── CLAUDE.md    # Pointer to this file.
```

Agents should never invent a new top-level folder without updating this file
and `ROADMAP.md`.

### About `CLI/`

`CLI/genosyn` and `CLI/install.sh` are the canonical source. Shell is the
right medium here — the CLI wraps `docker` on the operator's host, runs with
no Node dependency, and ships as a single file. The TypeScript-only rule
covers the product code in `App/` and `Home/`; it does not extend to the
operator CLI.

Both files are copied into `Home/client/public/` by Home's `sync-cli`
npm script (wired into `predev` and `prebuild`), so editing `CLI/` is the
single source of truth. Bump `CLI_VERSION` in `CLI/genosyn` when you ship a
change users should notice.

Because `sync-cli` reads from `../CLI/`, **Home's Docker image must be built
with the repo root as the build context** (not `./Home`). `Home/Dockerfile`
mirrors the repo layout inside the image at `/build/Home` + `/build/CLI` so
the relative path resolves the same way as local dev.
`.github/workflows/docker.yml` sets `context: .` for the Home matrix entry
and `context: ./App` for App. If you rename `CLI/`, update **all three**:
the sync script, the Dockerfile, and the workflow matrix.

---

## 3. Naming — get this right

This project has a **deliberate vocabulary**. Use these words consistently in
code, UI copy, commits, and docs.

| ✅ Use | ❌ Do not use |
| --- | --- |
| **Routine** (scheduled recurring AI work) | Task, Job, Cron, Workflow |
| **Soul** (employee constitution — `AIEmployee.soulBody` in the DB) | Persona, Prompt, System prompt |
| **Skill** (playbook — `Skill.body` in the DB) | Tool, Capability, Function |
| **AI Employee** | Agent, Bot, Assistant (in product copy) |
| **AI Model** (backend brain record) | Provider, LLM config |
| **Member** (human user in a company) | User (in product copy; `User` is fine as the DB entity name) |
| **Run** (one execution of a Routine) | Execution, Invocation |
| **Integration** (a connector type: Stripe, Gmail, …; static in code) | Provider, Plugin, Service (in product copy) |
| **Connection** (one authenticated account inside an Integration; DB row) | Account, Instance, Integration (of the DB row) |
| **Grant** (an AI employee's access to a Connection) | Permission, Attachment, Binding |

**"Tasks" is reserved** for a future task-manager feature (Projects + Todos).
Do not use "Task" for scheduled AI work, ever.

---

## 4. Tech stack — non-negotiables

- **Language:** TypeScript everywhere. No plain JS files.
- **Backend:** Express. Do **not** introduce Nest, Fastify, tRPC, etc.
- **ORM:** **TypeORM**. SQLite driver today, Postgres driver later via config.
  Do not add a second ORM or raw SQL query builder.
- **Frontend:** React 18 + Vite + TailwindCSS + React Router + lucide-react.
  Do **not** introduce Next.js, Remix, Redux, MUI, Chakra, shadcn-as-a-dep
  (copying a few primitives is fine), or CSS-in-JS.
- **Auth:** bcrypt + `cookie-session`. No JWT libraries, no Auth0/Clerk.
- **Email:** per-company `EmailProvider` rows pick the transport (SMTP via
  `nodemailer`, or SendGrid / Mailgun / Resend / Postmark via REST). Falls
  back to the global SMTP block in `config.ts` for system-level sends, then
  to the console. Every send appends an `EmailLog` row visible at
  Settings → Email Logs.
- **Cron:** `node-cron`.
- **Validation:** `zod` at the API boundary.
- **No Next.js.** Listed twice because agents keep reaching for it.

Before adding any new dependency, ask: does `ROADMAP.md` already imply it? If
not, flag the addition in the PR description.

---

## 5. Config

All runtime settings live in `App/config.ts` as a single exported object with
**commented JSON-shape**. There is **no `.env` file** in this project — do not
introduce `dotenv`, `config-yaml`, `.env.*`, or per-environment config files.
One file (`config.ts`), one object, comments above each field. Users who want
to override values edit `config.ts` directly.

Users flip `config.db.driver` from `"sqlite"` to `"postgres"` to upgrade.
Entities and migrations must work on both.

---

## 6. Data on disk

Everything user-generated lives under `config.dataDir` (default `./data`):

```
data/
├── app.sqlite
└── companies/<company-slug>/employees/<emp-slug>/
    ├── .claude/ .codex/ .opencode/ .goose/ .openclaw/   # per-employee provider creds
    ├── .mcp.json                                          # materialized before every spawn
    └── …                                                  # whatever the CLI writes into cwd
```

- **The database is the source of truth** for Soul, Skill, and Routine prose
  (`AIEmployee.soulBody`, `Skill.body`, `Routine.body`) and for captured
  Run logs (`Run.logContent`). Do not reintroduce `SOUL.md` /
  `skills/<slug>/README.md` / `routines/<slug>/README.md` on disk.
- What stays on disk is the runtime surface the provider CLI needs: the
  per-employee credentials directories (`.claude`, `.codex`, `.opencode`,
  `.goose`, `.openclaw`), the provider-specific MCP config we materialize
  before each spawn, and any artifacts the CLI writes into its cwd. Each
  provider has its own config shape and file location; every provider
  always includes a built-in `genosyn` server so the employee can call
  back into Genosyn to create Routines, Todos, journal notes, etc.:
    * **claude-code** → `.mcp.json` at the employee's cwd
    * **codex** → `$CODEX_HOME/config.toml` with `[mcp_servers.<name>]`
      blocks (HTTP-transport external servers are skipped with a note,
      since codex only supports stdio)
    * **opencode** → `opencode.json` at the cwd with `mcp.<name>` entries
    * **goose** → no file is written; servers are passed as runtime CLI
      flags (`--with-extension`, `--with-streamable-http-extension`) so we
      don't fight with whatever `goose configure` wrote into the same
      `config.yaml`
    * **openclaw** → `mcp.servers.<name>` block inside `openclaw.json`
      pointed at by `OPENCLAW_CONFIG_PATH`. The file holds non-MCP config
      (model defaults, gateway, channels) too, so we read-merge-write —
      preserving everything outside `mcp.servers` and overlaying our
      managed entries on top. Operator can run `OPENCLAW_CONFIG_PATH=…
      OPENCLAW_STATE_DIR=… openclaw onboard` once per employee dir to
      seed model defaults, or rely on OpenClaw's built-in defaults.
- The `data/` directory is gitignored. Never commit anything inside it.
- Slugs are derived once at create-time via `slugify`; renames update the
  display name but not the slug (so URLs and credential paths stay stable).

---

## 7. Code conventions

- **Modules are small and single-purpose.** A route file handles HTTP; it
  delegates to a service in `server/services/`.
- **No business logic in route handlers** beyond request parsing + response
  shaping.
- **Every new route** gets a zod schema for body/query/params.
- **Every new entity** gets a TypeORM migration. Never mutate an existing
  migration after it has been committed.
- **React components**: function components + hooks only. Co-locate small
  components with their page; promote to `components/` only when reused.
- **Styling**: Tailwind utility classes. Extract a component before you
  extract a class. No inline `style={}` unless truly dynamic.
- **Icons**: `lucide-react` only.
- **Imports**: absolute paths from `@/` (set up in `tsconfig.json` +
  `vite.config.ts`).
- **Lint/format**: project ships with ESLint + Prettier defaults. **Run
  `npm run lint` in both `App/` and `Home/` before you commit** — CI runs
  the same command and rejects any errors. Warnings are tolerated; errors
  are not. Recurring traps that keep breaking CI:
  - **JSX text with `'` or `"`** trips `react/no-unescaped-entities`. Use
    `&apos;` / `&quot;` (or wrap the text in a `{"..."}` JS expression).
    Applies to apostrophes in contractions (`you'll`, `don't`) and quoted
    phrases inside JSX children.
  - **`while (true)`** trips `no-constant-condition`. Use `for (;;)` for
    intentional infinite loops.
  - **Ternary used as a statement** (`cond ? a() : b();`) trips
    `@typescript-eslint/no-unused-expressions`. Use `if (cond) a(); else b();`.
  - **Arrays built with `.push()`** should be declared `const`, not `let`.
    The `prefer-const` rule fires on any binding that is never reassigned.
  - Unused imports / args — either remove them or rename to `_name` (the
    unused-vars rule allows `^_` prefix).
- **Required npm scripts** (both `App/` and `Home/` must implement these,
  CI depends on them): `dev`, `build`, `lint`, `typecheck`, `start`.
  App additionally exposes: `typeorm`, `migration:generate`,
  `migration:run`, `migration:revert`, `migration:show`, `migration:create`.
- **Runtime:** Node 22 (LTS). Pinned in `.nvmrc`, both `Dockerfile`s, and
  CI. Do not downgrade.
- **Build output layout** (Dockerfiles depend on this):
  - App: server compiled to `dist/server/index.js`, client assets under
    `dist/client/` (served by the Express process).
  - Home: `dist/server.js` serving built client assets.
- **Schema changes require a migration, and migrations are NEVER
  hand-written.** `synchronize` is off. After editing entities, run
  `npm run migration:generate -- server/db/migrations/<Name>` and commit
  the generated file as-is. The CLI diffs your entity changes against the
  current local DB and emits the SQL for you — do not write the
  `up()` / `down()` bodies yourself, and do not "tidy up" the generated
  output. Boot calls `AppDataSource.runMigrations()` so pending migrations
  apply on startup. Never edit a migration that has already been
  committed; if you got the schema wrong, write a follow-up migration.
  - If `migration:generate` complains that the binary is stale (the
    `NODE_MODULE_VERSION` mismatch on `better-sqlite3`), run
    `npm rebuild better-sqlite3` once and try again.
  - The current local DB must already be migrated to head before you
    generate (`npm run migration:run`), otherwise the diff will include
    work from earlier branches.

---

## 8. UI principles

Think **Linear × Notion**. Clean, quiet, fast.

- Neutral palette (slate/stone), one accent color, generous whitespace.
- `rounded-xl`, subtle `border`, soft shadow `shadow-sm`. No heavy gradients,
  no glassmorphism, no emoji decoration in product chrome.
- Inter (or the system sans stack) for body; tabular-nums for numeric data.
- Empty states always exist. Loading states always exist. Error toasts
  always exist.
- Mobile-responsive is expected, not optional.

---

## 9. Testing before you hand off

The human explicitly asked for browser-tested flows. Before claiming a
milestone is done, drive the happy path in a browser (via the `browse` /
`gstack` skill or manual) and catch at least:

- Signup → login → logout round-trip
- Create company → switch company → invite member
- Create AI employee → edit Soul → add skill → add routine → assign model
- Forgot password flow (when SMTP unset, check that the reset link logs to
  server console)

---

## 10. Commits & PRs

- Commit messages: imperative mood, 1–3 sentence body explaining *why* the
  change exists, not *what* it does.
- One logical change per commit where practical.
- Never use `--no-verify`, `--no-gpg-sign`, or `--amend` on a commit that
  has already been pushed.
- Never commit anything under `data/` or `node_modules/`.
- PR descriptions reference the milestone (`M3 — AI Employees + Soul`) from
  `ROADMAP.md` and list the manual test steps you ran.

### Releases

Cutting a release is a separate, tightly-scripted ritual — see
[`RELEASING.md`](./RELEASING.md). Short version: bump `VERSION`, push
`main` to `release`, the workflow tags + publishes GHCR images for you.
Don't tag manually, don't edit version numbers in `package.json` files.

---

## 11. Things that will get your PR rejected

- Introducing Next.js, JWT libraries, Prisma/Drizzle, or a component library
  without prior discussion.
- Using "Task" to mean a scheduled AI routine.
- Committing files under `data/`.
- Writing business logic inside route handlers.
- Reintroducing on-disk `SOUL.md` / skill / routine markdown files. Soul,
  skill, and routine bodies live on their DB rows; run logs live on the
  Run row. The filesystem under `data/` is only for provider credentials,
  `.mcp.json`, and CLI artifacts.
- Naming a user-configurable MCP server `genosyn`. The name is reserved for
  the built-in stdio binary at `server/mcp-genosyn/`. User-configured
  servers with that name are dropped when `.mcp.json` is materialized.
- Skipping the zod schema on a new endpoint.
- Hand-writing a migration file. Always run
  `npm run migration:generate -- server/db/migrations/<Name>` and commit
  what it emits. See section 7.
- Adding a feature that isn't on the roadmap without adding it to the
  roadmap first.
- Pushing a commit that breaks `npm run lint` or `npm run build` in either
  `App/` or `Home/`. CI runs both on every push to `main`; run them locally
  first. See section 7 for the ESLint rules that keep biting.

---

## 12. When in doubt

Re-read `ROADMAP.md`, then ask the human. Don't guess on product decisions.
