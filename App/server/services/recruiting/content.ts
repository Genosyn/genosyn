import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  CRITERION_IMPORTANCES,
  DEFAULT_OPENING_FORM,
  FORM_FIELD_MODES,
  MAX_ANSWER_CHARS,
  MAX_OPENING_CRITERIA,
  MAX_OPENING_QUESTIONS,
  MAX_QUESTION_OPTIONS,
  OPENING_QUESTION_KINDS,
  normalizeOpeningForm,
  type ApplicationAnswer,
  type OpeningCriterion,
  type OpeningFormSettings,
  type OpeningQuestion,
} from "../../../shared/recruiting.js";
import { RecruitingValidationError } from "./errors.js";

/**
 * The structured parts of an Opening — its criteria, its questions and which
 * standard fields its form asks for — as they cross every seam: the schemas
 * the routes and the MCP tools validate input with, the normalizers that give
 * new rows stable ids, and the tolerant readers for what is already stored.
 *
 * Stored JSON is read defensively on purpose. A row written by an older
 * release, or hand-edited, must degrade to "fewer criteria" rather than take
 * down a careers page or a screening.
 */

/** Ids Recruiting mints are UUIDs; ids it accepts back are any short, URL-safe token. */
const itemIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use the id the Opening returned, or leave it out for a new one");

export const criterionInputSchema = z
  .object({
    id: itemIdSchema.optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600).default(""),
    importance: z.enum(CRITERION_IMPORTANCES).default("important"),
  })
  .strict();
export type CriterionInput = z.input<typeof criterionInputSchema>;

export const criteriaInputSchema = z.array(criterionInputSchema).max(MAX_OPENING_CRITERIA);

export const questionInputSchema = z
  .object({
    id: itemIdSchema.optional(),
    label: z.string().trim().min(1).max(300),
    help: z.string().trim().max(500).default(""),
    kind: z.enum(OPENING_QUESTION_KINDS),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).max(MAX_QUESTION_OPTIONS).default([]),
  })
  .strict();
export type QuestionInput = z.input<typeof questionInputSchema>;

export const questionsInputSchema = z.array(questionInputSchema).max(MAX_OPENING_QUESTIONS);

const formModeSchema = z.enum(FORM_FIELD_MODES);
export const formInputSchema = z
  .object({
    phone: formModeSchema.optional(),
    location: formModeSchema.optional(),
    linkedin: formModeSchema.optional(),
    website: formModeSchema.optional(),
    resume: z.enum(["required", "optional"]).optional(),
    coverLetter: formModeSchema.optional(),
  })
  .strict();
export type FormInput = z.infer<typeof formInputSchema>;

function uniqueId(candidate: string | undefined, taken: Set<string>): string {
  const id = candidate && !taken.has(candidate) ? candidate : randomUUID();
  taken.add(id);
  return id;
}

/**
 * Validated criteria with an id each. A criterion that keeps its id keeps its
 * history: Scorecards rate by id, so renaming "TypeScript" to "TypeScript and
 * Node" still lines up with the ratings already given.
 */
export function normalizeCriteria(input: CriterionInput[]): OpeningCriterion[] {
  const parsed = criteriaInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingValidationError(
      `Criteria are invalid: ${parsed.error.issues[0]?.message ?? "check each name and importance"}`,
    );
  }
  const taken = new Set<string>();
  const names = new Set<string>();
  return parsed.data.map((criterion) => {
    const key = criterion.name.toLowerCase();
    if (names.has(key)) {
      throw new RecruitingValidationError(`Two criteria are both called "${criterion.name}".`);
    }
    names.add(key);
    return {
      id: uniqueId(criterion.id, taken),
      name: criterion.name,
      description: criterion.description,
      importance: criterion.importance,
    };
  });
}

export function normalizeQuestions(input: QuestionInput[]): OpeningQuestion[] {
  const parsed = questionsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingValidationError(
      `Questions are invalid: ${parsed.error.issues[0]?.message ?? "check each question"}`,
    );
  }
  const taken = new Set<string>();
  return parsed.data.map((question) => {
    const selects = question.kind === "single_select" || question.kind === "multi_select";
    const options = selects ? [...new Set(question.options)] : [];
    if (selects && options.length < 2) {
      throw new RecruitingValidationError(
        `"${question.label}" needs at least two different choices.`,
      );
    }
    return {
      id: uniqueId(question.id, taken),
      label: question.label,
      help: question.help,
      kind: question.kind,
      required: question.required,
      options,
    };
  });
}

export function mergeForm(current: OpeningFormSettings, patch: FormInput): OpeningFormSettings {
  return normalizeOpeningForm({ ...current, ...patch });
}

