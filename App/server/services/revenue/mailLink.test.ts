import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { Suppression } from "../../db/entities/Suppression.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import {
  counterpartyAddresses,
  detectBounces,
  extractFailedRecipients,
  handleInboundForSequences,
  isBounceSender,
  linkAccountMessagesSafely,
  linkAccountMessagesSince,
  linkMessagesToContacts,
  messageDirection,
} from "./mailLink.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_mail_link";
const OTHER_CO = "co_someone_else";
const MAILBOX = "me@genosyn.test";
const ACCOUNT = { id: "acct_1", companyId: CO, address: MAILBOX };

let seq = 0;

/** A mirrored inbound message; override only what the case is about. */
function draftMessage(over: Partial<MailMessage> = {}): Partial<MailMessage> {
  seq += 1;
  return {
    companyId: CO,
    accountId: ACCOUNT.id,
    threadId: `thr_${seq}`,
    gmailMessageId: `gm_${seq}`,
    gmailThreadId: `gt_${seq}`,
    fromEmail: "ada@acme.test",
    toEmails: MAILBOX,
    ccEmails: "",
    bccEmails: "",
    subject: `Subject ${seq}`,
    snippet: "the short version",
    bodyText: "the long version",
    labelIds: " INBOX ",
    sentAt: new Date("2026-07-01T10:00:00.000Z"),
    ...over,
  };
}

async function message(over: Partial<MailMessage> = {}): Promise<MailMessage> {
  return insert(MailMessage, draftMessage(over));
}

async function contact(email: string, over: Partial<Contact> = {}): Promise<Contact> {
  return insert(Contact, { companyId: CO, name: email, email, ...over });
}

async function activities(companyId = CO): Promise<Activity[]> {
  return AppDataSource.getRepository(Activity).find({
    where: { companyId },
    order: { occurredAt: "ASC" },
  });
}

async function contactCount(companyId = CO): Promise<number> {
  return AppDataSource.getRepository(Contact).countBy({ companyId });
}

async function enrollment(
  over: Partial<SequenceEnrollment> = {},
): Promise<SequenceEnrollment> {
  return insert(SequenceEnrollment, {
    companyId: CO,
    sequenceId: `seq_${(seq += 1)}`,
    contactId: `c_${seq}`,
    status: "active",
    currentStepOrder: 1,
    nextRunAt: new Date("2026-07-05T09:00:00.000Z"),
    ...over,
  });
}

/** An RFC 3464 delivery report, trimmed to the parts we read. */
const DSN_BODY = [
  "This is the mail system at host mx.acme.test.",
  "",
  "I'm sorry to have to inform you that your message could not be delivered.",
  "",
  "Reporting-MTA: dns; mx.acme.test",
  "Final-Recipient: rfc822; grace@acme.test",
  "Action: failed",
  "Status: 5.1.1",
].join("\n");

// ───────────────────────────── messageDirection ─────────────────────────────

describe("messageDirection", () => {
  test("a message from the mailbox itself is outbound", () => {
    assert.equal(messageDirection({ fromEmail: MAILBOX }, MAILBOX), "outbound");
  });

  test("ignores case and a display name on either side", () => {
    assert.equal(
      messageDirection({ fromEmail: "Me <ME@Genosyn.TEST>" }, ` ${MAILBOX} `),
      "outbound",
    );
  });

  test("anyone else is inbound", () => {
    assert.equal(messageDirection({ fromEmail: "ada@acme.test" }, MAILBOX), "inbound");
  });

  test("an unreadable mailbox address falls back to inbound", () => {
    // Without knowing who "we" are we cannot claim authorship; calling our own
    // mail theirs is the cheaper mistake.
    assert.equal(messageDirection({ fromEmail: MAILBOX }, "not an address"), "inbound");
    assert.equal(messageDirection({ fromEmail: MAILBOX }, ""), "inbound");
  });

  test("an unreadable From is inbound rather than a match on empty", () => {
    assert.equal(messageDirection({ fromEmail: "" }, MAILBOX), "inbound");
  });
});

// ─────────────────────────── counterpartyAddresses ───────────────────────────

