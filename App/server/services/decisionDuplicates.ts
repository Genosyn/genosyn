import { AppDataSource } from "../db/datasource.js";
import { Decision } from "../db/entities/Decision.js";

/**
 * Keeping each AI Employee's questions few and distinct.
 *
 * The Decision stack is read by busy people, and the cost of a question is
 * paid by them, not by the employee that asks it. Two rules run at intake
 * (`decisionIntake.ts`), before a question is screened or stacked, so a
 * question that breaks one costs no model call and pages nobody:
 *
 *  - **Never the same question twice.** A question is refused, and the
 *    employee pointed at the one already waiting, when one of the same
 *    employee's questions still waiting
 *      - reads the same — the same words once filler and dates are set
 *        aside (`same_question`);
 *      - came from the same piece of work — the same Run, email thread or
 *        chat, which asks one combined question at a time (`same_work`); or
 *      - came from the same Routine and is about the same thing — the same
 *        customer, deal or reference, or mostly the same words
 *        (`same_subject`), since a Routine blocked on a question should not
 *        ask it again on its next Run.
 *  - **A few at a time.** One employee may hold at most
 *    {@link MAX_WAITING_DECISIONS_PER_EMPLOYEE} questions waiting at once.
 *    The next is refused with what to do instead: wait, retract one that
 *    matters less, or fold this one into a question already waiting.
 *
 * Matching by wording is deliberately conservative: two questions that name
 * different things — different customers, invoices, deals — never read as
 * the same, however alike the rest of their words are.
 *
 * Neither rule touches Approvals: email and work reviews are system gates
 * that each still get a human answer. Snoozed and AI-routed questions are
 * still waiting, so they count.
 */

/** The most questions one AI Employee may have waiting at once. */
export const MAX_WAITING_DECISIONS_PER_EMPLOYEE = 3;

/** Word overlap at which two questions read as the same question. */
export const SAME_QUESTION_SIMILARITY = 0.7;
/** Word overlap at which two questions from one Routine are about the same thing. */
export const SAME_SUBJECT_SIMILARITY = 0.5;

/** A waiting question, as much of it as matching needs (no body). */
export type WaitingDecision = Pick<
  Decision,
  "id" | "title" | "routineId" | "runId" | "mailThreadId" | "conversationId" | "createdAt"
>;

/** The question being asked, and where its employee was working. */
export type AskedQuestion = {
  title: string;
  routineId?: string | null;
  runId?: string | null;
  mailThreadId?: string | null;
  conversationId?: string | null;
};

export type DuplicateKind = "same_question" | "same_work" | "same_subject";

export type DuplicateMatch = { decision: WaitingDecision; match: DuplicateKind };

/**
 * Words that frame a question rather than say what it is about — "Decide …",
 * "Should we …", "Choose the … for …" — so two phrasings of one question
 * compare on their subject.
 */
const FRAMING_WORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "on",
  "in",
  "at",
  "by",
  "with",
  "and",
  "or",
  "we",
  "our",
  "us",
  "i",
  "my",
  "you",
  "your",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "be",
  "is",
  "are",
  "do",
  "does",
  "should",
  "shall",
  "would",
  "can",
  "could",
  "will",
  "whether",
  "if",
  "about",
  "from",
  "vs",
  "versus",
  "decide",
  "decision",
  "choose",
  "choice",
  "pick",
  "confirm",
  "which",
  "what",
  "how",
  "now",
  "please",
]);

