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
- Each company can register multiple **AI Models**: **Anthropic** (Claude),
  **OpenAI** (GPT), or a **custom** OpenAI-compatible endpoint (Ollama, vLLM,
  llama.cpp, a gateway) — and assign them to employees. API-key and custom
  models run through Genosyn's direct in-process model loop. A trusted,
  single-tenant OpenAI model may instead use ChatGPT subscription access
  through the official pinned `@openai/codex` app-server; this is a narrow
  official runtime path, not a return to generic provider CLI harnesses. The
  standard Docker default runs it beside bubblewrap-isolated coding and
  repository work — the CLI creates the container with the two options the
  sandbox needs (`--security-opt seccomp=unconfined`,
  `--security-opt systempaths=unconfined`), since a stock container can neither
  create a user namespace nor mount its own `/proc`; where user namespaces are
  unavailable anyway, boot falls back to disabled and this path still works
  without coding tools.

Read `ROADMAP.md` for the full vocabulary, milestones, and backlog. **Do not
duplicate content from ROADMAP.md here** — link to it.

---

## 2. Repo layout

```
genosyn/
├── App/         # Product app: Express + TypeORM + React + Vite + Tailwind
├── Home/        # Standalone marketing site (React + Vite + Tailwind).
│                # Deployed to genosyn.com as a Cloudflare Worker by
│                # .github/workflows/site.yml — see RELEASING.md.
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

Both Docker images use the repo root as their build context. Home needs the
root because `sync-cli` reads from `../CLI/`; App needs it because in-app Help
ships a read-only snapshot of App, Home, CLI, the roadmap, docs, and delivery
workflows for AI Employees to inspect. `Home/Dockerfile` mirrors the repo
layout inside the image at `/build/Home` + `/build/CLI` so the relative path
resolves the same way as local dev. If you rename `CLI/`, update **all three**:
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
| **Folder** (the exclusive, nestable filing tree for Routines — `RoutineFolder`) | Category, Group, Collection, Tag |
| **Integration** (a connector type: Stripe, Gmail, …; static in code) | Provider, Plugin, Service (in product copy) |
| **Connection** (one authenticated account inside an Integration; DB row) | Account, Instance, Integration (of the DB row) |
| **Member browser** (a Chrome a human connected from their own computer — `MemberBrowser`) | Connection, Browser Connection, Device |
| **Decision** (a question an AI Employee stacked for the company to answer — a human, or the AI decider a `DecisionPolicy` rule names — `Decision`) | Approval, Question, Ask, Escalation |
| **Waiver** (an earned, revocable exemption from one human gate — `AutonomyWaiver`) | Tier, Level, Trust score |
| **Budget** (a monthly ad-spend envelope — `Budget`) | Cap, Limit, Allowance (as product nouns) |
| **Trigger** (an event subscription that fires a Routine — `RoutineTrigger`; a Revenue **Signal** stays a cron-evaluated query, never a Trigger) | Subscription, Listener, Hook |
| **Wakeup** (a timed follow-up session an employee schedules for itself — `EmployeeWakeup`) | Reminder, Timer, Snooze |
| **Workstream** (a persistent state document for work spanning many Runs — `Workstream`) | Project (reserved for the task manager), Thread, Epic |
| **Initiative** (standing work an employee proposes and a human accepts — `Initiative`) | Proposal (Revision proposals own that word), Suggestion, Idea |
| **Policy** (a company-wide rule binding every employee — `CompanyPolicy`; a decision-routing rule is a `DecisionPolicy`, always said as "decision policy") | Rule, Guideline, Guardrail |
| **Standing question** (a question configured once at TLDR settings that every briefing answers — `TldrStandingQuestion`) | Preset, Template question, Default question |
| **Suggested action** (a one-click next step an AI Employee attached to its own answer — `TldrQuestionAction`) | Quick action, Command, Shortcut |
| **Repository** (a version-controlled workspace — code, strategy docs, policies; `Repository`) | Code Repository, Repo, Codebase |
| **Work session** (one request to an AI Employee to do work in a Repository — `RepositoryWorkSession`) | Job, Task, Agent run |
| **Grant** (an AI employee's access to a resource — a Connection, Note, Chart, Repo, …) | Permission, Attachment, Binding |
| **Project member** (a human Member *or* an AI Employee authorized on a Project — `ProjectMember`) | Grant, Permission, Collaborator |
| **Goal** (a measurable objective — `Goal`, linked from `Routine.goalId`) | Objective, OKR, KPI, Target (as a noun) |
| **Lesson** (a graded Run's structured takeaway — `RunLesson`) | Learning (Resources' old name), Insight, Retro |
| **Revision proposal** (a staged Soul/Skill/Routine edit awaiting a human — `RevisionProposal`) | Self-modification, Patch, Suggestion |
| **Contact** (a person in the Revenue section) | Lead, Person, Prospect |
| **Deal** (one revenue opportunity) | Opportunity, Pipeline item |
| **Deal Stage** (a step in the sales process) | Pipeline stage — see the warning below |
| **Sequence** (multi-step outbound outreach) | Campaign, Drip, Cadence |
| **Signal** (a product-usage trigger) | Alert, Trigger, Event |
| **Activity** (one event on a Contact / Deal timeline) | Event, Log, Interaction |
| **Suppression** (an address we must never email) | Blocklist, Blacklist |

**"Tasks" is reserved** for the task-manager feature (Projects + Todos), which
has shipped. Do not use "Task" for scheduled AI work, ever.

**"Connection" stays reserved** for one authenticated account inside an
Integration. A Chrome someone connects from their own machine is a **Member
browser** (`MemberBrowser`, granted to employees through
`EmployeeMemberBrowserGrant` like every other resource) — never a "Connection",
not least because `IntegrationAuthMode` already has a `"browser"` mode meaning
"a Connection whose credentials the headless browser replays". Two unrelated
meanings on one word is what this table exists to prevent.

**"Decision" and "Approval" are not synonyms**, and the split is the whole
point of both. An **Approval** is the *system* interposing on an action an
employee already attempted — a gated routine tick, a payment over a threshold,
a guarded tool call — and the server replays that exact action once a human
ticks it. It is binary, it is never the employee's idea, and because approving
it fires a privileged side effect it is admin-gated and its payload is redacted
at every boundary. A **Decision** is the employee choosing to stop and ask:
it writes the question and the options itself, answering one performs no side
effect, and an ordinary Member can answer it. Never label a Decision "approve /
reject", and never route a gated action through the Decision Stack — anything
privileged the employee does afterwards still meets its own Approval.

**"Repository" is not a synonym for "codebase."** A Repository is any
version-controlled workspace the company keeps: a service's source, a
quarter's strategy, a set of operating policies. The section used to be called
"Code", which told people it was for engineers and nothing else. `kind` on the
row (`code` / `documents`) only changes copy, editor defaults, and how an AI
Employee is briefed — every Repository is a plain git repository underneath.
Note that the physical tables are still `code_repositories` and
`employee_code_repository_grants`: renaming a table means either a generated
migration that drops and recreates it or a hand-written one, and §7 forbids
the second. The product noun is what matters.

**A Folder is not a Tag, and neither replaces the other.** A **Folder** answers
*where does this routine live* — one per routine, nestable, navigable in the
sidebar. A **Tag** answers *what is this about* — many per resource, spanning
every section of the app. M27 shipped tags saying they grouped resources
"without forcing a folder hierarchy"; M48 added the hierarchy for Routines
because a chip that narrows a flat list is not somewhere to put things. Do not
add a `folderId` to a resource that only ever needed a tag, and do not model a
folder as a reserved tag name.

**"Pipeline" is reserved** for the DAG automation primitive (M10). The sales
pipeline is a flat, ordered list of **Deal Stages** — there is no container
entity, and no UI label anywhere says "pipeline" to mean the sales process. The
word survives only as prose inside metric names ("pipeline coverage", "open
pipeline value"). Introducing a `DealPipeline` entity would put two unrelated
meanings on one word in the same codebase, which is exactly what this table
exists to prevent.

---

## 4. Tech stack — non-negotiables

- **Language:** TypeScript everywhere. No plain JS files.
- **Backend:** Express. Do **not** introduce Nest, Fastify, tRPC, etc.
- **ORM:** **TypeORM**. SQLite is the self-hosted default; shared SaaS uses
  Postgres via config and the dedicated Postgres migration stream.
  Do not add a second ORM or raw SQL query builder.
- **Frontend:** React 18 + Vite + TailwindCSS + React Router + lucide-react.
  Do **not** introduce Next.js, Remix, Redux, MUI, Chakra, shadcn-as-a-dep
  (copying a few primitives is fine), or CSS-in-JS.
- **Auth:** bcrypt + `cookie-session`. No JWT libraries, no Auth0/Clerk.
- **Email (transactional):** per-company `EmailProvider` rows pick the
  transport (SMTP via `nodemailer`, or SendGrid / Mailgun / Resend / Postmark
  via REST). Falls back to the global SMTP block in `config.ts` for
  system-level sends, then to the console. Every transactional send appends an
  `EmailLog` row; company-scoped rows are visible at Settings → Email Logs
  (system sends — welcome, password reset, global SMTP test — carry a null
  `companyId` and are logged but not surfaced anywhere yet).
- **Email (the company's inbox):** the `Mail*` subsystem is **separate** and
  sends through the Gmail API on a `google` Connection. It does **not** write
  `EmailLog` — there is no `gmail` transport, and adding one would drag the
  OAuth mailbox into `EmailProviderConfig`. Sent mail is recorded as a
  `MailMessage` on the thread instead. Keep the two apart — see ROADMAP M25.
- **Cron:** `node-cron`.
- **Validation:** `zod` at the API boundary.
- **No Next.js.** Listed twice because agents keep reaching for it.

Before adding any new dependency, ask: does `ROADMAP.md` already imply it? If
not, flag the addition in the PR description.

---

## 5. Config

Boot-critical runtime settings live in `App/config.ts` as a single exported
object with **commented JSON-shape**. There is **no `.env` file** in this
project — do not introduce `dotenv`, `config-yaml`, `.env.*`, or
per-environment config files. One file (`config.ts`), one object, comments
above each field. Users who want to override boot settings edit `config.ts`
directly.

Settings that an operator can safely change while the app is running live in
the `AppSetting` table and are managed by a master admin. The browser-facing
public URL is stored under `instance.publicUrl` and edited at **Admin →
General**; do not reintroduce it in `config.ts`.

Users flip `config.db.driver` from `"sqlite"` to `"postgres"` to upgrade.
Entities and migrations must work on both.

---

## 6. Data on disk

Everything user-generated lives under `config.dataDir` (default `./data`):

```
data/
├── .instance-secrets.json  # generated cookie + encryption roots (mode 0600)
├── .instance-secrets.required # non-secret loss-detection marker (mode 0600)
├── .private/
│   ├── browser-state/<company-id>/<employee-id>.json # cookies/localStorage
│   ├── browser-recordings/<company-id>/<run-id>/ # silent per-session Routine MP4s
│   └── code-repository-ssh/<company-id>/<employee-id>.known_hosts
├── app.sqlite
└── companies/<company-slug>/employees/<emp-slug>/
    ├── repos/  code-repos/    # git working trees the coding tools operate on
    └── …                      # artifacts the agent's tools write into cwd
