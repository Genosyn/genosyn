import { SelectQueryBuilder } from "typeorm";

/**
 * Tokenized LIKE search, shared by every surface that has to find rows by
 * words a person actually typed.
 *
 * Extracted verbatim from `services/search.ts`, which had the only correct
 * implementation in the tree: tokens AND together, columns OR together, and
 * case folds two-pronged so the same query behaves the same on sqlite and
 * postgres. Notes and Resources each carried their own single
 * `LIKE '%whole query%'` instead, which is why "refund policy" missed a
 * document saying "our policy for refunds" — and, because bare `LIKE` folds
 * ASCII case on sqlite and does not on postgres, why the same search returned
 * different rows on the two supported drivers.
 *
 * Nothing here is new behaviour. It is `search.ts`'s behaviour, in a module
 * the other callers can import.
 */

/**
 * How many query tokens participate. Each token adds a LIKE per searched
 * column, so an unbounded 200-char query of 1-char words would be an easy way
 * to pin the (synchronous, on sqlite) driver. Nobody types nine words to find
 * a document.
 */
export const MAX_TOKENS = 8;

/** One query token in both casings the SQL needs — see {@link andWhereTokens}. */
export type Token = { lo: string; raw: string };

/** Escape `%`, `_`, and `\` so user input matches literally inside LIKE. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Split a raw query into at most {@link MAX_TOKENS} tokens, both casings. */
export function tokenizeQuery(raw: string): Token[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((tok) => ({ raw: tok, lo: tok.toLowerCase() }));
}

/**
 * Require every whitespace-separated token of the query to appear in at
 * least one of `cols`. Tokens AND together, columns OR together — "acme
 * invoice" should match a row named "Invoice run — Acme" regardless of
 * word order.
 *
 * Case-folding is two-pronged because SQLite's LOWER() (no ICU) folds only
 * ASCII: `LOWER(col) LIKE :lowercased` handles ASCII case on both drivers,
 * and `col LIKE :as-typed` lets a non-ASCII query ("Café", "Отчёт") match
 * verbatim on sqlite too. The one gap left: uppercase non-ASCII *stored*
 * text queried in lowercase won't match on sqlite (it will on postgres) —
 * closing that needs ICU or a normalized shadow column; not worth it here.
 */
export function andWhereTokens<T extends object>(
  qb: SelectQueryBuilder<T>,
  cols: string[],
  tokens: Token[],
  /** Disambiguates parameter names when a query builds two token clauses. */
  prefix = "tok",
): SelectQueryBuilder<T> {
  tokens.forEach((tok, i) => {
    const variants = [`LOWER(%c) LIKE :${prefix}Lo${i} ESCAPE '\\'`];
    const params: Record<string, string> = {
      [`${prefix}Lo${i}`]: `%${escapeLike(tok.lo)}%`,
    };
    if (tok.raw !== tok.lo) {
      variants.push(`%c LIKE :${prefix}Raw${i} ESCAPE '\\'`);
      params[`${prefix}Raw${i}`] = `%${escapeLike(tok.raw)}%`;
    }
    const clause = cols.flatMap((col) => variants.map((v) => v.replaceAll("%c", col))).join(" OR ");
    qb = qb.andWhere(`(${clause})`, params);
  });
  return qb;
}

/**
 * The OR-ed sibling of {@link andWhereTokens}: a row qualifies if *any*
 * token hits any column. Used as the fallback pass when the AND pass finds
 * nothing, so a query with one wrong word degrades to partial hits instead
 * of an empty result the caller cannot distinguish from an empty library.
 */
export function orWhereTokens<T extends object>(
  qb: SelectQueryBuilder<T>,
  cols: string[],
  tokens: Token[],
  prefix = "any",
): SelectQueryBuilder<T> {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  tokens.forEach((tok, i) => {
    const variants = [`LOWER(%c) LIKE :${prefix}Lo${i} ESCAPE '\\'`];
    params[`${prefix}Lo${i}`] = `%${escapeLike(tok.lo)}%`;
    if (tok.raw !== tok.lo) {
      variants.push(`%c LIKE :${prefix}Raw${i} ESCAPE '\\'`);
      params[`${prefix}Raw${i}`] = `%${escapeLike(tok.raw)}%`;
    }
    clauses.push(...cols.flatMap((col) => variants.map((v) => v.replaceAll("%c", col))));
  });
  if (clauses.length === 0) return qb;
  return qb.andWhere(`(${clauses.join(" OR ")})`, params);
}

/**
 * Rank a label against the query. Mirrors the tiers the ⌘K palette uses
 * (exact > prefix > word boundary > substring) so a hit sorts the same way
 * wherever it surfaced.
 */
export function scoreLabel(label: string, q: string, tokens: Token[]): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 90;
  const at = l.indexOf(q);
  if (at > 0 && !/[a-z0-9]/.test(l[at - 1])) return 80;
  if (at > 0) return 65;
  // The full query missed but every token hit (SQL guarantees each token
  // matched *some* searched column — this bonus is for all-in-the-label).
  if (tokens.length > 1 && tokens.every((t) => l.includes(t.lo))) return 55;
  return 40; // matched via a secondary column (summary, tags, body, …)
}
