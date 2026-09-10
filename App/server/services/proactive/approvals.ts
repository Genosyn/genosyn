import crypto from "node:crypto";
import { In, LessThan } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { User } from "../../db/entities/User.js";
import { CHAT_HARD_TIMEOUT_MS, chatWithEmployee } from "../chat.js";
import { redactApprovalSummary } from "../approvalRedaction.js";
import { recordAudit } from "../audit.js";
import { handoverDeliveryMode } from "../mail/handoverPrompt.js";
import { handoverGrantError } from "../mail/handovers.js";
import { notifyApprovalPending } from "../notifications.js";
import { workBlocked } from "../standdowns.js";
import { runWorkSummary } from "../runWorkSummary.js";
import type { StartRunOptions } from "../runner.js";

const originSchema = z.object({
  routineId: z.string().nullish(),
  runId: z.string().nullish(),
  conversationId: z.string().nullish(),
  mailThreadId: z.string().nullish(),
  mailHandoverId: z.string().nullish(),
  mailDeliveryMode: z.enum(["draft", "reply", "triage"]).nullish(),
  selfReviewOnly: z.boolean().optional(),
});

/** Supplied by the token, never from the model's tool arguments. */
export type ProactiveWorkOrigin = z.infer<typeof originSchema>;

const payloadSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  context: z.string().min(1).max(4_000),
  plan: z.string().min(1).max(8_000),
  origin: originSchema,
  sourceFingerprint: z.string().min(1),
  dedupeKey: z.string().min(1),
});
export type ProactiveWorkPayload = z.infer<typeof payloadSchema>;

export function parseProactiveWorkPayload(value: string | null): ProactiveWorkPayload {
  return payloadSchema.parse(JSON.parse(value || "null"));
}

/** Only the human-readable report from this kind may cross the Approval API. */
export function proactiveWorkOutcomeSummary(approval: Approval): string | null {
  if (approval.kind !== "proactive_work" || !approval.resultJson) return null;
  try {
    const result: unknown = JSON.parse(approval.resultJson);
    const summary =
      result && typeof result === "object" && "summary" in result ? result.summary : null;
    return typeof summary === "string"
      ? (redactApprovalSummary(summary) ?? "").slice(0, 12_000)
      : null;
  } catch {
    return null;
  }
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reviewText(value: string, limit: number, name: string): string {
  const text = (redactApprovalSummary(value) ?? "").trim();
  if (!text || text.length > limit) throw new Error(`${name} must contain 1–${limit} characters.`);
  return text;
}

/** Recheck the standing source so old reviews cannot authorize a changed instruction. */
async function sourceFingerprint(
  companyId: string,
  employeeId: string,
  origin: ProactiveWorkOrigin,
): Promise<string> {
  if (!origin.routineId && !origin.mailHandoverId && !origin.mailThreadId)
    throw new Error("A work review needs its original Routine or email source.");
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new Error("The AI Employee is no longer in this company.");
  if (origin.selfReviewOnly)
    throw new Error("An own-work review may only stage a Revision proposal.");
  if (workBlocked(companyId, { employeeId, routineId: origin.routineId ?? undefined }).blocked)
    throw new Error("This work is under a Standdown.");
  const source: unknown[] = [employeeId];
  if (origin.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: origin.routineId,
      employeeId,
    });
    if (!routine || !routine.enabled)
      throw new Error("The source Routine was disabled or removed.");
    if (routine.selfReviewOnly) throw new Error("The source Routine is limited to its own review.");
    if (
      origin.runId &&
      !(await AppDataSource.getRepository(Run).existsBy({
        id: origin.runId,
        routineId: routine.id,
      }))
    )
      throw new Error("The source Run does not belong to this Routine.");
    if (
      routine.mailDeliveryMode != null &&
      origin.mailDeliveryMode !== "draft" &&
      origin.mailDeliveryMode !== "triage"
    )
      throw new Error("The source Routine's draft-only restriction must be preserved.");
    source.push({
      routineId: routine.id,
      body: routine.body,
      modelId: routine.modelId,
      mailDeliveryMode: routine.mailDeliveryMode,
      selfReviewOnly: routine.selfReviewOnly,
    });
  }
  if (origin.mailHandoverId) {
    const handover = await AppDataSource.getRepository(MailHandover).findOneBy({
      id: origin.mailHandoverId,
      companyId,
      employeeId,
    });
    if (!handover || handover.threadId !== origin.mailThreadId)
      throw new Error("The original email handover is no longer available.");
    if (handoverDeliveryMode(handover.mode) !== origin.mailDeliveryMode)
      throw new Error("The email handover's delivery restriction must be preserved.");
    if (handover.sourceKind === "rule") {
      const rule = handover.ruleId
        ? await AppDataSource.getRepository(MailRule).findOneBy({
            id: handover.ruleId,
            companyId,
            accountId: handover.accountId,
            enabled: true,
          })
        : null;
      let actions: unknown;
      try {
        actions = JSON.parse(rule?.actionsJson || "[]");
      } catch {
        actions = [];
      }
      if (
        !Array.isArray(actions) ||
        !actions.some(
          (action: Record<string, unknown>) =>
            action.type === "handToEmployee" &&
            action.employeeId === employeeId &&
            action.mode === handover.mode &&
            action.instruction === handover.instruction,
        )
      )
        throw new Error(
          "The email rule was disabled, removed, or changed. Review fresh work instead.",
        );
    }
    const error = await handoverGrantError(employeeId, handover.accountId, handover.mode);
    if (error) throw new Error(error);
    source.push({
      handoverId: handover.id,
      ruleId: handover.ruleId,
      sourceKind: handover.sourceKind,
      instruction: handover.instruction,
      mode: handover.mode,
    });
  }
  if (origin.mailThreadId) {
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: origin.mailThreadId,
      companyId,
    });
    const account = thread
      ? await AppDataSource.getRepository(MailAccount).findOneBy({
          id: thread.accountId,
          companyId,
          status: "active",
        })
      : null;
    if (!thread || !account)
      throw new Error("The source mailbox or email thread is no longer active.");
    const error = await handoverGrantError(
      employeeId,
      account.id,
      origin.mailDeliveryMode ?? "draft",
    );
    if (error) throw new Error(error);
    source.push({ threadId: thread.id, accountId: account.id });
  }
  return digest(source);
}

