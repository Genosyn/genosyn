# Genosyn — Roadmap

> **Mission:** Run companies autonomously. Give every team a roster of AI
> employees that live by a written soul, carry real skills, work recurring
> routines on a schedule, and report back to humans.

This file is the working plan. **Edit freely** — and keep it honest. If a
feature ships, mark its milestone `[x]` here in the same PR. If reality
diverges from the plan, update the plan; don't leave it stale.

---

## Decisions log

Past calls that still shape the codebase. Listed once so future contributors
don't re-litigate them.

1. **ORM = TypeORM, sqlite → postgres via config.** Heavier than Drizzle /
   Kysely, but the cross-driver migration story is the cleanest. Entities,
   migrations, and relations work on both.
2. **Recurring AI work = "Routines".** "Tasks" is reserved for the human-style
   project/todo manager (now shipped — see `Project` + `Todo`).
3. **Home site is fully standalone.** Own package.json, own UI, no shared
   components. Open source, no pricing page.
4. **AI Models are employee-owned, one-to-one.** Each AI Employee has at most
   one `AIModel` with its own credentials on disk under the employee's
   directory. No shared company pool. Firing an employee revokes their
   credentials in one step (`rm -rf`).
5. **Database is the source of truth** for Soul, Skill, and Routine prose
   (`AIEmployee.soulBody`, `Skill.body`, `Routine.body`) and for captured Run
   logs (`Run.logContent`, 256 KB cap). The filesystem under `data/` only
   carries provider credentials, materialized `.mcp.json`, repo checkouts,
   and CLI artifacts.
6. **No `.env` file, ever.** All runtime settings live in `App/config.ts` as
   one exported object with commented JSON-shape. Self-hosters edit
   `config.ts` directly.

---

## Vocabulary

- **Company** — a tenant. Many users belong to it.
- **Member** — a human user inside a company.
- **AI Employee** — a persistent AI persona attached to a company. Has a
  name, role, **Soul**, **Skills**, **Routines**, and (optionally) a
  `reportsToEmployeeId` for org-chart relationships.
- **Soul** — the written constitution of an employee: values, tone, how it
  makes decisions, what it refuses to do. Markdown on `AIEmployee.soulBody`.
- **Skill** — a capability the employee knows how to apply. Markdown on
  `Skill.body`.
- **Routine** — a scheduled recurring piece of work. Cron-triggered. Markdown
  brief on `Routine.body` alongside cron metadata.
- **AI Model** — the brain of a single AI Employee. One-to-one with the
  employee. Provider (`claude-code` / `codex` / `opencode` / `goose`), model
  string, credentials on disk under the employee's data dir.
- **Run** — a single execution of a routine. Captured stdout + stderr stored
  on `Run.logContent` (256 KB cap).
- **Integration** — a connector type (Stripe, Gmail, Metabase, …). Static
  catalog defined in `server/integrations/providers/<name>.ts`.
- **Connection** — one authenticated account inside an Integration. DB row
  (`IntegrationConnection`), per-company.
- **Grant** — an AI employee's access to a Connection
  (`EmployeeConnectionGrant`).
- **Pipeline** — DAG of typed nodes for deterministic glue (separate
  primitive from Routines). Triggered manually, by webhook, or on cron.
- **Note / Notebook** — Notion-style company-wide markdown knowledge base.
- **Base** — Airtable-style multi-table workspaces with views, comments,
  attachments.
- **Channel / DM** — Slack-style workspace chat between humans and AI.
- **Handoff** — formal AI→AI delegation with status workflow.
- **Approval** — gate that blocks an action until a human ✓.

---

## Architecture

