import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { listCustomerMail } from "./customerMail.js";
import { indexMailboxAddresses } from "./mail/addressIndex.js";

let companyId: string;
let mailbox: MailAccount;
let customer: Customer;
let minute = 0;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  minute = 0;
  companyId = testCompanyId();
  mailbox = await insert(MailAccount, {
    companyId,
    connectionId: randomUUID(),
    address: "sales@northwind.test",
  });
  customer = await insert(Customer, {
    companyId,
    name: "Acme",
    slug: "acme",
    email: "Billing@Acme.com",
    domain: "acme.com",
  });
});

/** Index what the mailbox holds, as the background indexer would, then list. */
async function listAfterIndexing(
  ...args: Parameters<typeof listCustomerMail>
): ReturnType<typeof listCustomerMail> {
  await indexMailboxAddresses(mailbox, { now: new Date(Date.now() + 60 * 60_000) });
  return listCustomerMail(...args);
}

/** One single-message conversation; later calls are newer. */
async function conversation(
  subject: string,
  headers: {
    from?: string;
    fromName?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    draft?: boolean;
    labels?: string;
    companyId?: string;
  },
): Promise<MailThread> {
  const at = new Date(Date.UTC(2026, 8, 1, 9, minute++));
  const owner = headers.companyId ?? companyId;
  const thread = await insert(MailThread, {
    companyId: owner,
    accountId: mailbox.id,
    gmailThreadId: `thread-${randomUUID()}`,
    subject,
    snippet: "Thanks &amp; regards",
    labelIds: headers.labels ?? " INBOX ",
    messageCount: 1,
    lastMessageAt: at,
  });
  await insert(MailMessage, {
    companyId: owner,
    accountId: mailbox.id,
    threadId: thread.id,
    gmailMessageId: `message-${randomUUID()}`,
    gmailThreadId: thread.gmailThreadId,
    gmailDraftId: headers.draft ? `draft-${randomUUID()}` : "",
    fromName: headers.fromName ?? "",
    fromEmail: headers.from ?? "sales@northwind.test",
    toEmails: headers.to ?? "",
    ccEmails: headers.cc ?? "",
    bccEmails: headers.bcc ?? "",
    subject,
    sentAt: at,
  });
  return thread;
}

test("lists every conversation with the customer's addresses and domain, newest first", async () => {
  await insert(CustomerContact, {
    companyId,
    customerId: customer.id,
    name: "Pat Payables",
    email: "pat@acme-holdings.example",
  });
  await insert(Contact, {
    companyId,
    customerId: customer.id,
    name: "Ada Lovelace",
    email: "ada@acme.com",
  });
  await insert(Contact, {
    companyId,
    customerId: customer.id,
    name: "Grace Hopper",
    email: "grace@hopper-consulting.example",
  });
  await insert(Contact, {
    companyId,
    customerId: customer.id,
    name: "Gone Person",
    email: "gone@elsewhere.example",
    archivedAt: new Date(),
  });

  await conversation("Invoice question", { from: "Billing <BILLING@acme.com>", to: "sales@northwind.test" });
  await conversation("Kickoff", { to: '"Lovelace, Ada" <ada@acme.com>' });
  await conversation("EU rollout", { to: "someone@partner.example", cc: "ops@eu.acme.com" });
  await conversation("Remittance", { to: "Pat <pat@acme-holdings.example>" });
  await conversation("Advisory", { from: "grace@hopper-consulting.example", fromName: "Grace H." });
  await conversation("Stranger at a lookalike domain", { from: "someone@acme.com.au" });
  await conversation("Stranger at a suffix domain", { from: "x@notacme.com" });
  await conversation("Archived contact", { from: "gone@elsewhere.example" });
  await conversation("Blind copy only", { to: "someone@partner.example", bcc: "ada@acme.com" });
  await conversation("Unsent draft", { to: "ada@acme.com", draft: true });
  await conversation("Binned", { from: "ada@acme.com", labels: " TRASH " });
  await conversation("Junk", { from: "ada@acme.com", labels: " SPAM " });
  await conversation("Another company", { from: "ada@acme.com", companyId: testCompanyId() });

  // Before the indexer has read the mailbox, the page says so instead of
  // claiming there is no mail.
  const unindexed = await listCustomerMail(companyId, customer);
  assert.equal(unindexed.indexing, true);
  assert.equal(unindexed.total, 0);

  const page = await listAfterIndexing(companyId, customer);
  assert.equal(page.indexing, false);

  assert.deepEqual(
    page.threads.map((thread) => thread.subject),
    ["Advisory", "Remittance", "EU rollout", "Kickoff", "Invoice question"],
  );
  assert.equal(page.total, 5);
  assert.equal(page.domain, "acme.com");
  assert.equal(page.mailboxCount, 1);
  // The billing email leads, then billing contacts, then Revenue Contacts
  // (whose own order is by creation, a tie inside one test second).
  assert.deepEqual(page.addresses.slice(0, 2), ["billing@acme.com", "pat@acme-holdings.example"]);
  assert.deepEqual(page.addresses.slice(2).sort(), [
    "ada@acme.com",
    "grace@hopper-consulting.example",
  ]);

  const bySubject = new Map(page.threads.map((thread) => [thread.subject, thread]));
  assert.deepEqual(bySubject.get("Kickoff")?.people, [{ email: "ada@acme.com", name: "Ada Lovelace" }]);
  assert.deepEqual(bySubject.get("EU rollout")?.people, [{ email: "ops@eu.acme.com", name: "" }]);
  assert.deepEqual(bySubject.get("Remittance")?.people, [
    { email: "pat@acme-holdings.example", name: "Pat Payables" },
  ]);
  // A contact's own name wins over whatever their mail client sends.
  assert.deepEqual(bySubject.get("Advisory")?.people, [
    { email: "grace@hopper-consulting.example", name: "Grace Hopper" },
  ]);

  const kickoff = bySubject.get("Kickoff");
  assert.equal(kickoff?.accountId, mailbox.id);
  assert.equal(kickoff?.mailboxAddress, "sales@northwind.test");
  assert.equal(kickoff?.snippet, "Thanks & regards");
});

