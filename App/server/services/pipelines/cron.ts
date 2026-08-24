import parser from "cron-parser";
import cron from "node-cron";

/**
 * The one answer to "will this schedule ever fire?".
 *
 * Two libraries are involved and they do not agree. `node-cron` accepts
 * `@annually` and `0 9 1W * *`; `cron-parser`, which is what actually computes
 * `nextRunAt`, throws on both. A Schedule trigger that passes the first and
 * fails the second is dropped by `syncScheduleFields` with `cronExpr` and
 * `nextRunAt` left null — the pipeline simply never runs, and nothing anywhere
 * says why. That silence is the worst failure in the feature, so the check and
 * the scheduling live in one place and cannot drift apart.
 */

/** Next fire time, or null when the expression cannot be scheduled. */
export function nextRunFor(cronExpr: string, from: Date = new Date()): Date | null {
  if (!cron.validate(cronExpr)) return null;
  try {
    return parser.parseExpression(cronExpr, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

/** Whether the heartbeat would ever pick this expression up. */
export function isSchedulableCron(cronExpr: string): boolean {
  return nextRunFor(cronExpr) !== null;
}
