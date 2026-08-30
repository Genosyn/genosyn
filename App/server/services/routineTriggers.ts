import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { LIVE_SYNC_KINDS } from "../db/subscribers/resourceChangeSubscriber.js";
import { registerRoutineTriggerSink } from "./resourceEvents.js";
import { runRoutine } from "./runner.js";
import { recordAudit } from "./audit.js";
import { notifyApprovalPending } from "./notifications.js";
import { workBlocked } from "./standdowns.js";

/**
 * Triggers — event-fired Routines on the live-sync spine (M54).
 *
 * The spine's frames are coarse and id-only by design, and this module keeps
 * them that way: a fire tells the Routine only that its subscribed family
 * changed (plus scope ids, when known). The employee reads the actual state
 * through its own grant-gated tools, so an event can route work but never
 * carry content — the same reason the client's live refetch is safe.
 *
 * Two guards make subscriptions safe to leave on:
 *  - the per-trigger minimum interval, claimed on `lastFiredAt` with a
 *    conditional UPDATE so racing flushes fire once — and so a Routine that
 *    writes the very family it subscribes to converges to one fire per
 *    interval instead of a hot loop;
 *  - the webhook precedent for gated Routines: a `requiresApproval` Routine's
 *    fire enqueues the Approval a cron tick would, never a bypass.
 */

const MIN_INTERVAL_FLOOR_SEC = 60;
export const MIN_INTERVAL_DEFAULT_SEC = 900;

export class RoutineTriggerError extends Error {}

export function assertValidTriggerKind(kind: string): void {
  if (!LIVE_SYNC_KINDS.includes(kind)) {
    throw new RoutineTriggerError(
      `Unknown event kind "${kind}" — subscribable kinds are: ${LIVE_SYNC_KINDS.join(", ")}`,
    );
  }
}

export function normalizeMinInterval(sec: number | undefined): number {
  return Math.max(MIN_INTERVAL_FLOOR_SEC, Math.round(sec ?? MIN_INTERVAL_DEFAULT_SEC));
}

/** Wired once at boot; deliveries arrive after each coalesced flush. */
export function bootRoutineTriggers(): void {
  registerRoutineTriggerSink((companyId, kind, scopeIds) => {
    void dispatchTriggerEvent(companyId, kind, scopeIds).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[triggers] dispatch failed for ${companyId}/${kind}:`, err);
    });
  });
}

/** Exported bare for tests — the sink above is just this with a catch. */
export async function dispatchTriggerEvent(
  companyId: string,
  kind: string,
  scopeIds: string[],
): Promise<void> {
  const triggers = await AppDataSource.getRepository(RoutineTrigger).find({
    where: { companyId, kind, enabled: true },
  });
  // A company-wide Standdown stops every trigger without a per-trigger lookup
  // (M58). The narrower scopes are checked inside `fireTrigger`, where the
  // Routine and its employee are already in hand.
  if (workBlocked(companyId).blocked) return;
  for (const trigger of triggers) {
    // An empty scope set means "the specifics overflowed — treat as
    // company-wide", exactly as the client's refetch does.
    if (trigger.scopeId && scopeIds.length > 0 && !scopeIds.includes(trigger.scopeId)) continue;
    try {
      await fireTrigger(trigger);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[triggers] fire failed for trigger ${trigger.id}:`, err);
    }
  }
}

async function fireTrigger(trigger: RoutineTrigger): Promise<void> {
  const cutoff = new Date(Date.now() - trigger.minIntervalSec * 1000);
  // The interval claim: whoever flips lastFiredAt owns this fire. Two
  // predicates because IsNull cannot ride an OR inside `update`'s criteria.
  const claim = await AppDataSource.getRepository(RoutineTrigger)
    .createQueryBuilder()
    .update()
    .set({ lastFiredAt: new Date() })
    .where("id = :id", { id: trigger.id })
    .andWhere('("lastFiredAt" IS NULL OR "lastFiredAt" < :cutoff)', { cutoff })
    .execute();
  if (claim.affected !== 1) return;

  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: trigger.routineId });
  if (!routine || !routine.enabled) return;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
    companyId: trigger.companyId,
  });
  if (!emp) return;
  // Checked after the interval claim rather than before it: a fire that is
  // stopped should still consume its slot, so lifting a standdown does not
  // release a burst of triggers that all became due while work was stopped.
  if (workBlocked(trigger.companyId, { employeeId: emp.id, routineId: routine.id }).blocked) {
    return;
  }

  await recordAudit({
    companyId: trigger.companyId,
    actorKind: "system",
    action: "routine.run.event",
    targetType: "routine",
    targetId: routine.id,
    targetLabel: routine.name,
    metadata: { kind: trigger.kind, scopeId: trigger.scopeId },
  });
  try {
    const journal = AppDataSource.getRepository(JournalEntry);
    await journal.save(
      journal.create({
        employeeId: emp.id,
        kind: "system",
        title: `A change in ${trigger.kind} triggered your routine "${routine.name}"`,
        body: "",
        routineId: routine.id,
        runId: null,
        authorUserId: null,
      }),
    );
  } catch {
    // Journal is best-effort here, as on the webhook path.
  }

  // The webhook precedent, verbatim: gated Routines meet their Approval.
  if (routine.requiresApproval) {
    const approvalRepo = AppDataSource.getRepository(Approval);
    const pending = await approvalRepo.save(
      approvalRepo.create({
        companyId: trigger.companyId,
        routineId: routine.id,
        employeeId: emp.id,
        status: "pending",
      }),
    );
    void notifyApprovalPending(pending).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[triggers] notify approval failed for ${pending.id}:`, err);
    });
    return;
  }
  runRoutine(routine, { triggerKind: "event" }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[triggers] routine ${routine.id} failed:`, err);
  });
}

export async function listTriggersForRoutine(
  companyId: string,
  routineId: string,
): Promise<RoutineTrigger[]> {
  return AppDataSource.getRepository(RoutineTrigger).find({
    where: { companyId, routineId },
    order: { createdAt: "ASC" },
  });
}
