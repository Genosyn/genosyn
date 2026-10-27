# Genosyn threat model

This document is for Anthropic's OSS Scanner, and for anyone deciding whether
something they found in Genosyn is a vulnerability. Report vulnerabilities
privately to security@genosyn.com (see `SECURITY.md`). `AGENTS.md` defines the
vocabulary used here (AI Employee, Soul, Skill, Routine, Run, Grant, Approval,
Decision, Standdown, Check, Waiver, Connection, Vault, Work session) and is the
authority on architecture. User-facing behavior is documented in
`Home/client/docs/pages/`.

## What Genosyn is and where untrusted input enters

Genosyn is a self-hosted platform for running companies with AI Employees.

- **The App** (`App/`) is one Node 22 process (Express, TypeORM, a React
  client built with Vite) serving the API and the web client on port 8471.
  SQLite by default, Postgres optional. `App/config.ts` holds boot
  configuration only (secrets, database, security posture); everything else
  is runtime settings in the database, edited by a master admin under Admin.
- **Tenancy.** An install is **single-tenant**: one organization, which may
  run several **Companies** on the same host and database. A Company has human
  **Members**, each with a role (`owner`, `admin`, `member`) and a Finance
  access level (`none`, `read`, `full`; owners and admins always have full),
  and **AI Employees**. **Master admins** (`User.isMasterAdmin`) operate the
  whole install.
- **AI Employees** have a Soul, Skills, and Routines (markdown stored in the
  database), hold **Grants** to resources (Connections, Vault items,
  Repositories, Bases, mailboxes, and more), and run turns through the pinned
  OpenCode runtime (API-key and custom AI Models) or the official Codex
  app-server (ChatGPT subscription models). Genosyn supplies each turn's
  context and tools: the built-in `genosyn` tools, served by a loopback-only
  internal API; browser tools; and MCP servers a company configures.
- **Genosyn Connect** (`Connect/`) is a separate, stateless OAuth broker
  (connect.genosyn.com) holding one OAuth app per provider, so an install can
  connect Gmail without registering its own app. The App is only its client.
- **Home** (`Home/`) is the marketing site and docs. **CLI** (`CLI/`) holds
  the operator's shell scripts, and **Helm** (`Helm/`) the Kubernetes chart.

### Who is trusted with what

| Actor | Trust |
| --- | --- |
| Operator and host: `App/config.ts`, environment, data directory, Docker or Kubernetes | Fully trusted. |
| Master admin | Fully trusted across the install: the SQL console and runtime settings (`App/server/routes/admin.ts`), install-wide custom JavaScript, backups and restore, SSO, the outbound private-host allowlist, and adding user accounts directly (with a password they set or a one-time setup link they are shown). |
| Company owner or admin | Trusted with their Company. In the default host execution mode they also decide what AI Employees run on the host (coding tools, stdio MCP servers, Repository command policies), so they are effectively trusted with the host. |
| Company member | Authenticated, lower privilege: bound by role, Finance access, per-item access (Vault items, restricted Projects), and conversation ownership. |
| AI Employee | Acts only through its Grants and the turn's tool scope. In an interactive turn, its access is intersected with the requesting Member's current access. |
| Everyone else | Untrusted: the internet, Members of other Companies, anyone who emails a company mailbox, web pages, documents, MCP server results, repository content, and people on external chat surfaces who are not linked to a Member. |

### Where untrusted input enters

Route mounting order, and which routes sit before authentication and the
trusted-origin check, is in `App/server/index.ts`.

