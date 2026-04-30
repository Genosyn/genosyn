import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import multer from "multer";
import unzipper from "unzipper";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Learning } from "../db/entities/Learning.js";
import type { LearningSourceKind } from "../db/entities/Learning.js";
import {
  EmployeeLearningGrant,
} from "../db/entities/EmployeeLearningGrant.js";
import type { NoteAccessLevel } from "../db/entities/EmployeeNoteGrant.js";
import { Company } from "../db/entities/Company.js";
import { companyDir, ensureDir } from "./paths.js";

/**
 * Learnings — knowledge ingestion. The store is a flat per-company table
 * of `Learning` rows; bytes for uploads land on disk under
 * `data/companies/<slug>/learnings/`. Retrieval is substring matching on
 * `bodyText` for v1, mirroring `search_notes`.
 *
 * Source kinds:
 *   - `url`: fetch + minimal HTML→text extraction
 *   - `text`: human-pasted plain text
 *   - `pdf`: extracted via `pdf-parse`
 *   - `epub`: unzipped + each XHTML chapter stripped to text
 *   - `video`: accepted but stored as `failed` for now (no ASR yet)
 */

export const LEARNING_MAX_BYTES = 25 * 1024 * 1024;
/** Hard cap on the extracted text we keep on the row; SQLite handles MBs but
 * pulling a 50 MiB ebook body into a JSON response is wasteful. */
export const LEARNING_BODY_TEXT_CAP = 1 * 1024 * 1024;
/** Summary auto-generated when humans don't supply one. First N characters
 * of the extracted body text, single-line. */
export const LEARNING_AUTO_SUMMARY_CHARS = 320;

function learningsRoot(companySlug: string): string {
  const dir = path.join(companyDir(companySlug), "learnings");
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
 * Multer middleware for the create-learning route. Single-file upload
 * under field name `file`, capped at 25 MB. The route handler must set
 * `req.company` first (same pattern as the bases attachment route).
 */
export const learningUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const co = (req as unknown as { company?: Company }).company;
        if (!co) {
          cb(new Error("Company context missing on upload"), "");
          return;
        }
        cb(null, learningsRoot(co.slug));
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
    fileSize: LEARNING_MAX_BYTES,
    files: 1,
  },
});

export async function uniqueLearningSlug(
  companyId: string,
  base: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Learning);
  let slug = base || "learning";
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
 * readability into the dep tree — for v1 we keep paragraph boundaries
 * but throw away inline markup. Good enough for substring search and
 * for an AI to read back.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].trim()).slice(0, 200)
    : "";

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
 * non-2xx response throws with a helpful message — the caller stamps the
 * row as `failed` and surfaces the error.
 */
export async function fetchUrlAsText(
  url: string,
): Promise<{ title: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be ingested.");
  }
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // Give servers a real-looking UA so a few sites don't refuse us.
      "User-Agent":
        "GenosynLearningBot/1.0 (+https://genosyn.com)",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LEARNING_MAX_BYTES) {
    throw new Error("Response is larger than the 25 MB ingestion cap.");
  }
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
 * PDF when imported as `require('pdf-parse')` from CJS — to avoid that
 * we go straight at the inner module.
 */
export async function pdfBufferToText(buf: Buffer): Promise<string> {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    data: Buffer,
  ) => Promise<{ text: string }>;
  const out = await pdfParse(buf);
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
    if (parts.join("\n\n").length > LEARNING_BODY_TEXT_CAP * 2) {
      // Stop early; the cap below trims to LEARNING_BODY_TEXT_CAP anyway.
      break;
    }
  }
  return parts.join("\n\n");
}

export function trimBodyText(text: string): string {
  // Strip embedded NUL bytes — SQLite's text APIs occasionally trip on
  // them when they leak in from PDF/EPUB extraction.
  // eslint-disable-next-line no-control-regex
  const normalized = text.replace(/\u0000/g, "").trim();
  if (normalized.length <= LEARNING_BODY_TEXT_CAP) return normalized;
  return normalized.slice(0, LEARNING_BODY_TEXT_CAP);
}

export function summarize(text: string, summary?: string): string {
  if (summary && summary.trim().length > 0) return summary.trim();
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= LEARNING_AUTO_SUMMARY_CHARS) return oneLine;
  return oneLine.slice(0, LEARNING_AUTO_SUMMARY_CHARS - 1) + "…";
}

// ---------- Storage / file helpers ----------

export function resolveLearningFile(
  companySlug: string,
  storageKey: string,
): string | null {
  const root = learningsRoot(companySlug);
  const abs = path.join(root, path.basename(storageKey));
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

export async function deleteLearningBytes(
  storageKey: string,
  companySlug: string,
): Promise<void> {
  try {
    const root = learningsRoot(companySlug);
    const abs = path.join(root, path.basename(storageKey));
    if (!abs.startsWith(root)) return;
    if (fs.existsSync(abs)) await fs.promises.unlink(abs);
  } catch {
    /* noop */
  }
}

export function inferSourceKindFromFilename(
  filename: string,
): LearningSourceKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if (
    ext === ".mp4" ||
    ext === ".mov" ||
    ext === ".webm" ||
    ext === ".mkv" ||
    ext === ".avi"
  ) {
    return "video";
  }
  return "text";
}

// ---------- Grant helpers ----------

export async function upsertLearningGrant(
  employeeId: string,
  learningId: string,
  accessLevel: NoteAccessLevel,
): Promise<EmployeeLearningGrant> {
  const repo = AppDataSource.getRepository(EmployeeLearningGrant);
  const existing = await repo.findOneBy({ employeeId, learningId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  const row = repo.create({ employeeId, learningId, accessLevel });
  await repo.save(row);
  return row;
}

export async function listDirectLearningGrants(
  learningId: string,
): Promise<EmployeeLearningGrant[]> {
  return AppDataSource.getRepository(EmployeeLearningGrant).find({
    where: { learningId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForLearning(
  learningId: string,
): Promise<void> {
  await AppDataSource.getRepository(EmployeeLearningGrant).delete({
    learningId,
  });
}

export async function listAccessibleLearningIds(
  employeeId: string,
): Promise<Set<string>> {
  const grants = await AppDataSource.getRepository(
    EmployeeLearningGrant,
  ).find({ where: { employeeId } });
  return new Set(grants.map((g) => g.learningId));
}

export async function hasLearningAccess(
  employeeId: string,
  learningId: string,
  required: NoteAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(
    EmployeeLearningGrant,
  ).findOneBy({ employeeId, learningId });
  if (!grant) return false;
  if (required === "read") return true;
  return grant.accessLevel === "write";
}

export async function listLearningsByIds(
  companyId: string,
  ids: string[],
): Promise<Learning[]> {
  if (ids.length === 0) return [];
  return AppDataSource.getRepository(Learning).find({
    where: { companyId, id: In(ids) },
    order: { updatedAt: "DESC" },
  });
}