/** A word as it compares: lower case, without a possessive or a plural `s`. */
function stem(word: string): string {
  const lower = word.toLocaleLowerCase().replace(/['’]s$/u, "");
  return lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")
    ? lower.slice(0, -1)
    : lower;
}

function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

/** A bare number — usually a date, a time or an amount a later question restates. */
function bareNumber(word: string): boolean {
  return /^[\p{N}.,:'’-]+$/u.test(word);
}

/** What a question is about: its words, stemmed, without framing words or bare numbers. */
export function questionWords(text: string): Set<string> {
  return new Set(
    tokens(text)
      .filter((word) => !bareNumber(word))
      .map(stem)
      .filter((word) => word && !FRAMING_WORDS.has(word)),
  );
}

/**
 * The names and references a question is about — a customer, a product, an
 * invoice or RFP number — read as capitalized words after the first, and
 * words that mix letters and digits.
 */
export function subjectWords(text: string): Set<string> {
  const subjects = new Set<string>();
  tokens(text).forEach((word, index) => {
    if (bareNumber(word)) return;
    const mixed = /\p{L}/u.test(word) && /\p{N}/u.test(word);
    const named = index > 0 && /^\p{Lu}/u.test(word) && !FRAMING_WORDS.has(stem(word));
    if (mixed || named) subjects.add(stem(word));
  });
  return subjects;
}

/** Shared words over all words (Jaccard), 0–1. */
export function questionSimilarity(a: string, b: string): number {
  const left = questionWords(a);
  const right = questionWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

function sharedCount(left: Set<string>, right: Set<string>): number {
  return [...left].filter((word) => right.has(word)).length;
}

/** Each names something the other does not: two questions about two different things. */
export function differentSubjects(a: string, b: string): boolean {
  const left = subjectWords(a);
  const right = subjectWords(b);
  return [...left].some((word) => !right.has(word)) && [...right].some((word) => !left.has(word));
}

function sameWording(asked: string, waiting: string): boolean {
  const left = questionWords(asked);
  const right = questionWords(waiting);
  if (left.size === 0 || right.size === 0) return false;
  const exact = left.size === right.size && sharedCount(left, right) === left.size;
  if (exact) return true;
  if (differentSubjects(asked, waiting)) return false;
  return (
    sharedCount(left, right) >= 2 && questionSimilarity(asked, waiting) >= SAME_QUESTION_SIMILARITY
  );
}

function sameSubject(asked: string, waiting: string): boolean {
  if (differentSubjects(asked, waiting)) return false;
  if (sharedCount(subjectWords(asked), subjectWords(waiting)) > 0) return true;
  return (
    sharedCount(questionWords(asked), questionWords(waiting)) >= 2 &&
    questionSimilarity(asked, waiting) >= SAME_SUBJECT_SIMILARITY
  );
}

function sameWork(asked: AskedQuestion, waiting: WaitingDecision): boolean {
  return (
    (!!asked.runId && asked.runId === waiting.runId) ||
    (!!asked.mailThreadId && asked.mailThreadId === waiting.mailThreadId) ||
    (!!asked.conversationId && asked.conversationId === waiting.conversationId)
  );
}

const PRIORITY: Record<DuplicateKind, number> = { same_question: 0, same_work: 1, same_subject: 2 };

/**
 * The waiting question this one repeats, if any. The most specific match
 * wins — the same wording, then the same piece of work, then the same
 * Routine's subject — and the oldest on a tie, so the employee is pointed at
 * the question people have been looking at longest.
 */
export function findDuplicateDecision(
  asked: AskedQuestion,
  waiting: WaitingDecision[],
): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;
  const ordered = [...waiting].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const decision of ordered) {
    const match: DuplicateKind | null = sameWording(asked.title, decision.title)
      ? "same_question"
      : sameWork(asked, decision)
        ? "same_work"
        : !!asked.routineId &&
            asked.routineId === decision.routineId &&
            sameSubject(asked.title, decision.title)
          ? "same_subject"
          : null;
    if (match && (!best || PRIORITY[match] < PRIORITY[best.match])) best = { decision, match };
  }
  return best;
}

/**
 * The employee's questions still waiting, oldest first. Reads only the short
 * columns it matches on, so a long body or pickup log is never loaded to
 * answer it.
 */
export async function waitingDecisionsOf(
  companyId: string,
  employeeId: string,
): Promise<WaitingDecision[]> {
  return AppDataSource.getRepository(Decision).find({
    select: {
      id: true,
      title: true,
      routineId: true,
      runId: true,
      mailThreadId: true,
      conversationId: true,
      createdAt: true,
    },
    where: { companyId, employeeId, status: "pending" },
    order: { createdAt: "ASC" },
    take: 200,
  });
}

export type WaitingCheck =
  | { outcome: "clear" }
  | { outcome: "already_waiting"; existing: WaitingDecision; match: DuplicateKind }
  | { outcome: "too_many_waiting"; waiting: WaitingDecision[]; limit: number };

/**
 * Whether this employee may stack this question now. A repeat is reported
 * before the limit, because "you already asked this" is the more useful
 * thing to be told.
 */
export async function checkWaitingDecisions(params: {
  companyId: string;
  employeeId: string;
  asked: AskedQuestion;
}): Promise<WaitingCheck> {
  const waiting = await waitingDecisionsOf(params.companyId, params.employeeId);
  const duplicate = findDuplicateDecision(params.asked, waiting);
  if (duplicate) {
    return { outcome: "already_waiting", existing: duplicate.decision, match: duplicate.match };
  }
  if (waiting.length >= MAX_WAITING_DECISIONS_PER_EMPLOYEE) {
    return { outcome: "too_many_waiting", waiting, limit: MAX_WAITING_DECISIONS_PER_EMPLOYEE };
  }
  return { outcome: "clear" };
}
