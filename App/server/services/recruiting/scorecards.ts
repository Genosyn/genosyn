import { z } from "zod";

import { AppDataSource } from "../../db/datasource.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import type { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import {
  RecruitingScorecard,
  type ScorecardAuthorKind,
  type ScorecardEvidence,
  type ScorecardRating,
} from "../../db/entities/RecruitingScorecard.js";
import {
  CRITERION_RATINGS,
  SCORE_LABEL_TEXT,
  computeScore,
  criteriaFingerprint,
  formatAnswerValue,
  type CriterionRating,
  type OpeningCriterion,
  type ScoreLabel,
} from "../../../shared/recruiting.js";
import { parseAnswers, parseCriteria, parseStringList } from "./content.js";
import { RecruitingValidationError } from "./errors.js";
import { recordApplicationEvent } from "./events.js";

/**
 * Scorecards: one reading of an Application against its Opening's criteria.
 *
 * Whoever writes one — the AI screener, another AI Employee, a Member — rates
 * each criterion and may quote the evidence. The server does the rest, and
 * that split is the point: the score is `computeScore` over the ratings, so
 * nobody types a number, and every quote is looked up in what the candidate
 * actually submitted, so a claim the application does not support is marked
 * on the page rather than believed.
 */

export const MAX_EVIDENCE_QUOTES = 3;
export const MAX_EVIDENCE_CHARS = 300;
export const MAX_SCORECARD_LIST_ITEMS = 5;

const ratingSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const scorecardRatingInputSchema = z
  .object({
    criterionId: z.string().trim().min(1).max(64),
    rating: ratingSchema.nullable(),
    evidence: z.array(z.string().trim().min(1).max(MAX_EVIDENCE_CHARS)).max(MAX_EVIDENCE_QUOTES).default([]),
    note: z.string().trim().max(400).default(""),
  })
  .strict();

const listItems = (max: number) =>
  z.array(z.string().trim().min(1).max(max)).max(MAX_SCORECARD_LIST_ITEMS).default([]);

export const scorecardInputSchema = z
  .object({
    ratings: z.array(scorecardRatingInputSchema).min(1).max(20),
    summary: z.string().trim().max(1_200).default(""),
    strengths: listItems(240),
    concerns: listItems(240),
    interviewQuestions: listItems(300),
    injectionDetected: z.boolean().default(false),
  })
  .strict();
export type ScorecardInput = z.input<typeof scorecardInputSchema>;

/** Text folded so a quote matches however the candidate punctuated or capitalized it. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a quote is in the application: exactly once folded, or — for a
 * quote of four or more words — at least four-fifths of it as one unbroken
 * run, which forgives a trimmed first or last word but not a paraphrase.
 * Matching is on whole words, so "Java" is not found in "JavaScript".
 */
export function quoteFound(quote: string, normalizedCorpus: string): boolean {
  const folded = normalizeForMatch(quote);
  if (!folded) return false;
  const haystack = ` ${normalizedCorpus} `;
  if (haystack.includes(` ${folded} `)) return true;
  const words = folded.split(" ");
  if (words.length < 4) return false;
  const shortest = Math.ceil(words.length * 0.8);
  for (let length = words.length - 1; length >= shortest; length--) {
    for (let start = 0; start + length <= words.length; start++) {
      if (haystack.includes(` ${words.slice(start, start + length).join(" ")} `)) return true;
    }
  }
  return false;
}

/**
 * The application as one text: what the screener reads and what quotes are
 * checked against. Pass the blinded text the screener saw, so a quote of
 * "[Candidate] led the team" still matches.
 */