1. **Unauthenticated HTTP to the App.**
   - Accounts: signup, login, logout, password reset, email verification, the
     second-factor step, passkey sign-in, install-wide SSO and company SSO
     (OIDC only): `App/server/routes/auth.ts`,
     `App/server/routes/passkeyLogin.ts`, `App/server/routes/twoFactor.ts`,
     `App/server/routes/sso.ts`, `App/server/routes/companySsoAuth.ts`.
   - Invitations: `POST /api/invitations/accept` needs a signed-in browser
     session whose email matches the invitation
     (`App/server/routes/invitations.ts`).
   - Public Base Forms and public document signing, where a token in the URL
     is the credential: `App/server/routes/publicForms.ts`,
     `App/server/routes/publicSignatures.ts`.
   - Inbound webhooks, where a token in the URL is the credential:
     `App/server/routes/webhooks.ts`. Chat surfaces (Slack, Microsoft Teams,
     WhatsApp), which verify the platform's signature:
     `App/server/routes/chatSurfaceWebhooks.ts`.
   - **Customer channels**: a Slack channel (often Slack Connect, shared with
     another organization) an owner or admin linked to a Customer
     (`App/server/services/customerChannels/`). Every human message posted
     there is kept, and the people in it are strangers whatever workspace they
     are in: their words reach the channel's AI Employee only as untrusted
     JSON in restricted turns (`customerChannels/turns.ts`) — a reply turn
     whose one tool skips the reply, composed from the channel's
     Member-written instructions and never the employee's Soul, Memory, Skills
     or company tools, even when a linked Member asked; and a notes turn whose
     one tool submits notes the server files on the linked Customer. Messages
     in channels that are not linked are dropped unread. In any group
     conversation the platform says another organization can read — linked or
     not — a reply carries no Member's authority, and a channel that cannot be
     checked is treated as shared (`groupAudience` in
     `App/server/services/chatSurfaces/inbound.ts`). A linked Member's turn
     reaching company tools in such a channel is a finding.
   - Phone number webhooks from Twilio (incoming texts and calls, call turns,
     delivery and call statuses), which verify `X-Twilio-Signature` with the
     Auth Token of the Connection that owns the number before acting:
     `App/server/routes/phoneWebhooks.ts`. Callers and texters are strangers:
     their words reach the AI Employee only through the restricted,
     tool-less turns in `App/server/services/phone/conversation.ts`, never its
     Soul, Memory or company tools.
   - Unsubscribe links (`App/server/routes/unsubscribe.ts`).
   - The **careers site**: a company's Openings and the application form
     (multipart, with a resume file), at `/careers/<company-slug>` and under
     `/api/careers` (`App/server/routes/careersSite.ts`,
     `App/server/routes/careers.ts`). Applicants are strangers: what they send
     reaches AI Employees only as untrusted data (the AI screener's restricted
     one-tool turn in `App/server/services/recruiting/screening.ts`, and
     `list_applications` and `get_application`, both taint sources). A company may serve the site on its own
     verified domain; `careersHostGuard` answers that `Host` with the careers
     site only. `GET /api/careers/domains/check` (for a proxy's on-demand TLS)
     says whether a domain is a verified careers domain. An internal careers
     site needs a signed-in Member of that company.
   - **Data room guests**: `/room/<token>` and `/api/room/<token>`
     (`App/server/routes/publicDataRooms.ts`,
     `App/server/services/dataRooms/portal.ts`). The token in a guest's link
     is their only credential; it reaches only that guest's folders and their
     own questions. Guests are strangers: a question reaches AI Employees only
     as untrusted data (the room's restricted answer turn in
     `App/server/services/dataRooms/ai.ts`, shown only the documents that guest
     can open, and `list_data_room_questions`, a taint source).
   - OAuth callbacks for Integrations, and the return page Genosyn Connect
     sends the browser back to: `App/server/routes/integrationsOauth.ts`,
     `App/server/services/hostedOauth.ts`.
   - OAuth for the Genosyn MCP server, so claude.ai and ChatGPT can sign in:
     the discovery documents under `/.well-known/`, open dynamic client
     registration (`POST /api/oauth/register`, throttled per address and
     capped while unused), the authorization endpoint (`GET /oauth/authorize`,
     which only validates and redirects to the consent page), and the token
     and revocation endpoints, where client credentials and the PKCE verifier
     are the proof: `App/server/routes/mcpOauth.ts`,
     `App/server/services/mcpOauth/`. Approving an app needs an owner's or
     admin's signed-in browser session at `/api/oauth/consent`.
   - Member-browser pairing (a one-time code exchanged for a bridge token) and
     its WebSocket: `App/server/routes/memberBrowserBridge.ts`,
     `App/server/services/realtime.ts`.
   - WebSockets for live updates and the browser viewer, opened with
     single-use tokens that authenticated routes mint
     (`App/server/services/realtime.ts`).
   - `/api/health`, the OpenAPI document and its viewer, and the custom
     JavaScript loader.
   - The `genosyn-api` command line, served to anyone as one file at
     `/cli/genosyn-api.mjs` (`App/server/routes/cli.ts`): the open-source
     client built from `App/cli/`, with no secret in it. It runs on Members'
     own machines, keeps their API key in a mode-0600 file under
     `~/.genosyn/`, sends it only to the install it was saved for, and never
     follows a redirect with it.
   - **Loopback-only internal APIs**: `/api/internal/mcp` (the `genosyn`
     tools) and `/api/internal/browser/sessions/:id` (the browser tools),
     guarded by `App/server/middleware/loopbackOnly.ts` plus a bearer token.
     Reaching them from anywhere but the App's own host is a vulnerability.
2. **Authenticated Members of lower roles.** About sixty routers under
   `App/server/routes/` serve `/api/companies/:cid/...`. Each applies
   `requireAuth` and `requireCompanyMember`, then role and Finance checks
   (`requireCompanyRole`, `requireCompanyRoleForMutations`,
   `requireMasterAdmin` in `App/server/middleware/auth.ts`;
   `App/server/middleware/financeAccess.ts`). Personal API keys
   (`Authorization: Bearer gen_...`, `App/server/routes/apiKeys.ts`) are bound
   to one Company and act with their user's current role there. They cannot
   manage the account, MFA, invitations, other keys, or instance
   administration. The Genosyn MCP server (`/api/companies/:cid/mcp`,
   `App/server/routes/companyMcp.ts`) accepts only such a key, or the OAuth
   access token of a **connected app** an owner or admin approved for that
   Company (`App/server/services/mcpOauth/`) — it never reads the session
   cookie — refuses any browser `Origin` but the install's public URL, and
   replays each tool call through the App's own router with that same
   credential (`App/server/services/companyMcp/dispatch.ts`). A connected
   app's token is accepted at that endpoint and on those in-process replays
   only (`App/server/middleware/auth.ts`); using one against the REST API
   directly, reaching an operation through the server that a key could not
   reach over REST, or another Company's data, is a vulnerability.
3. **Other Companies on the same install.** Every `:cid` route must scope
   rows to that Company, including IDs that arrive in bodies and queries
   (another Company's Connection, Vault item, Repository, Base, employee,
   Run, mail thread, or file). Realtime events and search results must not
   cross Companies either.
4. **Inbound email.** Company mailboxes sync over the Gmail API or IMAP. The
   bodies, headers, and attachments are shown to Members (the email HTML is
   sanitized in `App/client/pages/MailThreadView.tsx`) and read by AI
   Employees: the per-mailbox AI analysis (`App/server/services/mail/analysis.ts`),
   AI mail rules (`App/server/services/mail/aiRuleEvaluator.ts`),
   handovers (`App/server/services/mail/handoverPrompt.ts`), and the meeting
   scheduler's proposal (`App/server/services/mail/meetingProposal.ts`, a
   restricted one-tool turn whose guests, times and quoted evidence the server
   checks against the thread; a Member sends the invitation). Treat every
   email as an attempt at prompt injection.
