import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RecipientSuggestion } from "./api.js";
import {
  alwaysCcAddresses,
  availableSuggestions,
  contactNameFor,
  emailedLabel,
  matchSuggestions,
  suggestionDetail,
  suggestionInitials,
  suggestionLabel,
  suggestionRecipient,
  unsavedRecipients,
} from "./recipientSuggestions.js";
import type { Recipient, RecipientFields } from "./recipientTokens.js";

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

const ok = (email: string, name = ""): Recipient => ({ email, name, valid: true });
const fields = (to: Recipient[] = [], cc: Recipient[] = []): RecipientFields => ({ to, cc });

/** As the server ranks them: billing first, then by recency, then the rest. */
const RANKED = [
  suggestion("billing@optionmetrics.com", { billing: true, sources: ["billing_email"] }),
  suggestion("priya@optionmetrics.com", {
    name: "Priya Shah",
    role: "Accounts payable",
    primary: true,
    billing: true,
    sources: ["customer_contact"],
  }),
  suggestion("chad@optionmetrics.com", {
    name: "Chad Champion",
    sources: ["deal", "domain"],
    dealTitle: "2027 renewal",
    lastEmailedAt: "2026-09-10T09:00:00.000Z",
  }),
  suggestion("lin@lin-consulting.example", { name: "Lin Wu", sources: ["revenue_contact"] }),
  suggestion("analyst@optionmetrics.com", { name: "Ana Lyst", role: "Analyst" }),
];

describe("availableSuggestions", () => {
  test("offers everyone nobody has put on the email yet, in the server's order", () => {
    assert.deepEqual(
      availableSuggestions(RANKED, fields([ok("billing@optionmetrics.com")])).map((s) => s.email),
      [
        "priya@optionmetrics.com",
        "chad@optionmetrics.com",
        "lin@lin-consulting.example",
        "analyst@optionmetrics.com",
      ],
    );
  });

  test("leaves out whoever is on To, Cc or Always Cc, however their address is written", () => {
    const left = availableSuggestions(
      RANKED,
      fields([ok("Billing@OptionMetrics.com")], [ok("PRIYA@optionmetrics.com", "Priya")]),
      ["  Chad@OptionMetrics.com "],
    );
    assert.deepEqual(
      left.map((s) => s.email),
      ["lin@lin-consulting.example", "analyst@optionmetrics.com"],
    );
  });

  test("brings someone back the moment they are taken off the email", () => {
    const withPriya = fields([ok("billing@optionmetrics.com")], [ok("priya@optionmetrics.com")]);
    assert.equal(
      availableSuggestions(RANKED, withPriya).some((s) => s.email === "priya@optionmetrics.com"),
      false,
    );
    const without = fields([ok("billing@optionmetrics.com")], []);
    assert.equal(availableSuggestions(RANKED, without)[0].email, "priya@optionmetrics.com");
  });

  test("never offers the same address twice", () => {
    assert.deepEqual(
      availableSuggestions(
        [suggestion("a@acme.com"), suggestion("A@ACME.com", { name: "Dup" })],
        fields(),
      ).map((s) => s.email),
      ["a@acme.com"],
    );
  });
});

describe("matchSuggestions", () => {
  test("is empty until something is typed", () => {
    assert.deepEqual(matchSuggestions(RANKED, ""), []);
    assert.deepEqual(matchSuggestions(RANKED, "   "), []);
  });

  test("puts a name or address that starts with the text first, then a word that does, then any match", () => {
    const people = [
      suggestion("zoe@acme.com", { name: "Zoe Pratt" }),
      suggestion("pat@acme.com", { name: "Pat Smith" }),
      suggestion("ops@acme.com", { name: "Ops", role: "Operations" }),
      suggestion("apex@acme.com", { name: "Apex Team" }),
    ];
    assert.deepEqual(
      matchSuggestions(people, "pa").map((s) => s.email),
      ["pat@acme.com"],
    );
    // Pat's name starts with it; one of Zoe's words does; Ops and Apex only
    // contain it, so they keep the order they came in.
    assert.deepEqual(
      matchSuggestions(people, "P").map((s) => s.email),
      ["pat@acme.com", "zoe@acme.com", "ops@acme.com", "apex@acme.com"],
    );
  });

  test("matches a role too, after any name or address", () => {
    assert.deepEqual(
      matchSuggestions(RANKED, "payable").map((s) => s.email),
      ["priya@optionmetrics.com"],
    );
    assert.deepEqual(
      matchSuggestions(RANKED, "analyst").map((s) => s.email),
      ["analyst@optionmetrics.com"],
    );
  });

  test("ignores case and surrounding spaces, and stops at the limit", () => {
    assert.deepEqual(
      matchSuggestions(RANKED, "  OPTIONMETRICS ", 2).map((s) => s.email),
      ["billing@optionmetrics.com", "priya@optionmetrics.com"],
    );
  });
});

