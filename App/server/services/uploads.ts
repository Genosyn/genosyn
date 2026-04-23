import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import { AppDataSource } from "../db/datasource.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { companyDir, ensureDir } from "./paths.js";

/**
 * File-upload layer for the workspace-chat surface.
 *
 * Uploads land on local disk under
 * `data/companies/<slug>/attachments/<uuid>.<ext>`. The sqlite row
 * (Attachment) carries only metadata — filename, mime type, size, and a
 * storage key — so large binaries never bloat the DB.
 *
 * Orphan handling: attachments are uploaded before the message is sent
 * (the composer needs the id to embed in the message body), so a user that
 * abandons the composer leaves a row behind with `messageId = null`. A
 * future sweeper can drop these; in v1 we just accept the cost — disk is
 * cheap and the UI doesn't surface them.
 */

export const ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;

function attachmentsRoot(companySlug: string): string {
  const dir = path.join(companyDir(companySlug), "attachments");
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
 * 25 MB. Storage uses diskStorage so we never hold the whole file in memory;
 * the filename is a new uuid + the original extension.
 *
 * The `destination` callback needs the companySlug to know where to write.
 * We resolve that from the URL param `cid` → Company.slug at call time
 * (the routes/workspace.ts layer sets `req.company` before multer runs).
 */
export const uploadMiddleware = multer({
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
    fileSize: ATTACHMENTS_MAX_BYTES,
    files: 1,
  },
});

/**
 * Persist the attachment row after multer drops the file on disk. Called
 * from the route handler; returns the hydrated Attachment so the route can
 * respond with the id the client will embed in the outgoing message.
 */
export async function recordAttachment(params: {
  companyId: string;
  companySlug: string;
  file: Express.Multer.File;
  uploadedByUserId: string;
}): Promise<Attachment> {
  const repo = AppDataSource.getRepository(Attachment);
  const attachment = repo.create({
    companyId: params.companyId,
    messageId: null,
    filename: params.file.originalname,
    mimeType: params.file.mimetype || "application/octet-stream",
    sizeBytes: params.file.size,
    storageKey: path.basename(params.file.path),
    uploadedByUserId: params.uploadedByUserId,
  });
  await repo.save(attachment);
  return attachment;
}

/**
 * Resolve an attachment id → absolute path on disk. Guards against path
 * traversal by re-joining from the company's attachment root so an attacker
 * can't smuggle `..` through `storageKey`. Returns null if the file is
 * missing or the row doesn't belong to the requested company.
 */
export async function resolveAttachmentFile(
  attachmentId: string,
  companyId: string,
): Promise<{ row: Attachment; absPath: string; company: Company } | null> {
  const row = await AppDataSource.getRepository(Attachment).findOneBy({
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
 * Attach uploaded files to a message after it's persisted. Called from the
 * chat service right after `ChannelMessage` is saved.
 */
export async function bindAttachmentsToMessage(
  attachmentIds: string[],
  messageId: string,
  companyId: string,
): Promise<Attachment[]> {
  if (attachmentIds.length === 0) return [];
  const repo = AppDataSource.getRepository(Attachment);
  const rows = await repo.findByIds(attachmentIds);
  const scoped = rows.filter(
    (r) => r.companyId === companyId && r.messageId === null,
  );
  for (const r of scoped) r.messageId = messageId;
  await repo.save(scoped);
  return scoped;
}

export async function attachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;
  const rows = await AppDataSource.getRepository(Attachment)
    .createQueryBuilder("a")
    .where("a.messageId IN (:...ids)", { ids: messageIds })
    .orderBy("a.createdAt", "ASC")
    .getMany();
  for (const r of rows) {
    if (!r.messageId) continue;
    const arr = out.get(r.messageId) ?? [];
    arr.push(r);
    out.set(r.messageId, arr);
  }
  return out;
}
