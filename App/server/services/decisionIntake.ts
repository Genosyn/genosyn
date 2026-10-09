import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Decision, DecisionOption, DecisionUrgency } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { currentAuditContext, recordAudit } from "./audit.js";
import { DecisionStackOffError, getDecisionStackState } from "./decisionStackSettings.js";
import {
  checkWaitingDecisions,
  type DuplicateKind,
  type WaitingDecision,
} from "./decisionDuplicates.js";
import {
  screenDecision,
  type DecisionScreenOutcome,
  type DecisionScreenQuestion,
} from "./decisionScreening.js";
import { createDecision, normalizeDecisionOptions, type DecisionOptionInput } from "./decisions.js";
import {
  decisionRecommendationSchema,
  decisionSummarySchema,
  humanDecisionReasonSchema,
} from "./humanDecisionGuidance.js";

/**
 * The one door an AI Employee's question comes through on its way to the
 * Decision stack. `request_decision` calls it; nothing else may create a
 * Decision on an employee's behalf (`decisionIntake.test.ts` holds every
 * other server file to that).
 *
 * In order:
 *  1. **Is the stack on?** Off refuses with a message that says what to do
 *     instead. No row, no screen, no model call.
 *  2. **Is the question well formed?** The same rules `createDecision`
 *     enforces, checked before a model is asked anything.
 *  3. **Is it new, and is there room?** A question that repeats one of the
 *     employee's own questions still waiting, or that would take it past
 *     the few it may hold at once, is refused with what to do instead
 *     (`decisionDuplicates.ts`). No row, no screen, no model call.
 *  4. **Does it belong?** The company's instructions screen it
 *     (`decisionScreening.ts`). Kept off: nothing is created, the employee is
 *     told why and what to do instead, and the outcome is recorded where
 *     people can tune their instructions. Any failure lets it through.
 *  5. **Stack it** — `createDecision`, which re-checks that the stack is
 *     still on at the moment of writing, then routes it under the company's
 *     decision policies and pages people exactly as before. Step 3 runs
 *     again first, since the screen can take a while and another question
 *     may have been stacked meanwhile.
 */

/** What an employee reads when the company has switched the stack off. */
export const DECISION_STACK_OFF_MESSAGE =
  "The Decision stack is turned off for this company, so you cannot raise new Decisions and nobody was asked. " +
  "Carry on without one: follow your instructions, Soul and company Policies; take only allowed steps you can easily undo; " +
  "record open questions and blocked work in your Workstream or work report so a person can pick them up; " +
  "and never take a consequential step you lack the authority for. " +
  "Required Approvals, email reviews and work reviews are unaffected.";

/** What an employee reads when the company's instructions keep a question off. */
export const KEPT_OFF_STACK_NOTE =
  "Your company's Decision stack instructions keep this question off the stack, so no Decision was created and nobody was asked. " +
  "Do not rephrase it or ask it again. Handle it within your own authority, Grants and company Policies: " +
  "if a choice is still needed, take the most cautious step you can easily undo and record your assumption in your Workstream or work report; " +
  "if no safe step exists, stop that line of work and note what is blocked there. " +
  "This check gives you no new authority: never take a consequential step you are not already allowed to take, " +
  "and required Approvals, email reviews and work reviews still apply.";

/** How a waiting question is named back to the employee: its title and id. */
function named(decision: WaitingDecision): string {
  return `“${decision.title}” (id ${decision.id})`;
}

const ALREADY_WAITING_LEAD: Record<DuplicateKind, string> = {
  same_question: "You already asked this and it is still waiting for an answer",
  same_work:
    "You already have a question waiting from this same piece of work (this Run, email thread or chat), " +
    "and each piece of work asks one combined question at a time",
  same_subject: "This Routine already has a question waiting about the same thing",
};

/** What an employee reads when it asks a question it already has waiting. */
export function alreadyWaitingNote(existing: WaitingDecision, match: DuplicateKind): string {
  return (
    `${ALREADY_WAITING_LEAD[match]}: ${named(existing)}. ` +
    "No new Decision was created and nobody was asked again. Do not ask it again. " +
    "Wait for the answer — list_decisions and get_decision read it. " +
    "If something material has changed, retract that one with cancel_decision and ask one combined question with the new facts; " +
    "otherwise keep new details in your Workstream or work report. " +
    "Until it is answered, take only allowed steps you can easily undo; required Approvals, email reviews and work reviews still apply."
  );
}

