import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Deal } from "../db/entities/Deal.js";
import { DealContact } from "../db/entities/DealContact.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership } from "../db/entities/Membership.js";
import { Suppression } from "../db/entities/Suppression.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  compareSuggestions,
  deliveredAddresses,
  isBillingMailbox,
  isBillingRole,
  listRecipientSuggestions,
  MAX_RECIPIENT_SUGGESTIONS,
  mergeCandidates,
  rankSuggestions,
  type RecipientCandidate,
  type RecipientSuggestion,
  suggestionAddress,
  suggestionTier,
} from "./recipientSuggestions.js";

/**
 * Who the send dialog offers for an invoice or estimate email, and in what
 * order. The pure parts — reading a role as billing, merging one person found
 * several ways, ranking — are checked on their own; the rest against a real
 * database, where the guards that matter live: the free-mail and own-domain
 * rule, archived and do-not-contact people, suppressions, and other companies'
 * rows that happen to carry the same ids or domain.
 */

describe("isBillingRole", () => {
  test("reads billing and finance roles and titles as billing", () => {
    for (const role of [
      "Accounts Payable",
      "accounts payable clerk",
      "AP Clerk",
      "A/P",
      "Accounts receivable",
      "Payables",
      "Billing",
      "Billing contact",
      "Invoicing",
      "Finance",
      "VP, Finance",
      "Finance Director",
      "Chief Financial Officer",
      "CFO",
      "Financial Controller",
      "Controller",
      "Accounting Manager",
      "Accountant",
      "Bookkeeper",
      "Treasurer",
      "Accounts",
      "Accounts team",
    ]) {
      assert.equal(isBillingRole(role), true, role);
    }
  });

  test("leaves sales, engineering and deal roles alone", () => {
    for (const role of [
      "",
      "   ",
      "Account Manager",
      "Account Executive",
      "Key accounts lead",
      "CTO",
      "Head of Engineering",
      "Champion",
      "Economic buyer",
      "Apprentice",
      "Happy customer",
      "Procurement",
    ]) {
      assert.equal(isBillingRole(role), false, role);
    }
    assert.equal(isBillingRole(null), false);
    assert.equal(isBillingRole(undefined), false);
  });
});

describe("isBillingMailbox", () => {
  test("reads shared finance mailboxes as billing", () => {
    for (const email of [
      "ap@acme.com",
      "AP@acme.com",
      "billing@acme.com",
      "accounts@acme.com",
      "accounts.payable@acme.com",
      "accounts-payable@acme.com",
      "accounts_payable@acme.com",
      "invoices+acme@acme.com",
      "finance.team@acme.com",
      "remittance@acme.com",
    ]) {
      assert.equal(isBillingMailbox(email), true, email);
    }
  });

  test("leaves people and other shared mailboxes alone", () => {
    for (const email of [
      "jane@acme.com",
      "apple@acme.com",
      "sales@acme.com",
      "support@acme.com",
      "@acme.com",
      "not-an-address",
    ]) {
      assert.equal(isBillingMailbox(email), false, email);
    }
  });
});

describe("suggestionAddress", () => {
  test("offers the bare, lowercased address", () => {
    assert.equal(suggestionAddress("  Jane Doe <JANE@Acme.COM> "), "jane@acme.com");
    assert.equal(suggestionAddress("o'neil@acme.com"), "o'neil@acme.com");
  });

  test("offers nothing the send endpoint would refuse", () => {
    for (const raw of ["", "   ", "not an email", "jane@acme", "a!b@acme.com", "a..b@acme.com"]) {
      assert.equal(suggestionAddress(raw), null, raw);
    }
    assert.equal(suggestionAddress(null), null);
    assert.equal(suggestionAddress(`${"a".repeat(320)}@acme.com`), null);
  });
});

