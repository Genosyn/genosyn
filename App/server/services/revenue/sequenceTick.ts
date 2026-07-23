import { In, LessThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Sequence } from "../../db/entities/Sequence.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { SequenceStep } from "../../db/entities/SequenceStep.js";
import { SequenceStepRun, type StepRunStatus } from "../../db/entities/SequenceStepRun.js";
import { partitionRecipients } from "../mail/suppression.js";
import { recordActivity } from "./activities.js";
import {
  computeNextRunAt,
  isWithinSendWindow,
  nextWindowOpening,
  selectDueEnrollments,
  type SendWindow,
} from "./sendWindow.js";
import { parseSendWindow } from "./sequences.js";

/**
 * The sequence scheduler.
 *
 * One sweep: find the enrolments whose next touch is due, decide whether each
 * one may go out right now, and hand the ones that may to a drafter. What makes
 * this module testable is what it refuses to import — **it never calls the AI
 * and never calls Gmail.** Drafting is an injected {@link TouchDrafter}, and the
 * real one is installed at boot by the wiring layer with
 * {@link setTouchDrafter}. Everything below is then reachable from a test with
 * nothing but the in-memory database, which matters because the interesting
 * behaviour here is not "did it send" but "did it correctly decide *not* to".
 *
 * Three rules the whole file exists to hold:
 *
 * - **One bad enrolment cannot abort the tick.** Every enrolment is wrapped in
 *   its own try/catch, and the sweep itself is wrapped too. A sequence pointing
 *   at a deleted mail account is a normal Tuesday; a scheduler that stops
 *   dispatching for the whole install because of it is an outage.
 * - **The gates are re-checked at send time, not trusted from enrolment time.**
 *   Somebody who unsubscribed an hour after being enrolled must not receive the
 *   touch that was already queued for them. That check is the single most
 *   important line in the module.
 * - **Cheap refusals are made before the cap is spent.** Enrolments belonging to
 *   a paused sequence, or to one that has already burned its daily allowance,
 *   are filtered out *before* {@link MAX_TOUCHES_PER_TICK} is applied. Applying
 *   the cap first would let one paused campaign with a thousand due enrolments
 *   starve every other company on the install, tick after tick.
 *
 * Failure is deliberately **retry-free**: an enrolment whose touch throws is
 * marked `failed` and stops. The alternative — retrying — means an employee that
 * reliably produces a malformed draft mails the same prospect every hour until
 * somebody notices. A human unpausing a failed enrolment is the right recovery.
 */

/**
 * Touches dispatched per tick, across every company.
 *
 * Caps the *work*, not the scan: enrolments refused before dispatch (paused
 * sequence, exhausted daily cap) do not consume it, so a large blocked backlog
 * cannot squeeze out live campaigns. Sized to be comfortably drainable within
 * one cron interval — the queue is meant to trail slightly, not to burst.
 */
export const MAX_TOUCHES_PER_TICK = 25;

/**
 * How many due enrolments to read before filtering down to the cap. Four times
 * the touch budget leaves room to skip past a blocked sequence without a second
 * round-trip, while keeping the read bounded on an install with a huge backlog.
 */
const CANDIDATE_MULTIPLIER = 4;

/**
 * How long to wait before re-examining an enrolment whose window will not open
 * inside `nextWindowOpening`'s 14-day horizon — a sequence frozen with an empty
 * `days` list, or one configured into a window that never occurs.
 *
 * Setting `nextRunAt` to null instead would be *wrong*: null is this system's
 * "not scheduled at all", so the enrolment would never be looked at again even
 * after somebody fixed the window. A daily re-check costs one row read and
 * recovers on its own.
 */
const FROZEN_WINDOW_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait after a drafter declines a touch.
 *
 * A `skipped` result is "not now", not "not ever" — the employee was busy, the
 * grant is missing, nothing is wired up yet — so the step is **not** advanced.
 * Silently burning a step the contact never received is the one outcome nobody
 * could debug later. The delay is what stops a permanently misconfigured
 * drafter from hot-looping the whole tick budget.
 */
const SKIP_RETRY_MS = 60 * 60 * 1000;

/** Step-run statuses that count against a sequence's daily allowance. */
const CAPPED_RUN_STATUSES: StepRunStatus[] = ["sent", "drafted"];

export type TickResult = {
  /** Enrolments examined. `sent + drafted + skipped + failed` always equals it. */
  processed: number;
  sent: number;
  drafted: number;
  skipped: number;
  failed: number;
};

export type TouchOutcome = {
  status: StepRunStatus;
  mailMessageId?: string | null;
  mailThreadId?: string | null;
  subject?: string;
  detail?: string;
};

