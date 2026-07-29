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

export class DraftSendAlreadyRunningError extends Error {}

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

export function serializeDraftSendBatch(batch: MailDraftSendBatch): DraftSendBatchView {
  const items = parseItems(batch.itemsJson);
  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    sent: batch.sent,
    failed: batch.failed,
    remaining: Math.max(0, batch.total - batch.sent - batch.failed),
    nextSendAt: batch.nextSendAt?.toISOString() ?? null,
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
  const batch = await latestBatch(account.id);
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
): Promise<MailDraftSendBatch> {
  if (await latestBatch(account.id, ACTIVE_STATUSES)) {
    throw new DraftSendAlreadyRunningError("A bulk draft send is already in progress.");
  }

  const orderedIds = [...new Set(ids)].slice(0, MAX_QUEUED_DRAFT_IDS);
  const rows =
    orderedIds.length > 0
      ? await AppDataSource.getRepository(MailMessage).find({
          where: {
            id: In(orderedIds),
            companyId: account.companyId,
            accountId: account.id,
          },
        })
      : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const eligibleIds = orderedIds.filter((id) => {
    const row = byId.get(id);
    return Boolean(
      row?.gmailDraftId && `${row.toEmails} ${row.ccEmails} ${row.bccEmails}`.trim() !== "",
    );
  });
  if (eligibleIds.length === 0) {
    throw new Error("None of those drafts can be queued for sending.");
  }

  const now = timing.now?.() ?? new Date();
  const delayMs = timing.delayMs?.() ?? randomSendDelayMs();
  const items: DraftSendItem[] = eligibleIds.map((draftId) => ({
    draftId,
    status: "queued",
    errorMessage: "",
  }));
  const repo = AppDataSource.getRepository(MailDraftSendBatch);
  const batch = repo.create({
    companyId: account.companyId,
    accountId: account.id,
    status: "queued",
    total: items.length,
    sent: 0,
    failed: 0,
    itemsJson: JSON.stringify(items),
    nextSendAt: new Date(now.getTime() + delayMs),
    finishedAt: null,
    createdByUserId: actorUserId,
  });
  await repo.save(batch);
  await recordAuditSafely({
    companyId: account.companyId,
    actorUserId,
    action: "mail.draft.bulk_send_queued",
    targetType: "mail_draft_send_batch",
    targetId: batch.id,
    targetLabel: account.address,
    metadata: { total: batch.total, minimumDelaySeconds: 60, maximumDelaySeconds: 120 },
  });
  return batch;
}

/** Freeze a confirmed selection into one durable, paced send queue. */
export async function createDraftSendBatch(
  account: MailAccount,
  ids: string[],
  actorUserId: string | null,
  timing: QueueTiming = {},
): Promise<DraftSendBatchView> {
  if (creatingAccountIds.has(account.id)) {
    throw new DraftSendAlreadyRunningError("A bulk draft send is already in progress.");
  }
  creatingAccountIds.add(account.id);
  try {
    const batch = await withSchedulerLease(`mail-draft-send-create:${account.id}`, 15_000, () =>
      createDraftSendBatchUnlocked(account, ids, actorUserId, timing),
    );
    if (!batch) {
      throw new DraftSendAlreadyRunningError("A bulk draft send is already in progress.");
    }
    return serializeDraftSendBatch(batch);
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
    return batch ? serializeDraftSendBatch(batch) : null;

  const now = options.now?.() ?? new Date();
  if (!batch.nextSendAt || batch.nextSendAt > now) return serializeDraftSendBatch(batch);

  const items = parseItems(batch.itemsJson);
  const current = items.find((item) => item.status === "queued");
  if (!current) {
    finishBatch(batch, items, now);
    await repo.save(batch);
    return serializeDraftSendBatch(batch);
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
  return serializeDraftSendBatch(batch);
}

/** Process at most one mail from a batch, guarded across app replicas. */
export async function processDraftSendBatch(
  batchId: string,
  options: ProcessOptions = {},
): Promise<DraftSendBatchView | null> {
  if (activeBatchIds.has(batchId)) return null;
  activeBatchIds.add(batchId);
  try {
    return await withSchedulerLease(`mail-draft-send:${batchId}`, LEASE_TTL_MS, () =>
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
