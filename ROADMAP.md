# Genosyn — Roadmap

> **Mission:** Run companies autonomously. Give every team a roster of AI
> employees that live by a written soul, carry real skills, work recurring
> routines on a schedule, and report back to humans.

This file is the working plan. Edit freely — nothing here is built yet.

---

## Open questions / decisions

### 1. ORM — TypeORM vs alternatives
**Decision:** use **TypeORM** with the SQLite driver now; switch the driver to
Postgres later with a config flag. Entities, migrations, and relations stay the
same across both. Trade-off: TypeORM is heavier than Drizzle / Kysely and has
some quirks around SQLite foreign keys, but the Postgres migration story is the
cleanest in the Node ecosystem.

### 2. What do we call the recurring cron'd work?
We want to reserve **"Tasks"** for a future task-manager feature (todos,
projects, kanban). So the recurring scheduled work an AI employee performs
needs a different word.

**Candidates:**
| Name | Feel | Notes |
| --- | --- | --- |
| **Routines** ⭐ | Daily/weekly rhythm | Clear, non-technical, doesn't collide with Tasks or Jobs. Recommended. |
| Playbooks | Named, repeatable procedures | Great if we lean into "every routine is a documented procedure." |
| Duties | Ongoing responsibilities | Slightly formal, very "employee." |
| Shifts | Scheduled work blocks | Nice metaphor but implies time-windows, not triggers. |
| Beats | Newsroom "beat reporter" | Poetic, niche. |
| Cadences | The rhythm itself | Describes the schedule, not the work. |
| Jobs | Engineering default | Too generic; conflicts with "job title." |

**Recommendation: Routines.** Reads naturally: *"Ada runs 3 routines — morning
standup digest, hourly inbox triage, Friday weekly report."* Future task
manager uses **Projects + Todos**, no collision.

### 3. Home site
Fully **standalone**. Own package.json, own UI, no shared components. Open
source, **no pricing page**.

### 4. Task runner execution
Routines store cron expressions and prompt/skill bindings. Real model
invocation (claude-code / codex / opencode) ships in M6. The runner spawns
the provider CLI in the employee's working directory with the employee's
own credentials scoped to `data/.../employees/<slug>/.claude/`, falling back
to a stub log when no model is connected (so self-hosters without the CLI
installed still see Run records).

### 5. Who owns an AI Model?
**Decision:** Models are **employee-owned, one-to-one**. Each AI Employee has
(at most) one AIModel connection, with its own credentials on disk under the
employee's directory. No shared company pool. Rationale:
- Matches how human employees work (each has their own signed-in accounts).
- Concurrency is naturally scoped per employee.
- Firing an employee revokes their credentials in one step (`rm -rf`).
- Per-employee cost attribution is free from the provider's own dashboard.

Users who want to share one subscription across several employees can reuse
the same Anthropic account during `claude login` — each employee still has
its own on-disk creds file, which can be individually disconnected.

---

## Vocabulary (so we stay consistent)

- **Company** — a tenant. Many users belong to it.
- **Member** — a human user inside a company.
- **AI Employee** — a persistent AI persona attached to a company. Has a name,
  role, and **Soul**.
- **Soul** (`SOUL.md`) — the written constitution of an employee: values, tone,
  how it makes decisions, what it refuses to do.
- **Skill** — a capability the employee knows how to apply. Lives as
  `skills/<slug>/README.md`. Think: *"how to write a weekly changelog,"* *"how
  to triage a bug report."*
- **Routine** — a scheduled recurring piece of work. Cron-triggered. Lives as
  `routines/<slug>/README.md` + metadata row.
- **AI Model** — the brain of a single AI Employee. One-to-one with the
  employee. Has a provider (`claude-code` / `codex` / `opencode`), a model
  string, and its own credentials stored under the employee's data dir.
- **Run** — a single execution of a routine. Produces logs + artifacts.

---

## Architecture