/** What an employee reads when it already holds as many waiting questions as it may. */
export function tooManyWaitingNote(waiting: WaitingDecision[], limit: number): string {
  return (
    `You already have ${waiting.length} questions waiting for people, and an AI Employee may hold at most ${limit} at once, ` +
    "so no Decision was created and nobody was asked. Do not ask it again now. " +
    `Waiting: ${waiting.map(named).join("; ")}. ` +
    "Wait for answers (list_decisions reads them). If one no longer matters, or this question matters more, retract it with " +
    "cancel_decision and ask one combined question. Meanwhile handle this within your own authority: take only allowed steps you " +
    "can easily undo, and record what is blocked in your Workstream or work report. " +
    "Required Approvals, email reviews and work reviews still apply."
  );
}

export type RaiseDecisionParams = {
  companyId: string;
  employeeId: string;
  /** The asking employee's row, when the caller already has it. */
  employee?: AIEmployee;
  title: string;
  body?: string;
  humanDecisionReason: string;
  /** One or two plain sentences for a busy owner. */
  summary?: string | null;
  /** The recommended answer and why, in one sentence. */
  recommendation?: string | null;
  options: DecisionOptionInput[];
  urgency?: DecisionUrgency;
  assigneeUserId?: string | null;
  routineId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  mailThreadId?: string | null;
  automaticContinuation?: boolean;
};

export type RaiseDecisionResult =
  | {
      outcome: "stacked";
      decision: Decision;
      options: DecisionOption[];
      screen: DecisionScreenOutcome;
    }
  | {
      outcome: "kept_off";
      title: string;
      screen: Extract<DecisionScreenOutcome, { outcome: "kept_off" }>;
    }
  | {
      /** The employee already has this question waiting; nothing was created. */
      outcome: "already_waiting";
      title: string;
      existing: WaitingDecision;
      match: DuplicateKind;
    }
  | {
      /** The employee already holds as many waiting questions as it may. */
      outcome: "too_many_waiting";
      title: string;
      waiting: WaitingDecision[];
      limit: number;
    }
  | { outcome: "stack_off" };

export type RaiseDecisionDependencies = {
  screen?: typeof screenDecision;
};

/** The question as it would be stacked, which is what the screen reads. */
function screenQuestion(params: RaiseDecisionParams, options: DecisionOption[]): {
  title: string;
  question: DecisionScreenQuestion;
} {
  // The same scrubbing `createDecision` applies, so the screen reads what the
  // stack would show and never a credential the employee happened to quote.
  const title = (redactApprovalSummary(params.title) ?? "").trim().slice(0, 200);
  if (!title) throw new Error("A decision needs a title.");
  if (options.length === 0) {
    throw new Error("A decision needs at least one option a human can choose.");
  }
  const humanDecisionReason = humanDecisionReasonSchema.parse(params.humanDecisionReason);
  // The short lines are optional (older tool lists omit them), but bounded when given.
  if (params.summary != null) decisionSummarySchema.parse(params.summary);
  if (params.recommendation != null) decisionRecommendationSchema.parse(params.recommendation);
  return {
    title,
    question: {
      title,
      humanDecisionReason: redactApprovalSummary(humanDecisionReason),
      body: redactApprovalSummary(params.body ?? "") ?? "",
      options: options.map((option) => ({ label: option.label, detail: option.detail })),
      urgency: params.urgency ?? "normal",
    },
  };
}

async function writeJournal(employeeId: string, title: string, body: string): Promise<void> {
  try {
    const provenance = currentAuditContext();
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title: title.slice(0, 500),
        body,
        runId: provenance?.runId ?? null,
        routineId: provenance?.routineId ?? null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // The outcome is already in the audit log and the tool result.
    // eslint-disable-next-line no-console
    console.warn("[decision-intake] journal write failed", err);
  }
}

