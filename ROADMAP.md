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
4. **AI Models are employee-owned; an employee can hold several with one
   active.** Each `AIModel` keeps its own credentials on disk under the
   employee's directory (or encrypted in `configJson`). An employee can
   register multiple models and flip exactly one to active (`AIModel.isActive`,
   newest-added wins by default) — the runner + chat seams always spawn the
   active one. No shared company pool. Firing an employee revokes every model's
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
- **AI Model** — a brain an AI Employee can run on: a direct connection to a
  model API. An employee can register several and keep exactly one active
  (`AIModel.isActive`). Provider is `anthropic` (Claude), `openai` (GPT), or
  `custom` (any OpenAI-compatible endpoint); the API key / base URL lives
  encrypted on `AIModel.configJson`. Genosyn calls the API in-process and runs
  the tool-use loop itself — no provider CLIs.
- **Run** — a single execution of a routine. The agent's transcript (streamed
  text + tool activity) is stored on `Run.logContent` (256 KB cap).
- **Integration** — a connector type (Stripe, Gmail, Metabase, …). Static
  catalog defined in `server/integrations/providers/<name>.ts`.
- **Connection** — one authenticated account inside an Integration. DB row
  (`IntegrationConnection`), per-company.
- **Grant** — an AI employee's access to a Connection
  (`EmployeeConnectionGrant`).
- **Code Repository** — any git repo the company adds so granted AI
  employees can read, commit, and push real code (`CodeRepository` +
  `EmployeeCodeRepositoryGrant`). Provider-agnostic (HTTPS / SSH), distinct
  from the GitHub-Connection-bound repos in M12.
- **Pipeline** — DAG of typed nodes for deterministic glue (separate
  primitive from Routines). Triggered manually, by webhook, or on cron.
- **Note / Notebook** — Notion-style company-wide markdown knowledge base.
- **Base** — Airtable-style multi-table workspaces with views, comments,
  attachments.
- **Channel / DM** — Slack-style workspace chat between humans and AI.
- **Handoff** — formal AI→AI delegation with status workflow.
- **Mail Handover** — one email thread handed to one AI employee to draft,
  reply, or triage (Email section, M25). Distinct from a Handoff, which is
  AI→AI.
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
- **Explore (M20):** `Chart`, `Dashboard`, `DashboardCard`
- **Notes (M11):** `Notebook`, `Note`, `EmployeeNotebookGrant`,
  `EmployeeNoteGrant`
- **Bases (M11.5):** `Base`, `BaseTable`, `BaseField`, `BaseView`,
  `BaseRecord`, `BaseRecordComment`, `BaseRecordAttachment`,
  `EmployeeBaseGrant`
- **Tasks (Projects + Todos):** `Project`, `Todo`, `TodoComment`,
  `ProjectMember`
- **Pipelines (M10):** `Pipeline`, `PipelineRun`
- **Integrations:** `IntegrationConnection`, `EmployeeConnectionGrant`,
  `McpServer` (external MCP server registry)
- **Code (M21):** `CodeRepository`, `EmployeeCodeRepositoryGrant`
- **Approvals + audit:** `Approval` (kind: routine | lightning_payment | …),
  `AuditEvent`, `Notification`
- **Email (transactional sends):** `EmailProvider`, `EmailLog`
- **Email client (M25):** `MailAccount`, `MailThread`, `MailMessage`,
  `MailLabel`, `MailRule`, `MailHandover`, `MailChatMessage`,
  `EmployeeMailAccountGrant`
- **Backups:** `Backup`, `BackupSchedule`, `BackupDestination`
- **Secrets:** `Secret`
- **Organization:** `Tag`, `TagAssignment` (company-scoped labels attached to
  taggable resources)

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
    driver: "sqlite", // "sqlite" | "postgres"
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },
  port: 8471,
  publicUrl: "http://localhost:8471",
  sessionSecret: "change-me-in-production",
  smtp: {
    host: "",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    fromName: "Genosyn",
    from: "no-reply@genosyn.local",
  },
  integrations: { google: { clientId: "", clientSecret: "" } /* … */ },
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
- [x] Home product pages — `/products` index plus a dedicated page per
      product surface (AI Employees, Workspace, Tasks, Bases, Notes,
      Resources, Pipelines, Explore, Email, Customers, Finance, Code),
      prerendered to static HTML at build time with per-route titles,
      descriptions, canonicals, Open Graph tags, and JSON-LD, plus
      sitemap.xml, robots.txt, and llms.txt / llms-full.txt so search
      engines and LLM crawlers index real content without executing JS

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
- [x] **Per-routine model.** `Routine.modelId` pins one of the employee's
      own `AIModel` rows; null (default) inherits the employee's active
      model. Runner resolves via `resolveRoutineModel()`; deleting a model
      clears the pins naming it. Runs only — chat stays on the active model.
- [x] **MCP surface** — `list_routines`, `create_routine`, `update_routine`
      (rename, recron, rewrite brief, enable/disable in place), and
      `delete_routine`, so an AI employee can manage routines end-to-end
      instead of only creating them.

### M23 — Routines section ✅

Routines were reachable only as a tab inside one employee. They are now a
top-level section of their own, listing every routine in the company.

- [x] Top-level **Routines** entry in the nav under a new "AI" group,
      alongside **AI Employees** (moved out of Essentials and relabelled
      from "Employees")
- [x] Company-wide `GET /routines` — every routine in the company with its
      `employee` and `lastRun` attached, sorted by employee then routine
      name. `GET /routines/:rid` is the same shape plus `body`.
- [x] Routines index: per-employee sidebar filter, health chips (All /
      Active / Paused / Needs attention), assigned-to column
- [x] Routine detail at `/routines/:empSlug/:routineSlug` — two slug
      segments because a routine slug is unique only per-employee — with
      Overview / Brief / Runs / Settings tabs
- [x] The employee Routines tab redirects to the company list filtered to
      that employee; existing `?routine=&run=` deep links preserved

### M24 — Skills section ✅

Skills were reachable only as a tab inside one employee, so the company's
playbook library was invisible. They are now a top-level section of their
own, alongside Routines — same shape, same reasoning.

