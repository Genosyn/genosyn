import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { customerBillTo, withCustomerReread } from "./customerBillTo.js";

/**
 * The invoice, estimate and recurring invoice forms show the picked
 * customer's email and billing address under the Customer field, and warn
 * about whichever is missing.
 */

describe("customerBillTo", () => {
  test("passes the email and address through, trimmed", () => {
    assert.deepEqual(
      customerBillTo({
        email: "  ap@acme.com ",
        billingAddress: "\n1 Main St\nSpringfield\n",
      }),
      { email: "ap@acme.com", address: "1 Main St\nSpringfield" },
    );
  });

  test("blank or whitespace-only reads as missing, as it prints nothing", () => {
    assert.deepEqual(customerBillTo({ email: "", billingAddress: "" }), {
      email: "",
      address: "",
    });
    assert.deepEqual(customerBillTo({ email: " ", billingAddress: " \n\t " }), {
      email: "",
      address: "",
    });
  });
});

describe("withCustomerReread", () => {
  const acme = { id: "c-acme", email: "" };
  const globex = { id: "c-globex", email: "ap@globex.com" };

  test("puts the re-read customer in place of its row and leaves the rest", () => {
    const fresh = { id: "c-acme", email: "ap@acme.com" };
    assert.deepEqual(withCustomerReread([acme, globex], fresh), [fresh, globex]);
  });

  test("a customer the list does not hold is not added", () => {
    assert.deepEqual(withCustomerReread([globex], { id: "c-acme", email: "ap@acme.com" }), [
      globex,
    ]);
  });

  test("a list that has not loaded stays unloaded", () => {
    assert.equal(withCustomerReread(null, acme), null);
  });
});