/**
 * Writes one touch and reports what happened to it.
 *
 * The seam between scheduling and sending. A real implementation asks the
 * sequence's AI Employee to draft from the step instruction plus the contact's
 * live context, then either files the result in the drafts queue (`drafted`) or
 * sends it when `autoSend` and both grants allow (`sent`). It is a function
 * rather than an import because that is what keeps this module free of the AI
 * runtime and the mail provider.
 *
 * Contract: it should **not throw** for ordinary refusals — return `skipped`
 * with a reason, or `failed` for something a human must look at. A throw is
 * handled (the enrolment fails, the tick continues), but it produces a worse
 * audit trail than a `failed` result carrying a message.
 */
export type TouchDrafter = (ctx: {
  sequence: Sequence;
  step: SequenceStep;
  enrollment: SequenceEnrollment;
  contact: Contact;
}) => Promise<TouchOutcome>;

const NO_DRAFTER: TouchDrafter = async () => ({
  status: "skipped",
  detail: "no drafter configured",
});

let activeDrafter: TouchDrafter = NO_DRAFTER;

/**
 * Install the real drafter, or pass null to restore the inert default.
 *
 * Called once at boot by the wiring layer, and by tests. Module-level mutable
 * state is normally a smell; here it is the point — it is what lets the
 * scheduler be imported, and exercised, without dragging in the AI runtime.
 * The default refuses rather than throwing so that a tick running before the
 * wiring completes leaves an auditable `skipped` run instead of failing
 * everybody's enrolments.
 */
export function setTouchDrafter(fn: TouchDrafter | null): void {
  activeDrafter = fn ?? NO_DRAFTER;
}

/** What one enrolment did — the four outcome buckets of {@link TickResult}. */
type Outcome = "sent" | "drafted" | "skipped" | "failed";

/**
 * Run one sweep.
 *
 * Never throws: a caller is a cron entry that has nowhere to report an error
 * and would otherwise take the process with it. A sweep that fails at the very
 * first query returns zeroes.
 */
export async function tickSequences(now = new Date()): Promise<TickResult> {
  const result: TickResult = { processed: 0, sent: 0, drafted: 0, skipped: 0, failed: 0 };

  try {
    const candidates = await AppDataSource.getRepository(SequenceEnrollment).find({
      where: { status: "active", nextRunAt: LessThanOrEqual(now) },
      order: { nextRunAt: "ASC", id: "ASC" },
      take: MAX_TOUCHES_PER_TICK * CANDIDATE_MULTIPLIER,
    });
    if (candidates.length === 0) return result;

    const sequenceIds = [...new Set(candidates.map((e) => e.sequenceId))];
    const sequences = await loadSequences(sequenceIds);
    const [stepsBySequence, capRemaining] = await Promise.all([
      loadSteps(sequenceIds),
      loadCapBudget([...sequences.values()], now),
    ]);

    const runnable: SequenceEnrollment[] = [];
    for (const enrollment of candidates) {
      const sequence = sequences.get(enrollment.sequenceId);
      if (!sequence) {
        // An enrolment whose campaign row is gone is corrupt, not merely idle.
        // Fail it loudly rather than leaving it to be re-read every tick.
        result.processed += 1;
        result.failed += 1;
        await safely(() => failEnrollment(enrollment, "sequence no longer exists"));
        continue;
      }
      if (sequence.status !== "active") {
        result.processed += 1;
        result.skipped += 1;
        continue;
      }
      if ((capRemaining.get(sequence.id) ?? 0) <= 0) {
        result.processed += 1;
        result.skipped += 1;
        continue;
      }
      runnable.push(enrollment);
    }

    // The pure helper is the authority on due-ness and ordering, so the
    // fairness rule lives in exactly one tested place — and so the id
    // tie-break cannot drift with the driver's string collation.
    const due = selectDueEnrollments(runnable, now, MAX_TOUCHES_PER_TICK);

    for (const enrollment of due) {
      const sequence = sequences.get(enrollment.sequenceId);
      if (!sequence) continue;
      const steps = stepsBySequence.get(enrollment.sequenceId) ?? [];
      result.processed += 1;
      try {
        const outcome = await processEnrollment({
          enrollment,
          sequence,
          steps,
          now,
          capRemaining,
        });
        result[outcome] += 1;
      } catch (err) {
        result.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        // The failure bookkeeping is itself wrapped: a database error while
        // recording a failure must not escape and end the sweep.
        await safely(async () => {
          const step = steps[enrollment.currentStepOrder];
          if (step) {
            await recordStepRun(enrollment, sequence, step, {
              status: "failed",
              detail: message,
            }, now);
          }
          await failEnrollment(enrollment, message);
        });
      }
    }

    return result;
  } catch {
    // Whatever we managed before the sweep broke is still true. Reporting it
    // beats reporting nothing, and the next tick starts clean.
    return result;
  }
}

