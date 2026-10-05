import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  bootMailSearchIndex,
  indexQueuedThreads,
  mailSearchIndexReady,
  mailSearchMatch,
  stopMailSearchIndex,
} from "./searchIndex.js";
import {
  applyMailScope,
  applyMailSearchFilters,
  effectiveScope,
  parseMailQuery,
} from "./searchQuery.js";

/**
 * Mail search on SQLite answers its text filters from a full-text index kept
 * in the connection's temp schema. These pin what that index promises: words
 * and word starts across every message in a thread, the operators as column
 * filters, writes reflected after a sweep, and the scanning filters whenever
 * the index cannot answer.
 */

before(initTestDb);
beforeEach(async () => {
  stopMailSearchIndex();
  await resetTestDb();
});
after(async () => {
  stopMailSearchIndex();
  await closeTestDb();
});

const COMPANY_ID = "co_mail_search_index_test";
const ACCOUNT_ID = "acct_mail_search_index_test";
let minute = 0;

async function thread(subject: string, labelIds = " INBOX "): Promise<MailThread> {
  minute += 1;
  return insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: ACCOUNT_ID,
    gmailThreadId: randomUUID(),
    subject,
    labelIds,
    lastMessageAt: new Date(Date.UTC(2026, 9, 1, 9, minute)),
  });
}

async function message(
  t: MailThread,
  fields: Partial<Pick<MailMessage, "subject" | "fromName" | "fromEmail" | "toEmails" | "bodyText">>,
): Promise<MailMessage> {
  return insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: ACCOUNT_ID,
    threadId: t.id,
    gmailMessageId: randomUUID(),
    gmailThreadId: t.gmailThreadId,
    subject: t.subject,
    ...fields,
  });
}

/** Build the index and drain its queue, as the background sweep would. */
function buildIndex(): void {
  bootMailSearchIndex();
  while (indexQueuedThreads(1_000));
}

async function search(query: string): Promise<string[]> {
  const parsed = parseMailQuery(query);
  let qb = AppDataSource.getRepository(MailThread)
    .createQueryBuilder("t")
    .where("t.accountId = :aid", { aid: ACCOUNT_ID })
    .andWhere("t.lastMessageAt IS NOT NULL");
  qb = applyMailScope(qb, effectiveScope(parsed, undefined));
  qb = applyMailSearchFilters(qb, parsed, undefined);
  const rows = await qb.orderBy("t.lastMessageAt", "DESC").getMany();
  return rows.map((row) => row.subject);
}

async function seedMailbox(): Promise<{ refund: MailThread; memo: MailThread }> {
  const invoice = await thread("Q3 invoice");
  await message(invoice, {
    fromName: "Ada Ledger",
    fromEmail: "ada@northwind.example",
    bodyText: "Please find the invoice attached.",
  });
  await message(invoice, { bodyText: "Payment sent. Thanks, Café Lumière" });
  const refund = await thread("Refund request");
  await message(refund, {
    fromName: "Billing",
    fromEmail: "billing@acme.example",
    toEmails: "support@northwind.example",
    bodyText: "I would like a refund for order 1234.",
  });
  const memo = await thread("Lunch");
  await message(memo, { bodyText: "Recorded a voice memo about the offsite." });
  return { refund, memo };
}

describe("with the index built", () => {
  test("terms match words and word starts across a thread, and every term must hold", async () => {
    await seedMailbox();
    buildIndex();
    assert.equal(mailSearchIndexReady(), true);

    assert.deepEqual(await search("invo"), ["Q3 invoice"]);
    // Two terms satisfied by different messages of one conversation.
    assert.deepEqual(await search("invoice payment"), ["Q3 invoice"]);
    assert.deepEqual(await search("cafe"), ["Q3 invoice"]);
    assert.deepEqual(await search("refund 1234"), ["Refund request"]);
    assert.deepEqual(await search("refund lunch"), []);
    assert.deepEqual(await search("zqxjkvb"), []);
    // A word is matched from its start, never from its middle.
    assert.deepEqual(await search("voice"), ["Lunch"]);
    // Two letters match a whole word, not every word starting with them.
    assert.deepEqual(await search("q3"), ["Q3 invoice"]);
  });

  test("quotes match words in order, and the operators search their own fields", async () => {
    await seedMailbox();
    buildIndex();

    assert.deepEqual(await search('"find the invoice"'), ["Q3 invoice"]);
    assert.deepEqual(await search('"invoice the find"'), []);
    assert.deepEqual(await search("from:acme"), ["Refund request"]);
    assert.deepEqual(await search("from:billing@acme.example"), ["Refund request"]);
    assert.deepEqual(await search("from:ada"), ["Q3 invoice"]);
    assert.deepEqual(await search("to:support"), ["Refund request"]);
    // The body says "refund", but only the subject is asked about.
    assert.deepEqual(await search("subject:refund"), ["Refund request"]);
    assert.deepEqual(await search("subject:offsite"), []);
  });

  test("keeps up with mail that arrives, changes, or goes away", async () => {
    const { refund, memo } = await seedMailbox();
    buildIndex();

    const arrival = await message(refund, { bodyText: "Following up: zebra crossing outage." });
    while (indexQueuedThreads(1_000));
    assert.deepEqual(await search("zebra"), ["Refund request"]);

    arrival.bodyText = "Following up: nothing new.";
    await AppDataSource.getRepository(MailMessage).save(arrival);
    while (indexQueuedThreads(1_000));
    assert.deepEqual(await search("zebra"), []);

    await AppDataSource.getRepository(MailMessage).delete({ id: arrival.id });
    while (indexQueuedThreads(1_000));
    assert.deepEqual(await search("following"), []);

    // A deleted conversation leaves the index at once, before any sweep.
    await AppDataSource.getRepository(MailThread).delete({ id: memo.id });
    assert.deepEqual(await search("memo"), []);
  });
});

test("a stopped index leaves mail writes alone", async () => {
  await seedMailbox();
  buildIndex();
  const triggers = () =>
    AppDataSource.query(
      `SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'mail_search_%'`,
    ) as Promise<unknown[]>;
  assert.equal((await triggers()).length, 4);

  stopMailSearchIndex();
  assert.deepEqual(await triggers(), []);
  assert.equal(mailSearchIndexReady(), false);
});

describe("falling back to scanning", () => {
  test("search scans for substrings until the index has been built", async () => {
    await seedMailbox();
    assert.equal(mailSearchIndexReady(), false);
    assert.equal(mailSearchMatch(parseMailQuery("voice")), null);
    // Substring semantics: "voice" sits inside "invoice" too.
    assert.deepEqual(await search("voice"), ["Lunch", "Q3 invoice"]);
  });

  test("values the index cannot answer are scanned for, even once it is built", async () => {
    const t = await thread("Office move");
    await message(t, { bodyText: "Desk 東京 moves to floor 3 — cost @@ 40%" });
    buildIndex();

    assert.equal(mailSearchMatch(parseMailQuery("@@")), null);
    assert.equal(mailSearchMatch(parseMailQuery("東京")), null);
    assert.deepEqual(await search("@@"), ["Office move"]);
    assert.deepEqual(await search("東京"), ["Office move"]);
    // An answerable query on the same mailbox still uses the index.
    assert.notEqual(mailSearchMatch(parseMailQuery("desk")), null);
    assert.deepEqual(await search("desk"), ["Office move"]);
  });
});
