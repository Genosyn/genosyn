import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { listLongRunningAdapters, getChatSurfaceAdapter } from "./adapters.js";
import { handleInboundTurn, logSurfaceError } from "./inbound.js";
import type { ChatSurfaceProviderId } from "./types.js";

/**
 * Lifecycle for the chat surfaces that hold an outbound connection open —
 * Telegram's long poll and Slack's Socket Mode.
 *
 * Webhook surfaces (Microsoft Teams, WhatsApp) start nothing and never appear
 * here: their inbound path is an HTTP route, so there is no loop to own.
 *
 * Ownership is a {@link withSchedulerLease} claim per Connection. Two replicas
 * polling one Telegram bot is a 409 from Telegram and two Slack sockets is two
 * answers to one question, so exactly one process may hold each. A replica
 * that loses the race sleeps and retries, which is also how failover works
 * when the holder dies: the lease expires and the next attempt wins it.
 */

type Worker = {
  connectionId: string;
  provider: ChatSurfaceProviderId;
  cancel(): void;
  finished: Promise<void>;
};

/** First pause after a transport ends — a revoked token must not become a spin. */
const ERROR_BACKOFF_MS = 5_000;
/**
 * Ceiling on that pause.
 *
 * A transport can end immediately and keep ending immediately: a Slack
 * Connection saved without an app-level token has no Socket Mode to open, and
 * a revoked bot token fails its first call every time. Retrying either of them
 * every five seconds forever is a loop that costs an outbound request per tick
 * and tells nobody anything. Doubling up to five minutes keeps a genuine blip
 * recovering in seconds while a misconfiguration settles into something
 * cheap — and neither case has to wait it out, because saving the Connection
 * calls {@link refreshChatSurfaceWorker}, which replaces the worker outright.
 */
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * A transport that stayed up this long was working, whatever ended it, so the
 * next failure starts over at the short pause instead of inheriting the
 * backoff from an unrelated one hours ago.
 */
const HEALTHY_RUN_MS = 60_000;
/** How often we look for Connections created by another replica. */
const DISCOVERY_INTERVAL_MS = 30_000;
const LEASE_TTL_MS = 90_000;

const WORKERS = new Map<string, Worker>();
let discoveryTimer: NodeJS.Timeout | null = null;

/** Start a loop for every long-running chat-surface Connection. */
export async function bootChatSurfaceWorkers(): Promise<void> {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = setInterval(() => {
    void discoverConnections();
  }, DISCOVERY_INTERVAL_MS);
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
  await discoverConnections();
}

async function discoverConnections(): Promise<void> {
  const providers = listLongRunningAdapters().map((a) => a.provider);
  if (providers.length === 0) return;
  try {
    const conns = await AppDataSource.getRepository(IntegrationConnection).find();
    for (const conn of conns) {
      if (!(providers as string[]).includes(conn.provider)) continue;
      startWorker(conn.id, conn.provider as ChatSurfaceProviderId);
    }
  } catch (err) {
    logSurfaceError("chat-surface", undefined, "connection discovery failed", err);
  }
}

/**
 * Re-evaluate one Connection: start, stop, or replace its loop. Idempotent,
 * and called from the integrations service on every create/edit/delete plus
 * from the grant routes, so a freshly granted employee starts answering
 * without a restart.
 */
export async function refreshChatSurfaceWorker(
  connectionId: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  const existing = WORKERS.get(connectionId);
  if (existing) {
    existing.cancel();
    WORKERS.delete(connectionId);
    await existing.finished.catch(() => {});
  }
  if (opts.deleted) return;
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  if (!conn) return;
  const adapter = getChatSurfaceAdapter(conn.provider);
  if (!adapter?.run) return;
  startWorker(conn.id, adapter.provider);
}

function startWorker(connectionId: string, provider: ChatSurfaceProviderId): void {
  if (WORKERS.has(connectionId)) return;
  const adapter = getChatSurfaceAdapter(provider);
  if (!adapter?.run) return;
  let cancelled = false;
  const worker: Worker = {
    connectionId,
    provider,
    cancel() {
      cancelled = true;
    },
    finished: Promise.resolve(),
  };
  worker.finished = runOwnedLoop(connectionId, provider, () => cancelled).finally(() => {
    if (WORKERS.get(connectionId) === worker) WORKERS.delete(connectionId);
  });
  WORKERS.set(connectionId, worker);
}

async function runOwnedLoop(
  connectionId: string,
  provider: ChatSurfaceProviderId,
  isCancelled: () => boolean,
): Promise<void> {
  const adapter = getChatSurfaceAdapter(provider);
  if (!adapter?.run) return;
  const run = adapter.run;
  let backoffMs = ERROR_BACKOFF_MS;
  for (;;) {
    if (isCancelled()) return;
    // A Connection that has been deleted has no transport to hold open, and
    // nothing else will ever stop this worker: discovery only starts loops,
    // and `refreshChatSurfaceWorker` is not called for a company being deleted
    // wholesale. Checking here is what makes the loop finite.
    const stillExists = await connectionExists(connectionId);
    if (stillExists === false) return;

    const startedAt = Date.now();
    // A null return means another replica holds the lease; anything else means
    // our own loop ended, which happens on cancel or a fatal transport error.
    // All three want the same thing next — wait, then try to own it again —
    // so there is deliberately nothing to branch on here.
    await withSchedulerLease(
      `chat-surface:${provider}:${connectionId}`,
      LEASE_TTL_MS,
      async (lease) => {
        try {
          // The transport is cancelled by either of two things, and the second
          // is the one that is easy to forget: losing the lease. A renewal can
          // fail while this process is otherwise healthy — a database blip is
          // enough — and the lease then passes to another replica that starts
          // its own poll. Two pollers on one Telegram token is a 409 and two
          // Slack sockets is two answers to one question, so a fence that is
          // handed to us and not read is the same as no fence at all.
          await run({
            connectionId,
            isCancelled: () => isCancelled() || !lease.isHeld(),
            deliver: handleInboundTurn,
          });
        } catch (err) {
          logSurfaceError(provider, connectionId, "transport loop failed", err);
        }
      },
    );
    if (isCancelled()) return;

    backoffMs =
      Date.now() - startedAt >= HEALTHY_RUN_MS
        ? ERROR_BACKOFF_MS
        : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    await sleepCancellable(backoffMs, isCancelled);
  }
}

/**
 * Does this Connection still exist? `null` when the question could not be
 * answered — a database blip must not be read as a deletion and retire a
 * working bot.
 */
async function connectionExists(connectionId: string): Promise<boolean | null> {
  try {
    return (
      (await AppDataSource.getRepository(IntegrationConnection).countBy({ id: connectionId })) > 0
    );
  } catch {
    return null;
  }
}

/** Stop every loop. Used by tests and by an orderly shutdown. */
export async function stopChatSurfaceWorkers(): Promise<void> {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  const workers = [...WORKERS.values()];
  WORKERS.clear();
  for (const worker of workers) worker.cancel();
  await Promise.all(workers.map((w) => w.finished.catch(() => {})));
}

/** Connection ids with a live loop in this process. Exposed for tests. */
export function activeChatSurfaceWorkerIds(): string[] {
  return [...WORKERS.keys()].sort();
}

export function sleepCancellable(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    if (typeof timer.unref === "function") timer.unref();
  });
}
