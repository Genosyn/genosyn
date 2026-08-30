import { IsNull, In, LessThan, Not } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Goal } from "../db/entities/Goal.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { resolveRoutineModel } from "./models.js";
import { notifyRunOffGoal } from "./runAlerts.js";
import { assessRunOutcome, type CheckResultEvidence } from "./runVerdicts.js";
import type { EffectRow } from "./runEffects.js";
import { getContainmentSettings } from "./runtimeSettings.js";

/**
 * Grading a finished Run, and re-grading the ones nobody graded.
 *
 * The runner used to own both halves of this inline, and only the happy half
 * existed. `assessOutcomeQuietly` ran the check right after the Run finalized,
 * and if the process died inside that two-minute window — a deploy, a
 * `docker stop`, an OOM — the Run stayed `completed` with a null
 * `outcomeVerdict` forever. Nothing ever came back for it. That would be a
 * small gap if a null verdict meant "unknown", but every consumer read it as
 * "nothing was wrong": the earned-autonomy sweep counted such a Run as clean
 * evidence toward letting an employee work without a human. A restart at the
 * wrong moment was, quite literally, a way to earn trust.
 *
 * So the grading body lives here, both callers share it, and the sweep below
 * finishes what the runner could not. `Run.outcomeCheckedAt` is the durable
 * "somebody looked" stamp the sweep keys on — distinct from `outcomeVerdict`,
 * which records what they concluded.
 */

/** Runs re-graded per pass is a runtime setting; this bounds a bad value. */
const REGRADE_HARD_CAP = 50;

export type GradeRunResult =
  | { graded: true; verdict: NonNullable<Run["outcomeVerdict"]>; note: string }
  | { graded: false; reason: string };

/**
 * Grade one completed Run and persist the verdict.
 *
 * Never throws. The update is conditional on the Run still being `completed`
 * and still ungraded, so a row another owner has since rewritten — or that the
 * sweep and the runner both reached — is written exactly once.
 */
