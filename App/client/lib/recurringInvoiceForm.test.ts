import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  changeRecurringInvoiceNameCustomer,
  existingRecurringInvoiceName,
  initialRecurringInvoiceCustomer,
  initialRecurringInvoiceName,
  newRecurringInvoicePath,
  RECURRING_INVOICE_CUSTOMER_PARAM,
  recurringInvoiceNameToSave,
  requestedRecurringInvoiceCustomerId,
  typedRecurringInvoiceName,
  type RecurringInvoiceNameState,
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
