import { AppDataSource } from "../../db/datasource.js";
import { config } from "../../../config.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { broadcastToCompany } from "../realtime.js";
import { accessTokenForAccount } from "./accounts.js";
import {
  GmailApiError,
  getMessage,
  getProfile,
  getThread,
  listHistory,
  listLabels,
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
import { runRulesForNewMessage } from "./rules.js";

/**
 * Two-way Gmail sync, poll-based.
 *
 * Same heartbeat shape as `services/cron.ts`: one 30s interval, a `ticking`
 * guard against overlapping passes, and per-account due-time bookkeeping on
 * the row (`lastSyncAt` + config.mail.syncIntervalSec). Polling (rather than
 * Gmail Pub/Sub push) is deliberate — self-hosted installs get inbox sync
 * with zero Google Cloud ceremony beyond the OAuth client they already made.
 *
 * The first import walks the ENTIRE mailbox, newest first, so every message
 * is mirrored and searchable locally without ever opening Gmail. A large
 * mailbox spans many heartbeat passes: each pass imports a bounded batch and
 * persists a resumable `backfillPageToken` cursor, so the import survives
 * restarts and never blocks or floods the API. While a backfill is in
 * flight the account is always "due", so passes run back-to-back until the
 * mailbox is fully imported. After that, every pass replays the Gmail
 * history log from the stored `historyId` cursor; when Gmail expires the
 * cursor (404), we fall back to a fresh backfill.
 *
 * Inbound rules fire only on messages that are (a) new to the mirror,
 * (b) not drafts, and (c) not sent by the account itself — and never during
 * a backfill, so connecting a mailbox can't storm an AI employee with a
 * mailbox's worth of historical handovers.
 */

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** How long an errored account waits before the heartbeat retries it. A
 * transient blip must not park a mailbox forever, but a permanently-broken
 * one shouldn't be hammered every 30s either. */
const ERROR_RETRY_MS = 5 * 60 * 1000;
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

/** Accounts with a sync pass in flight — the per-account mutex. */
const syncing = new Set<string>();
/** When the in-flight full backfill for an account started, so a completed
 * backfill can prune messages deleted upstream (rows not re-touched). Kept
 * in memory: a restart mid-backfill simply skips that round's prune. */
const backfillStartedAt = new Map<string, Date>();

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
    const repo = AppDataSource.getRepository(MailAccount);
    // Include errored accounts so a transient failure self-heals — they are
    // just retried on a slower cadence than healthy ones.
    const accounts = await repo.find({
      where: [{ status: "active" }, { status: "error" }],
    });
    const now = Date.now();
    const intervalMs = config.mail.syncIntervalSec * 1000;
    for (const account of accounts) {
      const since = account.lastSyncAt ? now - account.lastSyncAt.getTime() : Infinity;
      // A mailbox still importing its history is always due — passes run
      // back-to-back until the whole mailbox is mirrored.
      const backfilling = !account.backfilledAt;
      const due =
        account.status === "error"
          ? since >= ERROR_RETRY_MS
          : backfilling || since >= intervalMs;
      if (!due) continue;
      // Fire in the background; the `syncing` set stops overlap per account.
      void syncAccountNow(account.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[mail] sync failed for account ${account.id}:`, err);
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mail] heartbeat pass failed:", err);
  } finally {
    ticking = false;
  }
}

/**
 * Run one sync pass for an account. Serializes per account; a call that
 * finds a pass already in flight returns without doing anything.
 */
export async function syncAccountNow(accountId: string): Promise<void> {
  if (syncing.has(accountId)) return;
  syncing.add(accountId);
  try {
    const repo = AppDataSource.getRepository(MailAccount);
    const account = await repo.findOneBy({ id: accountId });
    if (!account || account.status === "paused") return;

    let changed = false;
    try {
      const token = await accessTokenForAccount(account);
      await syncLabels(account, await listLabels(token));

      if (!account.backfilledAt) {
        await backfillPass(account, token);
        changed = true;
      } else {
        changed = await incremental(account, token);
      }
      account.status = "active";
      account.statusMessage = "";
    } catch (err) {
      account.status = "error";
      account.statusMessage = err instanceof Error ? err.message : String(err);
      changed = true;
    }
    account.lastSyncAt = new Date();
    await repo.save(account);
    if (changed) {
      broadcastToCompany(account.companyId, {
        type: "mail.updated",
        accountId: account.id,
      });
    }
  } finally {
    syncing.delete(accountId);
  }
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
 * persists the page cursor, and yields; the heartbeat resumes it. When the
 * listing is exhausted, `backfilledAt` is stamped and any locally-mirrored
 * message not re-touched by the import is pruned (handles a re-backfill
 * after the history cursor expired).
 */
async function backfillPass(account: MailAccount, token: string): Promise<void> {
  const threadsBudget = config.mail.backfillThreadsPerPass;
  const msBudget = config.mail.backfillPassSeconds * 1000;
  const q = config.mail.backfillDays > 0 ? `newer_than:${config.mail.backfillDays}d` : undefined;

  if (!account.historyId && !account.backfillPageToken) {
    // First pass of a fresh import — anchor the incremental cursor first.
    const profile = await getProfile(token);
    account.historyId = profile.historyId;
    backfillStartedAt.set(account.id, new Date());
  }
  if (!backfillStartedAt.has(account.id)) {
    // Resuming after a restart — approximate the epoch so the prune stays safe
    // (only rows older than any pass in this import get removed on completion).
    backfillStartedAt.set(account.id, account.createdAt);
  }

  const startedAt = Date.now();
  let processed = 0;
  let pageToken = account.backfillPageToken || undefined;

  for (;;) {
    const page = await listThreads(token, {
      q,
      maxResults: 100,
      pageToken,
    });
    for (const t of page.threads) {
      const full = await getThread(token, t.id, "full");
      for (const gm of full.messages ?? []) {
        await upsertGmailMessage(account, gm);
      }
      await recomputeThread(account, t.id);
      processed += 1;
      account.backfilledCount += 1;
    }
    pageToken = page.nextPageToken;
    account.backfillPageToken = pageToken ?? "";
    if (!pageToken || page.threads.length === 0) {
      // Import complete.
      await refreshDraftIds(account, token);
      await pruneStaleAfterBackfill(account);
      backfillStartedAt.delete(account.id);
      account.backfilledAt = new Date();
      account.backfillPageToken = "";
      return;
    }
    if (processed >= threadsBudget || Date.now() - startedAt >= msBudget) {
      // Yield; the next heartbeat resumes from the persisted cursor.
      return;
    }
  }
}

/**
 * After a full import completes, drop locally-mirrored messages that the
 * import did not re-touch — those were deleted or hard-trashed upstream
 * during a gap (e.g. while the history cursor had expired). A full backfill
 * upserts (and so bumps `updatedAt` on) every still-existing message, so
 * anything older than the import's start is gone from Gmail.
 */
async function pruneStaleAfterBackfill(account: MailAccount): Promise<void> {
  const startedAt = backfillStartedAt.get(account.id);
  if (!startedAt) return;
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const stale = await msgRepo
    .createQueryBuilder("m")
    .select(["m.id", "m.gmailThreadId"])
    .where("m.accountId = :aid", { aid: account.id })
    .andWhere("m.updatedAt < :start", { start: startedAt })
    .getMany();
  if (stale.length === 0) return;
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
 */
async function incremental(
  account: MailAccount,
  token: string,
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
      records = records.concat(page.history ?? []);
      if (page.historyId) latestHistoryId = page.historyId;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      // Cursor expired — Gmail only keeps history for about a week. Re-anchor
      // by resetting to a fresh full import; the resumable backfill re-runs on
      // the following heartbeats and its completion prune drops anything
      // deleted upstream during the gap. Existing rows stay put meanwhile, so
      // the mailbox never blanks out.
      account.historyId = "";
      account.backfilledAt = null;
      account.backfillPageToken = "";
      return true;
    }
    throw err;
  }

  if (records.length === 0) {
    account.historyId = latestHistoryId;
    return false;
  }

  // Fold the log into per-message outcomes so each message is fetched once
  // no matter how many records touched it.
  const deleted = new Set<string>();
  const touched = new Map<string, string>(); // gmailMessageId → gmailThreadId
  for (const rec of records) {
    for (const d of rec.messagesDeleted ?? []) {
      deleted.add(d.message.id);
      touched.set(d.message.id, d.message.threadId);
    }
    for (const group of [rec.messagesAdded, rec.labelsAdded, rec.labelsRemoved]) {
      for (const item of group ?? []) {
        if (deleted.has(item.message.id)) continue;
        touched.set(item.message.id, item.message.threadId);
      }
    }
  }

  const threadsToRecompute = new Set<string>();
  const newInbound: Array<{ messageRowId: string }> = [];

  for (const [gmailMessageId, gmailThreadId] of touched) {
    if (deleted.has(gmailMessageId)) {
      const t = await deleteMessageByGmailId(account, gmailMessageId);
      if (t) threadsToRecompute.add(t);
      continue;
    }
    try {
      const mirrored = await AppDataSource.getRepository(MailMessage).existsBy({
        accountId: account.id,
        gmailMessageId,
      });
      if (mirrored) {
        // Label-only change: the body is already local, a minimal fetch is enough.
        const minimal = await getMessage(token, gmailMessageId, "minimal");
        await updateMessageLabels(account, gmailMessageId, minimal.labelIds ?? []);
        threadsToRecompute.add(gmailThreadId);
        continue;
      }
      // New to the mirror — fetch the full message.
      const gm = await getMessage(token, gmailMessageId, "full");
      const { row, created } = await upsertGmailMessage(account, gm);
      threadsToRecompute.add(gm.threadId);
      const inbound =
        created &&
        !columnHasLabel(row.labelIds, "DRAFT") &&
        !columnHasLabel(row.labelIds, "SENT") &&
        row.fromEmail.toLowerCase() !== account.address.toLowerCase();
      if (inbound) newInbound.push({ messageRowId: row.id });
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
  await refreshDraftIds(account, token);
  account.historyId = latestHistoryId;

  // Rules run after the mirror is consistent so a handover prompt renders
  // the thread the employee will actually see.
  for (const { messageRowId } of newInbound) {
    await runRulesForNewMessage(account, messageRowId);
  }
  return true;
}
