/**
 * The words people type for a kind of result, shared by the company search
 * (`server/services/search.ts`) and the client surfaces that search a list of
 * named records (Explore's chart/dashboard sidebar).
 *
 * A search for "revenue dashboard" is asking for the Dashboard called
 * Revenue, not for a row whose *title* contains both words. Treating a kind
 * word as a qualifier makes the phrase work in either order, in the singular
 * or the plural, and by the synonyms people actually use ("repo", "agent",
 * "doc") — while leaving the remaining words to narrow the title.
 *
 * The product's own vocabulary lives in AGENTS.md §3. These are search
 * aliases, never rendered copy: the rows keep saying Dashboard, Repository,
 * AI Employee.
 */

/** Every kind a company search result can carry. */
export type SearchKind =
  | "product"
  | "employee"
  | "skill"
  | "routine"
  | "channel"
  | "project"
  | "todo"
  | "base"
  | "notebook"
  | "note"
  | "resource"
  | "chart"
  | "dashboard"
  | "repository"
  | "pipeline"
  | "customer"
  | "account"
  | "opening"
  | "applicant"
  | "catalogProduct";

/**
 * Singular base words for each kind. Plurals are derived, so the table stays
 * one line per word and "dashboard"/"dashboards" can never disagree.
 *
 * `product` and `catalogProduct` are deliberately empty: "product" names a
 * product area (a page) as often as a Finance product (a row), and letting it
 * select a kind would make one of the two unreachable by its own name. They
 * still match as ordinary text.
 */
const KIND_TERMS: Record<SearchKind, readonly string[]> = {
  product: [],
  employee: ["employee", "agent", "bot", "assistant", "teammate", "worker", "staff", "ai"],
  skill: ["skill", "playbook"],
  routine: ["routine", "cron", "schedule"],
  channel: ["channel", "chat"],
  project: ["project"],
  todo: ["todo", "task", "ticket"],
  base: ["base", "table", "database", "spreadsheet", "sheet", "airtable"],
  notebook: ["notebook"],
  note: ["note", "doc", "document", "page", "wiki"],
  resource: ["resource", "ebook", "library"],
  chart: ["chart", "graph", "visualization", "visualisation"],
  dashboard: ["dashboard"],
  repository: ["repository", "repo"],
  pipeline: ["pipeline", "workflow"],
  customer: ["customer", "client"],
  account: ["account"],
  opening: ["opening", "job", "role", "vacancy", "posting"],
  applicant: ["applicant", "candidate", "application"],
  catalogProduct: [],
};

/**
 * How a kind word scores against a row of that kind. It sits where a synonym
 * sits — below the row's own name, above a description-only hit — so an exact
 * title always leads a kind-only phrase.
 */
export const KIND_MATCH_SCORE = {
  /** "dashboard" or "dashboards"; also a synonym, e.g. "repo". */
  exact: 55,
  /** "dash" while the person is still typing. */
  prefix: 45,
} as const;

/**
 * A prefix must be long enough to mean something. Three letters would make
 * "pro" select every Project and "cha" select Channels, Charts, and Chats at
 * once; four still lets "dash", "char", "repo", and "proj" work as you type.
 */
const PREFIX_MIN_LENGTH = 4;

/** Fold a word the way the query is folded: case, accents, and punctuation stop mattering. */
export function foldKindText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "base" → "bases", "chart" → "charts", "repository" → "repositories". */
function pluralOf(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** One term against one already-folded token. */
function matchTerm(term: string, token: string): number | null {
  if (token === term || token === pluralOf(term)) return KIND_MATCH_SCORE.exact;
  if (token.length >= PREFIX_MIN_LENGTH && term.length > token.length && term.startsWith(token)) {
    return KIND_MATCH_SCORE.prefix;
  }
  return null;
}

/**
 * How well `token` names `kind`, or null when it does not. Higher is better,
 * on the same scale as the palette's synonym scores.
 */
export function matchKindToken(kind: SearchKind, token: string): number | null {
  const folded = foldKindText(token);
  if (!folded) return null;
  let best: number | null = null;
  for (const term of KIND_TERMS[kind]) {
    const score = matchTerm(term, folded);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/** True when the token names at least one kind, so it can act as a qualifier. */
export function isKindToken(token: string): boolean {
  return searchKindsNamedByToken(token).length > 0;
}

/**
 * Every kind the token names — more than one when a prefix is ambiguous.
 * Exact names come before prefix matches, so "note" leads with Note and
 * lists Notebook after it.
 */
export function searchKindsNamedByToken(token: string): SearchKind[] {
  const folded = foldKindText(token);
  if (!folded) return [];
  return (Object.keys(KIND_TERMS) as SearchKind[])
    .map((kind) => ({ kind, score: matchKindToken(kind, folded) }))
    .filter((entry): entry is { kind: SearchKind; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.kind);
}
