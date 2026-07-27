import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { EntityTarget, ObjectLiteral, QueryDeepPartialEntity } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueImportBatch } from "../../db/entities/RevenueImportBatch.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { RevenueOperationRow } from "../../db/entities/RevenueOperationRow.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { BulkAtomicValidationError, runRevenueBulkOperation } from "./bulk.js";
import { executeRevenueBulkJob, getRevenueBulkJob } from "./bulkJobs.js";
import { createCustomField, installBaseMigrationCustomFields } from "./customFields.js";
import { exportRevenueSnapshotPage } from "./exports.js";
import { listFollowUpPage, listFollowUps } from "./followUps.js";
import {
  commitLinkedRevenueImport,
  commitRevenueImport,
  getRevenueImportRows,
  getRevenueImportSummary,
  rollbackRevenueImport,
} from "./imports.js";
import { rollbackRevenueOperation } from "./operations.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function account(
  companyId: string,
  name: string,
  patch: Partial<Customer> = {},
): Promise<Customer> {
  return insert(Customer, {
    companyId,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    accountStatus: "prospect",
    archivedAt: null,
    ...patch,
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

async function insertChunks<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  rows: QueryDeepPartialEntity<T>[],
): Promise<void> {
  const repo = AppDataSource.getRepository(entity);
  for (let offset = 0; offset < rows.length; offset += 200) {
    await repo.insert(rows.slice(offset, offset + 200));
  }
}

function followUpFixtureId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

describe("bulk Revenue invariants", () => {
  test("records verified custom-field evidence transactionally and includes it in guarded undo", async () => {
    const companyId = testCompanyId();
    const target = await account(companyId, "Evidence Account");
    const field = await insert(RevenueCustomField, {
      companyId,
      resourceType: "account",
      key: "territory",
      name: "Territory",
      fieldType: "text",
      archivedAt: null,
    });
    const previousEvidence = await insert(RevenueFieldEvidence, {
      companyId,
      resourceType: "account",
      resourceId: target.id,
      fieldKey: "custom:territory",
      sourceType: "manual",
      sourceId: "manual:territory",
      extractedValueJson: JSON.stringify("South"),
      normalizedValue: "south",
      confidence: 100,
      status: "accepted",
      verificationState: "verified",
      extractedAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    const result = await runRevenueBulkOperation(
      companyId,
      {
        resourceType: "account",
        target: { ids: [target.id] },
        action: { type: "set_custom_fields", values: { territory: "North" } },
        dryRun: false,
        mode: "partial",
        idempotencyKey: "bulk-territory-evidence",
      },
      { employeeId: "employee-revenue" },
    );

    assert.equal(result.applied, 1);
    assert.ok(result.operationId);
    const value = await AppDataSource.getRepository(RevenueCustomValue).findOneByOrFail({
      companyId,
      fieldId: field.id,
      resourceId: target.id,
    });
    assert.equal(JSON.parse(value.valueJson), "North");
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueFieldEvidence).findOneByOrFail({
          id: previousEvidence.id,
        })
      ).status,
      "superseded",
    );
    const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).findOneByOrFail({
      companyId,
      resourceType: "account",
      resourceId: target.id,
      sourceId: `bulk:bulk-territory-evidence:account:${target.id}:territory`,
    });
    assert.equal(evidence.status, "accepted");
    assert.equal(evidence.verificationState, "verified");
    assert.equal(evidence.verifyingActorType, "ai_employee");
    assert.equal(evidence.verifyingActorId, "employee-revenue");
    const undoRows = await AppDataSource.getRepository(RevenueOperationRow).find({
      where: {
        companyId,
        operationId: result.operationId,
        entityType: "revenue_field_evidence",
      },
    });
    assert.equal(undoRows.length, 2);

    await rollbackRevenueOperation(companyId, result.operationId!);
    assert.equal(
      await AppDataSource.getRepository(RevenueCustomValue).countBy({
        companyId,
        fieldId: field.id,
        resourceId: target.id,
      }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueFieldEvidence).countBy({ id: evidence.id }),
      0,
    );
    const restoredEvidence = await AppDataSource.getRepository(
      RevenueFieldEvidence,
    ).findOneByOrFail({
      id: previousEvidence.id,
    });
    assert.equal(restoredEvidence.status, "accepted");
    assert.equal(restoredEvidence.verificationState, "verified");
  });

  test("rolls back all valid writes in atomic mode and retains them in partial mode", async () => {
    const companyId = testCompanyId();
    const first = await contact(companyId, "Atomic Contact");
    const atomicRequest = {
      resourceType: "contact" as const,
      target: { ids: [first.id, "missing-contact"] },
      action: {
        type: "set_contact_lifecycle" as const,
        lifecycleStage: "qualified" as const,
      },
      dryRun: false,
      mode: "atomic" as const,
      idempotencyKey: "atomic-contact-lifecycle",
    };
    await assert.rejects(
      () => runRevenueBulkOperation(companyId, atomicRequest),
      (error: unknown) => {
        assert.ok(error instanceof BulkAtomicValidationError);
        assert.equal(error.result.failed, 1);
        assert.equal(error.result.applied, 1);
        return true;
      },
    );
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id })).lifecycleStage,
      "lead",
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueOperation).countBy({
        companyId,
        idempotencyKey: atomicRequest.idempotencyKey,
      }),
      0,
    );

    const partial = await runRevenueBulkOperation(companyId, {
      ...atomicRequest,
      mode: "partial",
      idempotencyKey: "partial-contact-lifecycle",
    });
    assert.equal(partial.applied, 1);
    assert.equal(partial.failed, 1);
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: first.id })).lifecycleStage,
      "qualified",
    );
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueOperation).findOneByOrFail({
          id: partial.operationId,
        })
      ).status,
      "partial",
    );
  });

  test("refuses to undo queued and running bulk jobs", async () => {
    const companyId = testCompanyId();
    for (const status of ["queued", "running"] as const) {
      const operation = await insert(RevenueOperation, {
        companyId,
        kind: "bulk",
        resourceType: "contact",
        status,
        idempotencyKey: `bulk-${status}`,
        requestJson: "{}",
        summaryJson: "{}",
        completedAt: new Date(),
        rolledBackAt: null,
      });
      await assert.rejects(
        () => rollbackRevenueOperation(companyId, operation.id),
        /queued or running operation cannot be rolled back/,
      );
      assert.equal(
        (
          await AppDataSource.getRepository(RevenueOperation).findOneByOrFail({
            id: operation.id,
          })
        ).status,
        status,
      );
    }
  });

  test("resumes a running bulk job once with its stable execution key", async () => {
    const companyId = testCompanyId();
    const target = await contact(companyId, "Recovered Contact");
    const preview = await runRevenueBulkOperation(companyId, {
      resourceType: "contact",
      target: { ids: [target.id] },
      action: {
        type: "set_contact_lifecycle",
        lifecycleStage: "qualified",
      },
      dryRun: true,
      mode: "partial",
    });
    const clientRequest = {
      resourceType: "contact" as const,
      target: { ids: [target.id] },
      action: {
        type: "set_contact_lifecycle" as const,
        lifecycleStage: "qualified" as const,
      },
      dryRun: false,
      mode: "partial" as const,
      idempotencyKey: "bulk-job-parent-recovery",
    };
    const job = await insert(RevenueOperation, {
      companyId,
      kind: "bulk",
      resourceType: "contact",
      status: "running",
      idempotencyKey: clientRequest.idempotencyKey,
      requestJson: JSON.stringify({
        type: "bulk_job",
        clientRequest,
        executionRequest: {
          ...clientRequest,
          idempotencyKey: `bulk-job-execution:${clientRequest.idempotencyKey}`,
        },
        actor: { userId: "member-owner" },
      }),
      summaryJson: JSON.stringify({ state: "running", preview }),
      completedAt: new Date(),
      rolledBackAt: null,
    });

    await Promise.all([executeRevenueBulkJob(job.id), executeRevenueBulkJob(job.id)]);

    assert.equal(
      (await AppDataSource.getRepository(RevenueOperation).findOneByOrFail({ id: job.id })).status,
      "completed",
    );
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: target.id }))
        .lifecycleStage,
      "qualified",
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueOperation).countBy({
        companyId,
        idempotencyKey: `bulk-job-execution:${clientRequest.idempotencyKey}`,
      }),
      1,
    );
  });

  test("reports incremental in-flight progress without weakening the execution transaction", async () => {
    const companyId = testCompanyId();
    const first = await contact(companyId, "Progress First");
    const second = await contact(companyId, "Progress Second");
    const preview = await runRevenueBulkOperation(companyId, {
      resourceType: "contact",
      target: { ids: [first.id, second.id] },
      action: {
        type: "set_contact_lifecycle",
        lifecycleStage: "qualified",
      },
      dryRun: true,
      mode: "partial",
    });
    const clientRequest = {
      resourceType: "contact" as const,
      target: { ids: [first.id, second.id] },
      action: {
        type: "set_contact_lifecycle" as const,
        lifecycleStage: "qualified" as const,
      },
      dryRun: false,
      mode: "partial" as const,
      idempotencyKey: "bulk-job-live-progress",
    };
    const job = await insert(RevenueOperation, {
      companyId,
      kind: "bulk",
      resourceType: "contact",
      status: "queued",
      idempotencyKey: clientRequest.idempotencyKey,
      requestJson: JSON.stringify({
        type: "bulk_job",
        clientRequest,
        executionRequest: {
          ...clientRequest,
          idempotencyKey: `bulk-job-execution:${clientRequest.idempotencyKey}`,
        },
        actor: { userId: "member-owner" },
      }),
      summaryJson: JSON.stringify({
        state: "queued",
        progress: {
          total: preview.matched,
          processed: 0,
          valid: preview.valid,
          failedValidation: preview.failed,
        },
        preview,
      }),
      completedAt: new Date(),
      rolledBackAt: null,
    });

    let releaseProgress!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let observedProgress!: () => void;
    const observed = new Promise<void>((resolve) => {
      observedProgress = resolve;
    });
    const execution = executeRevenueBulkJob(job.id, async (progress) => {
      if (progress.processed !== 1) return;
      observedProgress();
      await release;
    });
    await observed;
    try {
      const inFlight = await getRevenueBulkJob(companyId, job.id);
      assert.equal(inFlight?.operation.status, "running");
      assert.deepEqual(inFlight?.summary.progress, {
        total: 2,
        processed: 1,
        valid: 2,
        failedValidation: 0,
        applied: 1,
        skipped: 0,
        failed: 0,
      });
    } finally {
      releaseProgress();
    }
    await execution;

    const completed = await getRevenueBulkJob(companyId, job.id);
    assert.equal(completed?.operation.status, "completed");
    assert.equal((completed?.summary.progress as { processed?: number } | undefined)?.processed, 2);
    assert.equal(
      await AppDataSource.getRepository(RevenueOperation).countBy({
        companyId,
        idempotencyKey: `bulk-job-execution:${clientRequest.idempotencyKey}`,
      }),
      1,
    );
  });

  test("selects the same filtered follow-ups as the queue", async () => {
    const companyId = testCompanyId();
    const customer = await account(companyId, "Customer Account", {
      accountStatus: "customer",
    });
    const prospect = await account(companyId, "Prospect Account");
    const dueAt = new Date("2030-07-20T10:00:00.000Z");
    const reminderAt = new Date("2030-07-20T09:00:00.000Z");
    const matching = await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Send security answers",
      bodyText: "Complete the questionnaire",
      occurredAt: new Date("2030-07-01T00:00:00.000Z"),
      customerId: customer.id,
      taskStatus: "open",
      dueAt,
      priority: "high",
      reminderAt,
    });
    await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Send security answers",
      bodyText: "Wrong account status",
      occurredAt: new Date("2030-07-01T00:00:00.000Z"),
      customerId: prospect.id,
      taskStatus: "open",
      dueAt,
      priority: "high",
      reminderAt,
    });
    await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Unrelated work",
      bodyText: "",
      occurredAt: new Date("2030-07-01T00:00:00.000Z"),
      customerId: customer.id,
      taskStatus: "open",
      dueAt,
      priority: "normal",
      reminderAt,
    });
    const filter = {
      source: "task" as const,
      status: "open" as const,
      q: "security",
      priority: "high" as const,
      accountStatus: "customer" as const,
      archivedResources: "exclude" as const,
      dueFrom: new Date("2030-07-20T00:00:00.000Z"),
      dueTo: new Date("2030-07-21T00:00:00.000Z"),
      reminderFrom: new Date("2030-07-20T08:00:00.000Z"),
      reminderTo: new Date("2030-07-20T09:30:00.000Z"),
    };
    const queue = await listFollowUps(companyId, filter);
    const preview = await runRevenueBulkOperation(companyId, {
      resourceType: "follow_up",
      target: { filter },
      action: { type: "update_follow_up", taskStatus: "completed" },
      dryRun: true,
    });
    assert.deepEqual(
      queue.map((row) => row.id),
      [matching.id],
    );
    assert.deepEqual(
      preview.rows.map((row) => row.resourceId),
      queue.map((row) => row.id),
    );
  });

  test("matches task follow-ups linked to an Account through a Deal or Partnership", async () => {
    const companyId = testCompanyId();
    const targetAccount = await account(companyId, "Indirect Account");
    const otherAccount = await account(companyId, "Other Account");
    const dueAt = new Date("2031-01-20T10:00:00.000Z");
    const deal = await insert(Deal, {
      companyId,
      title: "Account-linked Deal",
      stageId: "open-stage",
      status: "open",
      customerId: targetAccount.id,
      archivedAt: null,
    });
    const partnership = await insert(Partnership, {
      companyId,
      name: "Account-linked Partnership",
      customerId: targetAccount.id,
      archivedAt: null,
    });
    const direct = await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Direct",
      occurredAt: dueAt,
      customerId: targetAccount.id,
      taskStatus: "open",
      dueAt,
    });
    const throughDeal = await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Through Deal",
      occurredAt: dueAt,
      dealId: deal.id,
      customerId: null,
      taskStatus: "open",
      dueAt,
    });
    const throughPartnership = await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Through Partnership",
      occurredAt: dueAt,
      partnershipId: partnership.id,
      customerId: null,
      taskStatus: "open",
      dueAt,
    });
    await insert(Activity, {
      companyId,
      kind: "task",
      subject: "Other",
      occurredAt: dueAt,
      customerId: otherAccount.id,
      taskStatus: "open",
      dueAt,
    });
    const filter = {
      source: "task" as const,
      linkedResourceType: "account" as const,
      linkedResourceId: targetAccount.id,
      closedDeals: "include" as const,
    };

    const queue = await listFollowUps(companyId, filter);
    const preview = await runRevenueBulkOperation(companyId, {
      resourceType: "follow_up",
      target: { filter },
      action: { type: "update_follow_up", priority: "high" },
      dryRun: true,
    });
    const expected = [direct.id, throughDeal.id, throughPartnership.id].sort();
    assert.deepEqual(queue.map((row) => row.id).sort(), expected);
    assert.deepEqual(preview.rows.map((row) => row.resourceId).sort(), expected);
  });

  test("caps mixed filtered follow-ups deterministically before freezing execution IDs", async () => {
    const companyId = testCompanyId();
    const dueAt = new Date("2035-01-01T12:00:00.000Z");
    const perSource = 1_700;
    await Promise.all([
      insertChunks(
        Activity,
        Array.from({ length: perSource }, (_, index) => ({
          id: followUpFixtureId(index),
          companyId,
          kind: "task",
          subject: `Task ${index}`,
          bodyText: "",
          occurredAt: dueAt,
          taskStatus: "open",
          dueAt,
          priority: "normal",
        })),
      ),
      insertChunks(
        Deal,
        Array.from({ length: perSource }, (_, index) => ({
          id: followUpFixtureId(10_000 + index),
          companyId,
          title: `Deal ${index}`,
          stageId: "open-stage",
          status: "open",
          nextFollowUpAt: dueAt,
          archivedAt: null,
        })),
      ),
      insertChunks(
        Partnership,
        Array.from({ length: perSource }, (_, index) => ({
          id: followUpFixtureId(20_000 + index),
          companyId,
          name: `Partnership ${index}`,
          nextFollowUpAt: dueAt,
          archivedAt: null,
        })),
      ),
    ]);
    const request = {
      resourceType: "follow_up" as const,
      target: {
        filter: {
          closedDeals: "include" as const,
          archivedResources: "exclude" as const,
        },
      },
      action: { type: "update_follow_up" as const, taskStatus: "completed" as const },
      dryRun: true,
    };
    const first = await runRevenueBulkOperation(companyId, request);
    const second = await runRevenueBulkOperation(companyId, request);
    const frozenIds = first.rows.map((row) => ({
      source: row.source!,
      id: row.resourceId,
    }));
    const frozen = await runRevenueBulkOperation(companyId, {
      ...request,
      target: { followUpIds: frozenIds },
    });
    const keys = (rows: typeof first.rows) => rows.map((row) => `${row.source}:${row.resourceId}`);

    assert.equal(first.matched, 5_000);
    assert.equal(first.rows.length, 5_000);
    assert.deepEqual(
      new Set(first.rows.map((row) => row.source)),
      new Set(["task", "deal", "partnership"]),
    );
    assert.deepEqual(keys(second.rows), keys(first.rows));
    assert.equal(frozen.matched, 5_000);
    assert.deepEqual(keys(frozen.rows), keys(first.rows));
  });

  test("paginates and exports a single follow-up source beyond five thousand rows", async () => {
    const companyId = testCompanyId();
    const dueAt = new Date("2035-02-01T12:00:00.000Z");
    const count = 5_105;
    await insertChunks(
      Activity,
      Array.from({ length: count }, (_, index) => ({
        id: followUpFixtureId(index),
        companyId,
        kind: "task",
        subject: `Task ${index}`,
        bodyText: "",
        occurredAt: dueAt,
        taskStatus: "open",
        dueAt,
        priority: "normal",
      })),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listFollowUpPage(companyId, {
        source: "task",
        state: "all",
        limit: 500,
        cursor,
      });
      seen.push(...page.rows.map((row) => row.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, count);
    assert.equal(new Set(seen).size, count);
    assert.equal(seen[5_000], followUpFixtureId(5_000));

    const exported = await exportRevenueSnapshotPage(companyId, "follow_ups", {
      limit: 10,
      offset: 5_000,
    });
    assert.equal(exported.rows.length, 10);
    assert.equal(exported.rows[0].id, followUpFixtureId(5_000));
    assert.equal(exported.nextOffset, 5_010);
  });
});

