import fs from "node:fs/promises";
import { In, IsNull, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { recordAttachment, resolveAttachmentFile } from "./uploads.js";

export const WORK_SESSION_ATTACHMENTS_MAX = 10;

export type WorkSessionAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export function serializeWorkSessionAttachment(row: Attachment): WorkSessionAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    isImage: row.mimeType.startsWith("image/"),
  };
}

export async function recordWorkSessionAttachment(args: Parameters<typeof recordAttachment>[0]) {
  try {
    if (args.file.size === 0) throw new Error("Cannot attach an empty file.");
    return await recordAttachment(args);
  } catch (error) {
    await fs.rm(args.file.path, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * A turn UUID owns its uploads just as a chat message UUID does. Claim them in
 * the transaction that writes the turn, so an invalid or already-used upload
 * cannot leave half a request behind or be silently dropped from the brief.
 */
export async function bindWorkSessionAttachments(args: {
  attachmentIds: string[];
  turnId: string;
  companyId: string;
  userId: string;
  manager: EntityManager;
}): Promise<void> {
  if (args.attachmentIds.length > WORK_SESSION_ATTACHMENTS_MAX) {
    throw new Error(`Attach at most ${WORK_SESSION_ATTACHMENTS_MAX} files to one instruction.`);
  }
  const ids = [...new Set(args.attachmentIds)];
  if (!ids.length) return;
  const repo = args.manager.getRepository(Attachment);
  const result = await repo.update(
    {
      id: In(ids),
      companyId: args.companyId,
      uploadedByUserId: args.userId,
      messageId: IsNull(),
    },
    { messageId: args.turnId },
  );
  if (result.affected !== ids.length) {
    throw new Error("An attachment is unavailable. Upload your files again before sending.");
  }
}

export async function resolveWorkSessionAttachment(
  repository: Repository,
  userId: string,
  attachmentId: string,
) {
  const resolved = await resolveAttachmentFile(attachmentId, repository.companyId);
  if (!resolved) return null;
  if (!resolved.row.messageId) {
    return resolved.row.uploadedByUserId === userId ? resolved : null;
  }
  const turn = await AppDataSource.getRepository(RepositoryWorkSessionTurn).findOneBy({
    id: resolved.row.messageId,
    companyId: repository.companyId,
  });
  if (!turn) return null;
  const session = await AppDataSource.getRepository(RepositoryWorkSession).exist({
    where: {
      id: turn.sessionId,
      companyId: repository.companyId,
      repositoryId: repository.id,
    },
  });
  return session ? resolved : null;
}