export function applicationCorpus(application: {
  resumeText: string;
  coverLetter: string;
  answersJson: string;
  candidateLocation: string;
  websiteUrl: string;
}): string {
  const answers = parseAnswers(application.answersJson)
    .map((answer) => `${answer.label}: ${formatAnswerValue(answer)}`)
    .join("\n");
  return [
    application.candidateLocation,
    application.websiteUrl,
    answers,
    application.coverLetter,
    application.resumeText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type ScorecardAuthor =
  | { kind: "screener"; employeeId: string; name: string; modelLabel: string }
  | { kind: "employee"; employeeId: string; name: string }
  | { kind: "member"; userId: string; name: string };

/**
 * Validate and save a Scorecard. AI authors must rate every criterion — an
 * AI that skips one has not done the job — while a Member may leave a
 * criterion unrated when they have nothing to say about it.
 */
export async function recordScorecard(args: {
  application: RecruitingApplication;
  opening: RecruitingOpening;
  author: ScorecardAuthor;
  input: ScorecardInput;
  /** The text the author read; quotes are checked against it. */
  corpus?: string;
}): Promise<RecruitingScorecard> {
  const parsed = scorecardInputSchema.safeParse(args.input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecruitingValidationError(
      `The scorecard is invalid${issue ? ` (${issue.path.join(".") || "input"}: ${issue.message})` : ""}.`,
    );
  }
  const input = parsed.data;
  const criteria = parseCriteria(args.opening.criteriaJson);
  if (criteria.length === 0) {
    throw new RecruitingValidationError(
      "This Opening has no criteria yet, so there is nothing to score against. Add criteria first.",
    );
  }
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();
  for (const rating of input.ratings) {
    if (!byId.has(rating.criterionId)) {
      throw new RecruitingValidationError(
        `"${rating.criterionId}" is not one of this Opening's criteria. Use the ids from get_opening.`,
      );
    }
    if (seen.has(rating.criterionId)) {
      throw new RecruitingValidationError(`Rate "${byId.get(rating.criterionId)!.name}" only once.`);
    }
    seen.add(rating.criterionId);
  }
  if (args.author.kind !== "member") {
    const missing = criteria.filter((criterion) => !seen.has(criterion.id) );
    const unrated = input.ratings.filter((rating) => rating.rating === null);
    if (missing.length > 0 || unrated.length > 0) {
      const names = [
        ...missing.map((criterion) => criterion.name),
        ...unrated.map((rating) => byId.get(rating.criterionId)!.name),
      ];
      throw new RecruitingValidationError(
        `Rate every criterion, using 0 ("Not shown") when the application says nothing about it. Missing: ${names.join(", ")}.`,
      );
    }
  }

  const corpus = normalizeForMatch(args.corpus ?? applicationCorpus(args.application));
  let unverifiedQuotes = 0;
  const ratingsByCriterion = new Map(input.ratings.map((rating) => [rating.criterionId, rating]));
  const ratings: ScorecardRating[] = criteria.map((criterion) => {
    const given = ratingsByCriterion.get(criterion.id);
    const evidence: ScorecardEvidence[] = (given?.evidence ?? []).map((quote) => {
      const found = quoteFound(quote, corpus);
      if (!found) unverifiedQuotes += 1;
      return { quote, found };
    });
    return {
      criterionId: criterion.id,
      name: criterion.name,
      importance: criterion.importance,
      rating: given?.rating ?? null,
      evidence,
      note: given?.note ?? "",
    };
  });

  const result = computeScore(
    criteria,
    ratings
      .filter((rating): rating is ScorecardRating & { rating: CriterionRating } =>
        (CRITERION_RATINGS as readonly number[]).includes(rating.rating as number),
      )
      .map((rating) => ({ criterionId: rating.criterionId, rating: rating.rating })),
  );

  const repo = AppDataSource.getRepository(RecruitingScorecard);
  const scorecard = await repo.save(
    repo.create({
      companyId: args.application.companyId,
      openingId: args.opening.id,
      applicationId: args.application.id,
      authorKind: args.author.kind,
      authorEmployeeId: args.author.kind === "member" ? null : args.author.employeeId,
      authorUserId: args.author.kind === "member" ? args.author.userId : null,
      authorName: args.author.name.slice(0, 200),
      score: result.score,
      label: result.label,
      criteriaFingerprint: criteriaFingerprint(criteria),
      unverifiedQuotes,
      injectionDetected: input.injectionDetected,
      modelLabel: args.author.kind === "screener" ? args.author.modelLabel.slice(0, 200) : "",
      summary: input.summary,
      ratingsJson: JSON.stringify(ratings),
      strengthsJson: JSON.stringify(input.strengths),
      concernsJson: JSON.stringify(input.concerns),
      interviewQuestionsJson: JSON.stringify(input.interviewQuestions),
    }),
  );

  // The board and the list sort by the latest AI reading; a person's
  // Scorecard sits beside it rather than replacing it.
  if (args.author.kind !== "member") {
    await AppDataSource.getRepository(RecruitingApplication).update(
      { id: args.application.id },
      {
        score: result.score,
        scoreLabel: result.label,
        scoredAt: new Date(),
        latestScorecardId: scorecard.id,
        // Only ever raised, never cleared: the caller's copy of the Application
        // can predate a flag another reading set while this one was running.
        ...(input.injectionDetected ? { injectionFlag: true } : {}),
        ...(args.author.kind === "screener"
          ? { screenStatus: "scored" as const, screenError: "", screenStartedAt: null }
          : {}),
      },
    );
  }

  await recordApplicationEvent({
    application: args.application,
    kind: "scored",
    actor:
      args.author.kind === "member"
        ? { kind: "member", userId: args.author.userId, name: args.author.name }
        : { kind: "employee", employeeId: args.author.employeeId, name: args.author.name },
    body: input.summary,
    meta: {
      scorecardId: scorecard.id,
      score: result.score,
      label: result.label,
      authorKind: args.author.kind,
      missingMustHaves: result.missingMustHaves,
      unverifiedQuotes,
    },
  });
  return scorecard;
}

export type ScorecardDto = {
  id: string;
  authorKind: ScorecardAuthorKind;
  authorName: string;
  authorEmployeeId: string | null;
  authorUserId: string | null;
  score: number | null;
  label: ScoreLabel | null;
  labelText: string | null;
  summary: string;
  ratings: ScorecardRating[];
  strengths: string[];
  concerns: string[];
  interviewQuestions: string[];
  missingMustHaves: string[];
  partialMustHaves: string[];
  unverifiedQuotes: number;
  injectionDetected: boolean;
  modelLabel: string;
  /** The Opening's criteria changed after this was written. */
  criteriaChanged: boolean;
  createdAt: string;
};

function parseRatings(json: string): ScorecardRating[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as ScorecardRating[]) : [];
  } catch {
    return [];
  }
}

