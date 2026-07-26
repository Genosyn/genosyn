import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { RevenueRecordAlias } from "../../db/entities/RevenueRecordAlias.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { AppDataSource } from "../../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../../test/dbHarness.js";
import { runRevenueBulkOperation } from "./bulk.js";
import { importHistoricalDealEvents } from "./dealHistory.js";
import {
  createCommercialValueProposal,
  listRevenueEvidence,
  proposeCanonicalDomains,
  reviewRevenueEvidence,
} from "./enrichment.js";
import { exportRevenueSnapshotPage } from "./exports.js";
import { mergeRevenueRecords, previewRevenueMerge } from "./merge.js";
import { findMergedRecordRedirect, rollbackRevenueOperation } from "./operations.js";
import {
  listRevenueDuplicateCandidates,
  scanRevenueDuplicates,
} from "./duplicates.js";
import { createRevenueDocumentCandidatesForMessage } from "./documentCapture.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function account(companyId: string, name: string): Promise<Customer> {
  return insert(Customer, {
    companyId,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    accountStatus: "prospect",
    archivedAt: null,
  });
}

async function contact(companyId: string, name: string): Promise<Contact> {
  return insert(Contact, {
    companyId,
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    lifecycleStage: "lead",
    archivedAt: null,
  });
}

describe("generic Revenue merge and guarded undo", () => {
  test("moves Deal history and evidence while preserving import IDs as aliases", async () => {
    const companyId = testCompanyId();
    const stage = await insert(DealStage, {
      companyId,
      name: "Qualified",
      slug: "qualified",
      sortOrder: 0,
      probability: 25,
      kind: "open",
    });
    const source = await insert(Deal, {
      companyId,
      title: "Acme duplicate",
      stageId: stage.id,
      amountCents: 0,
      status: "open",
      archivedAt: null,
    });
    const target = await insert(Deal, {
      companyId,
      title: "Acme renewal",
      stageId: stage.id,
      amountCents: 50_000,
      status: "open",
      archivedAt: null,
    });
    const history = await insert(DealHistoryEvent, {
      companyId,
      dealId: source.id,
      kind: "created",
      occurredAt: new Date("2024-01-01T00:00:00.000Z"),
      toStageId: stage.id,
      sourceKind: "import",
      sourceKey: "legacy:acme:created",
    });
    const evidence = await insert(RevenueFieldEvidence, {
      companyId,
      resourceType: "deal",
      resourceId: source.id,
      fieldKey: "commercial_value",
      sourceType: "document",
      sourceId: "quote-1",
      extractedValueJson: JSON.stringify({ amountCents: 50_000 }),
      confidence: 90,
      status: "proposed",
      extractedAt: new Date("2024-01-02T00:00:00.000Z"),
    });
    const importRow = await insert(RevenueImportRow, {
      companyId,
      batchId: "legacy-batch",
      resourceType: "deal",
      sourceId: "legacy-deal-17",
      nativeId: source.id,
      action: "create",
      status: "created",
      decisionJson: "{}",
    });
    const sourceField = await insert(RevenueCustomField, {
      companyId,
      resourceType: "deal",
      key: "original_source_id",
      name: "Original source ID",
      fieldType: "text",
    });
    await insert(RevenueCustomValue, {
      companyId,
      fieldId: sourceField.id,
      resourceType: "deal",
      resourceId: source.id,
      valueJson: JSON.stringify("legacy-deal-17"),
      searchValue: "legacy-deal-17",
    });
    await insert(Activity, {
      companyId,
      kind: "note",
      subject: "Source note",
      occurredAt: new Date("2024-02-01T00:00:00.000Z"),
      dealId: source.id,
    });

    const preview = await previewRevenueMerge(companyId, "deal", source.id, target.id);
    assert.equal(preview.relationshipCounts.historyEvents, 1);
    assert.equal(preview.relationshipCounts.evidence, 1);
    assert.ok(preview.fieldConflicts.some((row) => row.field === "title"));

    const merged = await mergeRevenueRecords(
      companyId,
      "deal",
      source.id,
      target.id,
      source.title,
      { userId: "member-1" },
    );
    assert.ok(merged.operationId);
    assert.equal(
      (await AppDataSource.getRepository(DealHistoryEvent).findOneByOrFail({ id: history.id }))
        .dealId,
      target.id,
    );
    assert.equal(
      (await AppDataSource.getRepository(RevenueFieldEvidence).findOneByOrFail({ id: evidence.id }))
        .resourceId,
      target.id,
    );
    assert.equal(
      (await AppDataSource.getRepository(RevenueImportRow).findOneByOrFail({ id: importRow.id }))
        .nativeId,
      source.id,
    );
    const aliases = await AppDataSource.getRepository(RevenueRecordAlias).find({
      where: { companyId, resourceType: "deal", recordId: target.id },
    });
    assert.ok(aliases.some((alias) => alias.aliasType === "merged_record_id" && alias.value === source.id));
    assert.ok(aliases.some((alias) => alias.aliasType === "source_id" && alias.value === "legacy-deal-17"));
    assert.deepEqual(await findMergedRecordRedirect(companyId, "deal", source.id), {
      operationId: merged.operationId,
      targetId: target.id,
    });

    const undone = await rollbackRevenueOperation(companyId, merged.operationId!);
    assert.ok(undone.rolledBack >= 6);
    assert.equal(
      (await AppDataSource.getRepository(Deal).findOneByOrFail({ id: source.id })).archivedAt,
      null,
    );
    assert.equal(
      (await AppDataSource.getRepository(DealHistoryEvent).findOneByOrFail({ id: history.id }))
        .dealId,
      source.id,
    );
    assert.equal(await findMergedRecordRedirect(companyId, "deal", source.id), null);
  });
});

