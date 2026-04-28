import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import { AppDataSource } from "../db/datasource.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { Company } from "../db/entities/Company.js";
import { companyDir, ensureDir } from "./paths.js";

/**
 * File-upload layer for Base records (the "open record" form attaches files
 * straight onto a row, alongside its comment thread).
 *
 * Bytes land on disk under
 * `data/companies/<slug>/base-attachments/<uuid>.<ext>`. The sqlite row
 * (BaseRecordAttachment) carries metadata + a storage key so large binaries
 * never bloat the DB.
 *
 * Shaped to mirror services/uploads.ts (workspace chat) so the patterns line
 * up; deliberately a sibling rather than reusing Attachment polymorphically
 * because the uploader can be an AI employee here.
 */

export const BASE_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;
/** Cap for AI-driven uploads so a runaway tool call can't fill the disk. */
export const BASE_ATTACHMENTS_AI_MAX_BYTES = 5 * 1024 * 1024;

function attachmentsRoot(companySlug: string): string {
  const dir = path.join(companyDir(companySlug), "base-attachments");
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
 * Multer middleware: single-file upload under field name `file`, capped at
 * 25 MB. The route handler is expected to set `req.company` before multer
 * runs (the bases router resolves the company via the `cid` path param).
 */
export const baseRecordUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const company = (req as unknown as { company?: Company }).company;
        if (!company) {
          cb(new Error("Company context missing on upload"), "");
          return;
        }
        cb(null, attachmentsRoot(company.slug));
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
    fileSize: BASE_ATTACHMENTS_MAX_BYTES,
    files: 1,
  },
});

export async function recordHumanAttachment(params: {
  companyId: string;
  recordId: string;
  file: Express.Multer.File;
  uploadedByUserId: string;
}): Promise<BaseRecordAttachment> {
  const repo = AppDataSource.getRepository(BaseRecordAttachment);
  const row = repo.create({
    recordId: params.recordId,
    companyId: params.companyId,
    filename: params.file.originalname,
    mimeType: params.file.mimetype || "application/octet-stream",
    sizeBytes: params.file.size,
    storageKey: path.basename(params.file.path),
    uploadedByUserId: params.uploadedByUserId,
    uploadedByEmployeeId: null,
  });
  await repo.save(row);
  return row;
}

/**
 * AI-driven upload path. The MCP tool sends bytes inline (base64 for small
 * binaries, plain text for text/* mime types) so the genosyn stdio binary
 * doesn't have to negotiate multipart with us. We materialize the file on
 * disk here and persist the metadata row.
 */
export async function recordEmployeeAttachment(params: {
  companyId: string;
  companySlug: string;
  recordId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  uploadedByEmployeeId: string;
}): Promise<BaseRecordAttachment> {
  if (params.bytes.length > BASE_ATTACHMENTS_AI_MAX_BYTES) {
    throw new Error(
      `Attachment exceeds the ${BASE_ATTACHMENTS_AI_MAX_BYTES / (1024 * 1024)} MB AI upload cap`,
    );
  }
  const root = attachmentsRoot(params.companySlug);
  const ext = safeExt(params.filename);
  const id = crypto.randomUUID();
  const fileName = `${id}${ext}`;
  await fs.promises.writeFile(path.join(root, fileName), params.bytes);

  const repo = AppDataSource.getRepository(BaseRecordAttachment);
  const row = repo.create({
    recordId: params.recordId,
    companyId: params.companyId,
    filename: params.filename,
    mimeType: params.mimeType || "application/octet-stream",
    sizeBytes: params.bytes.length,
    storageKey: fileName,
    uploadedByUserId: null,
    uploadedByEmployeeId: params.uploadedByEmployeeId,
  });
  await repo.save(row);
  return row;
}

export async function resolveBaseAttachmentFile(
  attachmentId: string,
  companyId: string,
): Promise<{
  row: BaseRecordAttachment;
  absPath: string;
  company: Company;
} | null> {
  const row = await AppDataSource.getRepository(BaseRecordAttachment).findOneBy({
    id: attachmentId,
  });
  if (!row || row.companyId !== companyId) return null;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return null;

  const root = attachmentsRoot(company.slug);
  const abs = path.join(root, path.basename(row.storageKey));
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return { row, absPath: abs, company };
}

/**
 * Best-effort delete of bytes on disk; the row is removed by the caller. We
 * never throw if the file is already missing — the row delete is the
 * source of truth.
 */
export async function deleteBaseAttachmentBytes(
  row: BaseRecordAttachment,
  companySlug: string,
): Promise<void> {
  try {
    const root = attachmentsRoot(companySlug);
    const abs = path.join(root, path.basename(row.storageKey));
    if (!abs.startsWith(root)) return;
    if (fs.existsSync(abs)) await fs.promises.unlink(abs);
  } catch {
    /* noop */
  }
}

export async function readBaseAttachmentText(
  row: BaseRecordAttachment,
  companySlug: string,
  maxBytes: number,
): Promise<string | null> {
  const root = attachmentsRoot(companySlug);
  const abs = path.join(root, path.basename(row.storageKey));
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  const stat = await fs.promises.stat(abs);
  if (stat.size > maxBytes) return null;
  const buf = await fs.promises.readFile(abs);
  return buf.toString("utf8");
}
