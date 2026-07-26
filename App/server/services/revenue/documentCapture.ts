import crypto from "node:crypto";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import {
  RevenueDocument,
  type RevenueDocumentKind,
} from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { accessTokenForAccount } from "../mail/accounts.js";
import {
  getAttachment,
  type ParsedAttachment,
} from "../mail/gmailClient.js";
import { recordAttachmentBytes } from "../uploads.js";
import { createRevenueDocument } from "./documents.js";
import type { RevenueOperationActor } from "./operations.js";

type ResourceSuggestion = {
  resourceType: "account" | "contact" | "deal" | "partnership";
  resourceId: string;
  label: string;
  confidence: number;
  reason: string;
};

const RELEVANT_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "json",
  "pdf",
  "ppt",
  "pptx",
  "rtf",
  "txt",
  "xls",
  "xlsx",
  "xml",
  "zip",
]);

function attachmentMetadata(message: MailMessage): ParsedAttachment[] {
  try {
    const parsed = JSON.parse(message.attachmentsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is ParsedAttachment =>
            Boolean(
              item &&
                typeof item === "object" &&
                typeof (item as ParsedAttachment).attachmentId === "string",
            ),
        )
      : [];
  } catch {
    return [];
  }
}

function classify(filename: string, subject: string): RevenueDocumentKind | null {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (!RELEVANT_EXTENSIONS.has(extension)) return null;
  const text = `${filename} ${subject}`.toLowerCase();
  if (/\b(rfp|request.for.proposal|tender)\b/.test(text)) return "rfp";
  if (/\b(security|questionnaire|vendor.assessment|dpa|privacy)\b/.test(text)) {
    return "security_questionnaire";
  }
  if (/\b(contract|agreement|msa|sow|order.form|terms)\b/.test(text)) return "contract";
  if (/\b(proposal|quote|quotation|pricing|estimate)\b/.test(text)) return "proposal";
  return extension === "pdf" || extension === "doc" || extension === "docx"
    ? "email_attachment"
    : null;
}