/** A short record of the screen for the `decision.create` audit row. */
export function screenAuditSummary(screen: DecisionScreenOutcome): Record<string, unknown> {
  switch (screen.outcome) {
    case "allowed":
      return {
        outcome: "allowed",
        reason: screen.reason,
        ...(screen.instructionNumber ? { instructionNumber: screen.instructionNumber } : {}),
      };
    case "kept_off":
      return {
        outcome: "kept_off",
        reason: screen.reason,
        instructionNumber: screen.instructionNumber,
      };
    case "unscreened":
      return { outcome: "unscreened", cause: screen.cause, detail: screen.detail };
  }
}

export async function raiseDecision(
  params: RaiseDecisionParams,
  dependencies: RaiseDecisionDependencies = {},
): Promise<RaiseDecisionResult> {
  const state = await getDecisionStackState(params.companyId);
  if (state && !state.enabled) return { outcome: "stack_off" };

  const options = normalizeDecisionOptions(params.options);
  const { title, question } = screenQuestion(params, options);

  const employee =
    params.employee ??
    (await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: params.employeeId,
      companyId: params.companyId,
    }));
  if (!employee || employee.companyId !== params.companyId) {
    throw new Error("The asking AI Employee is not part of this company.");
  }

  // A repeat, or one question too many, is refused before any model is asked.
  const checkWaiting = async (): Promise<RaiseDecisionResult | null> => {
    const check = await checkWaitingDecisions({
      companyId: params.companyId,
      employeeId: employee.id,
      asked: {
        title,
        routineId: params.routineId,
        runId: params.runId,
        mailThreadId: params.mailThreadId,
        conversationId: params.conversationId,
      },
    });
    if (check.outcome === "already_waiting") {
      return { outcome: "already_waiting", title, existing: check.existing, match: check.match };
    }
    if (check.outcome === "too_many_waiting") {
      return { outcome: "too_many_waiting", title, waiting: check.waiting, limit: check.limit };
    }
    return null;
  };
  const refusedBefore = await checkWaiting();
  if (refusedBefore) return refusedBefore;

  const screen = await (dependencies.screen ?? screenDecision)({
    employee,
    instructionsText: state?.instructions ?? "",
    question,
  });

  if (screen.outcome === "kept_off") {
    await recordAudit({
      companyId: params.companyId,
      actorEmployeeId: employee.id,
      action: "decision.screen_out",
      targetType: "decision",
      targetId: null,
      targetLabel: title,
      metadata: {
        reason: screen.reason,
        instructionNumber: screen.instructionNumber,
        instruction: screen.instruction,
        instructionsDefault: state?.usingDefaultInstructions ?? true,
        urgency: question.urgency,
        options: options.map((option) => option.label),
      },
    });
    await writeJournal(
      employee.id,
      `Kept off the Decision stack: ${title}`,
      [
        `Reason: ${screen.reason}`,
        `Instruction ${screen.instructionNumber}: ${screen.instruction}`,
        "Nobody was asked. Handle it within your own authority, note any assumption in your Workstream or work report, and do not ask it again.",
      ].join("\n"),
    );
    return { outcome: "kept_off", title, screen };
  }

  // The screen can take a while; a question stacked meanwhile still counts.
  const refusedAfter = await checkWaiting();
  if (refusedAfter) return refusedAfter;

  try {
    const created = await createDecision({
      companyId: params.companyId,
      employeeId: employee.id,
      title: params.title,
      body: params.body,
      humanDecisionReason: params.humanDecisionReason,
      summary: params.summary,
      recommendation: params.recommendation,
      options: params.options,
      urgency: params.urgency,
      assigneeUserId: params.assigneeUserId,
      routineId: params.routineId,
      runId: params.runId,
      conversationId: params.conversationId,
      mailThreadId: params.mailThreadId,
      automaticContinuation: params.automaticContinuation,
      screening: screenAuditSummary(screen),
    });
    return { outcome: "stacked", ...created, screen };
  } catch (error) {
    // Switched off while the question was being checked: the switch wins.
    if (error instanceof DecisionStackOffError) return { outcome: "stack_off" };
    throw error;
  }
}
