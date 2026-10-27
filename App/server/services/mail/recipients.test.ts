import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { CompanyPolicy } from "../../db/entities/CompanyPolicy.js";
import { Contact } from "../../db/entities/Contact.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Suppression, type SuppressionReason } from "../../db/entities/Suppression.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { policyBlockedRecipients } from "../companyPolicies.js";
import { indexMailboxAddresses } from "./addressIndex.js";
import {
  checkRecipients,
  cleanDisplayName,
  isAutomatedAddress,
  namedAddresses,
  prefixUpperBound,
  suggestRecipients,
} from "./recipients.js";

/**
 * The two reads behind the To / Cc / Bcc chips: the mailbox's address book,
 * and the check that turns a chip red before Send. Both run against a real
 * (in-memory) database with the real address indexer filling
 * `mail_message_addresses`, because what matters is which rows the indexed
 * reads reach — another mailbox's people, the mailbox itself and machine
 * senders must never come back.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const SELF = "owner@oneuptime.example";

let companyId: string;
let account: MailAccount;
let clock = Date.parse("2026-10-01T09:00:00Z");

async function mailbox(overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId,
    connectionId: `connection_${randomUUID()}`,
    provider: "gmail",
    address: SELF,
    status: "active",
    ...overrides,
  });
}

/** One mirrored message, each a minute newer than the last. */
async function message(
  into: MailAccount,
  fields: Partial<MailMessage> & Pick<MailMessage, "fromEmail">,
): Promise<MailMessage> {
  clock += 60_000;
  const suffix = randomUUID();
  return insert(MailMessage, {
    companyId: into.companyId,
    accountId: into.id,
    threadId: `thread_${suffix}`,
    gmailMessageId: `gmail_${suffix}`,
    gmailThreadId: `gmail_thread_${suffix}`,
    toEmails: SELF,
    subject: "Status page",
    bodyText: "Hello",
    createdAt: new Date(clock),
    sentAt: new Date(clock),
    ...fields,
  });
}

async function index(...accounts: MailAccount[]): Promise<void> {
  for (const each of accounts) {
    await indexMailboxAddresses(each, { now: new Date(clock + 60 * 60_000) });
  }
}

beforeEach(async () => {
  companyId = testCompanyId();
  account = await mailbox();
});

describe("reading names out of address headers", () => {
  test("keeps quoted names whole, decodes encoded words, and skips what is not an address", () => {
    assert.deepEqual(
      namedAddresses(
        '"Menzel, Felix" <Felix@Assense.example>, =?UTF-8?B?Wm/Dqw==?= <zoe@acme.example>, not-an-address, bare@acme.example',
      ),
      [
        { email: "felix@assense.example", name: "Menzel, Felix" },
        { email: "zoe@acme.example", name: "Zoë" },
        { email: "bare@acme.example", name: "" },
      ],
    );
  });

  test("never shows an address, or quote marks, as somebody's name", () => {
    assert.deepEqual(namedAddresses("'ana@acme.example' <ana@acme.example>"), [
      { email: "ana@acme.example", name: "" },
    ]);
    assert.equal(cleanDisplayName("'Ana Lima'"), "Ana Lima");
    assert.equal(cleanDisplayName("  "), "");
    assert.equal(cleanDisplayName("x".repeat(500)).length, 200);
    assert.deepEqual(namedAddresses(""), []);
    assert.deepEqual(namedAddresses(null), []);
  });

  test("bounds a key range just past every string with the prefix", () => {
    assert.equal(prefixUpperBound("fel"), "fem");
    assert.equal(prefixUpperBound("a"), "b");
    assert.ok("felix@x" >= "fel" && "felix@x" < prefixUpperBound("fel"));
    assert.ok(!("fem@x" < prefixUpperBound("fel")));
  });

  test("recognises machine senders nobody writes to", () => {
    for (const address of [
      "noreply@github.example",
      "no-reply@stripe.example",
      "donotreply@bank.example",
      "do-not-reply@bank.example",
      "mailer-daemon@googlemail.example",
      "postmaster@acme.example",
      "bounces+123@mail.example",
    ]) {
      assert.equal(isAutomatedAddress(address), true, address);
    }
    for (const address of [
      "noreen@acme.example",
      "replyguy@acme.example",
      "felix@assense.example",
    ]) {
      assert.equal(isAutomatedAddress(address), false, address);
    }
  });
});

