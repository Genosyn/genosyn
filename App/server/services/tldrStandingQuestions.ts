import { IsNull, LessThanOrEqual, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrStandingQuestion } from "../db/entities/TldrStandingQuestion.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import {
  MAX_QUESTIONS_PER_TLDR,
  runTldrQuestionTurn,
  TLDR_QUESTION_PROMPT_MAX_CHARS,
} from "./tldrQuestions.js";

/**
 * The company's standing questions, and the pass that answers them.
 *
 * A brief says what happened. The questions worth asking about it are usually
 * the same every week — "what should we stop doing?", "what needs a decision
 * from me?" — and asking them by hand on every brief is exactly the kind of
 * remembering people stop doing by the third Tuesday. Configured once at TLDR
 * settings, they answer themselves: the moment a brief goes ready, the writing
 * employee works through the list and posts each answer as its own card under
 * the brief, with buttons already attached.
 *
 * The pass is deliberately unremarkable about authority. Each answer runs the
 * same restricted, zero-tool path a Member-asked card's opening answer runs,
 * so a company that configures ten standing questions has not given its
 * summarizer ten new ways to act — it has asked it ten questions.
 */

/** Standing questions per company. Each one costs model turns on every brief. */
export const MAX_STANDING_QUESTIONS = 8;

/**
 * How far back the recovery sweep will look for a brief that never got its
 * cards. Long enough to survive a restart or a model outage, short enough that
 * turning standing questions on today does not back-fill last month.
 */
const STANDING_SWEEP_WINDOW_MS = 6 * 60 * 60_000;

/** Briefs finished per sweep tick. The pass itself is several model calls each. */
const MAX_SWEPT_TLDRS_PER_TICK = 2;

export type TldrStandingQuestionDTO = {
  id: string;
  prompt: string;
  enabled: boolean;
  position: number;
};

export class TldrStandingQuestionValidationError extends Error {
  readonly status = 400;
}

export function serializeStandingQuestion(row: TldrStandingQuestion): TldrStandingQuestionDTO {
  return { id: row.id, prompt: row.prompt, enabled: row.enabled, position: row.position };
}

export async function listStandingQuestions(
  companyId: string,
): Promise<TldrStandingQuestionDTO[]> {
  const rows = await AppDataSource.getRepository(TldrStandingQuestion).find({
    where: { companyId },
    order: { position: "ASC", createdAt: "ASC" },
  });
  return rows.map(serializeStandingQuestion);
}

export type StandingQuestionInput = {
  /** Present for a question that already exists; absent creates one. */
  id?: string | null;
  prompt: string;
  enabled: boolean;
};

/**
 * Replace the whole list in one write.
 *
 * The settings page edits these as a list with one Save, so the honest server
 * shape is a list with one write: reordering three questions and deleting a
 * fourth is one intent, and splitting it into four requests would make a
 * half-applied save a thing that can happen.
 */
export async function replaceStandingQuestions(params: {
  companyId: string;
  userId: string | null;
  questions: StandingQuestionInput[];
}): Promise<TldrStandingQuestionDTO[]> {
  const cleaned: Array<{ id: string | null; prompt: string; enabled: boolean }> = [];
  const seen = new Set<string>();
  for (const input of params.questions) {
    const prompt = redactSensitiveText(input.prompt).trim().slice(0, TLDR_QUESTION_PROMPT_MAX_CHARS);
    if (!prompt) continue;
    // Two identical standing questions would answer twice and read as a bug.
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ id: input.id ?? null, prompt, enabled: input.enabled });
  }
  if (cleaned.length > MAX_STANDING_QUESTIONS) {
    throw new TldrStandingQuestionValidationError(
      `Keep at most ${MAX_STANDING_QUESTIONS} standing questions. Remove one before adding another.`,
    );
  }

  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(TldrStandingQuestion);
    const existing = await repo.findBy({ companyId: params.companyId });
    const byId = new Map(existing.map((row) => [row.id, row]));
    const keep = new Set<string>();

    for (const [position, input] of cleaned.entries()) {
      const current = input.id ? byId.get(input.id) : undefined;
      if (current) {
        keep.add(current.id);
        current.prompt = input.prompt;
        current.enabled = input.enabled;
        current.position = position;
        await repo.save(current);
        continue;
      }
      // An id we do not recognise is a stale client, not an instruction to
      // reach into another company. Treated as a new question here.
      const created = await repo.save(
        repo.create({
          companyId: params.companyId,
          prompt: input.prompt,
          enabled: input.enabled,
          position,
          createdByUserId: params.userId,
        }),
      );
      keep.add(created.id);
    }

    for (const row of existing) {
      if (!keep.has(row.id)) await repo.delete({ id: row.id });
    }
  });

  return listStandingQuestions(params.companyId);
}

// ───────────────────────────── the pass ─────────────────────────────

export type StandingAnswerDependencies = {
  runTurn?: typeof runTldrQuestionTurn;
  now?: () => Date;
};

export type StandingSweepDependencies = StandingAnswerDependencies & {
  /** How a swept briefing is handed off. Production never waits for one. */
  dispatch?: (tldrId: string) => void;
};

