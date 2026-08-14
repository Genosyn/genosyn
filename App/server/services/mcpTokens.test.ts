import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  drainAttachmentsForToken,
  drainSidecarsForToken,
  issueMcpToken,
  resolveMcpToken,
  revokeMcpToken,
  stageAttachmentForToken,
  stageSidecarForToken,
} from "./mcpTokens.js";

describe("short-lived MCP tokens", () => {
  test("binds identity and optional Run provenance to a unique token", () => {
    const first = issueMcpToken("employee", "company", {
      runId: "run",
      routineId: "routine",
      authority: "employee",
    });
    const second = issueMcpToken("employee", "company");
    assert.notEqual(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.deepEqual(resolveMcpToken(first), {
      token: first,
      employeeId: "employee",
      companyId: "company",
      runId: "run",
      routineId: "routine",
      authority: "employee",
      requesterUserId: null,
      requesterSessionVersion: null,
      expiresAt: resolveMcpToken(first)!.expiresAt,
    });
    assert.equal(resolveMcpToken(second)?.authority, "untrusted");
    assert.equal(resolveMcpToken(second)?.runId, null);
    revokeMcpToken(first);
    revokeMcpToken(second);
  });

  test("binds an interactive token to its requesting Member", () => {
    const token = issueMcpToken("employee", "company", {
      authority: "member",
      requesterUserId: "member",
      requesterSessionVersion: 7,
    });
    assert.equal(resolveMcpToken(token)?.authority, "member");
    assert.equal(resolveMcpToken(token)?.requesterUserId, "member");
    assert.equal(resolveMcpToken(token)?.requesterSessionVersion, 7);
    revokeMcpToken(token);
  });

  test("rejects contradictory authority metadata", () => {
    assert.throws(
      () =>
        issueMcpToken("employee", "company", {
          authority: "member",
          requesterSessionVersion: 0,
        }),
      /requires a requester user id/,
    );
    assert.throws(
      () =>
        issueMcpToken("employee", "company", {
          authority: "member",
          requesterUserId: "member",
        }),
      /requires a valid requester session version/,
    );
    assert.throws(
      () =>
        issueMcpToken("employee", "company", {
          authority: "member",
          requesterUserId: "member",
          requesterSessionVersion: -1,
        }),
      /requires a valid requester session version/,
    );
    assert.throws(
      () =>
        issueMcpToken("employee", "company", {
          authority: "employee",
          requesterUserId: "member",
        }),
      /valid only for Member/,
    );
    assert.throws(
      () =>
        issueMcpToken("employee", "company", {
          authority: "employee",
          requesterSessionVersion: 0,
        }),
      /valid only for Member/,
    );
  });

  test("stages attachments in order and drains exactly once", () => {
    const token = issueMcpToken("employee", "company");
    stageAttachmentForToken(token, "a");
    stageAttachmentForToken(token, "b");
    assert.deepEqual(drainAttachmentsForToken(token), ["a", "b"]);
    assert.deepEqual(drainAttachmentsForToken(token), []);
    revokeMcpToken(token);
  });

  test("groups sidecars by kind while preserving per-kind order", () => {
    const token = issueMcpToken("employee", "company");
    stageSidecarForToken(token, "mail.suggestions", { id: 1 });
    stageSidecarForToken(token, "other", "x");
    stageSidecarForToken(token, "mail.suggestions", { id: 2 });
    assert.deepEqual(drainSidecarsForToken(token), {
      "mail.suggestions": [{ id: 1 }, { id: 2 }],
      other: ["x"],
    });
    assert.deepEqual(drainSidecarsForToken(token), {});
    revokeMcpToken(token);
  });

  test("revocation clears identity and staged payloads", () => {
    const token = issueMcpToken("employee", "company");
    stageAttachmentForToken(token, "a");
    stageSidecarForToken(token, "kind", "payload");
    revokeMcpToken(token);
    assert.equal(resolveMcpToken(token), null);
    assert.deepEqual(drainAttachmentsForToken(token), []);
    assert.deepEqual(drainSidecarsForToken(token), {});
  });

  test("never resurrects staging for unknown or revoked tokens", () => {
    const token = issueMcpToken("employee", "company");
    revokeMcpToken(token);
    stageAttachmentForToken(token, "late");
    stageSidecarForToken(token, "late", "payload");
    stageAttachmentForToken("unknown", "late");
    assert.deepEqual(drainAttachmentsForToken(token), []);
    assert.deepEqual(drainSidecarsForToken(token), {});
  });

  test("expires tokens after the TTL and sweeps their staging", () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const token = issueMcpToken("employee", "company");
      stageAttachmentForToken(token, "a");
      now += 8 * 60 * 60 * 1_000;
      assert.equal(resolveMcpToken(token), null);
      issueMcpToken("other", "company");
      assert.deepEqual(drainAttachmentsForToken(token), []);
    } finally {
      Date.now = realNow;
    }
  });
});