```

Default self-host installs create `.instance-secrets.json` and its non-secret
loss-detection marker atomically when the public placeholders remain in
`config.ts`. Back both up with the database: losing the managed encryption key
makes ciphertext unreadable, and the marker makes a missing key fail closed
instead of silently creating a new identity. A matching non-secret key ID in
the database also detects loss or replacement of both files after database
initialization. Never copy secret values into logs, employee working trees,
support bundles, or source control. Explicit strong config values remain
supported and take precedence.

Browser authentication state, Routine browser recordings, and repository SSH
host-key caches are App-private. Silent visual recordings live under
`.private/browser-recordings/<company-id>/<run-id>/`, one MP4 per
`BrowserSession`, and are linked from the Run log rather than exposed in an AI
Employee's working tree. A recording from Genosyn's browser is admin-only; a
recording from a Member browser is visible only to that browser's exact owner.
Any BrowserSession in which a password field was observed withholds its
recording entirely. Repository tokens and SSH private keys are decrypted only
for short-lived, server-owned clone/fetch operations; they are never written
into an employee working tree or injected into model coding tools.

- **The database is the source of truth** for Soul, Skill, and Routine prose
  (`AIEmployee.soulBody`, `Skill.body`, `Routine.body`), for captured Run
  transcripts (`Run.logContent`), and for **model credentials** — API keys,
  custom-endpoint URLs, and OpenAI subscription credentials live encrypted in
  `AIModel.configJson`. Browser recording bytes are the file-backed Run-artifact
  exception: the `Run` → `BrowserSession` rows carry their identity and access
  scope, while silent MP4s stay App-private under the recording path above. Do
  not
  reintroduce `SOUL.md` / `skills/<slug>/README.md` / `routines/<slug>/README.md`
  on disk, and never write model credentials into an employee working tree or
  a persistent provider directory. The OpenAI subscription path is the only
  file-backed model-auth exception: each device login and Run gets a locked
  temporary `CODEX_HOME`. A managed ChatGPT session is materialized there; a
  Business / Enterprise access token is injected only into the child process
  environment. The directory is removed afterward.
- There are **no persistent per-provider credential dirs** (`.claude`,
  `.codex`, … are gone), generic provider CLI harnesses, or materialized MCP
  config files. API-key and custom models receive tools from Genosyn's
  in-process loop; OpenAI subscription models run through the official
  pinned `@openai/codex` app-server with the same Genosyn-owned tool registry:
    * built-in **coding tools**. Bubblewrap is the shipped default, so command
      execution is on out of the box wherever the sandbox can start; boot
      falls back to disabled where it cannot, never to host. Disabled mode
      exposes no coding tools and materializes no repositories, but supports
      subscription auth on a trusted single-tenant install.
      Separately acknowledged host mode exposes only the path-confined
      `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, and `grep`
      tools; it never exposes an unrestricted same-UID shell, but its host
      child-process posture makes subscription auth unavailable. Bubblewrap
      mode exposes only sandboxed `bash`, rooted at the employee cwd, and also
      supports subscription auth. Its private PID and `/tmp` namespaces isolate
      the sibling app-server's materialized credential. Every model turn in a
      bubblewrap deployment exposes only the sandboxed `bash` tool from this
      family; the in-process file tools are omitted install-wide so a concurrent
      non-subscription turn cannot race a symlink into that credential.
      Repository clone/fetch runs through the same namespace boundary.
      A **Repository work session** gets a second sandbox root of its own
      through `repository_run_command`: the same bubblewrap boundary, rooted
      at that session's worktree rather than the employee cwd, so the Member
      checkout, sibling sessions and `git` itself stay outside it. It is
      bubblewrap-only for the same reason `bash` is — host mode never gives an
      AI Employee a same-UID shell — and what it may run is a company decision
      on the Repository row (`commandMode` + `allowedCommands`). Everything
      else a session does still needs no execution at all;
    * the built-in **genosyn** tools, dispatched in-process to the loopback
      internal API (`server/mcp/toolManifest.ts` + `routes/mcpInternal.ts`)
      with a short-lived MCP token. The model is shown a **working set** of
      ~20 tools and reaches the rest through `find_tools` / `call_tool` — see
      `server/services/agent/tools/` and ROADMAP M30;
    * the built-in **browser** tools — a stdio MCP child at
      `server/mcp-browser/` that the agent connects to as an MCP client — when
      `AIEmployee.browserEnabled` is true. The same tools drive a **Member
      browser** when the conversation or Routine selects one: the Chrome then
      runs on a human's computer, reached through the zero-dependency bridge
      agent in `server/browser-bridge/` (served to Members from the App, paired
      with a one-time code) which launches a dedicated Chrome profile and
      relays CDP back over an outbound WebSocket. Its cookies, storage state,
      and downloads are never written under `config.dataDir`. The sole
      persisted output is a silent visual recording when a Routine Run actually
      uses that browser after its owner explicitly consents to unattended
      recording: it is stored App-private alongside the Run's browser artifacts,
      available only to the browser's exact owner, and withheld if the
      BrowserSession observes a password field;

    * any company-configured **MCP servers** (stdio/HTTP), which the agent
      connects to as an MCP client. User-configured stdio servers are omitted
      in disabled and bubblewrap modes; HTTP servers remain available. Host is
      the only trusted single-tenant mode that permits user-configured stdio
      children, and it rejects subscription auth.
  The agent runtime lives in `server/services/agent/`. What stays on disk under
  the employee dir is only the working tree the coding tools operate on:
  materialized git repos and whatever the tools write into cwd. Browser state
  and Run recordings remain in the App-private paths above.
