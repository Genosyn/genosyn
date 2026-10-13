import type { Decision } from "../db/entities/Decision.js";
import type { Role } from "../db/entities/Membership.js";
import { cancelDecision } from "./decisions.js";
import { snoozeDecision, type DecisionSnoozeDuration } from "./decisionSnoozes.js";

/**
 * Dismiss or snooze several waiting Decisions at once — the Decision stack's
 * bulk bar.
 *
 * Each id goes through exactly the call its own row's button makes
 * (`cancelDecision`, `snoozeDecision`), so the assignee rule, the
 * exactly-once claim on `pending`, the journal entry, the audit row and the
 * bell cleanup all apply to every Decision on its own. Answering is not on
 * offer: an answer starts the employee's pickup, so it stays one row at a
 * time.
 *
 * An id that is not this company's, belongs to a teammate, or was settled
 * meanwhile is skipped with its reason instead of failing the rest.
 */

export type DecisionBulkRequest =
  | { action: "dismiss"; ids: string[] }
  | { action: "snooze"; ids: string[]; duration: DecisionSnoozeDuration };

export type DecisionBulkOutcome = {
  /** Decisions that changed, in request order. */
  succeeded: string[];
  /** Ids left as they were, each with the reason. */
  skipped: Array<{ id: string; reason: string }>;
};

/** Why a Decision is no longer waiting, in the words its row would use. */
function settledReason(decision: Decision): string {
  if (decision.status === "decided") return "Already answered";
  if (decision.status === "cancelled") return "Already dismissed";
  if (decision.status === "expired") return "Expired";
  return "Changed meanwhile";
}

/** Let other requests in between rows: every awaited SQLite query here is synchronous. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function applyDecisionBulkAction(
  params: DecisionBulkRequest & { companyId: string; userId: string; role: Role },
): Promise<DecisionBulkOutcome> {
  const succeeded: string[] = [];
  const skipped: DecisionBulkOutcome["skipped"] = [];
  let first = true;
  for (const id of new Set(params.ids)) {
    if (!first) await yieldToEventLoop();
    first = false;
    const target = {
      companyId: params.companyId,
      decisionId: id,
      userId: params.userId,
      role: params.role,
    };
    const result =
      params.action === "dismiss"
        ? await cancelDecision({ ...target, reason: null })
        : await snoozeDecision({ ...target, duration: params.duration });
    if (result.outcome === "not_found") {
      skipped.push({ id, reason: "Decision not found" });
    } else if (result.outcome === "forbidden") {
      skipped.push({ id, reason: "Assigned to another teammate" });
    } else if (result.outcome === "conflict") {
      skipped.push({ id, reason: settledReason(result.decision) });
    } else {
      succeeded.push(id);
    }
  }
  return { succeeded, skipped };
}
