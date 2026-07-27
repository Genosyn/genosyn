import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { RevenueOperationRow } from "../../db/entities/RevenueOperationRow.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { getCustomValues } from "./customFields.js";
import { dismissRevenueDuplicateCandidate, scanRevenueDuplicates } from "./duplicates.js";
import { mergeRevenueRecords } from "./merge.js";
import { findMergedRecordRedirect, rollbackRevenueOperation } from "./operations.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function account(companyId: string, name: string, domain = ""): Promise<Customer> {
  return insert(Customer, {
    companyId,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    accountStatus: "prospect",
    domain,
    archivedAt: null,
  });
}

async function duplicateCandidate(
  companyId: string,
  resourceType: RevenueDuplicateCandidate["resourceType"],
  firstId: string,
  secondId: string,
  kind: string,
  score: number,
): Promise<RevenueDuplicateCandidate> {
  const [leftId, rightId] = [firstId, secondId].sort();
  return insert(RevenueDuplicateCandidate, {
    companyId,
    resourceType,
    leftId,
    rightId,
    score,
    reasonsJson: JSON.stringify([{ kind, score }]),
    status: "open",
    detectedAt: new Date(),
  });
}

async function customField(companyId: string): Promise<RevenueCustomField> {
  return insert(RevenueCustomField, {
    companyId,
    resourceType: "account",
    key: "segment",
    name: "Segment",
    fieldType: "text",
    required: false,
    sortOrder: 0,
  });
}

async function customValue(
  companyId: string,
  resourceId: string,
  fieldId: string,
  value: string,
): Promise<RevenueCustomValue> {
  return insert(RevenueCustomValue, {
    companyId,
    resourceType: "account",
    resourceId,
    fieldId,
    valueJson: JSON.stringify(value),
    searchValue: value.toLowerCase(),
  });
}

let evidenceSequence = 0;

async function fieldEvidence(
  companyId: string,
  resourceId: string,
  fieldKey: string,
  value: unknown,
  status: "accepted" | "proposed" = "accepted",
): Promise<RevenueFieldEvidence> {
  evidenceSequence += 1;
  const observedAt = new Date(`2026-07-01T00:00:${String(evidenceSequence).padStart(2, "0")}.000Z`);
  return insert(RevenueFieldEvidence, {
    companyId,
    resourceType: "account",
    resourceId,
    fieldKey,
    sourceType: "manual",
    sourceId: `merge-evidence-${evidenceSequence}`,
    sourceLabel: "Merge evidence fixture",
    extractedValueJson: JSON.stringify(value),
    normalizedValue: String(value).toLowerCase(),
    confidence: 100,
    status,
    verificationState: status === "accepted" ? "verified" : "unverified",
    extractionMethod: "manual",
    observedAt,
    extractedAt: observedAt,
    lastVerifiedAt: status === "accepted" ? observedAt : null,
    metadataJson: "{}",
    createdAt: observedAt,
  });
}