describe("deliveredAddresses", () => {
  test("reads the To and Cc of a delivered Member send", () => {
    assert.deepEqual(
      deliveredAddresses(
        JSON.stringify({
          status: "sent",
          toAddress: "Billing@Acme.com, ap@acme.com",
          ccAddress: "finance@northwind.test",
        }),
      ),
      ["billing@acme.com", "ap@acme.com", "finance@northwind.test"],
    );
  });

  test("reads an AI Employee's send, which records sendStatus and To", () => {
    assert.deepEqual(
      deliveredAddresses(JSON.stringify({ sendStatus: "sent", toAddress: "ap@acme.com" })),
      ["ap@acme.com"],
    );
  });

  test("reads nobody from a failed or skipped attempt, or from metadata it cannot parse", () => {
    for (const metadata of [
      JSON.stringify({ status: "failed", toAddress: "ap@acme.com" }),
      JSON.stringify({ status: "skipped", toAddress: "ap@acme.com" }),
      JSON.stringify({ sendStatus: "failed", toAddress: "ap@acme.com" }),
      JSON.stringify({ toAddress: "ap@acme.com" }),
      JSON.stringify({ status: "sent", toAddress: 7 }),
      JSON.stringify({ status: "sent", toAddress: "not an address" }),
      "{not json",
      "",
    ]) {
      assert.deepEqual(deliveredAddresses(metadata), [], metadata);
    }
  });
});

function candidate(
  email: string,
  source: RecipientCandidate["source"],
  extra: Partial<RecipientCandidate> = {},
): RecipientCandidate {
  return { email, name: "", role: "", source, ...extra };
}

function suggestion(email: string, extra: Partial<RecipientSuggestion> = {}): RecipientSuggestion {
  return {
    email,
    name: "",
    role: "",
    primary: false,
    billing: false,
    sources: ["domain"],
    dealTitle: null,
    lastEmailedAt: null,
    ...extra,
  };
}

describe("mergeCandidates", () => {
  test("one suggestion per address, however it was written and however often it was found", () => {
    const merged = mergeCandidates([
      candidate("JANE@acme.com", "domain", { name: "J. Doe", role: "Engineer" }),
      candidate("jane@acme.com", "customer_contact", { name: "Jane Doe", role: "" }),
      candidate("Jane Doe <jane@ACME.com>", "deal", {
        name: "Jane",
        role: "Champion",
        dealTitle: "Acme renewal",
      }),
    ]);
    assert.equal(merged.length, 1);
    const [jane] = merged;
    assert.equal(jane.email, "jane@acme.com");
    // The strongest source names the person, whatever order they were found in.
    assert.equal(jane.name, "Jane Doe");
    // …and the strongest source that has a role gives it.
    assert.equal(jane.role, "Champion");
    assert.deepEqual(jane.sources, ["customer_contact", "deal", "domain"]);
    assert.equal(jane.dealTitle, "Acme renewal");
  });

  test("is billing when any of a person's roles, or their mailbox, says so", () => {
    const merged = mergeCandidates([
      candidate("pat@acme.com", "customer_contact", { name: "Pat", role: "Project lead" }),
      candidate("pat@acme.com", "revenue_contact", { name: "Pat", role: "Finance Director" }),
      candidate("ap@acme.com", "domain"),
      candidate("office@acme.com", "billing_email"),
      candidate("sam@acme.com", "domain", { role: "Engineer" }),
    ]);
    const byEmail = new Map(merged.map((row) => [row.email, row]));
    assert.equal(merged.length, 4);
    assert.equal(byEmail.get("pat@acme.com")?.billing, true);
    assert.equal(byEmail.get("pat@acme.com")?.role, "Project lead");
    assert.equal(byEmail.get("ap@acme.com")?.billing, true);
    assert.equal(byEmail.get("office@acme.com")?.billing, true);
    assert.equal(byEmail.get("sam@acme.com")?.billing, false);
  });

  test("keeps the primary flag from whichever source has it, and drops addresses it cannot send to", () => {
    const merged = mergeCandidates([
      candidate("lee@acme.com", "revenue_contact"),
      candidate("lee@acme.com", "customer_contact", { primary: true }),
      candidate("not an address", "customer_contact", { name: "Nobody" }),
      candidate("", "customer_contact", { name: "Blank" }),
    ]);
    assert.deepEqual(
      merged.map((row) => [row.email, row.primary]),
      [["lee@acme.com", true]],
    );
  });

  test("carries when each address was last emailed", () => {
    const at = new Date("2026-09-01T10:00:00.000Z");
    const [row] = mergeCandidates(
      [candidate("lee@acme.com", "domain")],
      new Map([["lee@acme.com", at]]),
    );
    assert.equal(row.lastEmailedAt, at.toISOString());
  });
});

