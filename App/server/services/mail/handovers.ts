import { In, LessThan } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover, type MailHandoverMode } from "../../db/entities/MailHandover.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { workBlocked } from "../standdowns.js";
import { composeHandoverPrompt, handoverDeliveryMode } from "./handoverPrompt.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { chatWithEmployee, type ChatOptions } from "../chat.js";
import { recordAudit } from "../audit.js";
import { createNotifications } from "../notifications.js";
import { broadcastToCompany } from "../realtime.js";
import { config } from "../../../config.js";

/**
 * The handover runner: takes one email thread + one AI employee + an
 * instruction, and executes it through the chat seam so the employee works
 * with its full Soul / Memory / Skills and the grant-gated mail tools.
 *
 * Execution rides a small in-process FIFO (concurrency 2) — enough to keep
 * a busy inbox moving without letting a rule storm spawn twenty concurrent
 * agent loops. Survives restarts the honest way: `bootMailHandovers` fails
 * anything marked `running` (its loop died with the process) and re-queues
 * everything `pending`.
 */

const CONCURRENCY = 2;
const RESULT_SUMMARY_CAP = 8_000;

const queue: string[] = [];
let running = 0;
let discoveryTimer: NodeJS.Timeout | null = null;

/** Grant pre-flight shared by routes and rules: null when allowed, else a
 * human-readable reason. `reply` needs `send`; `draft`/`triage` need `draft`. */
export async function handoverGrantError(
  employeeId: string,
  accountId: string,
  mode: MailHandoverMode,
): Promise<string | null> {
  const needed: MailAccessLevel = mode === "reply" ? "send" : "draft";
  const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
    employeeId,
    accountId,
  });
  if (grant && MAIL_ACCESS_RANK[grant.accessLevel] >= MAIL_ACCESS_RANK[needed]) {
    return null;
  }
  return grant
    ? `This employee's access level on the mailbox is "${grant.accessLevel}" but a "${mode}" handover needs at least "${needed}".`
    : `This employee has no access to the mailbox yet. Grant it under Email → Settings → AI access.`;
}

/**
 * Is a rule already working this thread? A broad rule that matches several
 * messages in the same conversation, or a re-delivery, must not stack a
 * second handover on top of one still pending or running for the same
 * (thread, rule) — that is how a rule storms an employee. Manual handovers
 * are never deduped (a human asking twice means twice).
 */
export async function hasActiveRuleHandover(threadId: string, ruleId: string): Promise<boolean> {
  return AppDataSource.getRepository(MailHandover).existsBy([
    { threadId, ruleId, status: "pending" },
    { threadId, ruleId, status: "running" },
  ]);
}

type CreateMailHandoverArgs = {
  account: MailAccount;
  thread: MailThread;
  employeeId: string;
  mode: MailHandoverMode;
  instruction: string;
  /** When set, the handover is recorded as failed without running — used by
   * rules whose grant pre-flight failed, so the misconfiguration is visible. */
  precheckError?: string | null;
} & (
  | {
      sourceKind: "manual";
      ruleId: null;
      createdByUserId: string;
      requesterUserId: string;
      requesterSessionVersion: number;
    }
  | {
      sourceKind: "rule";
      ruleId: string;
      createdByUserId: null;
      requesterUserId?: never;
      requesterSessionVersion?: never;
    }
);

export async function createMailHandover(args: CreateMailHandoverArgs): Promise<MailHandover> {
  const repo = AppDataSource.getRepository(MailHandover);
  const handover = repo.create({
    companyId: args.account.companyId,
    accountId: args.account.id,
    threadId: args.thread.id,
    employeeId: args.employeeId,
    mode: args.mode,
    instruction: args.instruction,
    sourceKind: args.sourceKind,
    ruleId: args.ruleId,
    createdByUserId: args.createdByUserId,
    requesterUserId: args.requesterUserId ?? null,
    requesterSessionVersion: args.requesterSessionVersion ?? null,
    status: args.precheckError ? "failed" : "pending",
    errorMessage: args.precheckError ?? "",
    finishedAt: args.precheckError ? new Date() : null,
  });
  await repo.save(handover);
  await recordAudit({
    companyId: args.account.companyId,
    actorUserId: args.createdByUserId,
    actorKind: args.createdByUserId ? "user" : "system",
    action: "mail.handover.create",
    targetType: "mail_handover",
    targetId: handover.id,
    targetLabel: args.thread.subject || "(no subject)",
    metadata: { mode: args.mode, sourceKind: args.sourceKind },
  });
  if (args.precheckError) {
    await notifyHandoverFinished(handover);
  } else {
    enqueue(handover.id);
  }
  broadcastToCompany(args.account.companyId, {
    type: "mail.updated",
    accountId: args.account.id,
  });
  return handover;
}