```
genosyn/
├── App/                          # Product app (open source, self-hostable)
│   ├── config.ts                 # Central JSON-shaped config + comments
│   ├── server/                   # Express + TS + TypeORM
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── datasource.ts
│   │   │   ├── entities/         # 47+ entities — see inventory below
│   │   │   └── migrations/
│   │   ├── routes/               # 30+ HTTP routers — auth, companies, …
│   │   ├── services/             # cron, runner, chat, repoSync, oauth, …
│   │   ├── integrations/providers/  # Stripe, Gmail, GitHub, Lightning, …
│   │   ├── mcp-genosyn/          # Built-in stdio MCP server
│   │   └── middleware/           # session, auth guard, error, zod validate
│   ├── client/                   # React + Vite + Tailwind SPA
│   │   └── pages/                # 40+ pages
│   └── data/                     # runtime, gitignored
├── Home/                         # Marketing site, standalone
└── CLI/                          # `genosyn` cluster-maintainer bash CLI
```

### Entity inventory (by area)

- **Identity & tenancy:** `User`, `Company`, `Membership`, `Invitation`,
  `Team`
- **AI substrate:** `AIEmployee`, `AIModel`, `Skill`, `Routine`, `Run`,
  `EmployeeMemory`, `JournalEntry`, `Handoff`
- **Conversations:** `Conversation`, `ConversationMessage` (web + Telegram
  source dispatch, action pills serialized into `actionsJson`)
- **Workspace chat (M9):** `Channel`, `ChannelMember`, `ChannelMessage`,
  `MessageReaction`, `Attachment`
- **Notes (M11):** `Notebook`, `Note`, `EmployeeNotebookGrant`,
  `EmployeeNoteGrant`
- **Bases (M11.5):** `Base`, `BaseTable`, `BaseField`, `BaseView`,
  `BaseRecord`, `BaseRecordComment`, `BaseRecordAttachment`,
  `EmployeeBaseGrant`
- **Tasks (Projects + Todos):** `Project`, `Todo`, `TodoComment`
- **Pipelines (M10):** `Pipeline`, `PipelineRun`
- **Integrations:** `IntegrationConnection`, `EmployeeConnectionGrant`,
  `McpServer` (external MCP server registry)
- **Approvals + audit:** `Approval` (kind: routine | lightning_payment | …),
  `AuditEvent`, `Notification`
- **Email:** `EmailProvider`, `EmailLog`
- **Backups:** `Backup`, `BackupSchedule`
- **Secrets:** `Secret`

### Stack
- **Backend:** Express, TypeScript, **TypeORM** (sqlite → postgres), bcrypt,
  cookie-session, nodemailer, node-cron, zod, slugify, ws
- **Frontend:** React 18, Vite, TailwindCSS, React Router, lucide-react
- **Dev:** Vite proxies `/api/*` to Express in middleware mode (single port).
- **Runtime:** Node 22 LTS pinned in `.nvmrc`, Dockerfiles, and CI.
- **No Next.js.**

### `config.ts` shape
```ts
export const config = {
  dataDir: "./data",
  db: {
    driver: "sqlite",           // "sqlite" | "postgres"
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },
  port: 8471,
  publicUrl: "http://localhost:8471",
  sessionSecret: "change-me-in-production",
  smtp: { host: "", port: 587, secure: false, user: "", pass: "",
          from: "Genosyn <no-reply@genosyn.local>" },
  integrations: { google: { clientId: "", clientSecret: "" }, /* … */ },
} as const;
```

---

## Milestones

> **Notation.** `[x]` shipped. `[~]` partial. `[ ]` not started.

### M0 — Skeleton ✅
- [x] Monorepo scaffold (`App/` + `Home/`)
- [x] `config.ts` with JSON-shape + comments
- [x] Express server, TypeORM DataSource, initial migration
- [x] React + Vite + Tailwind client, dev proxy, build pipeline
- [x] UI kit primitives (Button, Input, Card, Modal, Sidebar, …)
- [x] Home landing page

### M1 — Auth ✅
- [x] Signup / Login / Logout (bcrypt + cookie-session)
- [x] Forgot password (token → email → reset page)
- [x] Email service: per-company `EmailProvider` rows (SMTP, SendGrid,
      Mailgun, Resend, Postmark) with global SMTP fallback and console fallback
- [x] Session middleware + `requireAuth` / `requireCompanyMember` guards

### M2 — Companies & Members ✅
- [x] Create / rename / delete company (owner-only)
- [x] Company switcher in app shell
- [x] Invite member by email (token link)
- [x] Roles: owner / admin / member

