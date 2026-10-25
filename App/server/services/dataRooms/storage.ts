import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import multer from "multer";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

import {
  DATA_ROOM_ACCEPTED_EXTENSIONS,
  DATA_ROOM_LIMITS,
  fileExtension,
  isAcceptedDataRoomFile,
} from "../../../shared/dataRooms.js";
import { docxBufferToText } from "../docxRead.js";
import { dataRoomPrivateCompanyDir, dataRoot, ensureDir } from "../paths.js";
import { pdfBufferToText } from "../resources.js";
import { readXlsx } from "../xlsxRead.js";
import { DataRoomValidationError } from "./errors.js";

/**
 * A data room's files on disk: where they live, how they arrive, what text
 * comes out of them, and how a guest's copy of a PDF is stamped.
 *
 * Every file is written once under a random name in the company's App-private
 * directory (`paths.dataRoomPrivateCompanyDir`) and never changed after; the
 * document row carries its SHA-256. A guest's watermark is applied to the copy
 * on its way out, so the stored original stays exactly what was uploaded.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The type a document is stored and served as, from its extension alone. What
 * the browser or the mail server called the upload is ignored: a room serves
 * only the types it accepts, and never HTML or SVG, so nothing it hands a
 * guest can run as a page on the App's origin.
 */
export function canonicalMimeType(filename: string): string {
  return MIME_BY_EXTENSION[fileExtension(filename)] ?? "application/octet-stream";
}

export function acceptedFileMessage(): string {
  return `Upload a PDF, Word, Excel, PowerPoint, text or image file (${DATA_ROOM_ACCEPTED_EXTENSIONS.join(", ")}).`;
}

function documentsDir(companyId: string): string {
  const dir = path.join(dataRoomPrivateCompanyDir(companyId), "documents");
  ensureDir(dir);
  return dir;
}

/** Absolute path of a stored document, or null when the key is not a bare file name. */
export function resolveDocumentPath(companyId: string, storageKey: string): string | null {
  const safe = path.basename(storageKey);
  if (!safe || safe !== storageKey) return null;
  const root = documentsDir(companyId);
  const absolute = path.join(root, safe);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

/** Write new bytes under a fresh name; never overwrites, never world-readable. */
export async function writeDocumentBytes(
  companyId: string,
  filename: string,
  bytes: Buffer,
): Promise<{ storageKey: string; sha256: string }> {
  const extension = fileExtension(filename) || ".bin";
  const storageKey = `${crypto.randomUUID()}${extension}`;
  await fs.promises.writeFile(path.join(documentsDir(companyId), storageKey), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return { storageKey, sha256: sha256(bytes) };
}

export async function deleteDocumentBytes(companyId: string, storageKey: string): Promise<void> {
  const absolute = resolveDocumentPath(companyId, storageKey);
  if (!absolute) return;
  await fs.promises.unlink(absolute).catch(() => undefined);
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** One file per request, kept on disk until the route has filed it. */
export const dataRoomUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      const temporaryRoot = path.join(dataRoot(), ".private", "uploads", "data-rooms");
      ensureDir(temporaryRoot);
      callback(null, temporaryRoot);
    },
    filename: (_req, _file, callback) => {
      callback(null, `${crypto.randomUUID()}.upload`);
    },
  }),
  limits: { fileSize: DATA_ROOM_LIMITS.documentBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!isAcceptedDataRoomFile(file.originalname)) {
      callback(new DataRoomValidationError(acceptedFileMessage()));
      return;
    }
    callback(null, true);
  },
}).single("file");

/**
 * The text without control characters. Tabs and newlines survive only when
 * asked for — a file name keeps none, extracted text keeps its lines.
 */
export function stripControlCharacters(value: string, keepLines = false): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const control = code < 0x20 || code === 0x7f;
    if (!control || (keepLines && (char === "\n" || char === "\t"))) out += char;
  }
  return out;
}

/**
 * A file name safe to store and show: no path, no control characters, and an
 * extension the room accepts.
 */
export function cleanFilename(filename: string): string {
  const base = stripControlCharacters(path.basename(filename.replace(/\\/g, "/")))
    .trim()
    .slice(0, 200);
  if (!base || !isAcceptedDataRoomFile(base))
    throw new DataRoomValidationError(acceptedFileMessage());
  return base;
}

/** "Q3 board deck.pdf" → "Q3 board deck". */
export function titleFromFilename(filename: string): string {
  const title = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (title || "Untitled document").slice(0, DATA_ROOM_LIMITS.documentTitleChars);
}

// ── Text ────────────────────────────────────────────────────────────────────

export type ExtractedText = {
  text: string;
  status: "extracted" | "none";
  pageCount: number;
};

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8_192);
  return sample.includes(0);
}

function cleanExtractedText(text: string): string {
  return stripControlCharacters(text.replace(/\r\n?/g, "\n"), true)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, DATA_ROOM_LIMITS.documentTextChars);
}

async function pdfPageCount(bytes: Buffer): Promise<number> {
  try {
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return document.getPageCount();
  } catch {
    return 0;
  }
}

const PPTX_SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
/** A deck's slide XML past this is not text worth reading, and may be a zip bomb. */
const MAX_PPTX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PPTX_SLIDES = 400;

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

