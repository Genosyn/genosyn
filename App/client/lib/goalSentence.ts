import type { GoalDirection } from "./api";

/**
 * Reading a Goal out of one sentence.
 *
 * A company's first Goal is "a direction and a number", and the person writing
 * it has already said both in a sentence: "Reach 50 paying customers by
 * March". Everything here is a guess made from those words, so the form can
 * start the target, direction and unit filled in and leave the person to
 * correct them rather than fill in four fields. None of it is stored as a
 * guess: whatever the form holds when it is submitted is what the Goal gets.
 */

/** Mirrors the Goals route, which refuses a longer title or unit. */
export const GOAL_TITLE_MAX = 140;
export const GOAL_UNIT_MAX = 20;

export type ParsedGoalSentence = {
  /** The first number the sentence states, scaled ("$2M" is 2000000), or null. */
  target: number | null;
  direction: GoalDirection;
  /** "$", "%", or a short noun such as "customers"; empty when none was found. */
  unit: string;
};

const CURRENCY = "[$€£¥₹]";
const MAGNITUDES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  trillion: 1e12,
};

/** A run of digits, with thousands separators and a decimal part when present. */
const DIGITS = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** "10k", "2M", "1.5bn" glued to the number, or "2 million" spelled out beside it. */
const MAGNITUDE = new RegExp(
  "^(?:(k|m|bn|b)(?![A-Za-z0-9])|\\s?(thousand|million|billion|trillion)(?![A-Za-z0-9]))",
  "i",
);
const PERCENT = /^(?:\s?%|\s(?:percent|per cent)(?![A-Za-z]))/i;
const MONTH_BEFORE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*$/i;

type NumberMention = {
  value: number;
  /** Where the digits begin and where the number, with its suffix, ends. */
  start: number;
  end: number;
  currency: string | null;
  percent: boolean;
  /** A bare whole number that reads as a year or the day of a month. */
  dateLike: boolean;
};

/** Floating-point noise ("1.1k" is 1100.0000000000002) is not a target. */
function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

function findNumbers(text: string): NumberMention[] {
  const found: NumberMention[] = [];
  for (const match of text.matchAll(DIGITS)) {
    const start = match.index ?? 0;
    const digits = match[0];
    // Glued to a letter ("Q3", "v2", "B2B") or to a decimal point or comma
    // that is not part of this number: a label or a fragment, not a quantity.
    if (/[A-Za-z.,]/.test(text[start - 1] ?? "")) continue;

    let end = start + digits.length;
    let multiplier = 1;
    let scaled = false;
    const magnitude = MAGNITUDE.exec(text.slice(end));
    if (magnitude) {
      multiplier = MAGNITUDES[(magnitude[1] ?? magnitude[2]).toLowerCase()];
      end += magnitude[0].length;
      scaled = true;
    }
    const percent = PERCENT.exec(text.slice(end));
    if (percent) end += percent[0].length;
    // "1st", "10x", "5min", "3pm": still glued to a word, so not a number.
    if (/^[A-Za-z0-9]/.test(text.slice(end))) continue;

    const before = text.slice(0, start);
    const currency = new RegExp(`(${CURRENCY})\\s?$`).exec(before)?.[1] ?? null;
    const whole = !digits.includes(",") && !digits.includes(".");
    const plain = whole && !scaled && !percent && !currency;
    const amount = Number(digits.replace(/,/g, ""));
    const year = plain && digits.length === 4 && amount >= 1900 && amount <= 2100;
    const dayOfMonth = plain && amount >= 1 && amount <= 31 && MONTH_BEFORE.test(before);
    found.push({
      value: tidy(amount * multiplier),
      start,
      end,
      currency,
      percent: Boolean(percent),
      dateLike: year || dayOfMonth,
    });
  }
  return found;
}

/**
 * The number a sentence is about: the first one, unless it is a date ("In
 * 2026, reach 1,000 customers" is about 1,000). A sentence whose only number
 * looks like a date still gets it, since "Reach 2000 customers" means 2000.
 */
function pickNumber(mentions: NumberMention[]): NumberMention | null {
  return mentions.find((mention) => !mention.dateLike) ?? mentions[0] ?? null;
}

