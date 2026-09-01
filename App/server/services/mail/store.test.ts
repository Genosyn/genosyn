import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { FakeMailbox } from "../../test/fakeMailbox.js";
import type { GmailHeader, GmailMessage } from "./gmailClient.js";
import { encodeLocation } from "./imapModel.js";
import { toMailboxMessage } from "./mailbox/gmail.js";
import type { MailboxLabel, MailboxMessage } from "./mailbox/types.js";
import {
  columnHasLabel,
  columnToLabelIds,
  deleteMessageByGmailId,
  labelIdsToColumn,
  recomputeThread,
  refreshDraftIds,
  syncLabels,
  updateMessageLabels,
  upsertGmailMessage,
  upsertMailMessage,
} from "./store.js";

/**
 * The local mirror's write path.
 *
 * Everything here is provider-neutral by construction, so the fixtures are
 * normalized {@link MailboxMessage} values rather than Gmail or IMAP payloads.
 * The cases that earn their keep are the ones where a *partial* re-read of a
 * message meets a row that already holds the full thing: a header-only pass
 * must leave the imported mail alone, and a Gmail read must not erase the
 * folder address an IMAP row needs to fetch itself again.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_store_test";
const SELF = "owner@example.com";

let accountSeq = 0;

async function mailAccount(overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  accountSeq += 1;
  return insert(MailAccount, {
    companyId: COMPANY_ID,
    // The connectionId index is unique, so every account fixture needs its own.
    connectionId: `conn_mail_store_${accountSeq}`,
    address: SELF,
    ...overrides,
  });
}

function headers(fields: Record<string, string>): GmailHeader[] {
  return Object.entries(fields).map(([name, value]) => ({ name, value }));
}

/** A fully-imported message, as an adapter hands it over. */
function mailboxMessage(
  overrides: Partial<MailboxMessage> & { ref: string; threadRef: string },
): MailboxMessage {
  return {
    labelIds: ["INBOX", "UNREAD"],
    headers: headers({
      From: "Ada Lovelace <ada@acme.com>",
      To: `${SELF}, Bob <bob@acme.com>`,
      Cc: "Finance <finance@acme.com>",
      Bcc: "audit@acme.com",
      Subject: "August invoice",
      "Message-ID": `<${overrides.ref}@acme.com>`,
      References: "<root@acme.com> <second@acme.com>",
      "In-Reply-To": "<second@acme.com>",
    }),
    snippet: "The August invoice is attached.",
    bodyText: "The August invoice is attached.",
    bodyHtml: "<p>The August invoice is attached.</p>",
    attachments: [
      {
        partId: "1.2",
        attachmentId: "att-august",
        filename: "logo.png",
        mimeType: "image/png",
        size: 2048,
      },
    ],
    sentAt: new Date("2026-08-14T09:30:00Z"),
    sizeEstimate: 4096,
    hasBodies: true,
    location: "",
    ...overrides,
  };
}

/** A header-only re-read: the shape an adapter produces with `hasBodies: false`. */
function degradedRead(
  overrides: Partial<MailboxMessage> & { ref: string; threadRef: string },
): MailboxMessage {
  return mailboxMessage({
    bodyText: "",
    bodyHtml: "",
    attachments: [],
    hasBodies: false,
    ...overrides,
  });
}

function messages(): ReturnType<typeof AppDataSource.getRepository<MailMessage>> {
  return AppDataSource.getRepository(MailMessage);
}

function threads(): ReturnType<typeof AppDataSource.getRepository<MailThread>> {
  return AppDataSource.getRepository(MailThread);
}

function reread(id: string): Promise<MailMessage> {
  return messages().findOneByOrFail({ id });
}

// ───────────────────────── upsertMailMessage ─────────────────────────

