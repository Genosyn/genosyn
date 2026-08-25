import crypto from "node:crypto";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { dispatchEmailReceived } from "../pipelines/events.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { analyzeInboundMessage } from "./analysis.js";
import { runRulesForNewMessage } from "./rules.js";

const DISCOVERY_INTERVAL_MS = 5_000;
const ACCOUNT_LEASE_MS = 12 * 60 * 60 * 1_000;
const INTERRUPTED_AFTER_MS = ACCOUNT_LEASE_MS + 60_000;

let discoveryTimer: NodeJS.Timeout | null = null;
let ticking = false;
const activeAccountIds = new Set<string>();
const activeRuns = new Map<string, { accountId: string; promise: Promise<void> }>();

class MailAutomationPausedError extends Error {}

export class MailAutomationBusyError extends Error {}

type MailAutomationEffectRunner = (
  account: MailAccount,
  message: MailMessage,
  assertRunnable: () => Promise<void>,
  beforeEffect: () => Promise<void>,
) => Promise<void>;

type MailAutomationRunOptions = {
  /** Deterministic clock for recovery tests. */
  now?: () => Date;
  /** Test seam for holding or counting side effects without starting a real Pipeline. */
  runEffects?: MailAutomationEffectRunner;
};

const runDefaultEffects: MailAutomationEffectRunner = async (
  account,
  message,
  assertRunnable,
  beforeEffect,
) => {
  // AI triage goes first, and is deliberately NOT fenced by `beforeEffect`.
  //
  // `rules.ts` takes the opposite line for its own model call, marking effects
  // started so a pause cannot bill for the same decision twice. The trade is
  // different here. Triage writes only its own row, keyed by this message, so
  // re-reading is free of consequence beyond the model call itself — whereas
  // fencing it would turn a pause mid-read into a *failed* automation, and the
  // unique replay guard means this message would then never get its rules or
  // its Pipelines at all. One duplicate read is the cheaper side of that.
  //
  // Going first also means the buttons a human wants are ready before a rule's
  // handover or a Pipeline that may run for hours.
  await assertRunnable();
  await analyzeInboundMessage(account, message).catch((error) => {
    // Triage is an enrichment. A mailbox whose model is down still gets its
    // rules and its Pipelines; the analysis row already recorded the failure.
    // eslint-disable-next-line no-console
    console.error(`[mail] AI analysis for message ${message.id} failed:`, error);
  });

  await assertRunnable();
  await runRulesForNewMessage(account, message.id, assertRunnable, beforeEffect);
  await assertRunnable();
  await dispatchEmailReceived(message.id, { failOnRejected: true, beforeEffect });
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

async function finish(
  id: string,
  status: "succeeded" | "failed",
  error: unknown = "",
): Promise<void> {
  await AppDataSource.getRepository(MailInboundAutomation)
    .createQueryBuilder()
    .update()
    .set({
      status,
      finishedAt: new Date(),
      errorMessage: status === "failed" ? errorMessage(error) : "",
    })
    .where("id = :id", { id })
    .andWhere('"status" = :running', { running: "running" })
    .execute();
}

async function failQueued(id: string, error: unknown): Promise<void> {
  await AppDataSource.getRepository(MailInboundAutomation)
    .createQueryBuilder()
    .update()
    .set({ status: "failed", finishedAt: new Date(), errorMessage: errorMessage(error) })
    .where("id = :id", { id })
    .andWhere('"status" = :queued', { queued: "queued" })
    .execute();
}

async function requeue(id: string): Promise<void> {
  await AppDataSource.getRepository(MailInboundAutomation)
    .createQueryBuilder()
    .update()
    .set({ status: "queued", startedAt: null, finishedAt: null, errorMessage: "" })
    .where("id = :id", { id })
    .andWhere('"status" = :running', { running: "running" })
    .execute();
}

async function processOne(
  id: string,
  accountId: string,
  options: MailAutomationRunOptions = {},
): Promise<void> {
  if (activeAccountIds.has(accountId)) return;
  activeAccountIds.add(accountId);
  try {
    await withSchedulerLease(
      `mail-automation-account:${accountId}`,
      ACCOUNT_LEASE_MS,
      async (lease) => {
        const repo = AppDataSource.getRepository(MailInboundAutomation);
        const accountRepo = AppDataSource.getRepository(MailAccount);
        const beforeClaim = await accountRepo.findOneBy({ id: accountId });
        if (!beforeClaim) {
          await failQueued(id, "Mailbox was disconnected before automation ran");
          return;
        }
        // Pause is reversible. Leave the item queued so Resume can process it
        // instead of turning the unique replay guard into permanent data loss.
        if (beforeClaim.status === "paused") return;

        const claimed = await repo
          .createQueryBuilder()
          .update()
          .set({ status: "running", startedAt: new Date(), finishedAt: null, errorMessage: "" })
          .where("id = :id", { id })
          .andWhere('"status" = :queued', { queued: "queued" })
          .execute();
        if ((claimed.affected ?? 0) === 0) return;

        const event = await repo.findOneBy({ id });
        if (!event) return;
        let effectsStarted = false;
        const assertRunnable = async (): Promise<void> => {
          if (!lease.isHeld()) throw new Error("Mailbox automation lease was lost");
          const account = await accountRepo.findOneBy({ id: accountId });
          if (!account) throw new Error("Mailbox was disconnected before automation ran");
          if (account.status === "paused") throw new MailAutomationPausedError();
        };
        const beforeEffect = async (): Promise<void> => {
          await assertRunnable();
          effectsStarted = true;
        };

        try {
          await assertRunnable();
          const account = await accountRepo.findOneByOrFail({ id: accountId });
          const message = await AppDataSource.getRepository(MailMessage).findOneBy({
            id: event.messageId,
            accountId,
          });
          if (!message) throw new Error("Inbound message no longer exists");
          await (options.runEffects ?? runDefaultEffects)(
            account,
            message,
            assertRunnable,
            beforeEffect,
          );
          await assertRunnable();
          await finish(event.id, "succeeded");
        } catch (error) {
          if (error instanceof MailAutomationPausedError && !effectsStarted) {
            await requeue(event.id);
          } else {
            await finish(
              event.id,
              "failed",
              error instanceof MailAutomationPausedError
                ? "Mailbox was paused after automation started"
                : error,
            );
          }
        }
      },
    );
  } finally {
    activeAccountIds.delete(accountId);
  }
}

function launch(id: string, accountId: string, options: MailAutomationRunOptions = {}): void {
  if (activeRuns.has(id)) return;
  const promise = processOne(id, accountId, options)
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[mail] inbound automation ${id} crashed:`, error);
    })
    .finally(() => {
      activeRuns.delete(id);
    });
  activeRuns.set(id, { accountId, promise });
}

async function tick(options: MailAutomationRunOptions = {}): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = options.now?.() ?? new Date();
    const staleBefore = new Date(now.getTime() - INTERRUPTED_AFTER_MS);
    await AppDataSource.getRepository(MailInboundAutomation)
      .createQueryBuilder()
      .update()
      .set({
        status: "failed",
        finishedAt: now,
        errorMessage: "The app stopped while this inbound automation was running.",
      })
      .where('"status" = :running', { running: "running" })
      .andWhere('("startedAt" IS NULL OR "startedAt" < :staleBefore)', { staleBefore })
      .execute();

    const queued = await AppDataSource.getRepository(MailInboundAutomation).find({
      where: { status: "queued" },
      order: { createdAt: "ASC" },
      take: 25,
    });
    // Only start the oldest item for each account. Launching every row made
    // the same-account losers continuously re-query the queue while the first
    // (possibly hours-long) Pipeline was still active.
    const launchedAccounts = new Set<string>();
    for (const event of queued) {
      if (activeAccountIds.has(event.accountId) || launchedAccounts.has(event.accountId)) continue;
      launchedAccounts.add(event.accountId);
      launch(event.id, event.accountId, options);
    }
  } finally {
    ticking = false;
  }
}

function runBackgroundTick(): void {
  void tick().catch((error) => {
    // A transient database error must not become an unhandled rejection that
    // terminates the app. The next five-second discovery pass tries again.
    // eslint-disable-next-line no-console
    console.error("[mail] inbound automation discovery failed:", error);
  });
}

/** Insert-once outbox write. This returns as soon as the durable replay guard
 * exists; slow rules and AI Pipelines run independently of inbox freshness. */
export async function enqueueInboundAutomation(
  message: MailMessage,
  options: MailAutomationRunOptions = {},
): Promise<void> {
  const id = crypto.randomUUID();
  await AppDataSource.getRepository(MailInboundAutomation)
    .createQueryBuilder()
    .insert()
    .values({
      id,
      companyId: message.companyId,
      accountId: message.accountId,
      messageId: message.id,
      gmailMessageId: message.gmailMessageId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      errorMessage: "",
    })
    .orIgnore()
    .execute();
  const inserted = await AppDataSource.getRepository(MailInboundAutomation).findOneBy({ id });
  if (inserted) launch(inserted.id, inserted.accountId, options);
}

export async function waitForMailAutomation(accountId: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const promises = [...activeRuns.values()]
      .filter((run) => run.accountId === accountId)
      .map((run) => run.promise);
    if (promises.length === 0) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new MailAutomationBusyError(
        "The mailbox is still finishing an inbound automation. Please try Disconnect again shortly.",
      );
    }
    let timer: NodeJS.Timeout | null = null;
    const completed = await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      throw new MailAutomationBusyError(
        "The mailbox is still finishing an inbound automation. Please try Disconnect again shortly.",
      );
    }
  }
}

export async function bootMailAutomationQueue(): Promise<void> {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = setInterval(() => {
    runBackgroundTick();
  }, DISCOVERY_INTERVAL_MS);
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
  await tick();
}

/** Deterministic discovery seam used by recovery tests and maintenance. */
export async function runMailAutomationQueuePass(
  options: MailAutomationRunOptions = {},
): Promise<void> {
  await tick(options);
}
