import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { FakeMailbox, type FakeMailboxCall } from "../../test/fakeMailbox.js";
import {
  type MailActionDependencies,
  type ThreadAction,
  bulkThreadAction,
  createMailDraft,
  performThreadAction,
  sendMailDraft,
  sendMailMessage,
} from "./actions.js";
import type { MimeFields } from "./mime.js";
import { columnHasLabel, columnToLabelIds, labelIdsToColumn } from "./store.js";
import { SuppressedRecipientError, addSuppression } from "./suppression.js";

/**
 * `actions.ts` seen through the provider seam.
 *
 * The point of the `Mailbox` interface is that this file no longer decides
 * *how* anything happens upstream — it says "archive this conversation" and an
 * adapter turns that into a Gmail label edit or an IMAP move. That claim is
 * only worth anything if something checks it, and the check has to happen at
 * the boundary: whether `star` went out as one `setFlagged` call or as
 * `modifyThread(token, id, ["STARRED"], [])` leaves identical rows behind in
 * the mirror. So these tests drive the real functions against a
 * {@link FakeMailbox} and assert on what the mailbox was *asked*, alongside
 * what the mirror ended up holding.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const SELF = "owner@example.com";
const COUNTERPARTY = "ada@acme.test";
const THREAD_REF = "thread-remote-1";
const MESSAGE_REF = "message-remote-1";

type Fixture = {
  account: MailAccount;
  mailbox: FakeMailbox;
  /** What the seam handed the action functions. */
  dependencies: MailActionDependencies;
  /** One entry per realtime fan-out, so a test can count them. */
  broadcasts: string[];
};

async function fixture(): Promise<Fixture> {
  const mailbox = new FakeMailbox();
  const broadcasts: string[] = [];
  const account = await insert(MailAccount, {
    companyId: testCompanyId(),
    // No IntegrationConnection row is created on purpose: the seam is what
    // decides which mailbox answers, and a test that had to mint encrypted
    // Google credentials in order to star a thread would be exercising the
    // connection store rather than this file.
    connectionId: "connection_never_resolved",
    // An IMAP mailbox, because nothing below may behave differently for one.
    provider: "imap",
    address: SELF,
    status: "active",
  });
  return {
    account,
    mailbox,
    dependencies: {
      mailbox: async () => mailbox,
      notify: (notified) => broadcasts.push(notified.id),
    },
    broadcasts,
  };
}

/** Mirror one conversation locally and seed the same message upstream. */
async function conversation(
  account: MailAccount,
  mailbox: FakeMailbox,
  input: { threadRef: string; messageRef: string; labelIds?: string[] },
): Promise<MailThread> {
  const labelIds = input.labelIds ?? ["INBOX", "UNREAD"];
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: input.threadRef,
    subject: "Quarterly invoice",
    labelIds: labelIdsToColumn(labelIds),
    unread: labelIds.includes("UNREAD"),
    messageCount: 1,
  });
  await insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: input.messageRef,
    gmailThreadId: input.threadRef,
    fromName: "Ada Lovelace",
    fromEmail: COUNTERPARTY,
    toEmails: SELF,
    subject: "Quarterly invoice",
    snippet: "The invoice for Q3 is attached",
    labelIds: labelIdsToColumn(labelIds),
    sentAt: new Date("2026-08-20T09:00:00Z"),
  });
  mailbox.seed({ ref: input.messageRef, threadRef: input.threadRef, labelIds: [...labelIds] });
  return thread;
}

function messages(account: MailAccount): Promise<MailMessage[]> {
  return AppDataSource.getRepository(MailMessage).findBy({ accountId: account.id });
}

async function labelsOf(account: MailAccount, messageRef: string): Promise<string[]> {
  const row = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
    accountId: account.id,
    gmailMessageId: messageRef,
  });
  return columnToLabelIds(row.labelIds);
}

async function reload(thread: MailThread): Promise<MailThread> {
  return AppDataSource.getRepository(MailThread).findOneByOrFail({ id: thread.id });
}

