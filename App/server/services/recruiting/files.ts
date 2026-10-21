import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { RESUME_MAX_BYTES } from "../../../shared/recruiting.js";
import { isBinary } from "../../lib/binaryBytes.js";
import { attachmentImageMime } from "../attachmentText.js";
import { docxBufferToText } from "../docxRead.js";
import { ensureDir, recruitingPrivateCompanyDir } from "../paths.js";
import { pdfBufferToText } from "../resources.js";
import { RecruitingValidationError } from "./errors.js";

/**
 * Applicants' files and the careers site's logo, on disk.
 *
 * Both live in the company's App-private Recruiting directory
 * (`paths.recruitingPrivateCompanyDir`), out of reach of an AI Employee's
 * coding tools, under names the server chose. Nothing is trusted about an
 * upload but its bytes: the type is decided by sniffing them, never by the
 * name or the declared MIME type, and a file that is not what a resume can be
 * is refused before it touches the disk.
 */

/** What the screener reads of a resume; a longer one is cut, never refused. */
export const RESUME_TEXT_CHAR_CAP = 60_000;

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export type ResumeKind = "pdf" | "docx" | "doc" | "odt" | "rtf" | "txt";

const RESUME_MIME: Record<ResumeKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain; charset=utf-8",
};

const RESUME_EXTENSION: Record<ResumeKind, string> = {
  pdf: ".pdf",
  docx: ".docx",
  doc: ".doc",
  odt: ".odt",
  rtf: ".rtf",
  txt: ".txt",
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export const RESUME_TYPE_HINT =
  "Upload a resume as a PDF, a Word document (.docx or .doc), an OpenDocument or RTF file, or plain text.";

/**
 * What these bytes are, if they can be a resume. Zip containers are told
 * apart by what is inside them, since a `.docx` renamed `.odt` is still a
 * `.docx`.
 */
export async function sniffResume(bytes: Buffer, filename: string): Promise<ResumeKind> {
  if (bytes.length === 0) throw new RecruitingValidationError("The resume file is empty.");
  if (bytes.length > RESUME_MAX_BYTES) {
    throw new RecruitingValidationError("Keep the resume under 10 MB.");
  }
  if (bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_MAGIC)) return "doc";
  if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    try {
      const zip = await JSZip.loadAsync(bytes);
      if (zip.file("word/document.xml")) return "docx";
      const mimetype = await zip.file("mimetype")?.async("string");
      if (mimetype?.trim() === "application/vnd.oasis.opendocument.text") return "odt";
    } catch {
      // Falls through to the refusal below: a zip we cannot open is no resume.
    }
    throw new RecruitingValidationError(RESUME_TYPE_HINT);
  }
  if (bytes.subarray(0, 5).toString("latin1") === "{\\rtf") return "rtf";
  const extension = path.extname(filename).toLowerCase();
  if ([".txt", ".md", ".markdown", ""].includes(extension) && !isBinary(bytes)) {
    const text = bytes.toString("utf8");
    if (!text.includes("�")) return "txt";
  }
  throw new RecruitingValidationError(RESUME_TYPE_HINT);
}

export function resumeMimeType(kind: ResumeKind): string {
  return RESUME_MIME[kind];
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, RESUME_TEXT_CHAR_CAP);
}

/**
 * Destinations whose contents are not the document's words: the font, colour
 * and style tables, document metadata, pictures, embedded objects, field
 * codes, bookmarks and index entries. Any `{\*\…}` destination is skipped too,
 * as the format asks of a reader that does not know it. Field results,
 * headers, footers and footnotes are kept: they are text the reader sees.
 */
const RTF_SKIPPED_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "revtbl",
  "rsidtbl",
  "filetbl",
  "pgdsctbl",
  "protusertbl",
  "latentstyles",
  "info",
  "title",
  "subject",
  "author",
  "operator",
  "keywords",
  "comment",
  "doccomm",
  "company",
  "manager",
  "category",
  "hlinkbase",
  "userprops",
  "docvar",
  "generator",
  "xmlnstbl",
  "themedata",
  "colorschememapping",
  "datastore",
  "mmathPr",
  "pict",
  "shppict",
  "nonshppict",
  "listpicture",
  "object",
  "objdata",
  "shpinst",
  "sp",
  "fldinst",
  "bkmkstart",
  "bkmkend",
  "xe",
  "tc",
  "txe",
  "rxe",
  "template",
  "pntxta",
  "pntxtb",
  "private",
  "annotation",
  "atnid",
  "atnauthor",
  "background",
  "passwordhash",
]);

