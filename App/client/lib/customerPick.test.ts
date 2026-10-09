import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CUSTOMER_PICK_PARAM,
  initialCustomerPick,
  requestedCustomerPick,
  withCustomerPick,
} from "./customerPick.js";

/**
 * New invoice, New estimate and New signature request on a customer's page
 * open their form with that customer picked — never with somebody else in
 * their place.
 */

const customers = [
  { id: "c-acme", name: "Acme" },
  { id: "c-globex", name: "Globex" },
];

describe("withCustomerPick", () => {
  test("no customer leaves the link as it was", () => {
    assert.equal(withCustomerPick("/c/acme/finance/invoices/new"), "/c/acme/finance/invoices/new");
    assert.equal(
      withCustomerPick("/c/acme/finance/invoices/new", null),
      "/c/acme/finance/invoices/new",
    );
    assert.equal(
      withCustomerPick("/c/acme/finance/invoices/new", ""),
      "/c/acme/finance/invoices/new",
    );
  });

  test("a customer travels as ?customerId=", () => {
    assert.equal(CUSTOMER_PICK_PARAM, "customerId");
    assert.equal(
      withCustomerPick("/c/acme/signatures/new", "4f5c6a1e-0000-4000-8000-000000000001"),
      "/c/acme/signatures/new?customerId=4f5c6a1e-0000-4000-8000-000000000001",
    );
  });

  test("the id is encoded, and reads back unchanged", () => {
    const href = withCustomerPick("/c/acme/finance/estimates/new", "a b&c");
    const params = new URL(href, "https://genosyn.test").searchParams;
    assert.equal(requestedCustomerPick(params), "a b&c");
  });
});

describe("requestedCustomerPick", () => {
  test("a link without one asks for nobody", () => {
    assert.equal(requestedCustomerPick(new URLSearchParams("")), null);
    assert.equal(requestedCustomerPick(new URLSearchParams("customerId=")), null);
    assert.equal(requestedCustomerPick(new URLSearchParams("customerId=%20%20")), null);
  });

  test("surrounding space is not part of the id", () => {
    assert.equal(requestedCustomerPick(new URLSearchParams("customerId=%20c-acme%20")), "c-acme");
  });
});

describe("initialCustomerPick", () => {
  test("the customer the link asked for", () => {
    assert.deepEqual(initialCustomerPick(customers, "c-globex"), {
      customer: customers[1],
      requestedUnavailable: false,
    });
  });

  test("no request: the first customer, as the forms always did", () => {
    assert.deepEqual(initialCustomerPick(customers, null), {
      customer: customers[0],
      requestedUnavailable: false,
    });
  });

  test("a request the list cannot offer is never swapped for someone else", () => {
    assert.deepEqual(initialCustomerPick(customers, "c-archived"), {
      customer: null,
      requestedUnavailable: true,
    });
  });

  test("where the customer is optional, no request means nobody", () => {
    assert.deepEqual(initialCustomerPick(customers, null, { fallbackToFirst: false }), {
      customer: null,
      requestedUnavailable: false,
    });
    assert.deepEqual(initialCustomerPick(customers, "c-acme", { fallbackToFirst: false }), {
      customer: customers[0],
      requestedUnavailable: false,
    });
  });

  test("an empty list offers nobody", () => {
    assert.deepEqual(initialCustomerPick([], null), {
      customer: null,
      requestedUnavailable: false,
    });
    assert.deepEqual(initialCustomerPick([], "c-acme"), {
      customer: null,
      requestedUnavailable: true,
    });
  });
});
