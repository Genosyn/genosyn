# AGENTS.md — Guide for AI coding agents working on Genosyn

> If you are Claude Code, Codex, opencode, Cursor, Aider, or any other AI
> agent touching this repo, read this file first. It is the single source of
> truth for how to work here.

---

## 1. What Genosyn is

Genosyn is an **open-source, self-hostable platform for running companies
autonomously with AI employees**. North star: [paperclip.ing](https://paperclip.ing/).

- A **Company** has human **Members** and **AI Employees**.
- Every **AI Employee** has a **Soul** (`SOUL.md`), a set of **Skills** (markdown
  docs), and **Routines** (scheduled cron-driven work).
- Each company can register multiple **AI Models** (`claude-code`, `codex`,
  `opencode` with custom model) and assign them to employees.

Read `ROADMAP.md` for the full vocabulary, milestones, and backlog. **Do not
duplicate content from ROADMAP.md here** — link to it.

---

## 2. Repo layout

```
genosyn/
├── App/         # Product app: Express + TypeORM + React + Vite + Tailwind
├── Home/        # Standalone marketing site (React + Vite + Tailwind)
├── ROADMAP.md   # The plan. Edit freely.
├── AGENTS.md    # This file.
└── CLAUDE.md    # Pointer to this file.
```

Agents should never invent a new top-level folder without updating this file
and `ROADMAP.md`.

---

## 3. Naming — get this right

This project has a **deliberate vocabulary**. Use these words consistently in
code, UI copy, commits, and docs.

| ✅ Use | ❌ Do not use |
| --- | --- |
| **Routine** (scheduled recurring AI work) | Task, Job, Cron, Workflow |
| **Soul** / `SOUL.md` (employee constitution) | Persona, Prompt, System prompt |
| **Skill** (`README.md` under `skills/<slug>/`) | Tool, Capability, Function |
| **AI Employee** | Agent, Bot, Assistant (in product copy) |
| **AI Model** (backend brain record) | Provider, LLM config |
| **Member** (human user in a company) | User (in product copy; `User` is fine as the DB entity name) |
| **Run** (one execution of a Routine) | Execution, Invocation |

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
- **Email:** `nodemailer` with SMTP from `config.ts`. Console fallback when
  SMTP host is empty.
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
    ├── SOUL.md
    ├── skills/<skill-slug>/README.md
    └── routines/<routine-slug>/README.md
```

- **Markdown files on disk are the source of truth** for Soul / Skill /
  Routine prose. The DB stores metadata (ids, cron exprs, timestamps,
  enabled flags) and acts as the index.
- The `data/` directory is gitignored. Never commit anything inside it.
- Slugs are derived once at create-time via `slugify`; renames update the
  display name but not the slug (rename = new slug would orphan files).

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
- **Lint/format**: project ships with ESLint + Prettier defaults; run them
  before commit.
- **Required npm scripts** (both `App/` and `Home/` must implement these,
  CI depends on them): `dev`, `build`, `lint`, `typecheck`, `start`.
- **Build output layout** (Dockerfiles depend on this):
  - App: server compiled to `dist/server/index.js`, client assets under
    `dist/client/` (served by the Express process).
  - Home: `dist/server.js` serving built client assets.

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
- Create AI employee → edit SOUL.md → add skill → add routine → assign model
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

---

## 11. Things that will get your PR rejected

- Introducing Next.js, JWT libraries, Prisma/Drizzle, or a component library
  without prior discussion.
- Using "Task" to mean a scheduled AI routine.
- Committing files under `data/`.
- Writing business logic inside route handlers.
- Storing Soul/Skill/Routine prose in the database instead of on disk.
- Skipping the zod schema on a new endpoint.
- Adding a feature that isn't on the roadmap without adding it to the
  roadmap first.

---

## 12. When in doubt

Re-read `ROADMAP.md`, then ask the human. Don't guess on product decisions.
