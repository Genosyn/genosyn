import { singularize } from "../../openapi/naming.js";
import type { CatalogueOperation, OperationCatalogue, OperationKind } from "./catalogue.js";

/**
 * Finding an operation among the hundreds the Genosyn MCP server can call.
 *
 * An agent describes what it wants in its own words — "add a contact", "list
 * overdue invoices", "run a routine now" — and this ranks the catalogue by how
 * well each operation's name, summary, path, area and prose cover them. Words
 * are compared after the same folding the operation ids were built with
 * (camelCase split, lower case, singular), so "deals", "Deal" and
 * "createRevenueDeal" meet on "deal". A short table of synonyms bridges the
 * words people reach for and the product's own vocabulary: an agent asking
 * for "tasks" finds todos, one asking for "leads" finds Contacts.
 */

/** Words that say nothing about which operation is meant. */
// prettier-ignore
const STOPWORDS = new Set([
  "a", "an", "and", "all", "any", "are", "as", "at", "be", "by", "can", "do", "for", "from",
  "how", "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "our", "some", "that",
  "the", "their", "them", "this", "to", "up", "us", "we", "what", "which", "with", "you", "your",
]);

/**
 * Query words and the catalogue words they may mean. A synonym match counts
 * for less than the word itself, so an operation named with the asker's own
 * word still ranks first.
 */
const SYNONYMS: Record<string, string[]> = {
  // Verbs people use for the verbs operation ids use.
  add: ["create"],
  new: ["create"],
  make: ["create"],
  edit: ["update"],
  change: ["update"],
  modify: ["update"],
  rename: ["update"],
  set: ["update"],
  remove: ["delete"],
  erase: ["delete"],
  show: ["get", "list"],
  view: ["get", "list"],
  fetch: ["get", "list"],
  read: ["get", "list"],
  find: ["search", "list"],
  lookup: ["search", "get"],
  start: ["run"],
  trigger: ["run"],
  pause: ["update", "disable"],
  resume: ["update", "enable"],
  attach: ["upload", "attachment"],
  import: ["upload"],
  // Everyday words for the product's nouns (AGENTS.md §3 keeps the product's own).
  task: ["todo", "project"],
  ticket: ["todo"],
  agent: ["employee"],
  bot: ["employee"],
  assistant: ["employee"],
  worker: ["employee"],
  job: ["routine"],
  cron: ["routine"],
  schedule: ["routine", "cron"],
  execution: ["run"],
  lead: ["contact"],
  prospect: ["contact"],
  // "people" folds to "person" before this table is read.
  person: ["contact", "member"],
  user: ["member"],
  opportunity: ["deal"],
  email: ["mail"],
  inbox: ["mail"],
  message: ["mail", "channel", "conversation"],
  chat: ["workspace", "channel", "conversation"],
  doc: ["note"],
  wiki: ["note"],
  page: ["note"],
  knowledge: ["resource", "note"],
  automation: ["pipeline", "routine"],
  workflow: ["pipeline"],
  okr: ["goal"],
  objective: ["goal"],
  kpi: ["goal"],
  approval: ["decision"],
  question: ["decision"],
  label: ["tag"],
  category: ["folder", "tag"],
  dashboard: ["explore", "chart"],
  report: ["letter", "tldr"],
  money: ["finance", "invoice"],
  payment: ["invoice", "finance"],
  bank: ["banking"],
  signature: ["signing", "envelope"],
  hire: ["recruiting", "application"],
  candidate: ["application"],
  applicant: ["application"],
  vacancy: ["opening"],
  calendar: ["meeting"],
  campaign: ["marketing"],
};

/**
 * Where a word was found, and what finding it there is worth. An area's name
 * counts as much as the operation's own — "tasks" means the Tasks area — and
 * `traits` are words for what the operation's shape says it does: one that
 * takes a file is an upload, one that answers with a file is a download.
 */
const FIELD_WEIGHTS = {
  name: 3,
  area: 3,
  summary: 2.5,
  traits: 2.5,
  path: 2,
  prose: 0.75,
} as const;

type Field = keyof typeof FIELD_WEIGHTS;

const SYNONYM_FACTOR = 0.6;
const PREFIX_WEIGHT = 1;

/** Fold text into comparable words: camelCase split, lower case, singular, stopwords out. */
export function searchWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word && !STOPWORDS.has(word))
    .map((word) => singularize(word));
}

type Indexed = { operation: CatalogueOperation; fields: Record<Field, Set<string>> };

const indexes = new WeakMap<OperationCatalogue, Indexed[]>();

function indexOf(catalogue: OperationCatalogue): Indexed[] {
  let index = indexes.get(catalogue);
  if (!index) {
    index = catalogue.operations.map((operation) => ({
      operation,
      fields: {
        name: new Set(searchWords(operation.name)),
        summary: new Set(searchWords(operation.summary)),
        area: new Set(searchWords(operation.area)),
        path: new Set(
          searchWords(
            operation.path.replace(/^\/api\/companies\/\{cid\}/, "").replace(/\{[^}]+\}/g, " "),
          ),
        ),
        prose: new Set(searchWords(operation.description)),
        traits: new Set([
          ...(operation.upload ? ["upload", "file", "attachment"] : []),
          ...(operation.response.binary ? ["download", "file", "export"] : []),
        ]),
      },
    }));
    indexes.set(catalogue, index);
  }
  return index;
}