describe("upsertMailMessage", () => {
  test("creates the thread shell the first time a conversation is seen", async () => {
    const account = await mailAccount();
    const { row, created } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    assert.equal(created, true);
    const thread = await threads().findOneByOrFail({ accountId: account.id, gmailThreadId: "t-1" });
    assert.equal(row.threadId, thread.id);
    assert.equal(thread.companyId, COMPANY_ID);
    assert.equal(row.gmailThreadId, "t-1");
  });

  test("re-syncing the same message updates its row instead of mirroring it twice", async () => {
    // Every sync pass re-reads messages it has already seen; a second row for
    // one message would double it in the thread list and in every rule.
    const account = await mailAccount();
    const first = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );
    const second = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", labelIds: ["INBOX"], snippet: "Paid." }),
    );

    assert.equal(second.created, false);
    assert.equal(second.row.id, first.row.id);
    assert.equal(await messages().countBy({ accountId: account.id }), 1);
    assert.equal(await threads().countBy({ accountId: account.id }), 1);
    const stored = await reread(first.row.id);
    assert.equal(stored.labelIds, " INBOX ");
    assert.equal(stored.snippet, "Paid.");
  });

  test("copies the addressing and threading headers out of the normalized set", async () => {
    // Reply-all, quoting and conversation grouping all read these columns, so
    // a header dropped here becomes a reply that goes to the wrong people.
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    const stored = await reread(row.id);
    assert.equal(stored.fromName, "Ada Lovelace");
    assert.equal(stored.fromEmail, "ada@acme.com");
    assert.equal(stored.toEmails, `${SELF}, Bob <bob@acme.com>`);
    assert.equal(stored.ccEmails, "Finance <finance@acme.com>");
    assert.equal(stored.bccEmails, "audit@acme.com");
    assert.equal(stored.subject, "August invoice");
    assert.equal(stored.messageIdHeader, "<m-1@acme.com>");
    assert.equal(stored.referencesHeader, "<root@acme.com> <second@acme.com>");
    assert.equal(stored.inReplyToHeader, "<second@acme.com>");
  });

  test("stores the sort key, the size and the snippet the list row renders", async () => {
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    const stored = await reread(row.id);
    assert.deepEqual(stored.sentAt, new Date("2026-08-14T09:30:00Z"));
    assert.equal(stored.sizeEstimate, 4096);
    assert.equal(stored.snippet, "The August invoice is attached.");
    assert.equal(stored.bodyText, "The August invoice is attached.");
    assert.equal(stored.bodyHtml, "<p>The August invoice is attached.</p>");
    assert.deepEqual(JSON.parse(stored.attachmentsJson), [
      {
        partId: "1.2",
        attachmentId: "att-august",
        filename: "logo.png",
        mimeType: "image/png",
        size: 2048,
      },
    ]);
  });

  test("a message with no sentAt is mirrored with a null sort key, not a bogus date", async () => {
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", sentAt: null }),
    );

    assert.equal((await reread(row.id)).sentAt, null);
  });
});

// ───────────────────────── preserveRichContent ─────────────────────────

