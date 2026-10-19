import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  describeDuplicateReasons,
  displayMergeValue,
  domainConflictOf,
  mergeCountRows,
  type AccountMergeCounts,
} from "./accountMerge.js";
import { api, ApiError } from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const noCounts: AccountMergeCounts = {
  contacts: 0,
  deals: 0,
  activities: 0,
  partnerships: 0,
  revenueDocuments: 0,
  signalEvents: 0,
  billingContacts: 0,
  contracts: 0,
  invoices: 0,
  estimates: 0,
  recurringInvoices: 0,
  credits: 0,
  customValuesCopied: 0,
  customValueConflicts: 0,
};

describe("what a merge moves", () => {
  test("lists each kind of record that moves, in a fixed order, and nothing it has none of", () => {
    assert.deepEqual(
      mergeCountRows({ ...noCounts, invoices: 3, contacts: 2, customValuesCopied: 1 }),
      [
        ["Contacts", 2],
        ["Invoices", 3],
        ["Custom values copied", 1],
      ],
    );
    assert.deepEqual(mergeCountRows(noCounts), []);
  });

  test("conflicts the person must settle are not a count of what moves", () => {
    assert.deepEqual(mergeCountRows({ ...noCounts, customValueConflicts: 4 }), []);
  });

  test("shows each conflicting value plainly", () => {
    assert.equal(displayMergeValue(""), "Empty");
    assert.equal(displayMergeValue(null), "Empty");
    assert.equal(displayMergeValue(undefined), "Empty");
    assert.equal(displayMergeValue(51000), "51000");
    assert.equal(displayMergeValue("wbhq.com"), "wbhq.com");
    assert.equal(displayMergeValue({ city: "San Antonio" }), '{"city":"San Antonio"}');
  });
});

describe("why two customers look like duplicates", () => {
  test("says it in a few words, starting with a capital", () => {
    assert.equal(
      describeDuplicateReasons([
        { kind: "exact_domain", value: "wbhq.com", score: 100 },
        { kind: "normalized_name", value: "whataburger", score: 60 },
      ]),
      "Same domain wbhq.com · same name",
    );
    assert.equal(
      describeDuplicateReasons([{ kind: "exact_email", value: "ap@wbhq.com", score: 100 }]),
      "Same email ap@wbhq.com",
    );
  });

  test("an alias reads like the value it matched, and repeats collapse", () => {
    assert.equal(
      describeDuplicateReasons([
        { kind: "exact_domain", value: "wbhq.com", score: 100 },
        { kind: "aliased_domain", value: "wbhq.com", score: 90 },
      ]),
      "Same domain wbhq.com",
    );
  });

  test("names reasons it has no wording for from the reason itself", () => {
    assert.equal(
      describeDuplicateReasons([{ kind: "shared_stripe_customer", score: 100 }]),
      "Same stripe customer",
    );
    assert.equal(describeDuplicateReasons([{ kind: "shared_source_id", score: 100 }]), "Same imported record");
    assert.equal(describeDuplicateReasons([{ kind: "exact_website", score: 100 }]), "Same website");
    assert.equal(describeDuplicateReasons([{ kind: "fuzzy_match", score: 10 }]), "Fuzzy match");
    assert.equal(describeDuplicateReasons([]), "Looks like the same company");
  });
});

describe("a domain another customer already uses", () => {
  test("a refused save carries the status and the body, with the same sentence as before", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "Whataburger already uses the domain wbhq.com",
          conflict: { id: "c-1", slug: "whataburger", name: "Whataburger" },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    const error = await api.patch("/api/companies/co/customers/wb-llc", { domain: "wbhq.com" }).then(
      () => assert.fail("the save was refused"),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof ApiError);
    assert.ok(error instanceof Error, "callers that only know Error still read the message");
    assert.equal(error.message, "Whataburger already uses the domain wbhq.com");
    assert.equal(error.status, 409);
    assert.deepEqual(domainConflictOf(error), {
      id: "c-1",
      slug: "whataburger",
      name: "Whataburger",
    });
  });

  test("anything else is not a domain conflict", async () => {
    assert.equal(domainConflictOf(new Error("Whataburger already uses the domain")), null);
    assert.equal(domainConflictOf(new ApiError("Nope", 403, { conflict: { id: "x" } })), null);
    assert.equal(domainConflictOf(new ApiError("Conflict", 409, { error: "Conflict" })), null);
    assert.equal(domainConflictOf(new ApiError("Conflict", 409, { conflict: { id: 1 } })), null);
    assert.equal(domainConflictOf(new ApiError("Conflict", 409, null)), null);

    // A proxy's HTML error page is still an ApiError, with no body to act on.
    globalThis.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
    const error = await api.get("/api/anything").then(
      () => assert.fail("the request failed"),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.data, null);
    assert.match(error.message, /did not respond \(502\)/);
  });
});