- OpenAI subscription device sessions and managed refresh-token locks are
  process-local. The supported topology for this auth mode is one trusted,
  single-tenant App process. The standard Docker installer supports it in the
  default bubblewrap execution mode, alongside isolated `bash` and repository
  work, and creates the container with the security options the sandbox needs
  (`CLI/genosyn`, `sandbox_requested`); on a host whose namespaces bubblewrap
  cannot use, boot falls back to disabled and the path still works without
  coding tools, repository materialization, or user-configured stdio MCP. Horizontally
  scaled installs must use API-key models until the coordination primitives are
  ready. Subscription turns serialize on the per-model lock and do not expose
  `delegate_parallel_work`; a delegated copy would otherwise wait on the lock
  held by its parent.
- The `data/` directory is gitignored. Never commit anything inside it.
- Slugs are derived once at create-time via `slugify`; renames update the
  display name but not the slug (so URLs stay stable).

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
- Empty states always exist. Loading states always exist. So do error states —
  but **never as a toast**. A failure belongs where the person is already
  looking: inline in the form or section that owns it (`<FormError>`), or, when
  there is no form to put it in, in the error modal
  (`useDialog().error(err, { title })`). Corner popups that time out are gone
  from this codebase; do not reintroduce a toast, a snackbar, or a
  notification library. Optimistic writes report a failure the same way, from
  `useBackgroundAction()`, after rolling the row back.
