import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailDraftSendBatch } from "../../db/entities/MailDraftSendBatch.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import { listDrafts, listHomeDraftEmails } from "./drafts.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY = "home-drafts-company";
const OTHER_COMPANY = "other-home-drafts-company";

async function mailbox(overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId: COMPANY,
    connectionId: testId("connection"),
    address: "sender@example.test",
    ...overrides,
  });
}

async function draft(
  account: MailAccount,
  overrides: Partial<MailMessage> = {},
): Promise<MailMessage> {
  return insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: testId("thread"),
    gmailMessageId: testId("message"),
    gmailThreadId: testId("provider-thread"),
    gmailDraftId: testId("provider-draft"),
    toEmails: "recipient@example.test",
    subject: "Review this email",
    ...overrides,
  });
}

async function queue(
  account: MailAccount,
  items: Array<{ draftId: string; status: string }>,
  overrides: Partial<MailDraftSendBatch> = {},
): Promise<MailDraftSendBatch> {
  return insert(MailDraftSendBatch, {
    companyId: account.companyId,
    accountId: account.id,
    status: "running",
    total: items.length,
    itemsJson: JSON.stringify(items),
    ...overrides,
  });
}

describe("Home draft email reminders", () => {
  test("returns an empty summary when no mailboxes exist", async () => {
    assert.deepEqual(await listHomeDraftEmails(COMPANY), {
      draftEmails: [],
      draftEmailCount: 0,
      draftEmailAccounts: [],
    });
  });

  test("omits mailboxes whose drafts queue is empty", async () => {
    await mailbox();
    assert.deepEqual(await listHomeDraftEmails(COMPANY), {
      draftEmails: [],
      draftEmailCount: 0,
      draftEmailAccounts: [],
    });
  });

  test("counts draft messages rather than thread labels or conversations", async () => {
    const account = await mailbox();
    const one = await draft(account, { threadId: "shared-thread", labelIds: "" });
    const two = await draft(account, { threadId: "shared-thread", labelIds: " DRAFT " });
    await draft(account, { gmailDraftId: "", labelIds: " DRAFT " });
    await draft(account, { gmailDraftId: "", labelIds: " SENT " });
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(result.draftEmailCount, 2);
    assert.deepEqual(new Set(result.draftEmails.map((row) => row.id)), new Set([one.id, two.id]));
  });

  test("scopes both mailboxes and messages to the requested company and ignores orphan mirrors", async () => {
    const own = await mailbox();
    const other = await mailbox({ companyId: OTHER_COMPANY, address: "private@example.test" });
    const visible = await draft(own);
    await draft(other, { subject: "Other company secret" });
    await draft(other, { companyId: COMPANY, subject: "Mismatched mailbox" });
    await draft(own, { companyId: OTHER_COMPANY, subject: "Mismatched company" });
    await draft(own, { accountId: "deleted-account", subject: "Orphan" });
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(result.draftEmailCount, 1);
    assert.deepEqual(
      result.draftEmails.map((row) => row.id),
      [visible.id],
    );
    assert.deepEqual(result.draftEmailAccounts, [{ id: own.id, email: own.address, count: 1 }]);
    assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  });

  test("keeps Gmail and IMAP drafts visible for active, paused, and errored mailboxes", async () => {
    for (const [index, status] of ["active", "paused", "error"].entries()) {
      const account = await mailbox({
        status: status as MailAccount["status"],
        provider: index ? "imap" : "gmail",
      });
      await draft(account);
    }
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(result.draftEmailCount, 3);
    assert.equal(result.draftEmailAccounts.length, 3);
  });

  for (const status of ["queued", "running"] as const) {
    test(`excludes queued and sending items in a ${status} batch and matches the Drafts review total`, async () => {
      const account = await mailbox();
      const rows = await Promise.all(Array.from({ length: 5 }, () => draft(account)));
      await queue(
        account,
        [
          { draftId: rows[0].id, status: "queued" },
          { draftId: rows[1].id, status: "sending" },
          { draftId: rows[2].id, status: "failed" },
          { draftId: rows[3].id, status: "sent" },
        ],
        { status },
      );
      const result = await listHomeDraftEmails(COMPANY);
      const review = await listDrafts(account, { filter: {}, offset: 0, limit: 100 });
      assert.equal(result.draftEmailCount, 3);
      assert.equal(result.draftEmailCount, review.totals.total);
      assert.deepEqual(
        new Set(result.draftEmails.map((row) => row.id)),
        new Set(rows.slice(2).map((row) => row.id)),
      );
    });
  }

  for (const status of ["completed", "completed_with_errors"] as const) {
    test(`ignores a ${status} batch when deciding whether an unsent draft needs review`, async () => {
      const account = await mailbox();
      const row = await draft(account);
      await queue(account, [{ draftId: row.id, status: "queued" }], { status });
      assert.equal((await listHomeDraftEmails(COMPANY)).draftEmailCount, 1);
    });
  }

  test("an unrelated mailbox queue cannot hide this mailbox's draft", async () => {
    const one = await mailbox();
    const two = await mailbox({ address: "second@example.test" });
    const row = await draft(two);
    await queue(one, [{ draftId: row.id, status: "sending" }]);
    const result = await listHomeDraftEmails(COMPANY);
    assert.deepEqual(
      result.draftEmails.map((item) => item.id),
      [row.id],
    );
    assert.equal(result.draftEmailCount, 1);
  });

  test("hides an entirely queued mailbox from account summaries", async () => {
    const account = await mailbox();
    const row = await draft(account);
    await queue(account, [{ draftId: row.id, status: "queued" }]);
    assert.deepEqual(await listHomeDraftEmails(COMPANY), {
      draftEmails: [],
      draftEmailCount: 0,
      draftEmailAccounts: [],
    });
  });

  test("limits previews to five while counting every draft and every mailbox with a backlog", async () => {
    const newest = await mailbox({ address: "zeta@example.test" });
    const oldest = await mailbox({ address: "alpha@example.test" });
    await mailbox({ address: "empty@example.test" });
    for (let index = 0; index < 8; index += 1) {
      await draft(newest, { updatedAt: new Date(`2026-09-09T10:0${index}:00.000Z`) });
    }
    await draft(oldest, { updatedAt: new Date("2026-08-01T00:00:00.000Z") });
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(result.draftEmailCount, 9);
    assert.equal(result.draftEmails.length, 5);
    assert.ok(result.draftEmails.every((row) => row.accountId === newest.id));
    assert.deepEqual(result.draftEmailAccounts, [
      { id: oldest.id, email: oldest.address, count: 1 },
      { id: newest.id, email: newest.address, count: 8 },
    ]);
  });

  test("merges newest updates across mailboxes and breaks equal timestamps by descending id", async () => {
    const one = await mailbox();
    const two = await mailbox({ address: "second@example.test" });
    const stamp = new Date("2026-09-09T10:00:00.000Z");
    await draft(one, { id: "draft-a", updatedAt: stamp });
    await draft(two, { id: "draft-c", updatedAt: stamp });
    await draft(one, { id: "draft-b", updatedAt: stamp });
    await draft(two, { id: "draft-newest", updatedAt: new Date(stamp.getTime() + 1_000) });
    assert.deepEqual(
      (await listHomeDraftEmails(COMPANY)).draftEmails.map((row) => row.id),
      ["draft-newest", "draft-c", "draft-b", "draft-a"],
    );
  });

  test("uses mailbox ids to stabilize summaries when two mailboxes share an address", async () => {
    const later = await mailbox({ id: "mailbox-z" });
    const first = await mailbox({ id: "mailbox-a" });
    await draft(later);
    await draft(first);
    assert.deepEqual(
      (await listHomeDraftEmails(COMPANY)).draftEmailAccounts.map((row) => row.id),
      ["mailbox-a", "mailbox-z"],
    );
  });

  test("keeps unfinished drafts and preserves quoted recipient names without parsing commas", async () => {
    const account = await mailbox();
    const empty = await draft(account, {
      toEmails: " \t ",
      ccEmails: " ",
      bccEmails: " ",
      subject: "",
    });
    const addressed = await draft(account, {
      toEmails: '  "Last, First" <person@example.test>, second@example.test  ',
    });
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(result.draftEmailCount, 2);
    assert.equal(result.draftEmails.find((row) => row.id === empty.id)?.recipientSummary, "");
    assert.equal(result.draftEmails.find((row) => row.id === empty.id)?.subject, "");
    assert.equal(
      result.draftEmails.find((row) => row.id === addressed.id)?.recipientSummary,
      '"Last, First" <person@example.test>, second@example.test',
    );
  });

  test("shows valid Cc-only and Bcc-only recipients without calling them missing", async () => {
    const account = await mailbox();
    const cc = await draft(account, {
      toEmails: "",
      ccEmails: " copy@example.test ",
      bccEmails: "hidden@example.test",
    });
    const bcc = await draft(account, { toEmails: " ", bccEmails: " hidden@example.test " });
    const result = await listHomeDraftEmails(COMPANY);
    assert.equal(
      result.draftEmails.find((row) => row.id === cc.id)?.recipientSummary,
      "Cc: copy@example.test",
    );
    assert.equal(
      result.draftEmails.find((row) => row.id === bcc.id)?.recipientSummary,
      "Bcc: hidden@example.test",
    );
  });

  test("returns only navigation and reminder fields, without message bodies or provider handles", async () => {
    const account = await mailbox();
    const stamp = new Date("2026-09-09T12:00:00.000Z");
    const row = await draft(account, {
      bodyText: "Private long body",
      bodyHtml: "<p>Private HTML</p>",
      snippet: "Private snippet",
      attachmentsJson: '[{"filename":"private.pdf"}]',
      updatedAt: stamp,
    });
    const result = await listHomeDraftEmails(COMPANY);
    assert.deepEqual(result.draftEmails, [
      {
        id: row.id,
        accountId: account.id,
        threadId: row.threadId,
        subject: row.subject,
        recipientSummary: row.toEmails,
        accountEmail: account.address,
        updatedAt: stamp.toISOString(),
      },
    ]);
  });

  test("counts Member, AI Employee, and externally synced drafts equally", async () => {
    const account = await mailbox();
    await draft(account, { createdByUserId: "another-member" });
    await draft(account, { createdByEmployeeId: "employee" });
    await draft(account);
    assert.equal((await listHomeDraftEmails(COMPANY)).draftEmailCount, 3);
  });

  test("removes sent and discarded drafts and returns failed queued drafts to review", async () => {
    const account = await mailbox();
    const [sent, discarded, failed] = await Promise.all([
      draft(account),
      draft(account),
      draft(account),
    ]);
    const batch = await queue(account, [{ draftId: failed.id, status: "sending" }]);
    assert.equal((await listHomeDraftEmails(COMPANY)).draftEmailCount, 2);
    await AppDataSource.getRepository(MailMessage).update(sent.id, { gmailDraftId: "" });
    await AppDataSource.getRepository(MailMessage).delete(discarded.id);
    assert.equal((await listHomeDraftEmails(COMPANY)).draftEmailCount, 0);
    await AppDataSource.getRepository(MailDraftSendBatch).update(batch.id, {
      itemsJson: JSON.stringify([
        { draftId: failed.id, status: "failed", errorMessage: "Retry needed" },
      ]),
    });
    assert.deepEqual(
      (await listHomeDraftEmails(COMPANY)).draftEmails.map((row) => row.id),
      [failed.id],
    );
  });

  test("tolerates malformed stored queue metadata consistently with the review page", async () => {
    const account = await mailbox();
    await draft(account);
    await queue(account, [], { itemsJson: "{broken" });
    const result = await listHomeDraftEmails(COMPANY);
    const review = await listDrafts(account, { filter: {}, offset: 0, limit: 100 });
    assert.equal(result.draftEmailCount, 1);
    assert.equal(result.draftEmailCount, review.totals.total);
  });
});