```
genosyn/
├── App/                          # Product app (open source, self-hostable)
│   ├── config.ts                 # Central JSON-shaped config + comments
│   ├── package.json
│   ├── server/                   # Express + TS + TypeORM
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── datasource.ts     # TypeORM DataSource (sqlite → postgres via config)
│   │   │   ├── entities/         # User, Company, Membership, AIEmployee, Skill, Routine, AIModel, Run
│   │   │   └── migrations/
│   │   ├── routes/               # /api/auth, /api/companies, /api/employees, /api/routines, /api/skills, /api/models
│   │   ├── services/             # email, files (SOUL/Skill/Routine md), slugs, cron, runner
│   │   ├── middleware/           # session, auth guard, error handler, zod validation
│   │   └── lib/
│   ├── client/                   # React + Vite + Tailwind SPA
│   │   ├── pages/                # Login, Signup, Forgot, Reset, Dashboard, Company, Employee, Skills, Routines, Models, Settings
│   │   ├── components/           # UI primitives + layout
│   │   ├── lib/api.ts
│   │   └── styles/
│   └── data/                     # runtime
│       ├── app.sqlite
│       └── companies/<company-slug>/employees/<emp-slug>/
│           ├── SOUL.md
│           ├── skills/<skill-slug>/README.md
│           ├── routines/<routine-slug>/README.md
│           └── .claude/          # CLAUDE_CONFIG_DIR — per-employee creds
└── Home/                         # Marketing site, standalone
    ├── server.ts
    ├── client/
    └── package.json
```

### Stack
- **Backend:** Express, TypeScript, **TypeORM** (sqlite → postgres), bcrypt,
  cookie-session, nodemailer, node-cron, zod, slugify
- **Frontend:** React 18, Vite, TailwindCSS, React Router, lucide-react
- **Dev:** Vite proxies `/api/*` to Express. Single `npm run dev` via
  `concurrently`.
- **No Next.js.**

### Data model (TypeORM entities)
- `User` — id, email (unique), passwordHash, name, resetToken, resetExpiresAt
- `Company` — id, name, slug, ownerId
- `Membership` — companyId, userId, role (owner / admin / member)
- `Invitation` — companyId, email, token, expiresAt *(V1)*
- `AIModel` — employeeId (unique), provider (`claude-code | codex | opencode`),
  model, authMode (`subscription | apikey`), configJson (encrypted secrets),
  connectedAt
- `AIEmployee` — companyId, name, slug, role
- `Skill` — employeeId, name, slug
- `Routine` — employeeId, name, slug, cronExpr, enabled, lastRunAt
- `Run` — routineId, startedAt, finishedAt, status, logsPath *(V1)*

### `config.ts` shape
```ts
export const config = {
  // Where SQLite db and per-company filesystem tree live
  dataDir: "./data",

  // Database driver — flip to "postgres" + fill url when ready
  db: {
    driver: "sqlite",           // "sqlite" | "postgres"
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },

  // API server
  port: 8471,
  publicUrl: "http://localhost:8471",
  sessionSecret: "change-me-in-production",

  // SMTP — leave host empty to disable; reset links log to console instead
  smtp: {
    host: "", port: 587, secure: false,
    user: "", pass: "",
    from: "Genosyn <no-reply@genosyn.local>",
  },
} as const;
```

---

## Milestones

### M0 — Skeleton (this week)
- [ ] Monorepo scaffold: `App/` and `Home/`
- [ ] `config.ts` with JSON-shape + comments
- [ ] Express server, TypeORM DataSource, initial migration
- [ ] React + Vite + Tailwind client, dev proxy, build pipeline
- [ ] Clean UI kit primitives (Button, Input, Card, Modal, Sidebar)
- [ ] Home landing page (hero, features, CTA, GitHub link)

### M1 — Auth
- [ ] Signup / Login / Logout with bcrypt + cookie-session
- [ ] Forgot password (token → email → reset page)
- [ ] `nodemailer` SMTP service with console fallback when unconfigured
- [ ] Session middleware + `requireAuth` guard

### M2 — Companies & Members
- [ ] Create / rename / delete company (owner-only)
- [ ] Company switcher in the app shell
- [ ] Invite member by email (token link)
- [ ] Roles: owner, admin, member

### M3 — AI Employees + Soul
- [ ] Create employee (name → slug, role)
- [ ] Scaffold `SOUL.md` with a sensible starter template
- [ ] In-app Soul editor (monaco or simple textarea with markdown preview)
- [ ] Employee list + detail pages

### M4 — Skills
- [ ] Create/rename/delete skill
- [ ] Edit `README.md` for a skill in-app
- [ ] Attach skills to routines (M5)

### M5 — Routines (recurring work)
- [ ] Create routine with cron expression
- [ ] Human-readable cron preview (e.g. *"Every weekday at 9am"*)
- [ ] README.md editor for the routine brief
- [ ] Enable/disable toggle
- [ ] `node-cron` registration on boot; stubbed runner writes a Run record

