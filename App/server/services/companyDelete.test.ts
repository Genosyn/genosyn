import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { EntityTarget, ObjectLiteral } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { CustomerCreditApplication } from "../db/entities/CustomerCreditApplication.js";
import { CustomerCreditLine } from "../db/entities/CustomerCreditLine.js";
import { CustomerRefund } from "../db/entities/CustomerRefund.js";
import { EmployeeMarketingGrant } from "../db/entities/EmployeeMarketingGrant.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { ExternalChatIdentity } from "../db/entities/ExternalChatIdentity.js";
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
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrQuestionMessage } from "../db/entities/TldrQuestionMessage.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { VendorCreditApplication } from "../db/entities/VendorCreditApplication.js";
import { VendorCreditLine } from "../db/entities/VendorCreditLine.js";
import { VendorRefund } from "../db/entities/VendorRefund.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "./billing/billingSettings.js";
import { deleteCompanyCascade } from "./companyDelete.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGRESSION_ENTITIES: EntityTarget<ObjectLiteral>[] = [
  AdSpendEvent,
  CustomerCredit,
  CustomerCreditApplication,
  CustomerRefund,
  EmployeeMarketingGrant,
  ExternalChatIdentity,
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
  TldrQuestion,
  TldrQuestionMessage,
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

/**
 * Deleting a company must CANCEL its live Stripe subscription outright — with
 * the Company, Membership, and CompanyBilling rows gone, no route can ever
 * mint a billing-portal session for that customer again, so leaving the
 * subscription running would bill the card forever with no self-serve stop.
 */
describe("company deletion and Stripe", () => {
  const originalFetch = globalThis.fetch;
  type StripeCall = { method: string; url: string };
  let stripeCalls: StripeCall[] = [];
  let stripeFails = false;

  beforeEach(async () => {
    await insert(AppSetting, {
      key: BILLING_SETTING_KEY,
      value: JSON.stringify({
        enabled: true,
        growthPriceId: "price_growth",
        scalePriceId: "price_scale",
        encryptedSecretKey: encryptSecret("sk_test_delete"),
        encryptedWebhookSecret: "",
      }),
    });
    invalidateBillingSettingsCache();
    stripeCalls = [];
    stripeFails = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.stripe.com/")) {
        stripeCalls.push({ method: init?.method ?? "GET", url });
        if (stripeFails) {
          return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
        }
        return new Response(JSON.stringify({ id: "sub_del", status: "canceled" }), {
          status: 200,
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateBillingSettingsCache();
  });

  async function companyWithSubscription(status: string): Promise<Company> {
    const company = await insert(Company, {
      name: "Billed",
      slug: `billed-${testId("slug")}`,
      ownerId: testId("user"),
    });
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "growth",
      status,
      stripeCustomerId: "cus_del",
      stripeSubscriptionId: "sub_del",
      stripeSubscriptionItemId: "si_del",
      seatCount: 3,
    });
    return company;
  }

  test("cancels a live subscription outright on delete", async () => {
    const company = await companyWithSubscription("active");
    await deleteCompanyCascade({ companyId: company.id, companySlug: company.slug });
    assert.deepEqual(stripeCalls, [
      { method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_del" },
    ]);
    assert.equal(await AppDataSource.getRepository(Company).countBy({ id: company.id }), 0);
  });

  test("a canceled subscription is left alone", async () => {
    const company = await companyWithSubscription("canceled");
    await deleteCompanyCascade({ companyId: company.id, companySlug: company.slug });
    assert.deepEqual(stripeCalls, []);
  });

  test("a Stripe failure is best-effort — the delete still completes", async () => {
    stripeFails = true;
    const company = await companyWithSubscription("active");
    await deleteCompanyCascade({ companyId: company.id, companySlug: company.slug });
    assert.equal(stripeCalls.length, 1);
    assert.equal(await AppDataSource.getRepository(Company).countBy({ id: company.id }), 0);
  });
});