- [x] Top-level **Skills** entry in the nav under the "AI" group, between
      **AI Employees** and **Routines** — who they are, what they know,
      when they work
- [x] Company-wide `GET /skills` — every skill in the company with its
      `employee` attached, sorted by employee then skill name. `body` is
      omitted; each playbook is fetched via `/skills/:sid/readme`.
- [x] `PATCH /skills/:sid` renames a skill, leaving the slug alone so
      links stay stable (this is what M4's "rename" claimed and never had)
- [x] Skills index: per-employee sidebar filter, free-text search over
      skill name and employee, known-by column
- [x] Skill detail at `/skills/:empSlug/:skillSlug` — two slug segments
      because a skill slug is unique only per-employee — with Playbook /
      Settings tabs. ⌘S saves the playbook, as the docs always claimed.
- [x] The employee Skills tab redirects to the company list filtered to
      that employee

### M27 — Company resource tags ✅

Reusable company labels for grouping resources without forcing a folder
hierarchy. Tags are case-insensitive within one company, free-form, and many
can be attached to the same resource.

- [x] `Tag` catalog plus polymorphic `TagAssignment` rows, with company
      ownership checks for Routines, Skills, Resources, Projects, Bases,
      Notebooks, Notes, Pipelines, Code Repositories, Charts, and Dashboards
- [x] Member-facing tag CRUD at **Settings → Tags**, including usage counts;
      renames update attached Resources and deletes detach without deleting
      the underlying resource
- [x] Multi-tag picker on all supported resource detail flows, plus create
      flows for Routines, Skills, and Resources, with inline creation of any
      new company tag
- [x] Tag chips and filters on the company-wide Routines, Skills, and
      Resources lists
- [x] Curated tag colors across chips, filters, and pickers, with color
      management in Settings and random colors assigned to existing tags
- [x] Existing comma-separated M18 Resource tags import into the company
      catalog on boot; the legacy string stays synchronized for MCP search and
      backwards-compatible Resource tools

### M25 — Email (agentic Gmail client) ✅

A top-level **Email** section: connect a Gmail account through the existing
Google integration, read and act on the mailbox like a mail client, and hand
threads to AI employees — on demand or automatically when mail arrives.
Distinct from the transactional **EmailProvider / EmailLog** subsystem (which
sends system mail); this is the company's real inbox. Internal namespace is
`Mail*` / `/api/companies/:cid/mail` so the two never collide.

- [x] **Entities.** `MailAccount` (rides on a `google` IntegrationConnection
      whose consent included the Gmail scope group; stores address, sync
      cursor `historyId`, status), `MailThread` + `MailMessage` (local mirror
      of the mailbox: headers, text + HTML bodies with size caps, label ids,
      attachment metadata), `MailLabel` (system + user labels),
      `MailRule` (automation on inbound mail), `MailHandover` (one thread
      handed to one AI employee with a status lifecycle), and
      `EmployeeMailAccountGrant` with three escalating capabilities
      `read` < `draft` < `send` (default `draft`: an employee can triage and
      write drafts, but a human presses Send).
- [x] **Two-way sync** (`services/mail/`). 30s heartbeat poller (same shape
      as cron.ts) per active account. The first import walks the **entire
      mailbox** newest-first — resumable across passes via a persisted
      `backfillPageToken` cursor + `backfilledCount` progress, so a large
      account imports fully in the background without blocking or flooding
      the API — then `history.list` incremental sync from the stored
      `historyId` (re-anchors with a fresh import + stale-row prune when
      Gmail expires the cursor). Errored accounts self-heal on a slower
      retry cadence rather than parking forever. Every action taken in
      Genosyn — read/unread, star, archive, trash, label, draft, send —
      writes through to the Gmail API first and re-syncs the affected
      messages, so Gmail and Genosyn stay consistent both ways. No Pub/Sub
      dependency: polling keeps self-hosted installs zero-config.
- [x] **Mail client UI** under `/c/<co>/mail`: folder + label sidebar with
      unread counts and import progress, thread list with **full-body
      search** (subject, participants, and message text via a portable
      EXISTS subquery), thread view (sanitized HTML bodies via DOMPurify —
      remote images blocked in the DOM until clicked, inline data:/cid
      images allowed), compose / reply / reply-all / **forward**,
      **outbound attachments** (staged upload + multipart/mixed MIME),
      inbound attachment download, drafts (including drafts AI employees
      wrote — edit then send), per-thread actions, account settings. The
      goal: never open Gmail to work the inbox.
- [x] **Hand to AI.** "Hand to AI" on any thread picks a granted employee,
      an instruction, and a mode: `draft` (employee writes a Gmail draft
      into the thread for human review), `reply` (employee sends —
      requires the `send` grant), or `triage` (employee labels / archives /
      flags). Handovers run through the chat seam (`chatWithEmployee`) on a
      small in-process queue; status + result surface in the thread view
      and the Handovers page, with bell notifications on completion/failure.
- [x] **Rules.** Per-account automation evaluated on every new inbound
      message the sync ingests: conditions (from / to / subject / body
      contains, has attachment) → actions (apply label, mark read, star,
      archive, hand to an AI employee with an instruction + mode). This is
      the "when an email comes in, ask an AI employee to categorize it"
      loop. Scheduled email work (inbox digests etc.) needs no new
      machinery — Routines can call the mail tools.
- [x] **MCP surface.** `list_mail_accounts`, `search_mail` (full-body index
      search with from / to / date / label / attachment filters),
      `get_mail_thread`, `create_mail_draft`, `update_mail_thread`,
      `send_mail` — grant-gated per account + capability, collapsed into a
      single `mail` family tool for the agent. AI writes record AuditEvent +
      JournalEntry like every other MCP write.
- [ ] Gmail Pub/Sub push (instant sync) — deferred; polling is the
      self-host-friendly default
- [ ] Forwarding original attachments (re-fetch + re-stage) and send-as
      aliases — deferred (forwarded body notes original attachment names)
- [x] **The grant levels bind every route to the mailbox.** The Google
      connector's `gmail_*` tools reach the same account with the same
      token, and originally honoured only the Connection grant — which made
      the `draft` default advisory, since an employee could just send
      through the integration surface instead. They now answer to the same
      `EmployeeMailAccountGrant` levels via an `assertCapability` closure
      the dispatcher binds to the caller (`services/connectionCapabilities.ts`),
      mapping read/draft/send onto the five `gmail_*` tools. A connection
      with no `MailAccount` is ungoverned and still passes — there is no
      level to enforce until a human connects the mailbox.
- [ ] Retire the `gmail_*` compose tools in favour of `send_mail` /
      `create_mail_draft`, once the latter accept Resource attachments.
      Two compose surfaces over one mailbox is a standing drift risk; the
      gate above keeps them consistent but does not merge them.
- [ ] Approval-gated `send_mail` (Approval kind `mail_send`) — deferred;
      the `draft` grant level is the human gate today
- [x] **Sync resilience + live import.** The backfill checkpoints its page
      cursor after every page (a caught error or hard crash resumes from the
      last completed page, never from scratch), skips threads deleted
      between listing and fetch instead of stalling the import, and every
      mid-import pass ALSO replays the history log first — so new mail
      shows up (and rules fire) within a heartbeat even while a huge
      mailbox is still importing. Un-pausing an account syncs immediately
      instead of waiting for the next heartbeat.
- [x] **Search grammar** (`services/mail/searchQuery.ts`) shared by the
      thread-list search box and the `search_mail` tool: terms AND together
      across subject/participants/snippet/body/addresses, quoted phrases,
      and Gmail-style operators — `from:` `to:` `subject:` `label:`
      `in:inbox|archive|sent|drafts|all|spam|trash` `has:attachment`
      `is:unread|read|starred` `before:`/`after:`. A search covers all mail
      (minus spam/trash) rather than the folder being viewed; `in:` narrows
      back down. The search box gets a `/` shortcut, a clear button, an
      operator cheat-sheet popover, a result-count header, and term
      highlighting in the result rows.
- [x] **Mail assistant** — a chat panel docked beside the whole Email
      section (`MailAssistant`, one rolling conversation per mailbox on
      `MailChatMessage`). Tag any AI employee with `@slug` (sticky until
      somebody else is tagged), and the turn runs through the chat seam
      with the mailbox + currently-viewed thread injected as context
      (thread contents only when the employee holds a `read` grant).
      Replies carry **action pills** (what the employee did, from
      AuditEvents) and **suggestion buttons** — structured next steps the
      employee proposes via the new `suggest_mail_actions` tool (op
      `suggest` on the `mail` family): open a pre-filled reply, send a
      draft, triage, open a thread, start a handover, or create an inbox
      rule. Buttons execute through the ordinary human routes with the
      human's own authority — so a `draft`-level employee can _propose_ a
      send the human approves with one click — and consuming buttons are
      stamped executed server-side so a reload can't re-arm them.

### M6 — AI Models (employee-owned) ✅

> **Superseded by M22.** The provider-CLI harnesses, subscription sign-in, and
> per-provider config materialization below were removed; Genosyn now calls the
> model API directly in-process. The employee-owned / one-active model remains.

- [x] `AIModel` employee-owned — many per employee, exactly one active
      (`AIModel.isActive`, newest-added active by default, switchable any time);
      runner + chat run the active one
- [x] Provider-specific setup for claude-code / codex / opencode / goose
- [x] Subscription sign-in flow (UI polls for credentials file)
- [x] API-key flow with AES-256-GCM encryption
- [x] Runner spawns provider CLI in employee cwd with scoped env
- [x] CLI install + sign-in flow brought into the browser
- [x] Disconnect deletes DB row and wipes credentials
- [x] `openclaw` provider added (apikey-only)
- [x] OpenClaw built-in `genosyn` MCP server (read-merge-write of the
      `mcp.servers` block inside openclaw.json)

### M22 — Direct model APIs (harnesses removed) ✅

- [x] Removed the five provider-CLI harnesses (`claude-code`, `codex`,
      `opencode`, `goose`, `openclaw`) — providers are now `anthropic`,
      `openai`, `custom` (OpenAI-compatible), authMode `apikey` | `customEndpoint`
- [x] In-process agent runtime (`server/services/agent/`): a provider-agnostic
      tool-use loop over the Anthropic Messages API, OpenAI Chat Completions,
      and OpenAI-compatible custom endpoints, with native streaming
- [x] Tools provided directly to the model: built-in coding tools (bash +
      file read/write/edit/glob/grep), the genosyn tools (dispatched in-process
      over loopback), browser tools (bridged from the stdio MCP child), and
      company-configured MCP servers (bridged over stdio/HTTP)
- [x] **Bounded parallel delegation.** Chat turns and Routine runs expose
      `delegate_parallel_work`: one AI Employee can run up to four temporary
      copies of itself concurrently (eight briefs per call, twelve per turn),
      then verify and synthesize their ordered results. Workers inherit the
      same Soul, Skills, AI Model, Grants, secrets, working directory, and
      timeout; recursion stops after one level.
- [x] Dropped subscription/OAuth sign-in, the in-browser pty install/login
      surface, node-pty, and the per-provider on-disk credential dirs; model
      credentials live encrypted on `AIModel.configJson`
- [x] Data migration remapping existing rows onto the new provider/authMode
      vocabulary

### M7 — Chat + Workspace ✅

- [x] Top-nav sections with context-specific sidebars
- [x] Per-employee sub-nav (Chat / Workspace / Soul / Skills / Settings /
      Connections / Handoffs / Journal)
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
- [x] Guided builder UX overhaul: client-side readiness checks
      (`getPipelineIssues` — missing trigger, broken edges, invalid
      cron/JSON, cycles) driving Needs setup / Ready / Paused badges,
      `startWith` starters (manual / schedule / webhook) seeded at create,
      resource pickers fed by live company data, an Integration-step
      action picker from the catalog's `integrationTools`, and a docs
      page at `/docs/pipelines`

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

### M11.6 — Record link columns + record pages ✅

- [x] Seven record-link field types — `customer`, `invoice`, `project`,
      `employee`, `member`, `note`, `pipeline` — so Base columns can point
      at records across Genosyn; cells store arrays of ids, no config and
      no migration (field `type` is a varchar)
- [x] `buildResourceOptionsFor` in `services/baseResources.ts` resolves
      ids → label / sublabel / deep-link URL per product. Restricted
      projects are filtered per viewer; archived customers and notes stay
      resolvable in existing cells but hidden from pickers
- [x] Grid, drawer, and view filters: chips deep-link to the target
      record, searchable pickers, `has any of` / `has none of` operators
- [x] Full-page record view at `/bases/<base>/<table>/r/<id>` — every
      column viewable and editable, comments + attachments, delete;
      the drawer's "Open full page" button links to it
- [x] MCP surface: record-link types in `add_base_field`;
      `list_base_rows` / `get_base_record` return a capped
      `resourceOptions` map so agents write valid ids
- [x] First dedicated Bases docs page (`/docs/bases`)

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

### M21 — Code Repositories ✅

Provider-agnostic cousin of M12. Where M12's repos ride on a GitHub
**Connection** + allowlist, a **Code Repository** is a first-class
company row pointed at _any_ git URL (GitHub, GitLab, Bitbucket,
self-hosted) over HTTPS or SSH, with access handed out per-employee.
"Add any repo; let the employees you choose commit and push."

- [x] `CodeRepository` entity — companyId, name, slug, gitUrl,
      defaultBranch, authMode (`none` | `https` | `ssh`), httpsUsername,
      encrypted token + encrypted SSH key (AES-256-GCM via `lib/secret`),
      committer identity, last-sync health. Credentials never returned to
      the client in plaintext.
- [x] `EmployeeCodeRepositoryGrant` — employee → repo with `read` < `write`
      (write = commit + push). Default `write`; sharing is fully opt-in
      (no auto-grant-to-all).
- [x] `services/codeRepos.ts` — `materializeCodeReposForEmployee` clones
      each granted repo into `<employeeDir>/code-repos/<slug>/` before every
      chat / routine spawn; per-(employee × repo) mutex; fetch-only on
      existing checkouts. HTTPS token rides a per-repo env var +
      credential-helper (never on disk); SSH key written 0600 + pinned via
      `core.sshCommand`. Read-only grants get the push URL disabled.
      `testCodeRepoConnection` probes creds via `git ls-remote --symref`.
- [x] HTTP routes under `/api/companies/:cid/code-repositories`: CRUD,
      `/test`, grant CRUD + candidates. zod-validated.
- [x] Prompt context — granted repos + their checkout paths + push rights
      injected into the chat / routine prompt; `list_code_repositories` MCP
      tool on the built-in `genosyn` server.
- [x] React UI under `/c/<co>/code`: index (list + add modal), detail
      split into sidebar-addressable Overview, AI access, and Settings pages
      (connection health, per-employee PR readiness, credentials, delete).
      New "Code" section under an Engineering group in the app shell.
- [x] Code-delivery guidance — repository context tells employees to branch,
      edit, test, commit, push, then call the granted GitHub
      `create_pull_request` tool; the UI shows which write-granted employees
      have that tool through a connected GitHub Connection.
- [ ] Worktree-per-routine isolation (shared with M12; deferred)
- [ ] Browse the checkout in a web file tree (deferred — agents use it on
      disk today)

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
- [x] `EmployeeResourceGrant` entity — employee → resource, with three
      escalating capabilities `read` < `edit` < `delete` (richer than
      notes' `read` / `write` because the team often wants employees
      that can keep a page tidy without authority to remove it).
- [x] Ingestion service `services/resources.ts`: * URL → `fetch` + minimal HTML→text (no jsdom/readability dep) * Plain text / `.txt` / `.md` / `.html` upload → store + index * PDF upload → text via `pdf-parse` (new dep, flagged below) * EPUB upload → unzip + collect XHTML body text via existing `unzipper` * Video → accepted but flagged `failed` with a "transcripts coming
      soon" note (no ASR dep)
- [x] HTTP routes under `/api/companies/:cid/resources`: list, create
      (URL / paste / upload via multer, 25 MB cap), detail, patch
      (rename + retag + body for `text`-kind), delete, plus grant CRUD.
      The `/file` endpoint serves inline by default (so PDFs render in a
      browser viewer and the EPUB reader can fetch the bytes); pass
      `?disposition=attachment` to force a download.
- [x] MCP tools — read (any grant): `list_resources`,
      `search_resources`, `get_resource`. `create_resource` (text or URL
      — file uploads stay humans-only) is open to everyone and grants the
      author `delete` on the row. `update_resource` requires `edit` or
      higher; `delete_resource` requires `delete`. Teammates start at
      `read` on rows they didn't author and humans promote them from the
      share modal.
- [x] React UI under `/c/<co>/resources`: Notion-style centered layout
      with quick-add tiles (URL / Paste / Upload), search-as-you-type,
      compact list view, share modal. Detail page is type-aware —
      text resources are an editable markdown document, PDFs render in
      a native browser iframe, EPUBs render via `epubjs` with TOC and
      progress, videos use `<video>`, URL resources surface as a
      prominent "Open original" card. The auto-summary section was
      dropped from the detail page (still produced for the index list).
- [x] AppShell sidebar entry under "Knowledge".

**New dependencies:** `pdf-parse` (small, well-maintained, Node 22 OK)
for ingestion; `epubjs` + `jszip` for the EPUB reader on the detail
page. Avoided the bigger choice of an embeddings store + vector
search; v1 relies on substring matching over titles, summaries, and
`bodyText`, same as `search_notes`. Embeddings + RAG land in a future
milestone once we know what the team actually queries.

### M20 — Explore (Metabase-style BI)

Self-serve analytics over the database integrations the company already
connects. Distinct from `Base` (Airtable-style structured workspaces the
team writes into) and from running queries by hand inside the Postgres /
MySQL / ClickHouse integration tools: an **Explore** surface lets humans
and AI employees save SQL queries as named **Charts**, pick a
visualization (table, scalar, bar, line, area, pie), and pin those charts
onto **Dashboards** that other members can read at a glance.

Phase A — Foundation (this milestone)

- [x] **Entities.** `Chart` (companyId, slug, title, description,
      connectionId → IntegrationConnection, sql, vizType, vizConfig JSON,
      author bookkeeping). `Dashboard` (companyId, slug, title,
      description, author bookkeeping). `DashboardCard` (dashboardId,
      chartId, x/y/w/h grid placement, optional title override).
- [x] **Executor service** at `services/explore.ts` that resolves an
      `IntegrationConnection` of provider `postgres` / `mysql` /
      `clickhouse`, decrypts the per-provider config, and runs the
      caller's SQL through `pg` / `mysql2` / `@clickhouse/client`
      respectively. Wall-clock timeout 30s, row cap 5,000 — same envelope
      as the integration tools. Read-only is **not** enforced; users
      should connect with a least-privileged role.
- [x] **HTTP routes** under `/api/companies/:cid/explore/*`: list
      database-shaped connections, run ad-hoc SQL (`POST /run`), CRUD
      Charts + Dashboards, run a saved Chart, add/move/remove
      DashboardCards.
- [x] **Visualization** — six built-in types implemented as inline SVG
      so we don't add another chart-lib dep: `table`, `scalar`, `bar`,
      `line`, `area`, `pie`. A `ChartRenderer` component picks one based
      on `vizType` + `vizConfig` (which column is the dimension, which
      column(s) are measures, and stack/orientation flags for bar).
- [x] **React pages** at `/c/<co>/explore`: index (recent charts +
      dashboards + database sources), chart editor (SQL textarea +
      result preview + viz picker + viz config side panel), dashboard
      view (grid render), dashboard edit (drag-grid of cards).
- [x] **MCP tools** — `list_charts`, `get_chart`, `run_chart`,
      `create_chart`, `update_chart`, `delete_chart`, `list_dashboards`,
      `get_dashboard`, `create_dashboard`, `add_dashboard_card`. AI
      employees can author Charts the team will see in the same way
      they already author Notes and Bases.

Phase B+ (deferred — out of this PR)

- Parameters / filters (date range, dropdown bound to a column).
- Scheduled deliveries (email a PNG of the dashboard at 9am).
- Embedding (public read-only links, signed).
- Snowflake / BigQuery / Redshift connectors.
- Native (no-SQL) query builder over a column picker.
- AI-suggested charts on a new connection.

### M15 — 2FA / TOTP (planned)

- [ ] `User` gets `totpSecret` (encrypted), `totpEnabledAt`, `recoveryCodes`
- [ ] Enroll flow with QR (otpauth://… → render via `qrcode` dep)
- [ ] Verify on login when enabled; recovery-code path
- [ ] Per-company "require 2FA" admin policy (later)

### M16 — SSO login (Google / OIDC) (shipped)

Instance-wide single sign-on, configured from Admin → SSO and **disabled by
default**. Rather than reusing a company's `integrations.google` Connection
(login is instance-scoped, not company-scoped), the operator registers a
dedicated OAuth client and Genosyn runs a spec-minimal OIDC
authorization-code flow in-process — discovery document + `userinfo`, no JWT
libraries. Google is just a preset issuer; Okta / Keycloak / Entra ID / Auth0
work the same way.

- [x] Admin → SSO: enable toggle (off by default), Google or custom-OIDC
      issuer, client id + secret (encrypted at rest via `lib/secret.ts`),
      button-label override, "check issuer" discovery probe, callback URL
      readout
- [x] `User.ssoIssuer` + `User.ssoSubject` (unique pair, nullable); existing
      accounts link by verified email on first SSO sign-in
- [x] Login page grows a "Continue with …" button when enabled; SSO failures
      round-trip back to `/login?ssoError=…`
- [x] Auto-provision toggle — create accounts on first sign-in, or admit
      only existing/invited users
- [ ] Owner can require SSO for their company (deferred)

### M17 — Marketplace (planned)

- [ ] Export an employee as `{ soul, skills[], routines[], grants[] }`
      bundle
- [ ] Import a bundle to scaffold a new employee (extends Templates)
- [ ] Public-by-URL share — landing page on Home consumes the bundle JSON

### M19 — Finance (Invoicing + Accounting)

Native finance suite for the company. Customers, products, tax rates;
invoices with HTML render → browser-print to PDF and "Send" via the
existing per-company `EmailProvider`; payments tracked against invoices;
double-entry general ledger that auto-posts from the invoice lifecycle;
financial reports (P&L, Balance Sheet, Cash Flow); reconciliation against
Stripe payouts and Brex Cash transactions; Brex corporate card expense and
liability accounting; multi-currency with FX gain/loss;
period-close workflow;
accountant exports; vendor/bills mirror of the invoice flow. Distinct
from the Stripe **integration** (read-only catalog of customers /
charges / subscriptions), which stays as-is.

Money is stored as integer **minor units** (cents) plus a 3-letter ISO
currency code on every row. Phase A defaults everything to USD with a
per-invoice override; Phase E adds the FX rate engine. Invoice numbers
are gapless per-company sequences (`numberSeq` int, displayed as
`INV-0001`) — accountants need this for compliance.

Phased so each phase ships behind its own PR:

- [x] **Phase A — Customers + Invoices.** `Customer`, `Product`,
      `TaxRate`, `Invoice`, `InvoiceLineItem`, `InvoicePayment` entities.
      CRUD UI for all four. Invoice creator with line items + per-line tax
      (inclusive or exclusive). Status lifecycle draft → sent → paid (with
      manual mark-as-paid for now) / overdue (computed) / void. Print-
      friendly `InvoicePrint` page (browser → "Save as PDF"). "Send" button
      emails the customer the HTML invoice via the company
      `EmailProvider`. Top-level "Finance" sidebar entry. **No ledger
      yet.**
- [x] **Phase B — General Ledger.** `Account` (chart of accounts;
      seeded with a sane default CoA on first visit), `LedgerEntry`,
      `LedgerLine` (double-entry, balanced enforcement at the service
      layer — the entity is named `LedgerEntry` rather than the
      accountant-natural "JournalEntry" because the codebase already had
      a `JournalEntry` for per-employee diary feeds; product copy still
      says "journal"). Auto-post from invoice issued (DR AR / CR Revenue + Tax Payable), invoice paid (DR Bank / CR AR), invoice voided
      (reverses every entry tied to the invoice). Manual journal entry
      UI for accountants. Trial balance view.
- [x] **Phase C — Reports.** Income Statement (P&L), Balance Sheet,
      Cash Flow Statement. Period filters (this month / quarter / YTD /
      custom). Comparison columns (vs. prior period). Drill-through from
      any account row to a running-balance ledger of its source entries.
- [x] **Phase D — Reconciliation.** `BankFeed` (Stripe payouts and
      native Brex Cash sync; CSV import as the universal fallback),
      `BankTransaction` ingestion with auto-match heuristics (amount +
      date proximity), manual matching UI with ranked candidates, unmatch
      escape on reconciled rows. Re-uses the existing
      `IntegrationConnection` framework for credentials.
- [x] **Corporate card accounting.** `CardFeed` and `CardTransaction`
      ingest the complete settled Brex primary-card history. Purchases auto-post
      DR Expense / CR Corporate Card Payable, refunds reverse those legs, and
      statement collections post DR Card Payable / CR Bank. Expense-category
      changes create append-only reclassification entries; failed postings stay
      visible and retryable.
- **Phase E — Multi-currency.** `Currency`, `ExchangeRate`, and
  `CompanyFinanceSettings` (home currency). Per-invoice currency with
  FX gain/loss auto-posted on payment when the rate at payment differs
  from the rate at issue. Per-line audit columns on `LedgerLine`
  (`origCurrency`, `origAmountCents`, `rate`).
  **Composable tax-rule engine deferred to a follow-up phase** —
  Phase A's flat `TaxRate` continues to work and is sufficient for
  most jurisdictions; composable rules earn their complexity once a
  user actually hits the limit.
- [x] **Phase F — Period close + Accountant exports.**
      `AccountingPeriod` with open / closed status. Closing posts a
      single balancing entry into 3100 Retained Earnings and locks the
      window — `postLedgerEntry` refuses to write inside a closed
      period. Plain-CSV exports (customers / invoices / general journal /
      trial balance) cover the common accountant hand-off; IIF / Xero
      -shaped exports are deferred until a real user asks for them.
- [x] **Phase G — Vendor side.** `Vendor`, `Bill`, `BillLineItem`,
      `BillPayment`. Mirror of invoices but inbound — issue auto-posts
      DR per-line Expense / CR 2200 Accounts Payable; payment auto-posts
      DR Accounts Payable / CR Bank with FX gain/loss for foreign-
      currency bills (mirrors the customer flow). Vendors / Bills sub-
      nav under Finance.
- [x] **Phase A follow-up — Recurring invoices.** `RecurringInvoice` +
      `RecurringInvoiceLineItem` entities. Cron-driven heartbeat
      (`services/recurringInvoices.ts`) materializes a fresh `Invoice`
      on each tick, optionally auto-issuing + emailing it via the
      existing send path. Status lifecycle active → paused → ended;
      optional `maxRuns` and `endsOn` caps flip to ended automatically.
      Sidebar entry under Finance, dedicated list / new / detail pages
      with cron presets + human-readable schedule preview.
- [x] **Customers spun out — accounts, ACV + contracts.** Customers
      graduated from a Finance sub-page to their own top-level
      **Customers** section (Customers + Contracts sub-nav; old
      `/finance/customers` URLs redirect). Added an **Annual Contract
      Value** money column on `Customer` (`annualContractValueCents`,
      shown in the customer list) and a new `CustomerContract` entity for
      uploaded signed agreements — a global Contracts page plus a
      per-customer panel, with bytes on disk under `customer-contracts/`
      like other attachments and metadata-only rows in the DB.
- [x] **Customer statements.** Statement of account per customer, derived
      on the fly from issued invoices + payments (no entity): chronological
      charge/credit ledger with a running balance, opening/closing totals, and
      an aging summary (current / 1-30 / 31-60 / 61-90 / 90+). Per-currency
      with a switcher; period presets (all time default) plus a custom range.
      In-app view at `/customers/:slug/statement`, served as printable HTML and
      a downloadable PDF via the same `htmlToPdf` path invoices use
      (`services/customerStatement.ts` + `customerStatementHtml.ts`).

MCP surface (added phase by phase): `list_invoices`, `get_invoice`,
`create_invoice`, `send_invoice`, `record_payment`, `void_invoice`,
`list_customers`, `create_customer`, `get_pl`, `get_balance_sheet`,
`post_journal_entry`, etc. Read-only tools land first; mutating tools
gate behind the existing approval-by-amount pattern Lightning uses.

### M26 — Paid Marketing (ad-platform Integrations + spend guardrails)

AI employees run, monitor, and optimize paid ad campaigns — safely. Native
Integrations for the platforms whose credential model fits self-hosting
(each company brings its own developer credentials; no central partner
app), read-first tools for pacing/reporting, and a deliberately tiny
mutation surface (pause / enable / budget change) where **every
spend-increasing write defaults to a human Approval**, generalizing the
Lightning spending-controls pattern. Platforms whose APIs are gated behind
slow human reviews (LinkedIn, X, TikTok) are served by the existing
browser tools + live take-over instead of native providers.

- [x] **Approval notifications for every kind.** `notifyApprovalPending`
      was routine-only; Lightning and browser approvals raised from chat
      never paged anyone. Now every pending Approval fans out bell +
      websocket + web-push to owners/admins, and the create-helpers in
      `services/approvals.ts` notify automatically.
- [x] **Guarded MCP tools.** Company-configured MCP servers can name
      guarded tool patterns (`ads_create_*`); matching calls queue an
      Approval (kind `mcp_tool`) with the verbatim call snapshotted and
      replay server-side on approve. Closes the hole where a write-capable
      external MCP server bypassed every Genosyn guardrail.
- [x] **Ads approval plumbing.** `ApprovalRequiredError` generalized
      beyond sats (kind + typed request payload, Lightning back-compat);
      new Approval kind `ad_spend` with create/execute/reject dispatch,
      before→after snapshot in the payload, and a drift check on replay
      (re-read the live object, abort if it changed since queueing).
- [x] **AdSpendEvent ledger.** Append-only, SQL-queryable record of every
      authorized budget delta (connection, employee, platform refs, signed
      minor-unit delta, approval id) — answers "how much did this employee
      authorize this month?" from the database. Rolling daily/monthly caps
      compute from it; caps re-run even on approved replay.
- [x] **Spend safety knobs per Connection** (`ads-shared.ts`, mirrors
      `lightning-shared.ts`): max single budget increase, rolling 24 h and
      30-day authorized-increase caps, `requireApprovalAbove` defaulting
      to 0 (every increase gated out of the box), and a kill switch that
      blocks all mutations. Spend-_decreasing_ actions (pause,
      budget-down) are fast-pathed — never blocked behind an approval —
      because pausing a runaway campaign is the emergency action.
- [x] **google-ads provider.** Rides the shared `google` OAuth app with an
      `adwords` scope group (the google-analytics precedent) + extra
      connect fields (developer token, login customer id). REST + GAQL:
      accounts, campaigns, reports, spend summary; gated pause/enable +
      budget mutations. API version pinned as a config constant.
- [x] **meta-ads provider.** API-key style: pasted Business Manager
      system-user token + ad account ids (no app review for a company's
      own accounts). Graph Marketing API insights + campaign reads, gated
      mutations, token-health `checkStatus`.
- [x] **microsoft-ads provider.** New `microsoft` OAuth app case
      (`msads.manage` + `offline_access`, rotating refresh tokens
      persisted via `ctx.setConfig`); Bing Ads REST v13 reads + gated
      mutations; developer token / customer id / account id connect fields.
- [x] **reddit-ads provider.** Rides the existing `reddit` OAuth app with
      ads scopes against `ads-api.reddit.com/api/v3`; hourly token refresh;
      reads + gated mutations.
- [x] **OAuth extra connect fields.** OAuth catalog entries can declare
      extra create-time fields (developer tokens, account ids) rendered in
      the connect modal and persisted into the encrypted config.
- [x] **Paid Marketing employee template** ("Sales & Marketing"): Soul
      encoding budget discipline (cite spend data, escalate anomalies,
      never raise budgets without approval), Skills for pacing checks and
      ROAS readouts joining ad spend against GA4 conversions and Finance
      invoices, Routines for a daily pacing check and weekly report.
- [x] **Docs + product surface.** Integrations docs sections per platform
      (incl. the Google OAuth consent-screen 7-day refresh-token trap and
      platform-side spending-limit backstops), browser-fallback recipe for
      LinkedIn / X / TikTok, Marketing product page on Home.

Deferred deliberately: campaign/creative creation (until the read+lever
loop proves out), audience/PII uploads, a campaign-mirror workspace
section, LinkedIn/X/TikTok native providers (review-gated; browser
fallback documented), FX conversion for caps (caps are denominated in the
ad account's currency).

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
- [x] **Subtasks** — `Todo.parentTodoId`, one level deep; checklist +
      progress in the peek panel, parent/progress chips in list & board,
      `create_todo` / `update_todo` MCP params for AI breakdown
- [x] **Default assignee = creator** — a todo created without naming an
      assignee belongs to whoever created it (explicit null still means
      unassigned; MCP `create_todo` already defaulted to the calling
      employee)
- [x] **Auto-start on assign** — assigning a todo to an AI employee (on
      create or reassign, from the app) kicks off a background work session
      immediately: the todo flips to `in_progress`, the employee works it
      with its full toolset and posts its report as a thread comment, then
      moves the todo to `done` — or `in_review` when a reviewer is set.
      Skipped quietly when the employee has no AI Model connected
      (`services/todoKickoff.ts`)
- [x] **Project access** — `Project.accessMode` (`open` / `restricted`) plus
      `ProjectMember` rows authorizing human Members _and_ AI Employees at
      `read` / `write`. Todos and comments inherit the project's access;
      both the list and board views are gated by it. Projects are `open` by
      default, so nothing changes until someone restricts one
- [ ] **Share a project with a Team** — blocked on humans being able to
      belong to a `Team` at all (today `Team` groups AI employees only)

### Integrations

- [x] **MCP server support** (external + built-in `genosyn` stdio binary
      with short-lived per-spawn Bearer)
- [x] **Integrations + Connections framework** with grants
- [x] **Stripe, Gmail, Metabase, GitHub, Linear, Notion, Postgres,
      MySQL, Clickhouse, Redis, Airtable, NocoDB, Telegram, X.com,
      Nostr, Lightning (NWC + LND), Google (Calendar + Drive + Gmail
      scopes), Google Analytics (GA4, read-only), Google Search
      Console (read-only), Reddit, LinkedIn**
- [x] **Secrets vault** (`Secret` entity, env-merged into spawns)
- [x] **Incoming webhooks** for both routines and pipelines
- [x] **Email attachments from Resources** — `gmail_send_message` /
      `gmail_create_draft` take `attachments: [{resourceSlug, format}]`.
      The server resolves the slug, checks the `EmployeeResourceGrant`,
      and attaches the bytes; slugs only, so no base64 ever crosses the
      model. `format: "original"` attaches the uploaded file verbatim,
      the rest render `bodyText` through the export pipeline.

### Org depth

- [x] **Teams** + reporting lines (`reportsToEmployeeId` org chart)
- [x] **Templates / Hiring** — `EMPLOYEE_TEMPLATES` static catalog,
      consumed by `EmployeeNew.tsx` to seed Soul + Skills + Routines

### Platform

- [ ] **API keys + REST API** — see M14 above
- [x] **Audit log** (`AuditEvent` with `actorKind: human | ai | webhook`)
- [x] **Usage & cost** — per-employee / per-routine token spend rollups
- [x] **Backups** — `Backup` + `BackupSchedule`, restore endpoint,
      catch-up backup on boot, plus off-box `BackupDestination` mirrors
      (mounted NAS path, SMB share, or SFTP) that auto-deliver every
      completed archive. Retention on the `BackupSchedule` row deletes local
      archives past a day count (hourly + after each backup), always sparing
      the newest completed archive and anything uploaded by hand
- [x] **Migrations dashboard** — read-only `Admin → Migrations` over the
      TypeORM ledger: applied / pending counts plus drift detection (rows
      matching no shipped migration, out-of-order timestamps from a branch
      merge). Boot still applies migrations automatically; this is the
      detail view behind the Instance Health migrations probe
- [x] **Notifications** — bell + panel, per-user feed
- [x] **Web Push (PWA)** — `web-push` + auto-generated VAPID keypair in
      `app_settings`, `PushSubscription` per device, fan-out on every
      bell row, `push`/`notificationclick` handlers in `sw.js`, opt-in
      from Home banner or Settings → Profile
- [x] **Command palette (⌘K)** — centred, searchable directory of every
      section, opened by `⌘K`/`Ctrl K` or the top-nav section pill. Ranked
      search over labels, descriptions, and a hidden synonym index (typing
      "cron" lands on Routines), full keyboard control. Replaced the mega-menu
      that used to drop out of the section pill
- [x] **Palette entity search** — the ⌘K palette also searches the company's
      content by name (`GET /api/companies/:cid/search`): AI employees,
      skills, routines, channels, projects, todos, bases, notebooks, notes,
      resources, charts, dashboards, repos, pipelines, customers. Sections
      stay first; entity hits group by kind underneath and ↵ opens them
      (todos land on their project board). Respects project access modes
      and private-channel membership
- [x] **Home page** — post-sign-in landing at the company root:
      unread notifications, my todos, reviews waiting on me, pending
      approvals, unread channels/DMs, today's journal digest, section
      directory (Employees roster moved to `/employees`)
- [x] **SSO / Google login** — instance-wide, Admin → SSO, disabled by
      default; see M16
- [ ] **2FA (TOTP)** — see M15
- [x] **Dark mode** — fully covered (1,500+ `dark:` classes)
- [x] **CLI** — `CLI/genosyn` bash wrapper around Docker, installed via
      `curl -fsSL https://genosyn.com/install.sh | bash`; fresh installs
      schedule a daily CLI + image upgrade by default, managed with
      `genosyn auto-update on|off|status`
- [ ] **Scripting CLI** — second, product-facing CLI for programmatic
      operations on companies / employees / routines (depends on M14)
- [~] **Import/export** — backup/restore round-trips a whole install;
  per-company export (one tenant out of a multi-company install) is
  still pending

### Runner

- [x] **Real execution** via the in-process agent against the model API
      (Anthropic / OpenAI / custom OpenAI-compatible); see M22
- [x] **Streaming logs to UI** (SSE on `employeeSurface.ts`)
- [x] **cwd-scoped tools** — the coding tools are rooted at the employee's
      working directory; bash inherits company secrets + repo env
- [x] **Browser access for AI employees** — headless Chromium bundled in
      the App container (Alpine `chromium` driven by `playwright-core`),
      opt-in per employee via `AIEmployee.browserEnabled`. Reserved
      built-in `browser` MCP exposes `browser_open`, `browser_snapshot`,
      `browser_click`, `browser_fill`, `browser_press`,
      `browser_screenshot`, `browser_close`, plus `browser_submit` and
      `browser_resume` for human-gated form submits. Stamped into all
      five providers' configs.
  - [x] **URL allow list.** `AIEmployee.browserAllowedHosts` (newline-
        separated host globs like `*.gmail.com`, `notion.so`). Empty list
        = unrestricted. Enforced inside `browser_open` before navigation.
  - [x] **Per-routine override.** `Routine.browserEnabledOverride`
        (`true` / `false` / `null`). Null inherits the employee setting;
        explicit values override either way. Materializer takes a
        `routineId` option from the runner and applies the override
        before stamping `.mcp.json`.
  - [x] **Approval mode for form submits.**
        `AIEmployee.browserApprovalRequired` boolean. When on, the new
        `browser_submit` tool queues an `Approval` (kind=`browser_action`)
        and returns `{status:"pending_approval", approvalId}`. The model
        calls `browser_resume(approvalId)` to re-fire once a human
        approves; rejections come back as a tool error.
  - [x] **Efficient agent browsing (v2).** Snapshots moved to Playwright
        aria snapshots in `ai` mode — every interactive element carries a
        `[ref=eN]` marker the model acts on via `aria-ref=eN` selectors
        (works into iframes), replacing the removed
        `page.accessibility.snapshot()` API that had left the tree
        permanently empty. Added `browser_select`, `browser_hover`,
        `browser_scroll`, `browser_back`, and `browser_wait`; popups are
        auto-adopted (the triggering action waits for the swap before it
        snapshots), JS dialogs auto-handled and surfaced as snapshot
        notes, wrong selectors fail in 5s with a snapshot in the error,
        the post-action settle is DOM-quiescence based (~0.3s typical vs
        a flat 3s `networkidle` wait) with a hard Node-side cap, and
        screenshots are JPEG. Approval-gated submits resume across turns
        off the Approval row but are bound to the approved page and fire
        exactly once; browser sessions survive App restarts via a DB
        token fallback. Docs at `/docs/browser`.
  - [x] **Live view + take-over.** Every browser-enabled spawn mints a
        `BrowserSession` row; the MCP child opens a CDP screencast
        (`Page.startScreencast`, JPEG q60) and pushes frames over a
        WebSocket up to the App, which fans them out to viewers
        connected at `/api/companies/:cid/employees/:eid/browser-sessions/
    :id/view`. The viewer page is a plain HTML+canvas iframe that
        also forwards mouse / keyboard events back via CDP
        `Input.dispatchMouseEvent` / `dispatchKeyEvent` when the human
        flips into "Take over" mode. Solves captcha / 2FA without an
        external service. The async `browser_submit` Approval flow
        stays as the fallback for unattended routines.
- [ ] **Genosyn-level sandbox** (docker / lightweight jail around the
      child process — provider sandboxes don't fully contain the spawn)
- [x] **Per-run context window budget** — the loop budgets each turn against
      `AIModel.contextWindow` (85% of it, leaving room to reply), and drops the
      oldest tool results to a stub when the next prompt wouldn't fit. Results
      are shrunk in place, never removed, because both wire formats require a
      `tool_use` to keep its `tool_result`. A provider that rejects a prompt
      anyway is caught, compacted hard, and retried once, so an unknown window
      degrades instead of killing the run. Per-result caps scale to the window;
      the transcript shows `[compact]` whenever history was dropped. Operators
      can set the window by hand (`contextWindowSource: "manual"`) for the many
      servers that report none

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
