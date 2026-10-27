import { In, IsNull, Not } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Run } from "../db/entities/Run.js";
import { readRunCheckpoint } from "./runContinuation.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/** Recorded once every hand-off finalized before `continued` existed reads Continued. */
export const CONTINUED_RUNS_BACKFILL_KEY = "runs.continuedStatusBackfill";

/** Rows per statement, well inside SQLite's bound-parameter limit. */
const CHUNK = 500;

type Candidate = Pick<
  Run,
  | "id"
  | "failureReason"
  | "continuationStopReason"
  | "checksVerdict"
  | "outcomeVerdict"
  | "checkpointJson"
  | "retryAt"
>;

/**
 * Reclassify historical hand-offs from Failed to Continued.
 *
 * Before `continued` existed, a Run that saved its progress and handed the
 * rest of its work to a continuation was stored as `failed` with no reason of
 * its own. Once the two-million-token batch hand-off shipped that was most
 * long Runs, and the Run history, Journal, letter to the board, Usage and
 * earned-autonomy evidence all counted ordinary progress as failure. Only the
 * exact hand-off shape moves: no error, no reported failure, no stop reason,
 * no failed Check or off-goal grade, a continue checkpoint, and a continuation
 * that took over or is still queued to. Real failures, and hand-offs whose
 * continuation was cancelled or skipped, keep `failed`.
 *
 * A boot service rather than a migration: migrations are generated from
 * entity diffs and never hand-written, and this is data, not schema. It runs
 * once, recorded in an AppSetting, so later boots never rescan Run history.
 * The update skips entity listeners: rewriting history is not a change a
 * Routine Trigger should fire on.
 */
export async function backfillContinuedRuns(): Promise<number> {
  const settings = AppDataSource.getRepository(AppSetting);
  if (await settings.existsBy({ key: CONTINUED_RUNS_BACKFILL_KEY })) return 0;
  const moved = await withSchedulerLease("continued-runs-backfill", 30 * 60_000, async (lease) => {
    if (await settings.existsBy({ key: CONTINUED_RUNS_BACKFILL_KEY })) return 0;
    const count = await reclassifyHandOffs(lease.assertHeld);
    lease.assertHeld();
    await settings.upsert(
      {
        key: CONTINUED_RUNS_BACKFILL_KEY,
        value: JSON.stringify({ at: new Date().toISOString(), runs: count }),
      },
      ["key"],
    );
    return count;
  });
  return moved ?? 0;
}

/** The shape every hand-off had, and nothing else that ends Failed has. */
export function hasHandOffShape(run: Candidate): boolean {
  if (run.failureReason?.trim() || run.continuationStopReason?.trim()) return false;
  if (run.checksVerdict === "failed" || run.outcomeVerdict === "off_goal") return false;
  return readRunCheckpoint(run)?.state === "continue";
}

async function reclassifyHandOffs(assertHeld: () => void): Promise<number> {
  const repo = AppDataSource.getRepository(Run);
  // Through the (status, startedAt) index: Failed Runs without an Error only.
  const candidates = await repo.find({
    where: { status: "failed", errorKind: IsNull() },
    select: {
      id: true,
      failureReason: true,
      continuationStopReason: true,
      checksVerdict: true,
      outcomeVerdict: true,
      checkpointJson: true,
      retryAt: true,
    },
  });
  const shaped = candidates.filter(hasHandOffShape);
  let moved = 0;
  for (let start = 0; start < shaped.length; start += CHUNK) {
    assertHeld();
    const chunk = shaped.slice(start, start + CHUNK);
    // Through the parentRunId index. A skipped continuation never took over.
    const children = await repo.find({
      where: {
        parentRunId: In(chunk.map((run) => run.id)),
        triggerKind: "continuation",
        status: Not("skipped"),
      },
      select: { id: true, parentRunId: true },
    });
    const takenOver = new Set(children.map((child) => child.parentRunId));
    const ids = chunk.filter((run) => run.retryAt || takenOver.has(run.id)).map((run) => run.id);
    if (ids.length === 0) continue;
    assertHeld();
    const result = await repo
      .createQueryBuilder()
      .update(Run)
      .set({ status: "continued" })
      .where({ id: In(ids), status: "failed" })
      .callListeners(false)
      .execute();
    moved += result.affected ?? 0;
  }
  return moved;
}
