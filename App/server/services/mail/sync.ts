import { AppDataSource } from "../../db/datasource.js";
import { config } from "../../../config.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { broadcastToCompany } from "../realtime.js";
import { dispatchEmailReceived } from "../pipelines/events.js";
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
import { withSchedulerLease } from "../schedulerLeases.js";

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
 * persists the resumable `backfillPageToken` cursor after EVERY page, so a
 * failure — caught error or hard crash — costs at most one page of re-fetch
 * and the import always picks up where it left off. While a backfill is in
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
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

/** Accounts with a sync pass in flight — the per-account mutex. */
const syncing = new Set<string>();
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
      const intervalMs = config.mail.syncIntervalSec * 1000;
      for (const account of accounts) {
        const since = account.lastSyncAt ? now - account.lastSyncAt.getTime() : Infinity;
        const backfilling = !account.backfilledAt;
        const due =
          account.status === "error" ? since >= ERROR_RETRY_MS : backfilling || since >= intervalMs;
        if (!due) continue;
        void syncAccountNow(account.id).catch((err) => {
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

/**
 * Run one sync pass for an account. Serializes per account; a call that
 * finds a pass already in flight returns without doing anything.
 */
export async function syncAccountNow(accountId: string): Promise<void> {
  await withSchedulerLease(`mail-account:${accountId}`, 5 * 60_000, async () => {
    await syncAccountNowUnlocked(accountId);
  });
}

async function syncAccountNowUnlocked(accountId: string): Promise<void> {
  if (syncing.has(accountId)) return;
  syncing.add(accountId);
  try {
    const repo = AppDataSource.getRepository(MailAccount);
    const account = await repo.findOneBy({ id: accountId });
    if (!account) {
      // Deleted mid-import — drop the in-memory walk bookkeeping.
      backfillStartedAt.delete(accountId);
      backfillSeenIds.delete(accountId);
      return;
    }
    if (account.status === "paused") return;

    let changed = false;
    try {
      const token = await accessTokenForAccount(account);
      await syncLabels(account, await listLabels(token));

      if (!account.backfilledAt) {
        // Mid-import, new mail must not wait for the walk to finish: the
        // history cursor was anchored before the first page, so replaying it
        // here surfaces (and rule-triages) everything that arrived since —
        // even when the full import takes hours.
        if (account.historyId) {
          await incremental(account, token, { duringBackfill: true });
        }
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
    // A completed no-op pass still advances lastSyncAt. Always notify clients
    // so their sync loader can finish and the visible timestamp stays honest.
    broadcastToCompany(account.companyId, {
      type: "mail.updated",
      accountId: account.id,
      threadsChanged: changed,
    });
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
    backfillSeenIds.set(account.id, new Set());
  }

  const repo = AppDataSource.getRepository(MailAccount);
  const startedAt = Date.now();
  let processed = 0;
  let pageToken = account.backfillPageToken || undefined;

  for (;;) {
    const page = await listThreads(token, {
      q,
      maxResults: 100,
      pageToken,
    });
    const seen = backfillSeenIds.get(account.id);
    for (const t of page.threads) {
      try {
        const full = await getThread(token, t.id, "full");
        for (const gm of full.messages ?? []) {
          await upsertGmailMessage(account, gm);
          seen?.add(gm.id);
        }
        await recomputeThread(account, t.id);
      } catch (err) {
        // A thread can be deleted between the listing and our fetch. Skip it
        // rather than erroring the whole import — the completion prune (or
        // the history log) squares the mirror.
        if (err instanceof GmailApiError && err.status === 404) continue;
        throw err;
      }
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
      backfillSeenIds.delete(account.id);
      account.backfilledAt = new Date();
      account.backfillPageToken = "";
      return;
    }
    // Persist the cursor (and the running count) after every page, so even a
    // hard crash mid-pass resumes from the last completed page instead of
    // re-importing the whole pass. A targeted UPDATE (not save) so a human
    // pausing the account mid-import can't be clobbered by our stale copy.
    // Broadcast so the sidebar counter ticks.
    await repo.update(account.id, {
      backfillPageToken: account.backfillPageToken,
      backfilledCount: account.backfilledCount,
    });
    broadcastToCompany(account.companyId, {
      type: "mail.updated",
      accountId: account.id,
    });
    if (processed >= threadsBudget || Date.now() - startedAt >= msBudget) {
      // Yield; the next heartbeat resumes from the persisted cursor.
      return;
    }
  }
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
async function pruneStaleAfterBackfill(account: MailAccount): Promise<void> {
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
  const newInbound: Array<{ messageRowId: string }> = [];
  const seen = backfillSeenIds.get(account.id);

  for (const [gmailMessageId, gmailThreadId] of touched) {
    if (deleted.has(gmailMessageId)) {
      const t = await deleteMessageByGmailId(account, gmailMessageId);
      if (t) threadsToRecompute.add(t);
      continue;
    }
    // Any non-deleted history event proves the message still exists — count
    // it for the in-flight import's completion prune.
    seen?.add(gmailMessageId);
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
      // New to the mirror — fetch the full message. Rules fire only for
      // genuine arrivals (a messagesAdded record): a label change on a
      // message the mirror hasn't imported yet is old mail, not new.
      const gm = await getMessage(token, gmailMessageId, "full");
      const { row, created } = await upsertGmailMessage(account, gm);
      threadsToRecompute.add(gm.threadId);
      const inbound =
        created &&
        added.has(gmailMessageId) &&
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
    void dispatchEmailReceived(messageRowId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[pipelines] email event failed for message ${messageRowId}:`, err);
    });
  }
  return true;
}
