import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import multer from "multer";
import unzipper from "unzipper";
import { In } from "typeorm";
import type { SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Resource } from "../db/entities/Resource.js";
import type { ResourceSourceKind } from "../db/entities/Resource.js";
import {
  EmployeeResourceGrant,
  RESOURCE_ACCESS_RANK,
} from "../db/entities/EmployeeResourceGrant.js";
import type { ResourceAccessLevel } from "../db/entities/EmployeeResourceGrant.js";
import { Company } from "../db/entities/Company.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { andWhereTokens, orWhereTokens, scoreLabel, tokenizeQuery } from "./likeSearch.js";
import { isBinary } from "../lib/binaryBytes.js";
import { safeFetchBuffer } from "../lib/outboundUrl.js";
import { companyDir, ensureDir } from "./paths.js";
import { docxBufferToText } from "./docxRead.js";
import { looksLikeWordDocument } from "./docxPackage.js";

/**
 * Resources — knowledge ingestion. The store is a flat per-company
 * table of `Resource` rows; bytes for uploads land on disk under
 * `data/companies/<slug>/resources/`. Retrieval is substring matching
 * on `bodyText` for v1, mirroring `search_notes`.
 *
 * Source kinds:
 *   - `url`: fetch + minimal HTML→text extraction
 *   - `text`: human-pasted plain text
 *   - `pdf`: extracted via `pdf-parse`
 *   - `epub`: unzipped + each XHTML chapter stripped to text
 *   - `video`: accepted but stored as `failed` for now (no ASR yet)
 */

export const RESOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** Hard cap on the extracted text we keep on the row; SQLite handles MBs but
 * pulling a 50 MiB ebook body into a JSON response is wasteful. */
export const RESOURCE_BODY_TEXT_CAP = 1 * 1024 * 1024;
/** Summary auto-generated when humans don't supply one. First N characters
 * of the extracted body text, single-line. */
export const RESOURCE_AUTO_SUMMARY_CHARS = 320;

function resourcesRoot(companySlug: string): string {
  const dir = path.join(companyDir(companySlug), "resources");
  ensureDir(dir);
  return dir;
}

function safeExt(filename: string): string {
  const e = path.extname(filename).toLowerCase();
  if (!e || e.length > 10) return "";
  if (!/^\.[a-z0-9]+$/.test(e)) return "";
  return e;
}

/**
 * Multer middleware for the create-resource route. Single-file upload
 * under field name `file`, capped at 25 MB. The route handler must set
 * `req.company` first (same pattern as the bases attachment route).
 */
export const resourceUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const co = (req as unknown as { company?: Company }).company;
        if (!co) {
          cb(new Error("Company context missing on upload"), "");
          return;
        }
        cb(null, resourcesRoot(co.slug));
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (_req, file, cb) => {
      const ext = safeExt(file.originalname);
      const id = crypto.randomUUID();
      cb(null, `${id}${ext}`);
    },
  }),
  limits: {
    fileSize: RESOURCE_MAX_BYTES,
    files: 1,
  },
});

export async function uniqueResourceSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Resource);
  let slug = base || "resource";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// ---------- Extraction helpers ----------

/**
 * Strip an HTML document down to plain text. Avoids dragging jsdom +
 * readability into the dep tree — for v1 we keep paragraph
 * boundaries but throw away inline markup. Good enough for substring
 * search and for an AI to read back.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()).slice(0, 200) : "";

  // Drop scripts/styles/headers wholesale before anything else so their
  // contents don't bleed into the text body.
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Block-level elements become newlines so paragraph structure survives.
  body = body
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|hr|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>(?=)/gi, "\n");
  // Drop every remaining tag.
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeHtmlEntities(body);
  body = body.replace(/\u00a0/g, " ");
  // Collapse whitespace within a line, then collapse runs of blank lines.
  body = body
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return { title, text: body };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

/**
 * Fetch a URL and return the (best-effort) extracted plain text. Any
 * non-2xx response throws with a helpful message — the caller stamps
 * the row as `failed` and surfaces the error.
 */
