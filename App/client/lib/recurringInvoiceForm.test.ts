import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  changeRecurringInvoiceNameCustomer,
  existingRecurringInvoiceName,
  initialRecurringInvoiceCustomer,
  initialRecurringInvoiceName,
  newRecurringInvoicePath,
  RECURRING_INVOICE_CUSTOMER_PARAM,
  recurringInvoiceFromDocumentPath,
  recurringInvoiceNameToSave,
  recurringInvoicePrefill,
  requestedRecurringInvoiceCustomerId,
  requestedRecurringInvoiceSource,
  typedRecurringInvoiceName,
  type RecurringInvoiceNameState,
  type RecurringInvoiceSourceDocument,
} from "./recurringInvoiceForm.js";
import { RECURRING_INVOICE_NAME_MAX_LENGTH } from "../../shared/recurringInvoiceName.js";

const hyphen = { id: "c-hyphen", name: "SMC Partners LLC, d/b/a Hyphen", domain: "", email: "" };
const acme = { id: "c-acme", name: "Acme Corp", domain: "acme.example", email: "ap@acme.example" };
const beta = { id: "c-beta", name: "Beta Industries", domain: "", email: "" };
const nameless = { id: "c-nameless", name: "", domain: "nameless.example", email: "" };
const blank = { id: "c-blank", name: " ", domain: "", email: "" };

/** Replay the form: start, then apply each step the way the page does. */
function replay(
  start: RecurringInvoiceNameState,
  steps: Array<{ type: string } | { customer: typeof acme | null }>,
): RecurringInvoiceNameState {
  let state = start;
  for (const step of steps) {
    state =
      "type" in step
        ? typedRecurringInvoiceName(step.type)
        : changeRecurringInvoiceNameCustomer(state, step.customer);
  }
  return state;
}

describe("a new schedule's name", () => {
  test("starts as the chosen customer's name and follows it", () => {
    assert.deepEqual(initialRecurringInvoiceName(hyphen), {
      value: "SMC Partners LLC, d/b/a Hyphen",
      followsCustomer: true,
    });
  });

  test("starts empty, still following, when no customer is chosen yet", () => {
    assert.deepEqual(initialRecurringInvoiceName(null), { value: "", followsCustomer: true });
    assert.deepEqual(initialRecurringInvoiceName(undefined), { value: "", followsCustomer: true });
  });

  test("follows every customer change until the person types", () => {
    const state = replay(initialRecurringInvoiceName(acme), [
      { customer: beta },
      { customer: hyphen },
      { customer: acme },
    ]);
    assert.deepEqual(state, { value: "Acme Corp", followsCustomer: true });
  });

  test("is the person's once they type, and no customer change overwrites it", () => {
    const state = replay(initialRecurringInvoiceName(acme), [
      { type: "Acme annual licence" },
      { customer: beta },
      { customer: hyphen },
    ]);
    assert.deepEqual(state, { value: "Acme annual licence", followsCustomer: false });
  });

  test("an edit that adds to the pre-filled name is the person's too", () => {
    const state = replay(initialRecurringInvoiceName(acme), [
      { type: "Acme Corp — support" },
      { customer: beta },
    ]);
    assert.equal(state.value, "Acme Corp — support");
  });

  test("a name retyped to match the customer is still the person's", () => {
    const state = replay(initialRecurringInvoiceName(acme), [
      { type: "Acme Cor" },
      { type: "Acme Corp" },
      { customer: beta },
    ]);
    assert.deepEqual(state, { value: "Acme Corp", followsCustomer: false });
  });

  test("clearing the field hands it back: it stays empty until the next customer change", () => {
    const cleared = replay(initialRecurringInvoiceName(acme), [{ type: "Custom" }, { type: "" }]);
    assert.deepEqual(cleared, { value: "", followsCustomer: true });
    assert.deepEqual(changeRecurringInvoiceNameCustomer(cleared, beta), {
      value: "Beta Industries",
      followsCustomer: true,
    });
  });

  test("a whitespace-only name counts as cleared, and the spaces typed stay until a change", () => {
    const spaced = replay(initialRecurringInvoiceName(acme), [{ type: "Custom" }, { type: "   " }]);
    assert.deepEqual(spaced, { value: "   ", followsCustomer: true });
    assert.deepEqual(changeRecurringInvoiceNameCustomer(spaced, hyphen), {
      value: "SMC Partners LLC, d/b/a Hyphen",
      followsCustomer: true,
    });
  });

  test("typing again after clearing takes the name back over", () => {
    const state = replay(initialRecurringInvoiceName(acme), [
      { type: "" },
      { customer: beta },
      { type: "Beta retainer" },
      { customer: acme },
    ]);
    assert.deepEqual(state, { value: "Beta retainer", followsCustomer: false });
  });

  test("re-picking the same customer refills a cleared name", () => {
    const state = replay(initialRecurringInvoiceName(acme), [{ type: "" }, { customer: acme }]);
    assert.deepEqual(state, { value: "Acme Corp", followsCustomer: true });
  });

  test("a customer without a name lends its domain, and one with nothing leaves it empty", () => {
    assert.equal(initialRecurringInvoiceName(nameless).value, "nameless.example");
    const state = replay(initialRecurringInvoiceName(acme), [{ customer: blank }]);
    assert.deepEqual(state, { value: "", followsCustomer: true });
    assert.equal(changeRecurringInvoiceNameCustomer(state, beta).value, "Beta Industries");
  });

  test("a very long customer name is cut to what a schedule name may hold", () => {
    const long = { id: "c-long", name: `${"Imported Holdings ".repeat(15)}Plc`, domain: "", email: "" };
    const state = initialRecurringInvoiceName(long);
    assert.equal(state.value.length <= RECURRING_INVOICE_NAME_MAX_LENGTH, true);
    assert.equal(long.name.startsWith(state.value), true);
    assert.equal(state.value, state.value.trim());
  });
});