5. **Web pages** read by the web tools and the browser tools
   (`App/server/mcp-browser/`), either Genosyn's own Chrome or a **Member
   browser**: a Chrome on a person's computer, driven through the bridge in
   `App/server/browser-bridge/`.
6. **MCP servers** a company configures (HTTP or stdio). Their tool results
   are untrusted content. Configuring them is admin-only.
7. **Repository content.** Repositories are cloned from remotes, and a work
   session reads the repository's `AGENTS.md` into its context. Allowed
   commands run the repository's own scripts.
8. **Uploaded and fetched files**: chat, Base, Resource, and mail
   attachments, avatars, documents to sign, applicants' resumes (typed by
   their bytes and stored App-private by
   `App/server/services/recruiting/files.ts`), and data room documents
   (App-private, `App/server/services/dataRooms/storage.ts`). Their parsing (PDF, DOCX,
   XLSX, EPUB, images, MIME) and the way they are served back to browsers
   (`App/server/services/files.ts`, `App/server/services/resourceFiles.ts`,
   `App/server/services/uploads.ts`).
9. **Bearer credentials**: session cookies, API keys, MCP tokens
   (`App/server/services/mcpTokens.ts`), connected apps' OAuth authorization
   codes, access and refresh tokens and client secrets
   (`App/server/services/mcpOauth/tokens.ts`), browser-session tokens,
   member-browser bridge tokens, webhook, form, signing and data room guest
   tokens, and
   invitation, reset, and verification tokens (`App/server/lib/token.ts`).
10. **Genosyn Connect on the public internet**:
    `/api/connect/<provider>/{status,start,authorize,callback,refresh}`
    (`Connect/src/routes.ts`). Its sign-in context is sealed into the
    request id and the provider `state` (`Connect/src/tokens.ts`,
    `Connect/src/secrets.ts`). Its consent page proves the opener with
    `postMessage` and a cookie (`Connect/src/pages.ts`). The credential goes
    back through the browser's URL fragment, encrypted to a one-time key that
    only the install's server holds.

## What is by design, not a vulnerability

