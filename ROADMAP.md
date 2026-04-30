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
invocation (claude-code / codex / opencode / goose) ships in M6. The runner spawns
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
- **Soul** — the written constitution of an employee: values, tone, how it
  makes decisions, what it refuses to do. Stored as markdown on
  `AIEmployee.soulBody` in the DB.
- **Skill** — a capability the employee knows how to apply. Stored as markdown
  on `Skill.body` in the DB. Think: *"how to write a weekly changelog,"* *"how
  to triage a bug report."*
- **Routine** — a scheduled recurring piece of work. Cron-triggered. Brief is
  markdown on `Routine.body` alongside the cron metadata.
- **AI Model** — the brain of a single AI Employee. One-to-one with the
  employee. Has a provider (`claude-code` / `codex` / `opencode` / `goose`),
  a model string, and its own credentials stored under the employee's data dir.
- **Run** — a single execution of a routine. Captured stdout + stderr are
  stored on `Run.logContent` in the DB (hard-capped at 256KB).

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
│       ├── app.sqlite            # Soul / Skill / Routine bodies + Run logs live here
│       └── companies/<company-slug>/employees/<emp-slug>/
│           ├── .claude/ .codex/ .opencode/ .goose/  # per-employee provider creds
│           ├── .mcp.json                     # materialized before each spawn
│           └── …                             # artifacts the CLI writes to cwd
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
- `AIModel` — employeeId (unique), provider (`claude-code | codex | opencode | goose`),
  model, authMode (`subscription | apikey`), configJson (encrypted secrets),
  connectedAt
- `AIEmployee` — companyId, name, slug, role, soulBody (markdown)
- `Skill` — employeeId, name, slug, body (markdown)
- `Routine` — employeeId, name, slug, cronExpr, enabled, lastRunAt, body (markdown)
- `Run` — routineId, startedAt, finishedAt, status, exitCode, logContent
  (captured stdout + stderr, capped at 256KB)
- `IntegrationConnection` — companyId, provider (`stripe`|`google`|`metabase`|…),
  label, authMode (`apikey`|`oauth2`), encryptedConfig (JSON: tokens,
  refresh tokens, base URL, scopes), status (`connected`|`error`|`expired`),
  lastCheckedAt
- `EmployeeConnectionGrant` — employeeId, connectionId (unique pair).
  Many-to-many between `AIEmployee` and `IntegrationConnection`.
- `EmailProvider` — companyId, kind (`smtp`|`sendgrid`|`mailgun`|`resend`|
  `postmark`), name, fromAddress, replyTo, encryptedConfig, isDefault,
  enabled, lastTested* fields. One default per company drives outgoing
  notification emails.
- `EmailLog` — every notification email Genosyn attempted to deliver:
  companyId (nullable for system sends), providerId, transport, purpose
  (`invitation`|`password_reset`|`welcome`|`test`|`other`), to/from,
  subject, body preview, status (`sent`|`failed`|`skipped`),
  errorMessage, messageId.

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
- [ ] Scaffold Soul with a sensible starter template (seeded into
      `AIEmployee.soulBody` at create time)
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
- [ ] Provider-specific setup for claude-code / codex / opencode / goose
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

### M7 — Chat + Workspace
- [x] Top-nav sections (Employees / Settings) with context-specific sidebar
- [x] Per-employee sub-nav (Chat / Workspace / Soul / Skills / Routines / Settings)
- [x] One-shot **Chat** with an employee: send a message, shell out to the
      employee's provider CLI with SOUL + Skills + recent turns as the
      prompt, return the reply. No persisted Conversation entity yet —
      transcript lives in the browser.
- [x] Employee **Workspace** browser + text editor: tree of the employee's
      on-disk directory, read/write scoped inside `employeeDir()` with
      path-traversal guards, 2 MiB text-only cap, binary files read-only.

### M8 — Polish + QA
- [ ] Browser-tested flows: signup → company → employee → skill → routine → model
- [ ] Empty states, loading states, error toasts
- [ ] README.md with self-host instructions

### M11 — Notes (Notion-style company-wide knowledge base)
- [x] `Note` entity + migration. Per-company markdown pages with optional
      `parentId` self-reference (nested pages, Notion-style), `archivedAt`
      soft-delete timestamp, and split author bookkeeping
      (`createdById`/`createdByEmployeeId`, ditto for `lastEditedBy*`) so
      both human Members and AI Employees can author.
- [x] CRUD + LIKE-search routes under `/api/companies/:cid/notes`. Tree
      reordering, parent reparenting (with cycle protection), restore
      from trash. Children of a deleted note are re-parented up one level
      rather than orphaned.
