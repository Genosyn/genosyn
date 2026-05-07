import path from "node:path";
import fs from "node:fs";
import { AppDataSource } from "../db/datasource.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { companyDir } from "./paths.js";
import { pdfBufferToText } from "./resources.js";

/**
 * Shared attachment → prompt-context layer used by every chat surface
 * (workspace channels and 1:1 employee chats). Attachments are anonymous
 * uploads keyed only by `companyId` until they're bound to a message; the
 * helpers here read the persisted bytes back off disk and produce text the
 * AI can ingest. Image / binary types announce themselves by name only —
 * we don't yet feed image bytes into the CLI prompt.
 */

/** Per-attachment text cap; PDFs in particular can balloon a prompt. */
export const ATTACHMENT_INLINE_CHAR_CAP = 30_000;

export function formatAttachmentBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isExtractableAttachment(mime: string, filename: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    mime === "application/yaml" ||
    mime === "application/pdf"
  ) {
    return true;
  }
  const ext = path.extname(filename).toLowerCase();
  return [
    ".pdf",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".log",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".html",
    ".htm",
    ".xml",
  ].includes(ext);
}

async function extractAttachmentText(
  absPath: string,
  mime: string,
  filename: string,
): Promise<string | null> {
  if (!isExtractableAttachment(mime, filename)) return null;
  try {
    const buf = await fs.promises.readFile(absPath);
    const ext = path.extname(filename).toLowerCase();
    if (mime === "application/pdf" || ext === ".pdf") {
      return await pdfBufferToText(buf);
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Build the inline attachment block tacked onto the AI's view of a freshly
 * sent message. Headers always announce filename + mime + size; for
 * extractable types the extracted text is included verbatim (per-file
 * capped). Non-extractable types are announced by name only so the AI
 * knows something arrived and can ask for context. `messageId` is the
 * UUID of either a `ChannelMessage` or a `ConversationMessage` — the
 * Attachment row only stores the bare id, and UUIDs don't collide across
 * tables.
 */
export async function inlineAttachmentsForMessage(
  messageId: string,
  companyId: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Attachment);
  const attachments = await repo.find({
    where: { messageId },
    order: { createdAt: "ASC" },
  });
  if (attachments.length === 0) return "";

  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return "";
  const root = path.join(companyDir(company.slug), "attachments");

  const blocks: string[] = [];
  for (const a of attachments) {
    // The id has to be in the header — without it the AI can see the file
    // but has no handle to pass to read_pdf_fields / fill_pdf_form / any
    // tool that takes an `attachmentId`. Naming it `id` (not `attachmentId`)
    // matches how every MCP tool's input parameter is named.
    const header = `[Attachment id=${a.id} filename="${a.filename}" size=${formatAttachmentBytes(
      Number(a.sizeBytes),
    )} mime="${a.mimeType}"]`;
    const abs = path.join(root, path.basename(a.storageKey));
    if (!abs.startsWith(root) || !fs.existsSync(abs)) {
      blocks.push(`${header}\n(File missing on disk — cannot include content.)`);
      continue;
    }
    const text = await extractAttachmentText(abs, a.mimeType, a.filename);
    if (text === null) {
      blocks.push(
        `${header}\n(Binary or unsupported type — content cannot be inlined as text. Acknowledge the attachment and ask the teammate for any details you need.)`,
      );
      continue;
    }
    // pdf-parse occasionally emits embedded NULs; some CLIs treat those as
    // C-string terminators and silently truncate the prompt.
    // eslint-disable-next-line no-control-regex
    const trimmed = text.replace(/\u0000/g, "").trim();
    if (trimmed.length === 0) {
      blocks.push(`${header}\n(No extractable text in file.)`);
      continue;
    }
    if (trimmed.length <= ATTACHMENT_INLINE_CHAR_CAP) {
      blocks.push(`${header}\n\n${trimmed}\n[end of ${a.filename}]`);
    } else {
      blocks.push(
        `${header}\n(Showing first ${ATTACHMENT_INLINE_CHAR_CAP} of ${trimmed.length} chars.)\n\n${trimmed.slice(
          0,
          ATTACHMENT_INLINE_CHAR_CAP,
        )}\n[truncated — ${a.filename}]`,
      );
    }
  }
  return blocks.length > 0
    ? `## Attachments from this message\n\n${blocks.join("\n\n")}`
    : "";
}

/**
 * One-line "filename (mime)" summary per message id for history turns.
 * Cheap to fetch — used to remind the AI that prior turns shipped files
 * without re-inlining their content.
 */
export async function historicalAttachmentSummaries(
  messageIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messageIds.length === 0) return out;
  const rows = await AppDataSource.getRepository(Attachment)
    .createQueryBuilder("a")
    .where("a.messageId IN (:...ids)", { ids: messageIds })
    .orderBy("a.createdAt", "ASC")
    .getMany();
  for (const r of rows) {
    if (!r.messageId) continue;
    // Same id-first shape as the inline header so the AI can act on
    // attachments from earlier turns without re-asking the human to upload.
    const piece = `id=${r.id} ${r.filename} (${r.mimeType})`;
    const prev = out.get(r.messageId);
    out.set(r.messageId, prev ? `${prev}, ${piece}` : piece);
  }
  return out;
}