### M3 — AI Employees + Soul ✅
- [x] Create employee with template selection
      (catalog in `services/templates.ts`)
- [x] Soul scaffold seeded into `AIEmployee.soulBody`
- [x] In-app Soul editor with markdown preview
- [x] Employee list, detail pages, per-employee sidebar

### M4 — Skills ✅
- [x] Create / rename / delete skill
- [x] In-app skill body editor (markdown)
- [x] Skills attached to employees and surfaced to the runner

### M5 — Routines ✅
- [x] Create routine with cron expression
- [x] Human-readable cron preview
- [x] Markdown brief editor
- [x] Enable/disable toggle
- [x] `node-cron` registration on boot, real Run records
- [x] Live-tail run logs in a modal on manual Run

### M6 — AI Models (employee-owned) ✅
- [x] `AIModel` one-to-one with `AIEmployee`
- [x] Provider-specific setup for claude-code / codex / opencode / goose
- [x] Subscription sign-in flow (UI polls for credentials file)
- [x] API-key flow with AES-256-GCM encryption
- [x] Runner spawns provider CLI in employee cwd with scoped env
- [x] CLI install + sign-in flow brought into the browser
- [x] Disconnect deletes DB row and wipes credentials

### M7 — Chat + Workspace ✅
- [x] Top-nav sections with context-specific sidebars
- [x] Per-employee sub-nav (Chat / Workspace / Soul / Skills / Routines /
      Settings / Connections / Handoffs / Journal)
- [x] Persisted conversations (`Conversation` + `ConversationMessage`),
      action pills rendered from `actionsJson`
- [x] Workspace file editor with path-traversal guards, 2 MiB text-only cap

### M8 — Polish + QA ✅
- [x] Browser-tested flows
- [x] Empty / loading / error states everywhere
- [x] README + self-host docs + CLI installer

### M9 — Workspace Chat (Slack-style) ✅
- [x] Public + private channels per company
- [x] DMs (idempotent pairing)
- [x] In-process WebSocket hub at `/api/ws` (auth via short-lived token)
- [x] Emoji picker + reactions
- [x] File uploads (multer, 25 MB cap)
- [x] `@employee-slug` mentions auto-invite + reply via `streamChatWithEmployee`
- [x] AI DMs reply on every message
- [x] Unread badges + read markers
- [x] Edit / soft-delete own messages, broadcast over WS
- [ ] Typing indicators UI (plumbing exists, UI deferred)
- [ ] Threaded replies UI (column exists, UI deferred)
- [ ] Search, link unfurls, desktop notifications

### M10 — Pipelines ✅
- [x] `Pipeline` + `PipelineRun` entities, per-company DAG
- [x] Node catalog: triggers (manual / webhook / schedule), Genosyn actions
      (sendMessage / createTodo / createProject / createBaseRecord /
      askEmployee / journalNote), logic (http / set / branch / delay) and
      `integration.invoke` for any provider tool
- [x] Executor service with topo-walk + per-run log
- [x] `tickPipelines()` heartbeat + webhooks at
      `/api/webhooks/pipelines/:pipelineId/:token`
- [x] Custom React canvas editor (no react-flow), side-panel node config,
      run-history tab

### M11 — Notes (Notion-style) ✅
- [x] `Note` + `Notebook` with parent self-reference, archive, split
      author bookkeeping
- [x] CRUD + search routes, tree reorder, parent reparenting with cycle
      protection, restore from trash
- [x] Notion-style sidebar tree, per-row "+" sub-page button, trash toggle
- [x] Editor with title + emoji icon, MarkdownEditor with ⌘S, breadcrumbs,
      "…" menu
- [x] MCP tools — `list_notes`, `search_notes`, `get_note`, `create_note`,
      `update_note`, `delete_note`. AI writes record `AuditEvent` +
      `JournalEntry`.