/** Each slide's words, in order, under "Slide N". */
export async function pptxBufferToText(bytes: Buffer): Promise<{ text: string; slides: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, match: PPTX_SLIDE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => Boolean(entry.match))
    .map((entry) => ({ name: entry.name, number: Number(entry.match[1]) }))
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_PPTX_SLIDES);
  const parts: string[] = [];
  for (const slide of slides) {
    const file = zip.file(slide.name);
    const declared = (file as unknown as { _data?: { uncompressedSize?: number } })?._data
      ?.uncompressedSize;
    if (!file || (typeof declared === "number" && declared > MAX_PPTX_PART_BYTES)) continue;
    const xml = await file.async("string");
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((paragraph) =>
        [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((run) => decodeXmlText(run[1]))
          .join(""),
      )
      .map((line) => line.trim())
      .filter(Boolean);
    if (paragraphs.length) parts.push(`Slide ${slide.number}\n${paragraphs.join("\n")}`);
  }
  return { text: parts.join("\n\n"), slides: slides.length };
}

async function xlsxBufferToText(bytes: Buffer): Promise<string> {
  const outline = await readXlsx(bytes, { maxCells: 1_000, maxChars: 50_000 });
  return outline.sheets
    .map((sheet) => {
      const cells = sheet.cells
        .filter((cell) => cell.value !== null && cell.value !== "")
        .map((cell) => `${cell.cell}: ${String(cell.value)}`);
      return cells.length ? `Sheet ${sheet.name}\n${cells.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The words in a document, for the AI Employee's brief and answers and for
 * checking the quotes they cite. A file that yields nothing is still a
 * document a guest can open; it is only invisible to the AI work.
 */
export async function extractDocumentText(bytes: Buffer, filename: string): Promise<ExtractedText> {
  const extension = fileExtension(filename);
  let text = "";
  let pageCount = 0;
  try {
    if (extension === ".pdf") {
      [text, pageCount] = await Promise.all([pdfBufferToText(bytes), pdfPageCount(bytes)]);
    } else if (extension === ".docx") {
      text = await docxBufferToText(bytes, { maxChars: DATA_ROOM_LIMITS.documentTextChars });
    } else if (extension === ".xlsx") {
      text = await xlsxBufferToText(bytes);
    } else if (extension === ".pptx") {
      const deck = await pptxBufferToText(bytes);
      text = deck.text;
      pageCount = deck.slides;
    } else if ([".txt", ".md", ".markdown", ".csv", ".tsv", ".json"].includes(extension)) {
      text = looksBinary(bytes) ? "" : bytes.toString("utf8");
    }
  } catch {
    text = "";
  }
  const cleaned = cleanExtractedText(text);
  return { text: cleaned, status: cleaned.length >= 20 ? "extracted" : "none", pageCount };
}

// ── Watermarks ──────────────────────────────────────────────────────────────

/** What the standard PDF font can draw: printable ASCII only. */
function pdfSafeText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
}

const WATERMARK_CACHE_BYTES = 64 * 1024 * 1024;
const watermarkCache = new Map<string, Buffer>();
let watermarkCacheBytes = 0;

function rememberWatermark(key: string, bytes: Buffer): void {
  if (bytes.length > WATERMARK_CACHE_BYTES / 4) return;
  // Two requests can stamp the same copy at once; count it only once.
  const previous = watermarkCache.get(key);
  if (previous) {
    watermarkCache.delete(key);
    watermarkCacheBytes -= previous.length;
  }
  watermarkCache.set(key, bytes);
  watermarkCacheBytes += bytes.length;
  for (const [oldest, value] of watermarkCache) {
    if (watermarkCacheBytes <= WATERMARK_CACHE_BYTES) break;
    watermarkCache.delete(oldest);
    watermarkCacheBytes -= value.length;
  }
}

/**
 * The PDF with `label` stamped faintly across the middle of every page and in
 * small type along its foot — who it was opened by, and when — so a copy that
 * leaves the room says where it came from.
 *
 * A deterrent, not a lock: anything shown on a screen can be photographed.
 * A PDF pdf-lib cannot rewrite (an encrypted one, a damaged one) is served as
 * uploaded rather than refused, since refusing would only stop the guest the
 * company invited from reading it.
 */
export async function watermarkPdf(
  bytes: Buffer,
  label: string,
  cacheKey?: string,
): Promise<Buffer> {
  const key = cacheKey ? `${cacheKey}:${label}` : null;
  const cached = key ? watermarkCache.get(key) : undefined;
  if (cached) return cached;
  try {
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const font = await document.embedFont(StandardFonts.Helvetica);
    const text = pdfSafeText(label);
    for (const page of document.getPages()) {
      const { width, height } = page.getSize();
      const size = Math.max(10, Math.min(28, Math.min(width, height) / 22));
      const textWidth = font.widthOfTextAtSize(text, size);
      const angle = Math.atan2(height, width);
      page.drawText(text, {
        x: width / 2 - (textWidth / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
        y: height / 2 - (textWidth / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
        size,
        font,
        color: rgb(0.39, 0.42, 0.5),
        opacity: 0.16,
        rotate: degrees((angle * 180) / Math.PI),
      });
      page.drawText(text, {
        x: 18,
        y: 10,
        size: 7,
        font,
        color: rgb(0.39, 0.42, 0.5),
        opacity: 0.6,
      });
    }
    const stamped = Buffer.from(await document.save());
    if (key) rememberWatermark(key, stamped);
    return stamped;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[data-rooms] could not watermark a PDF, serving it as uploaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return bytes;
  }
}

export function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const utf8 =
    path
      .basename(filename)
      .replace(/[\r\n]/g, "_")
      .slice(0, 255) || "document";
  const ascii = utf8.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}