describe("upsertMailMessage preserveRichContent", () => {
  test("a degraded re-read must not destroy a fully imported message", async () => {
    // A Gmail metadata fallback after a timeout, or an IMAP header-only pass,
    // carries no bodies at all. Writing it through would blank mail that was
    // imported in full an hour ago — the loss is silent and unrecoverable
    // until the next full re-read, which may never come.
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    await upsertMailMessage(
      account,
      degradedRead({ ref: "m-1", threadRef: "t-1", labelIds: ["INBOX"], snippet: "" }),
      { preserveRichContent: true },
    );

    const stored = await reread(row.id);
    assert.equal(stored.bodyText, "The August invoice is attached.");
    assert.equal(stored.bodyHtml, "<p>The August invoice is attached.</p>");
    assert.equal(JSON.parse(stored.attachmentsJson).length, 1);
    // The flags the degraded pass *did* carry still land, which is the whole
    // point of running it.
    assert.equal(stored.labelIds, " INBOX ");
  });

  test("a message that reports no bodies is preserved even without the flag", async () => {
    // Belt and braces on the same invariant. A caller that forgets the flag
    // would otherwise blank every body it touched, silently, and the loss
    // would not surface until a full re-read that may never come.
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    await upsertMailMessage(account, degradedRead({ ref: "m-1", threadRef: "t-1" }));

    const stored = await reread(row.id);
    assert.equal(stored.bodyText, "The August invoice is attached.");
    assert.equal(JSON.parse(stored.attachmentsJson).length, 1);
  });

  test("a complete re-read may still blank a body, because that is the truth", async () => {
    // A message whose body the sender actually deleted, or a draft cleared in
    // another client, has to be able to become empty here.
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    await upsertMailMessage(
      account,
      mailboxMessage({
        ref: "m-1",
        threadRef: "t-1",
        bodyText: "",
        bodyHtml: "",
        attachments: [],
        hasBodies: true,
      }),
    );

    const stored = await reread(row.id);
    assert.equal(stored.bodyText, "");
    assert.equal(stored.attachmentsJson, "[]");
  });

  test("a newly created row still gets its bodies written under the flag", async () => {
    // There is nothing to preserve on first sight, so skipping the write would
    // mirror a permanently empty message.
    const account = await mailAccount();
    const { row, created } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
      { preserveRichContent: true },
    );

    assert.equal(created, true);
    const stored = await reread(row.id);
    assert.equal(stored.bodyText, "The August invoice is attached.");
    assert.equal(stored.bodyHtml, "<p>The August invoice is attached.</p>");
    assert.equal(JSON.parse(stored.attachmentsJson).length, 1);
  });
});

// ───────────────────────── providerLocation ─────────────────────────

describe("upsertMailMessage location", () => {
  const INBOX_LOCATION = encodeLocation({ folder: "INBOX", uidValidity: "1755123", uid: 8412 });
  const ARCHIVE_LOCATION = encodeLocation({ folder: "Archive", uidValidity: "9921", uid: 17 });

  test("records where an IMAP message currently sits so it can be fetched again", async () => {
    const account = await mailAccount({ provider: "imap" });
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", location: INBOX_LOCATION }),
    );

    assert.equal((await reread(row.id)).providerLocation, INBOX_LOCATION);
  });

  test("a move upstream replaces the recorded address", async () => {
    // An IMAP message gets a brand new UID every time it changes folder, so a
    // stale location addresses either nothing or somebody else's mail.
    const account = await mailAccount({ provider: "imap" });
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", location: INBOX_LOCATION }),
    );

    await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", location: ARCHIVE_LOCATION }),
    );

    assert.equal((await reread(row.id)).providerLocation, ARCHIVE_LOCATION);
  });

  test("a provider with no location of its own must not clear one already stored", async () => {
    // Gmail always sends an empty location because its message id is address
    // enough. Writing that through would strip the folder/UID an IMAP row
    // depends on — and the mirror would then be unable to fetch the message.
    const account = await mailAccount({ provider: "imap" });
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", location: INBOX_LOCATION }),
    );

    await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1", location: "" }),
    );

    assert.equal((await reread(row.id)).providerLocation, INBOX_LOCATION);
  });
});

// ───────────────────────── upsertGmailMessage ─────────────────────────

