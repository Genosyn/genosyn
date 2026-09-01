import crypto from "node:crypto";
import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { broadcastToCompany } from "../realtime.js";
import { getMailSettings } from "../runtimeSettings.js";
import { accessTokenForAccount, deleteMailAccount, purgeMailAccountMirror } from "./accounts.js";
import {
  GmailApiError,
  gmailSyncErrorMessage,
  getMessage,
  getProfile,
  getThread,
  isGmailTimeoutError,
  isRetryableGmailReadError,
  listHistory,
  listThreads,
  type GmailHistoryRecord,
} from "./gmailClient.js";
import {
  columnHasLabel,
  deleteMessageByGmailId,
  recomputeThread,
  refreshDraftIds,
  syncLabels,
  updateMessageLabels,
  upsertGmailMessage,
} from "./store.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { linkAccountMessagesSafely } from "../revenue/mailLink.js";
import { withDraftSendDisconnectFence } from "./draftSendQueue.js";
import { enqueueInboundAutomation, waitForMailAutomation } from "./automationQueue.js";
import { listFolders, withImap } from "./imapClient.js";
import {
  imapBackfillPass,
  imapIncrementalPass,
  imapSyncErrorMessage,
  parseImapCursor,
  type ImapPassContext,
} from "./imapSync.js";
import { imapConfigForAccount, mailboxForAccount } from "./mailbox/index.js";
import type { Mailbox } from "./mailbox/types.js";

/**
 * Two-way mailbox sync, poll-based.
 *
 * This file owns the parts that are true of every mailbox — the heartbeat, the
 * account state machine, the distributed lease, the cancellation fence, and
 * the terminal bookkeeping — plus the Gmail engine itself. The IMAP engine
 * lives in `imapSync.ts` and is dispatched from {@link executeAccountSync};
 * `imapSync.ts` explains why the two reading strategies are separate rather
 * than one parameterised engine.
 *
 * Same heartbeat shape as `services/cron.ts`: one 30s interval, a `ticking`
 * guard against overlapping passes, and per-account due-time bookkeeping on
 * the row (`lastSyncAt` + the Admin → Runtime mail interval). Polling (rather than
 * Gmail Pub/Sub push) is deliberate — self-hosted installs get inbox sync
 * with zero Google Cloud ceremony beyond the OAuth client they already made.
 *
 * The first import walks the ENTIRE mailbox, newest first, so every message
 * is mirrored and searchable locally without ever opening Gmail. A large
 * mailbox spans many heartbeat passes: each pass imports a bounded batch and
 * persists the resumable `backfillPageToken` worklist after every thread, so
 * a failure — caught error or hard crash — resumes at the exact remaining
 * conversation. While a backfill is in
 * flight the account is always "due", so passes run back-to-back until the
 * mailbox is fully imported; each of those passes ALSO replays the Gmail
 * history log first, so mail that arrives mid-import shows up (and gets
 * rule-triaged) within a heartbeat instead of waiting for the walk to
 * finish. After the import, every pass replays the history log from the
 * stored `historyId` cursor; when Gmail expires the cursor (404), we fall
 * back to a fresh backfill.
 *
 * Inbound rules fire only on messages that are (a) new to the mirror,
 * (b) not drafts, and (c) not sent by the account itself — and never from
 * the backfill walk itself, so connecting a mailbox can't storm an AI
 * employee with a mailbox's worth of historical handovers. Genuinely new
 * arrivals reach rules through the history replay only, whose cursor is
 * anchored at connect time.
 */

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** How long an errored account waits before the heartbeat retries it. A
 * transient blip must not park a mailbox forever, but a permanently-broken
 * one shouldn't be hammered every 30s either. */
const ERROR_RETRY_MS = 5 * 60 * 1000;
const ACCOUNT_LEASE_MS = 5 * 60 * 1000;
/** Smaller Gmail pages let the wall-clock backfill budget take effect between
 * requests. Per-thread cursor checkpoints below mean this does not cost
 * restart progress. */
const BACKFILL_PAGE_SIZE = 25;
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

/** In-process coalescing. Postgres instances additionally share the scheduler
 * lease; the durable attempt id lets a restarted process resume an accepted
 * request rather than leaving the UI waiting forever. */
const syncRuns = new Map<string, { attemptId: string; promise: Promise<void> }>();
/** When the in-flight full backfill for an account started, so a completed
 * backfill can prune messages deleted upstream. Kept in memory: a restart
 * mid-backfill simply skips that round's prune. */
const backfillStartedAt = new Map<string, Date>();
/**
 * Every Gmail message id the in-flight import has PROVEN still exists
 * upstream — touched by the walk or the mid-import history replay. The
 * completion prune deletes only mirrored rows absent from this set: an
 * `updatedAt` heuristic is not enough, because TypeORM skips the UPDATE
 * (and the @UpdateDateColumn bump) entirely when a re-save assigns values
 * identical to the row, so on a re-backfill the unchanged majority of the
 * mailbox never gets "re-touched". Seeded only when a fresh import anchors
 * in this process; missing after a restart, which skips that round's prune.
 */
const backfillSeenIds = new Map<string, Set<string>>();

