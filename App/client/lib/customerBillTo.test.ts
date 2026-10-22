import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ApiError } from "./api.js";
import {
  customerBillTo,
  missingDetailsError,
  missingDetailsPatch,
  withSavedCustomer,
} from "./customerBillTo.js";

/**
 * The invoice, estimate and recurring invoice forms show the picked
 * customer's email and billing address under the Customer field, warn about
 * whichever is missing, and save one added there to the customer.
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

describe("missingDetailsPatch", () => {
  const missingBoth = { email: "", billingAddress: "" };

  test("saves both details when the customer has neither, trimmed", () => {
    assert.deepEqual(
      missingDetailsPatch(missingBoth, {
        email: " ap@acme.com ",
        address: "\n1 Main St\nSpringfield\n",
      }),
      { email: "ap@acme.com", billingAddress: "1 Main St\nSpringfield" },
    );
  });

  test("saves only what was filled in", () => {
    assert.deepEqual(missingDetailsPatch(missingBoth, { email: "ap@acme.com", address: "" }), {
      email: "ap@acme.com",
    });
    assert.deepEqual(missingDetailsPatch(missingBoth, { email: "  ", address: "1 Main St" }), {
      billingAddress: "1 Main St",
    });
  });

  test("never overwrites a detail already on file", () => {
    assert.deepEqual(
      missingDetailsPatch(
        { email: "ap@acme.com", billingAddress: " " },
        { email: "someone@else.com", address: "1 Main St" },
      ),
      { billingAddress: "1 Main St" },
    );
    assert.equal(
      missingDetailsPatch(
        { email: "ap@acme.com", billingAddress: "1 Main St" },
        { email: "someone@else.com", address: "2 Side St" },
      ),
      null,
    );
  });

  test("nothing filled in is nothing to save", () => {
    assert.equal(missingDetailsPatch(missingBoth, { email: "", address: "" }), null);
    assert.equal(missingDetailsPatch(missingBoth, { email: " ", address: "\n\t" }), null);
  });
});

describe("missingDetailsError", () => {
  test("names the email when the server's own check refused it", () => {
    const refused = new ApiError("ValidationError", 400, {
      error: "ValidationError",
      issues: [{ path: ["email"], message: "Invalid email" }],
    });
    assert.equal(missingDetailsError(refused), "Enter a valid email address, like ap@example.com.");
  });

  test("passes any other refusal through as the server said it", () => {
    assert.equal(
      missingDetailsError(new ApiError("Customer not found", 404, { error: "Customer not found" })),
      "Customer not found",
    );
  });

  test("a failure with no message still says what did not happen", () => {
    assert.equal(missingDetailsError(null), "Couldn't save to the customer.");
  });
});

describe("withSavedCustomer", () => {
  const acme = { id: "c-acme", email: "" };
  const globex = { id: "c-globex", email: "ap@globex.com" };

  test("puts the saved customer in place of its row and leaves the rest", () => {
    const saved = { id: "c-acme", email: "ap@acme.com" };
    assert.deepEqual(withSavedCustomer([acme, globex], saved), [saved, globex]);
  });

  test("a customer the list does not hold is not added", () => {
    assert.deepEqual(withSavedCustomer([globex], { id: "c-acme", email: "ap@acme.com" }), [
      globex,
    ]);
  });

  test("a list that has not loaded stays unloaded", () => {
    assert.equal(withSavedCustomer(null, acme), null);
  });
});