describe("upsertGmailMessage", () => {
  function gmailMessage(): GmailMessage {
    return {
      id: "gm-1",
      threadId: "gt-1",
      labelIds: ["INBOX", "IMPORTANT"],
      snippet: "Ada &amp; Charles asked about the invoice",
      internalDate: "1786613400000",
      sizeEstimate: 5120,
      payload: {
        mimeType: "text/plain",
        headers: headers({
          From: "Ada Lovelace <ada@acme.com>",
          To: SELF,
          Subject: "August invoice",
          "Message-ID": "<gm-1@acme.com>",
        }),
        body: { data: Buffer.from("Body from Gmail").toString("base64url") },
      },
    };
  }

  /** The columns that must not depend on which call site did the upsert. */
  function mirrored(row: MailMessage) {
    return {
      gmailMessageId: row.gmailMessageId,
      gmailThreadId: row.gmailThreadId,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      toEmails: row.toEmails,
      subject: row.subject,
      snippet: row.snippet,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      labelIds: row.labelIds,
      sentAt: row.sentAt,
      attachmentsJson: row.attachmentsJson,
      sizeEstimate: row.sizeEstimate,
      messageIdHeader: row.messageIdHeader,
      providerLocation: row.providerLocation,
    };
  }

  test("decodes the Gmail payload into the same columns as the normalized path", async () => {
    // The Gmail engine still deals in GmailMessage end to end; this wrapper is
    // the only thing keeping it from drifting away from the shared write path.
    const gmailAccount = await mailAccount();
    const neutralAccount = await mailAccount();
    const gm = gmailMessage();

    const viaGmail = await upsertGmailMessage(gmailAccount, gm);
    const viaMailbox = await upsertMailMessage(neutralAccount, toMailboxMessage(gm));

    assert.deepEqual(
      mirrored(await reread(viaGmail.row.id)),
      mirrored(await reread(viaMailbox.row.id)),
    );
  });

  test("stores the decoded body, the un-escaped snippet and internalDate as sentAt", async () => {
    const account = await mailAccount();
    const { row } = await upsertGmailMessage(account, gmailMessage());

    const stored = await reread(row.id);
    assert.equal(stored.bodyText, "Body from Gmail");
    assert.equal(stored.snippet, "Ada & Charles asked about the invoice");
    assert.deepEqual(stored.sentAt, new Date(1786613400000));
    assert.equal(stored.labelIds, " INBOX IMPORTANT ");
    assert.equal(stored.sizeEstimate, 5120);
    // Gmail message ids never move, so there is no second address to keep.
    assert.equal(stored.providerLocation, "");
  });
});

// ───────────────────────── label-string encoding ─────────────────────────

describe("label column encoding", () => {
  test("wraps the ids in sentinel spaces so LIKE can answer membership", () => {
    // The mirror has no join tables; `LIKE '% INBOX %'` is how both sqlite and
    // postgres answer "threads in this folder", and it needs the outer spaces.
    assert.equal(labelIdsToColumn(["INBOX", "UNREAD"]), " INBOX UNREAD ");
  });

  test("round-trips a label set through the column", () => {
    const ids = ["INBOX", "UNREAD", "Label_42"];
    assert.deepEqual(columnToLabelIds(labelIdsToColumn(ids)), ids);
  });

  test("an empty set encodes to the empty string, not a lone sentinel space", () => {
    // " " would make every `LIKE '% X %'` probe on an unlabelled row read
    // oddly and would leave a space where the UI expects nothing at all.
    assert.equal(labelIdsToColumn([]), "");
    assert.deepEqual(columnToLabelIds(""), []);
    assert.equal(columnHasLabel("", "INBOX"), false);
  });

  test("drops blank ids rather than encoding a double space", () => {
    // A double space would break the `LIKE '% X %'` probe for its neighbours.
    assert.equal(labelIdsToColumn([" INBOX ", "", "   ", "UNREAD"]), " INBOX UNREAD ");
  });

  test("membership is exact — a label that merely contains another does not match", () => {
    // Without the sentinels, an account with a "INBOX-ARCHIVE" label would
    // have every one of its threads show up in the Inbox.
    const column = labelIdsToColumn(["INBOX-ARCHIVE", "UNREADABLE"]);
    assert.equal(columnHasLabel(column, "INBOX"), false);
    assert.equal(columnHasLabel(column, "UNREAD"), false);
    assert.equal(columnHasLabel(column, "INBOX-ARCHIVE"), true);
    assert.equal(columnHasLabel(column, "UNREADABLE"), true);
  });
});

// ───────────────────────── syncLabels ─────────────────────────