describe("an existing schedule's name", () => {
  test("keeps the saved name and does not follow a customer change", () => {
    const state = replay(existingRecurringInvoiceName("Monthly retainer — Acme"), [
      { customer: beta },
      { customer: hyphen },
    ]);
    assert.deepEqual(state, { value: "Monthly retainer — Acme", followsCustomer: false });
  });

  test("keeps a saved name even when it matches the customer it bills", () => {
    const state = replay(existingRecurringInvoiceName("Acme Corp"), [{ customer: beta }]);
    assert.equal(state.value, "Acme Corp");
  });

  test("follows only once the person clears it, the same as a new one", () => {
    const state = replay(existingRecurringInvoiceName("Old name"), [
      { type: "" },
      { customer: beta },
    ]);
    assert.deepEqual(state, { value: "Beta Industries", followsCustomer: true });
  });
});

describe("recurringInvoiceNameToSave", () => {
  test("saves the field's text, trimmed", () => {
    assert.equal(recurringInvoiceNameToSave(typedRecurringInvoiceName("  Retainer  "), acme), "Retainer");
    assert.equal(recurringInvoiceNameToSave(initialRecurringInvoiceName(hyphen), hyphen), hyphen.name);
    assert.equal(recurringInvoiceNameToSave(existingRecurringInvoiceName("Kept"), beta), "Kept");
  });

  test("saves the customer's name when the field is blank", () => {
    for (const value of ["", "   "]) {
      assert.equal(recurringInvoiceNameToSave(typedRecurringInvoiceName(value), beta), "Beta Industries");
    }
    assert.equal(recurringInvoiceNameToSave(typedRecurringInvoiceName(""), nameless), "nameless.example");
  });

  test("has nothing to save when the field and the customer are both blank", () => {
    assert.equal(recurringInvoiceNameToSave(typedRecurringInvoiceName(" "), blank), "");
    assert.equal(recurringInvoiceNameToSave(typedRecurringInvoiceName(""), null), "");
  });
});