/** Control words that stand for text. Everything else is formatting, and reads as nothing. */
const RTF_WORD_TEXT: Record<string, string> = {
  par: "\n",
  line: "\n",
  page: "\n",
  sect: "\n",
  column: "\n",
  row: "\n",
  cell: "\t",
  nestcell: "\t",
  tab: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
};

/** Control symbols: an escaped brace or backslash, and the special spaces and hyphens. */
const RTF_SYMBOL_TEXT: Record<string, string> = {
  "\\": "\\",
  "{": "{",
  "}": "}",
  "~": " ",
  _: "-",
  // A backslash before a line break is a paragraph mark.
  "\n": "\n",
  "\r": "\n",
};

/** Windows-1252, where it differs from Latin-1: what `\'92` and friends mean in an RTF file. */
const CP1252_HIGH: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function cp1252(code: number): string {
  return CP1252_HIGH[code] ?? String.fromCharCode(code);
}

const RTF_CONTROL_WORD = /\\([a-zA-Z]+)(-?\d+)? ?/y;
const RTF_HEX_ESCAPE = /\\'([0-9a-fA-F]{2})/y;
const RTF_TEXT_RUN = /[^\\{}\r\n]+/y;

/**
 * Read RTF down to its words.
 *
 * A small tokenizer rather than a chain of replacements, because the parts
 * to drop are groups that nest: a font table holds a group per font, a
 * picture holds hex (or raw `\bin` bytes) that may contain braces. Line
 * breaks in the file itself are not text — only `\par`, `\line` and a
 * backslash before a line break are — and a `\uN` character is followed by
 * `\ucN` fallback characters that are skipped. The input is the file's bytes
 * read as Latin-1; `\'xx` escapes are read as Windows-1252.
 */
export function rtfToText(rtf: string): string {
  type Group = { skip: boolean; uc: number };
  const stack: Group[] = [];
  let group: Group = { skip: false, uc: 1 };
  /** Just after `{` (or `{\*`): the next control word may name a destination. */
  let groupStart = false;
  let ignorable = false;
  /** Fallback characters still to skip after a `\uN`. */
  let fallback = 0;
  const out: string[] = [];
  const emit = (text: string) => {
    if (!group.skip && text) out.push(text);
  };

  let index = 0;
  while (index < rtf.length) {
    const char = rtf[index];
    if (char === "{") {
      stack.push(group);
      group = { ...group };
      groupStart = true;
      ignorable = false;
      fallback = 0;
      index += 1;
      continue;
    }
    if (char === "}") {
      group = stack.pop() ?? group;
      groupStart = false;
      ignorable = false;
      fallback = 0;
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char !== "\\") {
      RTF_TEXT_RUN.lastIndex = index;
      const run = RTF_TEXT_RUN.exec(rtf)?.[0] ?? char;
      index += run.length;
      const skipped = Math.min(fallback, run.length);
      fallback -= skipped;
      const text = run.slice(skipped);
      if (text.trim()) groupStart = false;
      emit(text.replace(/[\u0080-\u009f]/g, (high) => cp1252(high.charCodeAt(0))));
      continue;
    }

    RTF_CONTROL_WORD.lastIndex = index;
    const word = RTF_CONTROL_WORD.exec(rtf);
    if (word) {
      index = RTF_CONTROL_WORD.lastIndex;
      const name = word[1];
      const param = word[2] === undefined ? null : Number(word[2]);
      if (groupStart && (ignorable || RTF_SKIPPED_DESTINATIONS.has(name))) group.skip = true;
      groupStart = false;
      ignorable = false;
      if (name === "bin") {
        // Raw bytes follow the delimiter; they may hold anything, braces included.
        index += Math.max(0, param ?? 0);
        fallback = 0;
      } else if (name === "uc") {
        group.uc = Math.max(0, param ?? 1);
      } else if (name === "u" && param !== null) {
        emit(String.fromCharCode(param < 0 ? param + 65536 : param));
        fallback = group.uc;
      } else {
        fallback = 0;
        emit(RTF_WORD_TEXT[name] ?? "");
      }
      continue;
    }

    RTF_HEX_ESCAPE.lastIndex = index;
    const hex = RTF_HEX_ESCAPE.exec(rtf);
    if (hex) {
      index = RTF_HEX_ESCAPE.lastIndex;
      groupStart = false;
      if (fallback > 0) fallback -= 1;
      else emit(cp1252(parseInt(hex[1], 16)));
      continue;
    }

    const symbol = rtf[index + 1] ?? "";
    index += 2;
    if (symbol === "*") {
      if (groupStart) ignorable = true;
      continue;
    }
    groupStart = false;
    fallback = 0;
    emit(RTF_SYMBOL_TEXT[symbol] ?? "");
  }
  return out.join("");
}

