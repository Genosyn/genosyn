import { LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Decision } from "../db/entities/Decision.js";
import type { Role } from "../db/entities/Membership.js";
import { recordAudit } from "./audit.js";
import { canDecide, notifyDecisionPending } from "./decisions.js";
import { markEntityNotificationsRead } from "./notifications.js";
import { emitResourceChange } from "./resourceEvents.js";

/** Fixed elapsed-time presets; a month is deliberately an unambiguous 30 days. */
export const DECISION_SNOOZE_MS = {
  one_hour: 60 * 60 * 1_000,
  one_day: 24 * 60 * 60 * 1_000,
  two_days: 2 * 24 * 60 * 60 * 1_000,
  one_week: 7 * 24 * 60 * 60 * 1_000,
  one_month: 30 * 24 * 60 * 60 * 1_000,
} as const;

export type DecisionSnoozeDuration = keyof typeof DECISION_SNOOZE_MS;

export function decisionSnoozedUntil(
  duration: DecisionSnoozeDuration,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + DECISION_SNOOZE_MS[duration]);
}

export type SnoozeDecisionOutcome =
  | { outcome: "not_found" }
  | { outcome: "forbidden"; decision: Decision }
  | { outcome: "conflict"; decision: Decision }
  | { outcome: "snoozed"; decision: Decision };

/**
 * Move a pending Decision out of human attention surfaces until one preset
 * deadline. This changes presentation only: routing and employee readers can
 * still resolve the question, and no pickup or journal entry is started.
 */
export async function snoozeDecision(params: {
  companyId: string;
  decisionId: string;
  userId: string;
  role: Role;
  duration: DecisionSnoozeDuration;
  now?: Date;
}): Promise<SnoozeDecisionOutcome> {
  const repo = AppDataSource.getRepository(Decision);
  const decision = await repo.findOneBy({ id: params.decisionId, companyId: params.companyId });
  if (!decision) return { outcome: "not_found" };
  if (!canDecide(decision, params.userId, params.role)) {
    return { outcome: "forbidden", decision };
  }
  if (decision.status !== "pending") return { outcome: "conflict", decision };

  const snoozedUntil = decisionSnoozedUntil(params.duration, params.now);
  const result = await repo.update(
    { id: decision.id, companyId: params.companyId, status: "pending" },
    { snoozedUntil, stallRemindedAt: null },
  );
  if (!result.affected) {
    const current = await repo.findOneBy({ id: decision.id, companyId: params.companyId });
    return { outcome: "conflict", decision: current ?? decision };
  }

  const updated = (await repo.findOneBy({ id: decision.id, companyId: params.companyId }))!;
  await markEntityNotificationsRead({
    companyId: updated.companyId,
    entityKind: "decision",
    entityId: updated.id,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[decisions] snooze notification cleanup failed", err);
  });
  emitResourceChange(updated.companyId, "decision", undefined, { trigger: false });
  await recordAudit({
    companyId: updated.companyId,
    actorUserId: params.userId,
    action: "decision.snooze",
    targetType: "decision",
    targetId: updated.id,
    targetLabel: updated.title,
    metadata: { duration: params.duration, snoozedUntil: snoozedUntil.toISOString() },
  });
  return { outcome: "snoozed", decision: updated };
}

/**
 * Wake due snoozes on the scheduler heartbeat. The due timestamp participates
 * in the claim so a simultaneous extension, answer or dismissal always wins
 * cleanly and never receives a stale wake notification.
 */
export async function releaseDueDecisionSnoozes(
  now: Date = new Date(),
  assertLeaseHeld: () => void = () => undefined,
): Promise<void> {
  const repo = AppDataSource.getRepository(Decision);
  const due = await repo.find({
    where: { status: "pending", snoozedUntil: LessThanOrEqual(now) },
    order: { snoozedUntil: "ASC" },
    take: 200,
  });

  for (const decision of due) {
    assertLeaseHeld();
    const claim = await repo.update(
      {
        id: decision.id,
        companyId: decision.companyId,
        status: "pending",
        snoozedUntil: LessThanOrEqual(now),
      },
      {
        snoozedUntil: null,
        // Waking is the reminder. Keep Phase 7 from also classifying an old
        // Decision as stale during this same scheduler pass.
        stallRemindedAt: now,
      },
    );
    if (!claim.affected) continue;

    assertLeaseHeld();
    const updated = await repo.findOneBy({ id: decision.id, companyId: decision.companyId });
    if (!updated || updated.status !== "pending") continue;
    emitResourceChange(updated.companyId, "decision", undefined, { trigger: false });
    await recordAudit({
      companyId: updated.companyId,
      actorKind: "system",
      action: "decision.snooze_complete",
      targetType: "decision",
      targetId: updated.id,
      targetLabel: updated.title,
      metadata: {},
    });
    assertLeaseHeld();
    await notifyDecisionPending(updated);
  }
}