describe("rankSuggestions", () => {
  test("billing first, then whoever was emailed most recently, then the rest", () => {
    const ranked = rankSuggestions([
      suggestion("never@acme.com", { name: "Never Emailed", sources: ["revenue_contact"] }),
      suggestion("older@acme.com", { lastEmailedAt: "2026-08-01T00:00:00.000Z" }),
      suggestion("primary@acme.com", { primary: true, sources: ["customer_contact"] }),
      suggestion("recent@acme.com", { lastEmailedAt: "2026-09-20T00:00:00.000Z" }),
      suggestion("ap@acme.com", { billing: true, sources: ["domain"] }),
      suggestion("billing@acme.com", { billing: true, sources: ["billing_email"] }),
      suggestion("cfo@acme.com", { billing: true, primary: true, sources: ["customer_contact"] }),
    ]);
    assert.deepEqual(
      ranked.map((row) => row.email),
      [
        "billing@acme.com",
        "cfo@acme.com",
        "ap@acme.com",
        "primary@acme.com",
        "recent@acme.com",
        "older@acme.com",
        "never@acme.com",
      ],
    );
    assert.deepEqual(
      ranked.map((row) => suggestionTier(row)),
      [0, 0, 0, 0, 1, 1, 2],
    );
  });

  test("among equals, the more recently emailed billing person leads", () => {
    const ranked = rankSuggestions([
      suggestion("a@acme.com", { billing: true, lastEmailedAt: "2026-08-01T00:00:00.000Z" }),
      suggestion("b@acme.com", { billing: true, lastEmailedAt: "2026-09-01T00:00:00.000Z" }),
      suggestion("c@acme.com", { billing: true }),
    ]);
    assert.deepEqual(
      ranked.map((row) => row.email),
      ["b@acme.com", "a@acme.com", "c@acme.com"],
    );
  });

  test("never-emailed people go by how closely they are tied to the account, then by name", () => {
    const ranked = rankSuggestions([
      suggestion("zed@acme.com", { name: "Zed", sources: ["domain"] }),
      suggestion("amy@acme.com", { name: "amy", sources: ["domain"] }),
      suggestion("bob@acme.com", { name: "Bob", sources: ["deal"] }),
      suggestion("cat@acme.com", { name: "Cat", sources: ["revenue_contact", "domain"] }),
      suggestion("dan@acme.com", { name: "Dan", sources: ["customer_contact"] }),
      suggestion("nameless@acme.com", { sources: ["domain"] }),
    ]);
    assert.deepEqual(
      ranked.map((row) => row.email),
      [
        "dan@acme.com",
        "cat@acme.com",
        "bob@acme.com",
        "amy@acme.com",
        "nameless@acme.com",
        "zed@acme.com",
      ],
    );
  });

  test("is a total order: ties break on the address, and the input is not reordered", () => {
    const input = [suggestion("b@acme.com"), suggestion("a@acme.com")];
    const ranked = rankSuggestions(input);
    assert.deepEqual(
      ranked.map((row) => row.email),
      ["a@acme.com", "b@acme.com"],
    );
    assert.deepEqual(
      input.map((row) => row.email),
      ["b@acme.com", "a@acme.com"],
    );
    assert.equal(compareSuggestions(input[0], input[0]), 0);
  });
});

// ───────────────────────────── against the database ─────────────────────────────

