import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ATTACHMENTS_MAX_BYTES, resolveAttachmentFile } from "./uploads.js";
import { XlsxError } from "./xlsxPackage.js";

/** Workbooks are attachment bytes, never paths supplied by an AI Employee. */
export async function loadXlsxAttachment(attachmentId: string, companyId: string) {
  const resolved = await resolveAttachmentFile(attachmentId, companyId);
  if (!resolved || resolved.row.storageKey !== path.basename(resolved.row.storageKey)) {
    throw new XlsxError("Attachment not found", 404);
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resolved.absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new XlsxError("Attachment not found", 404);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new XlsxError("Attachment not found", 404);
    if (stat.size > ATTACHMENTS_MAX_BYTES) {
      throw new XlsxError("The workbook exceeds the 25 MB attachment limit.", 413);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) {
      throw new XlsxError("The workbook changed while being read. Try again.");
    }
    return { row: resolved.row, bytes: bytes.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}

/** Keep the downloaded name consistent with the actual workbook format. */
export function editedXlsxFilename(original: string, override?: string): string {
  const clean = path
    .basename((override ?? original).replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const stem =
    clean
      .replace(/\.[^.]{1,12}$/, "")
      .replace(/^\.+/, "")
      .trim() || "workbook";
  return `${stem.slice(0, override ? 195 : 188)}${override ? "" : "-edited"}.xlsx`;
}
