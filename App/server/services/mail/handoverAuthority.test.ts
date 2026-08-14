import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveMailHandoverAuthority } from "./handovers.js";

describe("Mail handover execution authority", () => {
  test("binds manual and human-retried handovers to the accepting Member epoch", () => {
    assert.deepEqual(
      resolveMailHandoverAuthority({
        sourceKind: "manual",
        requesterUserId: "member-1",
        requesterSessionVersion: 7,
      }),
      { requesterUserId: "member-1", requesterSessionVersion: 7 },
    );
    assert.deepEqual(
      resolveMailHandoverAuthority({
        sourceKind: "rule",
        requesterUserId: "admin-2",
        requesterSessionVersion: 11,
      }),
      { requesterUserId: "admin-2", requesterSessionVersion: 11 },
    );
  });

  test("retains employee authority only for untouched rule automation", () => {
    assert.deepEqual(
      resolveMailHandoverAuthority({
        sourceKind: "rule",
        requesterUserId: null,
        requesterSessionVersion: null,
      }),
      { toolAuthority: "employee" },
    );
  });

  test("fails closed for legacy manual rows and partial authority records", () => {
    assert.equal(
      resolveMailHandoverAuthority({
        sourceKind: "manual",
        requesterUserId: null,
        requesterSessionVersion: null,
      }),
      null,
    );
    assert.equal(
      resolveMailHandoverAuthority({
        sourceKind: "manual",
        requesterUserId: "member-1",
        requesterSessionVersion: null,
      }),
      null,
    );
    assert.equal(
      resolveMailHandoverAuthority({
        sourceKind: "rule",
        requesterUserId: null,
        requesterSessionVersion: 3,
      }),
      null,
    );
  });
});
