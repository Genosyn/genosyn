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
import {
  MailHandover,
  type MailHandoverMode,
  type MailHandoverSource,
} from "../../db/entities/MailHandover.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { chatWithEmployee } from "../chat.js";
import { recordAudit } from "../audit.js";
import { createNotifications } from "../notifications.js";
import { broadcastToCompany } from "../realtime.js";
import { columnHasLabel } from "./store.js";
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
/** Keep prompts bounded: per-message and whole-transcript caps. */
const MESSAGE_CHARS_CAP = 4_000;
const TRANSCRIPT_CHARS_CAP = 24_000;
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

export async function createMailHandover(args: {
  account: MailAccount;
  thread: MailThread;
  employeeId: string;
  mode: MailHandoverMode;
  instruction: string;
  sourceKind: MailHandoverSource;
  ruleId: string | null;
  createdByUserId: string | null;
  /** When set, the handover is recorded as failed without running — used by
   * rules whose grant pre-flight failed, so the misconfiguration is visible. */
  precheckError?: string | null;
}): Promise<MailHandover> {
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
export async function retryMailHandover(handover: MailHandover): Promise<void> {
  const repo = AppDataSource.getRepository(MailHandover);
  if (inFlight.has(handover.id)) return;
  handover.status = "pending";
  handover.errorMessage = "";
  handover.resultSummary = "";
  handover.startedAt = null;
  handover.finishedAt = null;
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

async function runHandover(id: string): Promise<void> {
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
  if (!account || !thread || !employee) {
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
    const prompt = await composeHandoverPrompt(handover, account, thread);
    const result = await chatWithEmployee(account.companyId, employee.id, prompt, []);
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

async function composeHandoverPrompt(
  handover: MailHandover,
  account: MailAccount,
  thread: MailThread,
): Promise<string> {
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { threadId: thread.id },
    order: { sentAt: "ASC" },
  });
  const visible = messages.filter((m) => !columnHasLabel(m.labelIds, "DRAFT"));

  const parts: string[] = [];
  parts.push(
    handover.sourceKind === "rule"
      ? "An inbound email matched an automation rule, and the rule handed the thread to you."
      : "A human teammate handed you an email thread to handle.",
  );
  parts.push(
    `Mailbox: ${account.address}. Thread id: ${thread.id} (pass this as \`threadId\` to the \`mail\` tool).`,
  );
  parts.push(
    `Instruction: ${handover.instruction || "(none given — use the mode guidance below)"}`,
  );
  parts.push(modeGuidance(handover.mode));
  parts.push(
    'The full thread is below, oldest first. Use the `mail` tool (`op: "get"`, threadId as above) if you need to re-read it, check labels, or fetch anything the transcript truncated.',
  );
  parts.push("");
  parts.push(`=== Email thread: "${thread.subject || "(no subject)"}" ===`);

  let budget = TRANSCRIPT_CHARS_CAP;
  const rendered: string[] = [];
  // Render newest→oldest against the budget so long threads keep the recent
  // context, then restore chronological order for the prompt.
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const m = visible[i];
    const body = (m.bodyText || m.snippet).slice(0, MESSAGE_CHARS_CAP);
    const block = [
      `[${i + 1}] From: ${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}`,
      `    To: ${m.toEmails}${m.ccEmails ? `  Cc: ${m.ccEmails}` : ""}`,
      `    Date: ${m.sentAt ? m.sentAt.toISOString() : "unknown"}`,
      "",
      body,
    ].join("\n");
    if (block.length > budget) {
      rendered.push(`… ${i + 1} earlier message(s) omitted — fetch with the mail tool if needed.`);
      break;
    }
    budget -= block.length;
    rendered.push(block);
  }
  parts.push(rendered.reverse().join("\n\n---\n\n"));
  parts.push("");
  parts.push(
    "When you are done, reply with a short summary of exactly what you did (which tool calls, what you wrote or labelled). The summary is stored on the handover record for the humans to read.",
  );
  return parts.join("\n");
}

function modeGuidance(mode: MailHandoverMode): string {
  switch (mode) {
    case "draft":
      return 'Mode: DRAFT. Write the reply as a Gmail draft on this thread using the `mail` tool with `op: "draft"` and the `threadId` above. Do NOT send anything — a human will review and send the draft.';
    case "reply":
      return 'Mode: REPLY. Compose and SEND the reply yourself using the `mail` tool with `op: "send"` and the `threadId` above. You are trusted to send on this mailbox — keep the tone consistent with the thread.';
    case "triage":
      return 'Mode: TRIAGE. Do not write or send anything. Read the thread and file it: apply/remove labels, archive, star, or mark read using the `mail` tool with `op: "update"`. If asked to categorize, apply exactly the label the instruction names (labels are created on first use).';
  }
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
  });
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: handover.threadId,
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
