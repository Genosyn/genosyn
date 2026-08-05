import { In, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import {
  MailDraftSendBatch,
  type MailDraftSendBatchStatus,
} from "../../db/entities/MailDraftSendBatch.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { recordAudit } from "../audit.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { notifyMailChanged, sendMailDraft } from "./actions.js";

export const MAX_QUEUED_DRAFT_IDS = 2_000;
export const MIN_SEND_DELAY_MS = 60_000;
export const MAX_SEND_DELAY_MS = 120_000;
export const EXPECTED_SEND_DELAY_MS = (MIN_SEND_DELAY_MS + MAX_SEND_DELAY_MS) / 2;

const ACTIVE_STATUSES: MailDraftSendBatchStatus[] = ["queued", "running"];
const DISCOVERY_INTERVAL_MS = 5_000;
const LEASE_TTL_MS = 45_000;

type DraftSendItemStatus = "queued" | "sending" | "sent" | "failed";

type DraftSendItem = {
  draftId: string;
  status: DraftSendItemStatus;
  errorMessage: string;
};

export type DraftSendBatchView = {
  id: string;
  status: MailDraftSendBatchStatus;
  total: number;
  sent: number;
  failed: number;
  remaining: number;
  nextSendAt: string | null;
  estimatedCompletionAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  queuedDraftIds: string[];
  failures: { id: string; reason: string }[];
};

type QueueTiming = {
  now?: () => Date;
  delayMs?: () => number;
};

type ProcessOptions = QueueTiming & {
  sendDraft?: (account: MailAccount, draft: MailMessage) => Promise<MailMessage>;
};

let discoveryTimer: NodeJS.Timeout | null = null;
const activeBatchIds = new Set<string>();
const creatingAccountIds = new Set<string>();
const batchMutationTails = new Map<string, Promise<void>>();

export class DraftSendQueueBusyError extends Error {}

/** Random whole-millisecond pause in the inclusive one-to-two minute range. */
export function randomSendDelayMs(random: () => number = Math.random): number {
  return MIN_SEND_DELAY_MS + Math.floor(random() * (MAX_SEND_DELAY_MS - MIN_SEND_DELAY_MS + 1));
}

function parseItems(value: string): DraftSendItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): DraftSendItem[] => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { draftId?: unknown }).draftId !== "string"
      ) {
        return [];
      }
      const candidate = item as Partial<DraftSendItem>;
      const status: DraftSendItemStatus = ["queued", "sending", "sent", "failed"].includes(
        String(candidate.status),
      )
        ? (candidate.status as DraftSendItemStatus)
        : "queued";
      return [
        {
          draftId: candidate.draftId as string,
          status,
          errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

function itemCounts(items: DraftSendItem[]): { sent: number; failed: number } {
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "sent") sent += 1;
    if (item.status === "failed") failed += 1;
  }
  return { sent, failed };
}

export function serializeDraftSendBatch(
  batch: MailDraftSendBatch,
  now: Date = new Date(),
): DraftSendBatchView {
  const items = parseItems(batch.itemsJson);
  const remaining = Math.max(0, batch.total - batch.sent - batch.failed);
  const estimatedCompletionAt =
    remaining > 0 && batch.nextSendAt
      ? new Date(
          Math.max(now.getTime(), batch.nextSendAt.getTime()) +
            Math.max(0, remaining - 1) * EXPECTED_SEND_DELAY_MS,
        ).toISOString()
      : null;
  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    sent: batch.sent,
    failed: batch.failed,
    remaining,
    nextSendAt: batch.nextSendAt?.toISOString() ?? null,
    estimatedCompletionAt,
    createdAt: batch.createdAt.toISOString(),
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    queuedDraftIds: items
      .filter((item) => item.status === "queued" || item.status === "sending")
      .map((item) => item.draftId),
    failures: items
      .filter((item) => item.status === "failed")
      .map((item) => ({ id: item.draftId, reason: item.errorMessage })),
  };
}

async function latestBatch(
  accountId: string,
  statuses?: MailDraftSendBatchStatus[],
): Promise<MailDraftSendBatch | null> {
  return AppDataSource.getRepository(MailDraftSendBatch).findOne({
    where: statuses?.length ? { accountId, status: In(statuses) } : { accountId },
    order: { createdAt: "DESC" },
  });
}

