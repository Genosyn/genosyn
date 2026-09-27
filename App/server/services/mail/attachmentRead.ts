import { createHash } from "node:crypto";
import { extractAttachmentTextFromBuffer } from "../attachmentText.js";
import { looksLikeWordDocument } from "../docxPackage.js";
import { DOCX_TEXT_CHAR_CAP } from "../docxRead.js";
import { looksLikeSpreadsheet } from "../xlsxPackage.js";

/** Preserve the existing requested character ceiling while allowing continuation. */
export const MAIL_ATTACHMENT_TEXT_CAP = 20_000;
/** Leave room in the smallest 8k tool-result budget for metadata and guidance. */
export const MAIL_ATTACHMENT_TEXT_JSON_CAP = 5_000;

export type MailAttachmentTextReadOptions = {
  /** UTF-16 character offset from the previous page's nextOffset. */
  textOffset?: number;
  maxTextChars?: number;
};

/** Include extraction metadata: changing the type/name can change the parser. */
export function mailAttachmentTextVersion(
  bytes: Buffer,
  mimeType: string,
  filename: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, filename]))
    .update(bytes)
    .digest("hex");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Page the extracted text, never the original file bytes. HTML remains inert
 * source text: extracting a protected-message wrapper does not decrypt it or
 * visit its links. Spreadsheet/Word extractor limits stay explicit so reaching
 * the end of a preview cannot be mistaken for reading the whole document.
 */
export async function readMailAttachmentText(
  bytes: Buffer,
  mimeType: string,
  filename: string,
  options: MailAttachmentTextReadOptions = {},
) {
  const offset = options.textOffset ?? 0;
  const limit = options.maxTextChars ?? MAIL_ATTACHMENT_TEXT_CAP;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("textOffset must be a non-negative safe integer.");
  }
  if (!Number.isInteger(limit) || limit < 2 || limit > MAIL_ATTACHMENT_TEXT_CAP) {
    throw new Error(`maxTextChars must be an integer between 2 and ${MAIL_ATTACHMENT_TEXT_CAP}.`);
  }
  const extracted = await extractAttachmentTextFromBuffer(bytes, mimeType, filename);
  // Some model transports stop at embedded NULs. Normalize before computing
  // offsets, so continuation reads use the exact text returned on page one.
  // eslint-disable-next-line no-control-regex
  const readable = extracted?.replace(/\u0000/g, "").trim() ?? "";
  if (offset > readable.length) {
    throw new Error(
      `textOffset exceeds the ${readable.length} extracted characters. Restart at textOffset: 0.`,
    );
  }
  if (splitsSurrogatePair(readable, offset)) {
    throw new Error("textOffset splits a Unicode character. Use textCoverage.nextOffset.");
  }
  let end = Math.min(readable.length, offset + limit);
  // The final response must also fit small-context model tool budgets. JSON
  // escapes control characters, so budget serialized text rather than raw
  // characters and expose the actual next offset for every shortened page.
  if (JSON.stringify(readable.slice(offset, end)).length > MAIL_ATTACHMENT_TEXT_JSON_CAP) {
    let low = offset;
    let high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(readable.slice(offset, middle)).length <= MAIL_ATTACHMENT_TEXT_JSON_CAP) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    end = low;
  }
  if (splitsSurrogatePair(readable, end)) end -= 1;
  const text = readable.slice(offset, end);
  const nextOffset = end < readable.length ? end : null;
  const extractionAvailable = extracted !== null;
  const previewOnly =
    looksLikeSpreadsheet(mimeType, filename) ||
    (looksLikeWordDocument(mimeType, filename) && (extracted?.length ?? 0) >= DOCX_TEXT_CHAR_CAP);
  return {
    // Keep recovery coordinates ahead of the payload if a smaller model's
    // own tool budget clips the response; it can retry with maxTextChars.
    textVersion: mailAttachmentTextVersion(bytes, mimeType, filename),
    truncated: nextOffset !== null,
    textCoverage: {
      extractedChars: readable.length,
      returnedChars: text.length,
      offset,
      nextOffset,
      hasMore: nextOffset !== null,
      extractionAvailable,
      previewOnly,
      complete: extractionAvailable && !previewOnly && offset === 0 && nextOffset === null,
    },
    text,
  };
}