/**
 * Claim this brief's standing-question pass.
 *
 * The stamp is the durable cursor. Written before the model runs rather than
 * after, so a crash mid-pass leaves a brief with some of its cards instead of
 * a sweep that starts the whole list again and posts the first two twice.
 * Returns false when another process already holds the claim.
 */
async function claimStandingPass(tldrId: string, now: Date): Promise<boolean> {
  const result = await AppDataSource.getRepository(Tldr).update(
    { id: tldrId, status: "ready", standingAnsweredAt: IsNull() },
    { standingAnsweredAt: now },
  );
  return (result.affected ?? 0) > 0;
}

/**
 * Answer this company's standing questions on one freshly-posted brief.
 *
 * Sequential on purpose. These are several turns against one employee's one
 * model, and firing them together buys a few seconds on a background job in
 * exchange for rate-limit errors on a page nobody is watching yet.
 *
 * Never throws. A brief with three of its five cards is a better outcome than
 * a generation that reports failure for work that already succeeded, and each
 * card that did fail says so in its own thread where the answer would be.
 */
export async function answerStandingQuestions(
  tldrId: string,
  dependencies: StandingAnswerDependencies = {},
): Promise<number> {
  const now = dependencies.now?.() ?? new Date();
  const tldr = await AppDataSource.getRepository(Tldr).findOneBy({ id: tldrId, status: "ready" });
  if (!tldr) return 0;

  const questions = await AppDataSource.getRepository(TldrStandingQuestion).find({
    where: { companyId: tldr.companyId, enabled: true },
    order: { position: "ASC", createdAt: "ASC" },
  });
  if (questions.length === 0) {
    await claimStandingPass(tldr.id, now);
    return 0;
  }
  if (!(await claimStandingPass(tldr.id, now))) return 0;

  const runTurn = dependencies.runTurn ?? runTldrQuestionTurn;
  // The per-brief card ceiling is shared with anything a Member asked in the
  // seconds before this pass claimed the brief, so the pass takes what is left
  // rather than the whole list — and the turn's own check is the backstop.
  const existing = await AppDataSource.getRepository(TldrQuestion).countBy({
    companyId: tldr.companyId,
    tldrId: tldr.id,
  });
  const room = Math.max(0, MAX_QUESTIONS_PER_TLDR - existing);
  let answered = 0;
  for (const question of questions.slice(0, room)) {
    try {
      await runTurn({
        companyId: tldr.companyId,
        tldrId: tldr.id,
        prompt: question.prompt,
        origin: "standing",
        standingQuestionId: question.id,
        userId: null,
      });
      answered += 1;
    } catch (error) {
      console.error(
        `[tldr:standing] could not answer question=${question.id} tldr=${tldr.id}`,
        error,
      );
    }
  }
  return answered;
}

/**
 * Kick the pass off without making a caller wait for it.
 *
 * Generation returns as soon as the brief is readable; its standing questions
 * are minutes of model time that belong behind it, not in front of the request
 * that asked for a brief.
 */
export function scheduleStandingQuestions(
  tldrId: string,
  dependencies: StandingAnswerDependencies = {},
): void {
  void answerStandingQuestions(tldrId, dependencies).catch((error) => {
    console.error(`[tldr:standing] pass failed tldr=${tldrId}`, error);
  });
}

/**
 * Briefs that went ready but never got their cards, because the process that
 * owed them died first. Bounded by {@link STANDING_SWEEP_WINDOW_MS} so
 * configuring standing questions today never back-fills old history.
 *
 * Finds and hands off; deliberately does not wait. This runs inside the cron
 * heartbeat, which holds the scheduler lease and the re-entrancy guard for as
 * long as its body takes — and a pass is up to eight sequential model turns
 * per brief. Awaiting that here would stall every other scheduler phase behind
 * prose generation, which is the exact trade `dispatchDueTldrs` already
 * refuses to make. Each pass claims its own brief before its first model call,
 * so the next tick cannot pick up one that is already running.
 *
 * Returns the briefings handed off, not the questions answered.
 */
export async function sweepPendingStandingQuestions(
  now: Date = new Date(),
  dependencies: StandingSweepDependencies = {},
): Promise<number> {
  const pending = await AppDataSource.getRepository(Tldr).find({
    where: {
      status: "ready",
      standingAnsweredAt: IsNull(),
      createdAt: MoreThanOrEqual(new Date(now.getTime() - STANDING_SWEEP_WINDOW_MS)),
    },
    order: { createdAt: "ASC" },
    take: MAX_SWEPT_TLDRS_PER_TICK,
  });
  const dispatch =
    dependencies.dispatch ?? ((tldrId: string) => scheduleStandingQuestions(tldrId, dependencies));
  for (const tldr of pending) dispatch(tldr.id);
  return pending.length;
}

/**
 * Briefs older than the sweep window that never got their cards.
 *
 * Stamped rather than answered: leaving them null would make the sweep's
 * bounded query re-scan the same permanently-unanswerable rows on every tick.
 */
export async function retireStaleStandingClaims(now: Date = new Date()): Promise<number> {
  const result = await AppDataSource.getRepository(Tldr).update(
    {
      status: "ready",
      standingAnsweredAt: IsNull(),
      createdAt: LessThanOrEqual(new Date(now.getTime() - STANDING_SWEEP_WINDOW_MS)),
    },
    { standingAnsweredAt: now },
  );
  return result.affected ?? 0;
}