- Success needs no announcement. The list re-rendering, the row updating, the
  modal closing *is* the confirmation. Only when an action changes nothing on
  screen — a test email sent, a backup queued — does it earn a `<FormSuccess>`
  beside the control that started it.
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

## 10. Documentation

The marketing site at `Home/` ships the user-facing docs under
`Home/client/docs/pages/`. When you change something a user can see —
a new UI surface, a new auth mode, a renamed concept, a new
`genosyn` CLI subcommand, a new MCP tool, a config knob — **update
the docs in the same PR** as the feature. Stale docs are worse than
no docs: users follow the steps, hit a different reality, and lose
trust in the rest of the page.

What "update the docs" looks like in practice:

- Find the page the change belongs on. The current index lives in
  [`Home/client/docs/nav.ts`](./Home/client/docs/nav.ts); add a new
  page there only if the topic has no natural home.
- Lead with the in-app flow. Terminals and config-file paths can stay
  in an "Advanced" section, but the primary instructions should match
  what a user clicking through the UI actually sees — same labels,
  same button copy, same field names.
- Cross-link to related pages with `<DocLink to="/docs/...">` so
  readers can navigate without going back to the sidebar.
- If you removed a feature, **delete** the doc for it. Don't leave a
  page reading "this is deprecated" — that's clutter.