- **AI Employee commands run on the host, with no OS sandbox.** OpenCode's
  native coding tools, Genosyn's coding tools, Repository work-session
  commands, command Checks, stdio MCP servers, and server-managed git all run
  as the App process user, with its filesystem and network authority. That
  includes reading `App/data/`, where the database and the instance secrets
  live. A working directory, a tool permission, a Grant, or a command
  allowlist is not an OS sandbox (`AGENTS.md` §6, `agent.codingTools` in
  `App/config.ts`). An AI Employee running a command is not a finding. A
  party with less authority getting a command run is (see "How we rate
  severity"). `executionMode: "disabled"` is the off switch: no coding tools,
  no repositories, no stdio MCP servers.
- **Who may direct host execution.** Owners and admins: they write Souls,
  Skills, and Routines, choose AI Models, configure MCP servers, and set each
  Repository's command policy. Also any Member, through a **Repository work
  session**, on a Repository whose command policy (set by an owner or admin)
  allows commands and that the AI Employee is granted. The command allowlist
  (`App/server/services/repositoryCommandRun.ts`) states what the company
  permits. It is not isolation, because allowed tools such as `npm` and
  `node` run repository code that Members can edit. In interactive chat,
  coding and browser tools, company Connections, configured MCP servers,
  Memory, and repository context are available only to owners and admins.
- **Company Secrets are visible to AI commands.** Settings → Secrets holds
  environment variables injected by name into AI Employee commands and
  Pipelines, so a turn with coding tools can read them. Vault items are
  different: plaintext never reaches the model (see below).
- **Master admins are fully trusted.** They have the SQL console, install-wide
  custom JavaScript that runs for every signed-in user on most App pages,
  backup and restore of the whole data directory (including its encryption
  key), runtime settings, SSO, and the outbound private-host allowlist. They
  can add accounts directly (Admin → Users → Add user) and see the one-time
  setup link of an account they add; such an account starts unverified and is
  never made a company owner or master admin there.
- **Single-tenant trust.** Companies on one install share a host, a database,
  and an operator. An owner or admin who reaches another Company's data by
  running host commands is acting within the trust model. The supported
  installers (the `genosyn` CLI and the Helm chart, which refuses it) never
  enable `security.multiTenant`. That flag is a fail-closed posture in code
  (`App/server/services/runtimeSecurity.ts`: Postgres, explicit secrets, no
  coding tools, no browser), not a supported shared-hosting product.
- **Browser output is unfiltered.** Snapshots, screenshots, navigation
  metadata, and silent Routine recordings contain whatever the page showed,
  including values the website itself displays. Their authorization
  boundary is the control: Genosyn-browser recordings are for owners and
  admins, and a Member browser's recordings are for its owner alone.
  Sensitive content inside them is not a finding. Reaching them without that
  authorization is.
- **The careers site is public by choice.** A published Public or Unlisted
  Opening, the company's site branding, and its JSON feed (served with
  `Access-Control-Allow-Origin: *`) are meant for anyone. Criteria, screening
  instructions, Scorecards and applicants are not, and reaching them without
  signing in as a Member of that company is a finding. Any Member may read
  and act on applications; owners and admins alone change Recruiting
  settings, the careers site, its domain, and AI access.
- **A data room guest link is a bearer credential by design.** Anyone holding
  it opens the room as that guest until it is reissued or revoked. Watermarks
  and view-only rooms deter copying; they do not prevent it, since anything
  shown on a screen can be captured. Reaching another guest's folders or
  questions, another room, or a room's documents without a link is a finding.
  Data rooms are owners' and admins' alone; a Member reading one is a finding.
- **Answering a Decision has no side effect**, so any Member may answer one.
  Decision screening fails open by design (`AGENTS.md` §3). Approvals, which
  replay a held action, are admin-gated.
- **Any Member may read** an AI Employee's work timeline and a Run's report
  and Effects (`AGENTS.md` §3). The company audit log itself is admin-only.
- **A Vault item shared company-wide** can be revealed by any Member of that
  Company. Private items, per-item access, and AI Employee Grants are the
  boundary, and company-wide visibility never gives an AI Employee access.
- **An AI Model is the company's, and shared.** Its credentials sit on one
  `AIModel` row that any number of the company's AI Employees run on, through
  `EmployeeModel` attachments owners and admins make from a signed-in browser
  (`App/server/routes/companyModels.ts`). One employee running on a model
  another also uses is not a finding. Reaching a model of another company, or
  attaching, detaching or removing one without owner or admin authority — by
  API key, MCP client or AI Employee tool — would be.
- **A mailbox's suggested AI buttons** run only when a Member presses them,
  with that Member's authority.
- **Genosyn Connect cannot authenticate installs**, so anyone may start a
  sign-in, from any origin. The consent page names the requesting origin.
  Whoever holds a refresh token Connect issued can renew it: the token is the
  credential.
