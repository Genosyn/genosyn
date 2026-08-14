import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AuditEvent } from "../db/entities/AuditEvent.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

describe("turn action correlation boundary", () => {
  test("does not copy a concurrent Routine's audit metadata into delegated Member chat", async () => {
    const companyId = testId("company");
    const employeeId = testId("employee");
    const since = new Date(Date.now() - 1_000);
    await insert(AuditEvent, {
      companyId,
      actorKind: "ai",
      actorUserId: null,
      actorEmployeeId: employeeId,
      action: "integration.invoke",
      targetType: "connection",
      targetId: testId("connection"),
      targetLabel: "Routine-only payroll connection",
      metadataJson: JSON.stringify({
        via: "mcp",
        toolName: "read_payroll",
        argsPreview: '{"employee":"confidential"}',
        resultPreview: '{"salary":123456}',
      }),
    });

    for (const authority of ["member", "untrusted"] as const) {
      assert.deepEqual(
        await captureTurnActionsForAuthority({
          companyId,
          employeeId,
          since,
          authority,
        }),
        [],
      );
    }

    const employeeActions = await captureTurnActionsForAuthority({
      companyId,
      employeeId,
      since,
      authority: "employee",
    });
    assert.equal(employeeActions.length, 1);
    assert.equal(employeeActions[0]?.metadata?.resultPreview, '{"salary":123456}');
  });
});
