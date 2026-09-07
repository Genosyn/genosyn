import { randomUUID } from "node:crypto";
import { In, IsNull, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { Attachment } from "../db/entities/Attachment.js";
import {
  attachmentImageContextForMessages,
  inlineAttachmentsForMessage,
} from "./attachmentText.js";

export class MemberChatAttachmentError extends Error {
  status = 400;
}

/** Resolve an explicit attachment list without accepting another Member's upload. */
export async function validateMemberChatAttachments(
  companyId: string,
  userId: string | null,
  ids: string[],
  manager: EntityManager = AppDataSource.manager,
): Promise<Attachment[]> {
  if (ids.length === 0) return [];
  if (!userId || ids.length > 10 || new Set(ids).size !== ids.length) {
    throw new MemberChatAttachmentError(
      "Choose at most 10 different files uploaded for this message.",
    );
  }
  const rows = await manager.getRepository(Attachment).findBy({
    id: In(ids),
    companyId,
    uploadedByUserId: userId,
    messageId: IsNull(),
  });
  if (rows.length !== ids.length) {
    throw new MemberChatAttachmentError(
      "One or more attachments are unavailable. Upload them again before sending.",
    );
  }
  return ids.map((id) => rows.find((row) => row.id === id)!);
}

/** Claim every staged file together; a concurrent send cannot silently lose a file. */
export async function claimMemberChatAttachments(
  companyId: string,
  userId: string | null,
  ids: string[],
  messageId: string = randomUUID(),
  manager?: EntityManager,
): Promise<Attachment[]> {
  if (ids.length === 0) return [];
  const claim = async (manager: EntityManager) => {
    const rows = await validateMemberChatAttachments(companyId, userId, ids, manager);
    for (const row of rows) {
      const result = await manager
        .getRepository(Attachment)
        .update(
          { id: row.id, companyId, uploadedByUserId: userId!, messageId: IsNull() },
          { messageId },
        );
      if (result.affected !== 1)
        throw new MemberChatAttachmentError(
          "An attachment was already sent. Upload it again to include it here.",
        );
      row.messageId = messageId;
    }
    return rows;
  };
  return manager ? claim(manager) : withSerializedTransaction(claim);
}

export function serializeChatAttachment(row: Attachment) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    isImage: row.mimeType.startsWith("image/"),
  };
}

/** A Base question has no durable message row; release inputs after the model call so failures remain retryable. */
export async function prepareMemberChatAttachmentContext({
  companyId,
  userId,
  ids,
}: {
  companyId: string;
  userId: string;
  ids: string[];
}) {
  const messageId = randomUUID();
  await claimMemberChatAttachments(companyId, userId, ids, messageId);
  const release = async () => {
    if (ids.length)
      await AppDataSource.getRepository(Attachment).update(
        { companyId, uploadedByUserId: userId, messageId },
        { messageId: null },
      );
  };
  try {
    const text = await inlineAttachmentsForMessage(messageId, companyId);
    const images = (await attachmentImageContextForMessages([messageId], companyId)).get(messageId);
    return { text, images, release };
  } catch (error) {
    await release();
    throw error;
  }
}
