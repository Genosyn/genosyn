import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addMailRecipients,
  allMailRecipients,
  emptyMailRecipients,
  headerEntry,
  mailHeader,
  mailHeaders,
  mailRecipientProblem,
  mailRecipientsFrom,
  mailRecipientsSummary,
  MAX_MAIL_HEADER_CHARS,
  removeEverywhere,
  removeMailRecipient,
  sameMailRecipients,
  threadParticipants,
} from "./mailRecipients.js";
import { parseRecipients, type Recipient } from "./recipientTokens.js";

const ok = (email: string, name = ""): Recipient => ({ email, name, valid: true });
const emails = (items: Recipient[]) => items.map((item) => item.email);

describe("mailRecipientsFrom", () => {
  test("reads names and addresses from header strings", () => {
    const fields = mailRecipientsFrom({
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: '"Support, OneUptime" <support@oneuptime.com>, dana@acme.test',
    });
    assert.deepEqual(fields.to, [ok("felix.menzel@assense.com", "Felix Menzel")]);
    assert.deepEqual(fields.cc, [
      ok("support@oneuptime.com", "Support, OneUptime"),
      ok("dana@acme.test"),
    ]);
    assert.deepEqual(fields.bcc, []);
  });

  test("leaves the mailbox itself off, in any case", () => {
    const fields = mailRecipientsFrom(
      { to: "Me <ME@oneuptime.com>, felix@assense.com", cc: "me@oneuptime.com" },
      ["me@oneuptime.com"],
    );
    assert.deepEqual(emails(fields.to), ["felix@assense.com"]);
    assert.deepEqual(fields.cc, []);
  });

  test("keeps a person on the first line they appear on", () => {
    const fields = mailRecipientsFrom({
      to: "a@x.test",
      cc: "A@x.test, b@x.test",
      bcc: "b@x.test, c@x.test",
    });
    assert.deepEqual(emails(fields.to), ["a@x.test"]);
    assert.deepEqual(emails(fields.cc), ["b@x.test"]);
    assert.deepEqual(emails(fields.bcc), ["c@x.test"]);
  });

  test("an empty or missing header is no recipients", () => {
    assert.deepEqual(mailRecipientsFrom({}), emptyMailRecipients());
    assert.deepEqual(mailRecipientsFrom({ to: "", cc: null }), emptyMailRecipients());
  });
});

describe("adding and removing", () => {
  test("adding someone to a field takes them off the others", () => {
    let fields = mailRecipientsFrom({ to: "a@x.test", cc: "b@x.test" });
    fields = addMailRecipients(fields, "bcc", [ok("b@x.test")]);
    assert.deepEqual(emails(fields.cc), []);
    assert.deepEqual(emails(fields.bcc), ["b@x.test"]);
    fields = addMailRecipients(fields, "to", [ok("B@X.test")]);
    assert.deepEqual(emails(fields.to), ["a@x.test", "B@X.test"]);
    assert.deepEqual(emails(fields.bcc), []);
  });

  test("adding someone already on the field does not duplicate them, but fills a missing name", () => {
    let fields = mailRecipientsFrom({ to: "a@x.test" });
    fields = addMailRecipients(fields, "to", [ok("a@x.test", "Ana"), ok("a@x.test")]);
    assert.deepEqual(fields.to, [ok("a@x.test", "Ana")]);
  });

  test("adding keeps the order people were added in", () => {
    const fields = addMailRecipients(
      emptyMailRecipients(),
      "cc",
      parseRecipients("c@x.test, a@x.test, b@x.test"),
    );
    assert.deepEqual(emails(fields.cc), ["c@x.test", "a@x.test", "b@x.test"]);
  });

  test("removing from one field leaves the others alone", () => {
    const fields = mailRecipientsFrom({ to: "a@x.test", cc: "b@x.test" });
    const next = removeMailRecipient(fields, "cc", "B@x.test");
    assert.deepEqual(emails(next.cc), []);
    assert.deepEqual(emails(next.to), ["a@x.test"]);
    assert.deepEqual(emails(fields.cc), ["b@x.test"], "the original is not mutated");
  });

  test("removeEverywhere clears a blocked address from every line", () => {
    const fields = mailRecipientsFrom({
      to: "a@x.test",
      cc: "support@oneuptime.com",
      bcc: "c@x.test",
    });
    const next = removeEverywhere(fields, "SUPPORT@oneuptime.com");
    assert.deepEqual(emails(allMailRecipients(next)), ["a@x.test", "c@x.test"]);
  });
});

