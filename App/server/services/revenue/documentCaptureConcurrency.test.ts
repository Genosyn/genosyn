import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import {
  createRevenueDocumentCandidatesForMessage,
  reviewRevenueDocumentCandidate,
} from "./documentCapture.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

function pendingCandidate(
  companyId: string,
  values: Partial<RevenueDocumentCandidate> = {},
): Promise<RevenueDocumentCandidate> {
  return insert(RevenueDocumentCandidate, {
    companyId,
    mailMessageId: "mail-message-1",
    attachmentIndex: 0,
    gmailMessageId: "gmail-message-1",
    gmailThreadId: "gmail-thread-1",
    gmailAttachmentId: "gmail-attachment-1",
    filename: "Proposal.pdf",
    mimeType: "application/pdf",
    sizeBytes: 128,
    contentHash: "",
    proposedKind: "proposal",
    proposedResourceType: "deal",
    proposedResourceId: "deal-1",
    confidence: 95,
    alternativesJson: "[]",
    status: "pending",
    processingAt: null,
    processingToken: null,
    revenueDocumentId: null,
    reviewNote: "",
    reviewedAt: null,
    reviewedByUserId: null,
    ...values,
  });
}

describe("Revenue Gmail document capture concurrency", () => {
  test("concurrent queue attempts create one immutable Gmail candidate", async () => {
    const companyId = testCompanyId();
    const message = await insert(MailMessage, {
      companyId,
      accountId: "mail-account-1",
      threadId: "mail-thread-1",
      gmailMessageId: "gmail-message-1",
      gmailThreadId: "gmail-thread-1",
      fromEmail: "seller@example.com",
      toEmails: "buyer@example.com",
      subject: "Proposal attached",
      attachmentsJson: JSON.stringify([
        {
          attachmentId: "gmail-attachment-1",
          filename: "Proposal.pdf",
          mimeType: "application/pdf",
          size: 128,
        },
      ]),
    });

    const results = await Promise.all([
      createRevenueDocumentCandidatesForMessage(companyId, message),
      createRevenueDocumentCandidatesForMessage(companyId, message),
    ]);

    assert.equal(
      results.reduce((sum, result) => sum + result.created, 0),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueDocumentCandidate).countBy({
        companyId,
        gmailMessageId: message.gmailMessageId,
        gmailAttachmentId: "gmail-attachment-1",
      }),
      1,
    );
  });

  test("only one concurrent reviewer can finalize a candidate", async () => {
    const companyId = testCompanyId();
    const candidate = await pendingCandidate(companyId);

    const results = await Promise.allSettled([
      reviewRevenueDocumentCandidate(
        companyId,
        candidate.id,
        { decision: "reject", note: "Not relevant" },
        { userId: "member-1" },
      ),
      reviewRevenueDocumentCandidate(
        companyId,
        candidate.id,
        { decision: "reject", note: "Not relevant" },
        { userId: "member-1" },
      ),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const row = await AppDataSource.getRepository(RevenueDocumentCandidate).findOneByOrFail({
      id: candidate.id,
    });
    assert.equal(row.status, "rejected");
    assert.equal(row.processingAt, null);
    assert.equal(row.processingToken, null);
  });

  test("a stale processing lease can be recovered", async () => {
    const companyId = testCompanyId();
    const candidate = await pendingCandidate(companyId, {
      status: "processing",
      processingAt: new Date(Date.now() - 60 * 60 * 1000),
      processingToken: "abandoned-review",
    });

    const reviewed = await reviewRevenueDocumentCandidate(
      companyId,
      candidate.id,
      { decision: "reject" },
      { userId: "member-1" },
    );

    assert.equal(reviewed.status, "rejected");
    const persisted = await AppDataSource.getRepository(RevenueDocumentCandidate).findOneByOrFail({
      id: candidate.id,
    });
    assert.equal(persisted.processingAt, null);
    assert.equal(persisted.processingToken, null);
  });

  test("an accepted source conflict is linked to the winning document", async () => {
    const companyId = testCompanyId();
    const contact = await insert(Contact, {
      companyId,
      name: "Alex Buyer",
      email: "alex@example.com",
      lifecycleStage: "qualified",
      archivedAt: null,
    });
    const message = await insert(MailMessage, {
      companyId,
      accountId: "mail-account-1",
      threadId: "mail-thread-1",
      gmailMessageId: "gmail-message-1",
      gmailThreadId: "gmail-thread-1",
      fromEmail: "alex@example.com",
      subject: "Proposal attached",
      attachmentsJson: JSON.stringify([
        {
          attachmentId: "gmail-attachment-1",
          filename: "Proposal.pdf",
          mimeType: "application/pdf",
          size: 128,
        },
      ]),
    });
    const winner = await insert(RevenueDocument, {
      companyId,
      kind: "proposal",
      title: "Proposal.pdf",
      contactId: contact.id,
      sourceMailMessageId: message.id,
      sourceGmailMessageId: message.gmailMessageId,
      sourceGmailThreadId: message.gmailThreadId,
      sourceGmailAttachmentId: "gmail-attachment-1",
      sourceAttachmentIndex: 0,
      sourceAttachmentHash: "hash-1",
    });
    const candidate = await pendingCandidate(companyId, {
      mailMessageId: message.id,
      proposedResourceType: "contact",
      proposedResourceId: contact.id,
    });

    const reviewed = await reviewRevenueDocumentCandidate(
      companyId,
      candidate.id,
      { decision: "accept" },
      { userId: "member-1" },
    );

    assert.equal(reviewed.status, "duplicate");
    assert.equal(reviewed.revenueDocumentId, winner.id);
    assert.equal(reviewed.processingAt, null);
    assert.equal(await AppDataSource.getRepository(RevenueDocument).countBy({ companyId }), 1);
  });

  test("partial unique indexes arbitrate immutable source and hash races", async () => {
    const companyId = testCompanyId();
    const repo = AppDataSource.getRepository(RevenueDocument);
    const base = {
      companyId,
      kind: "proposal" as const,
      title: "Proposal",
      notes: "",
      dealId: "deal-1",
      customerId: null,
      partnershipId: null,
      contactId: null,
      attachmentId: null,
      sourceMailMessageId: null,
      sourceGmailThreadId: "gmail-thread-1",
      sourceAttachmentIndex: 0,
      externalUrl: "",
      createdByUserId: null,
      createdByEmployeeId: null,
    };
    await repo.save(
      repo.create({
        ...base,
        sourceGmailMessageId: "gmail-message-1",
        sourceGmailAttachmentId: "gmail-attachment-1",
        sourceAttachmentHash: "hash-1",
        captureDedupeHash: "hash-1",
      }),
    );

    await assert.rejects(
      repo.save(
        repo.create({
          ...base,
          sourceGmailMessageId: "gmail-message-1",
          sourceGmailAttachmentId: "gmail-attachment-1",
          sourceAttachmentHash: "hash-2",
          captureDedupeHash: "hash-2",
        }),
      ),
    );
    await assert.rejects(
      repo.save(
        repo.create({
          ...base,
          sourceGmailMessageId: "gmail-message-2",
          sourceGmailAttachmentId: "gmail-attachment-2",
          sourceAttachmentHash: "hash-1",
          captureDedupeHash: "hash-1",
        }),
      ),
    );

    await repo.save([
      repo.create({
        ...base,
        title: "Manual one",
        sourceGmailMessageId: "",
        sourceGmailAttachmentId: "",
        sourceAttachmentHash: "",
        captureDedupeHash: null,
      }),
      repo.create({
        ...base,
        title: "Manual two",
        sourceGmailMessageId: "",
        sourceGmailAttachmentId: "",
        sourceAttachmentHash: "",
        captureDedupeHash: null,
      }),
    ]);
    assert.equal(await repo.countBy({ companyId }), 3);
  });
});