/** Re-queue a failed handover. Idempotent: a double-click can't double-run
 * it — `enqueue` de-dupes ids already queued or in flight. */
export async function retryMailHandover(
  handover: MailHandover,
  requester: { userId: string; sessionVersion: number },
): Promise<void> {
  const repo = AppDataSource.getRepository(MailHandover);
  if (inFlight.has(handover.id)) return;
  handover.status = "pending";
  handover.errorMessage = "";
  handover.resultSummary = "";
  handover.startedAt = null;
  handover.finishedAt = null;
  handover.requesterUserId = requester.userId;
  handover.requesterSessionVersion = requester.sessionVersion;
  await repo.save(handover);
  enqueue(handover.id);
}

/** Recover stale work and continuously discover pending rows across replicas. */
export async function bootMailHandovers(): Promise<void> {
  const repo = AppDataSource.getRepository(MailHandover);
  const stale = await repo.find({
    where: {
      status: "running",
      startedAt: LessThan(new Date(Date.now() - 30 * 60_000)),
    },
  });
  for (const h of stale) {
    h.status = "failed";
    h.errorMessage = "The handover stopped responding before it completed.";
    h.finishedAt = new Date();
    await repo.save(h);
  }
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = setInterval(() => {
    void enqueuePendingHandovers();
  }, 30_000);
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
  await enqueuePendingHandovers();
}

async function enqueuePendingHandovers(): Promise<void> {
  const repo = AppDataSource.getRepository(MailHandover);
  const pending = await repo.find({
    where: { status: "pending" },
    order: { createdAt: "ASC" },
  });
  for (const h of pending) enqueue(h.id);
}

/** Ids currently queued or running — the de-dupe guard against the same
 * handover being enqueued twice (double retry, retry racing a boot requeue). */
const inFlight = new Set<string>();