describe("counterpartyAddresses", () => {
  const outbound = (over: Record<string, string> = {}) => ({
    fromEmail: MAILBOX,
    toEmails: "ada@acme.test",
    ccEmails: "",
    ...over,
  });

  test("outbound collects To and Cc", () => {
    assert.deepEqual(
      counterpartyAddresses(
        outbound({ toEmails: "Ada <ada@acme.test>, bob@acme.test", ccEmails: "cy@acme.test" }),
        MAILBOX,
      ),
      ["ada@acme.test", "bob@acme.test", "cy@acme.test"],
    );
  });

  test("outbound drops the mailbox's own address from its recipients", () => {
    assert.deepEqual(
      counterpartyAddresses(outbound({ toEmails: `ada@acme.test, ${MAILBOX}` }), MAILBOX),
      ["ada@acme.test"],
    );
  });

  test("de-duplicates somebody who is in both To and Cc", () => {
    assert.deepEqual(
      counterpartyAddresses(
        outbound({ toEmails: "ada@acme.test", ccEmails: "ADA@acme.test" }),
        MAILBOX,
      ),
      ["ada@acme.test"],
    );
  });

  test("inbound is the sender only — other recipients are not our correspondents", () => {
    assert.deepEqual(
      counterpartyAddresses(
        { fromEmail: "ada@acme.test", toEmails: `${MAILBOX}, bob@acme.test`, ccEmails: "cy@acme.test" },
        MAILBOX,
      ),
      ["ada@acme.test"],
    );
  });

  test("a note to self yields nobody", () => {
    assert.deepEqual(
      counterpartyAddresses({ fromEmail: MAILBOX, toEmails: MAILBOX, ccEmails: "" }, MAILBOX),
      [],
    );
  });

  test("unparseable recipients are skipped rather than guessed at", () => {
    assert.deepEqual(
      counterpartyAddresses(outbound({ toEmails: "ada@acme.test, undisclosed-recipients:;" }), MAILBOX),
      ["ada@acme.test"],
    );
  });
});

// ───────────────────────── linkMessagesToContacts ─────────────────────────

