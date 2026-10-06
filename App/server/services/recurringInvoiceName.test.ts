import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clipRecurringInvoiceName,
  defaultRecurringInvoiceName,
  RECURRING_INVOICE_NAME_MAX_LENGTH,
  resolveRecurringInvoiceName,
} from "../../shared/recurringInvoiceName.js";
import {
  nameForNewRecurringInvoice,
  RECURRING_INVOICE_NAME_REQUIRED_ERROR,
} from "./recurringInvoices.js";

const acme = { name: "SMC Partners LLC, d/b/a Hyphen", domain: "hyphen.example", email: "ap@hyphen.example" };

describe("defaultRecurringInvoiceName", () => {
  test("is the customer's name, exactly as written", () => {
    assert.equal(defaultRecurringInvoiceName(acme), "SMC Partners LLC, d/b/a Hyphen");
    assert.equal(defaultRecurringInvoiceName({ name: "Ünïcødé GmbH & Co. KG" }), "Ünïcødé GmbH & Co. KG");
  });

  test("puts the name on one line: surrounding whitespace goes, inner runs become one space", () => {
    assert.equal(defaultRecurringInvoiceName({ name: "  Acme Corp  " }), "Acme Corp");
    assert.equal(defaultRecurringInvoiceName({ name: "Acme\nHoldings\r\n Ltd" }), "Acme Holdings Ltd");
    assert.equal(defaultRecurringInvoiceName({ name: "Acme\t\tCorp" }), "Acme Corp");
    assert.equal(defaultRecurringInvoiceName({ name: "Acme  Corp " }), "Acme Corp");
  });

  test("falls back to the domain, then the billing email, for a customer without a name", () => {
    for (const name of ["", "   ", "\n\t", null, undefined]) {
      assert.equal(defaultRecurringInvoiceName({ ...acme, name }), "hyphen.example", String(name));
      assert.equal(
        defaultRecurringInvoiceName({ name, domain: " ", email: " ap@hyphen.example " }),
        "ap@hyphen.example",
        String(name),
      );
    }
  });

  test("is empty when the customer has nothing to name a schedule after", () => {
    assert.equal(defaultRecurringInvoiceName({ name: " ", domain: "", email: "\n" }), "");
    assert.equal(defaultRecurringInvoiceName({}), "");
    assert.equal(defaultRecurringInvoiceName(null), "");
    assert.equal(defaultRecurringInvoiceName(undefined), "");
  });

  test("never exceeds the schedule name limit, however long the customer's name", () => {
    const exact = "A".repeat(RECURRING_INVOICE_NAME_MAX_LENGTH);
    assert.equal(defaultRecurringInvoiceName({ name: exact }), exact);
    const imported = `${"Long imported account ".repeat(20)}End`;
    const name = defaultRecurringInvoiceName({ name: imported });
    assert.equal(name.length, RECURRING_INVOICE_NAME_MAX_LENGTH);
    assert.equal(imported.startsWith(name), true);
    const cutAtSpace = defaultRecurringInvoiceName({ name: `${"x".repeat(199)} rest` });
    assert.equal(cutAtSpace, "x".repeat(199), "a cut at a space leaves no trailing space");
    const longDomain = `${"sub.".repeat(60)}example.com`;
    assert.equal(defaultRecurringInvoiceName({ name: "", domain: longDomain }).length, 200);
  });
});

describe("clipRecurringInvoiceName", () => {
  test("leaves a name that fits untouched", () => {
    assert.equal(clipRecurringInvoiceName(""), "");
    assert.equal(clipRecurringInvoiceName("Acme"), "Acme");
    assert.equal(clipRecurringInvoiceName("abc", 3), "abc");
  });

  test("cuts to the limit and drops the space a cut can leave", () => {
    assert.equal(clipRecurringInvoiceName("abcdef", 4), "abcd");
    assert.equal(clipRecurringInvoiceName("ab cdef", 3), "ab");
    assert.equal(clipRecurringInvoiceName("abc", 0), "");
  });

  test("never splits a character made of a surrogate pair", () => {
    const rocket = "\u{1F680}";
    const value = `${"a".repeat(199)}${rocket}tail`;
    const clipped = clipRecurringInvoiceName(value);
    assert.equal(clipped, "a".repeat(199));
    assert.equal(clipped.length, 199);
    const fits = `${"a".repeat(198)}${rocket}`;
    assert.equal(clipRecurringInvoiceName(`${fits}more`), fits);
    assert.equal(clipRecurringInvoiceName(`${fits}more`).length, 200);
  });
});

describe("resolveRecurringInvoiceName", () => {
  test("keeps a given name, trimmed but otherwise as typed", () => {
    assert.equal(resolveRecurringInvoiceName("Monthly retainer", acme), "Monthly retainer");
    assert.equal(resolveRecurringInvoiceName("  Monthly   retainer \n", acme), "Monthly   retainer");
  });

  test("uses the customer's name when the name is missing or blank", () => {
    for (const requested of [undefined, null, "", "   ", "\n\t "]) {
      assert.equal(resolveRecurringInvoiceName(requested, acme), acme.name, JSON.stringify(requested));
    }
  });

  test("is empty when neither the request nor the customer has a name", () => {
    assert.equal(resolveRecurringInvoiceName("", { name: "" }), "");
    assert.equal(resolveRecurringInvoiceName(undefined, null), "");
  });

  test("never shortens a given name; the schemas refuse one that is too long", () => {
    const long = "N".repeat(RECURRING_INVOICE_NAME_MAX_LENGTH + 5);
    assert.equal(resolveRecurringInvoiceName(long, acme), long);
  });
});

describe("nameForNewRecurringInvoice", () => {
  test("names a new schedule as given, else after the customer, else refuses", () => {
    assert.equal(nameForNewRecurringInvoice("  Retainer  ", acme), "Retainer");
    assert.equal(nameForNewRecurringInvoice(undefined, acme), acme.name);
    assert.equal(nameForNewRecurringInvoice("", acme), acme.name);
    assert.equal(nameForNewRecurringInvoice(" ", { name: "", domain: "", email: "" }), null);
    assert.match(RECURRING_INVOICE_NAME_REQUIRED_ERROR, /name/i);
  });
});
