/**
 * Which words of a data room an AI answer gets to read, and whether the words
 * it quotes back are really there.
 *
 * An answer turn reads only the documents the asking guest can open — never
 * the rest of the room — so a question, however it is phrased, cannot reach a
 * folder its guest was not given. When those documents fit the turn they go in
 * whole; otherwise they are cut into overlapping passages and the passages
 * that share the most (rarer) words with the question go in, best first, up to
 * the budget. Plain lexical scoring (BM25) keeps it dependency-free,
 * deterministic and testable; the room's own index — every document's title
 * and brief — rides along so an answer can point at a document no passage was
 * chosen from.
 *
 * Quotes are checked against exactly the passages the turn was shown
 * ({@link verifyQuote}): a citation the model could not have read is dropped,
 * whatever it says.
 */

export type RetrievalDocument = {
  id: string;
  title: string;
  folderName: string | null;
  text: string;
  summary: string | null;
};

export type Excerpt = {
  documentId: string;
  title: string;
  folderName: string | null;
  /** Passages in document order. The whole text when it fit. */
  passages: string[];
  /** True when `passages` is the document's entire text. */
  whole: boolean;
};

export const CHUNK_CHARS = 1_400;
export const CHUNK_OVERLAP_CHARS = 200;

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this those to was we were what when " +
    "where which who why will with would you your yours about any all also more most much some such us via per " +
    "please tell share provide give know let"
  ).split(" "),
);

/** Lower-case words, folded and lightly stemmed, without stopwords. */
export function tokenize(text: string): string[] {
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const out: string[] = [];
  for (const raw of folded.split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 2 && !/^\d$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Plurals folded onto their singular — "revenues" and "revenue", "taxes" and
 * "tax", "liabilities" and "liability" — and nothing cleverer: a stemmer that
 * also cut "-ed" or "-ing" would split "price" from "priced" as often as it
 * joined them.
 */
function stem(word: string): string {
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export type Chunk = { documentId: string; start: number; end: number; text: string };

/**
 * Overlapping passages of about {@link CHUNK_CHARS}, each cut at a paragraph,
 * line or sentence break where one falls in its second half.
 */
export function chunkText(documentId: string, text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const window = text.slice(start, end);
      const half = Math.floor(window.length / 2);
      const breaks = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
      ];
      const cut = breaks.find((index) => index >= half);
      if (cut !== undefined) end = start + cut + 1;
    }
    chunks.push({ documentId, start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

/**
 * The passages to show an answer turn, within `budgetChars` of document text.
 * `focusDocumentId` — the document the guest had open when they asked — is
 * favoured, and always contributes at least its best passage.
 */
export function selectExcerpts(args: {
  documents: RetrievalDocument[];
  question: string;
  focusDocumentId?: string | null;
  budgetChars: number;
}): Excerpt[] {
  const readable = args.documents.filter((document) => document.text.trim().length > 0);
  const total = readable.reduce((sum, document) => sum + document.text.length, 0);
  if (total <= args.budgetChars) {
    return readable.map((document) => ({
      documentId: document.id,
      title: document.title,
      folderName: document.folderName,
      passages: [document.text],
      whole: true,
    }));
  }

  const chunks = readable.flatMap((document) => chunkText(document.id, document.text));
  const tokensByChunk = chunks.map((chunk) => tokenize(chunk.text));
  const query = [...new Set(tokenize(args.question))];
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokensByChunk) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const averageLength =
    tokensByChunk.reduce((sum, tokens) => sum + tokens.length, 0) /
    Math.max(1, tokensByChunk.length);
  const titleHits = new Map(
    readable.map((document) => {
      const titleTokens = new Set(tokenize(`${document.title} ${document.folderName ?? ""}`));
      return [document.id, query.filter((token) => titleTokens.has(token)).length];
    }),
  );

  const k1 = 1.2;
  const b = 0.75;
  const scored = chunks.map((chunk, index) => {
    const tokens = tokensByChunk[index];
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of query) {
      const frequency = counts.get(token) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      score +=
        (idf * frequency * (k1 + 1)) /
        (frequency + k1 * (1 - b + (b * tokens.length) / Math.max(1, averageLength)));
    }
    score += (titleHits.get(chunk.documentId) ?? 0) * 0.6;
    if (chunk.documentId === args.focusDocumentId) score = score * 1.5 + 0.5;
    return { chunk, score, index };
  });

  const ranked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  // Nothing in common with the question ("Can you summarise the room?"): the
  // opening of every document, an even share each, is the most useful read.
  if (ranked.length === 0) return openings(readable, args.budgetChars);
  const pool = ranked;

  const chosen: Chunk[] = [];
  let used = 0;
  const focusBest = args.focusDocumentId
    ? pool.find((entry) => entry.chunk.documentId === args.focusDocumentId)
    : undefined;
  for (const entry of focusBest ? [focusBest, ...pool.filter((e) => e !== focusBest)] : pool) {
    if (used + entry.chunk.text.length > args.budgetChars) continue;
    chosen.push(entry.chunk);
    used += entry.chunk.text.length;
  }

  const byDocument = new Map<string, Chunk[]>();
  for (const chunk of chosen) {
    const list = byDocument.get(chunk.documentId) ?? [];
    list.push(chunk);
    byDocument.set(chunk.documentId, list);
  }
  const excerpts: Excerpt[] = [];
  for (const document of readable) {
    const picked = byDocument.get(document.id);
    if (!picked) continue;
    picked.sort((a, c) => a.start - c.start);
    // Overlapping neighbours become one passage, so the model reads each
    // stretch of the document once and a quote spanning the seam still checks.
    const merged: Array<{ start: number; end: number }> = [];
    for (const chunk of picked) {
      const last = merged[merged.length - 1];
      if (last && chunk.start <= last.end) last.end = Math.max(last.end, chunk.end);
      else merged.push({ start: chunk.start, end: chunk.end });
    }
    excerpts.push({
      documentId: document.id,
      title: document.title,
      folderName: document.folderName,
      passages: merged.map((range) => document.text.slice(range.start, range.end)),
      whole: false,
    });
  }
  return excerpts;
}

/** The start of every document, each cut to an even share of the budget. */
function openings(documents: RetrievalDocument[], budgetChars: number): Excerpt[] {
  const share = Math.max(400, Math.floor(budgetChars / Math.max(1, documents.length)));
  const excerpts: Excerpt[] = [];
  let used = 0;
  for (const document of documents) {
    if (used >= budgetChars) break;
    let end = Math.min(document.text.length, share, budgetChars - used);
    if (end < document.text.length) {
      const window = document.text.slice(0, end);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (cut >= end / 2) end = cut + 1;
    }
    const passage = document.text.slice(0, end);
    used += passage.length;
    excerpts.push({
      documentId: document.id,
      title: document.title,
      folderName: document.folderName,
      passages: [passage],
      whole: end >= document.text.length,
    });
  }
  return excerpts;
}

/** Folded for comparing a quote with its source: case, quotes, dashes and spacing. */
export function normalizeForQuote(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Shorter than this and a "quote" proves nothing. */
export const MIN_QUOTE_CHARS = 8;

/**
 * Whether `quote` appears word for word in what the turn was shown of the
 * document. An ellipsis is not allowed to stitch two places together.
 */
export function verifyQuote(quote: string, shownPassages: readonly string[]): boolean {
  const needle = normalizeForQuote(quote);
  if (needle.length < MIN_QUOTE_CHARS || needle.includes("…") || needle.includes("..."))
    return false;
  return shownPassages.some((passage) => normalizeForQuote(passage).includes(needle));
}