describe("headers", () => {
  test("names travel with addresses, quoted when they need it", () => {
    assert.equal(
      headerEntry(ok("felix@assense.com", "Felix Menzel")),
      "Felix Menzel <felix@assense.com>",
    );
    assert.equal(headerEntry(ok("jane@x.test", "Doe, Jane")), '"Doe, Jane" <jane@x.test>');
    assert.equal(headerEntry(ok("q@x.test", 'Ann "The" Boss')), '"Ann \\"The\\" Boss" <q@x.test>');
    assert.equal(headerEntry(ok("plain@x.test")), "plain@x.test");
    assert.equal(headerEntry(ok("same@x.test", "same@x.test")), "same@x.test");
  });

  test("a header reads back as the same chips", () => {
    const fields = mailRecipientsFrom({
      to: '"Doe, Jane" <jane@x.test>, Bob <bob@x.test>',
      cc: "carol@x.test",
    });
    const roundTrip = mailRecipientsFrom(mailHeaders(fields));
    assert.deepEqual(roundTrip, fields);
  });

  test("invalid chips are never sent", () => {
    const items = [ok("a@x.test"), { email: "not an address", name: "", valid: false }];
    assert.equal(mailHeader(items), "a@x.test");
  });

  test("a list too long with names falls back to bare addresses", () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      ok(`person${index}@example-company.test`, `Person Number ${index} With A Long Name`),
    );
    const header = mailHeader(items);
    assert.ok(!header.includes("<"));
    assert.ok(header.length <= MAX_MAIL_HEADER_CHARS);
  });
});

describe("mailRecipientProblem", () => {
  test("names the invalid entry", () => {
    const fields = emptyMailRecipients();
    fields.to = [ok("a@x.test")];
    fields.cc = [{ email: "bob at x", name: "", valid: false }];
    assert.match(mailRecipientProblem(fields) ?? "", /bob at x/);
  });

  test("asks for a To recipient", () => {
    assert.equal(mailRecipientProblem(emptyMailRecipients()), "Add at least one recipient.");
    const onlyCc = mailRecipientsFrom({ cc: "a@x.test" });
    assert.equal(mailRecipientProblem(onlyCc), "Put at least one person on the To line.");
    assert.equal(mailRecipientProblem(onlyCc, { requireTo: false }), null);
  });

  test("accepts a sendable email", () => {
    assert.equal(
      mailRecipientProblem(mailRecipientsFrom({ to: "a@x.test", bcc: "b@x.test" })),
      null,
    );
  });

  test("refuses a line too long even as bare addresses", () => {
    const fields = emptyMailRecipients();
    fields.to = Array.from({ length: 120 }, (_, index) =>
      ok(`someone.with.a.long.address${index}@x.test`),
    );
    assert.match(mailRecipientProblem(fields) ?? "", /To line is too long/);
  });
});

describe("summaries and comparisons", () => {
  test("summarises who a reply goes to on one line", () => {
    const fields = mailRecipientsFrom({
      to: "Felix Menzel <felix@assense.com>",
      cc: "support@oneuptime.com",
      bcc: "a@x.test, b@x.test",
    });
    assert.equal(mailRecipientsSummary(fields), "Felix · cc support@oneuptime.com · bcc 2");
    assert.equal(mailRecipientsSummary(emptyMailRecipients()), "");
  });

  test("compares recipient sets by address, case-insensitively", () => {
    const a = mailRecipientsFrom({ to: "A@x.test", cc: "b@x.test" });
    const b = mailRecipientsFrom({ to: "Ann <a@x.test>", cc: "B@X.TEST" });
    assert.equal(sameMailRecipients(a, b), true);
    assert.equal(sameMailRecipients(a, mailRecipientsFrom({ to: "a@x.test" })), false);
  });
});

describe("threadParticipants", () => {
  test("lists everyone on the thread once, newest first, without the mailbox", () => {
    const people = threadParticipants(
      [
        {
          fromName: "Felix Menzel",
          fromEmail: "felix@assense.com",
          toEmails: "Me <me@oneuptime.com>",
          ccEmails: "support@oneuptime.com",
        },
        {
          fromName: "",
          fromEmail: "me@oneuptime.com",
          toEmails: "felix@assense.com",
          ccEmails: "Dana Lee <dana@assense.com>",
        },
      ],
      ["me@oneuptime.com"],
    );
    assert.deepEqual(people, [
      ok("felix@assense.com", "Felix Menzel"),
      ok("dana@assense.com", "Dana Lee"),
      ok("support@oneuptime.com"),
    ]);
  });
});