describe("what a suggestion shows", () => {
  test("the name, else the address", () => {
    assert.equal(suggestionLabel(RANKED[1]), "Priya Shah");
    assert.equal(suggestionLabel(RANKED[0]), "billing@optionmetrics.com");
  });

  test("the role, else how they are tied to the account", () => {
    const domain = "optionmetrics.com";
    assert.equal(suggestionDetail(RANKED[1], domain), "Accounts payable");
    assert.equal(suggestionDetail(RANKED[0], domain), "Billing email");
    assert.equal(suggestionDetail(RANKED[2], domain), "On 2027 renewal");
    assert.equal(suggestionDetail(RANKED[3], domain), "Revenue contact");
    assert.equal(
      suggestionDetail(suggestion("x@acme.com", { sources: ["customer_contact"] }), domain),
      "Billing contact",
    );
    assert.equal(
      suggestionDetail(suggestion("x@optionmetrics.com"), domain),
      "At optionmetrics.com",
    );
    assert.equal(suggestionDetail(suggestion("x@optionmetrics.com"), null), "");
  });

  test("when they were last emailed, with the year only when it is not this one", () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    assert.equal(emailedLabel("2026-10-02T09:00:00.000Z", now), "Emailed Oct 2");
    assert.equal(emailedLabel("2025-12-30T09:00:00.000Z", now), "Emailed Dec 30, 2025");
    assert.equal(emailedLabel(null, now), "");
    assert.equal(emailedLabel("not a date", now), "");
  });

  test("initials from the name, else the address", () => {
    assert.equal(suggestionInitials(RANKED[1]), "PS");
    assert.equal(suggestionInitials(suggestion("x@acme.com", { name: "Cher" })), "CH");
    assert.equal(suggestionInitials(suggestion("ap@acme.com")), "AP");
    assert.equal(
      suggestionInitials(suggestion("x@acme.com", { name: "Mary Ann de la Cruz" })),
      "MC",
    );
  });

  test("becomes a valid chip carrying the person's name", () => {
    assert.deepEqual(suggestionRecipient(RANKED[1]), ok("priya@optionmetrics.com", "Priya Shah"));
  });
});

describe("alwaysCcAddresses", () => {
  test("reads the comma-separated line the server sends", () => {
    assert.deepEqual(alwaysCcAddresses("books@northwind.test, ar@northwind.test"), [
      "books@northwind.test",
      "ar@northwind.test",
    ]);
    assert.deepEqual(alwaysCcAddresses(""), []);
  });
});

describe("unsavedRecipients", () => {
  test("is the valid typed addresses that are none of the customer's people nor Always Cc", () => {
    const typed = fields(
      [ok("billing@optionmetrics.com"), ok("new.person@optionmetrics.com", "New Person")],
      [
        ok("PRIYA@optionmetrics.com"),
        ok("books@northwind.test"),
        { email: "oops@", name: "", valid: false },
        ok("New.Person@OptionMetrics.com"),
        ok("outside@elsewhere.example"),
      ],
    );
    assert.deepEqual(
      unsavedRecipients(typed, RANKED, ["books@northwind.test"]).map((item) => item.email),
      ["new.person@optionmetrics.com", "outside@elsewhere.example"],
    );
  });

  test("is nobody when everyone came from a suggestion", () => {
    assert.deepEqual(
      unsavedRecipients(
        fields([ok("billing@optionmetrics.com")], [ok("lin@lin-consulting.example")]),
        RANKED,
      ),
      [],
    );
  });
});

describe("contactNameFor", () => {
  test("uses the name written with the address", () => {
    assert.equal(contactNameFor(ok("jd@acme.com", "  Jane Doe ")), "Jane Doe");
  });

  test("reads a name out of a first.last address", () => {
    assert.equal(contactNameFor(ok("jane.doe@acme.com")), "Jane Doe");
    assert.equal(contactNameFor(ok("MARY-ann_lee+billing@acme.com")), "Mary Ann Lee");
  });

  test("falls back to the address for a mailbox or a single word", () => {
    assert.equal(contactNameFor(ok("ap@acme.com")), "ap@acme.com");
    assert.equal(contactNameFor(ok("jane@acme.com")), "jane@acme.com");
    assert.equal(contactNameFor(ok("j.doe2@acme.com")), "j.doe2@acme.com");
  });
});
