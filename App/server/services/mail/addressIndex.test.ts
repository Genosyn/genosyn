import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailAddressIndexState } from "../../db/entities/MailAddressIndexState.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailMessageAddress } from "../../db/entities/MailMessageAddress.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../../test/dbHarness.js";
import { purgeMailAccountMirror } from "./accounts.js";
import {
  addressInDomain,
  baseDomainOf,
  indexMailboxAddresses,
  mailAddressIndexPending,
  messageAddresses,
} from "./addressIndex.js";

describe("baseDomainOf", () => {
  test("reduces a host to the name its owner registered", () => {
    assert.equal(baseDomainOf("acme.com"), "acme.com");
    assert.equal(baseDomainOf("eu.acme.com"), "acme.com");
    assert.equal(baseDomainOf("a.b.eu.acme.com"), "acme.com");
    assert.equal(baseDomainOf("mail.acme.co.uk"), "acme.co.uk");
    assert.equal(baseDomainOf("acme.com.au"), "acme.com.au");
    assert.equal(baseDomainOf("ops.acme.de"), "acme.de");
    assert.equal(baseDomainOf("Acme.COM"), "acme.com");
  });

  test("gives a domain and its subdomains the same key", () => {
    for (const [domain, host] of [
      ["acme.com", "eu.acme.com"],
      ["eu.acme.com", "x.eu.acme.com"],
      ["acme.co.uk", "billing.acme.co.uk"],
    ]) {
      assert.ok(addressInDomain(`a@${host}`, domain));
      assert.equal(baseDomainOf(host), baseDomainOf(domain));
    }
  });

  test("never treats a lookalike host as inside the domain", () => {
    assert.equal(addressInDomain("a@acme.com.au", "acme.com"), false);
    assert.equal(addressInDomain("a@notacme.com", "acme.com"), false);
    assert.equal(addressInDomain("a@acme.com", null), false);
  });
});

describe("messageAddresses", () => {
  test("reads From, To and Cc, lowercased and without display names", () => {
    assert.deepEqual(
      messageAddresses({
        fromEmail: "Ada <ADA@acme.com>",
        toEmails: '"Hopper, Grace" <grace@navy.example>, ops@acme.com',
        ccEmails: "ada@acme.com; Pat <pat@acme.com>",
      }),
      ["ada@acme.com", "grace@navy.example", "ops@acme.com", "pat@acme.com"],
    );
  });

  test("skips what does not parse", () => {
    assert.deepEqual(
      messageAddresses({ fromEmail: "", toEmails: "undisclosed-recipients:;", ccEmails: "" }),
      [],
    );
  });
});