let companyId: string;
let otherCompanyId: string;
let customer: Customer;
let stageId: string;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  otherCompanyId = testCompanyId();
  stageId = randomUUID();
  customer = await insert(Customer, {
    companyId,
    name: "OptionMetrics",
    slug: "optionmetrics",
    email: "Billing@OptionMetrics.com",
    domain: "optionmetrics.com",
  });
});

async function contact(values: Partial<Contact> & Pick<Contact, "name" | "email">) {
  return insert(Contact, { companyId, ...values });
}

async function deal(values: Partial<Deal> = {}) {
  return insert(Deal, {
    companyId,
    title: "Renewal",
    stageId,
    customerId: customer.id,
    ...values,
  });
}

async function list(limit?: number) {
  return listRecipientSuggestions(companyId, customer, { limit });
}

function emails(result: { suggestions: RecipientSuggestion[] }): string[] {
  return result.suggestions.map((row) => row.email);
}

describe("listRecipientSuggestions", () => {
  test("offers the billing email, billing contacts, linked contacts, deal people and people at the domain", async () => {
    await insert(CustomerContact, {
      companyId,
      customerId: customer.id,
      name: "Priya Shah",
      email: "priya@optionmetrics.com",
      role: "Accounts payable",
      isPrimary: true,
      sortOrder: 0,
    });
    await insert(CustomerContact, {
      companyId,
      customerId: customer.id,
      name: "Phone Only",
      email: "",
      sortOrder: 1,
    });
    await contact({
      name: "Linked Lin",
      email: "lin@lin-consulting.example",
      title: "Advisor",
      customerId: customer.id,
    });
    const champion = await contact({ name: "Chad Champion", email: "chad@optionmetrics.com" });
    const buyer = await contact({ name: "Erin Buyer", email: "erin@buyers.example", title: "COO" });
    const renewal = await deal({ title: "2027 renewal", primaryContactId: champion.id });
    await insert(DealContact, {
      companyId,
      dealId: renewal.id,
      contactId: buyer.id,
      role: "Economic buyer",
    });
    await contact({ name: "Sub Domain", email: "sub@eu.optionmetrics.com", title: "Analyst" });
    await contact({ name: "Look Alike", email: "fake@notoptionmetrics.com" });

    const result = await list();

    assert.equal(result.domain, "optionmetrics.com");
    const byEmail = new Map(result.suggestions.map((row) => [row.email, row]));
    assert.deepEqual([...byEmail.keys()].sort(), [
      "billing@optionmetrics.com",
      "chad@optionmetrics.com",
      "erin@buyers.example",
      "lin@lin-consulting.example",
      "priya@optionmetrics.com",
      "sub@eu.optionmetrics.com",
    ]);
    assert.deepEqual(byEmail.get("billing@optionmetrics.com"), {
      email: "billing@optionmetrics.com",
      name: "",
      role: "",
      primary: false,
      billing: true,
      sources: ["billing_email"],
      dealTitle: null,
      lastEmailedAt: null,
    });
    assert.equal(byEmail.get("priya@optionmetrics.com")?.primary, true);
    assert.equal(byEmail.get("priya@optionmetrics.com")?.billing, true);
    assert.equal(byEmail.get("priya@optionmetrics.com")?.name, "Priya Shah");
    assert.equal(byEmail.get("priya@optionmetrics.com")?.role, "Accounts payable");
    // A billing contact is not a Revenue contact, so the domain did not find her too.
    assert.deepEqual(byEmail.get("priya@optionmetrics.com")?.sources, ["customer_contact"]);
    assert.deepEqual(byEmail.get("chad@optionmetrics.com")?.sources, ["deal", "domain"]);
    assert.equal(byEmail.get("chad@optionmetrics.com")?.dealTitle, "2027 renewal");
    assert.equal(byEmail.get("erin@buyers.example")?.role, "Economic buyer");
    assert.deepEqual(byEmail.get("lin@lin-consulting.example")?.sources, ["revenue_contact"]);
    assert.deepEqual(byEmail.get("sub@eu.optionmetrics.com")?.sources, ["domain"]);

    // Billing and the primary contact lead.
    assert.deepEqual(emails(result).slice(0, 2), [
      "billing@optionmetrics.com",
      "priya@optionmetrics.com",
    ]);
  });

  test("merges a billing contact who is also a Revenue contact at the domain into one suggestion", async () => {
    await insert(CustomerContact, {
      companyId,
      customerId: customer.id,
      name: "Priya Shah",
      email: "Priya@OptionMetrics.com",
      role: "",
    });
    await contact({
      name: "Priya S.",
      email: "priya@optionmetrics.com",
      title: "Finance Director",
    });

    const result = await list();
    const priya = result.suggestions.filter((row) => row.email === "priya@optionmetrics.com");
    assert.equal(priya.length, 1);
    assert.equal(priya[0].name, "Priya Shah");
    assert.equal(priya[0].role, "Finance Director");
    assert.equal(priya[0].billing, true);
    assert.deepEqual(priya[0].sources, ["customer_contact", "domain"]);
  });

  test("never matches a free-mail domain as a whole, only people tied to the account", async () => {
    customer.domain = "gmail.com";
    customer.email = "owner.acme@gmail.com";
    await AppDataSource.getRepository(Customer).save(customer);
    await contact({ name: "Stranger", email: "stranger@gmail.com" });
    await contact({ name: "Another Stranger", email: "another@outlook.com" });
    await contact({ name: "Linked Owner", email: "linked@gmail.com", customerId: customer.id });

    const result = await list();

    assert.equal(result.domain, null);
    assert.deepEqual(emails(result).sort(), ["linked@gmail.com", "owner.acme@gmail.com"]);
  });

  test("matches the domain exactly, though LIKE reads an underscore in it as any character", async () => {
    customer.domain = "option_metrics.com";
    await AppDataSource.getRepository(Customer).save(customer);
    await contact({ name: "Wildcard Match", email: "wrong@optionxmetrics.com" });
    await contact({ name: "Subdomain Wildcard", email: "wrong@eu.optionxmetrics.com" });

    const result = await list();

    assert.equal(result.domain, "option_metrics.com");
    assert.deepEqual(emails(result), ["billing@optionmetrics.com"]);
  });

  test("never matches the company's own domain, which would suggest every colleague", async () => {
    const colleague = await insert(User, {
      email: `colleague-${randomUUID()}@optionmetrics.com`,
      name: "Colleague",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId, userId: colleague.id, role: "member" });
    await contact({ name: "Internal Person", email: "internal@optionmetrics.com" });

    const result = await list();

    assert.equal(result.domain, null);
    assert.deepEqual(emails(result), ["billing@optionmetrics.com"]);
  });

  test("leaves out archived contacts and the people on archived deals", async () => {
    await contact({
      name: "Archived Linked",
      email: "archived-linked@elsewhere.example",
      customerId: customer.id,
      archivedAt: new Date(),
    });
    await contact({
      name: "Archived At Domain",
      email: "archived@optionmetrics.com",
      archivedAt: new Date(),
    });
    const archivedChampion = await contact({
      name: "Archived Champion",
      email: "champ@deals.example",
      archivedAt: new Date(),
    });
    await deal({ primaryContactId: archivedChampion.id });
    const liveButOnArchivedDeal = await contact({ name: "Old Deal", email: "old@deals.example" });
    await deal({ primaryContactId: liveButOnArchivedDeal.id, archivedAt: new Date() });

    const result = await list();

    assert.deepEqual(emails(result), ["billing@optionmetrics.com"]);
  });

  test("never reaches into another company's rows, even with the same customer id or domain", async () => {
    await insert(CustomerContact, {
      companyId: otherCompanyId,
      customerId: customer.id,
      name: "Other Company Billing",
      email: "other-billing@elsewhere.example",
    });
    await insert(Contact, {
      companyId: otherCompanyId,
      customerId: customer.id,
      name: "Other Company Linked",
      email: "other-linked@elsewhere.example",
    });
    await insert(Contact, {
      companyId: otherCompanyId,
      name: "Other Company At Domain",
      email: "someone@optionmetrics.com",
    });
    const theirs = await insert(Contact, {
      companyId: otherCompanyId,
      name: "Their Champion",
      email: "their-champion@elsewhere.example",
    });
    await insert(Deal, {
      companyId: otherCompanyId,
      title: "Their deal",
      stageId,
      customerId: customer.id,
      primaryContactId: theirs.id,
    });
    // Our own deal naming their Contact by id must not leak it either.
    await deal({ primaryContactId: theirs.id });

    const result = await list();

    assert.deepEqual(emails(result), ["billing@optionmetrics.com"]);
  });

  test("never suggests a person marked Do not contact, or a suppressed address", async () => {
    await insert(CustomerContact, {
      companyId,
      customerId: customer.id,
      name: "Do Not Contact",
      email: "dnc@optionmetrics.com",
    });
    // The flag lives on a Revenue contact nobody linked to this account.
    await insert(Contact, {
      companyId,
      name: "DNC",
      email: "dnc@optionmetrics.com",
      doNotContact: true,
      archivedAt: new Date(),
    });
    await contact({
      name: "Linked DNC",
      email: "linked-dnc@elsewhere.example",
      customerId: customer.id,
      doNotContact: true,
    });
    await contact({ name: "Bounced", email: "bounced@optionmetrics.com" });
    await insert(Suppression, { companyId, email: "bounced@optionmetrics.com", reason: "bounce" });
    // A suppression in another company says nothing about this one.
    await contact({ name: "Fine Here", email: "fine@optionmetrics.com" });
    await insert(Suppression, {
      companyId: otherCompanyId,
      email: "fine@optionmetrics.com",
      reason: "manual",
    });

    const result = await list();

    assert.deepEqual(emails(result).sort(), [
      "billing@optionmetrics.com",
      "fine@optionmetrics.com",
    ]);
  });

  test("ranks people by when this customer's documents were last emailed to them", async () => {
    await contact({ name: "Alice Early", email: "alice@optionmetrics.com" });
    await contact({ name: "Bob Recent", email: "bob@optionmetrics.com" });
    await contact({ name: "Carol Never", email: "carol@optionmetrics.com" });
    await contact({ name: "Dave Failed", email: "dave@optionmetrics.com" });
    const invoice = await insert(Invoice, {
      companyId,
      customerId: customer.id,
      slug: "optionmetrics-inv-0001",
      number: "OPTIONMETRICS-INV-0001",
      status: "sent",
      currency: "USD",
      issueDate: new Date("2026-08-01T00:00:00.000Z"),
      dueDate: new Date("2026-08-31T00:00:00.000Z"),
    });
    const estimate = await insert(Estimate, {
      companyId,
      customerId: customer.id,
      slug: "optionmetrics-est-0001",
      number: "OPTIONMETRICS-EST-0001",
      status: "sent",
      currency: "USD",
      issueDate: new Date("2026-08-01T00:00:00.000Z"),
      validUntil: new Date("2026-08-31T00:00:00.000Z"),
    });
    const audit = (
      targetType: string,
      targetId: string,
      action: string,
      createdAt: string,
      metadata: Record<string, unknown>,
    ) =>
      insert(AuditEvent, {
        companyId,
        action,
        targetType,
        targetId,
        metadataJson: JSON.stringify(metadata),
        createdAt: new Date(createdAt),
      });
    await audit("invoice", invoice.id, "invoice.email.resend", "2026-08-05T09:00:00.000Z", {
      status: "sent",
      toAddress: "billing@optionmetrics.com",
      ccAddress: "alice@optionmetrics.com",
    });
    await audit("estimate", estimate.id, "finance.estimate.send", "2026-09-10T09:00:00.000Z", {
      status: "sent",
      toAddress: "bob@optionmetrics.com",
      ccAddress: "",
    });
    await audit("invoice", invoice.id, "invoice.email.resend", "2026-09-15T09:00:00.000Z", {
      status: "failed",
      toAddress: "dave@optionmetrics.com",
      ccAddress: "",
    });
    // Another customer's invoice, emailed to Carol, says nothing about this one.
    const otherCustomer = await insert(Customer, {
      companyId,
      name: "Elsewhere",
      slug: "elsewhere",
    });
    const otherInvoice = await insert(Invoice, {
      companyId,
      customerId: otherCustomer.id,
      slug: "elsewhere-inv-0001",
      status: "sent",
      currency: "USD",
      issueDate: new Date("2026-08-01T00:00:00.000Z"),
      dueDate: new Date("2026-08-31T00:00:00.000Z"),
    });
    await audit("invoice", otherInvoice.id, "invoice.email.resend", "2026-09-20T09:00:00.000Z", {
      status: "sent",
      toAddress: "carol@optionmetrics.com",
    });

    const result = await list();

    assert.deepEqual(emails(result), [
      "billing@optionmetrics.com",
      "bob@optionmetrics.com",
      "alice@optionmetrics.com",
      "carol@optionmetrics.com",
      "dave@optionmetrics.com",
    ]);
    const byEmail = new Map(result.suggestions.map((row) => [row.email, row]));
    assert.equal(byEmail.get("bob@optionmetrics.com")?.lastEmailedAt, "2026-09-10T09:00:00.000Z");
    assert.equal(
      byEmail.get("billing@optionmetrics.com")?.lastEmailedAt,
      "2026-08-05T09:00:00.000Z",
    );
    assert.equal(byEmail.get("carol@optionmetrics.com")?.lastEmailedAt, null);
    assert.equal(byEmail.get("dave@optionmetrics.com")?.lastEmailedAt, null);
  });

  test("counts outbound email with a Revenue contact as emailing them, and inbound as not", async () => {
    const wrote = await contact({ name: "We Wrote", email: "wrote@optionmetrics.com" });
    const heard = await contact({ name: "We Heard", email: "heard@optionmetrics.com" });
    await insert(Activity, {
      companyId,
      kind: "email_out",
      subject: "Your renewal",
      occurredAt: new Date("2026-09-01T12:00:00.000Z"),
      contactId: wrote.id,
    });
    await insert(Activity, {
      companyId,
      kind: "email_out",
      subject: "Earlier",
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
      contactId: wrote.id,
    });
    await insert(Activity, {
      companyId,
      kind: "email_in",
      subject: "Question",
      occurredAt: new Date("2026-09-05T12:00:00.000Z"),
      contactId: heard.id,
    });
    // An Activity another company recorded against the same Contact id.
    await insert(Activity, {
      companyId: otherCompanyId,
      kind: "email_out",
      subject: "Not ours",
      occurredAt: new Date("2026-09-09T12:00:00.000Z"),
      contactId: heard.id,
    });

    const result = await list();

    const byEmail = new Map(result.suggestions.map((row) => [row.email, row]));
    assert.equal(byEmail.get("wrote@optionmetrics.com")?.lastEmailedAt, "2026-09-01T12:00:00.000Z");
    assert.equal(byEmail.get("heard@optionmetrics.com")?.lastEmailedAt, null);
    assert.deepEqual(emails(result), [
      "billing@optionmetrics.com",
      "wrote@optionmetrics.com",
      "heard@optionmetrics.com",
    ]);
  });

  test("offers nothing for an account with no billing email and no people", async () => {
    customer.email = "";
    customer.domain = "";
    await AppDataSource.getRepository(Customer).save(customer);

    assert.deepEqual(await list(), { suggestions: [], domain: null });
  });

  test("returns at most the limit asked for, best first, within the hard ceiling", async () => {
    for (let index = 0; index < 8; index += 1) {
      await contact({ name: `Person ${index}`, email: `person${index}@optionmetrics.com` });
    }

    assert.equal((await list(3)).suggestions.length, 3);
    assert.equal((await list(3)).suggestions[0].email, "billing@optionmetrics.com");
    assert.equal((await list(0)).suggestions.length, 1);
    assert.equal((await list(MAX_RECIPIENT_SUGGESTIONS * 10)).suggestions.length, 9);
    assert.equal((await list()).suggestions.length, 9);
  });
});