describe("syncLabels", () => {
  const labels = (): ReturnType<typeof AppDataSource.getRepository<MailLabel>> =>
    AppDataSource.getRepository(MailLabel);

  const catalog: MailboxLabel[] = [
    { ref: "INBOX", name: "Inbox", labelType: "system", color: "" },
    { ref: "Label_7", name: "Invoices", labelType: "user", color: "#fb4c2f" },
  ];

  test("mirrors the catalog the mailbox reports", async () => {
    const account = await mailAccount();
    await syncLabels(account, catalog);

    const stored = await labels().find({
      where: { accountId: account.id },
      order: { name: "ASC" },
    });
    assert.deepEqual(
      stored.map((l) => [l.gmailLabelId, l.name, l.labelType, l.color]),
      [
        ["INBOX", "Inbox", "system", ""],
        ["Label_7", "Invoices", "user", "#fb4c2f"],
      ],
    );
  });

  test("a renamed label keeps its row rather than being replaced", async () => {
    // Messages reference the label by its upstream ref, so a delete-and-insert
    // would churn a row id for a change the user only sees as a new name.
    const account = await mailAccount();
    await syncLabels(account, catalog);
    const before = await labels().findOneByOrFail({
      accountId: account.id,
      gmailLabelId: "Label_7",
    });

    await syncLabels(account, [
      catalog[0],
      { ref: "Label_7", name: "Billing", labelType: "user", color: "#16a765" },
    ]);

    const after = await labels().findOneByOrFail({
      accountId: account.id,
      gmailLabelId: "Label_7",
    });
    assert.equal(after.id, before.id);
    assert.equal(after.name, "Billing");
    assert.equal(after.color, "#16a765");
    assert.equal(await labels().countBy({ accountId: account.id }), 2);
  });

  test("deletes a label the user removed upstream", async () => {
    // A label that lingers after being deleted leaves a sidebar entry that
    // shows nothing and cannot be got rid of from inside Genosyn.
    const account = await mailAccount();
    await syncLabels(account, catalog);

    await syncLabels(account, [catalog[0]]);

    const remaining = await labels().findBy({ accountId: account.id });
    assert.deepEqual(
      remaining.map((l) => l.gmailLabelId),
      ["INBOX"],
    );
  });

  test("only touches the account being synced", async () => {
    // One company can hold several mailboxes, and they share the label table.
    const account = await mailAccount();
    const other = await mailAccount({ address: "second@example.com" });
    await syncLabels(account, catalog);
    await syncLabels(other, catalog);

    await syncLabels(account, []);

    assert.equal(await labels().countBy({ accountId: account.id }), 0);
    assert.equal(await labels().countBy({ accountId: other.id }), 2);
  });
});

// ───────────────────────── recomputeThread ─────────────────────────

