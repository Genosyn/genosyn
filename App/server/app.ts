import "reflect-metadata";
import express from "express";
import cookieSession from "cookie-session";
import { config } from "../config.js";
import { authRouter } from "./routes/auth.js";
import { ssoRouter } from "./routes/sso.js";
import { companySsoAuthRouter } from "./routes/companySsoAuth.js";
import { companySsoRouter } from "./routes/companySso.js";
import { twoFactorRouter } from "./routes/twoFactor.js";
import { passkeyLoginRouter } from "./routes/passkeyLogin.js";
import { companiesRouter } from "./routes/companies.js";
import { invitationsRouter } from "./routes/invitations.js";
import { employeesRouter } from "./routes/employees.js";
import { skillsRouter } from "./routes/skills.js";
import { toolCatalogueRouter } from "./routes/toolCatalogue.js";
import { routinesRouter } from "./routes/routines.js";
import { proactiveRouter } from "./routes/proactive.js";
import { askAiRouter } from "./routes/askAi.js";
import { routineFoldersRouter } from "./routes/routineFolders.js";
import { goalsRouter } from "./routes/goals.js";
import { improvementRouter } from "./routes/improvement.js";
import { decisionPoliciesRouter } from "./routes/decisionPolicies.js";
import { decisionStackSettingsRouter } from "./routes/decisionStackSettings.js";
import { autonomyRouter } from "./routes/autonomy.js";
import { budgetsRouter } from "./routes/budgets.js";
import { companyPoliciesRouter } from "./routes/companyPolicies.js";
import { reactivityRouter } from "./routes/reactivity.js";
import { routineChecksRouter } from "./routes/routineChecks.js";
import { standdownsRouter } from "./routes/standdowns.js";
import { modelsRouter } from "./routes/models.js";
import { companyModelsRouter } from "./routes/companyModels.js";
import { employeeSurfaceRouter } from "./routes/employeeSurface.js";
import { employeeAccessRouter } from "./routes/employeeAccess.js";
import { projectsRouter } from "./routes/projects.js";
import { approvalsRouter } from "./routes/approvals.js";
import { decisionsRouter } from "./routes/decisions.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { mcpRouter } from "./routes/mcp.js";
import { mcpConnectRouter } from "./routes/mcpConnect.js";
import { companyMcpRouter } from "./routes/companyMcp.js";
import { mcpInternalRouter } from "./routes/mcpInternal.js";
import { secretsRouter } from "./routes/secrets.js";
import { vaultRouter } from "./routes/vault.js";
import { auditRouter } from "./routes/audit.js";
import { recordHistoryRouter } from "./routes/recordHistory.js";
import { usageRouter } from "./routes/usage.js";
import { templatesRouter } from "./routes/templates.js";
import { basesRouter } from "./routes/bases.js";
import { backupsRouter } from "./routes/backups.js";
import { backupDestinationsRouter } from "./routes/backupDestinations.js";
import { adminRouter } from "./routes/admin.js";
import { customJavaScriptRouter } from "./routes/customJavaScript.js";
import { integrationsRouter } from "./routes/integrations.js";
import { phoneRouter } from "./routes/phone.js";
import { phoneWebhooksRouter } from "./routes/phoneWebhooks.js";
import { PHONE_WEBHOOK_MOUNT } from "./services/phone/webhookUrls.js";
import { integrationsOauthRouter } from "./routes/integrationsOauth.js";
import { chatSurfaceBindRouter, chatSurfacesRouter } from "./routes/chatSurfaces.js";
// The mount path is imported rather than repeated: the same constant builds
// the URL the operator pastes into Microsoft's or Meta's console, and a mount
// that drifted from it would advertise an endpoint that 404s.
import {
  CHAT_SURFACE_WEBHOOK_MOUNT,
  chatSurfaceWebhooksRouter,
} from "./routes/chatSurfaceWebhooks.js";
import { workspaceRouter } from "./routes/workspace.js";
import { workspaceDiscussionsRouter } from "./routes/workspaceDiscussions.js";
import { pipelinesRouter } from "./routes/pipelines.js";
import { emailProvidersRouter } from "./routes/emailProviders.js";
import { emailLogsRouter } from "./routes/emailLogs.js";
import { notebooksRouter } from "./routes/notebooks.js";
import { notesRouter } from "./routes/notes.js";
import { resourcesRouter } from "./routes/resources.js";
import { resourceFoldersRouter } from "./routes/resourceFolders.js";
import { repositoriesRouter } from "./routes/repositories.js";
import { repositoryContentRouter } from "./routes/repositoryContent.js";
import { financeRouter } from "./routes/finance.js";
import { cardExpensesRouter } from "./routes/cardExpenses.js";
import { contractsRouter } from "./routes/contracts.js";
import { signaturesRouter } from "./routes/signatures.js";
import { publicSignaturesRouter, publicSigningSecurityHeaders } from "./routes/publicSignatures.js";
import { publicFormsRouter, publicFormsSecurityHeaders } from "./routes/publicForms.js";
import { dataRoomsRouter } from "./routes/dataRooms.js";
import {
  publicDataRoomSecurityHeaders,
  publicDataRoomsRouter,
} from "./routes/publicDataRooms.js";
import { formsRouter } from "./routes/forms.js";
import { exploreRouter } from "./routes/explore.js";
import { notificationsRouter } from "./routes/notifications.js";
import { teamsRouter } from "./routes/teams.js";
import { handoffsRouter } from "./routes/handoffs.js";
import { inboxRouter } from "./routes/inbox.js";
import { mailRouter } from "./routes/mail.js";
import { revenueRouter } from "./routes/revenue.js";
import { meetingsRouter } from "./routes/meetings.js";
import { revenueOperationsRouter } from "./routes/revenueOperations.js";
import { marketingRouter } from "./routes/marketing.js";
import { recruitingRouter } from "./routes/recruiting.js";
import { careersRouter } from "./routes/careers.js";
import { careersHostGuard } from "./routes/careersSite.js";
import { unsubscribeRouter } from "./routes/unsubscribe.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { connectedAppsRouter } from "./routes/connectedApps.js";
import {
  oauthAuthorizeRouter,
  oauthConsentRouter,
  oauthDiscoveryRouter,
  oauthServerRouter,
} from "./routes/mcpOauth.js";
import { cliRouter } from "./routes/cli.js";
import { openapiRouter } from "./routes/openapi.js";
import { homeRouter } from "./routes/home.js";
import { navigationRouter } from "./routes/navigation.js";
import { workTimelineRouter } from "./routes/workTimeline.js";
import { employeeWorkQueueRouter } from "./routes/employeeWorkQueue.js";
import { tldrsRouter } from "./routes/tldrs.js";
import { boardLettersRouter } from "./routes/boardLetters.js";
import { searchRouter } from "./routes/search.js";
import { systemHealthRouter } from "./routes/systemHealth.js";
import { pushRouter } from "./routes/push.js";
import { browserSessionsRouter } from "./routes/browserSessions.js";
import { browserRpcRouter } from "./routes/browserRpc.js";
import { memberBrowserBridgeRouter } from "./routes/memberBrowserBridge.js";
import { memberBrowsersRouter } from "./routes/memberBrowsers.js";
import { tagsRouter } from "./routes/tags.js";
import { requireTrustedOrigin, securityHeaders } from "./middleware/httpSecurity.js";
import { loopbackOnly } from "./middleware/loopbackOnly.js";
import { appVersion } from "./lib/version.js";
import { secureSessionCookies } from "./services/runtimeSecurity.js";
import { getEffectiveInstanceSecrets } from "./lib/instanceSecrets.js";
import { rejectAiBrowserAppRequests } from "./services/browserRequestBoundary.js";