### M11.5 — Base record detail ✅
- [x] `BaseRecordComment` + `BaseRecordAttachment` entities
- [x] CRUD + download endpoints; multer 25 MB human cap, 5 MB AI cap
- [x] Side drawer in `BaseDetail.tsx` with form + comment thread + files
- [x] MCP tools — `get_base_record`, comment CRUD, attachment CRUD

### M12 — Engineering Repos ✅
- [x] GitHub Connection extended with OAuth + GitHub App auth modes
      (`github-oauth.ts`, `github-app.ts`) on top of existing PAT
- [x] Per-Connection `repos[]` allowlist on `encryptedConfig.repos`
- [x] `services/repoSync.ts` materializes git checkouts under
      `<employeeDir>/repos/<owner>/<name>/` before each spawn; per-employee+
      connection mutex; fetch-only on existing checkouts (won't trample WIP)
- [x] Per-connection git credential helper (`.git/genosyn-cred.sh`) reads
      from `GENOSYN_GH_TOKEN_<connId>` env var the runner sets at spawn time
      — token never lands on disk
- [x] `create_pull_request` MCP tool on the github provider
- [x] Settings → Integrations UI for GitHub repo allowlist editing
- [x] Workspace tree shows materialized `repos/` subtree
- [ ] Default Engineering skill body template (still attached manually)
- [ ] Worktree-per-routine isolation (deferred — single-mutex is fine for now)
- [ ] Signed commits via the GitHub App identity (deferred)

### M13 — Lightning ✅
- [x] `lightning` provider (NWC / NIP-47) — wallet-agnostic via Alby Hub /
      Mutiny / Phoenixd / Coinos / LNbits / Zeus
- [x] `lightning-lnd` provider with REST + macaroon + optional CA pinning
- [x] Tools: `get_info`, `get_balance`, `make_invoice`, `pay_invoice`,
      `pay_keysend` (NWC only), `lookup_invoice`, `list_transactions`
- [x] Spending controls (`maxPaymentSats`, `dailyLimitSats`,
      `requireApprovalAboveSats`) enforced at the tool boundary
- [x] Live `checkStatus` at create + on "Test connection"
- [x] Generalized `Approval` entity with `kind` discriminator;
      `services/approvals.ts` dispatches; lightning over-cap payments queue
      a `lightning_payment` Approval which replays the call on approve

### M14 — API Keys + REST API ✅

Programmatic access to the same surface humans use through the UI. Today
all routes are session-gated; this milestone introduces a Bearer-token
auth path that delegates to the same membership / role checks. Unlocks
external triggers, scripting, CI integration, and a public Cowork-style
plugin surface later.

- [x] `ApiKey` entity + migration. Fields: companyId (indexed), userId
      (owner), name, prefix (first 8 chars for display), tokenHash
      (sha256 hex of the random 32 bytes), lastUsedAt, expiresAt,
      revokedAt, createdAt.
- [x] Token format: `gen_<43 base64url chars>` (32 random bytes). Hash
      with sha256 — high-entropy random input doesn't need bcrypt and
      sha256 keeps the per-request lookup O(1) on an indexed column.
- [x] `requireAuth` extended: if no session, fall back to
      `Authorization: Bearer gen_…`. On match, set `req.userId = key.userId`,
      stash `req.apiKeyCompanyId` and `req.apiKey` for downstream guards
      to reject cross-company use.
- [x] `requireCompanyMember` rejects when an API key is presented for a
      company id other than the key's `companyId`, even if the underlying
      user is a member of both.
- [x] CRUD routes under `/api/companies/:cid/api-keys`:
      `GET` (list, no plaintext), `POST` (create, returns plaintext once
      and never again), `DELETE :id` (revoke).
- [x] Settings → API keys page mirroring the Secrets / Audit shape: table
      of keys with prefix + name + last-used + expires; "Generate" modal
      that surfaces the plaintext once with a copy button and warning;
      revoke confirmation.
- [x] Audit events on create / revoke.
- [x] **OpenAPI / Swagger docs** — registry-based spec generator at
      `server/openapi/`, served as `/api/openapi.json` (raw) and `/api/docs`
      (interactive Swagger UI). Both Bearer + cookie auth schemes
      pre-configured for try-it-out. Coverage today: auth, companies,
      api-keys (full M14), employees, routines + runs. Adding a new area
      = one more file under `server/openapi/`.

### M18 — Resources (knowledge ingestion) ✅

External material — articles, ebooks, transcripts — that an AI employee
should "study" and refer back to. Distinct from `EmployeeMemory` (atomic
durable facts, auto-injected into the prompt) and `Note` (human-authored
markdown the team writes together): a Resource is **content the team did
not write**, ingested once, queried on demand via the MCP surface.

> Originally shipped as "Learnings"; renamed to "Resources" so the
> vocabulary doesn't collide with the verb form ("learning something
> new") that already shows up across Skill / Memory copy. The follow-up
> migration `RenameLearningsToResources` drops the old tables and
> creates the new ones — there is no in-place data migration.

- [x] `Resource` entity — companyId, title, slug, sourceKind
      (`url` | `text` | `pdf` | `epub` | `video`), sourceUrl, sourceFilename,
      summary, bodyText (extracted plain text, capped at 1 MiB),
      tags (comma-joined string), bytes, status
      (`pending` | `ready` | `failed`), errorMessage, author bookkeeping.
- [x] `EmployeeResourceGrant` entity — employee → resource, with the
      same `read` / `write` access levels as Notes.
- [x] Ingestion service `services/resources.ts`:
      * URL → `fetch` + minimal HTML→text (no jsdom/readability dep)
      * Plain text / `.txt` / `.md` / `.html` upload → store + index
      * PDF upload → text via `pdf-parse` (new dep, flagged below)
      * EPUB upload → unzip + collect XHTML body text via existing `unzipper`
      * Video → accepted but flagged `failed` with a "transcripts coming
        soon" note (no ASR dep)
- [x] HTTP routes under `/api/companies/:cid/resources`: list, create
      (URL / paste / upload via multer, 25 MB cap), detail, patch
      (rename + retag), delete, plus grant CRUD.
- [x] MCP tools — `list_resources`, `search_resources`, `get_resource`
      mirroring the Notes pattern. Read-only for AI; humans curate.
- [x] React UI under `/c/<co>/resources`: Notion-style centered layout
      with quick-add tiles (URL / Paste / Upload), search-as-you-type,
      compact list view, document-style detail page, share modal.
- [x] AppShell sidebar entry under "Knowledge".

**New dependency:** `pdf-parse` (small, well-maintained, Node 22 OK).
Avoided the bigger choice of an embeddings store + vector search; v1
relies on substring matching over titles, summaries, and `bodyText`,
same as `search_notes`. Embeddings + RAG land in a future milestone
once we know what the team actually queries.

### M15 — 2FA / TOTP (planned)
- [ ] `User` gets `totpSecret` (encrypted), `totpEnabledAt`, `recoveryCodes`
- [ ] Enroll flow with QR (otpauth://… → render via `qrcode` dep)
- [ ] Verify on login when enabled; recovery-code path
- [ ] Per-company "require 2FA" admin policy (later)

### M16 — Google login / SSO (planned)
- [ ] Reuse existing `integrations.google` OAuth client for sign-in
- [ ] `User.googleSub` (unique, nullable); link existing accounts by email
- [ ] Owner can require Google login for their company

### M17 — Marketplace (planned)
- [ ] Export an employee as `{ soul, skills[], routines[], grants[] }`
      bundle
- [ ] Import a bundle to scaffold a new employee (extends Templates)
- [ ] Public-by-URL share — landing page on Home consumes the bundle JSON

---

## V1 backlog (post-MVP)

Items here are not on the active milestone path but worth picking up. Most
of the original V1 backlog has shipped — what remains is mostly
"engineering depth."

### Employee depth
- [x] **Memory / Journal** — `EmployeeMemory` durable facts auto-injected
      into prompts; `JournalEntry` is the per-employee diary feed
- [x] **Persisted Conversations** (M7)
- [x] **Handoffs** (`Handoff` entity + UI)
- [x] **Run history + artifacts** — every Run captures stdout/stderr;
      live-tail in modal
- [x] **Approvals / human-in-the-loop** (`Approval` entity, generalized
      via `kind` discriminator)
- [ ] **Reviews** — weekly/monthly self-review markdown an employee
      writes about its own performance
- [ ] **Goals / KPIs** — numeric goals updated in runs, surfaced on
      employee detail

### Task manager
- [x] **Projects + Todos** with statuses, assignees, due dates,
      `in_review` flow, comments

### Integrations
- [x] **MCP server support** (external + built-in `genosyn` stdio binary
      with short-lived per-spawn Bearer)
- [x] **Integrations + Connections framework** with grants
- [x] **Stripe, Gmail, Metabase, GitHub, Linear, Notion, Postgres,
      MySQL, Clickhouse, Redis, Airtable, NocoDB, Telegram, X.com,
      Nostr, Lightning (NWC + LND), Google (Calendar + Drive + Gmail
      scopes)**
- [x] **Secrets vault** (`Secret` entity, env-merged into spawns)
- [x] **Incoming webhooks** for both routines and pipelines

### Org depth
- [x] **Teams** + reporting lines (`reportsToEmployeeId` org chart)
- [x] **Templates / Hiring** — `EMPLOYEE_TEMPLATES` static catalog,
      consumed by `EmployeeNew.tsx` to seed Soul + Skills + Routines

### Platform
- [ ] **API keys + REST API** — see M14 above
- [x] **Audit log** (`AuditEvent` with `actorKind: human | ai | webhook`)
- [x] **Usage & cost** — per-employee / per-routine token spend rollups
- [x] **Backups** — `Backup` + `BackupSchedule`, restore endpoint,
      catch-up backup on boot
- [x] **Notifications** — bell + panel, per-user feed
- [ ] **SSO / Google login** — see M16
- [ ] **2FA (TOTP)** — see M15
- [x] **Dark mode** — fully covered (1,500+ `dark:` classes)
- [x] **CLI** — `CLI/genosyn` bash wrapper around Docker, installed via
      `curl -fsSL https://genosyn.com/install.sh | bash`
- [ ] **Scripting CLI** — second, product-facing CLI for programmatic
      operations on companies / employees / routines (depends on M14)
- [~] **Import/export** — backup/restore round-trips a whole install;
      per-company export (one tenant out of a multi-company install) is
      still pending

### Runner
- [x] **Real execution** for claude-code / codex / opencode / goose
- [x] **Streaming logs to UI** (SSE on `employeeSurface.ts`)
- [x] **Provider-level sandboxing** (codex `--sandbox workspace-write`,
      runner cwd-scoped)
- [ ] **Genosyn-level sandbox** (docker / lightweight jail around the
      child process — provider sandboxes don't fully contain the spawn)
- [ ] **Per-run context window budget**

---

## V2+ wild ideas

- **Marketplace** of Soul personas + skill packs (M17 above is the seed)
- **Voice** — TTS summaries; "call" an employee
- **Meeting presence** — employee joins a Google Meet, takes notes, files a
  routine-driven summary
- **Soul versioning + contracts** — Soul edits go through approval
- **Performance dashboards** — heatmaps of routine reliability
- **Federation** — two self-hosted Genosyn orgs cooperate on a shared
  project

---

## Design principles

1. **Employee-first, not workflow-first.** The primary noun is the
   employee; routines, skills, and grants hang off them.
2. **Database as source of truth.** Soul, skills, routines, and run logs
   live on their DB rows. The filesystem only carries provider runtime
   surface (credentials, `.mcp.json`, repo checkouts, CLI artifacts).
3. **Local-first & self-hostable.** SQLite works offline on a laptop; flip
   `config.db.driver` to Postgres when you outgrow it.
4. **Human-in-the-loop by default.** Autonomy is opt-in per routine, and
   per-Connection thresholds (e.g. `requireApprovalAboveSats` on
   Lightning) gate risky actions.
5. **Boring tech, clean UI.** Express + TypeORM + React. No frameworks of
   the month. Linear × Notion feel.