const DECREASE =
  /\b(?:reduc(?:e|es|ed|ing|tion)|cut(?:s|ting)?|lower(?:s|ed|ing)?|decreas(?:e|es|ed|ing)|(?:drive|drives|driving|drove|bring|brings|bringing|brought)\s+(?:[\w%$'’-]+\s+){0,3}?down|below|under|fewer|less|at most|no more than)\b/i;

/** Words that end a unit: the noun after the number stops where the sentence moves on. */
const STOP_WORDS = new Set(
  (
    "a an the by in on at to from for of and or but with without within before after until till " +
    "through during over under below above than as is are was were will be been we our my your " +
    "their its it into off out up down while when then so via per each every this that these " +
    "those next last about around roughly approximately"
  ).split(" "),
);
/** Words that can open a unit ("monthly active users") but not extend one ("customers monthly"). */
const TRAILING_STOP_WORDS = new Set(
  "daily weekly monthly quarterly yearly annually today tomorrow soon now total overall".split(" "),
);

function unitAfter(text: string): string {
  const words: string[] = [];
  let rest = text;
  while (words.length < 3) {
    const match = /^\s*([A-Za-z][A-Za-z'’-]*)/.exec(rest);
    if (!match) break;
    const word = match[1];
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) break;
    if (words.length > 0 && TRAILING_STOP_WORDS.has(lower)) break;
    words.push(word);
    rest = rest.slice(match[0].length);
  }
  while (words.length > 1 && words.join(" ").length > GOAL_UNIT_MAX) words.shift();
  return words.join(" ").slice(0, GOAL_UNIT_MAX);
}

/**
 * Read a Goal sentence: the first number it states, which way it should move,
 * and what it counts.
 *
 * - **Target:** "50", "2,000", "$2M", "10k", "1.5 million" and "40%" are all
 *   read, and a date or a label such as "Q3" is not mistaken for the target.
 * - **Direction:** `decrease_to` when the sentence says reduce, cut, lower,
 *   decrease, drive down, below, under, fewer or less; otherwise `increase_to`.
 * - **Unit:** the currency symbol or "%" the number carries, else the noun
 *   that follows it ("paying customers").
 */
export function parseGoalSentence(sentence: string): ParsedGoalSentence {
  const direction: GoalDirection = DECREASE.test(sentence) ? "decrease_to" : "increase_to";
  const mention = pickNumber(findNumbers(sentence));
  if (!mention) return { target: null, direction, unit: "" };
  const unit = mention.currency ?? (mention.percent ? "%" : unitAfter(sentence.slice(mention.end)));
  return { target: mention.value, direction, unit };
}

/**
 * What the Target field holds. Stricter than the sentence reader: the box is
 * for a number, so "1,5" or "50 customers" is refused instead of guessed at.
 * A leading minus is kept, since a target can be below zero.
 */
export function parseGoalTarget(text: string): number | null {
  const trimmed = text.trim();
  const mention = findNumbers(trimmed)[0];
  if (!mention) return null;
  const lead = trimmed.slice(0, mention.start);
  if (!new RegExp(`^-?\\s*(?:${CURRENCY})?\\s*$`).test(lead)) return null;
  if (trimmed.slice(mention.end).trim() !== "") return null;
  return lead.trim().startsWith("-") ? -mention.value : mention.value;
}

/** A target as the field shows it: plain digits, nothing a locale could misread. */
export function formatGoalTarget(value: number): string {
  return String(tidy(value));
}

/** The three details the form can fill in from the sentence, as the form holds them. */
export type GoalDetails = { target: string; direction: GoalDirection; unit: string };
/** Which details the person has changed by hand; those stop following the sentence. */
export type GoalDetailsEdited = Partial<Record<keyof GoalDetails, boolean>>;

/**
 * The details after the sentence changed: each one follows the sentence unless
 * the person has edited it, in which case their value stays.
 */
export function syncGoalDetails(
  sentence: string,
  current: GoalDetails,
  edited: GoalDetailsEdited,
): GoalDetails {
  const parsed = parseGoalSentence(sentence);
  return {
    target: edited.target
      ? current.target
      : parsed.target === null
        ? ""
        : formatGoalTarget(parsed.target),
    direction: edited.direction ? current.direction : parsed.direction,
    unit: edited.unit ? current.unit : parsed.unit,
  };
}

export type GoalDraft = GoalDetails & { sentence: string };
export type GoalPayload = {
  title: string;
  targetValue: number;
  direction: GoalDirection;
  unit: string;
};

/** The Goal to send, or the one sentence that says what is missing. */
export function buildGoalPayload(
  draft: GoalDraft,
): { ok: true; goal: GoalPayload } | { ok: false; error: string } {
  const title = draft.sentence.trim();
  if (!title) return { ok: false, error: "Write your Goal in a sentence." };
  if (title.length > GOAL_TITLE_MAX) {
    return { ok: false, error: `Keep your Goal to ${GOAL_TITLE_MAX} characters or fewer.` };
  }
  const targetValue = parseGoalTarget(draft.target);
  if (targetValue === null) return { ok: false, error: "Add a target number for your Goal." };
  const unit = draft.unit.trim();
  if (unit.length > GOAL_UNIT_MAX) {
    return { ok: false, error: `Keep the unit to ${GOAL_UNIT_MAX} characters or fewer.` };
  }
  return { ok: true, goal: { title, targetValue, direction: draft.direction, unit } };
}