describe("linkMessagesToContacts", () => {
  test("an inbound message from a known contact becomes an email_in activity", async () => {
    const ada = await contact("ada@acme.test");
    const msg = await message();

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 1, activities: 1 });
    const rows = await activities();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "email_in");
    assert.equal(rows[0].contactId, ada.id);
    assert.equal(rows[0].subject, msg.subject);
  });

  test("an outbound message to a known contact becomes an email_out activity", async () => {
    const ada = await contact("ada@acme.test");
    const msg = await message({
      fromEmail: MAILBOX,
      toEmails: "Ada <ada@acme.test>",
      labelIds: " SENT ",
    });

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 1, activities: 1 });
    const rows = await activities();
    assert.equal(rows[0].kind, "email_out");
    assert.equal(rows[0].contactId, ada.id);
  });

  test("a Cc'd contact is linked too", async () => {
    const cy = await contact("cy@acme.test");
    const msg = await message({
      fromEmail: MAILBOX,
      toEmails: "stranger@nowhere.test",
      ccEmails: "cy@acme.test",
    });

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    const rows = await activities();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contactId, cy.id);
  });

  test("a stranger is NOT turned into a contact", async () => {
    // The whole point: a mailbox is mostly newsletters, vendors and receipts.
    // Auto-creating a row for each would destroy the list's usefulness.
    const msg = await message({ fromEmail: "newsletter@bigcorp.test" });

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 0, activities: 0 });
    assert.equal(await contactCount(), 0);
    assert.deepEqual(await activities(), []);
  });

  test("a message mixing a known contact and strangers links only the contact", async () => {
    const ada = await contact("ada@acme.test");
    const msg = await message({
      fromEmail: MAILBOX,
      toEmails: "ada@acme.test, stranger@nowhere.test",
      ccEmails: "another@nowhere.test",
    });

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 1, activities: 1 });
    assert.equal(await contactCount(), 1);
    assert.equal((await activities())[0].contactId, ada.id);
  });

  test("one message to two known contacts writes one activity per timeline", async () => {
    const ada = await contact("ada@acme.test");
    const bob = await contact("bob@acme.test");
    const msg = await message({
      fromEmail: MAILBOX,
      toEmails: "ada@acme.test, bob@acme.test",
    });

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 1, activities: 2 });
    const owners = (await activities()).map((a) => a.contactId).sort();
    assert.deepEqual(owners, [ada.id, bob.id].sort());
  });

  test("one contact holding two addresses on the thread is written once", async () => {
    const ada = await contact("ada@acme.test");
    // Same person Cc'd under the address we hold, plus To under it as well.
    const msg = await message({
      fromEmail: MAILBOX,
      toEmails: "ada@acme.test",
      ccEmails: "Ada Lovelace <ADA@ACME.TEST>",
    });

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 1, activities: 1 });
    assert.equal((await activities())[0].contactId, ada.id);
  });

  test("re-syncing the same messages writes nothing new", async () => {
    await contact("ada@acme.test");
    const msg = await message();

    const first = await linkMessagesToContacts(CO, [msg], MAILBOX);
    const second = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.equal(first.activities, 1);
    assert.equal(second.activities, 0);
    assert.equal((await activities()).length, 1);
  });

  test("idempotency survives a re-sync that also carries a brand new message", async () => {
    await contact("ada@acme.test");
    const first = await message();
    await linkMessagesToContacts(CO, [first], MAILBOX);

    const second = await message({ subject: "Follow up" });
    const result = await linkMessagesToContacts(CO, [first, second], MAILBOX);

    assert.deepEqual(result, { linked: 2, activities: 1 });
    assert.equal((await activities()).length, 2);
  });

  test("occurredAt comes from sentAt, not from when we learned about it", async () => {
    await contact("ada@acme.test");
    const sentAt = new Date("2024-02-03T04:05:06.000Z");
    const msg = await message({ sentAt });

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.equal((await activities())[0].occurredAt.getTime(), sentAt.getTime());
  });

  test("a message with no sentAt still lands, using when we mirrored it", async () => {
    await contact("ada@acme.test");
    const msg = await message({ sentAt: null });

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    const row = (await activities())[0];
    assert.ok(row.occurredAt instanceof Date);
    assert.ok(Number.isFinite(row.occurredAt.getTime()));
  });

  test("the thread and message ids are carried onto the activity for deep-linking", async () => {
    await contact("ada@acme.test");
    const msg = await message();

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    const row = (await activities())[0];
    assert.equal(row.mailThreadId, msg.threadId);
    assert.equal(row.mailMessageId, msg.id);
  });

  test("the contact's account is denormalized onto the activity", async () => {
    await contact("ada@acme.test", { customerId: "cust_acme" });
    const msg = await message();

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.equal((await activities())[0].customerId, "cust_acme");
  });

  test("the body is the snippet, which has quoted history already stripped", async () => {
    await contact("ada@acme.test");
    const msg = await message({ snippet: "  Sounds good  ", bodyText: "Sounds good\n> lots of quoting" });

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.equal((await activities())[0].bodyText, "Sounds good");
  });

  test("falls back to the full body when Gmail gave us no snippet", async () => {
    await contact("ada@acme.test");
    const msg = await message({ snippet: "", bodyText: "the long version" });

    await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.equal((await activities())[0].bodyText, "the long version");
  });

  test("drafts are never put on a timeline", async () => {
    await contact("ada@acme.test");
    const byLabel = await message({
      fromEmail: MAILBOX,
      toEmails: "ada@acme.test",
      labelIds: " DRAFT ",
    });
    const byDraftId = await message({
      fromEmail: MAILBOX,
      toEmails: "ada@acme.test",
      gmailDraftId: "r-123",
      labelIds: "",
    });

    const result = await linkMessagesToContacts(CO, [byLabel, byDraftId], MAILBOX);

    assert.deepEqual(result, { linked: 0, activities: 0 });
    assert.deepEqual(await activities(), []);
  });

  test("a contact in another company is never matched", async () => {
    await insert(Contact, {
      companyId: OTHER_CO,
      name: "Ada",
      email: "ada@acme.test",
    });
    const msg = await message();

    const result = await linkMessagesToContacts(CO, [msg], MAILBOX);

    assert.deepEqual(result, { linked: 0, activities: 0 });
    assert.deepEqual(await activities(), []);
    assert.deepEqual(await activities(OTHER_CO), []);
  });

  test("moves the contact's lastActivityAt forward, which is what the list sorts by", async () => {
    const ada = await contact("ada@acme.test");
    assert.equal(ada.lastActivityAt, null);
    const sentAt = new Date("2026-06-30T08:00:00.000Z");

    await linkMessagesToContacts(CO, [await message({ sentAt })], MAILBOX);

    const refreshed = await AppDataSource.getRepository(Contact).findOneByOrFail({ id: ada.id });
    assert.equal(refreshed.lastActivityAt?.getTime(), sentAt.getTime());
  });

  test("an empty batch is a no-op and costs no queries", async () => {
    assert.deepEqual(await linkMessagesToContacts(CO, [], MAILBOX), {
      linked: 0,
      activities: 0,
    });
  });

  test("a batch larger than the chunk size is fully linked", async () => {
    // Chunking exists so the IN(...) lists stay under any driver's bound
    // parameter ceiling; a first import hands us a whole backfill page.
    await contact("ada@acme.test");
    const repo = AppDataSource.getRepository(MailMessage);
    const batch = repo.create(
      Array.from({ length: 205 }, () => draftMessage() as MailMessage),
    );
    const saved = await repo.save(batch);

    const result = await linkMessagesToContacts(CO, saved, MAILBOX);

    assert.deepEqual(result, { linked: 205, activities: 205 });
    assert.equal((await activities()).length, 205);
  });
});