describe("Revenue import provenance and reconciliation", () => {
  test("records stable simple-import provenance and removes it with the imported resource", async () => {
    const companyId = testCompanyId();
    await createCustomField(companyId, {
      resourceType: "contact",
      name: "Current stack",
      fieldType: "text",
    });
    const batch = await commitRevenueImport(
      companyId,
      {
        resourceType: "contact",
        sourceKind: "csv",
        sourceLabel: "contacts.csv",
        mapping: {
          name: "name",
          email: "email",
          "custom:current_stack": "stack",
        },
        rows: [
          {
            sourceId: "csv-row-7",
            values: {
              name: "Imported Person",
              email: "imported@example.com",
              stack: "Prometheus",
            },
          },
        ],
      },
      { userId: "member-owner" },
    );
    const imported = await AppDataSource.getRepository(RevenueImportRow).findOneByOrFail({
      companyId,
      batchId: batch.id,
      sourceId: "csv-row-7",
    });
    const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).findOneByOrFail({
      companyId,
      resourceType: "contact",
      resourceId: imported.nativeId!,
      fieldKey: "custom:current_stack",
    });
    assert.equal(evidence.sourceType, "import");
    assert.equal(evidence.sourceId, `import:${batch.id}:csv-row-7:contact`);
    assert.equal(evidence.verificationState, "verified");
    assert.equal(evidence.verifyingActorType, "member");
    assert.equal(evidence.verifyingActorId, "member-owner");
    const metadata = JSON.parse(evidence.metadataJson) as Record<string, unknown>;
    assert.equal(metadata.importBatchId, batch.id);
    assert.equal(metadata.importSourceRowId, "csv-row-7");
    assert.equal(metadata.importedResourceType, "contact");

    assert.equal((await rollbackRevenueImport(companyId, batch.id))?.deleted, 1);
    assert.equal(
      await AppDataSource.getRepository(RevenueFieldEvidence).countBy({ id: evidence.id }),
      0,
    );
  });

  test("records stable linked-import provenance for every created resource", async () => {
    const companyId = testCompanyId();
    await installBaseMigrationCustomFields(companyId);
    const batch = await commitLinkedRevenueImport(
      companyId,
      {
        sourceKind: "base",
        sourceLabel: "Base / Revenue",
        sourceBaseId: "base-revenue",
        sourceTableId: "table-revenue",
        mapping: {
          account: { name: "company" },
          contact: { name: "person", email: "email" },
          deal: { title: "opportunity" },
        },
        rows: [
          {
            sourceId: "base-row-12",
            values: {
              company: "Linked Account",
              person: "Linked Contact",
              email: "linked@example.com",
              opportunity: "Linked Deal",
            },
          },
        ],
      },
      { employeeId: "employee-importer" },
    );
    const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).find({
      where: {
        companyId,
        sourceType: "import",
      },
      order: { resourceType: "ASC" },
    });
    assert.equal(evidence.length, 3);
    assert.deepEqual(
      new Set(evidence.map((row) => row.resourceType)),
      new Set(["account", "contact", "deal"]),
    );
    for (const row of evidence) {
      assert.equal(row.sourceId, `import:${batch.id}:base-row-12:${row.resourceType}`);
      assert.equal(row.verifyingActorType, "ai_employee");
      assert.equal(row.verifyingActorId, "employee-importer");
      assert.equal(JSON.parse(row.metadataJson).importBatchId, batch.id);
    }

    assert.equal((await rollbackRevenueImport(companyId, batch.id))?.deleted, 3);
    assert.equal(
      await AppDataSource.getRepository(RevenueFieldEvidence).countBy({
        companyId,
        sourceType: "import",
      }),
      0,
    );
  });

  test("paginates reconciliation rows after applying source, native, action, and error filters", async () => {
    const companyId = testCompanyId();
    const batch = await insert(RevenueImportBatch, {
      companyId,
      resourceType: "contact",
      sourceKind: "csv",
      sourceLabel: "large.csv",
      status: "completed",
      mappingJson: "{}",
      rowMapJson: "[]",
      createdIdsJson: "[]",
      reportJson: "{}",
      rolledBackAt: null,
    });
    const nativeA = "11111111-1111-4111-8111-111111111111";
    const nativeB = "22222222-2222-4222-8222-222222222222";
    await AppDataSource.getRepository(RevenueImportRow).save([
      AppDataSource.getRepository(RevenueImportRow).create({
        companyId,
        batchId: batch.id,
        resourceType: "contact",
        sourceId: "row-a",
        nativeId: nativeA,
        action: "create",
        status: "created",
        reason: "",
        decisionJson: "{}",
        sortOrder: 0,
      }),
      AppDataSource.getRepository(RevenueImportRow).create({
        companyId,
        batchId: batch.id,
        resourceType: "contact",
        sourceId: "row-b",
        nativeId: nativeB,
        action: "create",
        status: "created",
        reason: "",
        decisionJson: "{}",
        sortOrder: 1,
      }),
      AppDataSource.getRepository(RevenueImportRow).create({
        companyId,
        batchId: batch.id,
        resourceType: "contact",
        sourceId: "row-c",
        nativeId: null,
        action: "skip",
        status: "failed",
        reason: "Invalid email address",
        decisionJson: "{}",
        sortOrder: 2,
      }),
    ]);

    const firstPage = await getRevenueImportRows(companyId, batch.id, {
      resourceType: "contact",
      action: "create",
      limit: 1,
      offset: 0,
    });
    const secondPage = await getRevenueImportRows(companyId, batch.id, {
      resourceType: "contact",
      action: "create",
      limit: 1,
      offset: 1,
    });
    assert.equal(firstPage?.total, 2);
    assert.deepEqual(
      firstPage?.rows.map((row) => row.sourceId),
      ["row-a"],
    );
    assert.deepEqual(
      secondPage?.rows.map((row) => row.sourceId),
      ["row-b"],
    );
    assert.equal(
      (
        await getRevenueImportRows(companyId, batch.id, {
          sourceId: "row-b",
          nativeId: nativeB,
        })
      )?.total,
      1,
    );
    const failures = await getRevenueImportRows(companyId, batch.id, {
      status: "failed",
      error: "email",
      hasError: true,
    });
    assert.equal(failures?.total, 1);
    assert.equal(failures?.rows[0].sourceId, "row-c");
    assert.equal(
      (
        await getRevenueImportRows(companyId, batch.id, {
          q: nativeA,
          hasError: false,
        })
      )?.rows[0].sourceId,
      "row-a",
    );
  });

  test("materializes a legacy import ledger once under concurrent readers", async () => {
    const companyId = testCompanyId();
    const batch = await insert(RevenueImportBatch, {
      companyId,
      resourceType: "contact",
      sourceKind: "csv",
      sourceLabel: "legacy.csv",
      status: "completed",
      mappingJson: "{}",
      rowMapJson: JSON.stringify([
        {
          sourceId: "legacy-created",
          nativeId: "11111111-1111-4111-8111-111111111111",
          action: "create",
        },
        {
          sourceId: "legacy-matched",
          nativeId: "22222222-2222-4222-8222-222222222222",
          action: "duplicate",
        },
        {
          sourceId: "legacy-skipped",
          nativeId: null,
          action: "skip",
          reason: "Missing name",
        },
      ]),
      createdIdsJson: "[]",
      reportJson: "{}",
      rolledBackAt: null,
    });

    const reads = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        index % 2 === 0
          ? getRevenueImportRows(companyId, batch.id, { limit: 10 })
          : getRevenueImportSummary(companyId, batch.id),
      ),
    );
    assert.ok(reads.every((result) => result !== null));
    const rows = await AppDataSource.getRepository(RevenueImportRow).find({
      where: { companyId, batchId: batch.id },
      order: { sortOrder: "ASC" },
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.sourceId),
      ["legacy-created", "legacy-matched", "legacy-skipped"],
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  });
});