describe("the mailbox's address book", () => {
  async function seed() {
    for (let index = 0; index < 5; index += 1) {
      await message(account, {
        fromName: "Felix Menzel",
        fromEmail: "felix.menzel@assense.example",
        toEmails: `Owner <${SELF}>`,
        ccEmails: index < 3 ? "Support <support@oneuptime.example>" : "",
      });
    }
    await message(account, {
      fromName: "Owner",
      fromEmail: SELF,
      toEmails:
        '"Felix (Assense)" <felix.menzel@assense.example>, "Berg, Anna" <anna@assense.example>',
    });
    await message(account, {
      fromName: "Owner",
      fromEmail: SELF,
      toEmails: "anna@assense.example",
    });
    await message(account, { fromName: "Fiona Apple", fromEmail: "fiona@music.example" });
    await message(account, { fromName: "GitHub", fromEmail: "noreply@github.example" });
    // Another mailbox of the same company, and another company entirely.
    const other = await mailbox({ address: "sales@oneuptime.example" });
    await message(other, { fromName: "Felix Other", fromEmail: "felix.other@assense.example" });
    const stranger = await insert(MailAccount, {
      companyId: testCompanyId(),
      connectionId: `connection_${randomUUID()}`,
      provider: "gmail",
      address: SELF,
      status: "active",
    });
    await message(stranger, {
      fromName: "Felix Elsewhere",
      fromEmail: "felix.elsewhere@assense.example",
    });
    await index(account, other, stranger);
  }

  test("an empty query lists the people this mailbox writes with most, without itself or robots", async () => {
    await seed();
    const people = await suggestRecipients(account, "");
    assert.deepEqual(
      people.map((person) => [person.email, person.count]),
      [
        ["felix.menzel@assense.example", 6],
        ["support@oneuptime.example", 3],
        ["anna@assense.example", 2],
        ["fiona@music.example", 1],
      ],
    );
    assert.ok(people.every((person) => person.lastAt && !Number.isNaN(Date.parse(person.lastAt))));
  });

  test("prefers the name a person signs their own mail with", async () => {
    await seed();
    const [felix] = await suggestRecipients(account, "felix");
    assert.equal(felix.email, "felix.menzel@assense.example");
    assert.equal(felix.name, "Felix Menzel");
    const [anna] = await suggestRecipients(account, "anna");
    assert.equal(anna.name, "Berg, Anna");
  });

  test("matches the start of an address, ranked by how often the mailbox wrote with them", async () => {
    await seed();
    assert.deepEqual(
      (await suggestRecipients(account, "f")).map((person) => person.email),
      ["felix.menzel@assense.example", "fiona@music.example"],
    );
    assert.deepEqual(
      (await suggestRecipients(account, "FE")).map((person) => person.email),
      ["felix.menzel@assense.example"],
    );
    assert.deepEqual(
      (await suggestRecipients(account, "felix.menzel@assense.example")).map((p) => p.email),
      ["felix.menzel@assense.example"],
    );
  });

  test("finds everyone at a company from the start of its domain", async () => {
    await seed();
    assert.deepEqual(
      (await suggestRecipients(account, "assense")).map((person) => person.email),
      ["felix.menzel@assense.example", "anna@assense.example"],
    );
    assert.deepEqual(
      (await suggestRecipients(account, "@assense")).map((person) => person.email),
      ["felix.menzel@assense.example", "anna@assense.example"],
    );
  });

  test("finds a person by a word of their name", async () => {
    await seed();
    assert.deepEqual(
      (await suggestRecipients(account, "menzel")).map((person) => person.email),
      ["felix.menzel@assense.example"],
    );
    assert.deepEqual(
      (await suggestRecipients(account, "berg")).map((person) => person.email),
      ["anna@assense.example"],
    );
  });

  test("never offers the mailbox itself, a machine sender, or another mailbox's people", async () => {
    await seed();
    assert.deepEqual(await suggestRecipients(account, "owner"), []);
    assert.deepEqual(await suggestRecipients(account, "noreply"), []);
    assert.deepEqual(await suggestRecipients(account, "felix.other"), []);
    assert.deepEqual(await suggestRecipients(account, "felix.elsewhere"), []);
    assert.deepEqual(await suggestRecipients(account, "zzz"), []);
  });

  test("offers a correspondent the indexer has not reached yet", async () => {
    await seed();
    await message(account, { fromName: "Gabe New", fromEmail: "gabe@newco.example" });
    const [gabe] = await suggestRecipients(account, "gabe");
    assert.equal(gabe.email, "gabe@newco.example");
    assert.equal(gabe.name, "Gabe New");
  });

  test("respects the limit", async () => {
    await seed();
    assert.equal((await suggestRecipients(account, "", 2)).length, 2);
    assert.equal((await suggestRecipients(account, "", 0)).length, 1);
    assert.equal((await suggestRecipients(account, "", 500)).length, 4);
  });

  test("names someone only older mail mentions, from a sample of that mail", async () => {
    await message(account, { fromName: "Old Friend", fromEmail: "old@friend.example" });
    const repo = AppDataSource.getRepository(MailMessage);
    const newer: Partial<MailMessage>[] = [];
    for (let index = 0; index < 420; index += 1) {
      clock += 1_000;
      newer.push({
        companyId: account.companyId,
        accountId: account.id,
        threadId: `thread_bulk_${index}`,
        gmailMessageId: `gmail_bulk_${index}`,
        gmailThreadId: `gmail_thread_bulk_${index}`,
        fromName: "Busy Person",
        fromEmail: "busy@acme.example",
        toEmails: SELF,
        createdAt: new Date(clock),
      });
    }
    for (let start = 0; start < newer.length; start += 100) {
      await repo.insert(newer.slice(start, start + 100));
    }
    await index(account);

    const [old] = await suggestRecipients(account, "old");
    assert.equal(old.email, "old@friend.example");
    assert.equal(old.name, "Old Friend");
    assert.equal(old.count, 1);
    // Outside the newest window, so its recency is not known.
    assert.equal(old.lastAt, null);
  });
});

