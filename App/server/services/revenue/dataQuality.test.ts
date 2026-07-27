import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { In } from "typeorm";

import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { InvoicePayment } from "../../db/entities/InvoicePayment.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { RevenueRecordAlias } from "../../db/entities/RevenueRecordAlias.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { AppDataSource } from "../../db/datasource.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { runRevenueBulkOperation } from "./bulk.js";
import { historicalFunnelMetrics, importHistoricalDealEvents } from "./dealHistory.js";
import {
  createCommercialValueProposal,
  listRevenueEvidence,
  proposeCanonicalDomains,
  proposeCommercialValuesFromFinance,
  reviewRevenueEvidence,
} from "./enrichment.js";
import { exportRevenueSnapshotPage, revenueExportCsv } from "./exports.js";
import { mergeRevenueRecords, previewRevenueMerge } from "./merge.js";
import { findMergedRecordRedirect, rollbackRevenueOperation } from "./operations.js";
import { listRevenueDuplicateCandidates, scanRevenueDuplicates } from "./duplicates.js";
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
    assert.ok(
      aliases.some((alias) => alias.aliasType === "merged_record_id" && alias.value === source.id),
    );
    assert.ok(
      aliases.some((alias) => alias.aliasType === "source_id" && alias.value === "legacy-deal-17"),
    );
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
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id })).lifecycleStage,
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
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id })).lifecycleStage,
      "qualified",
    );
    const replay = await runRevenueBulkOperation(companyId, committedRequest);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, committed.operationId);

    await rollbackRevenueOperation(companyId, committed.operationId!);
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id })).lifecycleStage,
      "lead",
    );
  });
});

