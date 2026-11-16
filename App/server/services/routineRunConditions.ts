import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import {
  routineRunConditionOf,
  runConditionDecides,
  type RoutineRunCondition,
} from "../../shared/routineRunCondition.js";
import { emitResourceChange } from "./resourceEvents.js";
import {
  countUnplannedWorkstreams,
  listWorkstreamRevisits,
  type WorkstreamRevisit,
} from "./workstreams.js";

/**
 * Run conditions — whether a scheduled time or a Trigger fire should start a
 * Run at all.
 *
 * A Routine that wakes on a clock has no way to know whether there is anything
 * to do, so before this every scheduled time started a full Run: the AI Model
 * read the whole brief, found nothing due, and finished — and the outcome check
 * then spent a second model turn grading that nothing. Follow through on open
 * work did it every 30 minutes for every employee carrying standing work, on an
 * idle install as much as a busy one.
 *
 * A condition is decided here, by the server, from its own rows: no model turn,
 * no Run row, nothing a model wrote and nothing it can talk its way past. The
 * Work queue's heartbeat works the same way for Pickups (AGENTS.md §3, "nothing
 * due costs no model turn"). When nothing is due the start is declined and
 * recorded on the Routine (`nothingDueAt`, `nothingDueCount`) rather than as a
 * Run, because a Run is a record of work that was attempted: idle Runs would
 * bury the ones that did something, and every consumer of Runs would have to
 * learn to skip them.
 *
 * Only automatic starts are decided (`runConditionDecides`). A person pressing
 * Run now, a webhook, an approved Approval, a retry and a continuation always
 * start: somebody asked for the work, or it already began.
 */

/**
 * A Run of these statuses looked at the Routine's work. An Error (including a
 * timeout or an interruption) or a Run skipped for want of an AI Model did not,
 * so a revisit it was started for stays due and the next scheduled time tries
 * again — the way a Pickup that never reached its model stays queued.
 */
export const LOOKED_RUN_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "completed",
  "reviewed",
  "continued",
  "failed",
];

/** At most this many due Workstreams are named in a brief or on the page. */
export const DUE_WORKSTREAMS_LISTED = 20;

/** The fields a condition reads from its Routine. */
export type ConditionedRoutine = Pick<
  Routine,
  "id" | "employeeId" | "runCondition" | "selfReviewOnly"
>;

export type RunConditionVerdict =
  | { condition: "always"; due: true }
  | {
      condition: "workstream_due";
      due: boolean;
      /** The due Workstreams, soonest revisit first, at most {@link DUE_WORKSTREAMS_LISTED}. */
      workstreams: WorkstreamRevisit[];
      /** When this Routine last looked: its latest Run's start, if any Run looked. */
      lookedAt: Date | null;
    };

/**
 * When a Routine last looked at its work: the start of its newest Run that got
 * going. Through the `(routineId, startedAt)` index, newest first, so it reads
 * the Run or two at the top of the Routine's history and never a transcript.
 */
export async function routineLookedAt(routineId: string): Promise<Date | null> {
  const latest = await AppDataSource.getRepository(Run).findOne({
    where: { routineId, status: In(LOOKED_RUN_STATUSES) },
    select: { id: true, startedAt: true },
    order: { startedAt: "DESC" },
  });
  return latest?.startedAt ?? null;
}

/** Decide a Routine's run condition as of `now`. Reads; never writes. */
export async function evaluateRunCondition(
  routine: ConditionedRoutine,
  now: Date = new Date(),
): Promise<RunConditionVerdict> {
  const condition: RoutineRunCondition = routineRunConditionOf(routine.runCondition);
  if (condition === "always") return { condition, due: true };
  const lookedAt = await routineLookedAt(routine.id);
  const workstreams = await listWorkstreamRevisits({
    routine,
    dueBy: now,
    after: lookedAt,
    limit: DUE_WORKSTREAMS_LISTED,
  });
  return { condition, due: workstreams.length > 0, workstreams, lookedAt };
}

/**
 * Record that an automatic start found nothing due. One small write on the
 * Routine, made without entity listeners: it is bookkeeping, not a change to the
 * Routine, so no Trigger subscribed to Routines may fire on it. Open pages are
 * told directly so the Routine shows when it last looked.
 */
export async function recordNothingDue(
  routine: Pick<Routine, "id" | "employeeId">,
  at: Date,
  companyId?: string,
): Promise<void> {
  await AppDataSource.getRepository(Routine)
    .createQueryBuilder()
    .update(Routine)
    .set({ nothingDueAt: at, nothingDueCount: () => '"nothingDueCount" + 1' })
    .where("id = :id", { id: routine.id })
    .callListeners(false)
    .execute();
  const company =
    companyId ??
    (
      await AppDataSource.getRepository(AIEmployee).findOne({
        where: { id: routine.employeeId },
        select: { id: true, companyId: true },
      })
    )?.companyId;
  if (company) emitResourceChange(company, "routine", undefined, { trigger: false });
}

/**
 * The gate every automatic start passes through, before the Run row — or the
 * Approval a gated Routine would ask for — exists. True means start; false
 * means nothing was due, which has been recorded. A start the condition does
 * not decide is always let through.
 */