/** Swallow an error from bookkeeping that must not abort the caller. */
async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Intentionally silent: the caller is already handling a failure.
  }
}

async function loadSequences(ids: string[]): Promise<Map<string, Sequence>> {
  const rows = await AppDataSource.getRepository(Sequence).find({ where: { id: In(ids) } });
  return new Map(rows.map((s) => [s.id, s]));
}

/** Every step for every candidate sequence, in one query, grouped in memory. */
async function loadSteps(ids: string[]): Promise<Map<string, SequenceStep[]>> {
  const rows = await AppDataSource.getRepository(SequenceStep).find({
    where: { sequenceId: In(ids) },
    order: { sortOrder: "ASC", id: "ASC" },
  });
  const out = new Map<string, SequenceStep[]>();
  for (const row of rows) {
    const bucket = out.get(row.sequenceId);
    if (bucket) bucket.push(row);
    else out.set(row.sequenceId, [row]);
  }
  return out;
}

/**
 * How many more touches each sequence may spend today.
 *
 * A rolling 24 hours rather than a calendar day, deliberately: a calendar cap
 * resets at local midnight, which means a sequence that hit its limit at 23:00
 * fires its whole next allowance an hour later, at 3am for half the recipients.
 * Rolling smooths that out without needing to know anybody's timezone.
 *
 * `dailyCap` of 0 means uncapped, which is what the column documents. One
 * grouped query for every candidate sequence, not one per sequence.
 */
async function loadCapBudget(
  sequences: Sequence[],
  now: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = sequences.map((s) => s.id);
  if (ids.length === 0) return out;

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const used = await AppDataSource.getRepository(SequenceStepRun)
    .createQueryBuilder("r")
    .select("r.sequenceId", "sequenceId")
    .addSelect("COUNT(*)", "count")
    .where("r.sequenceId IN (:...ids)", { ids })
    .andWhere("r.status IN (:...statuses)", { statuses: CAPPED_RUN_STATUSES })
    .andWhere("r.ranAt >= :since", { since })
    .groupBy("r.sequenceId")
    .getRawMany<{ sequenceId: string; count: string | number }>();

  const usedById = new Map(used.map((r) => [r.sequenceId, Number(r.count)]));
  for (const sequence of sequences) {
    if (sequence.dailyCap <= 0) {
      out.set(sequence.id, Number.POSITIVE_INFINITY);
      continue;
    }
    out.set(sequence.id, sequence.dailyCap - (usedById.get(sequence.id) ?? 0));
  }
  return out;
}

/**
 * Decide and act on one enrolment.
 *
 * The order of the gates is the design. Cheapest and least destructive first
 * (window, cap — both leave the enrolment intact for a later tick), then the
 * ones that end it (missing contact, suppression), then completion, and only
 * then the drafter. Checking suppression after drafting would mean paying for a
 * generated email we are then not allowed to send.
 */
async function processEnrollment(ctx: {
  enrollment: SequenceEnrollment;
  sequence: Sequence;
  steps: SequenceStep[];
  now: Date;
  capRemaining: Map<string, number>;
}): Promise<Outcome> {
  const { enrollment, sequence, steps, now, capRemaining } = ctx;
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const window = parseSendWindow(sequence);

  if (!isWithinSendWindow(now, window)) {
    enrollment.nextRunAt = scheduleWithin(now, window, now);
    await repo.save(enrollment);
    return "skipped";
  }

  // Re-checked here as well as before selection, because earlier enrolments in
  // this same tick may have spent the sequence's remaining allowance.
  if ((capRemaining.get(sequence.id) ?? 0) <= 0) return "skipped";

  const contact = await AppDataSource.getRepository(Contact).findOneBy({
    id: enrollment.contactId,
    companyId: enrollment.companyId,
  });
  if (!contact) {
    await failEnrollment(enrollment, "contact no longer exists");
    return "failed";
  }
  if (contact.archivedAt) {
    await stop(enrollment, "stopped_manual", "contact archived");
    return "skipped";
  }
  if (!contact.email) {
    await stop(enrollment, "stopped_manual", "contact has no email address");
    return "skipped";
  }

  // The gate that matters: enrolment consent is not send-time consent.
  const { suppressed } = await partitionRecipients(enrollment.companyId, [contact.email]);
  if (suppressed.length > 0) {
    const step = steps[enrollment.currentStepOrder];
    if (step) {
      // Recorded even though nothing was sent — "we correctly did not mail this
      // person" is the answer somebody needs the day a prospect complains.
      await recordStepRun(
        enrollment,
        sequence,
        step,
        { status: "skipped", detail: `${contact.email} is suppressed` },
        now,
      );
    }
    await stop(enrollment, "stopped_unsubscribed", "recipient is on the do-not-email list");
    return "skipped";
  }

  if (enrollment.currentStepOrder >= steps.length) {
    enrollment.status = "completed";
    enrollment.nextRunAt = null;
    await repo.save(enrollment);
    return "skipped";
  }

  const step = steps[enrollment.currentStepOrder];
  const outcome = await activeDrafter({ sequence, step, enrollment, contact });
  await recordStepRun(enrollment, sequence, step, outcome, now);

  if (outcome.status === "failed") {
    await failEnrollment(enrollment, outcome.detail || "the touch failed");
    return "failed";
  }

  if (outcome.status === "skipped") {
    // Hold position: the step has not been delivered, so it is not consumed.
    enrollment.nextRunAt = scheduleWithin(
      new Date(now.getTime() + SKIP_RETRY_MS),
      window,
      now,
    );
    await repo.save(enrollment);
    return "skipped";
  }

  await advance(enrollment, sequence, steps, outcome, window, now);
  capRemaining.set(sequence.id, (capRemaining.get(sequence.id) ?? 0) - 1);
  return outcome.status;
}

