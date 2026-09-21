import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeBaseGrant } from "../../db/entities/EmployeeBaseGrant.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import { issueMcpToken, revokeMcpToken } from "../mcpTokens.js";
import {
  prepareRetryCapabilities,
  recordRegistryCapabilities,
  RetryPreflightError,
} from "./retryPreflight.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";

let companyId: string;
let employee: AIEmployee;
let token: string;
before(initTestDb);
beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, { companyId, name: "Ada", slug: "ada", role: "Analyst" });
  token = issueMcpToken(employee.id, companyId, { authority: "employee" });
});
after(async () => {
  revokeMcpToken(token);
  await closeTestDb();
});

async function preflight(names: string[]) {
  return prepareRetryCapabilities({
    token,
    employeeId: employee.id,
    nativeCoding: false,
    requiredTools: names,
    registry: residentOnlyRegistry(
      names.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
        run: async () => ({ content: "unused" }),
      })),
    ),
  });
}

test("preflight requires send access for email and draft access for human-reviewed email", async () => {
  const grant = await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: testId("mailbox"),
    accessLevel: "read",
  });
  await preflight(["get_mail_message", "read_mail_attachment"]);
  await assert.rejects(preflight(["send_mail"]), /Required tools are unavailable: send_mail/);
  await assert.rejects(preflight(["request_mail_review"]), /request_mail_review/);
  await AppDataSource.getRepository(EmployeeMailAccountGrant).update(grant.id, {
    accessLevel: "draft",
  });
  await preflight(["request_mail_review", "revise_mail_review"]);
  await assert.rejects(preflight(["send_mail"]), /send_mail/);
});

test("invoice access can perform receivables work but cannot stage accounting review", async () => {
  await insert(EmployeeFinanceGrant, {
    companyId,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  await preflight([
    "update_customer",
    "issue_estimate",
    "send_estimate",
    "record_payment",
    "void_invoice",
  ]);
  await assert.rejects(preflight(["review_finance_transaction"]), /review_finance_transaction/);
});

test("Revenue read and write requirements follow the operation rather than its name prefix", async () => {
  await assert.rejects(preflight(["get_sequence"]), /get_sequence/);
  const grant = await insert(EmployeeRevenueGrant, {
    companyId,
    employeeId: employee.id,
    accessLevel: "read",
  });
  await preflight([
    "preview_revenue_record_merge",
    "resolve_revenue_record_redirect",
    "export_revenue_snapshot",
  ]);
  await assert.rejects(preflight(["enroll_in_sequence"]), /enroll_in_sequence/);
  await AppDataSource.getRepository(EmployeeRevenueGrant).update(grant.id, {
    accessLevel: "write",
  });
  await preflight(["enroll_in_sequence", "create_deal_stage", "update_sequence"]);
});

test("tools spanning Revenue, Finance and Email check each standing Grant independently", async () => {
  await insert(EmployeeRevenueGrant, { companyId, employeeId: employee.id, accessLevel: "write" });
  const finance = await insert(EmployeeFinanceGrant, {
    companyId,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: testId("mailbox"),
    accessLevel: "read",
  });
  await preflight([
    "scan_revenue_mail_documents",
    "review_revenue_document_candidate",
    "list_commercial_value_backlog",
  ]);
  await assert.rejects(
    preflight(["propose_finance_commercial_values"]),
    /propose_finance_commercial_values/,
  );
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(finance.id, {
    accessLevel: "full",
  });
  await preflight(["propose_finance_commercial_values"]);
});

test("preflight fails closed when current Grants cannot be read", async (t) => {
  t.mock.method(AppDataSource.getRepository(EmployeeBaseGrant), "count", async () => {
    throw new Error("database unavailable");
  });
  await assert.rejects(preflight(["get_mail_message"]), (error: unknown) => {
    assert.ok(error instanceof RetryPreflightError);
    assert.match(error.message, /Current Grants could not be verified/);
    return true;
  });
});

test("a retry validates the durable capability record before any tool can execute", async () => {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Evidence",
    slug: "evidence",
    cronExpr: "0 9 * * *",
    body: "Read",
  });
  const parent = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, companyId, {
    authority: "employee",
    routineId: routine.id,
    runId: parent.id,
  });
  let effects = 0;
  const registry = residentOnlyRegistry([
    {
      name: "read_evidence",
      description: "Read evidence",
      inputSchema: {},
      run: async () => {
        const persisted = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
        assert.deepEqual(JSON.parse(persisted.requiredToolsJson!).tools, ["read_evidence"]);
        effects++;
        return { content: "evidence" };
      },
    },
  ]);
  const recorder = await prepareRetryCapabilities({
    token,
    employeeId: employee.id,
    registry,
    nativeCoding: false,
  });
  recordRegistryCapabilities(registry, recorder);
  await registry.resolve("read_evidence")!.run({});
  await recorder.flush();
  await AppDataSource.getRepository(Run).update(parent.id, {
    status: "error",
    errorKind: "timeout",
  });
  const retry = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    triggerKind: "retry",
    parentRunId: parent.id,
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, companyId, {
    authority: "employee",
    routineId: routine.id,
    runId: retry.id,
  });
  await assert.rejects(
    prepareRetryCapabilities({
      token,
      employeeId: employee.id,
      registry: residentOnlyRegistry([]),
      nativeCoding: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RetryPreflightError);
      assert.deepEqual(error.missingTools, ["read_evidence"]);
      assert.equal(error.phase, "preflight");
      return true;
    },
  );
  assert.equal(effects, 1);
  await prepareRetryCapabilities({ token, employeeId: employee.id, registry, nativeCoding: false });
});

test("a retry rejects reduced Grants even when its prior tool remains registered", async () => {
  const grant = await insert(EmployeeRevenueGrant, {
    companyId,
    employeeId: employee.id,
    accessLevel: "write",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Evidence",
    slug: "evidence",
    cronExpr: "0 9 * * *",
    body: "Read",
  });
  const parent = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, companyId, {
    authority: "employee",
    routineId: routine.id,
    runId: parent.id,
  });
  const recorder = await preflight(["list_contacts"]);
  await recorder.record(["list_contacts"]);
  const retry = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    triggerKind: "retry",
    parentRunId: parent.id,
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, companyId, {
    authority: "employee",
    routineId: routine.id,
    runId: retry.id,
  });
  await AppDataSource.getRepository(EmployeeRevenueGrant).update(grant.id, { accessLevel: "read" });
  await assert.rejects(preflight(["list_contacts"]), /Grant scope was reduced or changed/);
});