test("pages through the conversations and keeps the total", async () => {
  await conversation("First", { from: "a@acme.com" });
  await conversation("Second", { from: "b@acme.com" });
  await conversation("Third", { from: "c@acme.com" });

  const first = await listAfterIndexing(companyId, customer, { limit: 2 });
  assert.deepEqual(
    first.threads.map((thread) => thread.subject),
    ["Third", "Second"],
  );
  assert.equal(first.total, 3);

  const second = await listAfterIndexing(companyId, customer, { limit: 2, offset: 2 });
  assert.deepEqual(
    second.threads.map((thread) => thread.subject),
    ["First"],
  );
  assert.equal(second.total, 3);
});

test("never treats a free-mail host or the company's own domain as the customer's", async () => {
  const freeMail = await insert(Customer, {
    companyId,
    name: "Solo founder",
    slug: "solo-founder",
    email: "founder@gmail.com",
    domain: "gmail.com",
  });
  const internal = await insert(Customer, {
    companyId,
    name: "Misfiled",
    slug: "misfiled",
    domain: "northwind.test",
  });
  await conversation("From the founder", { from: "founder@gmail.com" });
  await conversation("From another Gmail user", { from: "someone.else@gmail.com" });
  await conversation("Internal note", { from: "sales@northwind.test", to: "ops@northwind.test" });

  const founder = await listAfterIndexing(companyId, freeMail);
  assert.equal(founder.domain, null);
  assert.deepEqual(
    founder.threads.map((thread) => thread.subject),
    ["From the founder"],
  );

  const misfiled = await listAfterIndexing(companyId, internal);
  assert.equal(misfiled.domain, null);
  assert.deepEqual(misfiled.addresses, []);
  assert.equal(misfiled.total, 0);
});

test("a mailbox's own address on the customer does not claim the whole mailbox", async () => {
  const sameAsMailbox = await insert(Customer, {
    companyId,
    name: "Typo",
    slug: "typo",
    email: "sales@northwind.test",
  });
  await conversation("Anything we sent", { to: "someone@partner.example" });

  const page = await listAfterIndexing(companyId, sameAsMailbox);
  assert.deepEqual(page.addresses, []);
  assert.equal(page.total, 0);
});

test("reports when there is no mailbox to search", async () => {
  const otherCompany = testCompanyId();
  const lonely = await insert(Customer, {
    companyId: otherCompany,
    name: "Acme",
    slug: "acme",
    email: "billing@acme.com",
    domain: "acme.com",
  });

  const page = await listCustomerMail(otherCompany, lonely);
  assert.equal(page.mailboxCount, 0);
  assert.equal(page.total, 0);
  assert.deepEqual(page.threads, []);
});
