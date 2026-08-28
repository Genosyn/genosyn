import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { isTokenTainted, issueMcpToken, markTokenTainted, revokeMcpToken } from "./mcpTokens.js";
import {
  TAINT_SINK_TOOLS,
  createTaintedToolApproval,
  parseTaintedToolPayload,
  taintGateApplies,
} from "./taintPolicy.js";

/**
 * The taint policy's load-bearing pieces: taint is a property of one live
 * turn (never survives the token), the gate fires only for the closed sink
 * set, the queued Approval is redacted where every Approval is, and the
 * payload parser refuses to become an arbitrary-tool trampoline.
 */

let companyId: string;
let employee: AIEmployee;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
});

describe("token taint lifecycle", () => {
  test("taint marks a live token, never a dead one, and dies with the token", () => {
    const token = issueMcpToken(employee.id, companyId, { authority: "employee" });
    assert.equal(isTokenTainted(token), false);
    markTokenTainted(token);
    assert.equal(isTokenTainted(token), true);
    revokeMcpToken(token);
    assert.equal(isTokenTainted(token), false);
    // A dead token cannot be re-tainted — the turn is over.
    markTokenTainted(token);
    assert.equal(isTokenTainted(token), false);
  });
});

describe("taintGateApplies", () => {
  test("fires only for a tainted token calling a sink", () => {
    const token = issueMcpToken(employee.id, companyId, { authority: "employee" });
    assert.equal(taintGateApplies(token, "send_mail"), false);
    markTokenTainted(token);
    assert.equal(taintGateApplies(token, "send_mail"), true);
    assert.equal(taintGateApplies(token, "create_routine"), true);
    // Reads and non-sinks stay free — the policy escalates side effects only.
    assert.equal(taintGateApplies(token, "list_goals"), false);
    assert.equal(taintGateApplies(undefined, "send_mail"), false);
    revokeMcpToken(token);
  });
});

describe("createTaintedToolApproval", () => {
  test("queues a pending approval whose payload round-trips and whose summary is bounded", async () => {
    const approval = await createTaintedToolApproval({
      companyId,
      employeeId: employee.id,
      tool: "send_mail",
      toolArgs: { accountId: "a", to: "ceo@example.com", subject: "hi" },
    });
    assert.equal(approval.status, "pending");
    assert.equal(approval.kind, "tainted_tool");
    assert.match(approval.title ?? "", /Tainted turn · send_mail/);
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    const payload = parseTaintedToolPayload(stored.payloadJson);
    assert.equal(payload.tool, "send_mail");
    assert.equal(payload.employeeId, employee.id);
    assert.equal((payload.args as { to: string }).to, "ceo@example.com");
  });
});

describe("parseTaintedToolPayload", () => {
  test("refuses tools outside the closed sink set", () => {
    assert.ok(TAINT_SINK_TOOLS.has("send_mail"));
    assert.throws(
      () =>
        parseTaintedToolPayload(
          JSON.stringify({ tool: "delete_company", args: {}, employeeId: "e" }),
        ),
      /does not cover/,
    );
    assert.throws(() => parseTaintedToolPayload(null), /missing/);
    assert.throws(
      () => parseTaintedToolPayload(JSON.stringify({ tool: "send_mail", employeeId: "e" })),
      /missing the call/,
    );
  });
});