- **Outbound requests to public hosts** that admins configure (custom AI
  Model endpoints, MCP HTTP servers, Integrations, Pipelines' HTTP steps) are
  the product working. The outbound HTTP policy blocks private, loopback, and
  link-local destinations, unless a master admin or the operator allowlisted
  the host. A mailbox's IMAP or SMTP server, a Repository's git remote, and a
  backup destination may be private hosts, because an owner, admin, or master
  admin chose them: a self-hosted install talking to its own LAN is ordinary
  (`App/server/services/mail/hostPolicy.ts` applies only in multi-tenant
  mode).
- **The European Central Bank's reference rates** are fetched every three
  hours, for companies with automatic exchange rates on, from one URL fixed in
  `App/server/services/exchangeRateFeed.ts`, never from a request. The feed is
  read strictly as dates, currency codes and positive rates; a failed or
  malformed fetch changes nothing, and a fetched rate never replaces one a
  Member set.
- **Operator-controlled configuration** is the operator's responsibility:
  `App/config.ts` (for example `trustedProxyHops` not matching the real
  proxy chain), environment proxies, Helm values, and how the port is
  exposed.
- **Known, documented limits** of the taint policy
  (`App/server/services/taintPolicy.ts`): web tools taint a turn, and then the
  sink tools (`send_mail`, texts and calls, Routine and Skill writers,
  Repository push and pull request) need an Approval. Mail as a taint source,
  and connector compose tools, are deliberately not covered yet. A report
  showing only that an injected email or a connector compose tool sends
  without a taint Approval restates this. It is a finding if the send also
  crosses a mail delivery mode, a Grant, or an Approval that should have held.

## Components that matter most / least

Most, roughly in order:

1. **Authentication and sessions**: `App/server/middleware/auth.ts`,
   `App/server/services/userSessions.ts` (server-side revocable sessions),
   `App/server/routes/auth.ts`, `App/server/services/emailVerification.ts`,
   `App/server/services/masterAdmin.ts` (master-admin bootstrap),
   `App/server/services/authThrottle.ts`, passkeys and 2FA
   (`App/server/services/webAuthn.ts`, `App/server/routes/twoFactor.ts`), SSO
   and account linking (`App/server/services/ssoLogin.ts`,
   `App/server/services/companySso.ts`), API keys, invitations, and password
   reset.
2. **Authorization**: company scoping and role checks in every router under
   `App/server/routes/`, Finance access, Vault per-item access
   (`App/server/services/vault.ts`), conversation ownership, and CSRF and
   origin checks (`App/server/middleware/httpSecurity.ts`).
3. **Secrets at rest**: `App/server/lib/secret.ts` (AES-256-GCM with
   per-scope HKDF keys), `App/server/lib/instanceSecrets.ts` (the managed
   session and encryption keys). Also everything encrypted with them: AI
   Model credentials (`AIModel.configJson`), Connection credentials and OAuth
   tokens, Vault items and Vault sources, repository tokens and SSH keys
   (`App/server/services/repositories.ts`), SSO client secrets, TOTP seeds.
4. **The AI runtime boundary**:
   - the per-turn model proxy that keeps API keys in the App and gives
     OpenCode a disposable token (`App/server/services/agent/opencodeProxy.ts`),
     including an AI Model's backup keys, which it tries in turn when a key is
     refused (`App/server/services/agent/apiKeyRing.ts`);
   - OpenCode process setup (`App/server/services/agent/opencodeServer.ts`,
     `App/server/services/agent/opencodeRuntime.ts`);
   - the Codex runtime (`App/server/services/agent/codexRuntime.ts`,
     `App/server/services/codexSubscription.ts`);
   - MCP tokens and what they are bound to (`App/server/services/mcpTokens.ts`);
   - the internal tool API and its per-request checks
     (`App/server/routes/mcpInternal.ts`, `App/server/mcp/toolManifest.ts`);
   - Member delegation (`App/server/services/memberToolAuthority.ts`,
     `App/server/services/memberTurnAuthority.ts`);
   - tool scopes and restricted turns
     (`App/server/services/agent/tools/index.ts`,
     `App/server/services/agent/runEmployee.ts`), including collaboration
     turns — group discussion turns and `ask_colleague` answers — which may
     only read (`App/server/services/collaborationScope.ts`), and whose
     outcome's work only a Member starts
     (`App/server/services/groupDiscussions.ts`).
5. **Human gates**: Approvals (`App/server/services/approvals.ts`,
   `App/server/routes/approvals.ts`), Standdowns
   (`App/server/services/standdowns.ts`), and the taint policy. Checks and
   Waivers must have no MCP tool that writes them, and Standdowns none that
   lifts them. Decision intake (`App/server/services/decisionIntake.ts`) is
   the only path that creates a Decision. An AI Employee's Goal report
   (`App/server/services/goals.ts`) reaches only Goals it owns or its
   Routines serve and never settles one, and the Explore MCP tools refuse to
   change the SQL of, or delete, a Chart a Goal reads. Letters to the board
   (`App/server/services/boardLetters.ts`) are owner/admin-only, reads
   included; no MCP tool writes a letter, changes its figures, trace or
   audit, or appoints the auditor, which is never the letter's writer.
6. **Mail automation**: the analysis action allowlist
   (`App/server/services/mail/analysisAutomation.ts`: star, mark read,
   archive, a label the cited instruction names, and the email's own verified
   RFC 8058 one-click unsubscribe, on that one thread, once, on arrival),
   unsubscribe verification (`App/server/services/mail/unsubscribe.ts`), mail
   delivery modes (`App/server/services/mail/deliveryPolicy.ts`: draft,
   reply, triage, and review ceilings, set by the surface and never by the
   model), mail rules, handovers, and rendering email HTML in the client.
7. **Outbound requests and SSRF**: `App/server/lib/outboundUrl.ts`,
   `App/server/services/outboundNetworkPolicy.ts` (installed globally before
   the database opens), the runtime allowlist in
   `App/server/services/runtimeSettings.ts`, and the browser's host policy
   (`App/server/services/browserHostPolicy.ts`). Every feature that fetches a
   URL a Member or external content supplies must go through them.
8. **Browser**: `App/server/routes/browserRpc.ts` (including Vault fill,
   which must type a granted credential only into its saved origin without
   returning it), `App/server/services/memberBrowsers.ts`, and
   `App/server/services/browserRequestBoundary.ts` (the App refuses its own
   API to the AI's browser, even with a Member's cookies).
9. **Public routes**: forms, signing, data room guests, webhooks, chat
   surfaces, phone number webhooks, unsubscribe, the careers site and its
   custom-domain host guard, and OAuth callbacks (listed above).
10. **Files and parsers**: upload limits and types, how stored files are
    served (Content-Type, Content-Disposition, sandboxing), document parsing,
    and archive extraction (`App/server/services/backups.ts`).
11. **Genosyn Connect**: `Connect/src/` (`routes.ts`, `broker.ts`,
    `tokens.ts`, `secrets.ts`, `pages.ts`, `throttle.ts`, `config.ts`) and
    the App's client side (`App/server/services/hostedOauth.ts`,
    `App/server/services/hostedOauthTokens.ts`).
