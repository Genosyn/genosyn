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
import { bootRecurringInvoices } from "./services/recurringInvoices.js";
import { bootTelegramListeners } from "./services/telegramListener.js";
import { bootMailSync } from "./services/mail/sync.js";
import { bootMailHandovers } from "./services/mail/handovers.js";
import { attachRealtime } from "./services/realtime.js";
import { errorHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { ssoRouter } from "./routes/sso.js";
import { twoFactorRouter } from "./routes/twoFactor.js";
import { companiesRouter } from "./routes/companies.js";
import { invitationsRouter } from "./routes/invitations.js";
import { employeesRouter } from "./routes/employees.js";
import { skillsRouter } from "./routes/skills.js";
import { routinesRouter } from "./routes/routines.js";
import { modelsRouter } from "./routes/models.js";
import { employeeSurfaceRouter } from "./routes/employeeSurface.js";
import { projectsRouter } from "./routes/projects.js";
import { approvalsRouter } from "./routes/approvals.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { mcpRouter } from "./routes/mcp.js";
import { mcpConnectRouter } from "./routes/mcpConnect.js";
import { mcpInternalRouter } from "./routes/mcpInternal.js";
import { secretsRouter } from "./routes/secrets.js";
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
import { codeRepositoriesRouter } from "./routes/codeRepositories.js";
import { financeRouter } from "./routes/finance.js";
import { cardExpensesRouter } from "./routes/cardExpenses.js";
import { contractsRouter } from "./routes/contracts.js";
import { exploreRouter } from "./routes/explore.js";
import { notificationsRouter } from "./routes/notifications.js";
import { teamsRouter } from "./routes/teams.js";
import { handoffsRouter } from "./routes/handoffs.js";
import { inboxRouter } from "./routes/inbox.js";
import { mailRouter } from "./routes/mail.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { openapiRouter } from "./routes/openapi.js";
import { homeRouter } from "./routes/home.js";
import { searchRouter } from "./routes/search.js";
import { systemHealthRouter } from "./routes/systemHealth.js";
import { pushRouter } from "./routes/push.js";
import { browserSessionsRouter } from "./routes/browserSessions.js";
import { browserRpcRouter } from "./routes/browserRpc.js";
import { bootBrowserSessionSweeper } from "./services/browserSessions.js";
import { tagsRouter } from "./routes/tags.js";
import { backfillLegacyResourceTags, backfillTagColors } from "./services/tags.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  await initDb();
  await backfillTagColors();
  await backfillLegacyResourceTags();
  // Never leave the install without an operator: if the master-admin column
  // was just added on an existing DB, promote the earliest user so the Admin
  // dashboard stays reachable. No-op once any master admin exists.
  await ensureBootstrapMasterAdmin();
  await bootCron();
  await bootBackups();
  await bootPipelineCron();
  await bootRecurringInvoices();
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
  void bootMailHandovers().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mail] handover boot failed:", err);
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cookieSession({
      name: "genosyn.sid",
      secret: config.sessionSecret,
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: "lax",
    }),
  );

  // Public webhooks (token in URL is the credential). Mounted before auth
  // so session-less POSTs from external systems aren't gated.
  app.use("/api/webhooks", webhooksRouter);

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
  app.use("/api/companies/:cid", secretsRouter);
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
  app.use(
    "/api/companies/:cid/employees/:eid/browser-sessions",
    browserSessionsRouter,
  );

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

  // Code Repositories — provider-agnostic git repos the company adds so
  // granted AI employees can read, commit, and push real code. Checkouts are
  // materialized into the employee cwd before each spawn (services/codeRepos).
  app.use("/api/companies/:cid", codeRepositoriesRouter);

  // Finance (M19 Phase A) — Customers, Products, Tax rates, Invoices.
  // Native invoicing with HTML render + email send via the company's
  // EmailProvider. Ledger / reports / reconciliation come in later phases.
  app.use("/api/companies/:cid", financeRouter);
  app.use("/api/companies/:cid", cardExpensesRouter);

  // Customer contracts — uploaded agreements for the Customers section.
  // Separate router from finance so the Customers section owns its own
  // backend surface; mounted at the same company-scoped base path.
  app.use("/api/companies/:cid", contractsRouter);

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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[genosyn] fatal", err);
  process.exit(1);
});
