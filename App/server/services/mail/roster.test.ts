import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import { mailboxRoster } from "./roster.js";

/**
 * The mailbox roster feeds the AI triage settings: who could read the next
 * email, and on which brain. It must only offer models that can answer.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mailbox_roster_test";

async function fixture() {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: testId("connection"),
    address: "ap@example.com",
  });
  const employee = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "Support",
  });
  return { account, employee };
}

async function connectedModel(employeeId: string, model: string, isActive = false) {
  return insert(AIModel, {
    employeeId,
    provider: "anthropic",
    model,
    authMode: "apikey",
    isActive,
    configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-key" }),
    connectedAt: new Date(),
  });
}

describe("mailbox roster", () => {
  test("offers only connected models, active one first", async () => {
    const { account, employee } = await fixture();
    await connectedModel(employee.id, "claude-secondary");
    await connectedModel(employee.id, "claude-active", true);
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-unconfigured",
      authMode: "apikey",
      isActive: false,
      configJson: "{}",
    });

    const entry = (await mailboxRoster(COMPANY_ID, account.id)).find((r) => r.id === employee.id);

    assert.ok(entry);
    assert.equal(entry.hasModel, true);
    assert.deepEqual(
      entry.models.map((m) => m.model),
      ["claude-active", "claude-secondary"],
      "an unconnected model cannot answer, so it is not offered",
    );
  });

  test("an employee with no connected model is listed but offers no models", async () => {
    const { account, employee } = await fixture();
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-unconfigured",
      authMode: "apikey",
      isActive: true,
      configJson: "{}",
    });

    const entry = (await mailboxRoster(COMPANY_ID, account.id)).find((r) => r.id === employee.id);

    assert.ok(entry);
    assert.equal(entry.hasModel, true, "a row exists, so the chat seam has something to resolve");
    assert.deepEqual(entry.models, []);
  });

  test("reports each employee's Grant on this mailbox and no other", async () => {
    const { account, employee } = await fixture();
    const other = await insert(MailAccount, {
      companyId: COMPANY_ID,
      connectionId: testId("connection"),
      address: "sales@example.com",
    });
    const reader = await insert(AIEmployee, {
      companyId: COMPANY_ID,
      name: "Alex Nunes",
      slug: "alex",
      role: "Finance",
    });
    await insert(EmployeeMailAccountGrant, {
      accountId: account.id,
      employeeId: employee.id,
      accessLevel: "draft",
    });
    await insert(EmployeeMailAccountGrant, {
      accountId: other.id,
      employeeId: reader.id,
      accessLevel: "send",
    });

    const roster = await mailboxRoster(COMPANY_ID, account.id);

    assert.deepEqual(
      roster.map((r) => [r.slug, r.accessLevel]),
      [
        ["alex", null],
        ["jamie", "draft"],
      ],
    );
  });
});
