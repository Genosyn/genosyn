import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  drainAttachmentsForToken,
  drainSidecarsForToken,
  issueMcpToken,
  noteAttachmentForToken,
  resolveMcpToken,
  revokeMcpToken,
  stageAttachmentForToken,
  stageSidecarForToken,
  tokenOwnsAttachment,
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
      conversationId: null,
      mailThreadId: null,
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

  test("carries the chat or email thread a turn is working, for provenance", () => {
    // The Decision Stack reads these back to say where a question came from, so
    // a surface that forgets to stamp them must degrade to null, not to another
    // surface's id.
    const chat = issueMcpToken("employee", "company", {
      authority: "employee",
      conversationId: "conv-1",
    });
    const mail = issueMcpToken("employee", "company", {
      authority: "employee",
      mailThreadId: "thread-1",
    });
    const bare = issueMcpToken("employee", "company", { authority: "employee" });

    assert.equal(resolveMcpToken(chat)?.conversationId, "conv-1");
    assert.equal(resolveMcpToken(chat)?.mailThreadId, null);
    assert.equal(resolveMcpToken(mail)?.mailThreadId, "thread-1");
    assert.equal(resolveMcpToken(mail)?.conversationId, null);
    assert.equal(resolveMcpToken(bare)?.conversationId, null);
    assert.equal(resolveMcpToken(bare)?.mailThreadId, null);

    revokeMcpToken(chat);
    revokeMcpToken(mail);
    revokeMcpToken(bare);
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

  test("a staged attachment is also owned by the turn that staged it", () => {
    const token = issueMcpToken("employee", "company");
    stageAttachmentForToken(token, "produced");
    assert.equal(tokenOwnsAttachment(token, "produced"), true);
    // Draining hands the ids to the caller for binding; the turn can still
    // work with the file afterwards (e.g. attach the filled form to a draft).
    drainAttachmentsForToken(token);
    assert.equal(tokenOwnsAttachment(token, "produced"), true);
    revokeMcpToken(token);
  });

  test("a noted attachment is owned without being offered to the reply", () => {
    // `read_mail_attachment` opens a file the human already has — working
    // material, not something to hand back as a download.
    const token = issueMcpToken("employee", "company");
    noteAttachmentForToken(token, "opened-from-email");
    assert.equal(tokenOwnsAttachment(token, "opened-from-email"), true);
    assert.deepEqual(drainAttachmentsForToken(token), []);
    revokeMcpToken(token);
  });

  test("ownership does not leak between turns", () => {
    const mine = issueMcpToken("employee", "company");
    const theirs = issueMcpToken("employee", "company");
    noteAttachmentForToken(mine, "my-file");
    assert.equal(tokenOwnsAttachment(theirs, "my-file"), false);
    assert.equal(tokenOwnsAttachment(mine, "unknown-file"), false);
    revokeMcpToken(mine);
    revokeMcpToken(theirs);
  });

  test("revocation drops ownership, and a dead token cannot claim more", () => {
    const token = issueMcpToken("employee", "company");
    noteAttachmentForToken(token, "a");
    revokeMcpToken(token);
    assert.equal(tokenOwnsAttachment(token, "a"), false);
    noteAttachmentForToken(token, "late");
    assert.equal(tokenOwnsAttachment(token, "late"), false);
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