/** The best a single query word scores against one operation. */
function wordScore(entry: Indexed, word: string): number {
  let best = 0;
  for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
    if (entry.fields[field].has(word)) best = Math.max(best, FIELD_WEIGHTS[field]);
  }
  if (best === 0 && word.length >= 3) {
    for (const field of ["name", "summary", "path", "area"] as const) {
      for (const candidate of entry.fields[field]) {
        if (candidate.startsWith(word)) {
          best = Math.max(best, PREFIX_WEIGHT);
          break;
        }
      }
    }
  }
  return best;
}

function scoreOf(entry: Indexed, words: string[]): { matched: number; score: number } {
  let matched = 0;
  let score = 0;
  for (const word of words) {
    let best = wordScore(entry, word);
    for (const synonym of SYNONYMS[word] ?? []) {
      best = Math.max(best, wordScore(entry, singularize(synonym)) * SYNONYM_FACTOR);
    }
    if (best > 0) {
      matched += 1;
      score += best;
    }
  }
  return { matched, score };
}

const KIND_ORDER: Record<OperationKind, number> = { read: 0, write: 1, delete: 2 };

/** Code-unit order: the same on every machine, unlike the locale's. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An area by its name, in any case or spelled as a slug: "revenue", "letters-to-the-board". */
export function resolveArea(catalogue: OperationCatalogue, area: string): string | null {
  const wanted = area
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!wanted) return null;
  const match = catalogue.areas.find(
    (candidate) =>
      candidate.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim() === wanted,
  );
  return match?.name ?? null;
}

export type SearchOptions = {
  query?: string;
  /** An area name, already resolved with {@link resolveArea}. */
  area?: string;
  kind?: OperationKind;
  limit: number;
  offset: number;
};

/**
 * Operations matching the query, best first. With no query, every operation
 * in the area (or the catalogue), ordered by path so related ones sit together.
 */
export function searchOperations(
  catalogue: OperationCatalogue,
  options: SearchOptions,
): { total: number; operations: CatalogueOperation[] } {
  const words = searchWords(options.query ?? "");
  const candidates = indexOf(catalogue).filter(
    (entry) =>
      (!options.area || entry.operation.area === options.area) &&
      (!options.kind || entry.operation.kind === options.kind),
  );

  let ranked: CatalogueOperation[];
  if (words.length === 0) {
    ranked = candidates
      .map((entry) => entry.operation)
      .sort(
        (a, b) =>
          compare(a.path, b.path) ||
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          compare(a.method, b.method),
      );
  } else {
    ranked = candidates
      .map((entry) => ({ entry, ...scoreOf(entry, words) }))
      .filter((scored) => scored.matched > 0)
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.score - a.score ||
          KIND_ORDER[a.entry.operation.kind] - KIND_ORDER[b.entry.operation.kind] ||
          a.entry.operation.path.length - b.entry.operation.path.length ||
          compare(a.entry.operation.name, b.entry.operation.name),
      )
      .map((scored) => scored.entry.operation);
  }
  return {
    total: ranked.length,
    operations: ranked.slice(options.offset, options.offset + options.limit),
  };
}

/** Every area with how many operations of each kind it offers. */
export function areaOverview(catalogue: OperationCatalogue): Array<{
  name: string;
  description: string;
  operations: number;
  read: number;
  write: number;
  delete: number;
}> {
  return catalogue.areas.map((area) => {
    const inArea = catalogue.operations.filter((operation) => operation.area === area.name);
    return {
      name: area.name,
      description: area.description,
      operations: inArea.length,
      read: inArea.filter((operation) => operation.kind === "read").length,
      write: inArea.filter((operation) => operation.kind === "write").length,
      delete: inArea.filter((operation) => operation.kind === "delete").length,
    };
  });
}

/**
 * Operation ids that look like a mistyped one: the same words in another
 * order, a near spelling, or the best search matches for its words.
 */
export function similarOperationNames(
  catalogue: OperationCatalogue,
  name: string,
  limit = 3,
): string[] {
  const lower = name.toLowerCase();
  const close = catalogue.operations
    .map((operation) => ({
      name: operation.name,
      distance: editDistance(lower, operation.name.toLowerCase()),
    }))
    .filter((candidate) => candidate.distance <= Math.max(2, Math.floor(name.length / 5)))
    .sort((a, b) => a.distance - b.distance || compare(a.name, b.name))
    .map((candidate) => candidate.name);
  const searched = searchOperations(catalogue, {
    query: name,
    limit: limit * 2,
    offset: 0,
  }).operations.map((operation) => operation.name);
  return [...new Set([...close, ...searched])].slice(0, limit);
}

/** Levenshtein distance, for names of a few dozen characters. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