function parseArray(json: string): unknown[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Stored criteria, skipping anything that no longer parses. */
export function parseCriteria(json: string): OpeningCriterion[] {
  const result: OpeningCriterion[] = [];
  const taken = new Set<string>();
  for (const item of parseArray(json)) {
    const parsed = criterionInputSchema.safeParse(item);
    if (!parsed.success || !parsed.data.id || taken.has(parsed.data.id)) continue;
    taken.add(parsed.data.id);
    result.push({
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      importance: parsed.data.importance,
    });
  }
  return result.slice(0, MAX_OPENING_CRITERIA);
}

export function parseQuestions(json: string): OpeningQuestion[] {
  const result: OpeningQuestion[] = [];
  const taken = new Set<string>();
  for (const item of parseArray(json)) {
    const parsed = questionInputSchema.safeParse(item);
    if (!parsed.success || !parsed.data.id || taken.has(parsed.data.id)) continue;
    taken.add(parsed.data.id);
    result.push({
      id: parsed.data.id,
      label: parsed.data.label,
      help: parsed.data.help,
      kind: parsed.data.kind,
      required: parsed.data.required,
      options: parsed.data.options,
    });
  }
  return result.slice(0, MAX_OPENING_QUESTIONS);
}

export function parseForm(json: string): OpeningFormSettings {
  try {
    return normalizeOpeningForm(JSON.parse(json));
  } catch {
    return { ...DEFAULT_OPENING_FORM };
  }
}

export function parseAnswers(json: string): ApplicationAnswer[] {
  return parseArray(json).filter(
    (item): item is ApplicationAnswer =>
      !!item &&
      typeof item === "object" &&
      typeof (item as ApplicationAnswer).questionId === "string" &&
      typeof (item as ApplicationAnswer).label === "string",
  );
}

export function parseStringList(json: string): string[] {
  return parseArray(json).filter((item): item is string => typeof item === "string");
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/**
 * A web address a candidate typed, normalized, or null when it is not one.
 *
 * Only `scheme://` counts as a scheme, so `example.com:8080/work` is a host
 * and a port, not a URL with the scheme `example.com`. An address carrying a
 * user name or password is refused: `https://www.linkedin.com@evil.example/`
 * reads as a LinkedIn link and opens somewhere else.
 */
export function normalizeWebUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!HTTP_URL.test(withScheme) || withScheme.length > 500) return null;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Check a candidate's answers against the Opening's questions. Answers to
 * questions the Opening does not ask are dropped, never stored; each answer is
 * stored with the question as it was asked.
 */
export function validateAnswers(
  questions: OpeningQuestion[],
  raw: Record<string, unknown>,
): { answers: ApplicationAnswer[]; errors: Record<string, string> } {
  const answers: ApplicationAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const question of questions) {
    // Own properties only: a question id may be any short token, `constructor`
    // included, and an answer the candidate did not give must read as missing
    // rather than as whatever `Object.prototype` holds under that name.
    const value = Object.hasOwn(raw, question.id) ? raw[question.id] : undefined;
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (question.required) errors[question.id] = "This question needs an answer.";
      answers.push({ questionId: question.id, label: question.label, kind: question.kind, value: null });
      continue;
    }
    const fail = (message: string) => {
      errors[question.id] = message;
    };
    switch (question.kind) {
      case "short_text":
      case "long_text": {
        if (typeof value !== "string") {
          fail("Answer with text.");
          break;
        }
        const limit = question.kind === "short_text" ? 500 : MAX_ANSWER_CHARS;
        const text = value.trim();
        if (text.length > limit) {
          fail(`Keep this under ${limit.toLocaleString("en-US")} characters.`);
          break;
        }
        answers.push({ questionId: question.id, label: question.label, kind: question.kind, value: text });
        break;
      }
      case "yes_no": {
        const answer =
          typeof value === "boolean"
            ? value
            : value === "yes" || value === "true"
              ? true
              : value === "no" || value === "false"
                ? false
                : null;
        if (answer === null) {
          fail("Answer yes or no.");
          break;
        }
        answers.push({ questionId: question.id, label: question.label, kind: question.kind, value: answer });
        break;
      }
      case "single_select": {
        if (typeof value !== "string" || !question.options.includes(value)) {
          fail("Pick one of the choices.");
          break;
        }
        answers.push({ questionId: question.id, label: question.label, kind: question.kind, value });
        break;
      }
      case "multi_select": {
        const list = Array.isArray(value) ? value : [value];
        if (!list.every((item) => typeof item === "string" && question.options.includes(item))) {
          fail("Pick from the choices given.");
          break;
        }
        answers.push({
          questionId: question.id,
          label: question.label,
          kind: question.kind,
          value: [...new Set(list as string[])],
        });
        break;
      }
      case "number": {
        const number = typeof value === "number" ? value : Number(String(value).trim());
        if (!Number.isFinite(number) || Math.abs(number) > 1e12) {
          fail("Answer with a number.");
          break;
        }
        answers.push({ questionId: question.id, label: question.label, kind: question.kind, value: number });
        break;
      }
      case "url": {
        const url = typeof value === "string" ? normalizeWebUrl(value) : null;
        if (!url) {
          fail("Answer with a web address, like https://example.com.");
          break;
        }
        answers.push({ questionId: question.id, label: question.label, kind: question.kind, value: url });
        break;
      }
    }
  }
  return { answers, errors };
}