describe("historical Deal import", () => {
  test("previews, keeps original timestamps, replays idempotently, and rolls back", async () => {
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
        historyCompleteness: "complete" as const,
        originalCreatedAt,
        initialStageId: newStage.id,
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
    const preview = await importHistoricalDealEvents(
      companyId,
      "cutover-1",
      input,
      { userId: "member-1" },
      { sourceSystem: "legacy-crm", dryRun: true },
    );
    assert.equal(preview.imported, 0);
    assert.equal(preview.accepted, 3);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      0,
    );

    const first = await importHistoricalDealEvents(
      companyId,
      "cutover-1",
      input,
      { userId: "member-1" },
      { sourceSystem: "legacy-crm" },
    );
    assert.equal(first.imported, 3);
    assert.ok(first.operationId);
    const restored = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: deal.id });
    assert.equal(restored.createdAt.toISOString(), originalCreatedAt.toISOString());
    assert.equal(restored.closedAt?.toISOString(), originalWonAt.toISOString());

    const replay = await importHistoricalDealEvents(
      companyId,
      "cutover-1",
      input,
      {},
      { sourceSystem: "legacy-crm" },
    );
    assert.equal(replay.imported, 0);
    assert.equal(replay.skipped, 3);
    assert.equal(replay.duplicates, 3);
    assert.equal(replay.operationId, first.operationId);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      3,
    );

    await rollbackRevenueOperation(companyId, first.operationId!);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      0,
    );
    const rolledBack = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: deal.id });
    assert.equal(rolledBack.createdAt.toISOString(), "2026-06-01T00:00:00.000Z");
    assert.equal(rolledBack.closedAt?.toISOString(), "2026-07-01T00:00:00.000Z");
  });

  test("reorders source events, rejects overlap with native history, and labels snapshots", async () => {
    const companyId = testCompanyId();
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const qualifiedStage = await insert(DealStage, {
      companyId,
      name: "Qualified",
      slug: "qualified",
      sortOrder: 1,
      probability: 40,
      kind: "open",
    });
    const deal = await insert(Deal, {
      companyId,
      title: "Native continuation",
      stageId: qualifiedStage.id,
      amountCents: 10_000,
      status: "open",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
    });
    await insert(DealHistoryEvent, {
      companyId,
      dealId: deal.id,
      kind: "stage_changed",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      fromStageId: newStage.id,
      toStageId: qualifiedStage.id,
      sourceKind: "live",
      sourceKey: "live:native-stage",
    });

    const preview = await importHistoricalDealEvents(
      companyId,
      "cutover-overlap",
      [
        {
          sourceId: "legacy-native-1",
          dealId: deal.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "overlap",
              kind: "amount_changed",
              occurredAt: new Date("2025-02-01T00:00:00.000Z"),
              fromAmountCents: 5_000,
              toAmountCents: 10_000,
              currency: "USD",
            },
            {
              sourceId: "old-stage",
              kind: "stage_changed",
              occurredAt: new Date("2024-02-01T00:00:00.000Z"),
              fromStageId: newStage.id,
              toStageId: qualifiedStage.id,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm", dryRun: true },
    );
    assert.equal(preview.accepted, 1);
    assert.equal(preview.conflicting, 1);
    assert.equal(preview.reordered, 2);

    const snapshotDeal = await insert(Deal, {
      companyId,
      title: "Snapshot only",
      stageId: newStage.id,
      amountCents: 0,
      status: "open",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const snapshot = await importHistoricalDealEvents(
      companyId,
      "cutover-snapshot",
      [
        {
          sourceId: "legacy-snapshot-1",
          dealId: snapshotDeal.id,
          historyCompleteness: "snapshot_only",
          snapshotAt: new Date("2026-01-01T00:00:00.000Z"),
          events: [],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );
    assert.equal(snapshot.imported, 1);
    const metrics = await historicalFunnelMetrics(
      companyId,
      new Date("2023-01-01T00:00:00.000Z"),
      new Date("2027-01-01T00:00:00.000Z"),
      [newStage, qualifiedStage],
    );
    assert.equal(metrics.historyCoverage.snapshotOnlyDeals, 1);
    assert.equal(metrics.historyCoverage.partialDeals, 1);
    assert.equal(
      metrics.stagePerformance.every((row) => row.enteredDuringPeriod === 0),
      false,
    );
  });
});

describe("controlled enrichment", () => {
  test("attributes AI evidence reviews without recording human confirmation", async () => {
    const companyId = testCompanyId();
    const acceptedAccount = await account(companyId, "AI Accepted");
    const rejectedAccount = await account(companyId, "AI Rejected");
    const acceptedEvidence = await insert(RevenueFieldEvidence, {
      companyId,
      resourceType: "account",
      resourceId: acceptedAccount.id,
      fieldKey: "domain",
      sourceType: "manual",
      sourceId: "ai-domain-accept",
      sourceLabel: "accepted.example.com",
      extractedValueJson: JSON.stringify("accepted.example.com"),
      normalizedValue: "accepted.example.com",
      confidence: 100,
      status: "proposed",
      verificationState: "unverified",
      extractionMethod: "manual",
      observedAt: new Date("2026-07-01T00:00:00.000Z"),
      extractedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const rejectedEvidence = await insert(RevenueFieldEvidence, {
      companyId,
      resourceType: "account",
      resourceId: rejectedAccount.id,
      fieldKey: "domain",
      sourceType: "manual",
      sourceId: "ai-domain-reject",
      sourceLabel: "rejected.example.com",
      extractedValueJson: JSON.stringify("rejected.example.com"),
      normalizedValue: "rejected.example.com",
      confidence: 100,
      status: "proposed",
      verificationState: "unverified",
      extractionMethod: "manual",
      observedAt: new Date("2026-07-01T00:00:00.000Z"),
      extractedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const actor = { employeeId: "employee-revenue-reviewer" };

    const accepted = await reviewRevenueEvidence(companyId, acceptedEvidence.id, "accept", actor);
    const rejected = await reviewRevenueEvidence(companyId, rejectedEvidence.id, "reject", actor);

    for (const evidence of [accepted, rejected]) {
      assert.equal(evidence.humanConfirmedAt, null);
      assert.equal(evidence.humanConfirmedById, null);
      assert.equal(evidence.verifyingActorType, "ai_employee");
      assert.equal(evidence.verifyingActorId, actor.employeeId);
    }
  });

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
    const foreignDocument = await insert(RevenueDocument, {
      companyId: testCompanyId(),
      kind: "proposal",
      title: "Another company's signed quote",
      dealId: null,
      customerId: null,
      partnershipId: null,
      contactId: null,
      attachmentId: null,
      sourceMailMessageId: null,
      externalUrl: "https://example.test/foreign-quote",
    });
    await assert.rejects(
      () =>
        createCommercialValueProposal(companyId, {
          dealId: deal.id,
          sourceType: "document",
          sourceId: foreignDocument.id,
          sourceVerified: true,
          confidence: 100,
          value: {
            amountCents: 120_000,
            currency: "USD",
            revenueType: "recurring",
          },
        }),
      /not found in this company/,
    );
    const sourceDocument = await insert(RevenueDocument, {
      companyId,
      kind: "proposal",
      title: "Signed quote",
      dealId: deal.id,
      customerId: null,
      partnershipId: null,
      contactId: null,
      attachmentId: null,
      sourceMailMessageId: null,
      externalUrl: "https://example.test/signed-quote",
    });
    const valueEvidence = await createCommercialValueProposal(companyId, {
      dealId: deal.id,
      sourceType: "document",
      sourceId: sourceDocument.id,
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

    const sameValueEvidence = await createCommercialValueProposal(companyId, {
      dealId: deal.id,
      sourceType: "manual",
      sourceId: "member-confirmation-1",
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
    await reviewRevenueEvidence(companyId, sameValueEvidence.id, "accept", {
      userId: "member-1",
    });
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({
        where: { companyId, dealId: deal.id, kind: "amount_changed" },
      }),
      1,
    );

    const replacementEvidence = await createCommercialValueProposal(companyId, {
      dealId: deal.id,
      sourceType: "manual",
      sourceId: "member-confirmation-2",
      sourceVerified: true,
      confidence: 100,
      value: {
        amountCents: 180_000,
        currency: "USD",
        revenueType: "recurring",
        billingInterval: "year",
        mrrCents: 15_000,
        arrCents: 180_000,
        acvCents: 180_000,
      },
    });
    await assert.rejects(
      () =>
        reviewRevenueEvidence(companyId, replacementEvidence.id, "accept", {
          userId: "member-1",
        }),
      /supersedeExisting/,
    );
    await reviewRevenueEvidence(
      companyId,
      replacementEvidence.id,
      "accept",
      { userId: "member-1" },
      { supersedeExisting: true },
    );
    assert.equal(
      (await AppDataSource.getRepository(Deal).findOneByOrFail({ id: deal.id })).amountCents,
      180_000,
    );
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({
        where: { companyId, dealId: deal.id, kind: "amount_changed" },
      }),
      2,
    );
    const superseded = await AppDataSource.getRepository(RevenueFieldEvidence).findBy({
      id: In([valueEvidence.id, sameValueEvidence.id]),
    });
    assert.equal(
      superseded.every((row) => row.status === "superseded"),
      true,
    );
  });

  test("derives linked Contact domains without trusting caller verification claims", async () => {
    const companyId = testCompanyId();
    const unverifiedAccount = await account(companyId, "Northwind");
    const unverifiedContact = await insert(Contact, {
      companyId,
      name: "Una Verified",
      email: "una@team.northwind.co.uk",
      customerId: unverifiedAccount.id,
      lifecycleStage: "qualified",
      archivedAt: null,
    });
    const verifiedAccount = await account(companyId, "Contoso");
    const verifiedContact = await insert(Contact, {
      companyId,
      name: "Vera Verified",
      email: "vera@mail.contoso.com.au",
      customerId: verifiedAccount.id,
      lifecycleStage: "qualified",
      archivedAt: null,
    });
    await insert(RevenueFieldEvidence, {
      companyId,
      resourceType: "contact",
      resourceId: verifiedContact.id,
      fieldKey: "email",
      sourceType: "manual",
      sourceId: "member-email-review",
      sourceLabel: verifiedContact.email,
      extractedValueJson: JSON.stringify(verifiedContact.email),
      normalizedValue: verifiedContact.email,
      confidence: 100,
      status: "accepted",
      verificationState: "verified",
      extractionMethod: "member_review",
      observedAt: new Date("2025-01-01T00:00:00.000Z"),
      extractedAt: new Date("2025-01-01T00:00:00.000Z"),
      lastVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
      humanConfirmedAt: new Date("2025-01-01T00:00:00.000Z"),
      humanConfirmedById: "member-1",
      verifyingActorType: "member",
      verifyingActorId: "member-1",
      metadataJson: "{}",
    });

    const result = await proposeCanonicalDomains(companyId, {
      accountIds: [unverifiedAccount.id, verifiedAccount.id],
      verifiedContactIds: [unverifiedContact.id],
    });
    assert.equal(result.proposed, 2);
    const rows = (
      await listRevenueEvidence(companyId, {
        resourceType: "account",
        fieldKey: "domain",
        status: "proposed",
      })
    ).rows;
    const unverified = rows.find((row) => row.resourceId === unverifiedAccount.id);
    const verified = rows.find((row) => row.resourceId === verifiedAccount.id);
    assert.ok(unverified);
    assert.ok(verified);
    assert.equal(unverified.normalizedValue, "northwind.co.uk");
    assert.equal(verified.normalizedValue, "contoso.com.au");
    assert.ok(verified.confidence > unverified.confidence);
    assert.deepEqual(JSON.parse(unverified.metadataJson), {
      verifiedContactEmail: false,
      requestedAsVerified: true,
      aliasDomain: "team.northwind.co.uk",
      currentDomain: null,
      collisionAccountId: null,
    });
  });

  test("prefers accepted quote terms, then payment-backed invoices, without duplicate proposals", async () => {
    const companyId = testCompanyId();
    const stage = await insert(DealStage, {
      companyId,
      name: "Qualified",
      slug: "qualified",
      sortOrder: 0,
      probability: 40,
      kind: "open",
    });
    const quotedAccount = await account(companyId, "Quoted Co");
    const paidAccount = await account(companyId, "Paid Co");
    const quotedDeal = await insert(Deal, {
      companyId,
      title: "Quoted expansion",
      customerId: quotedAccount.id,
      stageId: stage.id,
      amountCents: 0,
      status: "open",
      archivedAt: null,
    });
    const paidDeal = await insert(Deal, {
      companyId,
      title: "Paid implementation",
      customerId: paidAccount.id,
      stageId: stage.id,
      amountCents: 0,
      status: "open",
      archivedAt: null,
    });
    const acceptedEstimate = await insert(Estimate, {
      companyId,
      customerId: quotedAccount.id,
      slug: "est-quoted",
      numberSeq: 1,
      number: "EST-0001",
      status: "accepted",
      issueDate: new Date("2025-01-01T00:00:00.000Z"),
      validUntil: new Date("2025-02-01T00:00:00.000Z"),
      currency: "USD",
      subtotalCents: 150_000,
      taxCents: 0,
      totalCents: 150_000,
      acceptedAt: new Date("2025-01-10T00:00:00.000Z"),
    });
    await insert(Invoice, {
      companyId,
      customerId: quotedAccount.id,
      slug: "inv-quoted",
      numberSeq: 1,
      number: "INV-0001",
      status: "paid",
      issueDate: new Date("2025-01-15T00:00:00.000Z"),
      dueDate: new Date("2025-02-15T00:00:00.000Z"),
      currency: "USD",
      subtotalCents: 90_000,
      taxCents: 0,
      totalCents: 90_000,
      paidCents: 90_000,
      balanceCents: 0,
    });
    const paidInvoice = await insert(Invoice, {
      companyId,
      customerId: paidAccount.id,
      slug: "inv-paid",
      numberSeq: 2,
      number: "INV-0002",
      status: "sent",
      issueDate: new Date("2025-02-01T00:00:00.000Z"),
      dueDate: new Date("2025-03-01T00:00:00.000Z"),
      currency: "GBP",
      subtotalCents: 80_000,
      taxCents: 0,
      totalCents: 80_000,
      paidCents: 20_000,
      balanceCents: 60_000,
    });
    const payment = await insert(InvoicePayment, {
      invoiceId: paidInvoice.id,
      amountCents: 20_000,
      currency: "GBP",
      paidAt: new Date("2025-02-10T00:00:00.000Z"),
      method: "bank_transfer",
    });

    assert.deepEqual(await proposeCommercialValuesFromFinance(companyId), {
      proposed: 2,
      ambiguousAccounts: 0,
    });
    assert.deepEqual(await proposeCommercialValuesFromFinance(companyId), {
      proposed: 0,
      ambiguousAccounts: 0,
    });
    const evidence = (
      await listRevenueEvidence(companyId, {
        resourceType: "deal",
        fieldKey: "commercial_value",
        sourceType: "finance",
      })
    ).rows;
    const quoteEvidence = evidence.find((row) => row.resourceId === quotedDeal.id);
    const paymentEvidence = evidence.find((row) => row.resourceId === paidDeal.id);
    assert.equal(quoteEvidence?.sourceId, acceptedEstimate.id);
    assert.equal(paymentEvidence?.sourceId, payment.id);
    assert.equal(
      (JSON.parse(paymentEvidence!.extractedValueJson) as { amountCents: number }).amountCents,
      paidInvoice.totalCents,
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
    const stage = await insert(DealStage, {
      companyId,
      name: "Proposal",
      slug: "proposal",
      sortOrder: 0,
      probability: 60,
      kind: "open",
    });
    const openDeal = await insert(Deal, {
      companyId,
      title: "Acme renewal",
      customerId: left.id,
      primaryContactId: person.id,
      stageId: stage.id,
      amountCents: 0,
      status: "open",
      archivedAt: null,
    });
    const closedDeal = await insert(Deal, {
      companyId,
      title: "Acme proposal",
      customerId: left.id,
      primaryContactId: person.id,
      stageId: stage.id,
      amountCents: 50_000,
      status: "won",
      archivedAt: null,
    });
    const message = await insert(MailMessage, {
      companyId,
      accountId: "mail-account-1",
      threadId: "mail-thread-1",
      gmailMessageId: "gmail-message-1",
      gmailThreadId: "gmail-thread-1",
      fromEmail: "sales@example.test",
      toEmails: `"Buyer, Alex" <${person.email}>`,
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
    assert.deepEqual(await createRevenueDocumentCandidatesForMessage(companyId, message), {
      created: 1,
      skipped: 0,
    });
    assert.deepEqual(await createRevenueDocumentCandidatesForMessage(companyId, message), {
      created: 0,
      skipped: 0,
    });
    const documentCandidate = await AppDataSource.getRepository(
      RevenueDocumentCandidate,
    ).findOneByOrFail({ companyId, mailMessageId: message.id });
    assert.equal(documentCandidate.proposedKind, "proposal");
    assert.equal(documentCandidate.proposedResourceType, "contact");
    assert.equal(documentCandidate.proposedResourceId, person.id);
    const alternatives = JSON.parse(documentCandidate.alternativesJson) as Array<{
      resourceType: string;
      resourceId: string;
      confidence: number;
    }>;
    const openSuggestion = alternatives.find(
      (row) => row.resourceType === "deal" && row.resourceId === openDeal.id,
    );
    const closedSuggestion = alternatives.find(
      (row) => row.resourceType === "deal" && row.resourceId === closedDeal.id,
    );
    assert.ok(openSuggestion);
    assert.ok(closedSuggestion);
    assert.ok(openSuggestion.confidence > closedSuggestion.confidence);
    assert.ok(alternatives.indexOf(openSuggestion) < alternatives.indexOf(closedSuggestion));
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

  test("neutralizes spreadsheet formulas without changing numeric values", () => {
    const csv = revenueExportCsv({
      resource: "accounts",
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
      offset: 0,
      limit: 1,
      total: 1,
      nextOffset: null,
      rows: [
        {
          equals: "=2+2",
          plus: "+SUM(1,1)",
          minus: "-1+2",
          hidden: " \t@SUM(1,1)",
          numeric: -42,
          safe: "Acme",
        },
      ],
    });

    assert.match(csv, /"'=2\+2"/);
    assert.match(csv, /"'\+SUM\(1,1\)"/);
    assert.match(csv, /"'-1\+2"/);
    assert.match(csv, /"' \t@SUM\(1,1\)"/);
    assert.match(csv, /"-42"/);
    assert.doesNotMatch(csv, /"'-42"/);
  });
});