async function odtToText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file("content.xml")?.async("string")) ?? "";
  return xml
    .replace(/<text:(?:p|h)\b[^>]*>/g, "\n")
    .replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<text:tab\s*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The words in a resume, for the screener and for AI Employees, or null when
 * none can be read — a scanned PDF, a legacy `.doc`. Never throws: an
 * unreadable resume is still a resume, kept for a person to open.
 */
export async function extractResumeText(bytes: Buffer, kind: ResumeKind): Promise<string | null> {
  try {
    let text: string;
    switch (kind) {
      case "pdf":
        text = await pdfBufferToText(bytes);
        break;
      case "docx":
        text = await docxBufferToText(bytes, { maxChars: RESUME_TEXT_CHAR_CAP * 2 });
        break;
      case "odt":
        text = await odtToText(bytes);
        break;
      case "rtf":
        text = rtfToText(bytes.toString("latin1"));
        break;
      case "txt":
        text = bytes.toString("utf8");
        break;
      default:
        return null;
    }
    const cleaned = cleanText(text);
    return cleaned.length >= 20 ? cleaned : null;
  } catch {
    return null;
  }
}

function resumesDir(companyId: string): string {
  const dir = path.join(recruitingPrivateCompanyDir(companyId), "resumes");
  ensureDir(dir);
  return dir;
}

function siteDir(companyId: string): string {
  const dir = path.join(recruitingPrivateCompanyDir(companyId), "site");
  ensureDir(dir);
  return dir;
}

/** Write new bytes under a fresh name; never overwrites, never world-readable. */
async function writeNew(dir: string, extension: string, bytes: Buffer): Promise<string> {
  const key = `${crypto.randomUUID()}${extension}`;
  await fs.promises.writeFile(path.join(dir, key), bytes, { flag: "wx", mode: 0o600 });
  return key;
}

export async function storeResume(
  companyId: string,
  bytes: Buffer,
  kind: ResumeKind,
): Promise<string> {
  return writeNew(resumesDir(companyId), RESUME_EXTENSION[kind], bytes);
}

/** The stored file for a key, or null when the key escapes the directory or is gone. */
function resolveInside(dir: string, key: string | null): string | null {
  if (!key) return null;
  const abs = path.join(dir, path.basename(key));
  if (!abs.startsWith(dir + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

export function resumeAbsPath(companyId: string, key: string | null): string | null {
  return resolveInside(resumesDir(companyId), key);
}

export async function deleteResume(companyId: string, key: string | null): Promise<void> {
  const abs = resumeAbsPath(companyId, key);
  if (abs) await fs.promises.rm(abs, { force: true });
}

const LOGO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** PNG, JPEG, GIF or WebP only: never SVG, which can carry script. */
export async function storeLogo(companyId: string, bytes: Buffer): Promise<string> {
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new RecruitingValidationError("Keep the logo under 2 MB.");
  }
  const mime = attachmentImageMime(bytes);
  if (!mime) {
    throw new RecruitingValidationError("Upload the logo as a PNG, JPEG, GIF or WebP image.");
  }
  return writeNew(siteDir(companyId), LOGO_EXTENSION[mime], bytes);
}

export function logoAbsPath(companyId: string, key: string | null): string | null {
  return resolveInside(siteDir(companyId), key);
}

export function logoMimeType(key: string): string {
  const extension = path.extname(key).toLowerCase();
  return (
    Object.entries(LOGO_EXTENSION).find(([, ext]) => ext === extension)?.[0] ?? "application/octet-stream"
  );
}

export async function deleteLogo(companyId: string, key: string | null): Promise<void> {
  const abs = logoAbsPath(companyId, key);
  if (abs) await fs.promises.rm(abs, { force: true });
}
