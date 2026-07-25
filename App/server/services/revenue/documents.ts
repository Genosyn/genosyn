import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Attachment } from "../../db/entities/Attachment.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { RevenueDocument, type RevenueDocumentKind } from "../../db/entities/RevenueDocument.js";
import { assertRevenueLinks } from "./integrity.js";

export type RevenueDocumentInput = {
  kind: RevenueDocumentKind;
  title: string;
  notes?: string;
  dealId?: string | null;
  customerId?: string | null;
  partnershipId?: string | null;
  contactId?: string | null;
  attachmentId?: string | null;
  sourceMailMessageId?: string | null;
  externalUrl?: string;
};

export type RevenueDocumentPatch = {
  kind?: RevenueDocumentKind;
  title?: string;
  notes?: string;
  dealId?: string | null;
  customerId?: string | null;
  partnershipId?: string | null;
  contactId?: string | null;
  externalUrl?: string;
};

export type HydratedRevenueDocument = RevenueDocument & {
  attachment: Pick<Attachment, "id" | "filename" | "mimeType" | "sizeBytes"> | null;
};

export async function listRevenueDocuments(
  companyId: string,
  filter: {
    dealId?: string;
    customerId?: string;
    partnershipId?: string;
    contactId?: string;
  } = {},
): Promise<HydratedRevenueDocument[]> {
  const repo = AppDataSource.getRepository(RevenueDocument);
  const rows = await repo.find({
    where: { companyId, ...filter },
    order: { createdAt: "DESC" },
  });
  const attachmentIds = rows.map((row) => row.attachmentId).filter((id): id is string => !!id);
  const attachments = attachmentIds.length
    ? await AppDataSource.getRepository(Attachment).find({
        where: { companyId, id: In(attachmentIds) },
      })
    : [];
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return rows.map((row) =>
    Object.assign(row, {
      attachment: row.attachmentId
        ? (() => {
            const attachment = byId.get(row.attachmentId!);
            return attachment
              ? {
                  id: attachment.id,
                  filename: attachment.filename,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                }
              : null;
          })()
        : null,
    }),
  );
}

export async function createRevenueDocument(
  companyId: string,
  input: RevenueDocumentInput,
  actor: { userId?: string | null; employeeId?: string | null },
): Promise<HydratedRevenueDocument> {
  if (!input.attachmentId && !input.sourceMailMessageId && !input.externalUrl?.trim()) {
    throw new Error("Attach a file, mail message, or external URL");
  }
  if (input.attachmentId) {
    const attachment = await AppDataSource.getRepository(Attachment).findOneBy({
      companyId,
      id: input.attachmentId,
    });
    if (!attachment) throw new Error("Attachment not found");
  }
  if (
    input.sourceMailMessageId &&
    !(await AppDataSource.getRepository(MailMessage).findOneBy({
      companyId,
      id: input.sourceMailMessageId,
    }))
  ) {
    throw new Error("Mail message not found");
  }
  await assertRevenueLinks(companyId, input, { requireOne: true });
  const row = await AppDataSource.getRepository(RevenueDocument).save(
    AppDataSource.getRepository(RevenueDocument).create({
      companyId,
      kind: input.kind,
      title: input.title.trim(),
      notes: input.notes ?? "",
      dealId: input.dealId ?? null,
      customerId: input.customerId ?? null,
      partnershipId: input.partnershipId ?? null,
      contactId: input.contactId ?? null,
      attachmentId: input.attachmentId ?? null,
      sourceMailMessageId: input.sourceMailMessageId ?? null,
      externalUrl: input.externalUrl?.trim() ?? "",
      createdByUserId: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
  return (
    await listRevenueDocuments(companyId, {
      ...(row.dealId ? { dealId: row.dealId } : {}),
      ...(row.customerId ? { customerId: row.customerId } : {}),
      ...(row.partnershipId ? { partnershipId: row.partnershipId } : {}),
      ...(row.contactId ? { contactId: row.contactId } : {}),
    })
  ).find((document) => document.id === row.id)!;
}

export async function getRevenueDocument(
  companyId: string,
  id: string,
): Promise<HydratedRevenueDocument | null> {
  const row = await AppDataSource.getRepository(RevenueDocument).findOneBy({ companyId, id });
  if (!row) return null;
  const attachment = row.attachmentId
    ? await AppDataSource.getRepository(Attachment).findOneBy({
        companyId,
        id: row.attachmentId,
      })
    : null;
  return Object.assign(row, {
    attachment: attachment
      ? {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }
      : null,
  });
}

export async function updateRevenueDocument(
  companyId: string,
  id: string,
  patch: RevenueDocumentPatch,
): Promise<HydratedRevenueDocument | null> {
  const repo = AppDataSource.getRepository(RevenueDocument);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  const links = {
    dealId: patch.dealId !== undefined ? patch.dealId : row.dealId,
    customerId: patch.customerId !== undefined ? patch.customerId : row.customerId,
    partnershipId: patch.partnershipId !== undefined ? patch.partnershipId : row.partnershipId,
    contactId: patch.contactId !== undefined ? patch.contactId : row.contactId,
  };
  await assertRevenueLinks(companyId, links, { requireOne: true });
  const externalUrl = patch.externalUrl !== undefined ? patch.externalUrl.trim() : row.externalUrl;
  if (!row.attachmentId && !row.sourceMailMessageId && !externalUrl) {
    throw new Error("A document must keep a file, mail message, or external URL");
  }
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.title !== undefined) row.title = patch.title.trim();
  if (patch.notes !== undefined) row.notes = patch.notes;
  row.externalUrl = externalUrl;
  row.dealId = links.dealId ?? null;
  row.customerId = links.customerId ?? null;
  row.partnershipId = links.partnershipId ?? null;
  row.contactId = links.contactId ?? null;
  await repo.save(row);
  return getRevenueDocument(companyId, row.id);
}

export async function deleteRevenueDocument(companyId: string, id: string): Promise<boolean> {
  const result = await AppDataSource.getRepository(RevenueDocument).delete({ companyId, id });
  return (result.affected ?? 0) > 0;
}
