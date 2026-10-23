import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addRecipients,
  dedupeRecipients,
  editableRecipient,
  formatRecipient,
  isSendableAddress,
  MAX_RECIPIENTS_PER_FIELD,
  parseRecipientEntry,
  parseRecipients,
  type Recipient,
  recipientAddresses,
  recipientKey,
  recipientLabel,
  recipientProblem,
  type RecipientFields,
  removeRecipient,
  splitRecipientText,
  takenAddresses,
  takeTypedRecipients,
} from "./recipientTokens.js";

const ok = (email: string, name = ""): Recipient => ({ email, name, valid: true });
const bad = (email: string): Recipient => ({ email, name: "", valid: false });
const fields = (to: Recipient[] = [], cc: Recipient[] = []): RecipientFields => ({ to, cc });

describe("isSendableAddress", () => {
  test("accepts what the send endpoint accepts", () => {
    for (const address of [
      "ap@acme.com",
      "Jane.Doe@Acme.CO.UK",
      "o'neil@acme.com",
      "first+invoices@acme.com",
      "x_y-z@sub.acme-group.io",
      " padded@acme.com ",
    ]) {
      assert.equal(isSendableAddress(address), true, address);
    }
  });

  test("refuses what the send endpoint refuses", () => {
    for (const address of [
      "",
      "   ",
      "jane",
      "jane@acme",
      "jane@acme.c",
      "@acme.com",
      "jane@@acme.com",
      "jane..doe@acme.com",
      ".jane@acme.com",
      "jane.@acme.com",
      "a!b@acme.com",
      "jane doe@acme.com",
      "jane@acme_co.com",
      "jane@-acme.com",
      "Jane <jane@acme.com>",
      `${"a".repeat(312)}@acme.com`,
    ]) {
      assert.equal(isSendableAddress(address), false, address);
    }
  });
});

describe("splitRecipientText", () => {
  test("splits on commas, semicolons and line breaks, dropping blanks", () => {
    assert.deepEqual(splitRecipientText(" a@x.com,b@x.com ; c@x.com\n d@x.com\r\ne@x.com,, ;\n"), [
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
    ]);
  });

  test("keeps a quoted name holding a comma or semicolon as one recipient", () => {
    assert.deepEqual(splitRecipientText('"Doe, Jane" <jane@x.com>; "Smith; Bob" <bob@x.com>'), [
      '"Doe, Jane" <jane@x.com>',
      '"Smith; Bob" <bob@x.com>',
    ]);
  });

  test("reads an escaped quote as part of the name", () => {
    assert.deepEqual(splitRecipientText('"Ann \\"Q, Jr" <q@x.com>, b@x.com'), [
      '"Ann \\"Q, Jr" <q@x.com>',
      "b@x.com",
    ]);
  });

  test("an unclosed quote swallows the commas after it, but never the next line", () => {
    assert.deepEqual(splitRecipientText('"Doe <doe@x.com>, bob@x.com\ncarol@x.com'), [
      '"Doe <doe@x.com>, bob@x.com',
      "carol@x.com",
    ]);
  });
});

describe("parseRecipientEntry", () => {
  test("reads a bare address, as written", () => {
    assert.deepEqual(parseRecipientEntry("  Jane@Acme.com "), [ok("Jane@Acme.com")]);
  });

  test("reads display-name syntax, quoted or not", () => {
    assert.deepEqual(parseRecipientEntry("Jane Doe <jane@acme.com>"), [
      ok("jane@acme.com", "Jane Doe"),
    ]);
    assert.deepEqual(parseRecipientEntry('"Doe, Jane" <jane@acme.com>'), [
      ok("jane@acme.com", "Doe, Jane"),
    ]);
    assert.deepEqual(parseRecipientEntry('"Ann \\"Q\\" Lee" <ann@acme.com>'), [
      ok("ann@acme.com", 'Ann "Q" Lee'),
    ]);
    assert.deepEqual(parseRecipientEntry("<jane@acme.com>"), [ok("jane@acme.com")]);
    assert.deepEqual(parseRecipientEntry("'Jane' <jane@acme.com>"), [ok("jane@acme.com", "Jane")]);
  });

  test("reads a name typed before a bare address, and the old comment form", () => {
    assert.deepEqual(parseRecipientEntry("Jane Doe jane@acme.com"), [
      ok("jane@acme.com", "Jane Doe"),
    ]);
    assert.deepEqual(parseRecipientEntry("jane@acme.com (Jane Doe)"), [
      ok("jane@acme.com", "Jane Doe"),
    ]);
  });

  test("reads a mailto link and an address wrapped or ended by punctuation", () => {
    assert.deepEqual(parseRecipientEntry("mailto:jane@acme.com"), [ok("jane@acme.com")]);
    assert.deepEqual(parseRecipientEntry("MAILTO:jane@acme.com"), [ok("jane@acme.com")]);
    assert.deepEqual(parseRecipientEntry("(jane@acme.com)."), [ok("jane@acme.com")]);
    assert.deepEqual(parseRecipientEntry("[jane@acme.com]"), [ok("jane@acme.com")]);
  });

  test("reads several bare addresses separated only by spaces", () => {
    assert.deepEqual(parseRecipientEntry("a@acme.com   b@acme.com\tc@acme"), [
      ok("a@acme.com"),
      ok("b@acme.com"),
      bad("c@acme"),
    ]);
  });

  test("keeps what it cannot read, as written, for the Member to fix", () => {
    assert.deepEqual(parseRecipientEntry("jane@acme"), [bad("jane@acme")]);
    assert.deepEqual(parseRecipientEntry("just a name"), [bad("just a name")]);
    assert.deepEqual(parseRecipientEntry("Jane <jane@acme>"), [bad("Jane <jane@acme>")]);
    assert.deepEqual(parseRecipientEntry("Jane <>"), [bad("Jane <>")]);
    assert.deepEqual(parseRecipientEntry("Jane <jane@acme.com"), [bad("Jane <jane@acme.com")]);
    assert.deepEqual(parseRecipientEntry("jane@acme.com> trailing"), [
      bad("jane@acme.com> trailing"),
    ]);
    assert.deepEqual(parseRecipientEntry("   "), []);
  });
});

