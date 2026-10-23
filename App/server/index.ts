import "reflect-metadata";
import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { AppDataSource, initDb } from "./db/datasource.js";
import { ensureBootstrapMasterAdmin } from "./services/masterAdmin.js";
import { bootCron } from "./services/cron.js";
import { startRunPauseWatcher } from "./services/runPause.js";
import { bootStanddowns } from "./services/standdowns.js";
import { bootBackups } from "./services/backups.js";
import { bootBackupVerification } from "./services/backupVerification.js";
import { bootPipelineCron } from "./services/pipelines/index.js";
import { bootContextWindowRefresh } from "./services/agent/contextWindowRefresh.js";
import { bootRecurringInvoices } from "./services/recurringInvoices.js";
import { bootRevenue } from "./services/revenue/boot.js";
import { bootMeetings } from "./services/meetings/boot.js";
import { bootChatSurfaceWorkers } from "./services/chatSurfaces/index.js";
import { bootMailSync } from "./services/mail/sync.js";
import { bootMailAddressIndex } from "./services/mail/addressIndex.js";
import { bootMailSearchIndex } from "./services/mail/searchIndex.js";
import { bootMailHandovers } from "./services/mail/handovers.js";
import { bootMailDraftSendQueue } from "./services/mail/draftSendQueue.js";
import { bootMailAutomationQueue } from "./services/mail/automationQueue.js";
import { finalizeInterruptedTldrQuestionTurns } from "./services/tldrQuestions.js";
import { attachRealtime, bootRealtimeBridge } from "./services/realtime.js";
import { errorHandler, installProcessErrorHandlers, logRedactedError } from "./middleware/error.js";
import { operationCatalogue } from "./services/companyMcp/appCatalogue.js";
import { bootProactiveDefaults } from "./services/proactive/defaults.js";
import { finalizeInterruptedAskAiTurns } from "./services/askAi/assistant.js";
import { bootRoutineTriggers } from "./services/routineTriggers.js";
import { bootPhone } from "./services/phone/sync.js";
import { appShellFallback, careersPagesRouter } from "./routes/careersSite.js";
import { bootCareersHosts } from "./services/recruiting/domains.js";
import { bootScreeningQueue } from "./services/recruiting/screeningQueue.js";
import { bootBrowserSessionSweeper } from "./services/browserSessions.js";
import { bootBrowserRecordingRetention } from "./services/browserRecordingRetention.js";
import { bootExchangeRateFeed } from "./services/exchangeRateFeed.js";
import { bootVaultSourceSync } from "./services/vaultSourceSync.js";
import { bootBankingSync } from "./services/bankingSync.js";
import { backfillLegacyResourceTags, backfillTagColors } from "./services/tags.js";
import {
  resolveCodingExecutionMode,
  validateRuntimeDependencies,
  validateRuntimeSecurity,
} from "./services/runtimeSecurity.js";
import { installOutboundNetworkPolicy } from "./services/outboundNetworkPolicy.js";
import { bootPublicUrl } from "./services/publicUrl.js";
import { bootCustomJavaScript } from "./services/customJavaScript.js";
import { bootRuntimeSettings, importLegacyConfigOverrides } from "./services/runtimeSettings.js";
import { bootAuthFlowStateSweeper, stopAuthFlowStateSweeper } from "./services/authFlowCleanup.js";
import { bootDurableChatTurnRecovery } from "./services/durableChatTurns.js";
import { bootSignatureExpirySweeper } from "./services/signing.js";
import { getEffectiveInstanceSecrets } from "./lib/instanceSecrets.js";
import { bindInstanceSecretsToDatabase } from "./services/instanceSecretsDatabase.js";
import { backfillRetiredIntegrationsIntoVault } from "./services/retiredIntegrationVaultBackfill.js";
import { matchCardCategoriesToBooks } from "./services/cardCategoryRepair.js";
import { createApp } from "./app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // First, so nothing that follows can print a raw error object. Node's
  // default handler would dump the whole thing — bound SQL parameters and all
  // — and log retention makes that unfixable after the fact.
  installProcessErrorHandlers();
  // Resolve or create durable self-host secrets before migrations, timers or
  // any other subsystem can observe placeholder credentials.
  getEffectiveInstanceSecrets();
  installOutboundNetworkPolicy();
  await initDb();
  await bindInstanceSecretsToDatabase();
  await bootAuthFlowStateSweeper();
  await bootPublicUrl();
  await bootCustomJavaScript();
  // An install upgrading from an old-shape config.ts (or a Kubernetes overlay
  // that still renders one) carries the operational blocks this build reads
  // from the database instead. Move them into their AppSetting rows once, so
  // the upgrade preserves behavior, before anything reads a runtime setting.
  await importLegacyConfigOverrides();
  await bootRuntimeSettings();
  // The standdown cache before the scheduler: a heartbeat that ran with an
  // empty cache would dispatch work a human had already stopped.
  await bootStanddowns();
  // Narrow a retired execution mode to `disabled` before validation reads it,
  // and before any tool registry, Run, or repository clone does.
  resolveCodingExecutionMode();
  validateRuntimeSecurity();
  await validateRuntimeDependencies();
  await bootRealtimeBridge();
  await backfillTagColors();
  await backfillLegacyResourceTags();
  // Never leave the install without an operator: if the master-admin column
  // was just added on an existing DB, promote the earliest user so the Admin
  // dashboard stays reachable. No-op once any master admin exists.
  await ensureBootstrapMasterAdmin();
  // Connectors retired from the catalog leave their credential sealed inside
  // a row nothing can read any more. Move it into the Vault, where a human
  // can still reveal it, before dropping the dead Connection. Runs after the
  // key ring is bound and validated, which is why it is not a migration.
  await backfillRetiredIntegrationsIntoVault();
  // Card purchases Entry review moved before Banking became the one place
  // their category changes: Banking shows the category their books hold.
  // Purchases split across several categories wait for a person on Banking.
  await matchCardCategoriesToBooks();
  await bootProactiveDefaults();
  // Recruiting: which custom domains serve a careers site, and the queue of
  // Applications waiting for their AI screen (resumed after a restart).
  await bootCareersHosts();
  bootScreeningQueue();
  await bootCron();
  // `genosyn upgrade` asks the running server to pause its Routine Runs before
  // it restarts. Started after boot recovery cleared any stale request.
  startRunPauseWatcher();
  // M54: Routine event Triggers subscribe to the live-sync flush. Registered
  // here rather than imported by resourceEvents so the low-level module stays
  // out of the runner's dependency graph.
  bootRoutineTriggers();
  await bootDurableChatTurnRecovery();
  await bootSignatureExpirySweeper();
  await bootBackups();
  // Daily verification that every backup the schedule promised is really there.
  bootBackupVerification();
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
  // Deletes Routine browser recordings past the window set at Admin → Runtime
  // → Browser. The first pass runs in the background, never gating startup.
  bootBrowserRecordingRetention();
  // The ECB's daily reference rates for companies with automatic exchange
  // rates on: a pass shortly after boot, then every three hours.
  bootExchangeRateFeed();
  bootVaultSourceSync();
  // Banking: every connected bank account and card syncs on its own, at the
  // interval set at Admin → Runtime → Bank sync. The first pass is within a
  // minute, so accounts catch up on whatever posted while the server was down.
  bootBankingSync();
  // External chat surfaces (M59) — the transports that dial out and hold a
  // connection open: one long poll per Telegram Connection, one Socket Mode
  // WebSocket per Slack Connection, each owned by a scheduler lease so two
  // replicas never answer the same message twice. Microsoft Teams and WhatsApp
  // arrive over the webhook router instead and start nothing here. Fires
  // asynchronously so a slow Telegram or Slack API doesn't gate server
  // startup; failures inside each loop are logged + retried.
  void bootChatSurfaceWorkers().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[chat-surface] boot failed:", err);
  });
  // Phone numbers: fetch the texts Twilio cannot push to this install, and
  // re-point numbers' webhooks when the public URL changes. Also registers the
  // automatic text reply, so it must run before any webhook can arrive.
  bootPhone();
  // Email section (M25): Gmail sync heartbeat + handover queue recovery.
  // The heartbeat's first pass runs async, so like the chat surfaces it never
  // gates startup; handover recovery is a quick DB sweep.
  bootMailSync();
  // Address index behind the Customer page's Emails tab; works through mail
  // mirrored before it existed in bounded chunks, then keeps up.
  bootMailAddressIndex();
  // Full-text index behind mail search (SQLite): built in the background, and
  // search scans as before until it is ready.
  bootMailSearchIndex();
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
  void finalizeInterruptedAskAiTurns().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[ask-ai] turn recovery failed:", err);
  });
  void finalizeInterruptedTldrQuestionTurns().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[tldr:question] turn recovery failed:", err);
  });

  // Every API route, mounted in order — see app.ts.
  const app = createApp();

  // Client. Dev: mount Vite as middleware so API + UI share one port and
  // HMR still works. Prod: serve the built SPA from dist/client.
  // Layout-wise, dev __dirname=App/server → clientDir=App/client;
  // prod __dirname=App/dist/server → clientDir=App/dist/client.
  const clientDir = path.resolve(__dirname, "..", "client");
  const isDev = process.env.NODE_ENV !== "production";

  type DevServer = Awaited<ReturnType<typeof import("vite")["createServer"]>>;
  let vite: DevServer | null = null;
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    // configFile must be explicit: Vite's auto-discovery looks in `root`
    // (client/), but our vite.config.ts lives one level up. Without it,
    // @vitejs/plugin-react is never applied and JSX crashes at runtime.
    vite = await createViteServer({
      configFile: path.resolve(__dirname, "..", "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  // The careers site's pages, before the App shell: its own small bundle
  // (`client/careers.html`), with each page's head and data filled in on the
  // server so link previews and job search engines read the real page.
  const careersTemplatePath = path.join(clientDir, "careers.html");
  let careersTemplate: string | null = null;
  app.use(
    careersPagesRouter({
      isDev,
      loadTemplate: async (url) => {
        if (vite) {
          return vite.transformIndexHtml(url, await fs.promises.readFile(careersTemplatePath, "utf8"));
        }
        careersTemplate ??= await fs.promises.readFile(careersTemplatePath, "utf8");
        return careersTemplate;
      },
    }),
  );

  if (vite) {
    app.use(vite.middlewares);
  } else if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api).*/, appShellFallback(path.join(clientDir, "index.html")));
  }

  app.use(errorHandler);

  // Build the API reference, and the Genosyn MCP server's operations from it,
  // before taking traffic: the first build walks the whole router stack
  // synchronously, and would otherwise stall the first request that needs it.
  try {
    operationCatalogue(app);
  } catch (err) {
    logRedactedError("[mcp] could not build the operation catalogue", err);
  }

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
 * The reason this exists is live browser state and meeting audio. An
 * employee's cookies and localStorage are only written to disk when a browser
 * session is torn down deliberately, while a notetaker's WebM needs its final
 * trailer before the process exits. Without this handler, `docker stop` or
 * `genosyn update` can lose a recent sign-in or the call captured so far.
 *
 * `docker stop` allows ten seconds before it escalates to `SIGKILL`, so the
 * flush is bounded well inside that: losing a few sessions' cookies is bad, but
 * hanging until the runtime shoots us loses all of them *and* leaves the
 * container in a worse state.
 *
 * Running Routine Runs are paused first, not cut off: each stops its model
 * turn and goes back to the queue with its transcript and progress, and the
 * next process continues it (`services/runPause.ts`). Each is marked before
 * it is asked, so one that cannot pause before the process exits is resumed
 * by recovery — on the next boot or on another replica — instead of failing.
 */