describe("recomputeThread", () => {
  async function seedThread(
    account: MailAccount,
    parts: Array<Partial<MailboxMessage> & { ref: string }>,
  ): Promise<void> {
    for (const part of parts) {
      await upsertMailMessage(account, mailboxMessage({ threadRef: "t-1", ...part }));
    }
  }

  test("rolls the member messages' labels up into a union", async () => {
    // The thread list filters on the thread row alone, so a label carried by
    // only one message still has to make its conversation findable.
    const account = await mailAccount();
    await seedThread(account, [
      { ref: "m-1", labelIds: ["INBOX", "UNREAD"] },
      { ref: "m-2", labelIds: ["INBOX", "STARRED"], sentAt: new Date("2026-08-15T09:00:00Z") },
    ]);

    const thread = await recomputeThread(account, "t-1");

    assert.deepEqual(columnToLabelIds(thread?.labelIds ?? "").sort(), [
      "INBOX",
      "STARRED",
      "UNREAD",
    ]);
  });

  test("an unread draft alone does not make the conversation unread", async () => {
    // Your own half-written reply is not new mail; marking the thread unread
    // would put a bold row in the list that nothing can clear.
    const account = await mailAccount();
    await seedThread(account, [
      { ref: "m-1", labelIds: ["INBOX"] },
      {
        ref: "m-2",
        labelIds: ["DRAFT", "UNREAD"],
        sentAt: new Date("2026-08-15T09:00:00Z"),
      },
    ]);

    assert.equal((await recomputeThread(account, "t-1"))?.unread, false);
  });

  test("an unread message that is not a draft does make it unread", async () => {
    const account = await mailAccount();
    await seedThread(account, [
      { ref: "m-1", labelIds: ["INBOX", "UNREAD"] },
      {
        ref: "m-2",
        labelIds: ["DRAFT"],
        sentAt: new Date("2026-08-15T09:00:00Z"),
      },
    ]);

    assert.equal((await recomputeThread(account, "t-1"))?.unread, true);
  });

  test("counts the real messages and leaves drafts out of the tally", async () => {
    // "3 messages" on a two-message conversation you happen to be replying to
    // is wrong on its face.
    const account = await mailAccount();
    await seedThread(account, [
      { ref: "m-1", labelIds: ["INBOX"] },
      { ref: "m-2", labelIds: ["SENT"], sentAt: new Date("2026-08-15T09:00:00Z") },
      { ref: "m-3", labelIds: ["DRAFT"], sentAt: new Date("2026-08-16T09:00:00Z") },
    ]);

    assert.equal((await recomputeThread(account, "t-1"))?.messageCount, 2);
  });

  test("titles the thread from the oldest message and previews the newest", async () => {
    // The subject people recognise is the one the conversation started with,
    // while the preview line and the sort key have to track the latest reply.
    const account = await mailAccount();
    await seedThread(account, [
      {
        ref: "m-1",
        headers: headers({ From: "Ada <ada@acme.com>", Subject: "August invoice" }),
        snippet: "Here is the invoice.",
        sentAt: new Date("2026-08-14T09:30:00Z"),
      },
      {
        ref: "m-2",
        headers: headers({ From: "Ada <ada@acme.com>", Subject: "Re: August invoice" }),
        snippet: "Paid, thanks.",
        sentAt: new Date("2026-08-15T11:00:00Z"),
      },
    ]);

    const thread = await recomputeThread(account, "t-1");

    assert.equal(thread?.subject, "August invoice");
    assert.equal(thread?.snippet, "Paid, thanks.");
    assert.deepEqual(thread?.lastMessageAt, new Date("2026-08-15T11:00:00Z"));
  });

  test("flags the conversation when any one message carried an attachment", async () => {
    const account = await mailAccount();
    await seedThread(account, [
      { ref: "m-1", attachments: [] },
      { ref: "m-2", sentAt: new Date("2026-08-15T09:00:00Z") },
    ]);

    assert.equal((await recomputeThread(account, "t-1"))?.hasAttachments, true);
  });

  test("deletes the thread row once its last message is gone", async () => {
    // A thread whose messages were all deleted upstream would otherwise sit in
    // the list forever and open onto nothing.
    const account = await mailAccount();
    await seedThread(account, [{ ref: "m-1" }]);
    assert.ok(await recomputeThread(account, "t-1"));

    await deleteMessageByGmailId(account, "m-1");

    assert.equal(await recomputeThread(account, "t-1"), null);
    assert.equal(await threads().countBy({ accountId: account.id, gmailThreadId: "t-1" }), 0);
  });

  test("returns null for a conversation this account never mirrored", async () => {
    const account = await mailAccount();
    assert.equal(await recomputeThread(account, "t-unknown"), null);
  });
});

// ───────────────────────── refreshDraftIds ─────────────────────────