/**
 * The App's HTTP surface: every middleware and router, in the order a request
 * meets them, from security headers to the last company router.
 *
 * It lives apart from `index.ts` so the exact app the server listens with can
 * be built without booting anything — no database, timers, or listening
 * socket. The OpenAPI document walks this same router stack to list every
 * endpoint (`server/openapi/routeDiscovery.ts`), and its coverage test builds
 * it here to prove no route ships undocumented. `index.ts` adds the client
 * (Vite in development, the built SPA in production), the careers pages and
 * the error handler after it.
 *
 * Mount a new router here, not in `index.ts`.
 */
export function createApp(): express.Express {
  const app = express();
  if (config.security.trustedProxyHops > 0) {
    app.set("trust proxy", config.security.trustedProxyHops);
  }
  app.use(securityHeaders);
  // Liveness/readiness probe — no auth, no session, no body. Mounted first so
  // an origin or parser misconfiguration can never take the probe down with it.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: appVersion() });
  });
  // A careers site's custom domain serves the careers site and nothing else:
  // before any other route, so no App API, page or sign-in answers there.
  app.use(careersHostGuard({ isDev: process.env.NODE_ENV !== "production" }));
  // The genosyn-api command line, a file to download (`routes/cli.ts`). It
  // needs no session or body, so it sits ahead of both.
  app.use("/cli", cliRouter());
  // External chat surface webhooks (M59) — Microsoft Teams and WhatsApp POST
  // here. Mounted BEFORE express.json() and before requireTrustedOrigin/session
  // middleware, because the signature is the only credential this endpoint
  // has: WhatsApp's signature is an HMAC over the exact bytes Meta sent, so the
  // router applies its own express.raw() and must see them before any parser
  // re-serializes them, and neither platform sends a cookie or an Origin
  // header, so the session and trusted-origin middleware would reject every
  // delivery.
  app.use(CHAT_SURFACE_WEBHOOK_MOUNT, chatSurfaceWebhooksRouter);
  // Phone number webhooks — Twilio's incoming texts and calls, the turns of a
  // conversation, and delivery statuses. Same reasons as above: Twilio sends no
  // cookie or Origin, and its signature (keyed by the number's Connection) is
  // the only credential, checked by the router itself.
  app.use(PHONE_WEBHOOK_MOUNT, phoneWebhooksRouter);
  // The Genosyn MCP server — every API-key operation, for any MCP client.
  // Mounted before the JSON parser and the session on purpose: an API key is
  // its only credential, so it never reads the session cookie, and it parses
  // its JSON-RPC body (larger than 1 MB, to carry a file) only after the key
  // checks out. Each tool call goes back through this same app with that key.
  app.use("/api/companies/:cid/mcp", companyMcpRouter);
  // OAuth for that server, so a client that signs in instead of sending a key
  // (claude.ai, ChatGPT) can connect: discovery, and the authorization
  // endpoint, a browser navigation that hands the request to the consent
  // page. Neither reads a session or a body.
  app.use("/.well-known", oauthDiscoveryRouter);
  app.use("/oauth", oauthAuthorizeRouter);
  // Signing URLs contain a bearer credential. Install these protections before
  // body parsing as well, so parser errors cannot emit a cacheable response.
  app.use("/api/sign", publicSigningSecurityHeaders);
  app.use("/sign", publicSigningSecurityHeaders);
  app.use("/api/forms", publicFormsSecurityHeaders);
  app.use("/forms", publicFormsSecurityHeaders);
  // A guest's data room link is a bearer credential too.
  app.use("/api/room", publicDataRoomSecurityHeaders);
  app.use("/room", publicDataRoomSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  // The OAuth registration, token and revocation endpoints: called by the
  // clients' own servers with no cookie, so ahead of the session — the client
  // credentials and the PKCE verifier are the only proof they take.
  app.use("/api/oauth", oauthServerRouter);

  // Recipient signing links are bearer-token authenticated and intentionally
  // session-free. Mount before cookie sessions and the trusted-origin gate so
  // email clients that omit Origin can view, consent, complete, or decline.
  app.use("/api/sign", publicSignaturesRouter);
  app.use("/api/forms", publicFormsRouter);
  // Data room guests: no account, no session — the token in their private
  // link is the credential, checked by the router on every request.
  app.use("/api/room", publicDataRoomsRouter);

  let sessionMiddleware: ReturnType<typeof cookieSession> | null = null;
  let sessionMiddlewareSecret = "";
  const currentSessionMiddleware = () => {
    const secret = getEffectiveInstanceSecrets().sessionSecret;
    if (!sessionMiddleware || sessionMiddlewareSecret !== secret) {
      sessionMiddlewareSecret = secret;
      sessionMiddleware = cookieSession({
        name: "genosyn.sid",
        secret,
        maxAge: 1000 * 60 * 60 * 24 * config.security.sessionMaxAgeDays,
        httpOnly: true,
        sameSite: "lax",
      });
    }
    return sessionMiddleware;
  };
  app.use((req, res, next) => {
    currentSessionMiddleware()(req, res, () => {
      // `cookie-session` reads this again when it writes the response. Resolve
      // it per request so saving an HTTPS public URL takes effect immediately.
      req.sessionOptions.secure = secureSessionCookies();
      next();
    });
  });

  // Same-origin browser code selected at Admin → General. The shell requests
  // it on every page, but the route only returns operator code for a valid
  // signed-in session after the fixed loader identifies an eligible page.
  app.use("/api/app", customJavaScriptRouter);

  // A human may temporarily sign into Genosyn inside an AI Employee's
  // persistent Browser. Once that context carries the Member session cookie,
  // browserChromium adds this marker after page code chooses its headers.
  // Reject every App API centrally so the session cannot mint API keys,
  // change roles, or route around item-level Vault Grants.
  app.use("/api", rejectAiBrowserAppRequests);

  // Public webhooks (token in URL is the credential). Mounted before auth
  // so session-less POSTs from external systems aren't gated.
  app.use("/api/webhooks", webhooksRouter);

  // Unsubscribe (M32). Deliberately NOT under /api and deliberately
  // unauthenticated: RFC 8058 one-click means Gmail's servers POST this URL
  // directly, with no session, no CSRF token and no JavaScript. It must also
  // still work years after the message was sent, so the token carries
  // everything it needs and never expires.
  app.use(unsubscribeRouter);

  // Public OAuth callback surface. Google redirects the browser here after
  // the user clicks "Allow"; auth is the single-use `state` token minted
  // inside startOauth(). Mounted before session so cross-site-redirect
  // cookie behavior doesn't matter.
  app.use("/api/integrations/oauth", integrationsOauthRouter);

  // Built-in MCP tools called by the Genosyn stdio binary we spawn alongside
  // every AI employee. Auth is a short-lived Bearer token we issued moments
  // earlier — session-less on purpose, but mounted before the session router
  // anyway so no cookie state leaks into these requests.
  app.use("/api/internal/mcp", loopbackOnly, mcpInternalRouter);

  // Built-in browser-tool RPC. The (now stripped down) `browser` MCP child
  // posts every tool call here; the App owns Chromium so it persists
  // across MCP child spawns / chat turns.
  app.use("/api/internal/browser/sessions/:id", loopbackOnly, browserRpcRouter);

  // Public OpenAPI document + Swagger UI. Mounted before the session router
  // so the docs page works for unauthenticated visitors — the spec describes
  // shapes, not data, and any documented endpoint still enforces its own auth.
  app.use("/api", openapiRouter);

  // Public machine endpoints above authenticate with one-shot or bearer
  // tokens. Everything below also rejects cross-origin browser mutations.
  app.use(requireTrustedOrigin);

  // The careers site's public API: anyone may read a public site and apply,
  // and a signed-in Member also sees internal Openings. Below the origin gate,
  // so an application can only be posted from the careers page itself.
  app.use("/api/careers", careersRouter);

  // The bridge agent's own surface: redeem a pairing code, download the agent.
  // It is session-less and bearer-shaped like the two internal routers above,
  // but it is mounted *below* `requireTrustedOrigin` on purpose. The agent is
  // a Node process and sends no `Origin`, so it passes that gate untouched,
  // while a web page cannot POST `/pair` cross-origin. Being below
  // `rejectAiBrowserAppRequests` matters more: without it an AI-driven browser
  // holding a Member session could pair a browser for itself.
  app.use("/api/internal/member-browsers", memberBrowserBridgeRouter);

  // SSO sign-in (status probe, IdP redirect, callback). Mounted before the
  // main auth router so its more-specific `/api/auth/sso/*` paths win; the
  // callback authenticates via the single-use state token, then writes the
  // session cookie itself. Per-company SSO (M56 Phase B) sits at the even
  // more specific `/api/auth/sso/company/*` and is mounted first for the
  // same reason.
  // The consent page's own calls: a signed-in Member approving or denying an
  // app. Below the origin gate, so no other site can answer for them.
  app.use("/api/oauth/consent", oauthConsentRouter);
  app.use("/api/auth/sso/company", companySsoAuthRouter);
  app.use("/api/auth/sso", ssoRouter);
  app.use("/api/auth", passkeyLoginRouter);
  app.use("/api/auth", twoFactorRouter);
  app.use("/api/auth", authRouter);
  // Web Push subscriptions for the PWA — user-scoped, so mounted outside
  // the per-company tree.
  app.use("/api/push", pushRouter);
  app.use("/api/companies", companiesRouter);
  app.use("/api/invitations", invitationsRouter);
  app.use("/api/backups", backupsRouter);
  app.use("/api/backup-destinations", backupDestinationsRouter);
  // Instance-wide admin — install health (DB, migrations, disk, runtime).
  // Not company-scoped; see routes/admin.ts for the auth rationale.
  app.use("/api/admin", adminRouter);
  app.use("/api", templatesRouter);
  // Nested under /api/companies/:cid/...
  app.use("/api/companies/:cid/employees", employeesRouter);
  // Chat + workspace file editor, scoped per employee. Split from the
  // employees CRUD router because these talk to the runner seam + fs, not
  // just the DB.
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
  // One employee's Access page: everything grantable, and many Grants at once,
  // each replayed through its kind's own route.
  app.use("/api/companies/:cid/employees", employeeAccessRouter);
  app.use("/api/companies/:cid", skillsRouter);
  app.use("/api/companies/:cid", toolCatalogueRouter);
  // Ask AI — the top-nav chat window. Its own router, mounted ahead of the
  // section routers, so no section's admin-only mutation gate applies to
  // asking a question about something on screen.
  app.use("/api/companies/:cid", askAiRouter);
  app.use("/api/companies/:cid", proactiveRouter);
  app.use("/api/companies/:cid", routinesRouter);
  app.use("/api/companies/:cid", routineFoldersRouter);
  app.use("/api/companies/:cid", goalsRouter);
  app.use("/api/companies/:cid", improvementRouter);
  app.use("/api/companies/:cid", decisionPoliciesRouter);
  // Decision stack → Settings: the switch for new Decisions and the
  // instructions every new one is checked against. Owner/admin to change.
  app.use("/api/companies/:cid", decisionStackSettingsRouter);
  app.use("/api/companies/:cid", autonomyRouter);
  app.use("/api/companies/:cid", budgetsRouter);
  app.use("/api/companies/:cid", companyPoliciesRouter);
  app.use("/api/companies/:cid", reactivityRouter);
  // M58 — the bar a Run has to clear, and the evidence that it did.
  app.use("/api/companies/:cid", routineChecksRouter);
  // M58 — the stop button. No MCP tool in either direction; see the router.
  app.use("/api/companies/:cid", standdownsRouter);
  // Teams + Handoffs (Phase B). Teams group employees; Handoffs are
  // formal AI→AI delegation with status workflow.
  app.use("/api/companies/:cid", teamsRouter);
  // Reusable company tags + polymorphic resource assignments.
  app.use("/api/companies/:cid", tagsRouter);
  app.use("/api/companies/:cid", handoffsRouter);
  // Company-wide daily digest (Phase C). Rolls up today's journal entries
  // across all employees so humans get a single feed.
  app.use("/api/companies/:cid", inboxRouter);
  // Home page aggregation — the post-sign-in landing surface.
  app.use("/api/companies/:cid", homeRouter);
  // The AI Employee work timeline behind Home's "What your AI employees did"
  // panel. Its own router because it refetches per employee, on its own clock.
  app.use("/api/companies/:cid", workTimelineRouter);
  app.use("/api/companies/:cid", employeeWorkQueueRouter);
  // Scheduled company briefs: configuration, history, and per-Member dismissal.
  app.use("/api/companies/:cid", tldrsRouter);
  // The monthly letter to the board, its writer and its auditor. Owners and
  // admins only, reads included.
  app.use("/api/companies/:cid", boardLettersRouter);
  // Company-wide quick search — entity results for the ⌘K palette.
  app.use("/api/companies/:cid", searchRouter);
  // Which sections the palette lists, and what waits beside the Decision stack.
  app.use("/api/companies/:cid", navigationRouter);
  // System Health — company-scoped roll-up of failed/stuck/skipped runs,
  // missing models, stale approvals, email + integration failures.
  app.use("/api/companies/:cid", systemHealthRouter);
  // Projects + Todos (task manager). See ROADMAP.md V1 backlog.
  app.use("/api/companies/:cid", projectsRouter);
  // Per-user notification feed — bell + panel in the top bar.
  app.use("/api/companies/:cid", notificationsRouter);
  // Bases (Airtable-style workspaces) — companion to Tasks.
  app.use("/api/companies/:cid", basesRouter);
  app.use("/api/companies/:cid", formsRouter);
  app.use("/api/companies/:cid", approvalsRouter);
  // The Decision Stack — questions an AI employee raised for a human to answer.
  // Member-level, unlike the admin-gated approvals inbox above it.
  app.use("/api/companies/:cid", decisionsRouter);
  app.use("/api/companies/:cid", secretsRouter);
  app.use("/api/companies/:cid/vault", vaultRouter);
  app.use("/api/companies/:cid", auditRouter);
  // One record's History — Member-readable behind that record's own read bar.
  app.use("/api/companies/:cid", recordHistoryRouter);
  // Per-company SSO settings (M56 Phase B).
  app.use("/api/companies/:cid", companySsoRouter);
  app.use("/api/companies/:cid", usageRouter);
  // Per-user programmatic API keys (M14). Bearer tokens minted here
  // authenticate as the calling user, scoped to this company only.
  app.use("/api/companies/:cid", apiKeysRouter);
  app.use("/api/companies/:cid", connectedAppsRouter);
  // The company's AI Models (Settings → AI Models) and every route keyed on
  // one model row; an employee's router below only attaches, detaches and
  // switches which of them it uses.
  app.use("/api/companies/:cid/models", companyModelsRouter);
  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  // External MCP transport — lets an outside harness connect to this
  // employee's built-in `genosyn` tools over Streamable HTTP, authenticated
  // by an API key. Mounted BEFORE the per-employee MCP CRUD router so the
  // more specific `/mcp/connect` path wins.
  app.use("/api/companies/:cid/employees/:eid/mcp/connect", mcpConnectRouter);
  app.use("/api/companies/:cid/employees/:eid/mcp", mcpRouter);

  // Live browser-view sessions — the iframe-able viewer + WS plumbing for
  // the headless Chromium the AI employee drives. See `services/browserSessions.ts`.
  app.use("/api/companies/:cid/employees/:eid/browser-sessions", browserSessionsRouter);

  // Browsers Members connect from their own computers. Owner-scoped, never
  // role-scoped — see routes/memberBrowsers.ts.
  app.use("/api/companies/:cid/member-browsers", memberBrowsersRouter);

  // Integrations + Connections. Company-scoped because connections belong
  // to the company and are granted out to employees.
  app.use("/api/companies/:cid/integrations", integrationsRouter);

  // Phone numbers — Twilio numbers given to AI Employees, with their texts and
  // calls. Owner/admin only, reads included; see routes/phone.ts.
  app.use("/api/companies/:cid/phone", phoneRouter);

  // External chat surfaces (M59) — who is talking to the company's bots, and
  // the webhook URL to paste into Microsoft's or Meta's console.
  app.use("/api/companies/:cid", chatSurfacesRouter);
  // Claiming a binding is deliberately not company-scoped: the human following
  // the one-time link out of Slack has not picked a company yet, and the
  // identity row already names one. Its own auth is attached per route rather
  // than to the router, so nothing here leaks onto the other `/api` mounts.
  app.use("/api", chatSurfaceBindRouter);

  // Workspace chat — Slack-style channels, DMs, file uploads, reactions.
  // Mounted under companies so `requireCompanyMember` gates every route.
  app.use("/api/companies/:cid/workspace", workspaceRouter);
  // Group chats and group discussions: several AI Employees working a Member's
  // question out together in a channel, ending in one outcome.
  app.use("/api/companies/:cid/workspace", workspaceDiscussionsRouter);

  // Pipelines — n8n-style visual automation, separate primitive from
  // Routines. Each Pipeline is a DAG of typed nodes; see services/pipelines/.
  app.use("/api/companies/:cid", pipelinesRouter);

  // Notes — Notion-style company-wide markdown knowledge base. Both human
  // members and AI employees (via the built-in MCP server) can read/write.
  // Notebooks are the top-level grouping; every Note belongs to one.
  app.use("/api/companies/:cid", notebooksRouter);
  app.use("/api/companies/:cid", notesRouter);

  // Resources (M18) — knowledge ingestion. Humans paste URLs / pastes /
  // upload PDFs / EPUBs; AI employees query the result via MCP tools.
  app.use("/api/companies/:cid", resourcesRouter);
  // The Resources library's files-and-folders tree.
  app.use("/api/companies/:cid", resourceFoldersRouter);

  // Repositories — provider-agnostic git repos the company adds so
  // granted AI employees can read, commit, and push real code. Checkouts are
  // materialized into the employee cwd before each spawn (services/codeRepos).
  app.use("/api/companies/:cid", repositoriesRouter);
  app.use("/api/companies/:cid", repositoryContentRouter);

  // Finance (M19 Phase A) — Customers, Products, Tax rates, Invoices.
  // Native invoicing with HTML render + email send via the company's
  // EmailProvider. Ledger / reports / reconciliation come in later phases.
  app.use("/api/companies/:cid", financeRouter);
  app.use("/api/companies/:cid", cardExpensesRouter);

  // Customer contracts — uploaded agreements for the Customers section.
  // Separate router from finance so the Customers section owns its own
  // backend surface; mounted at the same company-scoped base path.
  app.use("/api/companies/:cid", contractsRouter);

  // Signature envelopes — sender/admin surface. Recipient links use the
  // public router mounted above; every route here requires company membership.
  app.use("/api/companies/:cid", signaturesRouter);

  // Explore (M20) — Metabase-style analytics. Saved SQL queries (Charts) +
  // grids of charts (Dashboards) re-using the company's postgres/mysql/
  // clickhouse Integration Connections as the data source.
  app.use("/api/companies/:cid", exploreRouter);

  // Per-company email providers (SMTP / SendGrid / Mailgun / Resend /
  // Postmark) and the append-only delivery log used by Settings → Notification email
  // and its Logs tab.
  app.use("/api/companies/:cid/email/providers", emailProvidersRouter);
  app.use("/api/companies/:cid/email/logs", emailLogsRouter);

  // Email section (M25) — the company's real Gmail inboxes: two-way sync,
  // threads, drafts, rules, AI handovers, and per-employee grants. Distinct
  // from the transactional /email/* surface above; see services/mail/.
  app.use("/api/companies/:cid", mailRouter);

  // Revenue section (M32) — contacts, deals, activities, sequences, signals,
  // suppressions and the revenue reports.
  app.use("/api/companies/:cid", revenueRouter);
  app.use("/api/companies/:cid", revenueOperationsRouter);

  // Meetings section (M44) — connected calendars, the mirrored agenda,
  // recorded calls and their transcripts, and the per-employee grants that
  // decide which AI Employee may read or record which calendar.
  app.use("/api/companies/:cid", meetingsRouter);

  // Marketing agency (M35) — Campaign strategy, Creative, Experiments,
  // performance snapshots and per-employee access.
  app.use("/api/companies/:cid", marketingRouter);

  // Recruiting — Openings, Applications and their Scorecards, the AI
  // screener, and the careers site's settings and custom domain.
  app.use("/api/companies/:cid", recruitingRouter);

  // Data rooms — documents shared with guests outside the company, their
  // activity and questions, and the room's AI work. Owners and admins only.
  app.use("/api/companies/:cid", dataRoomsRouter);

  return app;
}