### M6 — AI Models (employee-owned)
- [ ] `AIModel` entity one-to-one with `AIEmployee`; migration drops
      `companyId` and `AIEmployee.defaultModelId`, adds `employeeId` (unique),
      `authMode`, `connectedAt`
- [ ] Provider-specific setup for claude-code / codex / opencode
- [ ] **Subscription sign-in flow:** employee detail page shows a one-liner
      (`CLAUDE_CONFIG_DIR=<path> claude login`), UI polls for credentials
      file and flips to "Connected" automatically
- [ ] **API-key flow:** encrypted-at-rest in `configJson` (AES-256-GCM, key
      derived from `config.sessionSecret`); "Test connection" button
- [ ] `runner` spawns the provider CLI with `cwd=<employeeDir>` and env
      scoped to that employee's credentials; falls back to stub log when no
      Model is connected or the CLI isn't installed
- [ ] Disconnect deletes the DB row and wipes `.claude/` on disk
- [ ] Company-level read-only "AI Models" overview page (per-employee
      connection status table)

### M7 — Polish + QA
- [ ] Browser-tested flows: signup → company → employee → skill → routine → model
- [ ] Empty states, loading states, error toasts
- [ ] README.md with self-host instructions

---

## V1 backlog (post-MVP)

### Employee depth
- **Memory / Journal** — each employee keeps a running `memory/YYYY-MM-DD.md`
  log of what it did, decisions it made, questions it had.
- **Conversations** — chat directly with an employee in the app. Mentions
  (`@ada`) anywhere trigger a reply.
- **Handoffs** — one employee delegates to another (writes a brief, pings).
- **Run history + artifacts** — every routine run logs output + produced files.
- **Approvals / human-in-the-loop** — employee proposes action, waits for a
  human ✓.

### Task manager (the "Tasks" we reserved the name for)
- **Projects** (containers) + **Todos** (items) with statuses, assignees,
  due dates.
- AI employees can be **assignees** — todos become the thing they work on
  when a routine doesn't fit.
- Kanban + list views.

### Integrations (the employee's real hands)
- **MCP server support** — employees pick up MCP tools.
- Gmail, Google Calendar, Slack, GitHub, Linear, Notion, generic webhook.
- **Secrets vault** — encrypted per-company secrets for integrations.
- **Incoming webhooks** — external events trigger routines.

### Org depth
- **Teams** — group employees, reporting lines, org chart visual.
- **Templates / Hiring** — spin up an employee from a template
  (Researcher, SDR, Marketer, Engineer, Ops).
- **Reviews** — weekly/monthly self-review markdown an employee writes about
  its own performance.
- **Goals / KPIs** — employees track numeric goals, update them in runs.

### Platform
- **API keys + REST API** — programmatic access to everything.
- **Audit log** — who/what/when.
- **Usage & cost** — per-employee / per-routine token spend rollups.
- **SSO / Google OAuth login**
- **2FA** (TOTP)
- **Dark mode**
- **CLI** — `genosyn` command for scripting.
- **Import/export** — back up a company (entities + filesystem tree).

### Runner
- Real execution for `claude-code`, `codex`, `opencode`.
- Sandboxed execution env (docker or lightweight jail).
- Streaming logs to the UI.
- Per-run context window budget.

---

## V2+ wild ideas (parking lot)

- **Marketplace** — share SOUL.md personas and skill packs publicly.
- **Employee ↔ employee** messaging, with humans CC'd.
- **Inbox** — unified stream of everything every employee produced today.
- **Voice** — TTS summaries; "call" an employee.
- **Meeting presence** — employee joins a Google Meet, takes notes, files a
  routine-driven summary.
- **Contracts** — an employee's Soul can be versioned; changes need approval.
- **Performance dashboards** — heatmaps of routine reliability.
- **Federation** — two self-hosted Genosyn orgs cooperate on a shared project.

---

## Design principles

1. **Employee-first, not workflow-first.** The primary noun is the employee;
   routines and skills hang off them.
2. **Markdown as source of truth.** Soul, skills, routines — all readable,
   diffable, commitable files on disk. DB is the index, not the truth.
3. **Local-first & self-hostable.** SQLite + filesystem works offline on a
   laptop. Postgres is an upgrade, not a requirement.
4. **Human-in-the-loop by default.** Autonomy is opt-in per routine.
5. **Boring tech, clean UI.** Express + TypeORM + React. No frameworks of the
   month. Interface should feel like Linear crossed with Notion.
