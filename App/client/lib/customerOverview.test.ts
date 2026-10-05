import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  customerMailThreadHref,
  dealTotalsByCurrency,
  describeMailSearch,
  orderAccountDeals,
  parseCustomerTab,
} from "./customerOverview.js";

describe("parseCustomerTab", () => {
  test("reads every tab the page offers", () => {
    for (const tab of ["emails", "activity", "deals", "people", "meetings", "billing", "documents"]) {
      assert.equal(parseCustomerTab(tab), tab);
    }
  });

  test("falls back to the overview for a missing or unknown tab", () => {
    assert.equal(parseCustomerTab(null), "overview");
    assert.equal(parseCustomerTab(""), "overview");
    assert.equal(parseCustomerTab("Emails"), "overview");
    assert.equal(parseCustomerTab("constructor"), "overview");
  });
});

describe("customerMailThreadHref", () => {
  test("opens the thread in its own mailbox", () => {
    assert.equal(
      customerMailThreadHref("northwind", { id: "thread-1", accountId: "mailbox 2" }),
      "/c/northwind/mail/t/thread-1?account=mailbox+2",
    );
  });
});

describe("describeMailSearch", () => {
  test("names the domain and counts addresses outside it", () => {
    assert.equal(describeMailSearch(["ada@acme.com"], "acme.com"), "anyone at acme.com");
    assert.equal(
      describeMailSearch(["ada@acme.com", "ops@eu.acme.com", "pat@holdings.example"], "acme.com"),
      "anyone at acme.com and 1 other address",
    );
    assert.equal(
      describeMailSearch(["a@one.example", "b@two.example"], "acme.com"),
      "anyone at acme.com and 2 other addresses",
    );
  });

  test("lists addresses when there is no domain", () => {
    assert.equal(describeMailSearch([], null), "");
    assert.equal(describeMailSearch(["a@one.example"], null), "a@one.example");
    assert.equal(
      describeMailSearch(["a@one.example", "b@two.example"], null),
      "a@one.example and b@two.example",
    );
    assert.equal(
      describeMailSearch(["a@one.example", "b@two.example", "c@three.example"], null),
      "a@one.example and 2 other addresses",
    );
  });

  test("does not treat a lookalike host as inside the domain", () => {
    assert.equal(
      describeMailSearch(["x@notacme.com"], "acme.com"),
      "anyone at acme.com and 1 other address",
    );
  });
});

const deal = (
  status: "open" | "won" | "lost",
  amountCents: number,
  updatedAt: string,
  closedAt: string | null = null,
  currency = "USD",
) => ({ status, amountCents, currency, updatedAt, closedAt });

describe("orderAccountDeals", () => {
  test("puts open deals first, then closed deals by close date", () => {
    const won = deal("won", 100, "2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z");
    const lost = deal("lost", 100, "2026-07-01T00:00:00Z", "2026-09-15T00:00:00Z");
    const stale = deal("open", 100, "2026-06-01T00:00:00Z");
    const fresh = deal("open", 100, "2026-09-20T00:00:00Z");
    assert.deepEqual(orderAccountDeals([won, stale, lost, fresh]), [fresh, stale, lost, won]);
  });

  test("leaves the input untouched", () => {
    const input = [deal("won", 1, "2026-01-01T00:00:00Z"), deal("open", 1, "2026-01-01T00:00:00Z")];
    orderAccountDeals(input);
    assert.equal(input[0].status, "won");
  });
});

describe("dealTotalsByCurrency", () => {
  test("sums one status per currency and skips empty amounts", () => {
    const deals = [
      deal("open", 150_00, "2026-09-01T00:00:00Z"),
      deal("open", 50_00, "2026-09-01T00:00:00Z"),
      deal("open", 0, "2026-09-01T00:00:00Z"),
      deal("open", 900_00, "2026-09-01T00:00:00Z", null, "EUR"),
      deal("won", 1_000_00, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"),
    ];
    assert.deepEqual(dealTotalsByCurrency(deals, "open"), [
      ["USD", 200_00],
      ["EUR", 900_00],
    ]);
    assert.deepEqual(dealTotalsByCurrency(deals, "won"), [["USD", 1_000_00]]);
    assert.deepEqual(dealTotalsByCurrency(deals, "lost"), []);
  });
});