describe("indexMailboxAddresses", () => {
  let companyId: string;
  let mailbox: MailAccount;
  const later = () => new Date(Date.now() + 60 * 60_000);

  before(initTestDb);
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    companyId = testCompanyId();
    mailbox = await insert(MailAccount, {
      companyId,
      connectionId: randomUUID(),
      address: "sales@northwind.test",
    });
  });

  /** Messages written straight to the table, with `createdAt` stored as given text. */
  async function messages(
    count: number,
    headers: (index: number) => { from?: string; to?: string; cc?: string; bcc?: string },
    createdAt: (index: number) => string,
  ): Promise<string[]> {
    // Ids are kept apart from the inserted objects: a multi-row insert that
    // refreshes its entities may write another row's generated values back
    // onto them, which would stamp each `createdAt` on the wrong message.
    const ids = Array.from({ length: count }, () => randomUUID());
    const rows = ids.map((id, index) => ({
      id,
      companyId,
      accountId: mailbox.id,
      threadId: "thread",
      gmailMessageId: `message-${randomUUID()}`,
      gmailThreadId: "thread",
      fromEmail: headers(index).from ?? "sales@northwind.test",
      toEmails: headers(index).to ?? "",
      ccEmails: headers(index).cc ?? "",
      bccEmails: headers(index).bcc ?? "",
    }));
    for (let start = 0; start < rows.length; start += 200) {
      await AppDataSource.getRepository(MailMessage)
        .createQueryBuilder()
        .insert()
        .values(rows.slice(start, start + 200))
        .updateEntity(false)
        .execute();
    }
    for (const [index, id] of ids.entries()) {
      await AppDataSource.query(`UPDATE mail_messages SET createdAt = ? WHERE id = ?`, [
        createdAt(index),
        id,
      ]);
    }
    return ids;
  }

  async function indexedAddresses(): Promise<Array<{ messageId: string; address: string }>> {
    return AppDataSource.getRepository(MailMessageAddress).find({
      where: { accountId: mailbox.id },
      select: { messageId: true, address: true },
    });
  }

  test("indexes every message once, across chunk boundaries inside one instant", async () => {
    // 1,100 messages, 700 of them sharing one stored second: the second chunk
    // starts mid-instant and must continue by id rather than skip ahead.
    const ids = await messages(
      1_100,
      (index) => ({ to: `person${index}@acme.com`, bcc: "hidden@acme.com" }),
      (index) => (index < 700 ? "2026-09-01 09:00:00" : `2026-09-01 09:00:01.${String(index % 1000).padStart(3, "0")}`),
    );

    // A budget stops the pass at the first chunk boundary past it; the next
    // pass resumes from the saved cursor.
    const first = await indexMailboxAddresses(mailbox, { now: later(), budget: 500 });
    assert.equal(first.caughtUp, false);
    assert.ok(first.indexed >= 500 && first.indexed < 1_100);
    assert.equal(await mailAddressIndexPending(companyId, [mailbox.id]), true);

    const rest = await indexMailboxAddresses(mailbox, { now: later() });
    assert.deepEqual(rest, { indexed: 1_100 - first.indexed, caughtUp: true });
    assert.equal(await mailAddressIndexPending(companyId, [mailbox.id]), false);

    const rows = await indexedAddresses();
    const byMessage = new Map<string, string[]>();
    for (const row of rows) byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row.address]);
    assert.equal(byMessage.size, ids.length);
    // The sender is the mailbox itself, which is never stored; nor is Bcc.
    assert.deepEqual(byMessage.get(ids[3]), ["person3@acme.com"]);
    assert.equal(rows.some((row) => row.address === "hidden@acme.com"), false);
  });

  test("reads mixed second- and millisecond-precision timestamps in order", async () => {
    const ids = await messages(
      4,
      (index) => ({ from: `p${index}@acme.com` }),
      (index) =>
        ["2026-09-01 09:00:00", "2026-09-01 09:00:00.500", "2026-09-01 09:00:01", "2026-09-01 09:00:00.250"][
          index
        ],
    );
    await indexMailboxAddresses(mailbox, { now: later() });
    const indexed = new Set((await indexedAddresses()).map((row) => row.messageId));
    assert.deepEqual([...ids].filter((id) => indexed.has(id)).length, 4);
  });

  test("leaves mail that has not settled for a later pass, then picks it up", async () => {
    const now = new Date("2026-09-01T09:10:00.000Z");
    await messages(
      2,
      (index) => ({ from: `p${index}@acme.com` }),
      (index) => (index === 0 ? "2026-09-01 09:00:00.000" : "2026-09-01 09:09:30.000"),
    );

    const early = await indexMailboxAddresses(mailbox, { now });
    assert.equal(early.indexed, 1);
    assert.deepEqual(
      (await indexedAddresses()).map((row) => row.address),
      ["p0@acme.com"],
    );

    const settled = await indexMailboxAddresses(mailbox, {
      now: new Date("2026-09-01T09:20:00.000Z"),
    });
    assert.equal(settled.indexed, 1);
    assert.deepEqual(
      (await indexedAddresses()).map((row) => row.address).sort(),
      ["p0@acme.com", "p1@acme.com"],
    );
  });

  test("is idempotent when a pass re-reads messages it already indexed", async () => {
    await messages(3, (index) => ({ from: `p${index}@acme.com` }), () => "2026-09-01 09:00:00");
    await indexMailboxAddresses(mailbox, { now: later() });
    await AppDataSource.getRepository(MailAddressIndexState).update(
      { accountId: mailbox.id },
      { cursorAt: "", cursorId: "" },
    );
    await indexMailboxAddresses(mailbox, { now: later() });
    assert.equal((await indexedAddresses()).length, 3);
  });

  test("an empty mailbox counts as caught up, and a purged one leaves nothing behind", async () => {
    assert.equal(await mailAddressIndexPending(companyId, [mailbox.id]), true);
    assert.deepEqual(await indexMailboxAddresses(mailbox, { now: later() }), {
      indexed: 0,
      caughtUp: true,
    });
    assert.equal(await mailAddressIndexPending(companyId, [mailbox.id]), false);

    await messages(2, (index) => ({ from: `p${index}@acme.com` }), () => "2026-09-01 09:00:00");
    await indexMailboxAddresses(mailbox, { now: later() });
    await purgeMailAccountMirror(mailbox.id);
    assert.equal((await indexedAddresses()).length, 0);
    assert.equal(
      await AppDataSource.getRepository(MailAddressIndexState).countBy({ accountId: mailbox.id }),
      0,
    );
  });
});
