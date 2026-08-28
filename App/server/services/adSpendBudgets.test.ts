import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { Budget } from "../db/entities/Budget.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Notification } from "../db/entities/Notification.js";
import { Membership } from "../db/entities/Membership.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import { makeAdSpendLedger } from "./adSpend.js";

/**
 * Budget envelopes at the ledger closure: scope resolution (company /
 * connection / employee — the tightest binds), calendar-month sums that
 * count only positive authorized deltas, and the once-per-month exhaustion
 * page.
 */

let companyId: string;
let connection: IntegrationConnection;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  connection = await insert(IntegrationConnection, {
    companyId,
    provider: "google-ads",
    label: "Ads",
    encryptedConfig: "",
  });
  await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
});

function ledger(employeeId?: string) {
  return makeAdSpendLedger({ connection, employeeId });
}

async function spend(amountMinor: number, over: Partial<AdSpendEvent> = {}): Promise<void> {
  await insert(AdSpendEvent, {
    companyId,
    connectionId: connection.id,
    employeeId: "",
    platform: "google-ads",
    adAccountRef: "",
    campaignRef: "",
    toolName: "ads_update_budget",
    mutationKind: "budget_increase",
    amountMinor,
    currency: "USD",
    ...over,
  });
}

describe("checkBudgets", () => {
  test("no budgets, no cost — and headroom passes", async () => {
    assert.equal(await ledger().checkBudgets(5_000), null);
    await insert(Budget, { companyId, name: "Ads month", amountMinor: 10_000 });
    await spend(4_000);
    assert.equal(await ledger().checkBudgets(5_000), null);
  });

  test("an exhausted company-wide envelope refuses with the budget named, and pages once", async () => {
    await insert(Budget, { companyId, name: "Ads month", amountMinor: 10_000 });
    await spend(8_000);
    const refusal = await ledger().checkBudgets(5_000);
    assert.match(refusal ?? "", /Refused by the budget "Ads month"/);
    assert.match(refusal ?? "", /Do not retry/);
    // Retrying against the dry envelope pages nobody a second time.
    await ledger().checkBudgets(5_000);
    // Give the fire-and-forget notify a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "budget_exhausted",
    });
    assert.equal(bells.length, 1);
  });

  test("decreases and other connections do not consume the envelope", async () => {
    await insert(Budget, {
      companyId,
      name: "This connection",
      amountMinor: 10_000,
      connectionId: connection.id,
    });
    await spend(-50_000); // a pause — spend-decreasing, never counted
    await spend(9_000, { connectionId: testId("other-conn") }); // someone else's platform
    assert.equal(await ledger().checkBudgets(9_500), null);
  });

  test("an employee-scoped envelope binds only that employee", async () => {
    const employeeId = testId("emp");
    await insert(Budget, {
      companyId,
      name: "Ada's envelope",
      amountMinor: 1_000,
      employeeId,
    });
    await spend(900, { employeeId });
    assert.match((await ledger(employeeId).checkBudgets(200)) ?? "", /Ada's envelope/);
    // A different employee (or an unattributed human mutation) is not bound.
    assert.equal(await ledger(testId("other-emp")).checkBudgets(200), null);
    assert.equal(await ledger().checkBudgets(200), null);
  });

  test("a disabled budget binds nobody", async () => {
    await insert(Budget, { companyId, name: "Off", amountMinor: 1, enabled: false });
    assert.equal(await ledger().checkBudgets(1_000_000), null);
  });

  test("the tightest of several applicable budgets binds", async () => {
    await insert(Budget, { companyId, name: "Company", amountMinor: 100_000 });
    await insert(Budget, {
      companyId,
      name: "Tight",
      amountMinor: 1_000,
      connectionId: connection.id,
    });
    const refusal = await ledger().checkBudgets(2_000);
    assert.match(refusal ?? "", /"Tight"/);
  });
});