describe("Revenue merge hardening", () => {
  test("rejects a conflict resolution that assigns both owner types", async () => {
    const companyId = testCompanyId();
    const source = await insert(Contact, {
      companyId,
      name: "Source Contact",
      email: "source@example.test",
      lifecycleStage: "lead",
      ownerId: "member-source",
      ownerEmployeeId: null,
      archivedAt: null,
    });
    const target = await insert(Contact, {
      companyId,
      name: "Target Contact",
      email: "target@example.test",
      lifecycleStage: "lead",
      ownerId: null,
      ownerEmployeeId: "employee-target",
      archivedAt: null,
    });

    await assert.rejects(
      () =>
        mergeRevenueRecords(
          companyId,
          "contact",
          source.id,
          target.id,
          source.name,
          {},
          { ownerId: "source" },
        ),
      /cannot have both a Member owner and an AI Employee owner/,
    );
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: source.id })).archivedAt,
      null,
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueOperation).count({ where: { companyId } }),
      0,
    );
  });

  test("rejects incoherent Deal stage, status, close date, and lost reason selections", async () => {
    const companyId = testCompanyId();
    const openStage = await insert(DealStage, {
      companyId,
      name: "Open",
      slug: "open",
      sortOrder: 0,
      probability: 25,
      kind: "open",
    });
    const lostStage = await insert(DealStage, {
      companyId,
      name: "Lost",
      slug: "lost",
      sortOrder: 1,
      probability: 0,
      kind: "lost",
    });
    const source = await insert(Deal, {
      companyId,
      title: "Source Deal",
      stageId: lostStage.id,
      status: "lost",
      closedAt: new Date("2026-07-01T00:00:00.000Z"),
      lostReason: "Budget",
      archivedAt: null,
    });
    const target = await insert(Deal, {
      companyId,
      title: "Target Deal",
      stageId: openStage.id,
      status: "open",
      closedAt: null,
      lostReason: "",
      archivedAt: null,
    });

    await assert.rejects(
      () =>
        mergeRevenueRecords(
          companyId,
          "deal",
          source.id,
          target.id,
          source.title,
          {},
          { stageId: "source" },
        ),
      /status open does not match Deal Stage kind lost/,
    );
    await assert.rejects(
      () =>
        mergeRevenueRecords(
          companyId,
          "deal",
          source.id,
          target.id,
          source.title,
          {},
          {
            stageId: "source",
            status: "source",
            closedAt: "target",
            lostReason: "source",
          },
        ),
      /terminal Deal must have a valid close date/,
    );

    const merged = await mergeRevenueRecords(
      companyId,
      "deal",
      source.id,
      target.id,
      source.title,
      {},
      {
        stageId: "source",
        status: "source",
        closedAt: "source",
        lostReason: "source",
      },
    );
    assert.ok(merged.operationId);
    const survivor = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id });
    assert.equal(survivor.stageId, lostStage.id);
    assert.equal(survivor.status, "lost");
    assert.equal(survivor.closedAt?.toISOString(), "2026-07-01T00:00:00.000Z");
    assert.equal(survivor.lostReason, "Budget");
  });

  test("resolves, rewires, and deduplicates every open candidate involving the source", async () => {
    const companyId = testCompanyId();
    const source = await account(companyId, "Merge Source");
    const target = await account(companyId, "Merge Target");
    const third = await account(companyId, "Third Account");
    const fourth = await account(companyId, "Fourth Account");
    const exact = await duplicateCandidate(
      companyId,
      "account",
      source.id,
      target.id,
      "same_domain",
      100,
    );
    const sourceThird = await duplicateCandidate(
      companyId,
      "account",
      source.id,
      third.id,
      "source_alias",
      60,
    );
    const targetThird = await duplicateCandidate(
      companyId,
      "account",
      target.id,
      third.id,
      "target_name",
      40,
    );
    const sourceFourth = await duplicateCandidate(
      companyId,
      "account",
      source.id,
      fourth.id,
      "shared_source_id",
      100,
    );

    const merged = await mergeRevenueRecords(
      companyId,
      "account",
      source.id,
      target.id,
      source.name,
    );
    assert.ok(merged.operationId);
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({
          id: exact.id,
        })
      ).status,
      "merged",
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneBy({
        id: sourceThird.id,
      }),
      null,
    );
    const combined = await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({
      id: targetThird.id,
    });
    assert.equal(combined.score, 100);
    assert.deepEqual(
      new Set(
        (JSON.parse(combined.reasonsJson) as Array<{ kind: string }>).map((reason) => reason.kind),
      ),
      new Set(["source_alias", "target_name"]),
    );
    const rewired = await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({
      id: sourceFourth.id,
    });
    assert.deepEqual(new Set([rewired.leftId, rewired.rightId]), new Set([target.id, fourth.id]));
    assert.equal(
      await AppDataSource.getRepository(RevenueDuplicateCandidate)
        .createQueryBuilder("candidate")
        .where("candidate.companyId = :companyId", { companyId })
        .andWhere("candidate.status = 'open'")
        .andWhere("(candidate.leftId = :sourceId OR candidate.rightId = :sourceId)", {
          sourceId: source.id,
        })
        .getCount(),
      0,
    );

    await rollbackRevenueOperation(companyId, merged.operationId!);
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({
          id: exact.id,
        })
      ).status,
      "open",
    );
    assert.ok(
      await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneBy({
        id: sourceThird.id,
      }),
    );
    const restoredRewire = await AppDataSource.getRepository(
      RevenueDuplicateCandidate,
    ).findOneByOrFail({ id: sourceFourth.id });
    assert.deepEqual(
      new Set([restoredRewire.leftId, restoredRewire.rightId]),
      new Set([source.id, fourth.id]),
    );
  });

  test("resolves redirect chains canonically and detects corrupt cycles", async () => {
    const companyId = testCompanyId();
    const first = await account(companyId, "Chain First");
    const second = await account(companyId, "Chain Second");
    const survivor = await account(companyId, "Chain Survivor");
    const firstMerge = await mergeRevenueRecords(
      companyId,
      "account",
      first.id,
      second.id,
      first.name,
    );
    const secondMerge = await mergeRevenueRecords(
      companyId,
      "account",
      second.id,
      survivor.id,
      second.name,
    );

    assert.deepEqual(await findMergedRecordRedirect(companyId, "account", first.id), {
      operationId: firstMerge.operationId,
      targetId: survivor.id,
    });
    assert.deepEqual(await findMergedRecordRedirect(companyId, "account", second.id), {
      operationId: secondMerge.operationId,
      targetId: survivor.id,
    });

    await rollbackRevenueOperation(companyId, secondMerge.operationId!);
    assert.deepEqual(await findMergedRecordRedirect(companyId, "account", first.id), {
      operationId: firstMerge.operationId,
      targetId: second.id,
    });

    await insert(RevenueOperation, {
      companyId,
      kind: "merge",
      resourceType: "contact",
      status: "completed",
      sourceId: "cycle-a",
      targetId: "cycle-b",
      requestJson: "{}",
      summaryJson: "{}",
      completedAt: new Date(),
    });
    await insert(RevenueOperation, {
      companyId,
      kind: "merge",
      resourceType: "contact",
      status: "completed",
      sourceId: "cycle-b",
      targetId: "cycle-a",
      requestJson: "{}",
      summaryJson: "{}",
      completedAt: new Date(),
    });
    await assert.rejects(
      () => findMergedRecordRedirect(companyId, "contact", "cycle-a"),
      /redirect cycle detected/,
    );
  });
});