// ─────────────────────── handleInboundForSequences ───────────────────────

describe("handleInboundForSequences", () => {
  test("an inbound reply stops the enrolment on that thread", async () => {
    const msg = await message();
    const enrolled = await enrollment({ mailThreadId: msg.threadId });

    const stopped = await handleInboundForSequences(CO, [msg], MAILBOX);

    assert.equal(stopped, 1);
    const refreshed = await AppDataSource.getRepository(SequenceEnrollment).findOneByOrFail({
      id: enrolled.id,
    });
    assert.equal(refreshed.status, "stopped_replied");
    assert.equal(refreshed.nextRunAt, null);
  });

  test("our own outbound message on the thread does not stop it", async () => {
    // Otherwise the sequence would stop itself the moment it sent step one.
    const msg = await message({ fromEmail: MAILBOX, toEmails: "ada@acme.test", labelIds: " SENT " });
    const enrolled = await enrollment({ mailThreadId: msg.threadId });

    const stopped = await handleInboundForSequences(CO, [msg], MAILBOX);

    assert.equal(stopped, 0);
    const refreshed = await AppDataSource.getRepository(SequenceEnrollment).findOneByOrFail({
      id: enrolled.id,
    });
    assert.equal(refreshed.status, "active");
  });

  test("a draft reply does not stop anything", async () => {
    const msg = await message({ labelIds: " DRAFT " });
    await enrollment({ mailThreadId: msg.threadId });

    assert.equal(await handleInboundForSequences(CO, [msg], MAILBOX), 0);
  });

  test("an inbound message on a thread with no enrolment is a no-op", async () => {
    const msg = await message();

    assert.equal(await handleInboundForSequences(CO, [msg], MAILBOX), 0);
  });

  test("an enrolment in another company is left alone", async () => {
    const msg = await message();
    const foreign = await enrollment({ companyId: OTHER_CO, mailThreadId: msg.threadId });

    assert.equal(await handleInboundForSequences(CO, [msg], MAILBOX), 0);
    const refreshed = await AppDataSource.getRepository(SequenceEnrollment).findOneByOrFail({
      id: foreign.id,
    });
    assert.equal(refreshed.status, "active");
  });

  test("two replies on the same thread stop it once", async () => {
    const first = await message();
    const second = await message({ threadId: first.threadId });
    await enrollment({ mailThreadId: first.threadId });

    assert.equal(await handleInboundForSequences(CO, [first, second], MAILBOX), 1);
  });

  test("an already-stopped enrolment is not counted again", async () => {
    const msg = await message();
    await enrollment({ mailThreadId: msg.threadId, status: "stopped_unsubscribed" });

    assert.equal(await handleInboundForSequences(CO, [msg], MAILBOX), 0);
  });
});

// ───────────────────────────── bounce detection ─────────────────────────────

describe("isBounceSender", () => {
  test("recognises the reserved report mailboxes", () => {
    assert.equal(isBounceSender("MAILER-DAEMON@acme.test"), true);
    assert.equal(isBounceSender("postmaster@acme.test"), true);
    assert.equal(isBounceSender("Mail Delivery System <mailerdaemon@acme.test>"), true);
  });

  test("does not treat a vendor envelope sender as a report", () => {
    // `bounces@` is also used for ordinary bulk mail; treating it as a report
    // would let a newsletter suppress addresses.
    assert.equal(isBounceSender("bounces@mailer.bigcorp.test"), false);
    assert.equal(isBounceSender("no-reply@bigcorp.test"), false);
  });

  test("junk is not a bounce sender", () => {
    assert.equal(isBounceSender(""), false);
    assert.equal(isBounceSender(null), false);
  });
});