function participantEmails(message: MailMessage): string[] {
  return [
    message.fromEmail,
    ...message.toEmails.split(","),
    ...message.ccEmails.split(","),
    ...message.bccEmails.split(","),
  ]
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

async function suggestionsForMessage(
  companyId: string,
  message: MailMessage,
): Promise<ResourceSuggestion[]> {
  const emails = participantEmails(message);
  const contacts = emails.length
    ? await AppDataSource.getRepository(Contact).find({
        where: { companyId, email: In(emails), archivedAt: IsNull() },
      })
    : [];
  const suggestions: ResourceSuggestion[] = contacts.map((contact) => ({
    resourceType: "contact",
    resourceId: contact.id,
    label: contact.name,
    confidence: contacts.length === 1 ? 85 : 65,
    reason: `Message participant ${contact.email}`,
  }));
  const contactIds = contacts.map((contact) => contact.id);
  const accountIds = [
    ...new Set(contacts.map((contact) => contact.customerId).filter((id): id is string => Boolean(id))),
  ];
  for (const contact of contacts) {
    if (contact.customerId) {
      suggestions.push({
        resourceType: "account",
        resourceId: contact.customerId,
        label: contact.companyName || contact.name,
        confidence: contacts.length === 1 ? 80 : 60,
        reason: `Account linked to ${contact.name}`,
      });
    }
  }
  if (contactIds.length > 0 || accountIds.length > 0) {
    const dealQb = AppDataSource.getRepository(Deal)
      .createQueryBuilder("deal")
      .where("deal.companyId = :companyId", { companyId })
      .andWhere("deal.archivedAt IS NULL");
    if (contactIds.length > 0 && accountIds.length > 0) {
      dealQb.andWhere(
        "(deal.primaryContactId IN (:...contactIds) OR deal.customerId IN (:...accountIds))",
        { contactIds, accountIds },
      );
    } else if (contactIds.length > 0) {
      dealQb.andWhere("deal.primaryContactId IN (:...contactIds)", { contactIds });
    } else {
      dealQb.andWhere("deal.customerId IN (:...accountIds)", { accountIds });
    }
    const deals = await dealQb.orderBy("deal.updatedAt", "DESC").take(20).getMany();
    for (const deal of deals) {
      const titleMatch = message.subject.toLowerCase().includes(deal.title.toLowerCase());
      suggestions.push({
        resourceType: "deal",
        resourceId: deal.id,
        label: deal.title,
        confidence: titleMatch ? 95 : deals.length === 1 ? 88 : deal.status === "open" ? 75 : 55,
        reason: titleMatch ? "Deal title appears in the subject" : "Deal matches a message participant",
      });
    }
  }
  if (contactIds.length > 0) {
    const partnerLinks = await AppDataSource.getRepository(PartnershipContact).find({
      where: { companyId, contactId: In(contactIds) },
    });
    const partnerships = partnerLinks.length
      ? await AppDataSource.getRepository(Partnership).find({
          where: {
            companyId,
            id: In(partnerLinks.map((link) => link.partnershipId)),
            archivedAt: IsNull(),
          },
        })
      : [];
    const partnershipById = new Map(partnerships.map((partnership) => [partnership.id, partnership]));
    for (const link of partnerLinks) {
      const partnership = partnershipById.get(link.partnershipId);
      if (!partnership) continue;
      suggestions.push({
        resourceType: "partnership",
        resourceId: partnership.id,
        label: partnership.name,
        confidence: partnerLinks.length === 1 ? 80 : 60,
        reason: "Partnership Contact is a message participant",
      });
    }
  }
  const unique = new Map(
    suggestions.map((suggestion) => [
      `${suggestion.resourceType}:${suggestion.resourceId}`,
      suggestion,
    ]),
  );
  return [...unique.values()].sort((left, right) => right.confidence - left.confidence);
}

export async function createRevenueDocumentCandidatesForMessage(
  companyId: string,
  message: MailMessage,
): Promise<{ created: number; skipped: number }> {
  const suggestions = await suggestionsForMessage(companyId, message);
  const best = suggestions[0] ?? null;
  const candidateRepo = AppDataSource.getRepository(RevenueDocumentCandidate);
  let created = 0;
  let skipped = 0;
  for (const [attachmentIndex, attachment] of attachmentMetadata(message).entries()) {
    const kind = classify(attachment.filename, message.subject);
    if (!kind) {
      skipped += 1;
      continue;
    }
    const existing = await candidateRepo.findOneBy({
      companyId,
      mailMessageId: message.id,
      attachmentIndex,
    });
    if (existing) continue;
    await candidateRepo.save(
      candidateRepo.create({
        companyId,
        mailMessageId: message.id,
        attachmentIndex,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
        contentHash: "",
        proposedKind: kind,
        proposedResourceType: best?.resourceType ?? null,
        proposedResourceId: best?.resourceId ?? null,
        confidence: best?.confidence ?? 20,
        alternativesJson: JSON.stringify(suggestions),
        status: "pending",
        revenueDocumentId: null,
        reviewNote: "",
        reviewedAt: null,
        reviewedByUserId: null,
      }),
    );
    created += 1;
  }
  return { created, skipped };
}

export async function scanMailForRevenueDocuments(
  companyId: string,
  opts: {
    accountId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  scannedMessages: number;
  createdCandidates: number;
  skippedAttachments: number;
  nextOffset: number | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const qb = AppDataSource.getRepository(MailMessage)
    .createQueryBuilder("message")
    .where("message.companyId = :companyId", { companyId })
    .andWhere("message.attachmentsJson != '[]'");
  if (opts.accountId) qb.andWhere("message.accountId = :accountId", { accountId: opts.accountId });
  if (opts.from) qb.andWhere("message.sentAt >= :from", { from: opts.from });
  if (opts.to) qb.andWhere("message.sentAt < :to", { to: opts.to });
  const messages = await qb
    .orderBy("message.sentAt", "ASC")
    .skip(offset)
    .take(limit + 1)
    .getMany();
  const page = messages.slice(0, limit);
  let createdCandidates = 0;
  let skippedAttachments = 0;
  for (const message of page) {
    const result = await createRevenueDocumentCandidatesForMessage(companyId, message);
    createdCandidates += result.created;
    skippedAttachments += result.skipped;
  }
  return {
    scannedMessages: page.length,
    createdCandidates,
    skippedAttachments,
    nextOffset: messages.length > limit ? offset + limit : null,
  };
}

export async function listRevenueDocumentCandidates(
  companyId: string,
  opts: {
    status?: RevenueDocumentCandidate["status"];
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueDocumentCandidate[]; total: number }> {
  const qb = AppDataSource.getRepository(RevenueDocumentCandidate)
    .createQueryBuilder("candidate")
    .where("candidate.companyId = :companyId", { companyId });
  if (opts.status) qb.andWhere("candidate.status = :status", { status: opts.status });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("candidate.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows, total };
}

export async function reviewRevenueDocumentCandidate(
  companyId: string,
  id: string,
  input:
    | { decision: "reject"; note?: string }
    | {
        decision: "accept";
        kind?: RevenueDocumentKind;
        resourceType?: "account" | "contact" | "deal" | "partnership";
        resourceId?: string;
        note?: string;
      },
  actor: RevenueOperationActor,
): Promise<RevenueDocumentCandidate> {
  const repo = AppDataSource.getRepository(RevenueDocumentCandidate);
  const candidate = await repo.findOneBy({ companyId, id });
  if (!candidate) throw new Error("Document candidate not found");
  if (candidate.status !== "pending") throw new Error("Document candidate was already reviewed");
  if (input.decision === "reject") {
    candidate.status = "rejected";
    candidate.reviewNote = input.note ?? "";
    candidate.reviewedAt = new Date();
    candidate.reviewedByUserId = actor.userId ?? null;
    return repo.save(candidate);
  }
  const resourceType = input.resourceType ?? candidate.proposedResourceType;
  const resourceId = input.resourceId ?? candidate.proposedResourceId;
  if (!resourceType || !resourceId) throw new Error("Choose the Revenue record for this document");
  if (candidate.confidence < 80 && (!input.resourceType || !input.resourceId)) {
    throw new Error("This link is ambiguous; choose the Revenue record explicitly");
  }
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({
    companyId,
    id: candidate.mailMessageId,
  });
  if (!message) throw new Error("Source mail message no longer exists");
  const metadata = attachmentMetadata(message)[candidate.attachmentIndex];
  if (!metadata) throw new Error("Source attachment no longer exists on the message");
  const mailAccount = await AppDataSource.getRepository(MailAccount).findOneBy({
    companyId,
    id: message.accountId,
  });
  if (!mailAccount) throw new Error("Source mailbox no longer exists");
  const token = await accessTokenForAccount(mailAccount);
  const payload = await getAttachment(token, message.gmailMessageId, metadata.attachmentId);
  if (!payload.data) throw new Error("Gmail returned an empty attachment");
  const bytes = Buffer.from(payload.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const existingDocument = await AppDataSource.getRepository(RevenueDocument).findOneBy({
    companyId,
    sourceAttachmentHash: contentHash,
  });
  if (existingDocument) {
    candidate.status = "duplicate";
    candidate.contentHash = contentHash;
    candidate.revenueDocumentId = existingDocument.id;
    candidate.reviewNote = input.note ?? "Duplicate file hash";
    candidate.reviewedAt = new Date();
    candidate.reviewedByUserId = actor.userId ?? null;
    return repo.save(candidate);
  }
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new Error("Company not found");
  const attachment = await recordAttachmentBytes({
    companyId,
    companySlug: company.slug,
    filename: candidate.filename,
    mimeType: candidate.mimeType,
    bytes,
    uploadedByUserId: actor.userId ?? null,
  });
  const links = {
    dealId: resourceType === "deal" ? resourceId : null,
    customerId: resourceType === "account" ? resourceId : null,
    partnershipId: resourceType === "partnership" ? resourceId : null,
    contactId: resourceType === "contact" ? resourceId : null,
  };
  const document = await createRevenueDocument(
    companyId,
    {
      kind: input.kind ?? (candidate.proposedKind as RevenueDocumentKind),
      title: candidate.filename,
      notes: input.note ?? `Captured from mail: ${message.subject}`,
      attachmentId: attachment.id,
      sourceMailMessageId: message.id,
      sourceAttachmentIndex: candidate.attachmentIndex,
      sourceAttachmentHash: contentHash,
      ...links,
    },
    actor,
  );
  candidate.status = "accepted";
  candidate.contentHash = contentHash;
  candidate.revenueDocumentId = document.id;
  candidate.reviewNote = input.note ?? "";
  candidate.reviewedAt = new Date();
  candidate.reviewedByUserId = actor.userId ?? null;
  return repo.save(candidate);
}