- [x] Notion-style sidebar tree with collapsible children, per-row "+"
      to add a sub-page, top-level new-note button, and trash toggle.
- [x] Note editor: title input, emoji-icon slot, MarkdownEditor with ⌘S
      save, breadcrumb trail of ancestors, and a "…" menu (move to top
      level, archive, restore, delete forever).
- [x] Built-in MCP tools — `list_notes`, `search_notes`, `get_note`,
      `create_note`, `update_note`, `delete_note` — so AI employees can
      both read team context and add to it. Each AI write records an
      `AuditEvent` (`actorKind: "ai"`) and a `JournalEntry` on the
      acting employee's diary.

> **Why a separate primitive from Journal / Memory.** Journal is the
> per-employee diary feed; Memory is per-employee durable facts that get
> auto-injected into every prompt. Notes are *company-wide shared
> knowledge* — what the team writes down for itself, human and AI alike.

### M11.5 — Base record detail (form + comments + files)
- [x] `BaseRecordComment` entity + migration. Per-record discussion thread
      with split author bookkeeping (`authorUserId` / `authorEmployeeId`)
      so humans and AI employees post into one stream.
- [x] `BaseRecordAttachment` entity + migration. Files live on disk under
      `data/companies/<slug>/base-attachments/<uuid>.<ext>`; metadata-only
      sqlite row carries filename, mime type, size, storage key, and
      uploader (human or AI).
- [x] CRUD routes under `/api/companies/:cid/bases/:slug/tables/:tid/rows/:rid/comments`
      and `…/attachments`, plus a download endpoint at
      `…/base-attachments/:id`. Multer caps human uploads at 25 MB and
      stores under per-company dir. Row / table / base delete cascades
      strip orphan comments + on-disk bytes.
- [x] Side drawer in `BaseDetail.tsx` opens a record like a form: every
      field is editable inline (reusing `CellEditor`), a comment thread
      sits below with a composer, and an attachments list lets the user
      pick / download / delete files. Hover the row index in the grid to
      get the expand affordance.
- [x] Built-in MCP tools — `get_base_record`, `list_record_comments`,
      `create_record_comment`, `delete_record_comment`,
      `list_record_attachments`, `attach_file_to_record`,
      `read_record_attachment`, `delete_record_attachment` — so AI
      employees can read a record in full, discuss it, drop a generated
      file (text or base64), and read teammates' uploads. AI writes
      record an `AuditEvent` (`actorKind: "ai"`) plus a `JournalEntry`
      on the acting employee's diary, mirroring the Notes pattern.
      Per-AI uploads are capped at 5 MB.

### M10 — Pipelines (visual automation, separate from Routines)
- [ ] `Pipeline` + `PipelineRun` entities + migration. A Pipeline is a DAG of
      typed nodes (graphJson on the row), per-company, with optional
      `cronExpr` / `nextRunAt` derived from any Schedule trigger nodes.
- [ ] Node catalog — three families:
    * **Triggers**: `trigger.manual`, `trigger.webhook`, `trigger.schedule`
    * **Genosyn actions**: `action.sendMessage` (workspace channel),
      `action.createTodo` (todo in a project), `action.createProject`,
      `action.createBaseRecord`, `action.askEmployee` (chat with an AI
      employee, capture reply), `action.journalNote`
    * **Logic / integrations**: `logic.http` (fetch), `logic.set` (compute
      a variable from a template), `logic.branch` (if/else),
      `logic.delay`, `integration.invoke` (call any tool on an
      `IntegrationConnection` — e.g. Stripe / Gmail / Metabase)
- [ ] Executor service — topo-walks the DAG from the firing trigger node,
      passes per-node outputs through a shared environment, captures a
      run log onto `PipelineRun.logContent` (256KB cap, same as Run).
      Templates: `{{<node-id>.path}}` resolved against upstream outputs.
- [ ] Triggers wired in: `tickPipelines()` runs alongside the routine
      heartbeat; webhooks land at `/api/webhooks/pipelines/:pipelineId/:token`
      with the token embedded in each Webhook node's config.
- [ ] CRUD + run-history API: `/api/companies/:cid/pipelines`,
      `…/:pipelineId/runs`, `…/runs/:runId/log`, `…/run` (manual fire).
- [ ] Visual editor — custom React canvas (no react-flow): drag nodes,
      drag-link output handles to input handles, side panel for per-node
      config, save graphJson. Run-history tab shows status + log per run.
- [ ] Top-nav "Pipelines" tab, between Bases and Approvals. Empty state +
      "New pipeline" CTA + node-palette helper.

