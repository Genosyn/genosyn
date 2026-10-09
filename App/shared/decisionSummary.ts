/**
 * The few plain lines the Decision stack shows for a question before anyone
 * opens its details: the question itself, one line about what is going on,
 * and what the asking employee recommends — and, once it is answered, one
 * line about how it went.
 *
 * New Decisions carry a short `summary` and `recommendation` the employee
 * wrote for a busy owner (`request_decision`). Older rows do not, so the same
 * lines are derived from what they do carry: the first sentence of the stated
 * reason, the option marked as the recommendation, the last paragraph of the
 * pickup log. Everything here is plain text and pure, shared by the server
 * (which stores the lines) and the client (which derives them for old rows).
 */
import { parseDecisionContext } from "./decisionContext.js";

/** The longest `summary` an employee may write: one or two short sentences. */
export const DECISION_SUMMARY_MAX = 200;
/** The longest `recommendation`: the recommended answer and why, in one sentence. */
export const DECISION_RECOMMENDATION_MAX = 160;
/** Fewer than this and a summary says nothing a title did not. */
export const DECISION_SUMMARY_MIN = 15;
/** Where a derived line is cut. */
export const DERIVED_LINE_MAX = 200;

/** One line of text: control characters and runs of whitespace become one space. */
export function oneLine(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Cut `text` to at most `max` characters, at a word where one is close, with
 * an ellipsis. Never splits a surrogate pair.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(max * 0.6)) cut = cut.slice(0, space);
  cut = cut.replace(/[\uD800-\uDBFF]$/, "").replace(/[\s,;:–—-]+$/, "");
  return `${cut}…`;
}

/**
 * Markdown read as plain text, closely enough for a one-line preview: code
 * blocks drop out, links keep their words, and heading, quote, list and
 * emphasis marks go. Line breaks are kept so paragraphs can still be found.
 */
export function plainText(markdown: string): string {
  const withoutCode = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\1[^\n]*|(?![\s\S]))/gm, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");
  return withoutCode
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#+\s*$/, "")
        .replace(/^\s*(?:>\s?)+/, "")
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Words a full stop follows without ending a sentence. */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "approx",
  "incl",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "inc",
  "ltd",
  "co",
  "corp",
  "no",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "a.m",
  "p.m",
  "u.s",
  "u.k",
]);

/** The paragraphs of plain text, each joined into one line. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => oneLine(paragraph))
    .filter(Boolean);
}

/**
 * The first sentence of `text` (markdown is read as plain text), cut to `max`.
 * A sentence ends at `.`, `!` or `?` followed by a capital, a digit, a quote
 * or the end — not after "e.g." or "Oct." — or at the end of its paragraph.
 */
export function firstSentence(text: string | null | undefined, max = DERIVED_LINE_MAX): string {
  const paragraph = paragraphs(plainText(text ?? ""))[0] ?? "";
  for (const match of paragraph.matchAll(/[.!?]+(?=\s|$)/g)) {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    const word = (/([\p{L}.]+)$/u.exec(paragraph.slice(0, at))?.[1] ?? "").toLowerCase();
    if (match[0] === "." && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word))) continue;
    const rest = paragraph.slice(end).trimStart();
    if (rest && !/^[\p{Lu}\p{N}"“'‘([]/u.test(rest)) continue;
    return clip(paragraph.slice(0, end), max);
  }
  return clip(paragraph, max);
}

/**
 * The last paragraph of a pickup log — where an employee's report lands when
 * it narrated its steps on the way there. A log without blank lines is read
 * line by line once it runs past a few lines.
 */
export function lastParagraph(text: string | null | undefined): string | null {
  const blocks = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const last = blocks.at(-1);
  if (!last) return null;
  if (blocks.length > 1) return last;
  const lines = last
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 3 ? (lines.at(-1) ?? null) : last;
}

export type DecisionHeadlineInput = {
  title: string;
  body: string;
  summary?: string | null;
  recommendation?: string | null;
  options: { id: string; label: string; detail: string | null; tone: string }[];
};

export type DecisionHeadline = {
  /** The question, as the employee titled it. */
  question: string;
  /** One plain line under the question, or null when nothing useful is there. */
  summary: string | null;
  /** True when `summary` was derived from an older row's reason or context. */
  summaryDerived: boolean;
  /** What "Recommends:" reads, or null when the employee recommended nothing. */
  recommendation: string | null;
  /** The option the employee marked as its recommendation. */
  recommendedOptionId: string | null;
};

function sameText(a: string, b: string): boolean {
  const words = (text: string) =>
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return words(a) === words(b);
}

/**
 * The lines a Decision opens on: its question, one line about the situation,
 * and the recommendation. Stored lines win; an older row derives its summary
 * from the first sentence of its stated reason (or, without one, of its
 * context) and its recommendation from the option marked `primary`.
 */
export function decisionHeadline(decision: DecisionHeadlineInput): DecisionHeadline {
  const recommended = decision.options.find((option) => option.tone === "primary") ?? null;
  const storedSummary = oneLine(decision.summary ?? "");
  const storedRecommendation = oneLine(decision.recommendation ?? "");
  let summary: string | null = storedSummary || null;
  let summaryDerived = false;
  if (!summary) {
    const context = parseDecisionContext(decision.body);
    const source = context.reason ?? context.sections[0]?.body ?? "";
    const derived = firstSentence(source);
    if (derived && !sameText(derived, decision.title)) {
      summary = derived;
      summaryDerived = true;
    }
  }
  return {
    question: decision.title,
    summary,
    summaryDerived,
    recommendation: storedRecommendation || recommended?.label || null,
    recommendedOptionId: recommended?.id ?? null,
  };
}

export type PickupReportInput = {
  pickupStatus: string;
  pickupSummary: string | null;
  pickupReport?: string | null;
};

export type PickupReport = {
  /** The employee's short report, for a finished pickup. */
  report: string | null;
  /** True when `report` was read off an older row's log. */
  reportDerived: boolean;
  /** The full log, when it holds more than the report; otherwise null. */
  log: string | null;
};

/**
 * A finished pickup's report and the full log behind it. A failed or skipped
 * pickup has no report: its summary is the reason, and it is the log.
 */
export function pickupReportOf(decision: PickupReportInput): PickupReport {
  const log = decision.pickupSummary?.trim() || null;
  if (decision.pickupStatus !== "done") return { report: null, reportDerived: false, log };
  const stored = decision.pickupReport?.trim() || null;
  const report = stored ?? lastParagraph(log);
  return {
    report,
    reportDerived: !stored && report !== null,
    log: log && report && oneLine(plainText(log)) !== oneLine(plainText(report)) ? log : null,
  };
}