describe("bulk Revenue operations", () => {
  test("previews, reports partial failures, replays idempotently and rolls back", async () => {
    const companyId = testCompanyId();
    const first = await contact(companyId, "Ada Lovelace");
    const second = await contact(companyId, "Grace Hopper");
    const request = {
      resourceType: "contact" as const,
      target: { ids: [first.id, second.id, "missing-contact"] },
      action: { type: "set_contact_lifecycle" as const, lifecycleStage: "qualified" as const },
      dryRun: true,
    };
    const preview = await runRevenueBulkOperation(companyId, request);
    assert.equal(preview.valid, 2);
    assert.equal(preview.failed, 1);
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id }))
        .lifecycleStage,
      "lead",
    );

    const committedRequest = {
      ...request,
      dryRun: false,
      idempotencyKey: "normalize-contacts-2026-07",
    };
    const committed = await runRevenueBulkOperation(companyId, committedRequest, {
      userId: "member-1",
    });
    assert.equal(committed.applied, 2);
    assert.equal(committed.failed, 1);
    assert.ok(committed.operationId);
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id }))
        .lifecycleStage,
      "qualified",
    );
    const replay = await runRevenueBulkOperation(companyId, committedRequest);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, committed.operationId);

    await rollbackRevenueOperation(companyId, committed.operationId!);
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id }))
        .lifecycleStage,
      "lead",
    );
  });
});

describe("historical Deal import", () => {
  test("keeps original timestamps and is idempotent", async () => {
    const companyId = testCompanyId();
    await account(companyId, "History Account");
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const wonStage = await insert(DealStage, {
      companyId,
      name: "Closed Won",
      slug: "closed-won",
      sortOrder: 1,
      probability: 100,
      kind: "won",
    });
    const deal = await insert(Deal, {
      companyId,
      title: "Historical win",
      stageId: wonStage.id,
      amountCents: 100_000,
      status: "won",
      closedAt: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const originalCreatedAt = new Date("2024-01-01T00:00:00.000Z");
    const originalWonAt = new Date("2024-02-15T00:00:00.000Z");
    const input = [
      {
        sourceId: "legacy-win-1",
        dealId: deal.id,
        originalCreatedAt,
        events: [
          {
            sourceId: "amount-1",
            kind: "amount_changed" as const,
            occurredAt: new Date("2024-01-10T00:00:00.000Z"),
            fromAmountCents: 50_000,
            toAmountCents: 100_000,
            currency: "USD",
          },
          {
            sourceId: "won-1",
            kind: "won" as const,
            occurredAt: originalWonAt,
            fromStageId: newStage.id,
            toStageId: wonStage.id,
          },
        ],
      },
    ];
    const first = await importHistoricalDealEvents(companyId, "cutover-1", input);
    assert.equal(first.imported, 3);
    const restored = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: deal.id });
    assert.equal(restored.createdAt.toISOString(), originalCreatedAt.toISOString());
    assert.equal(restored.closedAt?.toISOString(), originalWonAt.toISOString());

    const replay = await importHistoricalDealEvents(companyId, "cutover-1", input);
    assert.equal(replay.imported, 0);
    assert.equal(replay.skipped, 3);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      3,
    );
  });
});

