import { usageError } from "./errors.js";
import type { OptionDef } from "./options.js";

/**
 * Turning argv into options, words and parameters.
 *
 * Parsing happens in two passes because an operation's parameters are only
 * known once the operation is: the first pass reads the CLI's own options up
 * to the command (and the operation id), the second reads the rest knowing
 * which parameters exist and which of them are switches. Values are taken
 * verbatim — `--data -`, `--score -5` — whenever a flag needs one.
 */

export type Token =
  | { type: "flag"; name: string; short: boolean; value?: string; raw: string }
  | { type: "word"; value: string; afterEnd: boolean };

export function tokenize(argv: readonly string[]): Token[] {
  const tokens: Token[] = [];
  let ended = false;
  for (const raw of argv) {
    if (ended) {
      tokens.push({ type: "word", value: raw, afterEnd: true });
      continue;
    }
    if (raw === "--") {
      ended = true;
      continue;
    }
    const long = raw.startsWith("--") && raw.length > 2;
    const short = !long && raw.startsWith("-") && raw.length > 1 && !/^-[\d.]/.test(raw);
    if (long || short) {
      const body = raw.slice(long ? 2 : 1);
      const equals = body.indexOf("=");
      tokens.push({
        type: "flag",
        name: equals === -1 ? body : body.slice(0, equals),
        short,
        ...(equals === -1 ? {} : { value: body.slice(equals + 1) }),
        raw,
      });
      continue;
    }
    tokens.push({ type: "word", value: raw, afterEnd: false });
  }
  return tokens;
}

/** An operation parameter given as a flag; resolved against the operation later. */
export type FlagParam = { name: string; value: string | boolean; raw: string };

export type FlagMeaning =
  | { kind: "option"; option: OptionDef }
  /** `name` overrides the flag's own text — `--no-archived` sets `archived`. */
  | { kind: "param"; takes: "value" | "switch" | "negated"; name?: string }
  | { kind: "unknown" };

export type OptionValues = Map<string, string | boolean>;

export type WalkResult = {
  options: OptionValues;
  words: Array<{ value: string; afterEnd: boolean }>;
  params: FlagParam[];
  /** With `stopAtWord`, the word the walk stopped at and everything after it. */
  stoppedAt?: string;
  rest: Token[];
};

const SWITCH_VALUES: Record<string, boolean> = {
  true: true,
  false: false,
  "1": true,
  "0": false,
  yes: true,
  no: false,
};

/** Read a switch's `=value`; anything but a yes/no word is a mistake worth naming. */
function switchValue(token: Extract<Token, { type: "flag" }>): boolean {
  if (token.value === undefined) return true;
  const value = SWITCH_VALUES[token.value.toLowerCase()];
  if (value === undefined) {
    throw usageError(`${token.raw.split("=")[0]} is a switch; give it true or false, or nothing.`);
  }
  return value;
}

/**
 * Walk tokens, reading options and parameter flags through `meaning`. A flag
 * `meaning` doesn't know is handed to `onUnknown`, which throws the error
 * that fits where the walk is.
 */
export function walk(
  tokens: readonly Token[],
  meaning: (token: Extract<Token, { type: "flag" }>) => FlagMeaning,
  options: {
    stopAtWord?: boolean;
    onUnknown: (token: Extract<Token, { type: "flag" }>) => never;
    into?: OptionValues;
  },
): WalkResult {
  const result: WalkResult = {
    options: options.into ?? new Map(),
    words: [],
    params: [],
    rest: [],
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "word") {
      if (options.stopAtWord && !token.afterEnd) {
        result.stoppedAt = token.value;
        result.rest = tokens.slice(index + 1);
        return result;
      }
      result.words.push({ value: token.value, afterEnd: token.afterEnd });
      continue;
    }
    const takeValue = (label: string): string => {
      if (token.value !== undefined) return token.value;
      const next = tokens[index + 1];
      if (!next) throw usageError(`${label} needs a value.`);
      index += 1;
      return next.type === "word" ? next.value : next.raw;
    };
    const found = meaning(token);
    if (found.kind === "option") {
      const label = token.short ? `-${token.name}` : `--${token.name}`;
      if (found.option.value) result.options.set(found.option.name, takeValue(label));
      else result.options.set(found.option.name, switchValue(token));
      continue;
    }
    if (found.kind === "param") {
      const name = found.name ?? token.name;
      if (found.takes === "value") {
        result.params.push({ name, value: takeValue(`--${token.name}`), raw: token.raw });
      } else if (found.takes === "negated") {
        if (token.value !== undefined) {
          throw usageError(`--${token.name} takes no value.`);
        }
        result.params.push({ name, value: false, raw: token.raw });
      } else {
        let value: boolean;
        if (token.value !== undefined) {
          value = switchValue(token);
        } else {
          const next = tokens[index + 1];
          const word = next?.type === "word" && !next.afterEnd ? next.value.toLowerCase() : "";
          if (word === "true" || word === "false") {
            value = word === "true";
            index += 1;
          } else {
            value = true;
          }
        }
        result.params.push({ name, value, raw: token.raw });
      }
      continue;
    }
    options.onUnknown(token);
  }
  return result;
}

/** A word shaped `name=value` or `name:=json` names a parameter. */
const ITEM = /^([A-Za-z_][A-Za-z0-9_.-]*?)(:=|=)([\s\S]*)$/;

export type ItemParam = { name: string; value: string; json: boolean; raw: string };

export function parseItem(word: string): ItemParam | null {
  const match = ITEM.exec(word);
  if (!match) return null;
  return { name: match[1], value: match[3], json: match[2] === ":=", raw: word };
}

/** Lowercase and drop separators, so `amount-cents`, `amount_cents` and `amountCents` meet. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/** `amountCents` → `amount-cents`. Operation ids and parameter names are camelCase. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** The edit distance between two short strings, for "did you mean". */
export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** Up to three candidates close to `input`: a shared prefix, or a small edit distance. */
export function suggest(input: string, candidates: readonly string[]): string[] {
  const needle = normalizeName(input);
  if (!needle) return [];
  const scored = candidates
    .map((candidate) => {
      const normalized = normalizeName(candidate);
      const distance = editDistance(needle, normalized);
      const prefix = normalized.startsWith(needle) || needle.startsWith(normalized);
      return { candidate, score: prefix ? Math.min(distance, 1) : distance };
    })
    .filter(({ score }) => score <= Math.max(2, Math.floor(needle.length / 4)))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  return [...new Set(scored.map(({ candidate }) => candidate))].slice(0, 3);
}