export async function gradeAndPersistRunOutcome(args: {
  run: Run;
  routine: Routine;
  employee: AIEmployee;
  model: Parameters<typeof assessRunOutcome>[0]["model"];
  /** Already-loaded ledger rows, when the caller has them. */
  effects?: EffectRow[];
  /** This Run's Check results, when the caller just produced them. */
  checkResults?: CheckResultEvidence[];
  /** Test seam, forwarded verbatim to the checker. */
  runRestricted?: Parameters<typeof assessRunOutcome>[0]["runRestricted"];
}): Promise<GradeRunResult> {
  const { run, employee } = args;
  const runRepo = AppDataSource.getRepository(Run);
  try {
    // Re-read the Routine: the criteria and the Goal can both have been edited
    // while the Run was executing, and the bar a Run is graded against should
    // be the one that exists when it is graded.
    const fresh = await AppDataSource.getRepository(Routine).findOneBy({ id: args.routine.id });
    if (!fresh || !fresh.acceptanceCriteria.trim()) {
      return { graded: false, reason: "the routine declares no acceptance criteria" };
    }
    const goal = fresh.goalId
      ? await AppDataSource.getRepository(Goal).findOneBy({
          id: fresh.goalId,
          companyId: employee.companyId,
        })
      : null;

    const checkResults =
      args.checkResults ?? (await latestCheckResultsForRun(run.id, employee.companyId));

    const assessment = await assessRunOutcome({
      run,
      routine: fresh,
      employee,
      model: args.model,
      goal: goal && goal.status === "active" ? goal : null,
      effects: args.effects,
      checkResults,
      runRestricted: args.runRestricted,
    });

    const tokensIn = run.tokensIn + assessment.usage.inputTokens;
    const tokensOut = run.tokensOut + assessment.usage.outputTokens;
    const updated = await runRepo.update(
      // `outcomeCheckedAt: IsNull()` is the claim: the runner and the sweep can
      // both reach a Run (a slow verdict turn that outlives its heartbeat), and
      // whichever lands first is the verdict. Without it the second grader
      // would silently overwrite the first, spending a model turn to replace a
      // judgement with another one.
      { id: run.id, status: "completed", outcomeCheckedAt: IsNull() },
      {
        // ResourceChangeSubscriber routes Run updates by this relation key.
        routineId: run.routineId,
        outcomeVerdict: assessment.verdict,
        outcomeNote: assessment.note,
        // Stamped for every outcome including `unverified`: the column records
        // that a grader ran, not that it succeeded. Leaving it null on a failed
        // check would make the sweep retry the same broken provider forever.
        outcomeCheckedAt: new Date(),
        tokensIn,
        tokensOut,
      },
    );
    if (updated.affected !== 1) {
      return { graded: false, reason: "another grader reached this run first" };
    }
    run.outcomeVerdict = assessment.verdict;
    run.outcomeNote = assessment.note;
    run.outcomeCheckedAt = new Date();
    run.tokensIn = tokensIn;
    run.tokensOut = tokensOut;
    if (assessment.verdict === "off_goal") {
      void notifyRunOffGoal(run, assessment.note).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[runGrading] failed to notify off-goal run ${run.id}:`, err);
      });
    }
    return { graded: true, verdict: assessment.verdict, note: assessment.note };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[runGrading] outcome check failed for run ${run.id}:`, err);
    return { graded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The newest round's Check results for a Run.
 *
 * Only the newest: an earlier remediation round's failures are history the
 * strip shows a human, not evidence about the state the Run finished in.
 */
export async function latestCheckResultsForRun(
  runId: string,
  companyId: string,
): Promise<CheckResultEvidence[]> {
  const rows = await AppDataSource.getRepository(RunCheckResult).find({
    where: { runId, companyId },
    order: { attempt: "DESC", createdAt: "ASC" },
  });
  if (rows.length === 0) return [];
  const newest = rows[0].attempt;
  return rows
    .filter((r) => r.attempt === newest)
    .map((r) => ({ name: r.name, required: r.required, passed: r.passed, detail: r.detail }));
}

/**
 * Finish grading the Runs the runner never got to.
 *
 * Runs on the scheduler heartbeat. Picks completed Runs on criteria-bearing
 * Routines that have no `outcomeCheckedAt`, are old enough that the in-line
 * check has certainly either finished or died with its process, and belong to
 * an employee that still has a model to grade with.
 */
export async function sweepUngradedRuns(now: Date): Promise<void> {
  const settings = getContainmentSettings();
  const perPass = Math.min(settings.regradePerPass, REGRADE_HARD_CAP);
  if (perPass <= 0) return;
  const staleBefore = new Date(now.getTime() - settings.regradeAfterMinutes * 60 * 1000);

  const runRepo = AppDataSource.getRepository(Run);
  const candidates = await runRepo.find({
    where: {
      status: "completed",
      outcomeCheckedAt: IsNull(),
      outcomeVerdict: IsNull(),
      finishedAt: LessThan(staleBefore),
    },
    order: { finishedAt: "ASC" },
    // Over-fetch: most candidates belong to Routines with no criteria and are
    // filtered out below without costing a model turn. Bounded so a company
    // with a million ungraded historical Runs cannot stall the heartbeat.
    take: perPass * 10,
  });
  if (candidates.length === 0) return;

  const routineIds = [...new Set(candidates.map((r) => r.routineId))];
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { id: In(routineIds), acceptanceCriteria: Not("") },
  });
  const routineById = new Map(routines.map((r) => [r.id, r]));
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In([...new Set(routines.map((r) => r.employeeId))]) },
  });
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  let graded = 0;
  for (const run of candidates) {
    if (graded >= perPass) break;
    const routine = routineById.get(run.routineId);
    if (!routine?.acceptanceCriteria.trim()) continue;
    const employee = employeeById.get(routine.employeeId);
    if (!employee) continue;
    // No model, nothing to grade with. Stamp it so the sweep does not re-scan
    // the same rows every 30 seconds for the life of the install; the verdict
    // says plainly that it was never graded, which is the truth.
    const { model } = await resolveRoutineModel(routine).catch(() => ({ model: null }));
    if (!model) {
      await runRepo.update(
        { id: run.id, status: "completed", outcomeCheckedAt: IsNull() },
        {
          routineId: run.routineId,
          outcomeVerdict: "unverified",
          outcomeNote:
            "Never graded: the employee has no AI model connected, so no outcome check could run.",
          outcomeCheckedAt: new Date(),
        },
      );
      graded += 1;
      continue;
    }
    await gradeAndPersistRunOutcome({ run, routine, employee, model });
    graded += 1;
  }
}