describe("controlled enrichment", () => {
  test("proposes a verified business domain and applies reviewed value evidence", async () => {
    const companyId = testCompanyId();
    const acme = await account(companyId, "Acme");
    const person = await insert(Contact, {
      companyId,
      name: "Alex Buyer",
      email: "alex@acme.com",
      customerId: acme.id,
      lifecycleStage: "qualified",
      archivedAt: null,
    });
    const domainResult = await proposeCanonicalDomains(companyId, {
      accountIds: [acme.id],
      verifiedContactIds: [person.id],
    });
    assert.equal(domainResult.proposed, 1);
    const proposed = await listRevenueEvidence(companyId, {
      resourceType: "account",
      resourceId: acme.id,
      status: "proposed",
    });
    assert.equal(proposed.rows[0].normalizedValue, "acme.com");
    await reviewRevenueEvidence(companyId, proposed.rows[0].id, "accept", {
      userId: "member-1",
    });
    assert.equal(
      (await AppDataSource.getRepository(Customer).findOneByOrFail({ id: acme.id })).domain,
      "acme.com",
    );

    const stage = await insert(DealStage, {
      companyId,
      name: "Proposal",
      slug: "proposal",
      sortOrder: 0,
      probability: 60,
      kind: "open",
    });
    const deal = await insert(Deal, {
      companyId,
      title: "Acme contract",
      customerId: acme.id,
      stageId: stage.id,
      amountCents: 0,
      status: "open",
      archivedAt: null,
    });
    await assert.rejects(
      () =>
        createCommercialValueProposal(companyId, {
          dealId: deal.id,
          sourceType: "email",
          sourceId: "mail-guess",
          sourceVerified: false,
          confidence: 40,
          value: {
            amountCents: 120_000,
            currency: "USD",
            revenueType: "recurring",
          },
        }),
      /Unverified prose/,
    );
    const valueEvidence = await createCommercialValueProposal(companyId, {
      dealId: deal.id,
      sourceType: "document",
      sourceId: "signed-quote-1",
      sourceLabel: "Signed quote",
      sourceVerified: true,
      confidence: 100,
      value: {
        amountCents: 120_000,
        currency: "USD",
        revenueType: "recurring",
        billingInterval: "year",
        mrrCents: 10_000,
        arrCents: 120_000,
        acvCents: 120_000,
      },
    });
    await reviewRevenueEvidence(companyId, valueEvidence.id, "accept", {
      userId: "member-1",
    });
    assert.equal(
      (await AppDataSource.getRepository(Deal).findOneByOrFail({ id: deal.id })).amountCents,
      120_000,
    );
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({
        where: { companyId, dealId: deal.id, kind: "amount_changed" },
      }),
      1,
    );
  });
});

describe("ongoing duplicate candidates and document capture", () => {
  test("proposes candidates without auto-merging and queues mail attachments idempotently", async () => {
    const companyId = testCompanyId();
    const left = await account(companyId, "Acme Incorporated");
    const right = await account(companyId, "Acme LLC");
    const scan = await scanRevenueDuplicates(companyId);
    assert.equal(scan.created, 1);
    const candidates = await listRevenueDuplicateCandidates(companyId, {
      resourceType: "account",
      status: "open",
    });
    assert.equal(candidates.rows.length, 1);
    assert.deepEqual(
      new Set([candidates.rows[0].leftId, candidates.rows[0].rightId]),
      new Set([left.id, right.id]),
    );
    assert.equal(left.archivedAt, null);
    assert.equal(right.archivedAt, null);

    const person = await insert(Contact, {
      companyId,
      name: "Alex Buyer",
      email: "alex@acme.com",
      customerId: left.id,
      lifecycleStage: "qualified",
      archivedAt: null,
    });
    const message = await insert(MailMessage, {
      companyId,
      accountId: "mail-account-1",
      threadId: "mail-thread-1",
      gmailMessageId: "gmail-message-1",
      gmailThreadId: "gmail-thread-1",
      fromEmail: person.email,
      toEmails: "sales@example.test",
      subject: "Acme proposal",
      attachmentsJson: JSON.stringify([
        {
          attachmentId: "gmail-attachment-1",
          filename: "Acme Proposal.pdf",
          mimeType: "application/pdf",
          size: 12_345,
        },
      ]),
    });
    assert.deepEqual(
      await createRevenueDocumentCandidatesForMessage(companyId, message),
      { created: 1, skipped: 0 },
    );
    assert.deepEqual(
      await createRevenueDocumentCandidatesForMessage(companyId, message),
      { created: 0, skipped: 0 },
    );
    const documentCandidate = await AppDataSource.getRepository(
      RevenueDocumentCandidate,
    ).findOneByOrFail({ companyId, mailMessageId: message.id });
    assert.equal(documentCandidate.proposedKind, "proposal");
    assert.equal(documentCandidate.proposedResourceType, "contact");
    assert.equal(documentCandidate.proposedResourceId, person.id);
  });
});

describe("paginated native exports", () => {
  test("returns a stable next offset and includes archived records", async () => {
    const companyId = testCompanyId();
    await account(companyId, "First");
    const archived = await account(companyId, "Second");
    archived.archivedAt = new Date("2025-01-01T00:00:00.000Z");
    await AppDataSource.getRepository(Customer).save(archived);
    const firstPage = await exportRevenueSnapshotPage(companyId, "accounts", {
      limit: 1,
      offset: 0,
    });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.rows.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = await exportRevenueSnapshotPage(companyId, "accounts", {
      limit: 1,
      offset: firstPage.nextOffset!,
    });
    assert.equal(secondPage.rows.length, 1);
    assert.equal(secondPage.nextOffset, null);
    assert.equal(
      [...firstPage.rows, ...secondPage.rows].some((row) => row.archivedAt !== null),
      true,
    );
  });
});