describe("parseRecipients", () => {
  test("reads a pasted list in every shape at once, in order", () => {
    const pasted = [
      '"Doe, Jane" <jane@acme.com>, Bob Smith <bob@acme.com>; carol@acme.com',
      "Dave Lee dave@acme.com",
      "mailto:erin@acme.com",
      "",
      "frank@acme",
    ].join("\n");
    assert.deepEqual(parseRecipients(pasted), [
      ok("jane@acme.com", "Doe, Jane"),
      ok("bob@acme.com", "Bob Smith"),
      ok("carol@acme.com"),
      ok("dave@acme.com", "Dave Lee"),
      ok("erin@acme.com"),
      bad("frank@acme"),
    ]);
  });

  test("keeps each address once, however it was written, and a later name fills a missing one", () => {
    assert.deepEqual(
      parseRecipients("ap@acme.com, AP@ACME.com; Accounts <ap@acme.com>, jane@acme, JANE@acme"),
      [ok("ap@acme.com", "Accounts"), bad("jane@acme")],
    );
  });

  test("reads nothing from nothing", () => {
    assert.deepEqual(parseRecipients(""), []);
    assert.deepEqual(parseRecipients(" ,; \n "), []);
  });
});

describe("takeTypedRecipients", () => {
  test("leaves an unfinished address in the box", () => {
    assert.deepEqual(takeTypedRecipients("jane@acme.c"), { recipients: [], rest: "jane@acme.c" });
    assert.deepEqual(takeTypedRecipients("Jane Doe"), { recipients: [], rest: "Jane Doe" });
  });

  test("a separator finishes everything before it", () => {
    assert.deepEqual(takeTypedRecipients("jane@acme.com,"), {
      recipients: [ok("jane@acme.com")],
      rest: "",
    });
    assert.deepEqual(takeTypedRecipients("a@acme.com; b@acme.com, car"), {
      recipients: [ok("a@acme.com"), ok("b@acme.com")],
      rest: " car",
    });
    assert.deepEqual(takeTypedRecipients("oops@acme,"), {
      recipients: [bad("oops@acme")],
      rest: "",
    });
  });

  test("a comma inside a quoted name is not a separator yet", () => {
    assert.deepEqual(takeTypedRecipients('"Doe, Ja'), { recipients: [], rest: '"Doe, Ja' });
  });

  test("a space after a finished address, or after Name <address>, finishes it", () => {
    assert.deepEqual(takeTypedRecipients("jane@acme.com "), {
      recipients: [ok("jane@acme.com")],
      rest: "",
    });
    assert.deepEqual(takeTypedRecipients("Jane Doe <jane@acme.com> "), {
      recipients: [ok("jane@acme.com", "Jane Doe")],
      rest: "",
    });
    // Not a finished address yet: the name is still being typed.
    assert.deepEqual(takeTypedRecipients("Jane "), { recipients: [], rest: "Jane " });
    assert.deepEqual(takeTypedRecipients("jane@acme "), { recipients: [], rest: "jane@acme " });
  });
});

describe("addRecipients", () => {
  test("adds to Cc whoever is not on the email yet", () => {
    const result = addRecipients(fields([ok("billing@acme.com")], [ok("jane@acme.com")]), "cc", [
      ok("Jane@Acme.com"),
      ok("BILLING@acme.com"),
      ok("bob@acme.com"),
      ok("bob@acme.com"),
    ]);
    assert.deepEqual(
      result,
      fields([ok("billing@acme.com")], [ok("jane@acme.com"), ok("bob@acme.com")]),
    );
  });

  test("adding to To moves someone up from Cc, and never adds them twice", () => {
    const result = addRecipients(
      fields([ok("billing@acme.com")], [ok("jane@acme.com", "Jane"), ok("bob@acme.com")]),
      "to",
      [ok("jane@acme.com", "Jane"), ok("billing@acme.com")],
    );
    assert.deepEqual(
      result,
      fields([ok("billing@acme.com"), ok("jane@acme.com", "Jane")], [ok("bob@acme.com")]),
    );
  });

  test("keeps an invalid entry once, so it can be fixed", () => {
    const once = addRecipients(fields(), "to", [bad("jane@acme")]);
    assert.deepEqual(addRecipients(once, "to", [bad("JANE@acme")]), fields([bad("jane@acme")]));
  });

  test("never changes the fields it was given", () => {
    const before = fields([ok("a@acme.com")], [ok("b@acme.com")]);
    const snapshot = structuredClone(before);
    addRecipients(before, "to", [ok("b@acme.com")]);
    addRecipients(before, "cc", [ok("c@acme.com")]);
    assert.deepEqual(before, snapshot);
  });
});