12. **Migrations** (`App/server/db/migrations/`, generated, run at every
    boot): defaults that grant access (roles, Finance access, conversation
    ownership), and anything that could orphan or expose encrypted data.

Least:

- `Home/`: a static, prerendered marketing site and docs with no user data.
  Only its small Express server (`Home/server.ts`) handles requests.
- `CLI/`: the operator's own scripts on their own host (`CLI/genosyn`,
  `CLI/install.sh`, `CLI/deploy-saas.sh`).
- `Helm/genosyn/`: chart defaults the operator controls.
- Test drivers and one-off scripts: `App/scripts/`, `App/server/scripts/`.
- Checks that exist only in `App/client/` are UI, not a boundary: the server
  must enforce. XSS in the client is in scope.

## How to exercise it

The scanner image (`.oss-scanner/Dockerfile`) has everything installed and
built in place at `/src`, and works offline. Baseline logs from the image
build are in `/var/log/genosyn-tests/` (`app.log`, `connect.log`,
`home.log`, `boot.log`): compare against them before calling a test failure
new. `app.log` covers the security-focused slice of the App suite that the
Dockerfile names. The whole suite takes CI about 30 minutes on four cores.

**Tests.** They sit beside the code: `App/server/**/*.test.ts` and
`App/client/**/*.test.ts` run under `node:test` through `tsx`. Route tests boot
the real Express router on loopback against a throwaway SQLite database. The
fixtures are in `App/server/test/`: `dbHarness.ts`, `userSession.ts`,
`fakeMailbox.ts`, and `modelVerification.ts`. The full App suite is slow on
two CPUs, so run the files that matter:

```sh
cd /src/App
npx tsx --test --import ./server/test/httpSetup.ts server/middleware/auth.test.ts
npm test                     # the whole suite, as CI runs it (slow)
npm run lint && npm run typecheck
```

Browser tests are `App/scripts/test-*.ts`, run with `npm run test:<name>`.
Playwright's Chromium is installed and `GENOSYN_TEST_BROWSER=chromium` is set.
Examples: `npm run test:passkey-signin`, `npm run test:onboarding-fullstack`,
`npm run test:base-forms-browser`. `npm run test:connect-sign-in` drives the
App and Genosyn Connect together, with a fake Google. Connect's tests are
`cd /src/Connect && npm test` (`Connect/tests/`, fake Google in
`Connect/tests/helpers.ts`). Home's are `cd /src/Home && npm test`.