function installShutdownHandlers(server: http.Server): void {
  const FLUSH_BUDGET_MS = 6_000;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    stopAuthFlowStateSweeper();
    // A second Ctrl-C should not start a second flush over the first.
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[genosyn] ${signal} received — flushing live sessions`);

    // Stop taking new connections immediately; in-flight requests finish or
    // die with the process, which is the same outcome they had before.
    server.close();

    const flush = (async () => {
      const pausedRuns = pauseRoutineRunsForShutdown(FLUSH_BUDGET_MS - 1_500);
      const [{ releaseAllPages }, { shutdownMeetingNotetakers }] = await Promise.all([
        import("./services/browserChromium.js"),
        import("./services/meetings/recorder.js"),
      ]);
      const [browserCount, notetakerCount] = await Promise.all([
        releaseAllPages("shutdown"),
        shutdownMeetingNotetakers(
          "The App is restarting; the notetaker saved the recording captured so far.",
          FLUSH_BUDGET_MS - 500,
        ),
      ]);
      if (browserCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[genosyn] flushed ${browserCount} browser session(s)`);
      }
      if (notetakerCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[genosyn] finalised ${notetakerCount} meeting recording(s)`);
      }
      const runs = await pausedRuns;
      if (runs.asked > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[genosyn] paused ${runs.asked - runs.stillRunning} running Routine Run(s) to continue after the restart` +
            (runs.stillRunning ? `; ${runs.stillRunning} did not pause in time` : ""),
        );
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
      // Closing the SQLite handle checkpoints the write-ahead log back into
      // `app.sqlite`, so a stopped install is one self-contained file again.
      // Exiting without it loses nothing — the next open replays the log.
      .then(() => (AppDataSource.isInitialized ? AppDataSource.destroy() : undefined))
      .catch(() => {})
      .then(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Stop claiming Routine work and pause what is running, within `budgetMs`.
 * Never throws: a shutdown that cannot pause still shuts down, and boot
 * recovery deals with whatever was left running.
 */
async function pauseRoutineRunsForShutdown(
  budgetMs: number,
): Promise<{ asked: number; stillRunning: number }> {
  try {
    const [{ stopRoutineQueue }, { markRunsForRestart, pauseLocalRuns, pausableRunIds }] =
      await Promise.all([import("./services/routineQueue.js"), import("./services/runPause.js")]);
    stopRoutineQueue();
    const runIds = pausableRunIds();
    if (runIds.length === 0 || !AppDataSource.isInitialized) {
      return { asked: 0, stillRunning: 0 };
    }
    await markRunsForRestart(runIds).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[genosyn] could not mark running Routine Runs for the restart:", error);
    });
    return await pauseLocalRuns({ graceMs: 0, reason: "restart" }, { timeoutMs: budgetMs });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[genosyn] could not pause running Routine Runs:", error);
    return { asked: 0, stillRunning: 0 };
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[genosyn] fatal", err);
  process.exit(1);
});
