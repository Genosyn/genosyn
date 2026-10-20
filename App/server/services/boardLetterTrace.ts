/**
 * The trace: every number written in a letter to the board, matched to the
 * figure it quotes.
 *
 * A letter's figures are computed by the server from the ledger, the Goals,
 * the Runs and the Decision stack (`services/boardLetterFigures.ts`); the AI
 * Employee who writes the letter only writes the prose around them. The trace
 * is what makes that division checkable. It reads the prose the way a careful
 * reader would, finds every number in it, and asks of each one: is this one of
 * the letter's figures, as written or honestly rounded? A number that is not
 * is reported as untraced, and the letter shows it to the board marked.
 *
 * Deliberately mechanical. No model reads anything here, so nothing the
 * writer puts in its prose can talk the trace out of a finding, and the same
 * letter always traces the same way. What the trace cannot judge — whether a
 * traced number is used for the right thing, or whether the prose leaves out
 * something that matters — is the board's auditor's job
 * (`services/boardLetterAudit.ts`).
 *
 * What it treats as a number: digits, with optional thousands separators and
 * decimals, an optional currency sign or code, magnitude (`k`, `M`, `B`,
 * `thousand`, `million`, `billion`) and percent. What it leaves alone because
 * a letter needs them and they are not figures: years near the letter's own,
 * days of the month beside a month's name, ISO dates, clock times, ordinals
 * (`3rd`), the letter's own number after "No.", and anything inside a URL.
 * Numbers written as words are not figures and are not traced, which is why
 * the writer is told to use digits only for the letter's figures.
 */

export type TraceFigureKind = "money" | "count" | "percent" | "number";

/** A figure a letter may quote, in the units a reader would write it in. */
export type TraceFigure = {
  key: string;
  kind: TraceFigureKind;
  /**
   * Money in major units (dollars, not cents), a percent as its percentage
   * (41.2 for 41.2%), counts and plain numbers as they are.
   */
  value: number;
  /**
   * What the figure counts, in words ("Runs that failed"). Only breaks ties:
   * when several figures share the number written, the one whose words sit
   * beside it in the sentence is the one it quotes.
   */
  label?: string;
};

export type TraceTokenKind = "money" | "percent" | "plain";

/** One number as the letter wrote it. */
export type TraceToken = {
  /** Exactly as written, currency sign and suffix included. */
  text: string;
  /** Offsets into the letter body, `end` exclusive. */
  start: number;
  end: number;
  kind: TraceTokenKind;
  /** What the text says, in the figure's units (magnitude applied, sign kept). */
  value: number;
};

export type TracedToken = TraceToken & { figureKey: string };

export type LetterTrace = {
  traced: TracedToken[];
  untraced: TraceToken[];
};

export type TraceOptions = {
  /** The letter's own number, so "Letter No. 4" is not read as a figure. */
  letterNumber?: number;
  /** The year the letter covers; years within ten of it are dates, not figures. */
  year?: number;
};

const MONTH_NAME = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const MONTH_BEFORE = new RegExp(String.raw`\b${MONTH_NAME}\s+$`, "i");
const MONTH_AFTER = new RegExp(String.raw`^\s+(?:of\s+)?${MONTH_NAME}(?![\p{L}])`, "iu");
const LETTER_NUMBER_BEFORE = /\bNo\.?\s*$/i;
const URL = /\bhttps?:\/\/\S+/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g;

const CURRENCY_CODES = "USD|EUR|GBP|CAD|AUD|NZD|INR|JPY|CHF|SEK|NOK|DKK|SGD|HKD|ZAR|BRL|MXN";

/**
 * A number, read left to right:
 *   sign · currency · digits · magnitude · percent · trailing currency code
 *
 * The lookbehind keeps it from starting inside a word, another number, a path,
 * a time, a range or an identifier ("Q3", "INV-0004", "3-5", "9/30", "12:30").
 * The lookahead keeps it from ending inside one ("4xx", "12th", "1.2.3"); an
 * ordinal therefore never matches at all.
 */