describe("extractFailedRecipients", () => {
  const report = (bodyText: string, snippet = "") => ({
    fromEmail: "MAILER-DAEMON@acme.test",
    bodyText,
    snippet,
  });

  test("reads the RFC 3464 Final-Recipient field", () => {
    assert.deepEqual(extractFailedRecipients(report(DSN_BODY)), ["grace@acme.test"]);
  });

  test("tolerates angle brackets and trailing punctuation on the field", () => {
    assert.deepEqual(
      extractFailedRecipients(report("Final-Recipient: rfc822; <grace@acme.test>")),
      ["grace@acme.test"],
    );
  });

  test("takes every Final-Recipient in a multi-recipient report", () => {
    const body = [
      "Final-Recipient: rfc822; grace@acme.test",
      "Status: 5.1.1",
      "Final-Recipient: rfc822; hal@acme.test",
      "Status: 5.1.1",
    ].join("\n");
    assert.deepEqual(extractFailedRecipients(report(body)).sort(), [
      "grace@acme.test",
      "hal@acme.test",
    ]);
  });

  test("falls back to a lone address on a 550 line", () => {
    const body = "<grace@acme.test>: host mx.acme.test said: 550 5.1.1 User unknown";
    assert.deepEqual(extractFailedRecipients(report(body)), ["grace@acme.test"]);
  });

  test("records nothing when a failure line names two addresses", () => {
    // Which of them bounced? Unknowable — and a wrong suppression silently
    // stops legitimate mail forever.
    const body = "550 relaying denied for grace@acme.test via relay@acme.test";
    assert.deepEqual(extractFailedRecipients(report(body)), []);
  });

  test("records nothing when two different failure lines disagree", () => {
    const body = [
      "grace@acme.test: 550 User unknown",
      "hal@acme.test: 550 User unknown",
    ].join("\n");
    assert.deepEqual(extractFailedRecipients(report(body)), []);
  });

  test("the structured field wins over the prose, and prose ambiguity is ignored", () => {
    const body = [
      "550 5.1.1 delivery to grace@acme.test and relay@acme.test failed",
      "Final-Recipient: rfc822; grace@acme.test",
    ].join("\n");
    assert.deepEqual(extractFailedRecipients(report(body)), ["grace@acme.test"]);
  });

  test("never returns the report's own sender", () => {
    const body = "550 message from MAILER-DAEMON@acme.test could not be delivered";
    assert.deepEqual(extractFailedRecipients(report(body)), []);
  });

  test("a report we cannot read yields nothing", () => {
    assert.deepEqual(
      extractFailedRecipients(report("Delivery to the following recipient failed permanently.")),
      [],
    );
    assert.deepEqual(extractFailedRecipients(report("")), []);
  });

  test("a success notice with no failure code is not mined for addresses", () => {
    assert.deepEqual(
      extractFailedRecipients(report("Your message to grace@acme.test was delayed, retrying.")),
      [],
    );
  });

  test("reads the snippet when the body did not survive extraction", () => {
    assert.deepEqual(
      extractFailedRecipients(report("", "<grace@acme.test>: 550 5.1.1 User unknown")),
      ["grace@acme.test"],
    );
  });
});