export async function getLatestDraftSendBatch(
  account: MailAccount,
): Promise<DraftSendBatchView | null> {
  // SQLite timestamps have one-second precision, so a new active batch and the
  // terminal batch before it can tie on `createdAt`. Active work must always
  // win that tie or the client would briefly hide real progress.
  const batch = (await latestBatch(account.id, ACTIVE_STATUSES)) ?? (await latestBatch(account.id));
  return batch ? serializeDraftSendBatch(batch) : null;
}

/** Draft ids already owned by the active queue, used to disable duplicate sends. */
export async function activeDraftQueueIds(accountId: string): Promise<Set<string>> {
  const batch = await latestBatch(accountId, ACTIVE_STATUSES);
  if (!batch) return new Set();
  return new Set(
    parseItems(batch.itemsJson)
      .filter((item) => item.status === "queued" || item.status === "sending")
      .map((item) => item.draftId),
  );
}

function reportBackgroundError(label: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[mail] ${label}:`, error);
}

async function recordAuditSafely(args: Parameters<typeof recordAudit>[0]): Promise<void> {
  try {
    await recordAudit(args);
  } catch (error) {
    reportBackgroundError("could not record draft-send audit", error);
  }
}

async function createDraftSendBatchUnlocked(
  account: MailAccount,
  ids: string[],
  actorUserId: string | null,
  timing: QueueTiming,
): Promise<{ batch: MailDraftSendBatch; added: number }> {
  const activeBatch = await latestBatch(account.id, ACTIVE_STATUSES);
  const orderedIds = [...new Set(ids)].slice(0, MAX_QUEUED_DRAFT_IDS);
  const existingIds = activeBatch
    ? new Set(parseItems(activeBatch.itemsJson).map((item) => item.draftId))
    : new Set<string>();
  const capacity = activeBatch
    ? Math.max(0, MAX_QUEUED_DRAFT_IDS - activeBatch.total)
    : MAX_QUEUED_DRAFT_IDS;
  const candidateIds = orderedIds.filter((id) => !existingIds.has(id)).slice(0, capacity);
  const rows =
    candidateIds.length > 0
      ? await AppDataSource.getRepository(MailMessage).find({
          where: {
            id: In(candidateIds),
            companyId: account.companyId,
            accountId: account.id,
          },
        })
      : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const eligibleIds = candidateIds.filter((id) => {
    const row = byId.get(id);
    return Boolean(
      row?.gmailDraftId && `${row.toEmails} ${row.ccEmails} ${row.bccEmails}`.trim() !== "",
    );
  });
  if (eligibleIds.length === 0) {
    throw new Error(
      capacity === 0
        ? `This send queue already contains the maximum of ${MAX_QUEUED_DRAFT_IDS.toLocaleString()} emails.`
        : "None of those drafts can be added to the send queue.",
    );
  }

  const now = timing.now?.() ?? new Date();
  const delayMs = timing.delayMs?.() ?? randomSendDelayMs();
  const addedItems: DraftSendItem[] = eligibleIds.map((draftId) => ({
    draftId,
    status: "queued",
    errorMessage: "",
  }));
  const repo = AppDataSource.getRepository(MailDraftSendBatch);
  const batch =
    activeBatch ??
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      status: "queued",
      total: 0,
      sent: 0,
      failed: 0,
      itemsJson: "[]",
      nextSendAt: new Date(now.getTime() + delayMs),
      finishedAt: null,
      createdByUserId: actorUserId,
    });
  const items = [...parseItems(batch.itemsJson), ...addedItems];
  batch.itemsJson = JSON.stringify(items);
  batch.total = items.length;
  await repo.save(batch);
  await recordAuditSafely({
    companyId: account.companyId,
    actorUserId,
    action: activeBatch ? "mail.draft.bulk_send_added" : "mail.draft.bulk_send_queued",
    targetType: "mail_draft_send_batch",
    targetId: batch.id,
    targetLabel: account.address,
    metadata: {
      added: addedItems.length,
      total: batch.total,
      minimumDelaySeconds: 60,
      maximumDelaySeconds: 120,
    },
  });
  return { batch, added: addedItems.length };
}

/**
 * Serialize mutations within this process as well as across Postgres replicas.
 * `withSchedulerLease` deliberately skips database leases for SQLite, and a
 * lease already held by this process is re-entrant, so both layers matter.
 */
async function withBatchMutationLease<T>(batchId: string, fn: () => Promise<T>): Promise<T | null> {
  const previous = batchMutationTails.get(batchId) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  batchMutationTails.set(batchId, tail);
  await previous;
  try {
    return await withSchedulerLease(`mail-draft-send:${batchId}`, LEASE_TTL_MS, fn);
  } finally {
    release();
    if (batchMutationTails.get(batchId) === tail) batchMutationTails.delete(batchId);
  }
}

export type QueueDraftsForSendResult = { batch: DraftSendBatchView; added: number };

/** Start a durable paced queue, or append a confirmed selection to the active one. */
export async function createDraftSendBatch(
  account: MailAccount,
  ids: string[],
  actorUserId: string | null,
  timing: QueueTiming = {},
): Promise<QueueDraftsForSendResult> {
  if (creatingAccountIds.has(account.id)) {
    throw new DraftSendQueueBusyError("The send queue is being updated. Please try again.");
  }
  creatingAccountIds.add(account.id);
  try {
    const result = await withSchedulerLease(
      `mail-draft-send-create:${account.id}`,
      15_000,
      async () => {
        const activeBatch = await latestBatch(account.id, ACTIVE_STATUSES);
        if (!activeBatch) return createDraftSendBatchUnlocked(account, ids, actorUserId, timing);
        const appended = await withBatchMutationLease(activeBatch.id, () =>
          createDraftSendBatchUnlocked(account, ids, actorUserId, timing),
        );
        if (!appended) {
          throw new DraftSendQueueBusyError(
            "The send queue is sending an email. Please try again.",
          );
        }
        return appended;
      },
    );
    if (!result) {
      throw new DraftSendQueueBusyError("The send queue is being updated. Please try again.");
    }
    return {
      batch: serializeDraftSendBatch(result.batch, timing.now?.() ?? new Date()),
      added: result.added,
    };
  } finally {
    creatingAccountIds.delete(account.id);
  }
}

function finishBatch(batch: MailDraftSendBatch, items: DraftSendItem[], now: Date): void {
  const counts = itemCounts(items);
  batch.sent = counts.sent;
  batch.failed = counts.failed;
  batch.itemsJson = JSON.stringify(items);
  batch.nextSendAt = null;
  batch.finishedAt = now;
  batch.status = counts.failed > 0 ? "completed_with_errors" : "completed";
}

async function processDraftSendBatchUnlocked(
  batchId: string,
  options: ProcessOptions,
): Promise<DraftSendBatchView | null> {
  const repo = AppDataSource.getRepository(MailDraftSendBatch);
  const batch = await repo.findOneBy({ id: batchId });
  if (!batch || !ACTIVE_STATUSES.includes(batch.status))
    return batch ? serializeDraftSendBatch(batch, options.now?.() ?? new Date()) : null;

  const now = options.now?.() ?? new Date();
  if (!batch.nextSendAt || batch.nextSendAt > now) return serializeDraftSendBatch(batch, now);

  const items = parseItems(batch.itemsJson);
  const current = items.find((item) => item.status === "queued");
  if (!current) {
    finishBatch(batch, items, now);
    await repo.save(batch);
    return serializeDraftSendBatch(batch, now);
  }

  current.status = "sending";
  batch.status = "running";
  batch.itemsJson = JSON.stringify(items);
  await repo.save(batch);

  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: batch.accountId,
    companyId: batch.companyId,
  });
  let sentMessage: MailMessage | null = null;
  let errorMessage = "";

  if (!account) {
    errorMessage = "The mailbox is no longer connected.";
    for (const item of items) {
      if (item.status === "queued" || item.status === "sending") {
        item.status = "failed";
        item.errorMessage = errorMessage;
      }
    }
  } else {
    const draft = await AppDataSource.getRepository(MailMessage).findOneBy({
      id: current.draftId,
      companyId: batch.companyId,
      accountId: batch.accountId,
    });
    if (!draft?.gmailDraftId) {
      errorMessage = "The draft is no longer available.";
    } else if (`${draft.toEmails} ${draft.ccEmails} ${draft.bccEmails}`.trim() === "") {
      errorMessage = "The draft no longer has a recipient.";
    } else {
      try {
        sentMessage = options.sendDraft
          ? await options.sendDraft(account, draft)
          : await sendMailDraft(account, draft, { silent: true });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Gmail refused the send.";
      }
    }
    current.status = sentMessage ? "sent" : "failed";
    current.errorMessage = errorMessage;
  }

  const completedAt = options.now?.() ?? new Date();
  const next = items.find((item) => item.status === "queued");
  const counts = itemCounts(items);
  batch.sent = counts.sent;
  batch.failed = counts.failed;
  batch.itemsJson = JSON.stringify(items);
  if (next) {
    const delayMs = options.delayMs?.() ?? randomSendDelayMs();
    batch.nextSendAt = new Date(completedAt.getTime() + delayMs);
    batch.finishedAt = null;
    batch.status = "running";
  } else {
    finishBatch(batch, items, completedAt);
  }
  await repo.save(batch);

  if (account && sentMessage) {
    notifyMailChanged(account);
    await recordAuditSafely({
      companyId: account.companyId,
      actorUserId: batch.createdByUserId,
      action: "mail.send",
      targetType: "mail_message",
      targetId: sentMessage.id,
      targetLabel: sentMessage.subject || "(no subject)",
      metadata: { fromDraft: true, bulk: true, batchId: batch.id },
    });
  }

  if (!next) {
    await recordAuditSafely({
      companyId: batch.companyId,
      actorUserId: batch.createdByUserId,
      actorKind: batch.createdByUserId ? "user" : "system",
      action: "mail.draft.bulk_send",
      targetType: "mail_account",
      targetId: batch.accountId,
      targetLabel: account?.address ?? "Disconnected mailbox",
      metadata: { requested: batch.total, succeeded: batch.sent, skipped: batch.failed },
    });
  }
  return serializeDraftSendBatch(batch, completedAt);
}

/** Process at most one mail from a batch, guarded across app replicas. */
export async function processDraftSendBatch(
  batchId: string,
  options: ProcessOptions = {},
): Promise<DraftSendBatchView | null> {
  if (activeBatchIds.has(batchId)) return null;
  activeBatchIds.add(batchId);
  try {
    return await withBatchMutationLease(batchId, () =>
      processDraftSendBatchUnlocked(batchId, options),
    );
  } finally {
    activeBatchIds.delete(batchId);
  }
}

async function tickDraftSendQueue(): Promise<void> {
  const due = await AppDataSource.getRepository(MailDraftSendBatch).find({
    where: {
      status: In(ACTIVE_STATUSES),
      nextSendAt: LessThanOrEqual(new Date()),
    },
    order: { nextSendAt: "ASC" },
    take: 25,
  });
  await Promise.all(
    due.map((batch) =>
      processDraftSendBatch(batch.id).catch((error) => {
        reportBackgroundError(`draft-send batch ${batch.id} crashed`, error);
        return null;
      }),
    ),
  );
}

/**
 * Recover the durable cursor and start the due-work heartbeat.
 *
 * A row left at `sending` means the process stopped mid-attempt. It is put back
 * behind a fresh one-to-two minute pause so a restart can never turn the rest
 * of the queue into a burst.
 */
export async function bootMailDraftSendQueue(): Promise<void> {
  const repo = AppDataSource.getRepository(MailDraftSendBatch);
  const batches = await repo.find({ where: { status: In(ACTIVE_STATUSES) } });
  for (const batch of batches) {
    const items = parseItems(batch.itemsJson);
    const interrupted = items.some((item) => item.status === "sending");
    for (const item of items) {
      if (item.status === "sending") item.status = "queued";
    }
    const next = items.find((item) => item.status === "queued");
    if (!next) {
      finishBatch(batch, items, new Date());
    } else {
      batch.itemsJson = JSON.stringify(items);
      if (interrupted || !batch.nextSendAt) {
        batch.nextSendAt = new Date(Date.now() + randomSendDelayMs());
      }
    }
    await repo.save(batch);
  }

  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = setInterval(() => {
    void tickDraftSendQueue().catch((error) => {
      reportBackgroundError("draft-send queue heartbeat failed", error);
    });
  }, DISCOVERY_INTERVAL_MS);
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
  await tickDraftSendQueue();
}