/**
 * Move the enrolment onto the next rung and log the touch.
 *
 * `nextRunAt` is computed from the *next* step's delay measured from now, not
 * from the enrolment date, so a sequence that was paused for a week does not
 * bunch every remaining touch into the moment it resumes.
 */
async function advance(
  enrollment: SequenceEnrollment,
  sequence: Sequence,
  steps: SequenceStep[],
  outcome: TouchOutcome,
  window: SendWindow,
  now: Date,
): Promise<void> {
  const step = steps[enrollment.currentStepOrder];
  const nextStep = steps[enrollment.currentStepOrder + 1];

  enrollment.currentStepOrder += 1;
  enrollment.lastStepAt = now;
  if (outcome.mailThreadId) enrollment.mailThreadId = outcome.mailThreadId;

  if (!nextStep) {
    enrollment.status = "completed";
    enrollment.nextRunAt = null;
  } else {
    enrollment.nextRunAt =
      computeNextRunAt(now, nextStep, window, now) ??
      new Date(now.getTime() + FROZEN_WINDOW_RETRY_MS);
  }
  await AppDataSource.getRepository(SequenceEnrollment).save(enrollment);

  await recordActivity(
    enrollment.companyId,
    {
      kind: "sequence_step",
      subject: outcome.subject || step.name || `${sequence.name} step ${step.sortOrder + 1}`,
      contactId: enrollment.contactId,
      dealId: enrollment.dealId,
      occurredAt: now,
      mailMessageId: outcome.mailMessageId ?? null,
      mailThreadId: outcome.mailThreadId ?? enrollment.mailThreadId,
      meta: {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        stepId: step.id,
        stepOrder: step.sortOrder,
        status: outcome.status,
      },
    },
    { employeeId: sequence.employeeId },
  );
}

/**
 * The next instant inside the window at or after `from`, falling back to a
 * daily re-check when the window will not open inside the search horizon.
 */
function scheduleWithin(from: Date, window: SendWindow, now: Date): Date {
  return (
    nextWindowOpening(from, window) ?? new Date(now.getTime() + FROZEN_WINDOW_RETRY_MS)
  );
}

async function recordStepRun(
  enrollment: SequenceEnrollment,
  sequence: Sequence,
  step: SequenceStep,
  outcome: TouchOutcome,
  now: Date,
): Promise<SequenceStepRun> {
  const repo = AppDataSource.getRepository(SequenceStepRun);
  return repo.save(
    repo.create({
      companyId: enrollment.companyId,
      sequenceId: sequence.id,
      enrollmentId: enrollment.id,
      stepId: step.id,
      stepOrder: step.sortOrder,
      status: outcome.status,
      mailMessageId: outcome.mailMessageId ?? null,
      mailThreadId: outcome.mailThreadId ?? enrollment.mailThreadId,
      detail: outcome.detail ?? "",
      subject: (outcome.subject ?? "").slice(0, 500),
      ranAt: now,
    }),
  );
}

async function stop(
  enrollment: SequenceEnrollment,
  status: SequenceEnrollment["status"],
  reason: string,
): Promise<void> {
  enrollment.status = status;
  enrollment.stoppedReason = reason;
  enrollment.nextRunAt = null;
  await AppDataSource.getRepository(SequenceEnrollment).save(enrollment);
}

/** Retry-free by design — see the module note. */
async function failEnrollment(
  enrollment: SequenceEnrollment,
  message: string,
): Promise<void> {
  await stop(enrollment, "failed", message.slice(0, 500));
}