> **Why a separate primitive from Routines.** Routines are *one AI
> employee doing scheduled work*. Pipelines are *deterministic glue
> between Genosyn primitives and the outside world* — they may not
> involve an AI employee at all. Trying to fold them into Routines would
> blur the employee-first model.

### M9 — Workspace Chat (Slack-style)
- [x] `Channel`, `ChannelMember`, `ChannelMessage`, `MessageReaction`,
      `Attachment` entities + migration
- [x] Public + private channels, scoped per-company
- [x] Direct messages (1:1) to other humans or AI employees — idempotent
      pairing, so re-opening a DM lands on the same channel row
- [x] Realtime via a single in-process WebSocket hub (`ws`), mounted at
      `/api/ws` on the same HTTP server as REST. Auth is a one-shot
      short-lived token minted via `POST .../workspace/ws-token` to avoid
      decoding cookie-session inside the upgrade handler.
- [x] Emoji picker (curated unicode grid, no new dep) + emoji reactions
      on messages, toggling via `POST .../messages/:id/reactions`
- [x] File uploads via `multer` with 25 MB cap; bytes on disk under
      `data/companies/<slug>/attachments/<uuid>.<ext>`, metadata row in
      DB. Images render inline, anything else as a download chip.
- [x] `@employee-slug` mentions auto-invite the AI to public channels and
      trigger a reply via the existing chat seam (`streamChatWithEmployee`)
- [x] DMs with an AI counterparty reply on every message (no `@` needed)
- [x] Unread badges, read markers (`ChannelMember.lastReadAt`)
- [x] Edit / soft-delete own messages, broadcast over WS
- [ ] Typing indicators (plumbing lands with WS, UI deferred)
- [ ] Threaded replies (column exists, UI deferred)
- [ ] Search, link unfurls, desktop notifications

### M12 — Engineering Repos (AI employees that ship code)

Engineering AI employees need a working tree, not API calls — coding
providers (claude-code / codex / opencode / goose) are *editor-shaped*.
This milestone makes that real: each GitHub Connection materializes one
or more git checkouts into the employee's `cwd` before each spawn, the
agent uses normal `git` to branch + commit + push, and one new MCP tool
(`create_pull_request`) closes the loop.

- [ ] **GitHub OAuth + GitHub App auth modes.** Extend the existing
      `github` provider (currently `apikey` only) with `oauth2` and
      `github_app`. OAuth: add `"github"` to the `OauthApp` union in
      `services/oauth.ts:210` and to the dispatch switches at
      `oauth.ts:115` + `oauth.ts:235`; new helpers in
      `integrations/providers/github-oauth.ts` mirroring the Google /
      X shape. App: store `appId` + encrypted `privateKey` +
      `installationId`; mint installation tokens on demand and cache
      under their `expires_at`.
- [ ] **Per-Connection `repos[]` allowlist.** A Connection picks the
      subset of accessible repos that grants will materialize. Stored
      inside `IntegrationConnection.encryptedConfig.repos` as
      `{ owner, name, defaultBranch }[]` — no schema change. Editable
      from Settings → Integrations.
- [ ] **`services/repoSync.ts`.** Called from the runner pre-spawn
      block (parallel to `materializeMcpConfig` at
      `services/runner.ts:128`) and from `services/chat.ts`. Per
      granted repo: shallow `git clone` first time into
      `<employeeDir>/repos/<owner>/<name>/`, then
      `git fetch && git reset --hard origin/<defaultBranch>` on every
      subsequent spawn. Per-employee+repo lockfile so two concurrent
      runs on the same Connection serialize.
- [ ] **Token-based git auth.** Materialize `~/.git-credentials`
      (or a `GIT_ASKPASS` shim) inside the employee dir at spawn time
      so `git push` / `gh` work transparently inside the sandbox.
      Stripped after the spawn returns. App installations get a
      fresh, short-lived token per spawn.
- [ ] **One new MCP tool: `create_pull_request`** on the github
      provider. Inputs: `owner`, `repo`, `head`, `base`, `title`,
      `body`, `draft`. Branch + commit + push are normal `git`
      operations the agent runs itself in `repos/<owner>/<name>/`.
- [ ] **Settings → Integrations UI.** Github connect modal grows tabs
      for "GitHub App" / "OAuth" / "Personal token". Connection detail
      page lists materialized repos with checkboxes → save updates
      the allowlist.
- [ ] **Workspace visibility.** Employee Workspace tree (M7) gains a
      `repos/` subtree pre-populated by the runner. Read-only from
      the UI's perspective — the source of truth is the agent's
      working directory, not Genosyn-side mutations.
