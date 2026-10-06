/**
 * Text matching shared by the ⌘K palette's section and page searches.
 *
 * Both rank a short query against short labels, so they share one set of
 * tiers: an exact label beats a prefix, a prefix beats a word inside the
 * label, and a synonym or a skip-match only ever ranks below what the person
 * can actually read. Keeping the tiers in one place is what lets the palette
 * compare a section match with a page match and put the better one first.
 */

/** Scores for each way a query can land. Higher is better. */
export const MATCH_SCORE = {
  exact: 100,
  prefix: 90,
  /** The query starts a later word: "invoices" in "Recurring invoices". */
  boundary: 80,
  /** The query lands mid-word: "mail" in "Gmail". */
  infix: 65,
  /** "ri" reaches "Recurring invoices" without spelling either word. */
  initials: 58,
  keywordPrefix: 55,
  keyword: 45,
  description: 35,
  /** The query's letters appear in order with gaps ("aiemp"). */
  fuzzy: 20,
} as const;

/** A scored match, with the `[start, end)` label range to highlight, if any. */
export type TextMatch = { score: number; hit: [number, number] | null };

/**
 * Fold a label or query for comparison: case, accents, and runs of
 * whitespace stop mattering, so "  Récurring   Invoices " reads as
 * "recurring invoices".
 */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of an already-folded query. */
export function queryTokens(folded: string): string[] {
  return folded.split(" ").filter(Boolean);
}

/** Does `needle` appear in `hay` in order, allowing gaps? ("aiemp" → "AI Employees") */
export function isSubsequence(hay: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Rank a folded query against one label by where it lands in the label's own
 * text — exact, prefix, start of a later word, or mid-word. Null when the
 * label doesn't contain the query at all.
 *
 * The highlight range is only returned when folding kept the label's length,
 * because the offsets are found in the folded text but drawn over the
 * original: if folding changed the length ("ﬁ" → "fi"), they wouldn't line up,
 * and no highlight beats a wrong one.
 */
export function matchLabelText(label: string, q: string): TextMatch | null {
  if (!q) return null;
  const folded = foldSearchText(label);
  const aligned = folded.length === label.length;
  const range = (start: number, end: number): [number, number] | null =>
    aligned ? [start, end] : null;

  if (folded === q) return { score: MATCH_SCORE.exact, hit: range(0, folded.length) };
  const at = folded.indexOf(q);
  if (at === 0) return { score: MATCH_SCORE.prefix, hit: range(0, q.length) };
  if (at > 0) {
    // A hit at a word boundary ("Employees" in "AI Employees") reads as
    // intentional; one mid-word ("mail" in "Gmail") is weaker.
    const boundary = !/[a-z0-9]/.test(folded[at - 1]);
    return {
      score: boundary ? MATCH_SCORE.boundary : MATCH_SCORE.infix,
      hit: range(at, at + q.length),
    };
  }
  return null;
}

/**
 * A skip-match that must start where a word starts: "rcrng" reaches
 * "Recurring invoices", but "inv" doesn't reach "Transaction review" by
 * collecting an i, an n, and a v from three different words. Over a long list
 * of multi-word labels the unanchored version matches nearly anything.
 */
export function isWordAnchoredSubsequence(hay: string, needle: string): boolean {
  if (!needle) return true;
  for (let i = 0; i < hay.length; i++) {
    const wordStart = i === 0 || !/[a-z0-9]/.test(hay[i - 1]);
    if (wordStart && hay[i] === needle[0] && isSubsequence(hay.slice(i), needle)) return true;
  }
  return false;
}

/** First letter of every word: "Recurring invoices" → "ri". */
export function labelInitials(label: string): string {
  return foldSearchText(label)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

/** Does the query spell the start of the label's initials? */
export function matchesInitials(label: string, q: string): boolean {
  const initials = labelInitials(label);
  return initials.length > 1 && initials.startsWith(q);
}

/** Score the best synonym hit: one that starts with the query beats one that merely contains it. */
export function matchKeywords(keywords: readonly string[] | undefined, q: string): number | null {
  if (!q || !keywords?.length) return null;
  let best: number | null = null;
  for (const keyword of keywords) {
    const folded = foldSearchText(keyword);
    if (folded.startsWith(q)) return MATCH_SCORE.keywordPrefix;
    if (folded.includes(q)) best = MATCH_SCORE.keyword;
  }
  return best;
}