describe("refreshDraftIds", () => {
  async function draftRow(account: MailAccount, ref: string, gmailDraftId = ""): Promise<string> {
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref, threadRef: `t-${ref}`, labelIds: ["DRAFT"] }),
    );
    if (gmailDraftId) {
      row.gmailDraftId = gmailDraftId;
      await messages().save(row);
    }
    return row.id;
  }

  test("maps the mailbox's draft handles onto the mirrored messages", async () => {
    // Editing, sending or discarding a draft all need the handle, which lives
    // in a different namespace from the message's on both providers.
    const account = await mailAccount();
    const id = await draftRow(account, "m-1");
    const mailbox = new FakeMailbox();
    mailbox.drafts.set("draft-9", "m-1");

    await refreshDraftIds(account, mailbox);

    assert.equal((await reread(id)).gmailDraftId, "draft-9");
  });

  test("clears the handle on a row whose draft disappeared upstream", async () => {
    // Sending or discarding the draft in Gmail's own UI leaves our row holding
    // a handle that now resolves to nothing; keeping it makes the Drafts queue
    // offer a Send button that can only fail.
    const account = await mailAccount();
    const gone = await draftRow(account, "m-1", "draft-gone");
    const kept = await draftRow(account, "m-2", "draft-kept");
    const mailbox = new FakeMailbox();
    mailbox.drafts.set("draft-kept", "m-2");

    await refreshDraftIds(account, mailbox);

    assert.equal((await reread(gone)).gmailDraftId, "");
    assert.equal((await reread(kept)).gmailDraftId, "draft-kept");
  });

  test("a mailbox that stopped being writable mid-pass rewrites nothing", async () => {
    // The guard runs before the first save so a mailbox paused or disconnected
    // while the listing was in flight cannot have its handles rewritten from a
    // listing that is already stale.
    const account = await mailAccount();
    const id = await draftRow(account, "m-1", "draft-existing");
    const mailbox = new FakeMailbox();

    await assert.rejects(
      refreshDraftIds(account, mailbox, () => {
        throw new Error("Mail sync is paused for this account");
      }),
      /paused/,
    );

    assert.equal((await reread(id)).gmailDraftId, "draft-existing");
    assert.deepEqual(
      mailbox.calls.map((c) => c.method),
      ["listDraftRefs"],
    );
  });
});

// ───────────────── updateMessageLabels / deleteMessageByGmailId ─────────────────

describe("updateMessageLabels", () => {
  test("rewrites the label column of an already-mirrored message", async () => {
    // A history record saying "UNREAD was removed" is enough to update the
    // mirror; re-fetching the body for it would cost a request per read mail.
    const account = await mailAccount();
    const { row } = await upsertMailMessage(
      account,
      mailboxMessage({ ref: "m-1", threadRef: "t-1" }),
    );

    const updated = await updateMessageLabels(account, "m-1", ["INBOX", "STARRED"]);

    assert.equal(updated?.id, row.id);
    assert.equal((await reread(row.id)).labelIds, " INBOX STARRED ");
  });

  test("returns null for a message this account never mirrored", async () => {
    // Label history can name a message the backfill has not reached yet, and
    // that is not an error worth failing a sync pass over.
    const account = await mailAccount();
    assert.equal(await updateMessageLabels(account, "m-unknown", ["INBOX"]), null);
  });
});

describe("deleteMessageByGmailId", () => {
  test("returns the conversation the deleted message belonged to", async () => {
    // The caller needs the thread ref to recompute — or drop — the rollup, and
    // after the delete there is no row left to read it from.
    const account = await mailAccount();
    await upsertMailMessage(account, mailboxMessage({ ref: "m-1", threadRef: "t-1" }));

    assert.equal(await deleteMessageByGmailId(account, "m-1"), "t-1");
    assert.equal(await messages().countBy({ accountId: account.id, gmailMessageId: "m-1" }), 0);
  });

  test("returns null for an id we never mirrored", async () => {
    // Gmail history replays deletions we may never have seen the message for.
    const account = await mailAccount();
    assert.equal(await deleteMessageByGmailId(account, "m-unknown"), null);
  });

  test("does not reach into another account's mirror", async () => {
    // The lookup is scoped by account; deleting one mailbox's copy of a
    // message must leave the other mailbox's copy alone.
    const account = await mailAccount();
    const other = await mailAccount({ address: "second@example.com" });
    await upsertMailMessage(account, mailboxMessage({ ref: "m-1", threadRef: "t-1" }));

    assert.equal(await deleteMessageByGmailId(other, "m-1"), null);
    assert.equal(await messages().countBy({ accountId: account.id, gmailMessageId: "m-1" }), 1);
  });
});