- [ ] **Engineering skill body.** Ship a default `Engineering` skill
      template that points the employee at `repos/`, the
      `create_pull_request` tool, and a "branch → commit → push → PR"
      playbook. Users attach it manually in M12; auto-attach lands
      with future "Templates / Hiring".

> **Why extend `github` instead of a new primitive.** Repos look like
> Connections (one auth blob per org/account) and grants look like
> grants (per-employee scoping). The novel piece is the pre-spawn
> materialization step, which is parallel to how `.mcp.json` already
> gets written before each run — adding it to the runner is one
> hook, not a new entity.

> **Deferred to a follow-up.** GitLab + Bitbucket parallels (same
> shape, separate providers); per-routine `git worktree` isolation
> (only if same-routine concurrency becomes a real problem); signed
> commits via the GitHub App identity; sandboxed/containerized
> execution (lives with the broader runner sandbox V1 backlog item).

### M13 — Lightning (Bitcoin payments for companies + AI employees)

A first-class **Lightning** Integration so a Company can hold a wallet
and grant individual AI employees the ability to send and receive
Bitcoin. Wallet-agnostic by default: each Connection holds a
**Nostr Wallet Connect (NIP-47)** URI minted by any compatible wallet
(Alby Hub, Mutiny, Phoenixd, Coinos, LNbits, Zeus, …), so operators
don't have to run a Lightning node to use Genosyn — but those who do
can point NWC at their own node.

- [x] **`lightning` provider** under `App/server/integrations/providers/lightning.ts`,
      `authMode: "apikey"`, category `Payments`. The "API key" is a
      single `nostr+walletconnect://…` URI. We reuse the Schnorr
      signing + NIP-04 encryption already pulled in by the `nostr`
      provider, so no new crypto deps.
- [x] **Tools.** Standard NIP-47 surface, expressed in **sats** at the
      tool boundary (NWC is millisats internally — the provider
      converts):
        * `get_info` — wallet alias, network, supported methods
        * `get_balance` — `{ balanceSats }`
        * `make_invoice` — `{ amountSats, description?, expirySeconds? }`
        * `pay_invoice` — `{ invoice, amountSats? }`
        * `pay_keysend` — `{ pubkey, amountSats, message? }`
        * `lookup_invoice` — `{ paymentHash? | invoice? }`
        * `list_transactions` — `{ from?, until?, limit?, type? }`
- [x] **Spending controls** stored on the Connection's encrypted
      config (no schema change): `maxPaymentSats` (single payment cap)
      and `dailyLimitSats` (rolling 24h cap, tracked via a compact
      `spendLog` updated through `ctx.setConfig`). Payments over the
      cap throw a user-facing error at the tool boundary so the AI
      sees a clean refusal and can ask a human.
- [x] **`checkStatus`** does a live `get_info` over the relays at
      Connection-create time and from the "Test connection" button,
      surfacing relay/auth/method-support failures up front instead
      of at first payment.
- [x] **Approvals plumbing.** Generalized the existing `Approval`
      entity so it can hold non-routine kinds (migration
      `1780100000000-ApprovalKinds`: `kind`, `title`, `summary`,
      `payloadJson`, `resultJson`, `errorMessage`). New
      `services/approvals.ts` dispatches on `kind`. Lightning
      providers throw a generic `ApprovalRequiredError` from the
      tool handler when amount > `requireApprovalAboveSats`; the
      central `invokeConnectionTool` dispatcher in
      `services/integrations.ts` catches it and writes a
      `lightning_payment` Approval row containing the original
      `(connectionId, toolName, args)`. On approve, the dispatcher
      decrypts the connection, replays the call with
      `bypassApprovalGate: true`, and persists `resultJson` (or
      `errorMessage` on failure). Approvals UI renders both kinds
      from one page with kind-specific titles + icons.
- [x] **Direct LND/CLN macaroon auth as a separate provider.** Shipped
      `lightning-lnd` (separate provider entry, same tool surface
      via `lightning-shared.ts`). Auth: REST URL + hex macaroon +
      optional PEM cert (textarea field — added `"textarea"` to the
      `IntegrationCatalogField.type` union and to the connect-modal
      renderer). Speaks LND's REST API directly via `node:https`
      with optional CA pinning. Tools: `get_info`, `get_balance`,
      `make_invoice`, `pay_invoice`, `lookup_invoice`,
      `list_transactions`. **Keysend not implemented** — LND's REST
      keysend path needs preimage synthesis and TLV envelope
      management; users who need keysend stay on the NWC provider.
      CLN (`cln_rest`) is a future companion — same shape, separate
      module.