// ───────────────────── the semantic action → mailbox call map ─────────────────────

/**
 * Each row is one promise `actions.ts` makes to the rest of the product. They
 * are listed rather than asserted in a lump so a regression names the action it
 * broke — "archive silently became two calls" is a different bug from "star
 * stopped reaching the mailbox at all".
 */
const MAPPINGS: Array<{ name: string; action: ThreadAction; expected: FakeMailboxCall }> = [
  {
    name: "markRead asks the mailbox to set read, rather than deleting a Gmail UNREAD label",
    action: "markRead",
    expected: { method: "setRead", args: [THREAD_REF, true] },
  },
  {
    name: "markUnread asks for the same call with the flag inverted, not a second endpoint",
    action: "markUnread",
    expected: { method: "setRead", args: [THREAD_REF, false] },
  },
  {
    name: "star asks the mailbox to flag the conversation, which IMAP answers with \\Flagged",
    action: "star",
    expected: { method: "setFlagged", args: [THREAD_REF, true] },
  },
  {
    name: "unstar asks the mailbox to unflag the conversation",
    action: "unstar",
    expected: { method: "setFlagged", args: [THREAD_REF, false] },
  },
  {
    name: "archive asks the mailbox to archive — 'remove the INBOX label' means nothing to IMAP",
    action: "archive",
    expected: { method: "archive", args: [THREAD_REF] },
  },
  {
    name: "moveToInbox asks the mailbox to move the conversation back to the inbox",
    action: "moveToInbox",
    expected: { method: "moveToInbox", args: [THREAD_REF] },
  },
  {
    name: "trash asks the mailbox to trash the conversation",
    action: "trash",
    expected: { method: "trash", args: [THREAD_REF] },
  },
  {
    name: "untrash asks the mailbox to restore the conversation",
    action: "untrash",
    expected: { method: "untrash", args: [THREAD_REF] },
  },
];

describe("performThreadAction — provider-neutral action mapping", () => {
  for (const { name, action, expected } of MAPPINGS) {
    test(name, async () => {
      const { account, mailbox, dependencies, broadcasts } = await fixture();
      const thread = await conversation(account, mailbox, {
        threadRef: THREAD_REF,
        messageRef: MESSAGE_REF,
      });

      await performThreadAction(account, thread, action, {}, dependencies);

      // The whole call list, not a containment check: one mutation and one
      // re-read is the contract. An adapter-shaped extra round trip per action
      // is exactly the sort of thing that only shows up as latency in
      // production, where every call is a network hop.
      assert.deepEqual(mailbox.calls, [
        expected,
        { method: "readThreadState", args: [THREAD_REF] },
      ]);
      assert.deepEqual(broadcasts, [account.id]);
    });
  }

  test("stays quiet when the caller asked for silence, so a bulk run controls its own fan-out", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
    });

    await performThreadAction(account, thread, "archive", { silent: true }, dependencies);

    assert.deepEqual(
      mailbox.calls.map((call) => call.method),
      ["archive", "readThreadState"],
    );
    assert.deepEqual(broadcasts, []);
  });
});

// ─────────────────────────────── labels ───────────────────────────────