const NUMBER = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.,/:@#\-−–$€£¥₹])` +
    String.raw`(?<sign>[-−–](?=\s?(?:[A-Z]{0,3}[$€£¥₹]|\d)))?` +
    String.raw`(?<currency>[A-Z]{0,3}[$€£¥₹]\s?|(?:${CURRENCY_CODES})\s)?` +
    String.raw`(?<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?|\d+(?:\.\d+)?)` +
    String.raw`(?<magnitude>\s?(?:thousand|million|billion|bn|[kKMB]|(?<=[$€£¥₹]\s?\d[\d,.]*)[mb])(?![\p{L}\p{N}]))?` +
    String.raw`(?<percent>\s?(?:%|percent\b|per\s?cent\b))?` +
    String.raw`(?<code>\s(?:${CURRENCY_CODES})\b)?` +
    String.raw`(?![\p{L}\p{N}_/]|\.\d|,\d|:\d)`,
  "gu",
);

const MAGNITUDES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

function magnitudeOf(raw: string | undefined): number {
  if (!raw) return 1;
  const word = raw.trim();
  // Upper-case M and B are millions and billions; a lower-case k is thousands.
  // Lower-case m and b only reach here after a currency sign ("$4.8m").
  return MAGNITUDES[word.toLowerCase()] ?? 1;
}

/** Spans no number inside should be read: URLs and ISO dates. */
function quietSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of [URL, ISO_DATE]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      spans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }
  return spans;
}

function insideAny(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([from, to]) => start >= from && end <= to);
}

type ReadToken = TraceToken & {
  /** Half the place value of the last digit written: how far rounding can move it. */
  tolerance: number;
  /** Whether the text has a magnitude word or letter ("4.8M", "2 thousand"). */
  scaled: boolean;
  /** Digits with no separators, decimals, sign, currency or percent. */
  bareInteger: boolean;
};

/** Every number in `body`, in order, before anything is exempted. */
export function readNumbers(body: string): TraceToken[] {
  return readTokens(body).map(({ text, start, end, kind, value }) => ({
    text,
    start,
    end,
    kind,
    value,
  }));
}

function readTokens(body: string): ReadToken[] {
  const quiet = quietSpans(body);
  const tokens: ReadToken[] = [];
  NUMBER.lastIndex = 0;
  for (const match of body.matchAll(NUMBER)) {
    const groups = match.groups ?? {};
    const text = match[0].replace(/\s+$/, "");
    const start = match.index ?? 0;
    const end = start + text.length;
    if (insideAny(quiet, start, end)) continue;
    const digits = groups.digits ?? "";
    const plain = digits.replace(/,/g, "");
    const decimals = plain.includes(".") ? plain.length - plain.indexOf(".") - 1 : 0;
    const magnitude = magnitudeOf(groups.magnitude);
    const negative = Boolean(groups.sign);
    const value = Number(plain) * magnitude * (negative ? -1 : 1);
    if (!Number.isFinite(value)) continue;
    const kind: TraceTokenKind = groups.percent
      ? "percent"
      : groups.currency || groups.code
        ? "money"
        : "plain";
    tokens.push({
      text,
      start,
      end,
      kind,
      value,
      tolerance: (Math.pow(10, -decimals) * magnitude) / 2,
      scaled: magnitude !== 1,
      bareInteger: kind === "plain" && !negative && !groups.magnitude && /^\d+$/.test(digits),
    });
  }
  return tokens;
}

/** A number the letter needs that is not a figure: a date, a year, its own number. */
function isExempt(body: string, token: ReadToken, options: TraceOptions): boolean {
  if (!token.bareInteger) return false;
  const before = body.slice(Math.max(0, token.start - 24), token.start);
  const after = body.slice(token.end, token.end + 24);
  if (
    options.letterNumber !== undefined &&
    token.value === options.letterNumber &&
    LETTER_NUMBER_BEFORE.test(before)
  ) {
    return true;
  }
  if (
    token.value >= 1 &&
    token.value <= 31 &&
    (MONTH_BEFORE.test(before) || MONTH_AFTER.test(after))
  ) {
    return true;
  }
  if (options.year !== undefined && token.text.length === 4) {
    return Math.abs(token.value - options.year) <= 10;
  }
  return false;
}

