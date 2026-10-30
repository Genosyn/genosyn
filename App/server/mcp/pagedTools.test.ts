import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BANKING_PAGE, bankingFilterShape } from "../services/bankingQueue.js";
import { BILL_PAGE, CUSTOMER_PAGE, INVOICE_PAGE, RECURRING_INVOICE_PAGE } from "../services/financeListPages.js";
import { pageBodyShape } from "../services/listPaging.js";
import { MEETING_PAGE } from "../services/meetings/store.js";
import { LEDGER_REVIEW_PAGE, ledgerReviewFilterShape } from "../services/transactionReviews.js";
import { STATIC_TOOLS } from "./toolManifest.js";

/**
 * The paging contract as the model reads it. Every paged list tool advertises
 * `limit` (with the same maximum the server cuts to) and `cursor`, says in its
 * description how to read on, and never advertises an argument its endpoint
 * refuses — or hides one it takes.
 */

const PAGED: Record<string, { max: number; default: number }> = {
  list_banking_transactions: { max: BANKING_PAGE.maxLimit, default: BANKING_PAGE.defaultLimit },
  list_finance_transactions: { max: LEDGER_REVIEW_PAGE.maxLimit, default: LEDGER_REVIEW_PAGE.defaultLimit },
  list_invoices: { max: INVOICE_PAGE.maxLimit, default: INVOICE_PAGE.defaultLimit },
  list_bills: { max: BILL_PAGE.maxLimit, default: BILL_PAGE.defaultLimit },
  list_recurring_invoices: {
    max: RECURRING_INVOICE_PAGE.maxLimit,
    default: RECURRING_INVOICE_PAGE.defaultLimit,
  },
  list_customers: { max: CUSTOMER_PAGE.maxLimit, default: CUSTOMER_PAGE.defaultLimit },
  list_meetings: { max: MEETING_PAGE.maxLimit, default: MEETING_PAGE.defaultLimit },
  search_mail: { max: 50, default: 20 },
  list_runs: { max: 50, default: 20 },
  list_handoffs: { max: 200, default: 50 },
  list_todos: { max: 200, default: 50 },
};

function tool(name: string) {
  const found = STATIC_TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `${name} is in the manifest`);
  return found;
}

describe("paged list tools", () => {
  for (const [name, limits] of Object.entries(PAGED)) {
    test(`${name} advertises limit and cursor, and how to read on`, () => {
      const spec = tool(name);
      const properties = spec.inputSchema.properties as Record<
        string,
        { type?: string; minimum?: number; maximum?: number; description?: string }
      >;
      assert.equal(properties.limit?.type, "integer");
      assert.equal(properties.limit?.minimum, 1);
      assert.equal(properties.limit?.maximum, limits.max, "the maximum the server cuts to");
      assert.match(properties.limit?.description ?? "", new RegExp(`default ${limits.default}`));
      assert.equal(properties.cursor?.type, "string");
      assert.match(properties.cursor?.description ?? "", /nextCursor/);
      assert.match(spec.description, /nextCursor/);
      assert.match(spec.description, /hasMore/);
      assert.equal(spec.inputSchema.additionalProperties, false);
      assert.equal("offset" in properties, false, "one way to page: the cursor");
    });
  }

  test("the Banking and Entry review tools advertise exactly the filters their endpoints take", () => {
    for (const [name, shape] of [
      ["list_banking_transactions", { ...bankingFilterShape, ...pageBodyShape }],
      ["list_finance_transactions", { ...ledgerReviewFilterShape, ...pageBodyShape }],
    ] as const) {
      assert.deepEqual(
        Object.keys(tool(name).inputSchema.properties).sort(),
        Object.keys(shape).sort(),
        name,
      );
    }
  });

  test("read-only list tools stay read-only", () => {
    for (const name of ["list_banking_transactions", "list_bills"]) {
      assert.equal(tool(name).readOnly, true, name);
    }
  });

  test("a mailbox search says why it has no total", () => {
    assert.match(tool("search_mail").description, /no total/i);
  });
});