describe("Revenue merge evidence reconciliation", () => {
  test("target wins supersede losing source evidence and expose target provenance", async () => {
    const companyId = testCompanyId();
    const source = await account(companyId, "Evidence Source", "source.example");
    const target = await account(companyId, "Evidence Target", "target.example");
    const field = await customField(companyId);
    await customValue(companyId, source.id, field.id, "Source segment");
    await customValue(companyId, target.id, field.id, "Target segment");
    const targetDomain = await fieldEvidence(companyId, target.id, "domain", "target.example");
    const targetCustom = await fieldEvidence(
      companyId,
      target.id,
      "custom:segment",
      "Target segment",
    );
    const sourceDomain = await fieldEvidence(
      companyId,
      source.id,
      "domain",
      "source.example",
      "proposed",
    );
    const sourceCustom = await fieldEvidence(
      companyId,
      source.id,
      "custom:segment",
      "Source segment",
    );

    const merged = await mergeRevenueRecords(
      companyId,
      "account",
      source.id,
      target.id,
      source.name,
    );
    const evidenceRepo = AppDataSource.getRepository(RevenueFieldEvidence);
    for (const losing of [sourceDomain, sourceCustom]) {
      const current = await evidenceRepo.findOneByOrFail({ id: losing.id });
      assert.equal(current.resourceId, target.id);
      assert.equal(current.status, "superseded");
      assert.equal(current.verificationState, "superseded");
    }
    for (const winning of [targetDomain, targetCustom]) {
      const current = await evidenceRepo.findOneByOrFail({ id: winning.id });
      assert.equal(current.status, "accepted");
      assert.equal(current.verificationState, "verified");
    }
    const segment = (await getCustomValues(companyId, "account", target.id)).find(
      (row) => row.field.id === field.id,
    );
    assert.equal(segment?.value, "Target segment");
    assert.equal(segment?.provenance?.id, targetCustom.id);

    const operationRows = await AppDataSource.getRepository(RevenueOperationRow).find({
      where: { companyId, operationId: merged.operationId! },
    });
    const reconciled = operationRows.find((row) => row.resourceId === sourceCustom.id);
    assert.deepEqual(JSON.parse(reconciled!.beforeJson), {
      resourceId: source.id,
      status: "accepted",
      verificationState: "verified",
    });
    assert.deepEqual(JSON.parse(reconciled!.afterJson), {
      resourceId: target.id,
      status: "superseded",
      verificationState: "superseded",
    });
  });

  test("source wins keep its matching evidence active and supersede target evidence", async () => {
    const companyId = testCompanyId();
    const source = await account(companyId, "Source Winner", "source-wins.example");
    const target = await account(companyId, "Target Loser", "target-loses.example");
    const field = await customField(companyId);
    await customValue(companyId, source.id, field.id, "Source winner");
    await customValue(companyId, target.id, field.id, "Target loser");
    const sourceDomain = await fieldEvidence(companyId, source.id, "domain", "source-wins.example");
    const sourceCustom = await fieldEvidence(
      companyId,
      source.id,
      "custom:segment",
      "Source winner",
    );
    const targetDomain = await fieldEvidence(
      companyId,
      target.id,
      "domain",
      "target-loses.example",
    );
    const targetCustom = await fieldEvidence(
      companyId,
      target.id,
      "custom:segment",
      "Target loser",
      "proposed",
    );

    await mergeRevenueRecords(
      companyId,
      "account",
      source.id,
      target.id,
      source.name,
      {},
      { domain: "source", [`custom:${field.id}`]: "source" },
    );

    const survivor = await AppDataSource.getRepository(Customer).findOneByOrFail({
      id: target.id,
    });
    assert.equal(survivor.domain, "source-wins.example");
    const evidenceRepo = AppDataSource.getRepository(RevenueFieldEvidence);
    for (const winning of [sourceDomain, sourceCustom]) {
      const current = await evidenceRepo.findOneByOrFail({ id: winning.id });
      assert.equal(current.resourceId, target.id);
      assert.equal(current.status, "accepted");
      assert.equal(current.verificationState, "verified");
    }
    for (const losing of [targetDomain, targetCustom]) {
      const current = await evidenceRepo.findOneByOrFail({ id: losing.id });
      assert.equal(current.status, "superseded");
      assert.equal(current.verificationState, "superseded");
    }
    const segment = (await getCustomValues(companyId, "account", target.id)).find(
      (row) => row.field.id === field.id,
    );
    assert.equal(segment?.value, "Source winner");
    assert.equal(segment?.provenance?.id, sourceCustom.id);
  });

  test("guarded undo restores evidence ownership, active statuses, and custom provenance", async () => {
    const companyId = testCompanyId();
    const source = await account(companyId, "Undo Source");
    const target = await account(companyId, "Undo Target");
    const field = await customField(companyId);
    await customValue(companyId, source.id, field.id, "Source before undo");
    await customValue(companyId, target.id, field.id, "Target before merge");
    const sourceEvidence = await fieldEvidence(
      companyId,
      source.id,
      "custom:segment",
      "Source before undo",
    );
    const targetEvidence = await fieldEvidence(
      companyId,
      target.id,
      "custom:segment",
      "Target before merge",
    );
    const merged = await mergeRevenueRecords(
      companyId,
      "account",
      source.id,
      target.id,
      source.name,
      {},
      { [`custom:${field.id}`]: "source" },
    );
    assert.ok(merged.operationId);

    await rollbackRevenueOperation(companyId, merged.operationId!);

    const evidenceRepo = AppDataSource.getRepository(RevenueFieldEvidence);
    const restoredSource = await evidenceRepo.findOneByOrFail({ id: sourceEvidence.id });
    assert.equal(restoredSource.resourceId, source.id);
    assert.equal(restoredSource.status, "accepted");
    assert.equal(restoredSource.verificationState, "verified");
    const restoredTarget = await evidenceRepo.findOneByOrFail({ id: targetEvidence.id });
    assert.equal(restoredTarget.resourceId, target.id);
    assert.equal(restoredTarget.status, "accepted");
    assert.equal(restoredTarget.verificationState, "verified");
    const segment = (await getCustomValues(companyId, "account", target.id)).find(
      (row) => row.field.id === field.id,
    );
    assert.equal(segment?.value, "Target before merge");
    assert.equal(segment?.provenance?.id, targetEvidence.id);
  });
});