export async function admitConditionedStart(
  routine: ConditionedRoutine,
  triggerKind: string,
  opts: { now?: Date; companyId?: string } = {},
): Promise<boolean> {
  if (!runConditionDecides(triggerKind)) return true;
  if (routineRunConditionOf(routine.runCondition) === "always") return true;
  const now = opts.now ?? new Date();
  const verdict = await evaluateRunCondition(routine, now);
  if (verdict.due) return true;
  await recordNothingDue(routine, now, opts.companyId);
  return false;
}

/**
 * Every Workstream whose revisit has come, for a Run's brief: the ones that
 * started it and any this Routine looked at before without planning a new
 * revisit, which is worth the reminder. Leaving out "since it last looked" also
 * keeps a continuation's list the same as the Run it carries on.
 */
export async function revisitsDueForBrief(
  routine: ConditionedRoutine,
  now: Date = new Date(),
): Promise<WorkstreamRevisit[] | null> {
  if (routineRunConditionOf(routine.runCondition) !== "workstream_due") return null;
  return listWorkstreamRevisits({ routine, dueBy: now, limit: DUE_WORKSTREAMS_LISTED });
}

/**
 * The part of a conditioned Routine's brief the server writes: which
 * Workstreams are due and why the Run started, plus how to plan the next
 * revisit. It holds titles and ids of the employee's own Workstreams, never a
 * state document, and the instruction about `revisitAt` lives here rather than
 * in the stored brief so a starter installed before conditions existed is told
 * it too. Empty for a Routine that always runs.
 *
 * `originKind` is how the occurrence began: a continuation or a retry carries
 * on a start its condition admitted.
 */
export function composeRunConditionBlock(
  due: WorkstreamRevisit[] | null,
  originKind: string,
): string {
  if (due === null) return "";
  const admitted = runConditionDecides(originKind) || originKind === "retry";
  const listed = due.map(
    (w) =>
      `- "${w.title.replace(/\s+/g, " ").trim()}" (workstreamId ${w.id}) — revisit due since ${w.revisitAt?.toISOString()}`,
  );
  return [
    "## Due now",
    ...(listed.length
      ? [
          admitted
            ? "Genosyn started this Run because a revisit you planned has come. These of your Workstreams have reached their revisit time:"
            : "This Run was asked for, so it started whether or not anything was due. These of your Workstreams have reached their revisit time:",
          ...listed,
          ...(listed.length >= DUE_WORKSTREAMS_LISTED
            ? ["More may be due; list_workstreams shows the rest."]
            : []),
        ]
      : [
          admitted
            ? "None of your Workstreams has a revisit due any more; it changed after this Run was started. Finish quietly unless the brief finds other due work."
            : "None of your Workstreams has reached its revisit time. This Run was asked for, so it started anyway: look for due work as the brief says, and finish quietly if there is none.",
        ]),
    "",
    "Genosyn starts this Routine only when a revisit you planned has come, without asking the AI Model, so idle time costs nothing. Before you finish, give every Workstream you looked at its next revisit with update_workstream: `revisitAt` (an ISO 8601 time) for when it next needs a look, or `revisitAt: null` when it waits on nothing time-based, such as a person's answer. A revisit is taken up by one Run: a Workstream left without a new revisit is not looked at again by this Routine.",
  ].join("\n");
}

/** What the Routine page shows about its condition. */
export type RunConditionStatus = {
  condition: RoutineRunCondition;
  /** Whether the next scheduled time or Trigger fire would start a Run. */
  due: boolean;
  /** `workstream_due`: the Workstreams due now, soonest first. */
  dueWorkstreams: Array<{ id: string; title: string; revisitAt: string }>;
  /** `workstream_due`: the soonest revisit still to come, if any. */
  nextRevisit: { id: string; title: string; revisitAt: string } | null;
  /** `workstream_due`: active Workstreams with no revisit planned, which never start it. */
  unplanned: number;
  /** When it last looked: the start of its newest Run that got going. */
  lookedAt: string | null;
  /** The last time an automatic start found nothing due. */
  nothingDueAt: string | null;
  /** Automatic starts that found nothing due since the last Run finished. */
  nothingDueCount: number;
};

export async function runConditionStatus(
  routine: ConditionedRoutine & Pick<Routine, "nothingDueAt" | "nothingDueCount">,
  now: Date = new Date(),
): Promise<RunConditionStatus> {
  const verdict = await evaluateRunCondition(routine, now);
  const base = {
    condition: verdict.condition,
    due: verdict.due,
    nothingDueAt: routine.nothingDueAt ? routine.nothingDueAt.toISOString() : null,
    nothingDueCount: routine.nothingDueCount ?? 0,
  };
  if (verdict.condition === "always") {
    return {
      ...base,
      dueWorkstreams: [],
      nextRevisit: null,
      unplanned: 0,
      lookedAt: null,
    };
  }
  const [upcoming, unplanned] = await Promise.all([
    listWorkstreamRevisits({ routine, after: now, limit: 1 }),
    countUnplannedWorkstreams(routine),
  ]);
  const shown = (w: WorkstreamRevisit) => ({
    id: w.id,
    title: w.title,
    revisitAt: (w.revisitAt as Date).toISOString(),
  });
  return {
    ...base,
    dueWorkstreams: verdict.workstreams.map(shown),
    nextRevisit: upcoming[0] ? shown(upcoming[0]) : null,
    unplanned,
    lookedAt: verdict.lookedAt ? verdict.lookedAt.toISOString() : null,
  };
}
