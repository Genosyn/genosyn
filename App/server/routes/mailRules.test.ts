import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailRule } from "../db/entities/MailRule.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

type SerializedAiCondition = {
  employeeId: string;
  employeeName: string;
  instruction: string;
};

type SerializedRule = {
  id: string;
  accountId: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: {
    from?: string;
    to?: string;
    subjectContains?: string;
    bodyContains?: string;
    hasAttachment?: boolean;
    ai?: SerializedAiCondition;
  };
  actions: Array<Record<string, unknown> & { type: string }>;
  matchCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
};

type ApiError = {
  error?: string;
  issues?: Array<{
    code?: string;
    keys?: string[];
    path?: Array<string | number>;
  }>;
};

type ApiResponse<T> = {
  status: number;
  body: T;
};

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  // Exercise the same router-level authentication and company membership
  // middleware as the product mount, rather than calling handlers directly.
  app.use("/api/companies/:cid", mailRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `mail-rules-owner-${randomUUID()}@example.com`,
    name: "Mailbox Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Mail Rules Company",
    slug: `mail-rules-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "inbox@example.com",
    status: "paused",
    createdByUserId: owner.id,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya Inbox",
    slug: `maya-inbox-${randomUUID()}`,
    role: "Inbox specialist",
    soulBody: "Classify incoming email conservatively.",
  });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function grantAiRuleAccess(target: AIEmployee = employee): Promise<void> {
  await insert(EmployeeMailAccountGrant, {
    employeeId: target.id,
    accountId: account.id,
    accessLevel: "read",
  });
  await insert(AIModel, {
    employeeId: target.id,
    provider: "openai",
    model: "gpt-4.1-mini",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-api-key" }),
    connectedAt: new Date(),
  });
}

function aiRuleRequest(name = "Marketing cleanup") {
  return {
    name,
    enabled: true,
    conditions: {
      from: "newsletter@",
      ai: {
        employeeId: employee.id,
        instruction: "Match only unsolicited marketing email.",
      },
    },
    actions: [{ type: "unsubscribe" }, { type: "archive" }],
  };
}

function assertValidationError(response: ApiResponse<ApiError>, label: string): void {
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error, "ValidationError", label);
  assert.ok(
    response.body.issues?.some((issue) => issue.code === "unrecognized_keys"),
    `${label}: expected an unrecognized_keys issue, got ${JSON.stringify(response.body.issues)}`,
  );
}

describe("mail rule HTTP API", () => {
  test("round-trips AI conditions and unsubscribe actions through create, list, and patch", async () => {
    await grantAiRuleAccess();

    const created = await call<{ rule: SerializedRule }>(
      "POST",
      `/mail/accounts/${account.id}/rules`,
      aiRuleRequest(),
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.rule.accountId, account.id);
    assert.equal(created.body.rule.name, "Marketing cleanup");
    assert.deepEqual(created.body.rule.conditions, {
      from: "newsletter@",
      ai: {
        employeeId: employee.id,
        employeeName: employee.name,
        instruction: "Match only unsolicited marketing email.",
      },
    });
    assert.deepEqual(created.body.rule.actions, [{ type: "unsubscribe" }, { type: "archive" }]);

    const storedAfterCreate = await AppDataSource.getRepository(MailRule).findOneByOrFail({
      id: created.body.rule.id,
    });
    assert.deepEqual(JSON.parse(storedAfterCreate.conditionsJson), {
      from: "newsletter@",
      ai: {
        employeeId: employee.id,
        instruction: "Match only unsolicited marketing email.",
      },
    });
    assert.ok(
      !storedAfterCreate.conditionsJson.includes("employeeName"),
      "the hydrated display name must not be persisted into rule conditions",
    );

    const listed = await call<{ rules: SerializedRule[] }>(
      "GET",
      `/mail/accounts/${account.id}/rules`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rules.length, 1);
    assert.deepEqual(listed.body.rules[0].conditions, created.body.rule.conditions);
    assert.deepEqual(listed.body.rules[0].actions, created.body.rule.actions);

    const patched = await call<{ rule: SerializedRule }>(
      "PATCH",
      `/mail/rules/${created.body.rule.id}`,
      {
        name: "Weekly promotion cleanup",
        conditions: {
          subjectContains: "weekly offer",
          ai: {
            employeeId: employee.id,
            instruction: "Match marketing promotions, but never transactional mail.",
          },
        },
        actions: [{ type: "unsubscribe" }, { type: "markRead" }],
      },
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.rule.name, "Weekly promotion cleanup");
    assert.deepEqual(patched.body.rule.conditions, {
      subjectContains: "weekly offer",
      ai: {
        employeeId: employee.id,
        employeeName: employee.name,
        instruction: "Match marketing promotions, but never transactional mail.",
      },
    });
    assert.deepEqual(patched.body.rule.actions, [{ type: "unsubscribe" }, { type: "markRead" }]);

    const listedAfterPatch = await call<{ rules: SerializedRule[] }>(
      "GET",
      `/mail/accounts/${account.id}/rules`,
    );
    assert.equal(listedAfterPatch.status, 200);
    assert.equal(listedAfterPatch.body.rules.length, 1);
    assert.deepEqual(listedAfterPatch.body.rules[0], patched.body.rule);
  });

  test("requires both a mailbox Read Grant and a connected active AI Model", async () => {
    const path = `/mail/accounts/${account.id}/rules`;

    const withoutGrant = await call<ApiError>("POST", path, aiRuleRequest("No grant"));
    assert.equal(withoutGrant.status, 400);
    assert.match(withoutGrant.body.error ?? "", /needs at least Read access/);
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);

    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    const withoutModel = await call<ApiError>("POST", path, aiRuleRequest("No model"));
    assert.equal(withoutModel.status, 400);
    assert.match(withoutModel.body.error ?? "", /needs a connected AI Model/);

    const disconnectedModel = await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-4.1-mini",
      authMode: "apikey",
      isActive: true,
      configJson: "{}",
      connectedAt: null,
    });
    const withDisconnectedModel = await call<ApiError>(
      "POST",
      path,
      aiRuleRequest("Disconnected model"),
    );
    assert.equal(withDisconnectedModel.status, 400);
    assert.match(withDisconnectedModel.body.error ?? "", /needs a connected AI Model/);

    disconnectedModel.configJson = JSON.stringify({
      apiKeyEncrypted: "encrypted-test-api-key",
    });
    disconnectedModel.connectedAt = new Date();
    await AppDataSource.getRepository(AIModel).save(disconnectedModel);

    const accepted = await call<{ rule: SerializedRule }>(
      "POST",
      path,
      aiRuleRequest("Requirements met"),
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.rule.conditions.ai?.employeeName, employee.name);
  });

  test("rejects cross-company AI Employees and hydrates deleted employees safely", async () => {
    const otherCompany = await insert(Company, {
      name: "Other Company",
      slug: `other-mail-rules-${randomUUID()}`,
      ownerId: actingUserId as string,
    });
    const outsiderEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Other Inbox",
      slug: `other-inbox-${randomUUID()}`,
      role: "Inbox specialist",
    });

    const crossCompanyCreate = await call<ApiError>("POST", `/mail/accounts/${account.id}/rules`, {
      name: "Wrong company",
      conditions: {
        ai: {
          employeeId: outsiderEmployee.id,
          instruction: "Classify this message.",
        },
      },
      actions: [{ type: "archive" }],
    });
    assert.equal(crossCompanyCreate.status, 400);
    assert.match(crossCompanyCreate.body.error ?? "", /not in this company/);

    const corruptedForeignReference = await insert(MailRule, {
      companyId: company.id,
      accountId: account.id,
      name: "Legacy foreign reference",
      enabled: false,
      position: 99,
      conditionsJson: JSON.stringify({
        ai: {
          employeeId: outsiderEmployee.id,
          instruction: "A legacy row with an invalid tenant reference.",
        },
      }),
      actionsJson: JSON.stringify([{ type: "archive" }]),
    });
    const scopedList = await call<{ rules: SerializedRule[] }>(
      "GET",
      `/mail/accounts/${account.id}/rules`,
    );
    const scopedForeignRule = scopedList.body.rules.find(
      (rule) => rule.id === corruptedForeignReference.id,
    );
    assert.equal(scopedForeignRule?.conditions.ai?.employeeName, "(deleted AI Employee)");

    const deletedEmployeeId = employee.id;
    await AppDataSource.getRepository(AIEmployee).delete({ id: deletedEmployeeId });
    const legacyRule = await insert(MailRule, {
      companyId: company.id,
      accountId: account.id,
      name: "Employee removed later",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({
        ai: {
          employeeId: deletedEmployeeId,
          instruction: "Classify marketing messages.",
        },
      }),
      actionsJson: JSON.stringify([{ type: "archive" }]),
    });

    const listed = await call<{ rules: SerializedRule[] }>(
      "GET",
      `/mail/accounts/${account.id}/rules`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rules[0].conditions.ai?.employeeId, deletedEmployeeId);
    assert.equal(listed.body.rules[0].conditions.ai?.employeeName, "(deleted AI Employee)");

    const crossCompanyPatch = await call<ApiError>("PATCH", `/mail/rules/${legacyRule.id}`, {
      conditions: {
        ai: {
          employeeId: outsiderEmployee.id,
          instruction: "Use an employee from another company.",
        },
      },
    });
    assert.equal(crossCompanyPatch.status, 400);
    assert.match(crossCompanyPatch.body.error ?? "", /not in this company/);
    const disabledCrossCompanyPatch = await call<ApiError>(
      "PATCH",
      `/mail/rules/${legacyRule.id}`,
      {
        enabled: false,
        conditions: {
          ai: {
            employeeId: outsiderEmployee.id,
            instruction: "Disabling must not bypass tenant validation.",
          },
        },
      },
    );
    assert.equal(disabledCrossCompanyPatch.status, 400);
    assert.match(disabledCrossCompanyPatch.body.error ?? "", /not in this company/);
    const unchanged = await AppDataSource.getRepository(MailRule).findOneByOrFail({
      id: legacyRule.id,
    });
    assert.equal(JSON.parse(unchanged.conditionsJson).ai.employeeId, deletedEmployeeId);
  });

  test("rejects unknown fields at every rule request boundary", async () => {
    const path = `/mail/accounts/${account.id}/rules`;
    const base = {
      name: "Strict rule",
      conditions: { subjectContains: "promotion" },
      actions: [{ type: "archive" }],
    };

    assertValidationError(
      await call<ApiError>("POST", path, { ...base, unexpected: true }),
      "unknown create field",
    );
    assertValidationError(
      await call<ApiError>("POST", path, {
        ...base,
        conditions: { subjectContains: "promotion", unexpected: true },
      }),
      "unknown condition field",
    );
    assertValidationError(
      await call<ApiError>("POST", path, {
        ...base,
        conditions: {
          ai: {
            employeeId: employee.id,
            instruction: "Classify marketing messages.",
            employeeName: "Client-supplied display value",
          },
        },
      }),
      "unknown AI condition field",
    );
    assertValidationError(
      await call<ApiError>("POST", path, {
        ...base,
        actions: [{ type: "unsubscribe", url: "https://attacker.example/unsubscribe" }],
      }),
      "unknown action field",
    );

    const stored = await insert(MailRule, {
      companyId: company.id,
      accountId: account.id,
      name: "Patch target",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({ subjectContains: "promotion" }),
      actionsJson: JSON.stringify([{ type: "archive" }]),
    });
    assertValidationError(
      await call<ApiError>("PATCH", `/mail/rules/${stored.id}`, { unexpected: true }),
      "unknown patch field",
    );
  });

  test("rejects catch-all unsubscribe rules while allowing a conditioned static rule", async () => {
    const path = `/mail/accounts/${account.id}/rules`;
    const unsafeConditions = [{}, { from: " \t " }, { hasAttachment: false }];
    for (const [index, conditions] of unsafeConditions.entries()) {
      const rejected = await call<ApiError>("POST", path, {
        name: `Unsafe unsubscribe ${index}`,
        conditions,
        actions: [{ type: "unsubscribe" }],
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.error ?? "", /needs at least one static or AI condition/);
    }
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);

    const accepted = await call<{ rule: SerializedRule }>("POST", path, {
      name: "Conditioned unsubscribe",
      conditions: { subjectContains: "marketing promotion" },
      actions: [{ type: "unsubscribe" }],
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.rule.conditions, {
      subjectContains: "marketing promotion",
    });
    assert.deepEqual(accepted.body.rule.actions, [{ type: "unsubscribe" }]);
  });

  test("keeps legacy static-only rules readable and patchable without AI setup", async () => {
    const legacyConditions = {
      from: "billing.example",
      to: "accounts@",
      subjectContains: "invoice",
      bodyContains: "amount due",
      hasAttachment: true,
    };
    const legacyActions = [{ type: "applyLabel", labelName: "Finance" }, { type: "markRead" }];
    const legacy = await insert(MailRule, {
      companyId: company.id,
      accountId: account.id,
      name: "Legacy finance triage",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify(legacyConditions),
      actionsJson: JSON.stringify(legacyActions),
      matchCount: 7,
      lastMatchedAt: new Date("2026-01-02T03:04:05.000Z"),
    });

    const listed = await call<{ rules: SerializedRule[] }>(
      "GET",
      `/mail/accounts/${account.id}/rules`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rules.length, 1);
    assert.equal(listed.body.rules[0].conditions.ai, undefined);
    assert.deepEqual(listed.body.rules[0].conditions, legacyConditions);
    assert.deepEqual(listed.body.rules[0].actions, legacyActions);
    assert.equal(listed.body.rules[0].matchCount, 7);
    assert.equal(listed.body.rules[0].lastMatchedAt, "2026-01-02T03:04:05.000Z");

    const patched = await call<{ rule: SerializedRule }>("PATCH", `/mail/rules/${legacy.id}`, {
      name: "Legacy finance triage updated",
      enabled: false,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.rule.name, "Legacy finance triage updated");
    assert.equal(patched.body.rule.enabled, false);
    assert.deepEqual(patched.body.rule.conditions, legacyConditions);
    assert.deepEqual(patched.body.rule.actions, legacyActions);

    const createdStatic = await call<{ rule: SerializedRule }>(
      "POST",
      `/mail/accounts/${account.id}/rules`,
      {
        name: "New static rule",
        conditions: { from: "alerts@example.com" },
        actions: [{ type: "star" }],
      },
    );
    assert.equal(createdStatic.status, 200, JSON.stringify(createdStatic.body));
    assert.deepEqual(createdStatic.body.rule.conditions, { from: "alerts@example.com" });
    assert.deepEqual(createdStatic.body.rule.actions, [{ type: "star" }]);
  });

  test("enforces the real router authentication and company membership middleware", async () => {
    actingUserId = null;
    const unauthenticated = await call<ApiError>("GET", `/mail/accounts/${account.id}/rules`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error, "Unauthorized");

    const outsider = await insert(User, {
      email: `mail-rules-outsider-${randomUUID()}@example.com`,
      name: "Outsider",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    const forbidden = await call<ApiError>("GET", `/mail/accounts/${account.id}/rules`);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, "Forbidden");
  });
});