describe("removeRecipient", () => {
  test("removes one address from one field, compared case-insensitively", () => {
    const start = fields([ok("a@acme.com"), ok("b@acme.com")], [ok("b@acme.com")]);
    assert.deepEqual(
      removeRecipient(start, "to", "B@ACME.com"),
      fields([ok("a@acme.com")], [ok("b@acme.com")]),
    );
    assert.deepEqual(removeRecipient(start, "cc", "nobody@acme.com"), start);
  });
});

describe("recipientProblem", () => {
  test("is quiet when the email can go", () => {
    assert.equal(recipientProblem(fields([ok("a@acme.com")])), null);
    assert.equal(recipientProblem(fields([ok("a@acme.com")], [ok("b@acme.com")])), null);
  });

  test("names the one entry to fix, or counts several", () => {
    assert.equal(
      recipientProblem(fields([ok("a@acme.com")], [bad("jane@acme")])),
      "“jane@acme” isn’t a valid email address. Fix or remove it.",
    );
    assert.equal(
      recipientProblem(fields([bad("x"), ok("a@acme.com")], [bad("y")])),
      "2 entries aren’t valid email addresses. Fix or remove them.",
    );
  });

  test("asks for a To recipient", () => {
    assert.equal(
      recipientProblem(fields([], [ok("b@acme.com")])),
      "Add at least one To recipient.",
    );
  });

  test("holds each field to the endpoint's ceiling", () => {
    const many = Array.from({ length: MAX_RECIPIENTS_PER_FIELD + 1 }, (_, i) =>
      ok(`p${i}@acme.com`),
    );
    assert.equal(
      recipientProblem(fields([ok("a@acme.com")], many)),
      `Cc can hold at most ${MAX_RECIPIENTS_PER_FIELD} addresses.`,
    );
    assert.equal(
      recipientProblem(fields(many)),
      `To can hold at most ${MAX_RECIPIENTS_PER_FIELD} addresses.`,
    );
    assert.equal(recipientProblem(fields(many.slice(0, MAX_RECIPIENTS_PER_FIELD))), null);
  });
});

describe("chip text and what is sent", () => {
  test("a chip shows the name when there is one, and the whole recipient on hover", () => {
    assert.equal(recipientLabel(ok("jane@acme.com", "Jane Doe")), "Jane Doe");
    assert.equal(recipientLabel(ok("jane@acme.com")), "jane@acme.com");
    assert.equal(formatRecipient(ok("jane@acme.com", "Jane Doe")), "Jane Doe <jane@acme.com>");
    assert.equal(formatRecipient(ok("jane@acme.com")), "jane@acme.com");
    assert.equal(formatRecipient(bad("jane@acme")), "jane@acme (not a valid email address)");
  });

  test("sends bare, trimmed addresses and never an invalid entry", () => {
    assert.deepEqual(
      recipientAddresses([ok(" jane@acme.com", "Jane"), bad("oops"), ok("Bob@Acme.com")]),
      ["jane@acme.com", "Bob@Acme.com"],
    );
  });

  test("everyone already on the email, Always Cc included, compared case-insensitively", () => {
    assert.deepEqual(
      [
        ...takenAddresses(fields([ok("A@acme.com")], [ok("b@acme.com")]), [
          " Books@Northwind.test ",
        ]),
      ],
      ["a@acme.com", "b@acme.com", "books@northwind.test"],
    );
    assert.equal(recipientKey("  Jane@Acme.COM "), "jane@acme.com");
  });

  test("a chip put back into the box reads back as the same chip", () => {
    for (const chip of [
      ok("jane@acme.com"),
      ok("jane@acme.com", "Jane Doe"),
      ok("jane@acme.com", "Doe, Jane"),
      ok("ann@acme.com", 'Ann "Q" Lee; CFO'),
      bad("jane@acme"),
      bad("Jane <jane@acme>"),
    ]) {
      const written = editableRecipient(chip);
      assert.deepEqual(parseRecipients(written), [chip], written);
    }
    assert.equal(editableRecipient(ok("jane@acme.com", "Doe, Jane")), '"Doe, Jane" <jane@acme.com>');
  });

  test("de-duplicates keeping the first spelling", () => {
    assert.deepEqual(dedupeRecipients([ok("Jane@acme.com"), ok("jane@ACME.com", "Jane")]), [
      ok("Jane@acme.com", "Jane"),
    ]);
  });
});
