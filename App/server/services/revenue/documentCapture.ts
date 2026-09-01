import crypto from "node:crypto";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { Attachment } from "../../db/entities/Attachment.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RevenueDocument, type RevenueDocumentKind } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { normalizeEmail, parseAddressList } from "../../lib/emailAddress.js";
import type { ParsedAttachment } from "../mail/gmailClient.js";
import { mailboxForAccount } from "../mail/mailbox/index.js";
import { discardUnboundAttachment, recordAttachmentBytes } from "../uploads.js";
import { assertRevenueLinks } from "./integrity.js";
import type { RevenueOperationActor } from "./operations.js";

type ResourceSuggestion = {
  resourceType: "account" | "contact" | "deal" | "partnership";
  resourceId: string;
  label: string;
  confidence: number;
  reason: string;
};

export type PublicRevenueDocumentCandidate = Omit<RevenueDocumentCandidate, "processingToken">;

function publicDocumentCandidate(
  candidate: RevenueDocumentCandidate,
): PublicRevenueDocumentCandidate {
  const { processingToken: _processingToken, ...publicCandidate } = candidate;
  return publicCandidate;
}

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
      ? parsed.filter((item): item is ParsedAttachment =>
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
  const from = normalizeEmail(message.fromEmail);
  return [
    ...(from ? [from] : []),
    ...parseAddressList(message.toEmails).addresses,
    ...parseAddressList(message.ccEmails).addresses,
    ...parseAddressList(message.bccEmails).addresses,
  ].filter((email, index, all) => all.indexOf(email) === index);
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
    ...new Set(
      contacts.map((contact) => contact.customerId).filter((id): id is string => Boolean(id)),
    ),
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
    const deals = await dealQb
      .orderBy("CASE WHEN deal.status = 'open' THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("deal.updatedAt", "DESC")
      .take(20)
      .getMany();
    for (const deal of deals) {
      const titleMatch = message.subject.toLowerCase().includes(deal.title.toLowerCase());
      const isOpen = deal.status === "open";
      suggestions.push({
        resourceType: "deal",
        resourceId: deal.id,
        label: deal.title,
        confidence: titleMatch
          ? isOpen
            ? 95
            : 70
          : deals.length === 1
            ? isOpen
              ? 88
              : 55
            : isOpen
              ? 75
              : 55,
        reason: titleMatch
          ? "Deal title appears in the subject"
          : "Deal matches a message participant",
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
    const partnershipById = new Map(
      partnerships.map((partnership) => [partnership.id, partnership]),
    );
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
    const source = {
      companyId,
      gmailMessageId: message.gmailMessageId,
      gmailAttachmentId: attachment.attachmentId,
    };
    const existing = await candidateRepo.findOne({
      where: [
        source,
        {
          companyId,
          mailMessageId: message.id,
          attachmentIndex,
        },
      ],
    });
    if (existing) continue;
    try {
      await candidateRepo.insert(
        candidateRepo.create({
          companyId,
          mailMessageId: message.id,
          attachmentIndex,
          gmailMessageId: message.gmailMessageId,
          gmailThreadId: message.gmailThreadId,
          gmailAttachmentId: attachment.attachmentId,
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
          processingAt: null,
          processingToken: null,
          revenueDocumentId: null,
          reviewNote: "",
          reviewedAt: null,
          reviewedByUserId: null,
        }),
      );
    } catch (error) {
      // A mailbox sync and a manual backfill can enqueue the same immutable
      // Gmail attachment concurrently. The database is the arbiter; only
      // suppress the error when the winning row is now visible.
      const winner = await candidateRepo.findOne({
        where: [
          source,
          {
            companyId,
            mailMessageId: message.id,
            attachmentIndex,
          },
        ],
      });
      if (winner) continue;
      throw error;
    }
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
    accountId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: PublicRevenueDocumentCandidate[]; total: number }> {
  const qb = AppDataSource.getRepository(RevenueDocumentCandidate)
    .createQueryBuilder("candidate")
    .where("candidate.companyId = :companyId", { companyId });
  if (opts.status) qb.andWhere("candidate.status = :status", { status: opts.status });
  if (opts.accountId) {
    qb.innerJoin(
      MailMessage,
      "sourceMessage",
      "sourceMessage.id = candidate.mailMessageId AND sourceMessage.companyId = candidate.companyId",
    ).andWhere("sourceMessage.accountId = :accountId", { accountId: opts.accountId });
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("candidate.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows: rows.map(publicDocumentCandidate), total };
}

const DOCUMENT_REVIEW_LEASE_MS = 15 * 60 * 1000;

async function claimDocumentCandidate(
  companyId: string,
  id: string,
): Promise<{ candidate: RevenueDocumentCandidate; token: string }> {
  const repo = AppDataSource.getRepository(RevenueDocumentCandidate);
  const token = crypto.randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - DOCUMENT_REVIEW_LEASE_MS);
  const claimed = await repo
    .createQueryBuilder()
    .update(RevenueDocumentCandidate)
    .set({
      status: "processing",
      processingAt: now,
      processingToken: token,
    })
    .where("companyId = :companyId", { companyId })
    .andWhere("id = :id", { id })
    .andWhere(
      "(status = :pending OR (status = :processing AND (processingAt IS NULL OR processingAt <= :staleBefore)))",
      {
        pending: "pending",
        processing: "processing",
        staleBefore,
      },
    )
    .execute();
  if (claimed.affected !== 1) {
    const current = await repo.findOneBy({ companyId, id });
    if (!current) throw new Error("Document candidate not found");
    if (current.status === "processing") {
      throw new Error("Document candidate is currently being reviewed");
    }
    throw new Error("Document candidate was already reviewed");
  }
  return {
    candidate: await repo.findOneByOrFail({
      companyId,
      id,
      status: "processing",
      processingToken: token,
    }),
    token,
  };
}

async function releaseDocumentCandidateClaim(
  companyId: string,
  id: string,
  token: string,
): Promise<void> {
  await AppDataSource.getRepository(RevenueDocumentCandidate).update(
    {
      companyId,
      id,
      status: "processing",
      processingToken: token,
    },
    {
      status: "pending",
      processingAt: null,
      processingToken: null,
    },
  );
}

async function finishDocumentCandidate(
  companyId: string,
  id: string,
  token: string,
  patch: Pick<
    RevenueDocumentCandidate,
    | "status"
    | "contentHash"
    | "revenueDocumentId"
    | "reviewNote"
    | "reviewedAt"
    | "reviewedByUserId"
  >,
): Promise<PublicRevenueDocumentCandidate> {
  const repo = AppDataSource.getRepository(RevenueDocumentCandidate);
  const result = await repo.update(
    {
      companyId,
      id,
      status: "processing",
      processingToken: token,
    },
    {
      ...patch,
      processingAt: null,
      processingToken: null,
    },
  );
  if (result.affected !== 1) {
    throw new Error("Document candidate review lease was lost");
  }
  return publicDocumentCandidate(await repo.findOneByOrFail({ companyId, id }));
}

type DocumentCaptureReviewDependencies = {
  fetchAttachmentBytes?: () => Promise<Buffer>;
  recordAttachmentBytes?: typeof recordAttachmentBytes;
};

async function findCapturedDocument(
  companyId: string,
  source: {
    gmailMessageId: string;
    gmailAttachmentId: string;
    contentHash?: string;
  },
): Promise<RevenueDocument | null> {
  const qb = AppDataSource.getRepository(RevenueDocument)
    .createQueryBuilder("document")
    .where("document.companyId = :companyId", { companyId });
  if (source.contentHash) {
    qb.andWhere(
      "((document.sourceGmailMessageId = :gmailMessageId AND document.sourceGmailAttachmentId = :gmailAttachmentId) OR document.sourceAttachmentHash = :contentHash)",
      source,
    );
  } else {
    qb.andWhere(
      "document.sourceGmailMessageId = :gmailMessageId AND document.sourceGmailAttachmentId = :gmailAttachmentId",
      source,
    );
  }
  return qb.orderBy("document.createdAt", "ASC").getOne();
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
  dependencies: DocumentCaptureReviewDependencies = {},
): Promise<PublicRevenueDocumentCandidate> {
  const { candidate, token: claimToken } = await claimDocumentCandidate(companyId, id);
  let attachment: Attachment | null = null;
  let company: Company | null = null;
  try {
    if (input.decision === "reject") {
      return await finishDocumentCandidate(companyId, id, claimToken, {
        status: "rejected",
        contentHash: candidate.contentHash,
        revenueDocumentId: null,
        reviewNote: input.note ?? "",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId ?? null,
      });
    }

    const resourceType = input.resourceType ?? candidate.proposedResourceType;
    const resourceId = input.resourceId ?? candidate.proposedResourceId;
    if (!resourceType || !resourceId) {
      throw new Error("Choose the Revenue record for this document");
    }
    if (candidate.confidence < 80 && (!input.resourceType || !input.resourceId)) {
      throw new Error("This link is ambiguous; choose the Revenue record explicitly");
    }
    const links = {
      dealId: resourceType === "deal" ? resourceId : null,
      customerId: resourceType === "account" ? resourceId : null,
      partnershipId: resourceType === "partnership" ? resourceId : null,
      contactId: resourceType === "contact" ? resourceId : null,
    };
    await assertRevenueLinks(companyId, links, { requireOne: true });

    const message = await AppDataSource.getRepository(MailMessage).findOneBy({
      companyId,
      id: candidate.mailMessageId,
    });
    if (!message) throw new Error("Source mail message no longer exists");
    const metadata = attachmentMetadata(message)[candidate.attachmentIndex];
    if (!metadata) throw new Error("Source attachment no longer exists on the message");

    const source = {
      gmailMessageId: candidate.gmailMessageId || message.gmailMessageId,
      gmailAttachmentId: candidate.gmailAttachmentId || metadata.attachmentId,
    };
    const sourceWinner = await findCapturedDocument(companyId, source);
    if (sourceWinner) {
      return await finishDocumentCandidate(companyId, id, claimToken, {
        status: "duplicate",
        contentHash: candidate.contentHash,
        revenueDocumentId: sourceWinner.id,
        reviewNote: input.note ?? "Duplicate mail attachment",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId ?? null,
      });
    }

    let bytes: Buffer;
    if (dependencies.fetchAttachmentBytes) {
      bytes = await dependencies.fetchAttachmentBytes();
    } else {
      const mailAccount = await AppDataSource.getRepository(MailAccount).findOneBy({
        companyId,
        id: message.accountId,
      });
      if (!mailAccount) throw new Error("Source mailbox no longer exists");
      const mailbox = await mailboxForAccount(mailAccount);
      bytes = await mailbox.getAttachmentBytes(message.gmailMessageId, metadata);
    }
    if (bytes.length === 0) throw new Error("The mail server returned an empty attachment");
    const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const contentWinner = await findCapturedDocument(companyId, {
      ...source,
      contentHash,
    });
    if (contentWinner) {
      return await finishDocumentCandidate(companyId, id, claimToken, {
        status: "duplicate",
        contentHash,
        revenueDocumentId: contentWinner.id,
        reviewNote: input.note ?? "Duplicate file hash",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId ?? null,
      });
    }

    company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
    if (!company) throw new Error("Company not found");
    attachment = await (dependencies.recordAttachmentBytes ?? recordAttachmentBytes)({
      companyId,
      companySlug: company.slug,
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      bytes,
      uploadedByUserId: actor.userId ?? null,
    });

    try {
      return await AppDataSource.transaction(async (manager) => {
        const document = await manager.getRepository(RevenueDocument).save(
          manager.getRepository(RevenueDocument).create({
            companyId,
            kind: input.kind ?? (candidate.proposedKind as RevenueDocumentKind),
            title: candidate.filename,
            notes: input.note ?? `Captured from mail: ${message.subject}`,
            attachmentId: attachment!.id,
            sourceMailMessageId: message.id,
            sourceGmailMessageId: source.gmailMessageId,
            sourceGmailThreadId: candidate.gmailThreadId || message.gmailThreadId,
            sourceGmailAttachmentId: source.gmailAttachmentId,
            sourceAttachmentIndex: candidate.attachmentIndex,
            sourceAttachmentHash: contentHash,
            captureDedupeHash: contentHash,
            externalUrl: "",
            createdByUserId: actor.userId ?? null,
            createdByEmployeeId: actor.employeeId ?? null,
            ...links,
          }),
        );
        const finalized = await manager.getRepository(RevenueDocumentCandidate).update(
          {
            companyId,
            id,
            status: "processing",
            processingToken: claimToken,
          },
          {
            status: "accepted",
            processingAt: null,
            processingToken: null,
            contentHash,
            revenueDocumentId: document.id,
            reviewNote: input.note ?? "",
            reviewedAt: new Date(),
            reviewedByUserId: actor.userId ?? null,
          },
        );
        if (finalized.affected !== 1) {
          throw new Error("Document candidate review lease was lost");
        }
        return publicDocumentCandidate(
          await manager.getRepository(RevenueDocumentCandidate).findOneByOrFail({
            companyId,
            id,
          }),
        );
      });
    } catch (error) {
      const winner = await findCapturedDocument(companyId, {
        ...source,
        contentHash,
      });
      if (!winner) throw error;
      await discardUnboundAttachment({
        attachmentId: attachment.id,
        companyId,
        companySlug: company.slug,
      });
      attachment = null;
      return await finishDocumentCandidate(companyId, id, claimToken, {
        status: "duplicate",
        contentHash,
        revenueDocumentId: winner.id,
        reviewNote: input.note ?? "Duplicate attachment captured concurrently",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId ?? null,
      });
    }
  } catch (error) {
    if (attachment && company) {
      await discardUnboundAttachment({
        attachmentId: attachment.id,
        companyId,
        companySlug: company.slug,
      }).catch(() => undefined);
    }
    await releaseDocumentCandidateClaim(companyId, id, claimToken).catch(() => undefined);
    throw error;
  }
}
