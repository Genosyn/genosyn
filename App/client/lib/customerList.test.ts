import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CUSTOMER_LIST_PAGE_SIZE,
  CUSTOMER_LIST_QUERY_MAX_LENGTH,
  clampCustomerPage,
  customerListApiParams,
  customerListPageRange,
  customerListRangeLabel,
  customerListViewKey,
  customerPageOffset,
  parseCustomerListParams,
  patchCustomerListParams,
} from "./customerList.js";

describe("parseCustomerListParams", () => {
  test("uses a clean first-page default", () => {
    assert.deepEqual(parseCustomerListParams(new URLSearchParams()), {
      query: "",
      page: 1,
      showArchived: false,
    });
  });

  test("reads and normalizes every supported URL field", () => {
    assert.deepEqual(
      parseCustomerListParams(
        new URLSearchParams({ q: "  ACME billing  ", page: "3", archived: "true" }),
      ),
      { query: "ACME billing", page: 3, showArchived: true },
    );
  });

  test("rejects malformed, fractional, zero, negative, exponential, and unsafe pages", () => {
    for (const page of [
      "nope",
      "2.5",
      "0",
      "-2",
      "2e2",
      String(Number.MAX_SAFE_INTEGER),
      "9007199254740992",
    ]) {
      assert.equal(parseCustomerListParams(new URLSearchParams({ page })).page, 1, page);
    }
  });

  test("accepts a base-ten page with leading zeroes and normalizes it", () => {
    assert.equal(parseCustomerListParams(new URLSearchParams({ page: "0002" })).page, 2);
  });

  test("only the canonical archived value enables archived rows", () => {
    for (const archived of ["false", "1", "TRUE", "yes", ""]) {
      assert.equal(
        parseCustomerListParams(new URLSearchParams({ archived })).showArchived,
        false,
        archived,
      );
    }
  });

  test("bounds a hand-edited URL query to the server limit", () => {
    const state = parseCustomerListParams(new URLSearchParams({ q: `  ${"x".repeat(240)}  ` }));
    assert.equal(state.query.length, CUSTOMER_LIST_QUERY_MAX_LENGTH);
  });

  test("decodes punctuation and Unicode through URLSearchParams", () => {
    const state = parseCustomerListParams(new URLSearchParams("q=R%26D+München"));
    assert.equal(state.query, "R&D München");
  });
});

describe("patchCustomerListParams", () => {
  test("a changed search trims the query and returns to page one", () => {
    const next = patchCustomerListParams(new URLSearchParams("q=old&page=4&archived=true"), {
      query: "  new customer  ",
    });
    assert.equal(next.toString(), "q=new+customer&archived=true");
  });

  test("clearing search removes its URL field and returns to page one", () => {
    const next = patchCustomerListParams(new URLSearchParams("q=acme&page=7"), {
      query: "   ",
    });
    assert.equal(next.toString(), "");
  });

  test("changing archive scope returns to page one", () => {
    const enabled = patchCustomerListParams(new URLSearchParams("q=acme&page=4"), {
      showArchived: true,
    });
    assert.equal(enabled.toString(), "q=acme&archived=true");

    const disabled = patchCustomerListParams(new URLSearchParams("q=acme&page=4&archived=true"), {
      showArchived: false,
    });
    assert.equal(disabled.toString(), "q=acme");
  });

  test("page navigation keeps the active search and archive scope", () => {
    const next = patchCustomerListParams(new URLSearchParams("q=acme&archived=true"), {
      page: 2,
    });
    assert.equal(next.toString(), "q=acme&page=2&archived=true");
  });

  test("omits the default page and normalizes an invalid requested page", () => {
    assert.equal(
      patchCustomerListParams(new URLSearchParams("page=5"), { page: 1 }).toString(),
      "",
    );
    assert.equal(
      patchCustomerListParams(new URLSearchParams("page=5"), { page: Number.NaN }).toString(),
      "",
    );
  });

  test("does not reset the page when a scope patch normalizes to the same value", () => {
    const next = patchCustomerListParams(new URLSearchParams("q=acme&page=3"), {
      query: " acme ",
      showArchived: false,
    });
    assert.equal(next.toString(), "q=acme&page=3");
  });

  test("preserves unrelated URL state", () => {
    const next = patchCustomerListParams(new URLSearchParams("source=inbox&page=2"), {
      page: 3,
    });
    assert.equal(next.toString(), "source=inbox&page=3");
  });

  test("preserves unrelated state while a changed scope removes the old page", () => {
    const next = patchCustomerListParams(
      new URLSearchParams("source=inbox&tab=all&q=old&page=4&archived=true"),
      { query: "new" },
    );
    assert.equal(next.get("source"), "inbox");
    assert.equal(next.get("tab"), "all");
    assert.equal(next.get("q"), "new");
    assert.equal(next.get("archived"), "true");
    assert.equal(next.has("page"), false);
  });

  test("does not mutate the input params", () => {
    const current = new URLSearchParams("q=acme&page=2&source=inbox");
    patchCustomerListParams(current, { query: "beta" });
    assert.equal(current.toString(), "q=acme&page=2&source=inbox");
  });
});