function kindsMatch(token: TraceTokenKind, figure: TraceFigureKind): boolean {
  if (token === "percent") return figure === "percent";
  if (token === "money") return figure === "money";
  // A plain number can quote a count, a plain figure, or an amount written
  // without its sign ("revenue of 12,400"); never a percent with its sign lost.
  return figure !== "percent";
}

/**
 * Whether `token` honestly quotes `figure`.
 *
 * Within half the place value of the last digit written, so "$4.8M" quotes
 * $4,812,345 and "41%" quotes 41.4%. Signs are read from the words around a
 * number, so a loss of $1,200 may be written "$1,200". A rounding that drops
 * most of the precision must also stay within 5% of the figure: "$5M" does not
 * quote $4.6M, though it is within half a million of it.
 */
function quotes(token: ReadToken, figure: TraceFigure): boolean {
  if (!kindsMatch(token.kind, figure.kind)) return false;
  const written = Math.abs(token.value);
  const actual = Math.abs(figure.value);
  const difference = Math.abs(written - actual);
  if (difference > token.tolerance + 1e-9 * Math.max(1, actual)) return false;
  if (token.scaled && actual !== 0 && difference / actual > 0.05) return false;
  return true;
}

const STOP_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "its",
  "our",
  "than",
  "that",
  "the",
  "their",
  "this",
  "was",
  "were",
  "which",
  "with",
]);

/** Lower-case word stems of at least four letters: "failed" → "fail". */
function stems(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}+/gu) ?? [])
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, ""))
    .filter((stem) => stem.length >= 3);
}

/** The words around a number, within its sentence, at most eight each side. */
function contextStems(body: string, token: ReadToken): string[] {
  const before =
    body
      .slice(0, token.start)
      .split(/[.!?;\n]/)
      .pop() ?? "";
  const after = body.slice(token.end).split(/[.!?;\n]/)[0] ?? "";
  return [...stems(before).slice(-8), ...stems(after).slice(0, 8)];
}

/** How many of a figure's words appear beside the number. */
function affinity(context: readonly string[], figure: TraceFigure): number {
  if (!figure.label) return 0;
  return stems(figure.label).filter((word) =>
    context.some((near) => near === word || near.startsWith(word) || word.startsWith(near)),
  ).length;
}

/** Trace every number in `body` to the figures it may quote. */
export function traceLetter(
  body: string,
  figures: readonly TraceFigure[],
  options: TraceOptions = {},
): LetterTrace {
  const traced: TracedToken[] = [];
  const untraced: TraceToken[] = [];
  for (const token of readTokens(body)) {
    if (isExempt(body, token, options)) continue;
    const plain: TraceToken = {
      text: token.text,
      start: token.start,
      end: token.end,
      kind: token.kind,
      value: token.value,
    };
    // Every candidate is an honest quote at the precision written, so which
    // one the writer meant is read from the words beside the number ("1
    // failed" is Runs that failed, "Revenue was $4.8M" is revenue); only when
    // the words do not tell them apart does the closest figure win.
    const candidates = figures.filter((figure) => quotes(token, figure));
    const context = candidates.length > 1 ? contextStems(body, token) : [];
    const best = candidates
      .map((figure, index) => ({
        figure,
        index,
        distance: Math.abs(Math.abs(figure.value) - Math.abs(token.value)),
        affinity: affinity(context, figure),
      }))
      .sort(
        (a, b) => b.affinity - a.affinity || a.distance - b.distance || a.index - b.index,
      )[0]?.figure;
    if (best) traced.push({ ...plain, figureKey: best.key });
    else untraced.push(plain);
  }
  return { traced, untraced };
}