> **Why NWC + LND, not just NWC.** NWC is the smallest viable auth
> surface (one URI, one form field) and immediately works against
> every self-custodial wallet — that's the default path. LND is for
> operators who run their own node and want sovereignty; the same
> tool surface means an AI employee can be ported between modes
> without changing prompts.

> **Why `lightning`, not `bitcoin`.** Bitcoin on-chain is a separate
> can of worms (xpub watch wallets, PSBT signing, broadcast via
> Mempool/Esplora, fee estimation). When that lands it gets its own
> provider — same category, different transport. Lightning carries
> the day-to-day flow (invoices, micropayments, agent-to-agent
> transfers); on-chain is for treasury-style movements.

---

## V1 backlog (post-MVP)

### Employee depth
- **Memory / Journal** — each employee keeps a running `memory/YYYY-MM-DD.md`
  log of what it did, decisions it made, questions it had.
- **Persisted Conversations** — the M7 chat is ephemeral (lives in the
  browser). Persist threads in the DB, show history, support `@ada`
  mentions elsewhere that trigger a reply.
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
- **MCP server support** — employees pick up MCP tools. *(Shipped:
  external MCP servers configurable per-employee, plus a built-in
  `genosyn` stdio server at `App/server/mcp-genosyn/` that exposes
  Routines / Projects / Todos / Journal writes back into Genosyn's own
  DB. Auth is a short-lived Bearer token minted per spawn. Writes are
  recorded in AuditEvent with `actorKind: "ai"`.)*
- **Integrations + Connections.** *(Shipping: Stripe, Gmail, Metabase.)*
  Framework for connecting third-party data sources. Vocabulary:
    * **Integration** — a connector type (Stripe, Gmail, Metabase, …).
      Static catalog defined in `server/integrations/providers/<name>.ts`.
      Not a DB row.
    * **Connection** — one authenticated account inside an integration
      ("Stripe US", "Stripe EU"). Per-company. DB row
      (`IntegrationConnection`). Multiple connections per integration
      are supported.
    * **Grant** — a permission binding one AI employee to one
      connection (`EmployeeConnectionGrant`). One grant = access to
      every tool the provider exposes (no per-tool scopes in MVP).
  Credentials (API keys, OAuth refresh tokens) are encrypted at rest
  with the existing `sessionSecret`-derived key. AI employees never
  see raw credentials: the built-in `genosyn` MCP stdio binary lists
  per-grant tools dynamically and proxies calls through the internal
  HTTP surface, which decrypts server-side and calls the provider.
  OAuth providers use `config.integrations.google.{clientId,clientSecret}`
  and `config.publicUrl` for the redirect URI.
- Google Calendar, Slack, GitHub, Linear, Notion, generic webhook.
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
- **CLI** — `genosyn` cluster-maintainer command for self-hosters. *(Shipped:
  `CLI/genosyn`, a bash wrapper around Docker with `install`, `upgrade`,
  `start`/`stop`/`restart`, `status`, `logs`, `backup`, `restore`, and
  `uninstall` subcommands. Installed via
  `curl -fsSL https://genosyn.com/install.sh | bash`, which also drops the
  CLI into `/usr/local/bin` — or `~/.local/bin` without sudo. Scripting
  surface — a second, product-facing CLI for programmatic operations on
  companies/employees/routines — is still pending.)*
- **Import/export** — back up a company (entities + filesystem tree).

### Runner
- Real execution for `claude-code`, `codex`, `opencode`, `goose`.
- Sandboxed execution env (docker or lightweight jail).
- Streaming logs to the UI.
- Per-run context window budget.

---

## V2+ wild ideas (parking lot)

- **Marketplace** — share Soul personas and skill packs publicly (exported
  from the DB as markdown bundles).
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
2. **Database as source of truth.** Soul, skills, routines, and captured
   run logs all live on their DB rows as markdown / text. One place to back
   up, one place to restore. The filesystem tree under `data/companies/…`
   only carries what the provider CLI needs at runtime (credentials,
   `.mcp.json`, cwd artifacts).
3. **Local-first & self-hostable.** SQLite works offline on a laptop;
   flip `config.db.driver` to Postgres when you outgrow it. Either way the
   same entities and migrations apply.
4. **Human-in-the-loop by default.** Autonomy is opt-in per routine.
5. **Boring tech, clean UI.** Express + TypeORM + React. No frameworks of the
   month. Interface should feel like Linear crossed with Notion.