describe("customer list server query", () => {
  test("uses the fixed page size and converts a one-based page to an offset", () => {
    const params = customerListApiParams({ query: "", page: 3, showArchived: false });
    assert.equal(params.toString(), `limit=${CUSTOMER_LIST_PAGE_SIZE}&offset=50`);
  });

  test("includes encoded search and archive fields only when active", () => {
    const params = customerListApiParams({
      query: " Acme & Sons ",
      page: 2,
      showArchived: true,
    });
    assert.equal(params.toString(), "limit=25&offset=25&q=Acme+%26+Sons&archived=true");
  });

  test("gives equal states an equal stale-response key", () => {
    const canonical = { query: "acme", page: 2, showArchived: true };
    assert.equal(
      customerListViewKey(canonical),
      customerListViewKey({ ...canonical, query: " acme " }),
    );
    assert.notEqual(customerListViewKey(canonical), customerListViewKey({ ...canonical, page: 3 }));
  });
});

describe("customer pagination", () => {
  test("calculates page offsets and protects against invalid inputs", () => {
    assert.equal(customerPageOffset(1), 0);
    assert.equal(customerPageOffset(2), 25);
    assert.equal(customerPageOffset(4, 10), 30);
    assert.equal(customerPageOffset(0), 0);
    assert.equal(customerPageOffset(Number.NaN), 0);
  });

  test("describes an empty result without inventing page zero", () => {
    assert.deepEqual(customerListPageRange(8, 0), {
      page: 1,
      pageCount: 1,
      offset: 0,
      start: 0,
      end: 0,
      hasPrevious: false,
      hasNext: false,
    });
    assert.equal(customerListRangeLabel(8, 0), "0 customers");
  });

  test("describes the first of several pages", () => {
    assert.deepEqual(customerListPageRange(1, 51), {
      page: 1,
      pageCount: 3,
      offset: 0,
      start: 1,
      end: 25,
      hasPrevious: false,
      hasNext: true,
    });
  });

  test("describes a full middle page", () => {
    assert.deepEqual(customerListPageRange(2, 75), {
      page: 2,
      pageCount: 3,
      offset: 25,
      start: 26,
      end: 50,
      hasPrevious: true,
      hasNext: true,
    });
  });

  test("describes a partial final page and pluralizes the count", () => {
    assert.deepEqual(customerListPageRange(3, 51), {
      page: 3,
      pageCount: 3,
      offset: 50,
      start: 51,
      end: 51,
      hasPrevious: true,
      hasNext: false,
    });
    assert.equal(customerListRangeLabel(3, 51), "51–51 of 51 customers");
  });

  test("handles an exact page boundary", () => {
    const range = customerListPageRange(2, 50);
    assert.equal(range.end, 50);
    assert.equal(range.pageCount, 2);
    assert.equal(range.hasNext, false);
  });

  test("switches Next on only after the twenty-fifth customer", () => {
    const fullFirstPage = customerListPageRange(1, 25);
    assert.equal(fullFirstPage.pageCount, 1);
    assert.equal(fullFirstPage.hasNext, false);
    assert.equal(customerListRangeLabel(1, 25), "1–25 of 25 customers");

    const firstOfTwo = customerListPageRange(1, 26);
    assert.equal(firstOfTwo.pageCount, 2);
    assert.equal(firstOfTwo.hasNext, true);
    const secondOfTwo = customerListPageRange(2, 26);
    assert.equal(secondOfTwo.start, 26);
    assert.equal(secondOfTwo.end, 26);
    assert.equal(secondOfTwo.hasNext, false);
    assert.equal(customerListRangeLabel(2, 26), "26–26 of 26 customers");
  });

  test("clamps an out-of-range page to the last non-empty page", () => {
    assert.equal(clampCustomerPage(7, 51), 3);
    assert.deepEqual(customerListPageRange(7, 51), customerListPageRange(3, 51));
  });

  test("uses singular copy for one customer", () => {
    assert.equal(customerListRangeLabel(1, 1), "1–1 of 1 customer");
  });

  test("normalizes totals defensively", () => {
    assert.equal(customerListRangeLabel(1, -2), "0 customers");
    assert.equal(customerListRangeLabel(1, Number.NaN), "0 customers");
    assert.equal(customerListRangeLabel(1, 2.9), "1–2 of 2 customers");
  });
});