describe("performThreadAction — labels", () => {
  test("creates a label upstream before applying a name the mailbox has never seen", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
    });

    await performThreadAction(
      account,
      thread,
      "applyLabel",
      { labelName: "Invoices" },
      dependencies,
    );

    // Order matters: the ref used to label the thread has to be the one the
    // mailbox just minted, so applying a brand-new AI category cannot go out
    // with a name where a handle belongs.
    assert.deepEqual(mailbox.calls, [
      { method: "createLabel", args: ["Invoices"] },
      { method: "applyLabel", args: [THREAD_REF, "label-invoices"] },
      { method: "readThreadState", args: [THREAD_REF] },
    ]);
    assert.deepEqual(await labelsOf(account, MESSAGE_REF), ["INBOX", "UNREAD", "label-invoices"]);
  });

  test("mirrors the newly created label as a MailLabel row so the taxonomy is browsable", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
    });

    await performThreadAction(
      account,
      thread,
      "applyLabel",
      { labelName: "Invoices" },
      dependencies,
    );

    const rows = await AppDataSource.getRepository(MailLabel).findBy({ accountId: account.id });
    assert.deepEqual(
      rows.map((row) => ({
        companyId: row.companyId,
        gmailLabelId: row.gmailLabelId,
        name: row.name,
        labelType: row.labelType,
      })),
      [
        {
          companyId: account.companyId,
          gmailLabelId: "label-invoices",
          name: "Invoices",
          labelType: "user",
        },
      ],
    );
  });

  test("reuses an existing label whose name differs only in case, instead of minting a duplicate", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
    });
    await performThreadAction(
      account,
      thread,
      "applyLabel",
      { labelName: "Invoices" },
      dependencies,
    );

    // An AI employee categorizing mail writes the name it thought of, and it
    // does not think of the same capitalisation twice running. Two labels that
    // read identically in the sidebar would split the category in half.
    await performThreadAction(
      account,
      thread,
      "applyLabel",
      { labelName: "invoices" },
      dependencies,
    );

    assert.deepEqual(
      mailbox.calls.filter((call) => call.method === "createLabel"),
      [{ method: "createLabel", args: ["Invoices"] }],
    );
    assert.equal(
      await AppDataSource.getRepository(MailLabel).countBy({ accountId: account.id }),
      1,
    );
  });

  test("refuses to remove a label the account has never had rather than creating one to remove", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
    });

    await assert.rejects(
      () =>
        performThreadAction(
          account,
          thread,
          "removeLabel",
          { labelName: "Invoices" },
          dependencies,
        ),
      /Label "Invoices" not found/,
    );

    // Nothing reached the server and nothing was mirrored, so a typo in a rule
    // cannot quietly populate the sidebar with labels nobody asked for.
    assert.deepEqual(mailbox.calls, []);
    assert.equal(
      await AppDataSource.getRepository(MailLabel).countBy({ accountId: account.id }),
      0,
    );
    assert.deepEqual(broadcasts, []);
  });
});

// ──────────────────────── mirror refresh after a mutation ────────────────────────

describe("performThreadAction — mirror refresh", () => {
  test("re-reads the conversation from the mailbox so the list stops showing it unread", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
      labelIds: ["INBOX", "UNREAD"],
    });

    await performThreadAction(account, thread, "markRead", {}, dependencies);

    // Without the refresh the row the user just clicked would keep its bold
    // styling until the next sync pass — the classic "it didn't work" report.
    assert.deepEqual(await labelsOf(account, MESSAGE_REF), ["INBOX"]);
    const rolled = await reload(thread);
    assert.equal(rolled.unread, false);
    assert.deepEqual(columnToLabelIds(rolled.labelIds), ["INBOX"]);
  });

  test("refreshes every message of the conversation, not just the one the list row showed", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const thread = await conversation(account, mailbox, {
      threadRef: THREAD_REF,
      messageRef: MESSAGE_REF,
      labelIds: ["INBOX"],
    });
    // A second reply on the same conversation. Archiving moves the whole
    // thread upstream, so a mirror that only updated the newest message would
    // leave the thread's label union claiming it is still in the inbox.
    await insert(MailMessage, {
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: "message-remote-2",
      gmailThreadId: THREAD_REF,
      fromName: "Ada Lovelace",
      fromEmail: COUNTERPARTY,
      toEmails: SELF,
      subject: "Re: Quarterly invoice",
      labelIds: labelIdsToColumn(["INBOX"]),
      sentAt: new Date("2026-08-21T09:00:00Z"),
    });
    mailbox.seed({ ref: "message-remote-2", threadRef: THREAD_REF, labelIds: ["INBOX"] });

    await performThreadAction(account, thread, "archive", {}, dependencies);

    assert.deepEqual(await labelsOf(account, MESSAGE_REF), []);
    assert.deepEqual(await labelsOf(account, "message-remote-2"), []);
    const rolled = await reload(thread);
    assert.deepEqual(columnToLabelIds(rolled.labelIds), []);
    assert.equal(rolled.messageCount, 2);
  });
});

