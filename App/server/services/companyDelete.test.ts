import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import type { EntityTarget, ObjectLiteral } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { Company } from "../db/entities/Company.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { CustomerCreditApplication } from "../db/entities/CustomerCreditApplication.js";
import { CustomerCreditLine } from "../db/entities/CustomerCreditLine.js";
import { CustomerRefund } from "../db/entities/CustomerRefund.js";
import { EmployeeMarketingGrant } from "../db/entities/EmployeeMarketingGrant.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { InvoiceWriteOff } from "../db/entities/InvoiceWriteOff.js";
import { MailDraftSendBatch } from "../db/entities/MailDraftSendBatch.js";
import { MailSavedSearch } from "../db/entities/MailSavedSearch.js";
import { MarketingCampaign } from "../db/entities/MarketingCampaign.js";
import { MarketingCreative } from "../db/entities/MarketingCreative.js";
import { MarketingExperiment } from "../db/entities/MarketingExperiment.js";
import { MarketingPerformanceSnapshot } from "../db/entities/MarketingPerformanceSnapshot.js";
import { RealtimeEvent } from "../db/entities/RealtimeEvent.js";
import { Tag } from "../db/entities/Tag.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrDismissal } from "../db/entities/TldrDismissal.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { VendorCreditApplication } from "../db/entities/VendorCreditApplication.js";
import { VendorCreditLine } from "../db/entities/VendorCreditLine.js";
import { VendorRefund } from "../db/entities/VendorRefund.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { deleteCompanyCascade } from "./companyDelete.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGRESSION_ENTITIES: EntityTarget<ObjectLiteral>[] = [
  AdSpendEvent,
  CustomerCredit,
  CustomerCreditApplication,
  CustomerRefund,
  EmployeeMarketingGrant,
  FinanceProposal,
  InvoiceWriteOff,
  MailDraftSendBatch,
  MailSavedSearch,
  MarketingCampaign,
  MarketingCreative,
  MarketingExperiment,
  MarketingPerformanceSnapshot,
  RealtimeEvent,
  Tag,
  Tldr,
  TldrDismissal,
  TldrSettings,
  VendorCredit,
  VendorCreditApplication,
  VendorRefund,
  WorkloadLease,
];

function requiredValue(type: unknown, companyId: string, property: string): unknown {
  const normalized = String(type).toLocaleLowerCase();
  if (normalized.includes("date") || normalized.includes("time")) return new Date();
  if (["int", "integer", "real", "float", "double", "numeric", "decimal"].includes(normalized)) {
    return 1;
  }
  if (normalized === "boolean" || normalized === "bool") return false;
  return `${companyId}-${property}`;
}

/** Insert a valid minimal row from TypeORM metadata, including future required columns. */
async function insertMinimal(
  entity: EntityTarget<ObjectLiteral>,
  companyId: string,
): Promise<void> {
  const metadata = AppDataSource.getMetadata(entity);
  const values: ObjectLiteral = {};
  for (const column of metadata.columns) {
    if (column.isGenerated || column.isCreateDate || column.isUpdateDate || column.isDeleteDate) {
      continue;
    }
    if (column.propertyName === "companyId") {
      values.companyId = companyId;
      continue;
    }
    if (column.isNullable || column.default !== undefined) continue;
    values[column.propertyName] = requiredValue(column.type, companyId, column.propertyName);
  }
  await AppDataSource.getRepository(entity).insert(values);
}

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

describe("company deletion integrity", () => {
  test("the cascade names every entity with a required companyId column", async () => {
    const entitiesDir = path.resolve(__dirname, "../db/entities");
    const cascadeSource = await fs.readFile(path.join(__dirname, "companyDelete.ts"), "utf8");
    const files = (await fs.readdir(entitiesDir)).filter((file) => file.endsWith(".ts"));
    const missing: string[] = [];

    for (const file of files) {
      const source = await fs.readFile(path.join(entitiesDir, file), "utf8");
      if (!/\bcompanyId!\s*:/.test(source)) continue;
      const className = /export class (\w+)/.exec(source)?.[1];
      if (!className) continue;
      const directDelete = new RegExp(
        `m\\.delete\\(\\s*${className}\\s*,\\s*\\{\\s*companyId\\s*\\}`,
      );
      if (!directDelete.test(cascadeSource)) missing.push(className);
    }

    assert.deepEqual(missing, [], `companyDelete.ts is missing: ${missing.join(", ")}`);
  });

  test("removes every previously omitted row and indirect child without touching another company", async () => {
    const companyA = await insert(Company, {
      name: "Delete me",
      slug: `delete-${testId("slug")}`,
      ownerId: testId("user"),
    });
    const companyB = await insert(Company, {
      name: "Keep me",
      slug: `keep-${testId("slug")}`,
      ownerId: testId("user"),
    });

    for (const entity of REGRESSION_ENTITIES) {
      await insertMinimal(entity, companyA.id);
      await insertMinimal(entity, companyB.id);
    }

    const [creditA, creditB] = await Promise.all(
      [companyA.id, companyB.id].map((companyId) =>
        AppDataSource.getRepository(CustomerCredit).findOneByOrFail({ companyId }),
      ),
    );
    const [vendorCreditA, vendorCreditB] = await Promise.all(
      [companyA.id, companyB.id].map((companyId) =>
        AppDataSource.getRepository(VendorCredit).findOneByOrFail({ companyId }),
      ),
    );
    const [tagA, tagB] = await Promise.all(
      [companyA.id, companyB.id].map((companyId) =>
        AppDataSource.getRepository(Tag).findOneByOrFail({ companyId }),
      ),
    );
    await insert(CustomerCreditLine, { creditId: creditA.id, description: "delete" });
    await insert(CustomerCreditLine, { creditId: creditB.id, description: "keep" });
    await insert(VendorCreditLine, { creditId: vendorCreditA.id, description: "delete" });
    await insert(VendorCreditLine, { creditId: vendorCreditB.id, description: "keep" });
    await insert(TagAssignment, {
      tagId: tagA.id,
      resourceType: "resource",
      resourceId: testId("delete"),
    });
    await insert(TagAssignment, {
      tagId: tagB.id,
      resourceType: "resource",
      resourceId: testId("keep"),
    });

    await deleteCompanyCascade({ companyId: companyA.id, companySlug: companyA.slug });

    assert.equal(await AppDataSource.getRepository(Company).countBy({ id: companyA.id }), 0);
    assert.equal(await AppDataSource.getRepository(Company).countBy({ id: companyB.id }), 1);
    for (const entity of REGRESSION_ENTITIES) {
      assert.equal(
        await AppDataSource.getRepository(entity).countBy({ companyId: companyA.id }),
        0,
        `${AppDataSource.getMetadata(entity).name} leaked deleted-company data`,
      );
      assert.equal(
        await AppDataSource.getRepository(entity).countBy({ companyId: companyB.id }),
        1,
        `${AppDataSource.getMetadata(entity).name} deleted another company's data`,
      );
    }
    assert.equal(await AppDataSource.getRepository(CustomerCreditLine).count(), 1);
    assert.equal(await AppDataSource.getRepository(VendorCreditLine).count(), 1);
    assert.equal(await AppDataSource.getRepository(TagAssignment).count(), 1);
  });
});