export async function fetchUrlAsText(url: string): Promise<{ title: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be ingested.");
  }
  const res = await safeFetchBuffer(url, {
    headers: {
      // Give servers a real-looking UA so a few sites don't refuse us.
      "User-Agent": "GenosynResourceBot/1.0 (+https://genosyn.com)",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = res.body;
  if (contentType.startsWith("text/html") || contentType.includes("xhtml")) {
    const html = buf.toString("utf8");
    return htmlToText(html);
  }
  if (contentType.startsWith("text/")) {
    return { title: "", text: buf.toString("utf8") };
  }
  if (contentType.includes("application/pdf")) {
    const text = await pdfBufferToText(buf);
    return { title: "", text };
  }
  // Fall back to a text decode — many servers mis-tag their content type.
  return { title: "", text: buf.toString("utf8") };
}

/**
 * Extract text from a PDF buffer using `pdf-parse`. The library is
 * CommonJS-only and contains a debug branch that reads a built-in test
 * PDF when imported as `require('pdf-parse')` from CJS — to
 * avoid that we go straight at the inner module.
 *
 * The copy into a standalone `Uint8Array` is load-bearing. `pdf-parse` vendors
 * pdf.js 1.10, which passes the array we hand it down to the parser and then
 * works on it with textbook `TypedArray` assumptions. A Node `Buffer` violates
 * those: small ones are views into a shared 8 KiB allocation pool, so they
 * carry a non-zero `byteOffset` over an oversized backing `ArrayBuffer`, and
 * `Buffer#slice` returns a view where `Uint8Array#slice` returns a copy. Hand
 * one straight to the parser and extraction fails with "Invalid PDF structure"
 * on a perfectly valid document — not every time, but depending on where in
 * the pool the bytes landed and what else the process had allocated, which is
 * what made it look like a concurrency bug. `new Uint8Array(buf)` gives the
 * parser bytes it owns outright: offset zero, exact length, standard
 * semantics.
 */
export async function pdfBufferToText(buf: Buffer): Promise<string> {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    data: Uint8Array,
  ) => Promise<{ text: string }>;
  const out = await pdfParse(new Uint8Array(buf));
  return out.text ?? "";
}

/**
 * Extract text from an EPUB file on disk. EPUB is a zip of XHTML
 * documents listed in `META-INF/container.xml`; we keep this dependency
 * light by walking every `.xhtml` / `.html` file inside the archive and
 * stripping tags. Good enough for substring search.
 */
export async function epubFileToText(absPath: string): Promise<string> {
  const dir = await unzipper.Open.file(absPath);
  const entries = dir.files
    .filter((f) => /\.(xhtml|html|htm)$/i.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const parts: string[] = [];
  for (const entry of entries) {
    const buf = await entry.buffer();
    const html = buf.toString("utf8");
    const { text } = htmlToText(html);
    if (text.trim().length === 0) continue;
    parts.push(text.trim());
    if (parts.join("\n\n").length > RESOURCE_BODY_TEXT_CAP * 2) {
      // Stop early; the cap below trims to RESOURCE_BODY_TEXT_CAP anyway.
      break;
    }
  }
  return parts.join("\n\n");
}

export function trimBodyText(text: string): string {
  // Strip embedded NUL bytes — SQLite's text APIs occasionally
  // trip on them when they leak in from PDF/EPUB extraction.
  // eslint-disable-next-line no-control-regex
  const normalized = text.replace(/\u0000/g, "").trim();
  if (normalized.length <= RESOURCE_BODY_TEXT_CAP) return normalized;
  return normalized.slice(0, RESOURCE_BODY_TEXT_CAP);
}

export function summarize(text: string, summary?: string): string {
  if (summary && summary.trim().length > 0) return summary.trim();
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= RESOURCE_AUTO_SUMMARY_CHARS) return oneLine;
  return oneLine.slice(0, RESOURCE_AUTO_SUMMARY_CHARS - 1) + "…";
}

// ---------- Storage / file helpers ----------

export function resolveResourceFile(companySlug: string, storageKey: string): string | null {
  const root = resourcesRoot(companySlug);
  const abs = path.join(root, path.basename(storageKey));
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

export async function deleteResourceBytes(storageKey: string, companySlug: string): Promise<void> {
  try {
    const root = resourcesRoot(companySlug);
    const abs = path.join(root, path.basename(storageKey));
    if (!abs.startsWith(root)) return;
    if (fs.existsSync(abs)) await fs.promises.unlink(abs);
  } catch {
    /* noop */
  }
}

/**
 * Text out of an uploaded file, whichever kind it turned out to be.
 *
 * Both ingestion paths — a human dropping a file on the Resources page and an
 * AI Employee filing one it converted or pulled off an email — land here, so
 * a `.docx` cannot mean one thing on one route and something else on the
 * other. A failure is data, not an exception: the row is still created with
 * `status: 'failed'` and the reason on it, because a Resource whose text could
 * not be extracted is still a file someone can open.
 */
export async function extractResourceText(
  absPath: string,
  filename: string,
  sourceKind: ResourceSourceKind,
): Promise<{ bodyText: string; status: "ready" | "failed"; errorMessage: string }> {
  if (sourceKind === "video") {
    // Accept the upload but flag it — ASR is deliberately out of v1.
    return {
      bodyText: "",
      status: "failed",
      errorMessage:
        "Video transcripts aren't supported yet. Upload a transcript as text or paste the URL of one.",
    };
  }
  try {
    if (sourceKind === "pdf") {
      const buf = await fs.promises.readFile(absPath);
      return gradeExtraction(trimBodyText(await pdfBufferToText(buf)), "pdf");
    }
    if (sourceKind === "epub") {
      return gradeExtraction(trimBodyText(await epubFileToText(absPath)), "epub");
    }
    const buf = await fs.promises.readFile(absPath);
    if (looksLikeWordDocument("", filename)) {
      // A Word document infers as `text`, and decoding a zip as UTF-8 filled
      // `bodyText` with mojibake that search then happily matched against.
      return gradeExtraction(trimBodyText(await docxBufferToText(buf)), "docx");
    }
    // Everything unrecognised infers as `text` (`inferSourceKindFromFilename`),
    // so this branch is where a .png, .xlsx, .mp3 or .zip lands. Decoding those
    // as UTF-8 used to store mojibake and stamp the row `ready` — the summary
    // on the index card was literal PNG chunk names, and `search_resources`
    // matched against them. Refuse the bytes instead of indexing them.
    if (isBinary(buf)) {
      return { bodyText: "", status: "failed", errorMessage: binaryRefusal(buf, filename) };
    }
    const raw = buf.toString("utf8");
    const ext = path.extname(filename).toLowerCase();
    const bodyText =
      ext === ".html" || ext === ".htm" ? trimBodyText(htmlToText(raw).text) : trimBodyText(raw);
    return gradeExtraction(bodyText, "text");
  } catch (err) {
    return {
      bodyText: "",
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * A Resource whose extraction produced nothing is not Ready.
 *
 * Nothing used to check. `pdf-parse` does not throw on a scanned contract with
 * no text layer — it returns "\n\n" — so the row was saved `ready` with an
 * empty body, the index card showed a blank summary, and `search_resources`
 * silently never matched it. The employee then answered from nothing and
 * nobody could tell the difference between "the library has no answer" and
 * "the library has the answer and cannot read it". That second case is the
 * expensive one, and it is the one this function exists to name.
 *
 * The message is source-specific because the remedy is: a scan needs OCR or a
 * text copy, a JS-rendered page needs a PDF or a paste. Both are things a
 * human can act on, which a bare "extraction failed" is not.
 */
export function gradeExtraction(
  bodyText: string,
  kind: "pdf" | "epub" | "docx" | "text" | "url",
): { bodyText: string; status: "ready" | "failed"; errorMessage: string } {
  if (bodyText.trim().length > 0) return { bodyText, status: "ready", errorMessage: "" };
  const why: Record<typeof kind, string> = {
    pdf: "This PDF has no text layer — it is probably a scan. The file is stored and can still be viewed and signed, but nothing will find it by searching. Run it through OCR and upload the result.",
    epub: "No readable chapters came out of this EPUB. It may be DRM-protected or image-only.",
    docx: "No text came out of this Word document. It may hold only images.",
    text: "This file contained no readable text.",
    url: "This page returned no text — it is most likely rendered by JavaScript. Open it and save it as a PDF, or paste the text in directly.",
  };
  return { bodyText: "", status: "failed", errorMessage: why[kind] };
}

/**
 * Name the format we refused, when we can do it cheaply.
 *
 * Once the bytes are known to be binary, a zip signature plus a part name is
 * enough to tell an Office file from an archive — and telling someone "that's
 * a spreadsheet, Resources doesn't read those yet" is a different, actionable
 * sentence from "that file is binary". Anything we can't name gets the
 * generic line rather than a guess.
 */
function binaryRefusal(buf: Buffer, filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const named: Record<string, string> = {
    ".xlsx": "a spreadsheet",
    ".xls": "a spreadsheet",
    ".pptx": "a slide deck",
    ".ppt": "a slide deck",
    ".odt": "an OpenDocument file",
    ".ods": "an OpenDocument spreadsheet",
    ".pages": "a Pages document",
    ".key": "a Keynote deck",
    ".zip": "a zip archive",
  };
  const what = named[ext];
  if (what) {
    return `Resources can't read ${what} yet. Export it as PDF, Word, or plain text and upload that — the original is still stored here.`;
  }
  return "This file is binary, so no text could be extracted. It is stored and can be downloaded, but nothing will find it by searching. Upload a PDF, Word, or text version if you want it searchable.";
}

/**
 * Write bytes already in hand into the company's resource store.
 *
 * The sibling of the multer path, for a caller that holds a buffer rather
 * than a request: an AI Employee filing the PDF it just converted, or the
 * bytes of an attachment a customer emailed in. Returns the storage key the
 * `Resource` row carries and the absolute path extraction reads back.
 */
export async function writeResourceBytes(
  companySlug: string,
  filename: string,
  bytes: Buffer,
): Promise<{ storageKey: string; absPath: string }> {
  if (bytes.length === 0) throw new Error("Cannot file an empty file as a Resource");
  if (bytes.length > RESOURCE_MAX_BYTES) {
    throw new Error(`File exceeds the ${RESOURCE_MAX_BYTES / (1024 * 1024)} MB cap`);
  }
  const storageKey = `${crypto.randomUUID()}${safeExt(filename)}`;
  const absPath = path.join(resourcesRoot(companySlug), storageKey);
  await fs.promises.writeFile(absPath, bytes);
  return { storageKey, absPath };
}

export function inferSourceKindFromFilename(filename: string): ResourceSourceKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if (ext === ".mp4" || ext === ".mov" || ext === ".webm" || ext === ".mkv" || ext === ".avi") {
    return "video";
  }
  return "text";
}

// ---------- Grant helpers ----------

export async function upsertResourceGrant(
  employeeId: string,
  resourceId: string,
  accessLevel: ResourceAccessLevel,
): Promise<EmployeeResourceGrant> {
  const repo = AppDataSource.getRepository(EmployeeResourceGrant);
  const existing = await repo.findOneBy({ employeeId, resourceId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  const row = repo.create({ employeeId, resourceId, accessLevel });
  await repo.save(row);
  return row;
}

export async function listDirectResourceGrants(
  resourceId: string,
): Promise<EmployeeResourceGrant[]> {
  return AppDataSource.getRepository(EmployeeResourceGrant).find({
    where: { resourceId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForResource(resourceId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeResourceGrant).delete({
    resourceId,
  });
}

export async function listAccessibleResourceIds(employeeId: string): Promise<Set<string>> {
  const grants = await AppDataSource.getRepository(EmployeeResourceGrant).find({
    where: { employeeId },
  });
  return new Set(grants.map((g) => g.resourceId));
}

export async function hasResourceAccess(
  employeeId: string,
  resourceId: string,
  required: ResourceAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeResourceGrant).findOneBy({
    employeeId,
    resourceId,
  });
  if (!grant) return false;
  return RESOURCE_ACCESS_RANK[grant.accessLevel] >= RESOURCE_ACCESS_RANK[required];
}

export async function listResourcesByIds(companyId: string, ids: string[]): Promise<Resource[]> {
  if (ids.length === 0) return [];
  return AppDataSource.getRepository(Resource).find({
    where: { companyId, id: In(ids) },
    order: { updatedAt: "DESC" },
  });
}

/**
 * Grant `read` access to every AI employee in the company on this resource.
 * Called once at create time so a fresh Resource is immediately visible to
 * the team via the MCP surface — without this, every new ingestion
 * would silently land with zero grants and a human would have to walk
 * into the share modal before any employee could see it.
 *
 * Idempotent: per-employee grants are upserted, so calling this twice is
 * a no-op. Its mirror image is {@link grantAllResourcesToEmployee}, which the
 * hire route calls so an employee taken on *after* the library was filled
 * sees the library too. Together they close the hole this comment used to
 * describe as a future decision: neither order of operations now produces an
 * employee that reads an empty shelf.
 */
export async function grantResourceToAllEmployees(
  companyId: string,
  resourceId: string,
): Promise<number> {
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: ["id"],
  });
  for (const e of emps) {
    await upsertResourceGrant(e.id, resourceId, "read");
  }
  return emps.length;
}

// ---------- Passage retrieval ----------

/**
 * Finding the passage, not the document.
 *
 * A Resource body is capped at 1 MiB, and until now every read of one was
 * all-or-nothing: `get_resource` returned the whole column and the agent loop
 * head-clipped it at `toolResultCap` (60,000 chars, or as little as 8,000 on a
 * small context window — `services/agent/contextBudget.ts`). The model was
 * handed the first few percent of a book, told how much had been thrown away,
 * and given no second call that could reach the rest. Search had the mirror
 * problem: it returned whole rows and no indication of *where* in a megabyte
 * the query had matched.
 *
 * These helpers are the two halves of the fix. `buildMatchSnippet` says where
 * a hit is; `windowText` reads from there. Both are pure functions over a
 * string so they can be unit-tested without a database, and both are used by
 * the MCP handlers rather than reimplemented in them.
 */

/** Default window for one `get_resource` read. Deliberately below the
 *  smallest `toolResultCap` a real model resolves to, so the *server* decides
 *  where the text ends rather than a blind clip in the loop. */
export const RESOURCE_WINDOW_DEFAULT_CHARS = 15_000;
/** Ceiling a caller may ask for in one read. */
export const RESOURCE_WINDOW_MAX_CHARS = 40_000;
/** Characters of context returned around a search hit. */
export const RESOURCE_SNIPPET_CHARS = 240;
/** Stop counting occurrences here. Twenty is enough to say "this document is
 *  about the thing"; walking a megabyte for the exact total is not. */
export const RESOURCE_MAX_MATCHES = 20;

export type ResourceTextWindow = {
  text: string;
  bodyLength: number;
  windowStart: number;
  windowEnd: number;
  nextOffset: number | null;
  hasMore: boolean;
};

/**
 * Never cut through a surrogate pair. `String.prototype.slice` works in UTF-16
 * code units, so a naive boundary inside an emoji or an astral CJK character
 * emits a lone surrogate — which survives JSON, reaches the model as U+FFFD,
 * and corrupts the first character of the *next* window too.
 */
function safeBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  // A low surrogate here means the pair started at index - 1.
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
}

/** Pull a boundary back to the nearest earlier whitespace within `slack` so
 *  a window ends on a word rather than mid-token. */
function snapBackToWhitespace(text: string, index: number, slack: number): number {
  if (index <= 0 || index >= text.length) return index;
  const limit = Math.max(0, index - slack);
  for (let i = index; i > limit; i -= 1) {
    if (/\s/.test(text[i])) return i + 1;
  }
  return index;
}

/**
 * Read one window of a body, and say how to read the next.
 *
 * `around` finds the first occurrence of a phrase at or after `offset` and
 * centres the window on it, so an agent can go straight from a search hit to
 * the passage without arithmetic. When the phrase isn't found the window falls
 * back to `offset`, which is the honest degradation — the caller still gets
 * text, and `windowStart` tells it where the text came from.
 */
export function windowText(
  body: string,
  opts: { offset?: number; maxChars?: number; around?: string } = {},
): ResourceTextWindow {
  const bodyLength = body.length;
  const maxChars = Math.max(
    1,
    Math.min(opts.maxChars ?? RESOURCE_WINDOW_DEFAULT_CHARS, RESOURCE_WINDOW_MAX_CHARS),
  );
  let start = Math.max(0, Math.min(opts.offset ?? 0, bodyLength));

  if (opts.around && opts.around.trim().length > 0) {
    const needle = opts.around.trim().toLowerCase();
    const at = body.toLowerCase().indexOf(needle, start);
    if (at >= 0) {
      // Centre the window on the hit, keeping a little lead-in.
      start = Math.max(0, at - Math.floor(maxChars / 4));
    }
  }

  // The start is taken exactly as asked. Nudging it forward to a word
  // boundary was tried and is wrong twice over: it walks past the very hit an
  // `around`/`bodyOffset` read exists to land on, and because `nextOffset` is
  // the previous window's end, re-snapping on resume silently eats the
  // characters in between — paging a body no longer reconstructs it.
  // The end is snapped instead, which puts `nextOffset` on a word boundary
  // for free.
  start = safeBoundary(body, start);
  let end = safeBoundary(body, Math.min(start + maxChars, bodyLength));
  if (end < bodyLength) end = snapBackToWhitespace(body, end, 200);
  if (end <= start) end = safeBoundary(body, Math.min(start + maxChars, bodyLength));

  const hasMore = end < bodyLength;
  return {
    text: body.slice(start, end),
    bodyLength,
    windowStart: start,
    windowEnd: end,
    nextOffset: hasMore ? end : null,
    hasMore,
  };
}

export type ResourceMatch = {
  snippet: string;
  bodyOffset: number;
  matchCount: number;
};

/**
 * Where in the body did the query hit, and what does it say there?
 *
 * Case-insensitive without ever lowercasing the body: at fifty rows of a
 * megabyte each, `body.toLowerCase()` would allocate 50 MiB and walk it, on
 * the Express request thread, for every search. A sticky `RegExp` walked with
 * `lastIndex` reads the same characters once and stops at
 * {@link RESOURCE_MAX_MATCHES}.
 */
export function buildMatchSnippet(body: string, terms: string[]): ResourceMatch | null {
  if (!body || terms.length === 0) return null;
  let best: { at: number; length: number } | null = null;
  let matchCount = 0;

  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const re = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body)) !== null) {
      if (best === null || hit.index < best.at) best = { at: hit.index, length: hit[0].length };
      matchCount += 1;
      if (matchCount >= RESOURCE_MAX_MATCHES) break;
      // A zero-length match would spin forever; terms are non-empty, but the
      // guard costs nothing and the loop is unbounded otherwise.
      if (hit.index === re.lastIndex) re.lastIndex += 1;
    }
    if (matchCount >= RESOURCE_MAX_MATCHES) break;
  }

  if (!best) return null;
  const lead = Math.floor((RESOURCE_SNIPPET_CHARS - best.length) / 2);
  const start = safeBoundary(body, Math.max(0, best.at - Math.max(0, lead)));
  let end = safeBoundary(body, Math.min(body.length, start + RESOURCE_SNIPPET_CHARS));
  if (end < body.length) end = snapBackToWhitespace(body, end, 40);

  const raw = body.slice(start, end).replace(/\s+/g, " ").trim();
  const snippet = `${start > 0 ? "…" : ""}${raw}${end < body.length ? "…" : ""}`;
  return { snippet, bodyOffset: best.at, matchCount };
}

export type ResourceSearchHit = {
  resource: Resource;
  score: number;
  matchedIn: ("title" | "summary" | "tags" | "body")[];
  match: ResourceMatch | null;
};

export type ResourceSearchResult = {
  hits: ResourceSearchHit[];
  total: number;
  hasMore: boolean;
  /** True when the AND pass found nothing and the OR fallback answered. */
  broadened: boolean;
};

const SEARCH_COLUMNS = ["r.title", "r.summary", "r.tags", "r.bodyText"];

/**
 * Grant-scoped, relevance-ranked resource search.
 *
 * The grant gate is a correlated subquery rather than an expanded
 * `IN (:...ids)`: a company with more than 999 shared Resources would
 * otherwise blow SQLite's bound-parameter ceiling the moment its library grew,
 * and the fix is the same one line on both drivers.
 *
 * Two passes. Every token must hit some column (`andWhereTokens`); if that
 * finds nothing we re-run OR-ed and say so, because "no row contains all four
 * of your words" and "your library is empty" are different answers and the
 * caller cannot tell them apart from a bare `[]`.
 */
export async function searchResources(
  companyId: string,
  /** Null searches the whole company — the shape a human Member gets, since
   *  Members bypass the grant table entirely. */
  employeeId: string | null,
  opts: { query: string; limit: number; offset: number },
): Promise<ResourceSearchResult> {
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length === 0) return { hits: [], total: 0, hasMore: false, broadened: false };

  const grantGate = (qb: SelectQueryBuilder<Resource>): SelectQueryBuilder<Resource> => {
    const scoped = qb.where("r.companyId = :cid", { cid: companyId });
    if (employeeId === null) return scoped;
    return scoped
      .andWhere((sub) => {
        const inner = sub
          .subQuery()
          .select("g.resourceId")
          .from(EmployeeResourceGrant, "g")
          .where("g.employeeId = :eid")
          .getQuery();
        return `r.id IN ${inner}`;
      })
      .setParameter("eid", employeeId);
  };

  const repo = AppDataSource.getRepository(Resource);
  const run = async (broaden: boolean) => {
    const base = grantGate(repo.createQueryBuilder("r"));
    const filtered = broaden
      ? orWhereTokens(base, SEARCH_COLUMNS, tokens)
      : andWhereTokens(base, SEARCH_COLUMNS, tokens);
    // Count on the same predicate — the caller needs to know a page is a page.
    const total = await filtered.clone().getCount();
    const rows = await filtered
      .orderBy("r.updatedAt", "DESC")
      .skip(opts.offset)
      .take(opts.limit)
      .getMany();
    return { total, rows };
  };

  let broadened = false;
  let { total, rows } = await run(false);
  if (total === 0) {
    broadened = true;
    ({ total, rows } = await run(true));
  }

  const q = opts.query.trim().toLowerCase();
  const terms = [opts.query.trim(), ...tokens.map((t) => t.raw)];
  const hits = rows.map((resource) => {
    const matchedIn: ResourceSearchHit["matchedIn"] = [];
    const title = resource.title.toLowerCase();
    const summary = (resource.summary ?? "").toLowerCase();
    const tags = (resource.tags ?? "").toLowerCase();
    if (tokens.some((t) => title.includes(t.lo))) matchedIn.push("title");
    if (tokens.some((t) => summary.includes(t.lo))) matchedIn.push("summary");
    if (tokens.some((t) => tags.includes(t.lo))) matchedIn.push("tags");

    // Snippet from the body first — that is the one the model cannot see
    // anywhere else. Fall back to the summary so a title-only hit still
    // explains itself.
    const bodyMatch = buildMatchSnippet(resource.bodyText ?? "", terms);
    if (bodyMatch) matchedIn.push("body");
    const match = bodyMatch ?? buildMatchSnippet(resource.summary ?? "", terms);

    let score = scoreLabel(resource.title, q, tokens);
    if (matchedIn.includes("tags")) score += 6;
    if (matchedIn.includes("summary")) score += 4;
    if (bodyMatch) score += Math.min(bodyMatch.matchCount, 5);
    return { resource, score, matchedIn, match };
  });

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.resource.updatedAt.getTime() - a.resource.updatedAt.getTime();
  });

  return { hits, total, hasMore: opts.offset + rows.length < total, broadened };
}