describe("duplicate rescan reconciliation", () => {
  test("replaces reasons and removes an open candidate when its evidence disappears", async () => {
    const companyId = testCompanyId();
    await account(companyId, "Acme Incorporated", "acme.example");
    const right = await account(companyId, "Acme LLC", "acme.example");

    assert.equal((await scanRevenueDuplicates(companyId)).created, 1);
    const repo = AppDataSource.getRepository(RevenueDuplicateCandidate);
    const initial = await repo.findOneByOrFail({ companyId, status: "open" });
    assert.ok(
      (JSON.parse(initial.reasonsJson) as Array<{ kind: string }>).some(
        (reason) => reason.kind === "normalized_name",
      ),
    );

    right.name = "Different Business";
    await AppDataSource.getRepository(Customer).save(right);
    const replaced = await scanRevenueDuplicates(companyId);
    assert.equal(replaced.updated, 1);
    const current = await repo.findOneByOrFail({ id: initial.id });
    assert.equal(
      (JSON.parse(current.reasonsJson) as Array<{ kind: string }>).some(
        (reason) => reason.kind === "normalized_name",
      ),
      false,
    );

    right.domain = "different.example";
    await AppDataSource.getRepository(Customer).save(right);
    const closed = await scanRevenueDuplicates(companyId);
    assert.equal(closed.closed, 1);
    assert.equal(await repo.findOneBy({ id: initial.id }), null);
  });

  test("keeps a dismissed pair as durable memory across disappearing and returning evidence", async () => {
    const companyId = testCompanyId();
    const left = await account(companyId, "Dismissed Incorporated");
    const right = await account(companyId, "Dismissed LLC");
    await scanRevenueDuplicates(companyId);
    const repo = AppDataSource.getRepository(RevenueDuplicateCandidate);
    const candidate = await repo.findOneByOrFail({ companyId, status: "open" });
    await dismissRevenueDuplicateCandidate(companyId, candidate.id, "member-1");

    right.name = "Unrelated Business";
    await AppDataSource.getRepository(Customer).save(right);
    assert.equal((await scanRevenueDuplicates(companyId)).closed, 0);
    assert.equal((await repo.findOneByOrFail({ id: candidate.id })).status, "dismissed");

    right.name = "Dismissed Limited";
    await AppDataSource.getRepository(Customer).save(right);
    await scanRevenueDuplicates(companyId);
    const remembered = await repo.findOneByOrFail({ id: candidate.id });
    assert.equal(remembered.status, "dismissed");
    assert.equal(remembered.resolvedByUserId, "member-1");
    assert.ok(remembered.resolvedAt);
    assert.deepEqual(
      new Set([remembered.leftId, remembered.rightId]),
      new Set([left.id, right.id]),
    );
  });
});