// ───────────────────────────── bulk isolation ─────────────────────────────

describe("bulkThreadAction", () => {
  /** Three mirrored conversations, upstream and locally. */
  async function threeThreads(account: MailAccount, mailbox: FakeMailbox): Promise<MailThread[]> {
    const threads: MailThread[] = [];
    for (const n of [1, 2, 3]) {
      threads.push(
        await conversation(account, mailbox, {
          threadRef: `thread-${n}`,
          messageRef: `message-${n}`,
          labelIds: ["INBOX"],
        }),
      );
    }
    return threads;
  }

  test("isolates the one thread the mailbox rejects and archives the rest of the batch", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const threads = await threeThreads(account, mailbox);
    const archive = mailbox.archive.bind(mailbox);
    mailbox.archive = async (ref: string) => {
      if (ref === "thread-2") throw new Error("Mailbox is read-only right now");
      await archive(ref);
    };

    const result = await bulkThreadAction(account, threads, "archive", {}, dependencies);

    assert.deepEqual(result.succeeded, [threads[0].id, threads[2].id]);
    assert.deepEqual(result.skipped, [
      { id: threads[1].id, reason: "Mailbox is read-only right now" },
    ]);
    // The mirror has to agree with the report, or the user is told two threads
    // archived while the list still shows three in the inbox.
    assert.deepEqual(await labelsOf(account, "message-1"), []);
    assert.deepEqual(await labelsOf(account, "message-2"), ["INBOX"]);
    assert.deepEqual(await labelsOf(account, "message-3"), []);
  });

  test("broadcasts once for the whole batch rather than once per thread", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    const threads = await threeThreads(account, mailbox);
    const archive = mailbox.archive.bind(mailbox);
    mailbox.archive = async (ref: string) => {
      if (ref === "thread-2") throw new Error("Mailbox is read-only right now");
      await archive(ref);
    };

    await bulkThreadAction(account, threads, "archive", {}, dependencies);

    // Fifty threads selected in the UI must not make every connected client
    // refetch the mailbox fifty times — one failure in the middle included.
    assert.deepEqual(broadcasts, [account.id]);
  });

  test("says nothing at all when every thread in the batch failed", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    const threads = await threeThreads(account, mailbox);
    mailbox.archive = async () => {
      throw new Error("Mailbox is read-only right now");
    };

    const result = await bulkThreadAction(account, threads, "archive", {}, dependencies);

    assert.deepEqual(result.succeeded, []);
    assert.equal(result.skipped.length, 3);
    // Nothing changed, so telling clients to refetch would be pure noise.
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(await labelsOf(account, "message-2"), ["INBOX"]);
  });
});

// ─────────────────────────── the do-not-email gate ───────────────────────────