describe("initialRecurringInvoiceCustomer", () => {
  const customers = [acme, beta, hyphen];

  test("starts with the first customer when the link asks for none", () => {
    assert.deepEqual(initialRecurringInvoiceCustomer(customers, null), {
      customer: acme,
      requestedUnavailable: false,
    });
  });

  test("starts with the customer the link asks for", () => {
    assert.deepEqual(initialRecurringInvoiceCustomer(customers, "c-hyphen"), {
      customer: hyphen,
      requestedUnavailable: false,
    });
  });

  test("never swaps a requested customer it cannot offer for another one", () => {
    assert.deepEqual(initialRecurringInvoiceCustomer(customers, "c-archived"), {
      customer: null,
      requestedUnavailable: true,
    });
  });

  test("has no customer to start with when there are none", () => {
    assert.deepEqual(initialRecurringInvoiceCustomer([], null), {
      customer: null,
      requestedUnavailable: false,
    });
    assert.deepEqual(initialRecurringInvoiceCustomer([], "c-acme"), {
      customer: null,
      requestedUnavailable: true,
    });
  });
});

describe("links to the New recurring invoice form", () => {
  const base = "/c/acme/finance";

  test("open the plain form, or one with a customer picked", () => {
    assert.equal(newRecurringInvoicePath(base), "/c/acme/finance/recurring-invoices/new");
    assert.equal(newRecurringInvoicePath(base, null), "/c/acme/finance/recurring-invoices/new");
    assert.equal(newRecurringInvoicePath(base, ""), "/c/acme/finance/recurring-invoices/new");
    assert.equal(
      newRecurringInvoicePath(base, "4f5c6a1e-0000-4000-8000-000000000001"),
      "/c/acme/finance/recurring-invoices/new?customerId=4f5c6a1e-0000-4000-8000-000000000001",
    );
  });

  test("encode the customer id and round-trip through the form's reader", () => {
    const id = "odd id&x=1";
    const href = newRecurringInvoicePath(base, id);
    assert.equal(href.includes("odd id"), false);
    const params = new URL(href, "https://genosyn.example").searchParams;
    assert.equal(requestedRecurringInvoiceCustomerId(params), id);
  });

  test("ask for no customer when the parameter is missing or blank", () => {
    assert.equal(RECURRING_INVOICE_CUSTOMER_PARAM, "customerId");
    assert.equal(requestedRecurringInvoiceCustomerId(new URLSearchParams()), null);
    assert.equal(requestedRecurringInvoiceCustomerId(new URLSearchParams("customerId=")), null);
    assert.equal(requestedRecurringInvoiceCustomerId(new URLSearchParams("customerId=%20")), null);
    assert.equal(requestedRecurringInvoiceCustomerId(new URLSearchParams("customerId=%20c-acme%20")), "c-acme");
    assert.equal(requestedRecurringInvoiceCustomerId(new URLSearchParams("customer=c-acme")), null);
  });
});