**Run the App.** It needs no network. The first boot runs the whole migration
chain and creates `App/data/app.sqlite` and `App/data/.instance-secrets.json`:

```sh
cd /src/App
NODE_ENV=production node dist/server/index.js > /tmp/app.log 2>&1 &   # http://127.0.0.1:8471
# after editing server code: npm run build:server, then restart
# or run from source with live reload: npm run dev
```

Connect runs with `cd /src/Connect && CONNECT_PUBLIC_URL=http://127.0.0.1:8473 node dist/index.js`.
Without a Google client configured, `/status` reports `available: false`,
and well-formed sign-in and renewal requests answer 503. Its tests use an
in-process fake Google instead. Home runs with
`cd /src/Home && node dist/server.js` (port 8472).

**Accounts and Companies.** There is no email transport, so verification,
reset, and invitation links are printed to the App's log, tagged
`[email:skipped]`. Passwords need at least 12 characters. curl needs no
`Origin` header, but a browser always sends one, and it must match the host.

```sh
B=http://127.0.0.1:8471; J='Content-Type: application/json'
# Owner of a first Company (signup signs you in)
curl -s -c owner.jar -H "$J" $B/api/auth/signup \
  -d '{"email":"owner@example.test","password":"owner-password-1","name":"Owner"}'
curl -s -b owner.jar -H "$J" $B/api/companies -d '{"name":"Acme"}'      # -> {"id": "<cid>", ...}
# A Member: invite, sign up with the invited address, then accept with the
# token at the end of the /invite/... link the log shows
curl -s -b owner.jar -H "$J" $B/api/companies/<cid>/invitations -d '{"email":"member@example.test"}'
curl -s -c member.jar -H "$J" $B/api/auth/signup \
  -d '{"email":"member@example.test","password":"member-password-1","name":"Member"}'
curl -s -b member.jar -H "$J" $B/api/invitations/accept -d '{"token":"<invitation token>"}'
# Make a Member an admin (owner only; <uid> is the userId from GET .../members)
curl -s -b owner.jar $B/api/companies/<cid>/members
curl -s -b owner.jar -X PATCH -H "$J" $B/api/companies/<cid>/members/<uid> -d '{"role":"admin"}'
# Mint a personal API key: send the response's "token" (gen_...) as
# "Authorization: Bearer <token>"; its "prefix" is only a label
curl -s -b owner.jar -H "$J" $B/api/companies/<cid>/api-keys -d '{"name":"test"}'
```

For cross-company tests, sign up a second owner and create a second Company.
To make a master admin, set `security.bootstrapMasterAdminEmail` in
`App/config.ts` before the first boot (then `npm run build:server`), sign up
with that address, and confirm it with
`POST /api/auth/verify-email {"token": "<from the log>"}`. As a test-only
shortcut, set `isMasterAdmin = 1` and `emailVerifiedAt` on the row in the
`users` table with `sqlite3 App/data/app.sqlite`.

**AI Models offline.** No provider is reachable during a scan. The unit tests
stub providers instead. To drive a real turn, serve an OpenAI-compatible stub
on loopback and add its host to the private-host allowlist (Admin → Runtime →
Outbound network, or `security.outboundPrivateHostAllowlist` in
`App/config.ts`). Then add a custom AI Model pointing at it.

## How we rate severity

Rate by what an attacker needs first and what they gain. Assume the default
self-hosted install: single-tenant, host execution, SQLite.

**Critical**
- Remote code execution, or any company's data, without an account.
- Authentication bypass or account takeover: signing in as someone else,
  forging or replaying a session, API key, MCP token, or browser or bridge
  token, or completing sign-in without the second factor. Also hijacking an
  account through reset, verification, invitation, or SSO linking, or
  becoming master admin without the operator's consent.
- Cross-company access through the application: a Member or admin of one
  Company reads or changes another Company's data, employees, Runs,
  conversations, mail, files, or credentials through the API, realtime events,
  search, or AI tools.
- Disclosure of instance secrets (`App/data/.instance-secrets.json`, the
  session or encryption key) or of stored credentials (AI Model API keys,
  OAuth access or refresh tokens, Vault plaintext, repository tokens or SSH
  keys, mailbox passwords, SSO client secrets) to anyone not entitled to them.
- Anyone outside the Company making the host run a command, or making an AI
  Employee use privileged tools: an email sender, a web page, a document, an
  external chat user, a webhook caller, a public form. Also reaching the
  loopback-only APIs from outside.
- Genosyn Connect: obtaining another install's credential, forging or
  re-targeting a sealed request or `state`, or extracting its secrets.