describe("the suppression gate on the send paths", () => {
  const BLOCKED = "churned@acme.test";

  test("mirrors a sent message through the mailbox when nobody is suppressed", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();

    const sent = await sendMailMessage(
      account,
      { to: COUNTERPARTY, subject: "Renewal", bodyText: "Sending the renewal over." },
      null,
      dependencies,
    );

    const [call] = mailbox.calls;
    assert.equal(call.method, "sendMessage");
    // `calls` is deliberately untyped, so the composed MIME needs naming here.
    const mime = call.args[0] as MimeFields;
    assert.equal(mime.to, COUNTERPARTY);
    assert.equal(mime.subject, "Renewal");
    assert.ok(columnHasLabel(sent.labelIds, "SENT"));
    assert.deepEqual(broadcasts, [account.id]);
  });

  test("refuses a fresh send to a suppressed address without asking the mailbox to send it", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    await addSuppression({
      companyId: account.companyId,
      email: BLOCKED,
      reason: "unsubscribe",
      source: "test",
    });

    await assert.rejects(
      () =>
        sendMailMessage(
          account,
          { to: BLOCKED, subject: "Renewal", bodyText: "Sending the renewal over." },
          null,
          dependencies,
        ),
      SuppressedRecipientError,
    );

    // The gate is worthless if it throws after the message has already left:
    // an unsubscribe honoured only in the audit log is still a complaint.
    assert.deepEqual(mailbox.calls, []);
    assert.deepEqual(await messages(account), []);
    assert.deepEqual(broadcasts, []);
  });

  test("re-runs the gate at send time, so someone who unsubscribed after the draft was written is still refused", async () => {
    const { account, mailbox, dependencies, broadcasts } = await fixture();
    const draft = await createMailDraft(
      account,
      { to: BLOCKED, subject: "Renewal", bodyText: "Sending the renewal over." },
      null,
      {},
      dependencies,
    );
    assert.equal(draft.gmailDraftId, "draft-msg-1");

    // Days apart in the product — a draft written on Monday, approved on
    // Thursday — and one line apart here. Inheriting the check from compose
    // time is what would make this send go out.
    await addSuppression({
      companyId: account.companyId,
      email: BLOCKED,
      reason: "unsubscribe",
      source: "test",
    });
    const mark = mailbox.calls.length;
    broadcasts.length = 0;

    await assert.rejects(
      () => sendMailDraft(account, draft, {}, dependencies),
      SuppressedRecipientError,
    );

    assert.deepEqual(mailbox.calls.slice(mark), []);
    // The draft survives on both sides, so the operator can edit the recipient
    // rather than rewrite a message the refusal silently destroyed.
    assert.equal(mailbox.drafts.size, 1);
    assert.ok(
      await AppDataSource.getRepository(MailMessage).findOneBy({ id: draft.id }),
      "the refused draft must still be in the mirror",
    );
    assert.deepEqual(broadcasts, []);
  });

  test("sends a draft whose recipients are still allowed and swaps the mirror row for the sent copy", async () => {
    const { account, mailbox, dependencies } = await fixture();
    const draft = await createMailDraft(
      account,
      { to: COUNTERPARTY, subject: "Renewal", bodyText: "Sending the renewal over." },
      null,
      {},
      dependencies,
    );
    const mark = mailbox.calls.length;

    const sent = await sendMailDraft(account, draft, {}, dependencies);

    assert.deepEqual(mailbox.calls.slice(mark), [{ method: "sendDraft", args: ["draft-msg-1"] }]);
    assert.ok(columnHasLabel(sent.labelIds, "SENT"));
    assert.equal(sent.gmailDraftId, "");
    assert.deepEqual(
      (await messages(account)).map((row) => row.gmailMessageId),
      ["msg-1-sent"],
    );
  });

  test("clears the draft handle when the sent copy reuses the draft's identity", async () => {
    // On IMAP the copy filed in Sent is the draft's own bytes, so it carries
    // the same Message-ID and upserts onto the draft's existing row rather
    // than a new one. Leaving `gmailDraftId` on it would keep a handle to a
    // message the server has expunged — and the Drafts queue, which asks only
    // for a non-empty handle, would show a message that has already gone out
    // and fail to re-send it forever.
    const { account, mailbox, dependencies } = await fixture();
    mailbox.sentIdentity = "same-as-draft";
    const draft = await createMailDraft(
      account,
      { to: COUNTERPARTY, subject: "Renewal", bodyText: "Sending the renewal over." },
      null,
      {},
      dependencies,
    );

    const sent = await sendMailDraft(account, draft, {}, dependencies);

    assert.equal(sent.id, draft.id, "the sent copy landed on the draft's own row");
    assert.equal(sent.gmailDraftId, "");
    assert.ok(columnHasLabel(sent.labelIds, "SENT"));
    assert.equal(
      await AppDataSource.getRepository(MailMessage).countBy({ accountId: account.id }),
      1,
      "one message, not a phantom draft beside the sent copy",
    );
  });
});