- Keep each page short. If a page is creeping past 400 lines, that's
  a signal to split, not to keep adding.

You don't need to update `ROADMAP.md` for every doc change — the
roadmap tracks shipped milestones, not the docs we wrote about them.
But if the feature itself is new, mark the milestone `[x]` in the
same PR.

---

## 11. Commits & PRs

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

That same push to `release` is also what publishes **genosyn.com**. The
marketing site is a Cloudflare Worker deployed by
[`site.yml`](./.github/workflows/site.yml) — *not* the `ghcr.io/genosyn/home`
image, which is what self-hosters run. Nothing you merge to `main` reaches the
public site until it reaches `release`. See
[The marketing site](./RELEASING.md#the-marketing-site).

---

## 12. Things that will get your PR rejected

- Introducing Next.js, JWT libraries, Prisma/Drizzle, or a component library
  without prior discussion.
- Using "Task" to mean a scheduled AI routine.
- Committing files under `data/`.
- Writing business logic inside route handlers.
- Reintroducing on-disk `SOUL.md` / skill / routine markdown files. Soul,
  skill, and routine bodies live on their DB rows; Run logs live on the Run
  row. The filesystem under `data/` is for employee working trees and
  App-private runtime artifacts such as browser state and Run recordings —
  never model credentials, which live encrypted on the `AIModel` row.
- Reintroducing generic provider CLI harnesses, persistent per-provider
  credential dirs, Anthropic subscription/OAuth routing, or materialized MCP
  config files. API-key and custom models are called directly via the
  in-process agent (`server/services/agent/`). The only subscription exception
  is trusted single-tenant OpenAI through the official pinned `@openai/codex`
  app-server, with managed session files confined to a locked temporary
  `CODEX_HOME` and access tokens confined to the child process environment for
  a Run. The default bubblewrap execution supports that path with isolated
  coding and repository work; the disabled fallback supports it without those
  surfaces, while host mode and multi-tenant installs reject subscription
  auth.
- Naming a user-configurable MCP server `genosyn` or `browser`. Both names are
  reserved for built-in tools — `genosyn` runs in-process (dispatched to
  `routes/mcpInternal.ts`); `browser` is a stdio binary at `server/mcp-browser/`.
  User-configured servers with those names are dropped when the agent assembles
  its tool list.
- Adding a tool to the agent's resident working set without a reason that
  survives `toolBudget.test.ts`, or collapsing new tools into an
  `op`-dispatched family. Families are retired (ROADMAP M30) — defer the
  granular tools instead.
- Skipping the zod schema on a new endpoint.
- Hand-writing a migration file. Always run
  `npm run migration:generate -- server/db/migrations/<Name>` and commit
  what it emits. See section 7.
- Adding a feature that isn't on the roadmap without adding it to the
  roadmap first.
- Pushing a commit that breaks `npm run lint` or `npm run build` in either
  `App/` or `Home/`. CI runs both on every push to `main`; run them locally
  first. See section 7 for the ESLint rules that keep biting.
- Shipping a user-visible change without updating the docs at
  `Home/client/docs/pages/` in the same PR. See section 10.

---

## 13. When in doubt

Re-read `ROADMAP.md`, then ask the human. Don't guess on product decisions.