describe("checking recipients before Send", () => {
  async function suppress(email: string, reason: SuppressionReason, company = companyId) {
    await insert(Suppression, { companyId: company, email, reason, source: "test", notes: "" });
  }

  test("an ordinary list has nobody to flag", async () => {
    assert.deepEqual(
      await checkRecipients(companyId, { to: "felix@assense.example", cc: "anna@assense.example" }),
      [],
    );
    assert.deepEqual(await checkRecipients(companyId, {}), []);
  });

  test("says why each suppressed address is on the list", async () => {
    const reasons: SuppressionReason[] = [
      "unsubscribe",
      "bounce",
      "complaint",
      "manual",
      "imported",
    ];
    for (const reason of reasons) await suppress(`${reason}@acme.example`, reason);
    const blocked = await checkRecipients(companyId, {
      to: reasons.map((reason) => `${reason}@acme.example`).join(", "),
    });
    assert.deepEqual(
      blocked.map((row) => [row.email, row.reason, row.detail]),
      [
        [
          "unsubscribe@acme.example",
          "suppressed",
          "Unsubscribed — on this company's do-not-email list",
        ],
        ["bounce@acme.example", "suppressed", "Bounced — on this company's do-not-email list"],
        [
          "complaint@acme.example",
          "suppressed",
          "Marked as spam — on this company's do-not-email list",
        ],
        ["manual@acme.example", "suppressed", "Added by hand to this company's do-not-email list"],
        ["imported@acme.example", "suppressed", "Imported onto this company's do-not-email list"],
      ],
    );
  });

  test("reads display names and case the way the send gate does", async () => {
    await suppress("support@oneuptime.example", "manual");
    const blocked = await checkRecipients(companyId, {
      to: "felix@assense.example",
      cc: '"Support Desk" <SUPPORT@OneUptime.example>',
    });
    assert.deepEqual(
      blocked.map((row) => row.email),
      ["support@oneuptime.example"],
    );
  });

  test("flags a Contact marked do not contact", async () => {
    await insert(Contact, {
      companyId,
      name: "Dee",
      email: "dee@acme.example",
      doNotContact: true,
    });
    await insert(Contact, { companyId, name: "Ok", email: "ok@acme.example", doNotContact: false });
    assert.deepEqual(
      await checkRecipients(companyId, { bcc: "dee@acme.example, ok@acme.example" }),
      [
        {
          email: "dee@acme.example",
          reason: "do_not_contact",
          detail: "Marked do not contact — on this company's do-not-email list",
        },
      ],
    );
  });

  test("flags a Policy's blocked domain, subdomains included, naming the policy", async () => {
    await insert(CompanyPolicy, {
      companyId,
      title: "No competitors",
      body: "",
      blockedRecipientDomains: "rival.example\n",
      forbiddenTools: "",
      enabled: true,
    });
    const blocked = await checkRecipients(companyId, {
      to: "ceo@rival.example, eu@mail.rival.example, felix@assense.example",
    });
    assert.deepEqual(
      blocked.map((row) => [row.email, row.reason, row.detail]),
      [
        ["ceo@rival.example", "policy", "Blocked by the policy “No competitors”"],
        ["eu@mail.rival.example", "policy", "Blocked by the policy “No competitors”"],
      ],
    );
  });

  test("lists each address once, in the order written, under its first reason", async () => {
    await suppress("both@rival.example", "bounce");
    await insert(Contact, {
      companyId,
      name: "Both",
      email: "both@rival.example",
      doNotContact: true,
    });
    await insert(CompanyPolicy, {
      companyId,
      title: "No competitors",
      body: "",
      blockedRecipientDomains: "rival.example",
      forbiddenTools: "",
      enabled: true,
    });
    const blocked = await checkRecipients(companyId, {
      to: "ceo@rival.example",
      cc: "both@rival.example",
      bcc: "both@rival.example, CEO@rival.example",
    });
    assert.deepEqual(
      blocked.map((row) => [row.email, row.reason]),
      [
        ["ceo@rival.example", "policy"],
        ["both@rival.example", "suppressed"],
      ],
    );
  });

  test("another company's list never applies", async () => {
    await suppress("felix@assense.example", "unsubscribe", testCompanyId());
    assert.deepEqual(await checkRecipients(companyId, { to: "felix@assense.example" }), []);
  });
});

describe("policyBlockedRecipients", () => {
  test("ignores a disabled policy and reports the first one that blocks", async () => {
    await insert(CompanyPolicy, {
      companyId,
      title: "Off",
      body: "",
      blockedRecipientDomains: "acme.example",
      forbiddenTools: "",
      enabled: false,
      sortOrder: 0,
    });
    await insert(CompanyPolicy, {
      companyId,
      title: "First",
      body: "",
      blockedRecipientDomains: "rival.example",
      forbiddenTools: "",
      enabled: true,
      sortOrder: 1,
    });
    await insert(CompanyPolicy, {
      companyId,
      title: "Second",
      body: "",
      blockedRecipientDomains: "rival.example\nother.example",
      forbiddenTools: "",
      enabled: true,
      sortOrder: 2,
    });
    assert.deepEqual(
      await policyBlockedRecipients(companyId, [
        " CEO@rival.example ",
        "a@acme.example",
        "b@other.example",
        "",
      ]),
      [
        { address: "ceo@rival.example", policyTitle: "First" },
        { address: "b@other.example", policyTitle: "Second" },
      ],
    );
    assert.deepEqual(await policyBlockedRecipients(companyId, []), []);
  });
});
