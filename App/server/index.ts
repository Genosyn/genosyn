import "reflect-metadata";
import express from "express";
import cookieSession from "cookie-session";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { initDb } from "./db/datasource.js";
import { ensureBootstrapMasterAdmin } from "./services/masterAdmin.js";
import { bootCron } from "./services/cron.js";
import { bootBackups } from "./services/backups.js";
import { bootPipelineCron } from "./services/pipelines/index.js";
import { bootContextWindowRefresh } from "./services/agent/contextWindowRefresh.js";
import { bootRecurringInvoices } from "./services/recurringInvoices.js";
import { bootRevenue } from "./services/revenue/boot.js";
import { bootMeetings } from "./services/meetings/boot.js";
import { bootTelegramListeners } from "./services/telegramListener.js";
import { bootMailSync } from "./services/mail/sync.js";
import { bootMailHandovers } from "./services/mail/handovers.js";
import { bootMailDraftSendQueue } from "./services/mail/draftSendQueue.js";
import { bootMailAutomationQueue } from "./services/mail/automationQueue.js";
import { finalizeInterruptedAssistantTurns } from "./services/mail/assistant.js";
import { attachRealtime, bootRealtimeBridge } from "./services/realtime.js";
import { errorHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { ssoRouter } from "./routes/sso.js";
import { twoFactorRouter } from "./routes/twoFactor.js";
import { companiesRouter } from "./routes/companies.js";
import { invitationsRouter } from "./routes/invitations.js";
import { employeesRouter } from "./routes/employees.js";
import { skillsRouter } from "./routes/skills.js";
import { toolCatalogueRouter } from "./routes/toolCatalogue.js";
import { routinesRouter } from "./routes/routines.js";
import { modelsRouter } from "./routes/models.js";
import { employeeSurfaceRouter } from "./routes/employeeSurface.js";
import { projectsRouter } from "./routes/projects.js";
import { approvalsRouter } from "./routes/approvals.js";
import { decisionsRouter } from "./routes/decisions.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { mcpRouter } from "./routes/mcp.js";
import { mcpConnectRouter } from "./routes/mcpConnect.js";
import { mcpInternalRouter } from "./routes/mcpInternal.js";
import { secretsRouter } from "./routes/secrets.js";
import { vaultRouter } from "./routes/vault.js";
import { auditRouter } from "./routes/audit.js";
import { usageRouter } from "./routes/usage.js";
import { templatesRouter } from "./routes/templates.js";
import { basesRouter } from "./routes/bases.js";
import { backupsRouter } from "./routes/backups.js";
import { backupDestinationsRouter } from "./routes/backupDestinations.js";
import { adminRouter } from "./routes/admin.js";
import { integrationsRouter } from "./routes/integrations.js";
import { integrationsOauthRouter } from "./routes/integrationsOauth.js";
import { workspaceRouter } from "./routes/workspace.js";
import { pipelinesRouter } from "./routes/pipelines.js";
import { emailProvidersRouter } from "./routes/emailProviders.js";
import { emailLogsRouter } from "./routes/emailLogs.js";
import { notebooksRouter } from "./routes/notebooks.js";
import { notesRouter } from "./routes/notes.js";
import { resourcesRouter } from "./routes/resources.js";
import { repositoriesRouter } from "./routes/repositories.js";
import { repositoryContentRouter } from "./routes/repositoryContent.js";
import { financeRouter } from "./routes/finance.js";
import { cardExpensesRouter } from "./routes/cardExpenses.js";
import { contractsRouter } from "./routes/contracts.js";
import { signaturesRouter } from "./routes/signatures.js";
import { publicSignaturesRouter, publicSigningSecurityHeaders } from "./routes/publicSignatures.js";
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
import { unsubscribeRouter } from "./routes/unsubscribe.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { openapiRouter } from "./routes/openapi.js";
import { homeRouter } from "./routes/home.js";
import { searchRouter } from "./routes/search.js";
import { systemHealthRouter } from "./routes/systemHealth.js";
import { pushRouter } from "./routes/push.js";
import { browserSessionsRouter } from "./routes/browserSessions.js";
import { browserRpcRouter } from "./routes/browserRpc.js";
import { memberBrowserBridgeRouter } from "./routes/memberBrowserBridge.js";
import { memberBrowsersRouter } from "./routes/memberBrowsers.js";
import { bootBrowserSessionSweeper } from "./services/browserSessions.js";
import { tagsRouter } from "./routes/tags.js";
import { backfillLegacyResourceTags, backfillTagColors } from "./services/tags.js";
import { requireTrustedOrigin, securityHeaders } from "./middleware/httpSecurity.js";
import {
  secureSessionCookies,
  validateRuntimeDependencies,
  validateRuntimeSecurity,
} from "./services/runtimeSecurity.js";
import { installOutboundNetworkPolicy } from "./services/outboundNetworkPolicy.js";
import { bootPublicUrl } from "./services/publicUrl.js";
import { bootDurableChatTurnRecovery } from "./services/durableChatTurns.js";
import { bootSignatureExpirySweeper } from "./services/signing.js";
import { getEffectiveInstanceSecrets } from "./lib/instanceSecrets.js";
import { bindInstanceSecretsToDatabase } from "./services/instanceSecretsDatabase.js";
import { rejectAiBrowserAppRequests } from "./services/browserRequestBoundary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Resolve or create durable self-host secrets before migrations, timers or
  // any other subsystem can observe placeholder credentials.
  getEffectiveInstanceSecrets();
  installOutboundNetworkPolicy();
  await initDb();
  await bindInstanceSecretsToDatabase();
  await bootPublicUrl();
  validateRuntimeSecurity();
  await validateRuntimeDependencies();
  await bootRealtimeBridge();
  await backfillTagColors();
  await backfillLegacyResourceTags();
  // Never leave the install without an operator: if the master-admin column
  // was just added on an existing DB, promote the earliest user so the Admin
  // dashboard stays reachable. No-op once any master admin exists.
  await ensureBootstrapMasterAdmin();
  await bootCron();
  await bootDurableChatTurnRecovery();
  await bootSignatureExpirySweeper();
  await bootBackups();
  await bootPipelineCron();
  await bootRecurringInvoices();
  // A provider's context window moves when an operator re-launches their server
  // with a different max length — re-ask every three hours so the agent loop
  // budgets against today's number rather than the one saved with the key.
  bootContextWindowRefresh();
  // Revenue (M32): the sequence and signal heartbeats, plus the two callbacks
  // that let them reach the agent runtime. Synchronous — it only installs
  // timers; the first pass of each runs on its own interval.
  bootRevenue();
  // Calendar + Meetings (M44): the calendar sync heartbeat, and the callback
  // that lets a meeting transcript reach an AI Employee for its write-up.
  bootMeetings();
  bootBrowserSessionSweeper();
  // Long-polling Telegram listener — one outbound HTTP loop per Telegram
  // Connection. Fires asynchronously so a slow Telegram API doesn't gate
  // server startup; failures inside each loop are logged + retried.
  void bootTelegramListeners().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[telegram] boot failed:", err);
  });
  // Email section (M25): Gmail sync heartbeat + handover queue recovery.
  // The heartbeat's first pass runs async, so like Telegram it never gates
  // startup; handover recovery is a quick DB sweep.
  bootMailSync();
  void bootMailAutomationQueue().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mail] inbound automation queue failed to start:", err);
  });
  void bootMailHandovers().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mail] handover boot failed:", err);
  });
  void bootMailDraftSendQueue().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mail] draft-send queue boot failed:", err);
  });
  void finalizeInterruptedAssistantTurns().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mail] assistant turn recovery failed:", err);
  });

  const app = express();
  if (config.security.trustedProxyHops > 0) {
    app.set("trust proxy", config.security.trustedProxyHops);
  }
  app.use(securityHeaders);
  // Signing URLs contain a bearer credential. Install these protections before
  // body parsing as well, so parser errors cannot emit a cacheable response.
  app.use("/api/sign", publicSigningSecurityHeaders);
  app.use("/sign", publicSigningSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));

  // Recipient signing links are bearer-token authenticated and intentionally
  // session-free. Mount before cookie sessions and the trusted-origin gate so
  // email clients that omit Origin can view, consent, complete, or decline.
  app.use("/api/sign", publicSignaturesRouter);

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
  app.use("/api/internal/mcp", mcpInternalRouter);

  // Built-in browser-tool RPC. The (now stripped down) `browser` MCP child
  // posts every tool call here; the App owns Chromium so it persists
  // across MCP child spawns / chat turns.
  app.use("/api/internal/browser/sessions/:id", browserRpcRouter);

  // Public OpenAPI document + Swagger UI. Mounted before the session router
  // so the docs page works for unauthenticated visitors — the spec describes
  // shapes, not data, and any documented endpoint still enforces its own auth.
  app.use("/api", openapiRouter);

  // Public machine endpoints above authenticate with one-shot or bearer
  // tokens. Everything below also rejects cross-origin browser mutations.
  app.use(requireTrustedOrigin);

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
  // session cookie itself.
  app.use("/api/auth/sso", ssoRouter);
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
  app.use("/api/companies/:cid", skillsRouter);
  app.use("/api/companies/:cid", toolCatalogueRouter);
  app.use("/api/companies/:cid", routinesRouter);
  // Org chart + Handoffs (Phase B). Teams group employees; Handoffs are
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
  // Company-wide quick search — entity results for the ⌘K palette.
  app.use("/api/companies/:cid", searchRouter);
  // System Health — company-scoped roll-up of failed/stuck/skipped runs,
  // missing models, stale approvals, email + integration failures.
  app.use("/api/companies/:cid", systemHealthRouter);
  // Projects + Todos (task manager). See ROADMAP.md V1 backlog.
  app.use("/api/companies/:cid", projectsRouter);
  // Per-user notification feed — bell + panel in the top bar.
  app.use("/api/companies/:cid", notificationsRouter);
  // Bases (Airtable-style workspaces) — companion to Tasks.
  app.use("/api/companies/:cid", basesRouter);
  app.use("/api/companies/:cid", approvalsRouter);
  // The Decision Stack — questions an AI employee raised for a human to answer.
  // Member-level, unlike the admin-gated approvals inbox above it.
  app.use("/api/companies/:cid", decisionsRouter);
  app.use("/api/companies/:cid", secretsRouter);
  app.use("/api/companies/:cid/vault", vaultRouter);
  app.use("/api/companies/:cid", auditRouter);
  app.use("/api/companies/:cid", usageRouter);
  // Per-user programmatic API keys (M14). Bearer tokens minted here
  // authenticate as the calling user, scoped to this company only.
  app.use("/api/companies/:cid", apiKeysRouter);
  // Per-employee models — an employee can register several and keep one
  // active. See ROADMAP §5.
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

  // Workspace chat — Slack-style channels, DMs, file uploads, reactions.
  // Mounted under companies so `requireCompanyMember` gates every route.
  app.use("/api/companies/:cid/workspace", workspaceRouter);

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
  // Postmark) and the append-only delivery log used by Settings → Email
  // and Settings → Email Logs.
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

  // Client. Dev: mount Vite as middleware so API + UI share one port and
  // HMR still works. Prod: serve the built SPA from dist/client.
  // Layout-wise, dev __dirname=App/server → clientDir=App/client;
  // prod __dirname=App/dist/server → clientDir=App/dist/client.
  const clientDir = path.resolve(__dirname, "..", "client");
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    // configFile must be explicit: Vite's auto-discovery looks in `root`
    // (client/), but our vite.config.ts lives one level up. Without it,
    // @vitejs/plugin-react is never applied and JSX crashes at runtime.
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, "..", "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.use(errorHandler);

  // Wrap Express in an http.Server so we can attach the WebSocket upgrade
  // listener for the realtime workspace-chat surface. REST and WS share the
  // same port so `/api/*` and `/api/ws` proxy identically in dev and prod.
  const server = http.createServer(app);
  attachRealtime(server);
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[genosyn] listening on :${config.port}`);
  });
  installShutdownHandlers(server);
}

/**
 * Stop cleanly on the signals a container runtime actually sends.
 *
 * The reason this exists is browser state. An employee's cookies and
 * localStorage are only written to disk when a browser session is torn down
 * deliberately, so before this handler every `docker stop` and every
 * `genosyn update` killed live browsers mid-flight and silently rolled that
 * employee back to the previous snapshot — a sign-in performed two minutes
 * before an update was simply gone.
 *
 * `docker stop` allows ten seconds before it escalates to `SIGKILL`, so the
 * flush is bounded well inside that: losing a few sessions' cookies is bad, but
 * hanging until the runtime shoots us loses all of them *and* leaves the
 * container in a worse state.
 */
function installShutdownHandlers(server: http.Server): void {
  const FLUSH_BUDGET_MS = 6_000;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    // A second Ctrl-C should not start a second flush over the first.
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[genosyn] ${signal} received — flushing browser sessions`);

    // Stop taking new connections immediately; in-flight requests finish or
    // die with the process, which is the same outcome they had before.
    server.close();

    const flush = (async () => {
      const { releaseAllPages } = await import("./services/browserChromium.js");
      const count = await releaseAllPages("shutdown");
      if (count > 0) {
        // eslint-disable-next-line no-console
        console.log(`[genosyn] flushed ${count} browser session(s)`);
      }
    })();

    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_BUDGET_MS);
      // Don't let the budget timer itself hold the event loop open.
      timer.unref?.();
    });

    void Promise.race([flush, budget])
      .catch(() => {
        // A failed flush still exits — see the doc comment.
      })
      .then(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[genosyn] fatal", err);
  process.exit(1);
});