describe("Make recurring on an invoice or estimate", () => {
  const base = "/c/acme/finance";

  test("links to the form with the document named, and the form reads it back", () => {
    const fromInvoice = recurringInvoiceFromDocumentPath(base, {
      kind: "invoice",
      slug: "acme-corp-inv-0001",
    });
    assert.equal(fromInvoice, "/c/acme/finance/recurring-invoices/new?fromInvoice=acme-corp-inv-0001");
    const fromEstimate = recurringInvoiceFromDocumentPath(base, { kind: "estimate", slug: "est 1&x" });
    const params = new URL(fromEstimate, "https://genosyn.example").searchParams;
    assert.deepEqual(requestedRecurringInvoiceSource(params), { kind: "estimate", slug: "est 1&x" });
  });

  test("asks for no document when none is named, and an invoice wins over an estimate", () => {
    assert.equal(requestedRecurringInvoiceSource(new URLSearchParams()), null);
    assert.equal(requestedRecurringInvoiceSource(new URLSearchParams("fromInvoice=%20")), null);
    assert.deepEqual(
      requestedRecurringInvoiceSource(new URLSearchParams("fromEstimate=e-1&fromInvoice=i-1")),
      { kind: "invoice", slug: "i-1" },
    );
  });

  const options = {
    productIds: new Set(["p-retainer"]),
    taxRateIds: new Set(["t-vat"]),
    subsidiaryIds: new Set(["s-emea", "s-archived"]),
  };
  const invoice: RecurringInvoiceSourceDocument = {
    customerId: "c-acme",
    subsidiaryId: "s-emea",
    currency: "EUR",
    issueDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-31T00:00:00.000Z",
    notes: "Thanks for your business.",
    footer: "IBAN DE00 0000",
    discountCents: 0,
    lines: [
      {
        productId: null,
        description: "Hosting",
        quantity: 2,
        unitPriceCents: 5_000,
        taxRateId: "t-vat",
        taxPercent: 19,
        sortOrder: 1,
      },
      {
        productId: "p-retainer",
        description: "Monthly retainer",
        quantity: 1,
        unitPriceCents: 880_000,
        taxRateId: null,
        taxPercent: 0,
        sortOrder: 0,
      },
    ],
  };

  test("copies the customer, issuer, currency, terms, notes, footer and lines in order", () => {
    assert.deepEqual(recurringInvoicePrefill(invoice, options), {
      customerId: "c-acme",
      subsidiaryId: "s-emea",
      currency: "EUR",
      daysUntilDue: 30,
      notes: "Thanks for your business.",
      footer: "IBAN DE00 0000",
      lines: [
        {
          productId: "p-retainer",
          description: "Monthly retainer",
          quantity: 1,
          unitPriceCents: 880_000,
          taxRateId: null,
        },
        {
          productId: null,
          description: "Hosting",
          quantity: 2,
          unitPriceCents: 5_000,
          taxRateId: "t-vat",
        },
      ],
      droppedDiscountCents: 0,
      untaxedLines: 0,
    });
  });

  test("an estimate has no due date, so the form keeps its own payment terms", () => {
    const { dueDate: _dueDate, ...estimate } = invoice;
    assert.equal(recurringInvoicePrefill(estimate, options).daysUntilDue, null);
  });

  test("payment terms stay within the 0–365 days the form accepts", () => {
    const long = { ...invoice, dueDate: "2028-10-01T00:00:00.000Z" };
    assert.equal(recurringInvoicePrefill(long, options).daysUntilDue, 365);
    const backwards = { ...invoice, dueDate: "2026-09-01T00:00:00.000Z" };
    assert.equal(recurringInvoicePrefill(backwards, options).daysUntilDue, 0);
  });

  test("cuts loose a product or tax rate the form no longer offers, and counts lines left untaxed", () => {
    const prefill = recurringInvoicePrefill(invoice, {
      ...options,
      productIds: new Set(),
      taxRateIds: new Set(),
    });
    assert.deepEqual(
      prefill.lines.map((line) => [line.description, line.productId, line.taxRateId]),
      [
        ["Monthly retainer", null, null],
        ["Hosting", null, null],
      ],
    );
    // Only the taxed line lost anything: the retainer was never taxed.
    assert.equal(prefill.untaxedLines, 1);
  });

  test("keeps an archived issuer for the form to flag, but not one that is gone", () => {
    assert.equal(
      recurringInvoicePrefill({ ...invoice, subsidiaryId: "s-archived" }, options).subsidiaryId,
      "s-archived",
    );
    assert.equal(
      recurringInvoicePrefill({ ...invoice, subsidiaryId: "s-deleted" }, options).subsidiaryId,
      "",
    );
    assert.equal(recurringInvoicePrefill({ ...invoice, subsidiaryId: null }, options).subsidiaryId, "");
  });

  test("reports a discount the schedule cannot carry", () => {
    assert.equal(
      recurringInvoicePrefill({ ...invoice, discountCents: 88_000 }, options).droppedDiscountCents,
      88_000,
    );
  });
});