export function bootMailSync(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
  // Immediate pass so a just-rebooted server catches up without waiting.
  void tick();
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withSchedulerLease("mail-sync", HEARTBEAT_INTERVAL_MS * 3, async () => {
      const repo = AppDataSource.getRepository(MailAccount);
      const accounts = await repo.find({
        where: [{ status: "active" }, { status: "error" }],
      });
      const now = Date.now();
      const intervalMs = getMailSettings().syncIntervalSec * 1000;
      for (const account of accounts) {
        const retryReference = account.syncFinishedAt ?? account.lastSyncAt;
        const dueReference = account.status === "error" ? retryReference : account.lastSyncAt;
        const since = dueReference ? now - dueReference.getTime() : Infinity;
        const backfilling = !account.backfilledAt;
        const recovering = account.syncState === "queued" || account.syncState === "running";
        const due =
          recovering ||
          (account.status === "error"
            ? since >= ERROR_RETRY_MS
            : backfilling || since >= intervalMs);
        if (!due) continue;
        void queueAccountSync(account.id).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[mail] sync failed for account ${account.id}:`, err);
        });
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mail] heartbeat pass failed:", err);
  } finally {
    ticking = false;
  }
}

export type MailSyncRequest = {
  attemptId: string;
  state: MailAccount["syncState"];
  coalesced: boolean;
};

export class MailSyncPausedError extends Error {
  constructor() {
    super("Resume this mailbox before syncing.");
    this.name = "MailSyncPausedError";
  }
}

class MailSyncLeaseLostError extends Error {
  constructor() {
    super("Mailbox sync lease was lost");
    this.name = "MailSyncLeaseLostError";
  }
}

class MailSyncCancelledError extends Error {
  constructor() {
    super("Mailbox sync was cancelled");
    this.name = "MailSyncCancelledError";
  }
}

/**
 * Durably accept one sync request and launch it in the background. Calls made
 * while a pass is queued/running coalesce onto its attempt id. A process that
 * restarts sees the persisted attempt and tries the same id again; the shared
 * scheduler lease decides which Postgres instance owns the actual work.
 */
export async function queueAccountSync(accountId: string): Promise<MailSyncRequest> {
  const repo = AppDataSource.getRepository(MailAccount);
  const local = syncRuns.get(accountId);
  if (local) {
    const current = await repo.findOneBy({ id: accountId });
    if (!current) throw new Error("Mail account not found");
    if (current.status === "paused") throw new MailSyncPausedError();
    if (
      current.syncAttemptId === local.attemptId &&
      (current.syncState === "queued" || current.syncState === "running")
    ) {
      return { attemptId: local.attemptId, state: current.syncState, coalesced: true };
    }
    // Pause terminates the durable attempt immediately. A quick Resume waits
    // for that stale local worker to observe the fence, then queues a new id.
    await local.promise;
    return queueAccountSync(accountId);
  }

  let account = await repo.findOneBy({ id: accountId });
  if (!account) throw new Error("Mail account not found");
  if (account.status === "paused") throw new MailSyncPausedError();

  if (
    (account.syncState === "queued" || account.syncState === "running") &&
    account.syncAttemptId
  ) {
    launchAccountSync(account.id, account.syncAttemptId);
    return {
      attemptId: account.syncAttemptId,
      state: account.syncState,
      coalesced: true,
    };
  }

  const attemptId = crypto.randomUUID();
  const acceptedAt = new Date();
  const claim = await repo
    .createQueryBuilder()
    .update()
    .set({
      syncState: "queued",
      syncAttemptId: attemptId,
      syncStartedAt: acceptedAt,
      syncFinishedAt: null,
    })
    .where("id = :accountId", { accountId })
    .andWhere("status != :paused", { paused: "paused" })
    .andWhere('"syncState" NOT IN (:...busy)', { busy: ["queued", "running"] })
    .execute();

  if ((claim.affected ?? 0) === 0) {
    account = await repo.findOneBy({ id: accountId });
    if (!account) throw new Error("Mail account not found");
    if (account.status === "paused") throw new MailSyncPausedError();
    if (
      account.syncAttemptId &&
      (account.syncState === "queued" || account.syncState === "running")
    ) {
      launchAccountSync(account.id, account.syncAttemptId);
      return {
        attemptId: account.syncAttemptId,
        state: account.syncState,
        coalesced: true,
      };
    }
    if (account.syncAttemptId) {
      return {
        attemptId: account.syncAttemptId,
        state: account.syncState,
        coalesced: true,
      };
    }
    throw new Error("Mailbox sync could not be queued. Please try again.");
  }

  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId,
    threadsChanged: false,
  });
  launchAccountSync(accountId, attemptId);
  return { attemptId, state: "queued", coalesced: false };
}

/** Backwards-compatible name used by connect/resume call sites. */
export const syncAccountNow = queueAccountSync;

/** Test/coordination seam for destructive account operations. The worker's
 * own final deletion fence is authoritative; this simply lets callers wait
 * until that cleanup is complete. */
export async function waitForAccountSync(accountId: string): Promise<void> {
  await syncRuns.get(accountId)?.promise;
}

/** Stop an account, drain the current worker, then delete under the same
 * distributed lease used by sync. No late Gmail response can start rules,
 * pipelines, or recreate mirror rows after Disconnect returns. */
export async function disconnectMailAccount(account: MailAccount): Promise<void> {
  await withDraftSendDisconnectFence(account.id, async () => {
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      status: "paused",
      statusMessage: "",
    });
    await waitForAccountSync(account.id);
    await waitForMailAutomation(account.id);

    const deadline = Date.now() + 45_000;
    for (;;) {
      const deleted = await withSchedulerLease(
        `mail-automation-account:${account.id}`,
        ACCOUNT_LEASE_MS,
        async () => {
          return withSchedulerLease(`mail-account:${account.id}`, ACCOUNT_LEASE_MS, async () => {
            await deleteMailAccount(account);
            return true;
          });
        },
      );
      if (deleted) return;
      if (Date.now() >= deadline) {
        throw new Error("Mailbox is still finishing a sync. Please try Disconnect again shortly.");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  });
}

function launchAccountSync(accountId: string, attemptId: string): void {
  const current = syncRuns.get(accountId);
  if (current) return;
  const promise = executeAccountSync(accountId, attemptId)
    .catch(async (error) => {
      if (error instanceof MailSyncLeaseLostError) {
        // Keep the durable attempt running. A later heartbeat (or another app
        // instance) resumes the same id after it acquires the lease.
        return;
      }
      // The executor normally persists its own terminal failure. This catches
      // only infrastructure failures outside that envelope.
      const account = await AppDataSource.getRepository(MailAccount)
        .findOneBy({
          id: accountId,
          syncAttemptId: attemptId,
        })
        .catch(() => null);
      if (account) {
        await finishSyncAttempt(account, attemptId, {
          state: "failed",
          changed: false,
          errorMessage: gmailSyncErrorMessage(error),
        }).catch(() => {});
      }
      // eslint-disable-next-line no-console
      console.error(`[mail] sync attempt ${attemptId} failed:`, error);
    })
    .finally(() => {
      if (syncRuns.get(accountId)?.attemptId === attemptId) syncRuns.delete(accountId);
    });
  syncRuns.set(accountId, { attemptId, promise });
}

async function executeAccountSync(accountId: string, attemptId: string): Promise<void> {
  const leased = await withSchedulerLease(
    `mail-account:${accountId}`,
    ACCOUNT_LEASE_MS,
    async (lease) => {
      const repo = AppDataSource.getRepository(MailAccount);
      const assertWritable = async (): Promise<void> => {
        if (!lease.isHeld()) throw new MailSyncLeaseLostError();
        const current = await repo.findOne({
          where: { id: accountId, syncAttemptId: attemptId },
          select: { id: true, status: true, syncState: true },
        });
        if (!current || current.status === "paused" || current.syncState !== "running") {
          throw new MailSyncCancelledError();
        }
      };
      const running = await repo
        .createQueryBuilder()
        .update()
        .set({ syncState: "running", syncStartedAt: new Date(), syncFinishedAt: null })
        .where("id = :accountId", { accountId })
        .andWhere('"syncAttemptId" = :attemptId', { attemptId })
        .andWhere('"syncState" IN (:...startable)', { startable: ["queued", "running"] })
        .andWhere('"status" != :paused', { paused: "paused" })
        .execute();
      if ((running.affected ?? 0) === 0) return;

      const account = await repo.findOneBy({ id: accountId, syncAttemptId: attemptId });
      if (!account) return;
      if (account.status === "paused") {
        await finishSyncAttempt(account, attemptId, {
          state: "failed",
          changed: false,
          errorMessage: "",
        });
        return;
      }

      broadcastToCompany(account.companyId, {
        type: "mail.updated",
        accountId,
        threadsChanged: false,
      });

      // Stamped before fetching so revenue linking can find exactly what this
      // pass mirrored.
      const passStartedAt = new Date();
      let changed = false;
      try {
        const mailbox = await mailboxForAccount(account);
        const labels = await mailbox.listLabels();
        await assertWritable();
        await syncLabels(account, labels);

        if (account.provider === "imap") {
          changed = await imapPass(account, mailbox, assertWritable);
        } else if (!account.backfilledAt) {
          const token = await accessTokenForAccount(account);
          if (account.historyId) {
            await incremental(account, token, mailbox, assertWritable, { duringBackfill: true });
          }
          await backfillPass(account, token, mailbox, assertWritable);
          changed = true;
        } else {
          const token = await accessTokenForAccount(account);
          changed = await incremental(account, token, mailbox, assertWritable);
          changed = (await hydrateDeferredBodies(account, token, assertWritable)) || changed;
        }
        // Revenue enrichment is best-effort but remains inside the account's
        // distributed lease. Otherwise two app instances can race the same
        // read-before-insert activity dedupe after back-to-back sync passes.
        await assertWritable();
        if (changed) await linkAccountMessagesSafely(account, passStartedAt);
        await assertWritable();
        await finishSyncAttempt(account, attemptId, { state: "succeeded", changed });
      } catch (error) {
        if (error instanceof MailSyncLeaseLostError) throw error;
        if (error instanceof MailSyncCancelledError) {
          await finishSyncAttempt(account, attemptId, {
            state: "failed",
            changed,
            errorMessage: "",
          });
          return;
        }
        // The mirror may already contain messages fetched earlier in this
        // attempt. Link that partial window before returning an error so a
        // later retry's newer timestamp cannot strand those messages outside
        // Revenue timelines.
        if (changed) await linkAccountMessagesSafely(account, passStartedAt);
        await finishSyncAttempt(account, attemptId, {
          state: "failed",
          changed,
          errorMessage:
            account.provider === "imap"
              ? imapSyncErrorMessage(error)
              : gmailSyncErrorMessage(error),
        });
      }
    },
  );

  // `null` means another Postgres process owns the attempt's lease. Leave the
  // durable state alone; that owner will publish the terminal result. After a
  // crash, a later heartbeat retries and acquires the expired lease.
  if (leased === null) return;
}

/**
 * One IMAP pass: backfill while the mailbox is still importing, incremental
 * once it is done.
 *
 * The folder list is read once per pass and handed to both engines, because
 * every step needs it and a `LIST` per step would be a round trip to re-learn
 * something that changes when somebody creates a folder.
 */
async function imapPass(
  account: MailAccount,
  mailbox: Mailbox,
  assertWritable: () => Promise<void>,
): Promise<boolean> {
  const config = await imapConfigForAccount(account);
  const run = <T>(work: (client: import("imapflow").ImapFlow) => Promise<T>): Promise<T> =>
    withImap(account.id, config, work);
  const folders = await run((client) => listFolders(client));
  await assertWritable();
  const ctx: ImapPassContext = {
    account,
    config,
    assertWritable,
    run,
    folders,
    persistCursor: (cursor) => checkpointImapCursor(account, cursor, assertWritable),
  };

  if (!account.backfilledAt) {
    const complete = await imapBackfillPass(ctx);
    if (complete) {
      account.backfilledAt = new Date();
      account.backfillPageToken = "";
      // The draft handles have to exist before the Drafts queue can show
      // anything — see the note below.
      await refreshDraftIds(account, mailbox, assertWritable);
    }
    return true;
  }

  const changed = await imapIncrementalPass(ctx);
  // Map the Drafts folder onto the mirror every pass, exactly as the Gmail
  // engine does. Without it a draft somebody wrote in Apple Mail or their
  // webmail arrives here labelled DRAFT but with no handle, and the Drafts
  // queue — which asks for a non-empty handle — never shows it, so it cannot
  // be reviewed, edited, sent or discarded. The reverse matters too: a draft
  // discarded elsewhere keeps a stale handle until this clears it.
  await refreshDraftIds(account, mailbox, assertWritable);
  // A folder the server renumbered is handed back to the backfill, and that
  // has to keep working on a mailbox that finished importing months ago:
  // without this the folder's cursor would sit at `done: false` forever, every
  // mirrored row in it pointing at a UID that now addresses somebody else's
  // message. `backfilledAt` says the mailbox has been imported once, not that
  // no folder will ever need reading again.
  const unfinished = unfinishedFolders(account, folders);
  if (unfinished.length === 0) return changed;
  await imapBackfillPass({ ...ctx, folders: unfinished });
  return true;
}

/** Folders whose cursor says they still owe the mirror a read. */
function unfinishedFolders(
  account: MailAccount,
  folders: import("./imapModel.js").ImapFolder[],
): import("./imapModel.js").ImapFolder[] {
  const cursor = parseImapCursor(account.syncCursor);
  return folders.filter((folder) => cursor.folders[folder.path]?.done === false);
}

/**
 * Persist the IMAP cursor under the same guard the Gmail backfill checkpoint
 * uses: only the attempt that owns the row, only while it is still running,
 * and never over a mailbox somebody has just paused.
 */
async function checkpointImapCursor(
  account: MailAccount,
  cursor: string,
  assertWritable: () => Promise<void>,
): Promise<void> {
  await assertWritable();
  account.syncCursor = cursor;
  const checkpoint = await AppDataSource.getRepository(MailAccount)
    .createQueryBuilder()
    .update()
    .set({ syncCursor: cursor })
    .where("id = :accountId", { accountId: account.id })
    .andWhere('"syncAttemptId" = :attemptId', { attemptId: account.syncAttemptId })
    .andWhere('"syncState" = :running', { running: "running" })
    .andWhere('"status" != :paused', { paused: "paused" })
    .execute();
  if ((checkpoint.affected ?? 0) === 0) throw new MailSyncCancelledError();
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });
}

async function finishSyncAttempt(
  account: MailAccount,
  attemptId: string,
  result: {
    state: "succeeded" | "failed";
    changed: boolean;
    errorMessage?: string;
  },
): Promise<void> {
  const repo = AppDataSource.getRepository(MailAccount);
  const current = await repo.findOneBy({ id: account.id });
  if (!current) {
    await purgeMailAccountMirror(account.id);
    return;
  }
  // A Pause→Resume can supersede this attempt while its final async operation
  // is unwinding on another app instance. The mailbox still exists and belongs
  // to the newer attempt, so the stale worker must neither finish it nor purge
  // its mirror as though Disconnect had removed the account.
  if (current.syncAttemptId !== attemptId) return;
  const finishedAt = new Date();
  const terminal = await repo
    .createQueryBuilder()
    .update()
    .set({
      // Backfill checkpoints are persisted as they happen. Incremental
      // cursors, however, advance only on full success; keeping the stored
      // cursor on failure makes the same history events replayable.
      historyId: result.state === "succeeded" ? account.historyId : current.historyId,
      backfilledAt: result.state === "succeeded" ? account.backfilledAt : current.backfilledAt,
      backfillPageToken:
        result.state === "succeeded" ? account.backfillPageToken : current.backfillPageToken,
      backfilledCount:
        result.state === "succeeded" ? account.backfilledCount : current.backfilledCount,
      lastSyncAt: result.state === "succeeded" ? finishedAt : current.lastSyncAt,
      syncState: result.state,
      syncFinishedAt: finishedAt,
    })
    .where("id = :accountId", { accountId: account.id })
    .andWhere('"syncAttemptId" = :attemptId', { attemptId })
    .andWhere('"syncState" = :running', { running: "running" })
    .execute();
  if ((terminal.affected ?? 0) === 0) return;
  // The operator status is a separate control plane. The condition closes
  // the SELECT→UPDATE window: a concurrent Pause either wins before this
  // statement (and blocks it) or lands afterwards (and becomes final).
  await repo
    .createQueryBuilder()
    .update()
    .set({
      status: result.state === "succeeded" ? "active" : "error",
      statusMessage: result.errorMessage ?? "",
    })
    .where("id = :accountId", { accountId: account.id })
    .andWhere('"syncAttemptId" = :attemptId', { attemptId })
    .andWhere('"status" != :paused', { paused: "paused" })
    .execute();
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
    threadsChanged: result.changed,
  });
}

/**
 * One bounded pass of the full-mailbox import.
 *
 * The whole mailbox is walked newest-first across as many passes as it
 * takes. The FIRST pass captures the Gmail history cursor before listing a
 * single thread, so any mail that arrives mid-import lands in the history
 * log and the first incremental pass (after the backfill completes) picks
 * it up — nothing falls in the gap. Each pass imports up to
 * `backfillThreadsPerPass` threads (or runs for `backfillPassSeconds`),
 * persists the remaining-thread worklist, and yields; the heartbeat resumes it. When the
 * listing is exhausted, `backfilledAt` is stamped and any locally-mirrored
 * message not re-touched by the import is pruned (handles a re-backfill
 * after the history cursor expired).
 */
type BackfillCursor = {
  version: 1;
  /** Gmail token for the page represented by `pendingThreadIds`. Empty means
   * the first page. */
  pageToken: string;
  /** Null means the page still needs listing; an array is a durable worklist. */
  pendingThreadIds: string[] | null;
  nextPageToken: string;
  /** Slow threads are held here while healthy later pages continue. */
  deferredThreadIds: string[];
  /** Consecutive transient failures, retained across restarts. */
  threadAttempts: Record<string, number>;
  /** Per-message fallback progress for threads too large to fetch as one
   * response. Each hydrated message is checkpointed across passes. */
  messageWork: Record<
    string,
    { pendingMessageIds: string[]; messageAttempts: Record<string, number> }
  >;
  /** Bodies that repeatedly exceeded the bounded import pass. Their metadata
   * is already usable, while later ordinary sync passes keep attempting the
   * rich body without holding the mailbox backfill open forever. */
  /** Empty `messageId` means even the thread envelope timed out and the whole
   * conversation should be retried opportunistically. */
  hydrationQueue: Array<{ threadId: string; messageId: string; attempts: number }>;
};

function emptyBackfillCursor(): BackfillCursor {
  return {
    version: 1,
    pageToken: "",
    pendingThreadIds: null,
    nextPageToken: "",
    deferredThreadIds: [],
    threadAttempts: {},
    messageWork: {},
    hydrationQueue: [],
  };
}

export function parseBackfillCursor(raw: string): BackfillCursor {
  if (!raw) {
    return emptyBackfillCursor();
  }
  if (!raw.trim().startsWith("{")) {
    // Backwards compatibility with the original plain Gmail page token.
    return { ...emptyBackfillCursor(), pageToken: raw };
  }
  try {
    const value = JSON.parse(raw) as Partial<BackfillCursor>;
    if (value.version !== 1) throw new Error("unsupported cursor version");
    return {
      version: 1,
      pageToken: typeof value.pageToken === "string" ? value.pageToken : "",
      pendingThreadIds: Array.isArray(value.pendingThreadIds)
        ? value.pendingThreadIds.filter((id): id is string => typeof id === "string" && id !== "")
        : null,
      nextPageToken: typeof value.nextPageToken === "string" ? value.nextPageToken : "",
      deferredThreadIds: Array.isArray(value.deferredThreadIds)
        ? value.deferredThreadIds.filter((id): id is string => typeof id === "string" && id !== "")
        : [],
      threadAttempts:
        value.threadAttempts && typeof value.threadAttempts === "object"
          ? Object.fromEntries(
              Object.entries(value.threadAttempts).filter(
                (entry): entry is [string, number] =>
                  entry[0] !== "" && Number.isInteger(entry[1]) && entry[1] > 0,
              ),
            )
          : {},
      messageWork:
        value.messageWork && typeof value.messageWork === "object"
          ? Object.fromEntries(
              Object.entries(value.messageWork).flatMap(([threadId, rawWork]) => {
                if (!threadId || !rawWork || typeof rawWork !== "object") return [];
                const work = rawWork as {
                  pendingMessageIds?: unknown;
                  messageAttempts?: unknown;
                };
                if (!Array.isArray(work.pendingMessageIds)) return [];
                const pendingMessageIds = work.pendingMessageIds.filter(
                  (id): id is string => typeof id === "string" && id !== "",
                );
                const messageAttempts =
                  work.messageAttempts && typeof work.messageAttempts === "object"
                    ? Object.fromEntries(
                        Object.entries(work.messageAttempts).filter(
                          (entry): entry is [string, number] =>
                            entry[0] !== "" && Number.isInteger(entry[1]) && entry[1] > 0,
                        ),
                      )
                    : {};
                return [[threadId, { pendingMessageIds, messageAttempts }]];
              }),
            )
          : {},
      hydrationQueue: Array.isArray(value.hydrationQueue)
        ? value.hydrationQueue.flatMap((rawItem) => {
            if (!rawItem || typeof rawItem !== "object") return [];
            const item = rawItem as {
              threadId?: unknown;
              messageId?: unknown;
              attempts?: unknown;
            };
            if (typeof item.threadId !== "string" || typeof item.messageId !== "string") return [];
            if (!item.threadId) return [];
            return [
              {
                threadId: item.threadId,
                messageId: item.messageId,
                attempts:
                  typeof item.attempts === "number" && Number.isInteger(item.attempts)
                    ? Math.max(0, item.attempts)
                    : 0,
              },
            ];
          })
        : [],
    };
  } catch {
    // Gmail page tokens do not start with `{`. A malformed versioned cursor
    // cannot be sent back to Gmail as a page token; restart the idempotent
    // listing instead of poisoning every future pass with a 400.
    return emptyBackfillCursor();
  }
}

export function serializeBackfillCursor(cursor: BackfillCursor): string {
  return JSON.stringify(cursor);
}

async function checkpointBackfill(
  account: MailAccount,
  cursor: BackfillCursor,
  assertWritable: () => Promise<void>,
): Promise<void> {
  await assertWritable();
  account.backfillPageToken = serializeBackfillCursor(cursor);
  const checkpoint = await AppDataSource.getRepository(MailAccount)
    .createQueryBuilder()
    .update()
    .set({
      historyId: account.historyId,
      backfillPageToken: account.backfillPageToken,
      backfilledCount: account.backfilledCount,
    })
    .where("id = :accountId", { accountId: account.id })
    .andWhere('"syncAttemptId" = :attemptId', { attemptId: account.syncAttemptId })
    .andWhere('"syncState" = :running', { running: "running" })
    .andWhere('"status" != :paused', { paused: "paused" })
    .execute();
  if ((checkpoint.affected ?? 0) === 0) throw new MailSyncCancelledError();
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });
}

async function mirrorBackfillThread(
  account: MailAccount,
  token: string,
  threadId: string,
  cursor: BackfillCursor,
  passDeadline: number,
  assertWritable: () => Promise<void>,
): Promise<{ complete: boolean }> {
  let work = cursor.messageWork[threadId];
  if (!work) {
    try {
      const full = await getThread(token, threadId, "full", {
        maxAttempts: 1,
        timeoutMs: 15_000,
      });
      await assertWritable();
      for (const message of full.messages ?? []) {
        await assertWritable();
        await upsertGmailMessage(account, message);
        backfillSeenIds.get(account.id)?.add(message.id);
      }
      await recomputeThread(account, threadId);
      return { complete: true };
    } catch (error) {
      if (!isGmailTimeoutError(error)) throw error;
    }

    // A large response timed out. Persist its exact message worklist before
    // fetching any bodies; later passes resume inside the conversation.
    const minimal = await getThread(token, threadId, "minimal", {
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    await assertWritable();
    work = {
      pendingMessageIds: (minimal.messages ?? []).map((message) => message.id),
      messageAttempts: {},
    };
    cursor.messageWork[threadId] = work;
    await checkpointBackfill(account, cursor, assertWritable);
  }

  const thisRound = work.pendingMessageIds.length;
  for (let index = 0; index < thisRound && work.pendingMessageIds.length > 0; index += 1) {
    const messageId = work.pendingMessageIds[0];
    try {
      const message = await getMessage(token, messageId, "full", {
        maxAttempts: 1,
        timeoutMs: 10_000,
      });
      await assertWritable();
      await upsertGmailMessage(account, message);
      backfillSeenIds.get(account.id)?.add(message.id);
      work.pendingMessageIds.shift();
      delete work.messageAttempts[messageId];
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        await assertWritable();
        const deletedThreadId = await deleteMessageByGmailId(account, messageId);
        if (deletedThreadId) await recomputeThread(account, deletedThreadId);
        work.pendingMessageIds.shift();
        delete work.messageAttempts[messageId];
        await checkpointBackfill(account, cursor, assertWritable);
        continue;
      }
      if (!isGmailTimeoutError(error)) throw error;
      let metadata;
      try {
        metadata = await getMessage(token, messageId, "metadata", {
          maxAttempts: 1,
          timeoutMs: 8_000,
        });
      } catch (metadataError) {
        if (metadataError instanceof GmailApiError && metadataError.status === 404) {
          await assertWritable();
          const deletedThreadId = await deleteMessageByGmailId(account, messageId);
          if (deletedThreadId) await recomputeThread(account, deletedThreadId);
          work.pendingMessageIds.shift();
          delete work.messageAttempts[messageId];
          await checkpointBackfill(account, cursor, assertWritable);
          continue;
        }
        throw metadataError;
      }
      await assertWritable();
      await upsertGmailMessage(account, metadata, { preserveRichContent: true });
      backfillSeenIds.get(account.id)?.add(metadata.id);
      const attempts = (work.messageAttempts[messageId] ?? 0) + 1;
      if (attempts >= 3) {
        // Headers, labels and snippet are safely mirrored. Move the rich body
        // to an opportunistic queue so one pathological message cannot keep
        // the mailbox unhealthy, while its content is never abandoned.
        if (!cursor.hydrationQueue.some((item) => item.messageId === messageId)) {
          cursor.hydrationQueue.push({ threadId, messageId, attempts });
        }
        work.pendingMessageIds.shift();
        delete work.messageAttempts[messageId];
      } else {
        work.messageAttempts[messageId] = attempts;
        work.pendingMessageIds.push(work.pendingMessageIds.shift()!);
      }
    }
    await checkpointBackfill(account, cursor, assertWritable);
    if (Date.now() >= passDeadline) {
      return { complete: false };
    }
  }

  if (work.pendingMessageIds.length > 0) {
    return { complete: false };
  }
  delete cursor.messageWork[threadId];
  await recomputeThread(account, threadId);
  await checkpointBackfill(account, cursor, assertWritable);
  return { complete: true };
}

async function backfillPass(
  account: MailAccount,
  token: string,
  mailbox: Mailbox,
  assertWritable: () => Promise<void>,
): Promise<void> {
  const mailSettings = getMailSettings();
  const threadsBudget = mailSettings.backfillThreadsPerPass;
  const msBudget = mailSettings.backfillPassSeconds * 1000;
  const q =
    mailSettings.backfillDays > 0 ? `newer_than:${mailSettings.backfillDays}d` : undefined;

  if (!account.historyId && !account.backfillPageToken) {
    // First pass of a fresh import — anchor the incremental cursor first.
    const profile = await getProfile(token);
    await assertWritable();
    account.historyId = profile.historyId;
    backfillStartedAt.set(account.id, new Date());
    backfillSeenIds.set(account.id, new Set());
    // Persist the history anchor before the first Gmail listing. A crash or a
    // timeout on page one must not create a gap for mail arriving mid-import.
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      historyId: account.historyId,
    });
  }

  const startedAt = Date.now();
  const passDeadline = startedAt + msBudget;
  let processed = 0;
  let cursor = parseBackfillCursor(account.backfillPageToken);

  for (;;) {
    if (cursor.pendingThreadIds === null) {
      const page = await listThreads(token, {
        q,
        maxResults: BACKFILL_PAGE_SIZE,
        pageToken: cursor.pageToken || undefined,
      });
      await assertWritable();
      cursor.pendingThreadIds = page.threads.map((thread) => thread.id);
      cursor.nextPageToken = page.nextPageToken ?? "";
      // Persist the page worklist before fetching a body. A hard crash now
      // resumes at the exact remaining thread, not at the start of the page.
      await checkpointBackfill(account, cursor, assertWritable);
    }

    while (cursor.pendingThreadIds.length > 0) {
      const gmailThreadId = cursor.pendingThreadIds[0];
      try {
        const mirrored = await mirrorBackfillThread(
          account,
          token,
          gmailThreadId,
          cursor,
          passDeadline,
          assertWritable,
        );
        if (!mirrored.complete) {
          cursor.pendingThreadIds.shift();
          if (!cursor.deferredThreadIds.includes(gmailThreadId)) {
            cursor.deferredThreadIds.push(gmailThreadId);
          }
          processed += 1;
          await checkpointBackfill(account, cursor, assertWritable);
          if (processed >= threadsBudget || Date.now() >= passDeadline) return;
          continue;
        }
      } catch (err) {
        // A thread can be deleted between the listing and our fetch. Skip it
        // rather than erroring the whole import — the completion prune (or
        // the history log) squares the mirror.
        if (!(err instanceof GmailApiError && err.status === 404)) {
          if (isRetryableGmailReadError(err)) {
            // Isolate one persistently slow conversation while the healthy
            // remainder — including later Gmail pages — continues. The
            // deferred worklist and attempt count survive a restart.
            cursor.pendingThreadIds.shift();
            const attempts = (cursor.threadAttempts[gmailThreadId] ?? 0) + 1;
            if (attempts >= 3) {
              if (!cursor.hydrationQueue.some((item) => item.threadId === gmailThreadId)) {
                cursor.hydrationQueue.push({
                  threadId: gmailThreadId,
                  messageId: "",
                  attempts,
                });
              }
              delete cursor.threadAttempts[gmailThreadId];
              delete cursor.messageWork[gmailThreadId];
              account.backfilledCount += 1;
            } else {
              if (!cursor.deferredThreadIds.includes(gmailThreadId)) {
                cursor.deferredThreadIds.push(gmailThreadId);
              }
              cursor.threadAttempts[gmailThreadId] = attempts;
            }
            processed += 1;
            await checkpointBackfill(account, cursor, assertWritable);
            if (processed >= threadsBudget || Date.now() >= passDeadline) return;
            continue;
          }
          throw err;
        }
        await assertWritable();
        await AppDataSource.getRepository(MailMessage).delete({
          accountId: account.id,
          gmailThreadId,
        });
        await recomputeThread(account, gmailThreadId);
      }
      cursor.pendingThreadIds.shift();
      delete cursor.threadAttempts[gmailThreadId];
      processed += 1;
      account.backfilledCount += 1;
      await checkpointBackfill(account, cursor, assertWritable);
      if (processed >= threadsBudget || Date.now() >= passDeadline) {
        return;
      }
    }

    if (!cursor.nextPageToken) {
      if (cursor.deferredThreadIds.length > 0) {
        cursor.pendingThreadIds = cursor.deferredThreadIds;
        cursor.deferredThreadIds = [];
        await checkpointBackfill(account, cursor, assertWritable);
        // End the pass rather than immediately hammering the same slow
        // conversations. The heartbeat resumes this worklist shortly.
        return;
      }
      // Import complete.
      await refreshDraftIds(account, mailbox, assertWritable);
      await pruneStaleAfterBackfill(account, assertWritable);
      backfillStartedAt.delete(account.id);
      backfillSeenIds.delete(account.id);
      account.backfilledAt = new Date();
      account.backfillPageToken =
        cursor.hydrationQueue.length > 0
          ? serializeBackfillCursor({
              ...cursor,
              pendingThreadIds: [],
              deferredThreadIds: [],
              threadAttempts: {},
              messageWork: {},
            })
          : "";
      return;
    }

    cursor = {
      ...cursor,
      pageToken: cursor.nextPageToken,
      pendingThreadIds: null,
      nextPageToken: "",
    };
    await checkpointBackfill(account, cursor, assertWritable);
  }
}

/** Retry a small number of metadata-only messages after the mailbox is fully
 * usable. Retryable Gmail outages leave the queue intact without turning an
 * otherwise healthy sync red; permanent auth errors still surface normally. */
async function hydrateDeferredBodies(
  account: MailAccount,
  token: string,
  assertWritable: () => Promise<void>,
): Promise<boolean> {
  if (!account.backfillPageToken) return false;
  const cursor = parseBackfillCursor(account.backfillPageToken);
  if (cursor.hydrationQueue.length === 0) {
    account.backfillPageToken = "";
    return false;
  }

  let changed = false;
  const maxThisPass = Math.min(3, cursor.hydrationQueue.length);
  for (let index = 0; index < maxThisPass && cursor.hydrationQueue.length > 0; index += 1) {
    const item = cursor.hydrationQueue[0];
    try {
      if (item.messageId) {
        const message = await getMessage(token, item.messageId, "full", {
          maxAttempts: 1,
          timeoutMs: 10_000,
        });
        await assertWritable();
        await upsertGmailMessage(account, message);
      } else {
        const thread = await getThread(token, item.threadId, "full", {
          maxAttempts: 1,
          timeoutMs: 15_000,
        });
        await assertWritable();
        for (const message of thread.messages ?? []) {
          await assertWritable();
          await upsertGmailMessage(account, message);
        }
      }
      await recomputeThread(account, item.threadId);
      cursor.hydrationQueue.shift();
      changed = true;
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        await assertWritable();
        if (item.messageId) {
          const gmailThreadId = await deleteMessageByGmailId(account, item.messageId);
          if (gmailThreadId) await recomputeThread(account, gmailThreadId);
        } else {
          await AppDataSource.getRepository(MailMessage).delete({
            accountId: account.id,
            gmailThreadId: item.threadId,
          });
          await recomputeThread(account, item.threadId);
        }
        cursor.hydrationQueue.shift();
        changed = true;
      } else if (isRetryableGmailReadError(error)) {
        item.attempts += 1;
        cursor.hydrationQueue.push(cursor.hydrationQueue.shift()!);
        await checkpointBackfill(account, cursor, assertWritable);
        break;
      } else {
        throw error;
      }
    }
    await checkpointBackfill(account, cursor, assertWritable);
  }

  account.backfillPageToken =
    cursor.hydrationQueue.length > 0 ? serializeBackfillCursor(cursor) : "";
  return changed;
}

/**
 * After a full import completes, drop locally-mirrored messages the import
 * did not SEE — those were deleted or hard-trashed upstream during a gap
 * (e.g. while the history cursor had expired). Existence is proven by the
 * in-memory seen-set the walk and the mid-import history replay populate;
 * an `updatedAt < start` guard is kept as well so rows written mid-import
 * by paths outside the seen-set (write-through sends/drafts) can never be
 * pruned. Skipped when the seen-set is missing — a process restart during
 * the walk means it never covered the whole mailbox, and a wrong skip only
 * defers upstream-deletion cleanup, while a wrong prune deletes the mirror.
 */
async function pruneStaleAfterBackfill(
  account: MailAccount,
  assertWritable: () => Promise<void>,
): Promise<void> {
  const startedAt = backfillStartedAt.get(account.id);
  const seen = backfillSeenIds.get(account.id);
  if (!startedAt || !seen) return;
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const candidates = await msgRepo
    .createQueryBuilder("m")
    .select(["m.id", "m.gmailMessageId", "m.gmailThreadId"])
    .where("m.accountId = :aid", { aid: account.id })
    .andWhere("m.updatedAt < :start", { start: startedAt })
    .getMany();
  const stale = candidates.filter((m) => !seen.has(m.gmailMessageId));
  if (stale.length === 0) return;
  await assertWritable();
  const threads = new Set<string>();
  for (const m of stale) {
    await msgRepo.delete({ id: m.id });
    threads.add(m.gmailThreadId);
  }
  for (const gmailThreadId of threads) {
    await recomputeThread(account, gmailThreadId);
  }
}

/**
 * Replay the history log from the stored cursor. Returns whether anything
 * changed locally. On a 404 (cursor expired) the mirror rebuilds itself via
 * a fresh backfill.
 *
 * `duringBackfill` marks the mid-import replay that keeps new mail flowing
 * while the walk is still running. Its only behavioral difference is the
 * expired-cursor path: resetting the backfill cursors there would restart
 * the in-flight import from page one on every expiry, so the replay just
 * skips that pass — the first post-completion incremental hits the same 404
 * and triggers the standard re-anchor + fresh import.
 */
async function incremental(
  account: MailAccount,
  token: string,
  mailbox: Mailbox,
  assertWritable: () => Promise<void>,
  opts: { duringBackfill?: boolean } = {},
): Promise<boolean> {
  let records: GmailHistoryRecord[] = [];
  let latestHistoryId = account.historyId;
  let pageToken: string | undefined;
  try {
    for (;;) {
      const page = await listHistory(token, {
        startHistoryId: account.historyId,
        pageToken,
      });
      await assertWritable();
      records = records.concat(page.history ?? []);
      if (page.historyId) latestHistoryId = page.historyId;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      if (opts.duringBackfill) return false;
      // Cursor expired — Gmail only keeps history for about a week. Re-anchor
      // by resetting to a fresh full import; the resumable backfill re-runs on
      // the following heartbeats and its completion prune drops anything
      // deleted upstream during the gap. Existing rows stay put meanwhile, so
      // the mailbox never blanks out.
      account.historyId = "";
      account.backfilledAt = null;
      account.backfillPageToken = "";
      account.backfilledCount = 0;
      return true;
    }
    throw err;
  }

  if (records.length === 0) {
    account.historyId = latestHistoryId;
    return false;
  }

  // Fold the log into per-message outcomes so each message is fetched once
  // no matter how many records touched it. `added` tracks which ids arrived
  // via a messagesAdded record — the only kind that means "new mail". A
  // label-change record can also reference a message the mirror has never
  // seen (mid-import, or after a cursor gap); ingesting it is right, but
  // treating it as a new arrival would fire rules on old mail.
  const deleted = new Set<string>();
  const added = new Set<string>();
  const touched = new Map<string, string>(); // gmailMessageId → gmailThreadId
  for (const rec of records) {
    for (const d of rec.messagesDeleted ?? []) {
      deleted.add(d.message.id);
      touched.set(d.message.id, d.message.threadId);
    }
    for (const a of rec.messagesAdded ?? []) {
      if (deleted.has(a.message.id)) continue;
      added.add(a.message.id);
      touched.set(a.message.id, a.message.threadId);
    }
    for (const group of [rec.labelsAdded, rec.labelsRemoved]) {
      for (const item of group ?? []) {
        if (deleted.has(item.message.id)) continue;
        touched.set(item.message.id, item.message.threadId);
      }
    }
  }

  const threadsToRecompute = new Set<string>();
  const newInbound: MailMessage[] = [];
  const seen = backfillSeenIds.get(account.id);

  for (const [gmailMessageId, gmailThreadId] of touched) {
    await assertWritable();
    if (deleted.has(gmailMessageId)) {
      const t = await deleteMessageByGmailId(account, gmailMessageId);
      if (t) threadsToRecompute.add(t);
      continue;
    }
    // Any non-deleted history event proves the message still exists — count
    // it for the in-flight import's completion prune.
    seen?.add(gmailMessageId);
    try {
      const mirrored = await AppDataSource.getRepository(MailMessage).findOneBy({
        accountId: account.id,
        gmailMessageId,
      });
      if (mirrored) {
        // Label-only change: the body is already local, a minimal fetch is enough.
        const minimal = await getMessage(token, gmailMessageId, "minimal");
        await assertWritable();
        await updateMessageLabels(account, gmailMessageId, minimal.labelIds ?? []);
        threadsToRecompute.add(gmailThreadId);
        const inbound =
          added.has(gmailMessageId) &&
          !(minimal.labelIds ?? []).includes("DRAFT") &&
          !(minimal.labelIds ?? []).includes("SENT") &&
          mirrored.fromEmail.toLowerCase() !== account.address.toLowerCase();
        // A prior attempt may have mirrored this arrival before a later Gmail
        // read failed. Because the history cursor did not advance, include it
        // again so automation is not silently lost on retry.
        if (inbound) newInbound.push(mirrored);
        continue;
      }
      // New to the mirror — fetch the full message. Rules fire only for
      // genuine arrivals (a messagesAdded record): a label change on a
      // message the mirror hasn't imported yet is old mail, not new.
      const gm = await getMessage(token, gmailMessageId, "full");
      await assertWritable();
      const { row, created } = await upsertGmailMessage(account, gm);
      threadsToRecompute.add(gm.threadId);
      const inbound =
        created &&
        added.has(gmailMessageId) &&
        !columnHasLabel(row.labelIds, "DRAFT") &&
        !columnHasLabel(row.labelIds, "SENT") &&
        row.fromEmail.toLowerCase() !== account.address.toLowerCase();
      if (inbound) newInbound.push(row);
    } catch (err) {
      // A message can vanish between the history record and our fetch
      // (spam purge, hard delete). Drop our copy and move on.
      if (err instanceof GmailApiError && err.status === 404) {
        const t = await deleteMessageByGmailId(account, gmailMessageId);
        if (t) threadsToRecompute.add(t);
        continue;
      }
      throw err;
    }
  }

  for (const gmailThreadId of threadsToRecompute) {
    await recomputeThread(account, gmailThreadId);
  }
  await refreshDraftIds(account, mailbox, assertWritable);
  account.historyId = latestHistoryId;

  // Accept automation into a durable, deduplicated outbox after the mirror is
  // consistent. Slow AI Pipelines run independently and cannot hold inbox
  // freshness (or the Syncing button) open for hours.
  for (const message of newInbound) {
    await assertWritable();
    await enqueueInboundAutomation(message);
  }
  return true;
}