/**
 * Grant `read` on every existing Resource to one employee. The hire-time
 * mirror of `grantResourceToAllEmployees`.
 *
 * Without this, the order in which a company did two ordinary things decided
 * whether its AI Employees could read anything: ingest first and then hire,
 * and the new employee's `list_resources` returned `[]` forever — not an
 * error, not a warning, just an empty shelf indistinguishable from a company
 * that had never filed anything. The employee would then answer from its own
 * guesses with total confidence.
 *
 * Written as three statements rather than a loop of upserts because a company
 * with a real library and a growing roster would otherwise pay two queries per
 * resource per hire.
 */
export async function grantAllResourcesToEmployee(
  companyId: string,
  employeeId: string,
): Promise<number> {
  const resources = await AppDataSource.getRepository(Resource).find({
    where: { companyId },
    select: ["id"],
  });
  if (resources.length === 0) return 0;
  const grantRepo = AppDataSource.getRepository(EmployeeResourceGrant);
  const existing = await grantRepo.find({ where: { employeeId }, select: ["resourceId"] });
  const held = new Set(existing.map((g) => g.resourceId));
  const missing = resources.filter((r) => !held.has(r.id));
  if (missing.length === 0) return 0;
  await grantRepo.save(
    missing.map((r) => grantRepo.create({ employeeId, resourceId: r.id, accessLevel: "read" })),
  );
  return missing.length;
}

/** Drop every Resource grant an employee holds. Called when it is fired, so
 *  the share modal stops listing a row for someone who no longer exists. */
export async function deleteResourceGrantsForEmployee(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeResourceGrant).delete({ employeeId });
}