function enqueue(id: string): void {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  queue.push(id);
  pump();
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    running += 1;
    void runHandover(id)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[mail] handover ${id} crashed:`, err);
      })
      .finally(() => {
        running -= 1;
        inFlight.delete(id);
        pump();
      });
  }
}

export async function runHandover(
  id: string,
  runChat: typeof chatWithEmployee = chatWithEmployee,
): Promise<void> {
  const repo = AppDataSource.getRepository(MailHandover);
  const handover = await AppDataSource.transaction(async (manager) => {
    const txRepo = manager.getRepository(MailHandover);
    const row =
      config.db.driver === "postgres"
        ? await txRepo.findOne({
            where: { id },
            lock: { mode: "pessimistic_write" },
          })
        : await txRepo.findOneBy({ id });
    if (!row || row.status !== "pending") return null;
    row.status = "running";
    row.startedAt = new Date();
    return txRepo.save(row);
  });
  if (!handover) return;

  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: handover.accountId,
  });
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: handover.threadId,
  });
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: handover.employeeId,
  });
  if (
    !account ||
    !thread ||
    !employee ||
    account.companyId !== handover.companyId ||
    thread.companyId !== handover.companyId ||
    thread.accountId !== account.id ||
    employee.companyId !== handover.companyId
  ) {
    handover.status = "failed";
    handover.errorMessage =
      "The mailbox, thread, or employee behind this handover no longer exists.";
    handover.finishedAt = new Date();
    await repo.save(handover);
    await notifyHandoverFinished(handover);
    if (account) {
      broadcastToCompany(account.companyId, {
        type: "mail.updated",
        accountId: account.id,
      });
    }
    return;
  }

  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });

  // A throw anywhere below (DB blip, repo materialization, the agent loop)
  // must still land the handover in a terminal state and notify — otherwise
  // it orphans as "running" until the next restart with the creator staring
  // at a spinner.
  try {
    // A queued handover never outlives a pause or a revoked standing instruction.
    if (
      account.status !== "active" ||
      workBlocked(account.companyId, { employeeId: employee.id }).blocked
    ) {
      await repo.update(
        { id: handover.id, status: "running" },
        { status: "pending", startedAt: null },
      );
      return;
    }
    if (handover.sourceKind === "rule") {
      const rule = handover.ruleId
        ? await AppDataSource.getRepository(MailRule).findOneBy({
            id: handover.ruleId,
            companyId: account.companyId,
            accountId: account.id,
            enabled: true,
          })
        : null;
      let stillConfigured = false;
      try {
        const actions: unknown = rule ? JSON.parse(rule.actionsJson) : [];
        stillConfigured =
          Array.isArray(actions) &&
          actions.some(
            (action: Record<string, unknown>) =>
              action.type === "handToEmployee" &&
              action.employeeId === employee.id &&
              action.mode === handover.mode &&
              action.instruction === handover.instruction,
          );
      } catch {
        /* A malformed rule has no live authority. */
      }
      if (!stillConfigured)
        throw new Error(
          "The rule behind this handover was disabled, removed, or changed. New mail will use its current configuration.",
        );
    }
    const grantError = await handoverGrantError(employee.id, account.id, handover.mode);
    if (grantError) throw new Error(grantError);
    const messages = await AppDataSource.getRepository(MailMessage).find({
      where: { threadId: thread.id, accountId: account.id, companyId: account.companyId },
      order: { sentAt: "ASC" },
    });
    const prompt = composeHandoverPrompt(handover, account, thread, messages);
    const authority = resolveMailHandoverAuthority(handover);
    if (!authority) {
      throw new Error(
        "This manual handover predates secure Member delegation. Retry it from a logged-in browser to authorize a new attempt.",
      );
    }
    const result = await runChat(account.companyId, employee.id, prompt, [], {
      ...authority,
      mailThreadId: handover.threadId,
      mailHandoverId: handover.id,
      mailDeliveryMode: handoverDeliveryMode(handover.mode),
      proactiveReview: handover.sourceKind === "rule",
    });
    if (result.status === "ok") {
      handover.status = "completed";
      handover.resultSummary = result.reply.slice(0, RESULT_SUMMARY_CAP);
    } else {
      handover.status = "failed";
      handover.errorMessage = result.reply.slice(0, RESULT_SUMMARY_CAP);
    }
  } catch (err) {
    handover.status = "failed";
    handover.errorMessage = (err instanceof Error ? err.message : String(err)).slice(
      0,
      RESULT_SUMMARY_CAP,
    );
  }
  handover.finishedAt = new Date();
  await repo.save(handover);
  await recordAudit({
    companyId: account.companyId,
    actorEmployeeId: employee.id,
    action: handover.status === "completed" ? "mail.handover.complete" : "mail.handover.fail",
    targetType: "mail_handover",
    targetId: handover.id,
    targetLabel: thread.subject || "(no subject)",
  });
  await notifyHandoverFinished(handover);
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });
}

/** Rule automation is employee-owned; every browser-created/retried attempt is Member-bound. */
export function resolveMailHandoverAuthority(
  handover: Pick<MailHandover, "sourceKind" | "requesterUserId" | "requesterSessionVersion">,
): ChatOptions | null {
  if (handover.requesterUserId && handover.requesterSessionVersion !== null) {
    return {
      requesterUserId: handover.requesterUserId,
      requesterSessionVersion: handover.requesterSessionVersion,
    };
  }
  if (
    handover.sourceKind === "rule" &&
    handover.requesterUserId === null &&
    handover.requesterSessionVersion === null
  ) {
    return { toolAuthority: "employee" };
  }
  return null;
}

/** Bell + push: the creator hears about manual handovers; owners/admins
 * hear about rule-driven failures (a silent broken automation is worse
 * than a noisy one). Rule successes stay quiet — the draft in the thread
 * is the signal. */
async function notifyHandoverFinished(handover: MailHandover): Promise<void> {
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: handover.companyId,
  });
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: handover.employeeId,
    companyId: handover.companyId,
  });
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: handover.threadId,
    companyId: handover.companyId,
    accountId: handover.accountId,
  });
  if (!company) return;
  const subject = thread?.subject || "(no subject)";
  const empName = employee?.name ?? "An AI employee";
  const link = `/c/${company.slug}/mail/t/${handover.threadId}`;
  const failed = handover.status === "failed";

  let userIds: string[] = [];
  if (handover.createdByUserId) {
    userIds = [handover.createdByUserId];
  } else if (failed) {
    const admins = await AppDataSource.getRepository(Membership).find({
      where: { companyId: company.id, role: In(["owner", "admin"]) },
    });
    userIds = admins.map((m) => m.userId);
  }
  if (userIds.length === 0) return;

  const title = failed
    ? `${empName} could not finish an email handover`
    : `${empName} finished with "${subject}"`;
  const body = failed ? handover.errorMessage.slice(0, 300) : handover.resultSummary.slice(0, 300);
  await createNotifications(
    userIds.map((userId) => ({
      companyId: company.id,
      userId,
      kind: "mail_handover" as const,
      title,
      body,
      link,
      actorKind: "ai" as const,
      actorId: handover.employeeId,
      entityKind: "mail_handover" as const,
      entityId: handover.id,
    })),
  );
}