export function scorecardDto(scorecard: RecruitingScorecard, currentCriteria: OpeningCriterion[]): ScorecardDto {
  const ratings = parseRatings(scorecard.ratingsJson);
  return {
    id: scorecard.id,
    authorKind: scorecard.authorKind,
    authorName: scorecard.authorName,
    authorEmployeeId: scorecard.authorEmployeeId,
    authorUserId: scorecard.authorUserId,
    score: scorecard.score,
    label: scorecard.label,
    labelText: scorecard.label ? SCORE_LABEL_TEXT[scorecard.label] : null,
    summary: scorecard.summary,
    ratings,
    strengths: parseStringList(scorecard.strengthsJson),
    concerns: parseStringList(scorecard.concernsJson),
    interviewQuestions: parseStringList(scorecard.interviewQuestionsJson),
    missingMustHaves: ratings
      .filter((rating) => rating.importance === "must_have" && rating.rating === 0)
      .map((rating) => rating.name),
    partialMustHaves: ratings
      .filter((rating) => rating.importance === "must_have" && rating.rating === 1)
      .map((rating) => rating.name),
    unverifiedQuotes: scorecard.unverifiedQuotes,
    injectionDetected: scorecard.injectionDetected,
    modelLabel: scorecard.modelLabel,
    criteriaChanged: scorecard.criteriaFingerprint !== criteriaFingerprint(currentCriteria),
    createdAt: scorecard.createdAt.toISOString(),
  };
}

/** True once anyone, a person or an AI Employee, has scored this application. */
export async function hasScorecard(companyId: string, applicationId: string): Promise<boolean> {
  return AppDataSource.getRepository(RecruitingScorecard).exists({
    where: { companyId, applicationId },
  });
}

/**
 * An Application's Scorecards, newest first, in the same order every time.
 * `createdAt` has only the database's precision — a second on SQLite — so
 * Scorecards written in one instant are ordered by id, except that the
 * Application's current AI reading (`latestScorecardId`, when given) goes
 * first among them: a tie must never put an older AI reading ahead of the
 * one the Application's score came from.
 */
export async function listScorecards(
  applicationId: string,
  latestScorecardId?: string | null,
): Promise<RecruitingScorecard[]> {
  const rows = await AppDataSource.getRepository(RecruitingScorecard).find({
    where: { applicationId },
    order: { createdAt: "DESC", id: "DESC" },
    take: 100,
  });
  if (!latestScorecardId) return rows;
  const lifted = (row: RecruitingScorecard) => (row.id === latestScorecardId ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        b.row.createdAt.getTime() - a.row.createdAt.getTime() ||
        lifted(a.row) - lifted(b.row) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}
