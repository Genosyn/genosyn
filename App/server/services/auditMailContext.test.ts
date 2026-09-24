import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { closeTestDb, initTestDb, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { currentAuditContext, recordAudit, withAuditContext } from "./audit.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

async function saved(action: string) {
  return AppDataSource.getRepository(AuditEvent).findOneByOrFail({ action });
}

test("mail work inherits its exact source alongside Routine and conversation provenance", async () => {
  await withAuditContext(
    {
      mailThreadId: "thread-a",
      mailHandoverId: "handover-a",
      runId: "run-a",
      conversationId: "chat-a",
    },
    async () => {
      await Promise.resolve();
      await recordAudit({
        companyId: testCompanyId(),
        actorEmployeeId: "employee-a",
        action: "estimate.create",
        metadata: { currency: "GBP" },
      });
    },
  );
  const row = await saved("estimate.create");
  assert.deepEqual(JSON.parse(row.metadataJson), {
    currency: "GBP",
    mailThreadId: "thread-a",
    mailHandoverId: "handover-a",
  });
  assert.equal(row.runId, "run-a");
  assert.equal(row.conversationId, "chat-a");
  assert.equal(row.actorKind, "ai");
  assert.equal(currentAuditContext(), null);
});

test("metadata cannot override authenticated mail provenance or mutate the caller's input", async () => {
  const metadata = {
    mailThreadId: "forged-thread",
    mailHandoverId: "forged-handover",
    useful: true,
  };
  await withAuditContext({ mailThreadId: "real-thread", mailHandoverId: "real-handover" }, () =>
    recordAudit({ companyId: testCompanyId(), action: "decision.create", metadata }),
  );
  assert.deepEqual(JSON.parse((await saved("decision.create")).metadataJson), {
    mailThreadId: "real-thread",
    mailHandoverId: "real-handover",
    useful: true,
  });
  assert.equal(metadata.mailThreadId, "forged-thread");
});

test("unscoped calls cannot claim to have happened inside a mail handover", async () => {
  await recordAudit({
    companyId: testCompanyId(),
    action: "note.create",
    metadata: { mailThreadId: "forged-thread", mailHandoverId: "forged-handover" },
  });
  assert.equal((await saved("note.create")).metadataJson, "");
});

test("a handover without a thread is never promoted to mail provenance", async () => {
  await withAuditContext({ mailHandoverId: "orphan" }, () =>
    recordAudit({ companyId: testCompanyId(), action: "draft.create" }),
  );
  assert.equal((await saved("draft.create")).metadataJson, "");
});

test("a Member acting on an AI suggestion remains the actor", async () => {
  await withAuditContext({ mailThreadId: "thread-a" }, () =>
    recordAudit({ companyId: testCompanyId(), actorUserId: "member-a", action: "invoice.create" }),
  );
  const row = await saved("invoice.create");
  assert.equal(row.actorKind, "user");
  assert.equal(row.actorUserId, "member-a");
  assert.equal(row.actorEmployeeId, null);
  assert.deepEqual(JSON.parse(row.metadataJson), { mailThreadId: "thread-a" });
});

test("concurrent email actions keep separate source threads across asynchronous work", async () => {
  await Promise.all(
    ["a", "b", "c"].map((id) =>
      withAuditContext(
        { mailThreadId: `thread-${id}`, mailHandoverId: `handover-${id}` },
        async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await recordAudit({ companyId: testCompanyId(), action: `mail.action.${id}` });
        },
      ),
    ),
  );
  for (const id of ["a", "b", "c"]) {
    assert.deepEqual(JSON.parse((await saved(`mail.action.${id}`)).metadataJson), {
      mailThreadId: `thread-${id}`,
      mailHandoverId: `handover-${id}`,
    });
  }
});

test("a nested non-mail context cannot borrow its parent's email attribution", async () => {
  await withAuditContext({ mailThreadId: "outer-thread" }, async () => {
    await withAuditContext({ mailThreadId: null }, () =>
      recordAudit({ companyId: testCompanyId(), action: "unrelated.write" }),
    );
    await recordAudit({ companyId: testCompanyId(), action: "outer.write" });
  });
  assert.equal((await saved("unrelated.write")).metadataJson, "");
  assert.deepEqual(JSON.parse((await saved("outer.write")).metadataJson), {
    mailThreadId: "outer-thread",
  });
});