describe("detectBounces", () => {
  const daemonMessage = (bodyText: string, over: Partial<MailMessage> = {}) =>
    message({ fromEmail: "MAILER-DAEMON@acme.test", bodyText, snippet: "", ...over });

  test("suppresses the failed recipient and flags the contact", async () => {
    const grace = await contact("grace@acme.test");
    const now = new Date("2026-07-02T12:00:00.000Z");

    const recorded = await detectBounces(CO, [await daemonMessage(DSN_BODY)], now);

    assert.equal(recorded, 1);
    const suppression = await AppDataSource.getRepository(Suppression).findOneByOrFail({
      companyId: CO,
      email: "grace@acme.test",
    });
    assert.equal(suppression.reason, "bounce");
    assert.equal(suppression.source, "mail-sync");
    const refreshed = await AppDataSource.getRepository(Contact).findOneByOrFail({ id: grace.id });
    assert.equal(refreshed.bouncedAt?.getTime(), now.getTime());
  });

  test("suppresses an address we hold no contact for", async () => {
    // The suppression is about the address; a Contact is not required, and one
    // is deliberately not created for it.
    const recorded = await detectBounces(CO, [await daemonMessage(DSN_BODY)]);

    assert.equal(recorded, 1);
    assert.equal(await contactCount(), 0);
  });

  test("an ordinary message is never read as a bounce", async () => {
    await contact("grace@acme.test");
    const msg = await message({ fromEmail: "ada@acme.test", bodyText: DSN_BODY, snippet: "" });

    assert.equal(await detectBounces(CO, [msg]), 0);
    assert.equal(await AppDataSource.getRepository(Suppression).countBy({ companyId: CO }), 0);
  });

  test("a daemon message we cannot read records nothing at all", async () => {
    const msg = await daemonMessage("Delivery delayed. We will keep trying for 24 hours.");

    assert.equal(await detectBounces(CO, [msg]), 0);
    assert.equal(await AppDataSource.getRepository(Suppression).countBy({ companyId: CO }), 0);
  });

  test("an ambiguous report records nothing rather than guessing", async () => {
    const msg = await daemonMessage("550 relaying denied for grace@acme.test via relay@acme.test");

    assert.equal(await detectBounces(CO, [msg]), 0);
    assert.equal(await AppDataSource.getRepository(Suppression).countBy({ companyId: CO }), 0);
  });

  test("the same address named by two reports is recorded once", async () => {
    const recorded = await detectBounces(CO, [
      await daemonMessage(DSN_BODY),
      await daemonMessage(DSN_BODY),
    ]);

    assert.equal(recorded, 1);
    assert.equal(await AppDataSource.getRepository(Suppression).countBy({ companyId: CO }), 1);
  });

  test("re-syncing the same report is harmless", async () => {
    const msg = await daemonMessage(DSN_BODY);

    await detectBounces(CO, [msg]);
    await detectBounces(CO, [msg]);

    assert.equal(await AppDataSource.getRepository(Suppression).countBy({ companyId: CO }), 1);
  });

  test("a bounce report sitting in Drafts is ignored", async () => {
    const msg = await daemonMessage(DSN_BODY, { labelIds: " DRAFT " });

    assert.equal(await detectBounces(CO, [msg]), 0);
  });
});

// ───────────────────── linkAccountMessagesSince / Safely ─────────────────────

describe("linkAccountMessagesSince", () => {
  test("does the linking, the reply-stop and the bounce read in one pass", async () => {
    const ada = await contact("ada@acme.test");
    const since = new Date(Date.now() - 60_000);

    const inbound = await message();
    await enrollment({ contactId: ada.id, mailThreadId: inbound.threadId });
    await message({ fromEmail: "MAILER-DAEMON@acme.test", bodyText: DSN_BODY, snippet: "" });

    const result = await linkAccountMessagesSince(ACCOUNT, since);

    assert.equal(result.linked, 1);
    assert.equal(result.activities, 1);
    assert.equal(result.sequencesStopped, 1);
    assert.equal(result.bouncesRecorded, 1);
  });

  test("ignores messages mirrored before this pass began", async () => {
    await contact("ada@acme.test");
    await message();

    const result = await linkAccountMessagesSince(ACCOUNT, new Date(Date.now() + 60_000));

    assert.deepEqual(result, {
      linked: 0,
      activities: 0,
      sequencesStopped: 0,
      bouncesRecorded: 0,
    });
  });

  test("only reads the account it was given", async () => {
    await contact("ada@acme.test");
    await message({ accountId: "acct_other" });

    const result = await linkAccountMessagesSince(ACCOUNT, new Date(Date.now() - 60_000));

    assert.equal(result.linked, 0);
    assert.deepEqual(await activities(), []);
  });
});

describe("linkAccountMessagesSafely", () => {
  test("a failure inside linking does not propagate to mail sync", async () => {
    await contact("ada@acme.test");
    await message();
    const since = new Date(Date.now() - 60_000);
    // Break the revenue side underneath the pass. Mail sync must not care.
    await AppDataSource.query("DROP TABLE activities");

    await assert.rejects(() => linkAccountMessagesSince(ACCOUNT, since));
    assert.equal(await linkAccountMessagesSafely(ACCOUNT, since), null);
  });

  test("returns the result when nothing went wrong", async () => {
    await contact("ada@acme.test");
    await message();

    const result = await linkAccountMessagesSafely(ACCOUNT, new Date(Date.now() - 60_000));

    assert.equal(result?.linked, 1);
    assert.equal(result?.activities, 1);
  });
});