/** A bounded plan, inert until an admin claims the existing Approval route. */
export async function createProactiveWorkApproval(args: {
  companyId: string;
  employeeId: string;
  title: string;
  context: string;
  plan: string;
  origin: ProactiveWorkOrigin;
}): Promise<Approval> {
  const origin = originSchema.parse(args.origin);
  const title = reviewText(args.title, 200, "Title");
  const context = reviewText(args.context, 4_000, "Context");
  const plan = reviewText(args.plan, 8_000, "Plan");
  const fingerprint = await sourceFingerprint(args.companyId, args.employeeId, origin);
  // Run ids change on every poll. The source and concrete proposed plan do not.
  const dedupeKey = digest([origin.routineId ?? null, origin.mailThreadId ?? null, title, plan]);
  const result = await withSerializedTransaction(async (manager) => {
    if (AppDataSource.options.type === "postgres")
      await manager
        .getRepository(AIEmployee)
        .findOne({ where: { id: args.employeeId }, lock: { mode: "pessimistic_write" } });
    const repo = manager.getRepository(Approval);
    const scope = {
      companyId: args.companyId,
      employeeId: args.employeeId,
      kind: "proactive_work" as const,
    };
    const [active, recent] = await Promise.all([
      repo.find({ where: { ...scope, status: In(["pending", "executing"]) } }),
      repo.find({
        where: { ...scope, status: In(["rejected", "approved", "execution_failed"]) },
        order: { requestedAt: "DESC" },
        take: 200,
      }),
    ]);
    for (const approval of [...active, ...recent]) {
      let previous: ProactiveWorkPayload;
      try {
        previous = parseProactiveWorkPayload(approval.payloadJson);
      } catch {
        /* A malformed old row cannot authorize or suppress fresh work. */
        continue;
      }
      if (previous.dedupeKey !== dedupeKey) continue;
      if (approval.status === "executing") return { approval, created: false };
      if (previous.sourceFingerprint !== fingerprint) {
        if (approval.status === "pending")
          await repo.update({ id: approval.id, status: "pending" }, { status: "expired" });
        continue;
      }
      if (approval.status === "pending" || previous.context === context)
        return { approval, created: false };
    }
    const payload: ProactiveWorkPayload = {
      version: 1,
      title,
      context,
      plan,
      origin,
      sourceFingerprint: fingerprint,
      dedupeKey,
    };
    const approval = await repo.save(
      repo.create({
        companyId: args.companyId,
        employeeId: args.employeeId,
        kind: "proactive_work",
        routineId: origin.routineId ?? "",
        status: "pending",
        title,
        summary: `${context}\n\nProposed work\n${plan}`,
        payloadJson: JSON.stringify(payload),
      }),
    );
    return { approval, created: true };
  });
  if (result.created) {
    await recordAudit({
      companyId: args.companyId,
      actorEmployeeId: args.employeeId,
      action: "proactive.work_review",
      targetType: "approval",
      targetId: result.approval.id,
      targetLabel: title,
    });
    void notifyApprovalPending(result.approval).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[proactive] notification failed for ${result.approval.id}:`, error);
    });
  }
  return result.approval;
}

/** Review history is feedback, never authority for another autonomous action. */
export async function listProactiveWorkReviews(args: { companyId: string; employeeId: string }) {
  await reconcileProactiveWorkApprovals(args.companyId);
  const rows = await AppDataSource.getRepository(Approval).find({
    where: { companyId: args.companyId, employeeId: args.employeeId, kind: "proactive_work" },
    order: { requestedAt: "DESC" },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    title: redactApprovalSummary(row.title),
    summary: (redactApprovalSummary(row.summary) ?? "").slice(0, 500),
    status: row.status,
    routineId: row.routineId || null,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    outcome:
      row.status === "execution_failed"
        ? "The approved work failed. A Member can inspect the review. Do not restart it automatically."
        : row.status === "rejected"
          ? "A Member declined this work. Do not repeat the proposal without changed evidence."
          : row.status === "pending" || row.status === "executing"
            ? "This work is already waiting or underway. Do not create another proposal for it."
            : "Read the live source to verify the result; this review does not authorize more work.",
  }));
}

/** A lost process cannot leave a spinner indefinitely or replay ambiguous work. */
export async function reconcileProactiveWorkApprovals(companyId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Approval);
  const stale = {
    companyId,
    kind: "proactive_work" as const,
    status: "executing" as const,
    // A Routine may still be grading its outcome after its six-hour work budget.
    decidedAt: LessThan(new Date(Date.now() - CHAT_HARD_TIMEOUT_MS - 10 * 60_000)),
  };
  if (!(await repo.existsBy(stale))) return;
  await repo.update(stale, {
    status: "execution_failed",
    errorMessage:
      "The approved work stopped reporting before it finished. Inspect its results before proposing any further action; it will not restart automatically.",
  });
}

function approvedWorkBrief(payload: ProactiveWorkPayload): string {
  return [
    "A company owner or admin reviewed and approved this specific proposed work.",
    `Work: ${payload.title}`,
    `Why it was proposed:\n${payload.context}`,
    `Approved scope:\n${payload.plan}`,
    "Do only the approved scope. First reread the live source and check whether the work is already done or circumstances changed. If the plan is no longer appropriate, stop and report why. Do not treat this approval as standing authority for unrelated or later work. Every existing Grant, company Policy, delivery restriction and action Approval still applies. Checks cannot expand this approved scope: report an unmet Check if satisfying it would require unapproved work.",
    payload.origin.mailThreadId ? `Source email thread: ${payload.origin.mailThreadId}.` : "",
    "Finish with a short factual report, links to actual results, and anything still requiring a Member. Never describe a queued Repository work session as a completed fix.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The runner verifies persisted proof; a caller cannot claim approval with a trigger label. */
export async function validateProactiveRoutineApproval(
  approvalId: string,
  routine: Routine,
  companyId: string,
) {
  const approval = await AppDataSource.getRepository(Approval).findOneBy({
    id: approvalId,
    companyId,
    employeeId: routine.employeeId,
    routineId: routine.id,
    kind: "proactive_work",
    status: "executing",
  });
  if (!approval || !approval.decidedByUserId)
    throw new Error("This Routine needs its claimed human work approval.");
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  if (payload.origin.routineId !== routine.id)
    throw new Error("The approved plan belongs to a different Routine.");
  const [user, member] = await Promise.all([
    AppDataSource.getRepository(User).findOneBy({ id: approval.decidedByUserId }),
    AppDataSource.getRepository(Membership).findOneBy({
      companyId,
      userId: approval.decidedByUserId,
    }),
  ]);
  if (!user || !member || !["owner", "admin"].includes(member.role))
    throw new Error("The approving owner or admin no longer has authority.");
  if (
    (await sourceFingerprint(companyId, routine.employeeId, payload.origin)) !==
    payload.sourceFingerprint
  )
    throw new Error("The source instruction changed after this work was proposed.");
  return { user, payload, brief: approvedWorkBrief(payload) };
}

/** One human-authorized continuation, keeping the original delivery ceiling. */
export async function executeProactiveWorkApproval(
  approval: Approval,
  runChat: typeof chatWithEmployee = chatWithEmployee,
  runApprovedRoutine?: (routine: Routine, options: StartRunOptions) => Promise<Run>,
): Promise<void> {
  if (
    approval.kind !== "proactive_work" ||
    approval.status !== "executing" ||
    !approval.decidedByUserId
  )
    throw new Error("A human must claim this work review before it can start.");
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  if ((payload.origin.routineId ?? "") !== approval.routineId)
    throw new Error("The work review source does not match its Approval.");
  const [member, user] = await Promise.all([
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: approval.companyId,
      userId: approval.decidedByUserId,
    }),
    AppDataSource.getRepository(User).findOneBy({ id: approval.decidedByUserId }),
  ]);
  if (!user || !member || !["owner", "admin"].includes(member.role))
    throw new Error("An owner or admin must still have access to authorize this work.");
  const fingerprint = await sourceFingerprint(
    approval.companyId,
    approval.employeeId,
    payload.origin,
  );
  if (fingerprint !== payload.sourceFingerprint)
    throw new Error(
      "The source instruction changed after this work was proposed. Review a fresh proposal.",
    );
  if (payload.origin.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: payload.origin.routineId,
      employeeId: approval.employeeId,
    });
    const run = await (runApprovedRoutine ?? (await import("../runner.js")).runRoutine)(routine, {
      triggerKind: "approval",
      proactiveApprovalId: approval.id,
    });
    const summary = [
      `Run ${run.id}: ${run.status}.`,
      runWorkSummary(run),
      run.checksVerdict ? `Checks: ${run.checksVerdict}.` : "Checks were not verified.",
      run.outcomeNote || "No independent outcome assessment is available.",
    ].join(" ");
    await AppDataSource.getRepository(Approval).update(
      { id: approval.id, status: "executing" },
      {
        resultJson: JSON.stringify({ summary: redactApprovalSummary(summary), runId: run.id }),
      },
    );
    if (
      run.status !== "completed" ||
      run.checksVerdict === "failed" ||
      run.outcomeVerdict === "off_goal"
    )
      throw new Error(
        "The approved Run did not finish with its required Checks and outcome satisfied. Inspect the Run before requesting more work.",
      );
    return;
  }
  const result = await runChat(
    approval.companyId,
    approval.employeeId,
    approvedWorkBrief(payload),
    [],
    {
      requesterUserId: user.id,
      requesterSessionVersion: user.sessionVersion,
      mailThreadId: payload.origin.mailThreadId,
      mailHandoverId: payload.origin.mailHandoverId,
      routineId: payload.origin.routineId,
      mailDeliveryMode: payload.origin.mailDeliveryMode,
      selfReviewOnly: payload.origin.selfReviewOnly ?? false,
      proactiveReview: false,
      workloadKey: `proactive-approval:${approval.id}`,
      workloadScope: `proactive-approval:${approval.id}`,
    },
  );
  const summary = (redactApprovalSummary(result.reply) ?? "").slice(0, 12_000);
  await AppDataSource.getRepository(Approval).update(
    { id: approval.id, status: "executing" },
    {
      resultJson: JSON.stringify({ summary }),
    },
  );
  if (result.status !== "ok")
    throw new Error(result.reply || "The approved work could not finish.");
  if (result.stopReason === "max_steps" || result.stopReason === "aborted")
    throw new Error(
      "The approved work stopped before finishing. Inspect its partial results before requesting more work.",
    );
  await AppDataSource.getRepository(JournalEntry).save(
    AppDataSource.getRepository(JournalEntry).create({
      employeeId: approval.employeeId,
      kind: "system",
      title: `Completed approved work: ${payload.title}`,
      body: summary,
      routineId: payload.origin.routineId ?? null,
      runId: null,
      authorUserId: user.id,
    }),
  );
}