**High**
- Privilege escalation within a Company: Member to admin or owner, Finance
  `none` or `read` to writing Finance data, or a Member reaching admin-only
  data (the audit log, Approval payloads, Genosyn-browser recordings, Secret
  values, letters to the board) or admin-only actions.
- A Member getting host command execution, or coding, browser, company MCP,
  or Memory tools, outside the work-session path the Company enabled.
  Examples: through chat, through another employee's authority, on a
  Repository with commands off, or with `executionMode: "disabled"`.
- Bypassing a human gate: performing a held action without its Approval,
  changing what an Approval replays after it was granted, acting while a
  Standdown covers the scope, an AI Employee or Member writing a Check or
  Waiver or lifting a Standdown, or an AI Employee settling a Goal,
  changing the SQL of, or deleting, a Chart a Goal reads, appointing or
  replacing the board's auditor, or changing a letter's figures or audit.
- Bypassing a Grant: an AI Employee using a Connection, Vault item,
  Repository, Base, mailbox, or Project it was not granted. Also a Vault
  `use` Grant returning plaintext to the model, or Vault fill typing into
  another origin.
- An AI Employee writing another employee's Skills. Its tools write only its
  own (`App/server/services/skillAccess.ts`): a Skill's body is standing
  instructions in every prompt of the employee that owns it, so a teammate's
  Skills change only through a Member, whoever drives the turn.
- Prompt injection (from email, web pages, documents, MCP results, or
  repository content) that makes the server cross one of its own ceilings.
  Examples: mail automation doing anything beyond its allowlist or choosing
  its own target; a send in a draft, triage, or review delivery mode;
  shedding a turn's ceiling through deferred work; a tool outside the
  turn's scope.
- Stored XSS a Member, or external content (an email, a form submission, a
  document, a file), can plant in another user's session.
- SSRF to loopback, private, link-local, or metadata addresses despite the
  outbound policy (redirects, DNS rebinding, alternative IP forms, paths that
  skip the policy). Critical when it reaches the internal APIs or a cloud
  metadata credential.
- Reading another Member's private conversation, private Vault item, or
  restricted Project.

**Medium**
- CSRF on a state-changing route. High when it changes credentials, roles,
  security settings, Grants, or money.
- Stored XSS that only an owner or admin can plant in their own Company, and
  reflected XSS.
- Breaking a Repository's command allowlist when commands are restricted.
  The list is policy, not isolation, and allowed tools already run
  repository code.
- Information leaks across roles without secrets: metadata, other Members'
  email addresses, the names of private items.
- Bypassing rate limits on login, the second factor, or token guessing,
  where that makes an online attack practical.
- Unauthenticated denial of service that takes the install down with little
  effort.

**Low**
- Denial of service by an authenticated user, or one that needs large
  resources.
- Account enumeration, open redirects without a further impact, and missing
  hardening with no demonstrated exploit.

Findings that need the attacker to be a master admin, the operator, or the
host already are out of scope. Findings that need an owner or admin role are
in scope when they reach another Company through the application, or cross a
boundary that still holds with `executionMode: "disabled"` (for example,
becoming master admin).

## Anything to leave alone

- Anything restating that AI Employees run commands on the host without a
  sandbox, read the App's own files, or reach the network from a command.
  The same goes for owners, admins, or Members (through a commands-enabled
  work session) directing that. See "What is by design".
- Master-admin powers (the SQL console, custom JavaScript, restore, runtime
  settings) and operator configuration.
- Sensitive content in browser snapshots, screenshots, or recordings that the
  viewer is authorized to see.
- Dependency CVEs with no reachable path from Genosyn's code, and version
  bumps without a demonstrated impact.
- Self-XSS, missing security headers or cookie flags without an exploit,
  clickjacking of pages with no sensitive action, CSV or formula injection in
  exports, and verbose errors without secrets.
- Prompt injection that only changes what an AI Employee says, or makes it do
  something its Grants, the turn's tool scope, and the human gates already
  allow.
- The marketing site's content, the CLI's and the Helm chart's choices about
  the operator's own host, and the documented limits of the taint policy.
- Issues in third-party services themselves (Google, OpenAI, Anthropic,
  Slack, and others).

## Reports and patches

A useful report states the attacker's starting point (no account, Member,
admin, owner, external content), the impact, and a reproducer against a fresh
install, set up as in "How to exercise it". Patches should follow `AGENTS.md`:

- logic in `App/server/services/`, with routes only parsing and shaping;
- a zod schema on every endpoint;
- migrations generated, never hand-written;
- a regression test beside the code (`*.test.ts`);
- no weakening of a human gate, Grant, or allowlist to make a test pass.
