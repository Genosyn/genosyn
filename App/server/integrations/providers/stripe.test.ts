import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { stripeProvider } from "./stripe.js";
import type { IntegrationRuntimeContext } from "../types.js";
import type { stripeReadPage } from "./stripe-read.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const ctx: IntegrationRuntimeContext = {
  authMode: "apikey", config: { apiKey: "stripe-secret" }, companyId: "co", connectionId: "conn",
};
type Page = ReturnType<typeof stripeReadPage>;
async function read(name: string, args: Record<string, unknown> = {}): Promise<Page> {
  return await stripeProvider.invokeTool(name, args, ctx) as Page;
}
function response(data: unknown[], has_more = false) {
  return new Response(JSON.stringify({ object: "list", data, has_more }));
}

describe("Stripe bounded reads", () => {
  test("continues each list with the same time and resource filters and never marks a final continuation complete from start", async () => {
    for (const [name, resource, filters] of [
      ["list_customers", "customers", { email: "member@example.com" }],
      ["list_subscriptions", "subscriptions", { customerId: "cus_1", status: "all" }],
      ["list_invoices", "invoices", { customerId: "cus_1", status: "paid" }],
      ["list_charges", "charges", { customerId: "cus_1" }],
    ] as const) {
      const calls: URL[] = [];
      globalThis.fetch = (async (url, init) => {
        const parsed = new URL(String(url));
        calls.push(parsed);
        assert.equal(parsed.pathname, `/v1/${resource}`);
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer stripe-secret");
        return parsed.searchParams.has("starting_after")
          ? response([{ id: "row_older", created: 101 }])
          : response([{ id: "row_first", created: 200 }], true);
      }) as typeof fetch;
      const args = { ...filters, limit: 1, createdGte: 100, createdLt: 300 };
      const first = await read(name, args);
      assert.equal(first.has_more, true);
      assert.equal(first.nextStartingAfter, "row_first");
      assert.equal(first.coverage.completeFromStart, false);
      assert.equal(first.coverage.reachedEnd, false);
      const second = await read(name, { ...args, startingAfter: first.nextStartingAfter });
      assert.equal(second.nextStartingAfter, null);
      assert.equal(second.coverage.reachedEnd, true);
      assert.equal(second.coverage.completeFromStart, false);
      assert.equal(second.coverage.oldestCreated, 101);
      assert.deepEqual(first.coverage.filters, second.coverage.filters);
      assert.equal(calls[1].searchParams.get("starting_after"), "row_first");
      calls[1].searchParams.delete("starting_after");
      assert.equal(calls[0].href, calls[1].href);
    }
  });

  test("compact invoices preserve financial amounts and omit large line items and metadata; full mode is explicit", async () => {
    const row = {
      id: "in_1", created: 100, currency: "usd", total: 1299, amount_paid: 1299,
      status: "paid", customer: { id: "cus_1", metadata: { large: "x".repeat(100_000) } },
      parent: { subscription_details: { subscription: "sub_1" } },
      lines: { data: [{ description: "x".repeat(100_000) }] }, metadata: { large: "x".repeat(100_000) },
    };
    globalThis.fetch = (async () => response([row])) as typeof fetch;
    const compact = await read("list_invoices");
    assert.equal(compact.coverage.completeFromStart, true);
    assert.equal(compact.coverage.format, "compact");
    assert.equal(compact.data[0].amount_paid, 1299);
    assert.equal(compact.data[0].customer, "cus_1");
    assert.equal(compact.data[0].subscription, "sub_1");
    assert.ok(JSON.stringify(compact).length < 2000);
    const full = await read("list_invoices", { compact: false });
    assert.equal(full.coverage.format, "full");
    assert.deepEqual(full.data[0], row);
  });

  test("subscription prices remain useful and nested truncation is visible", async () => {
    globalThis.fetch = (async () => response([{
      id: "sub_1", status: "active", customer: "cus_1", created: 100,
      items: { has_more: false, data: Array.from({ length: 8 }, (_, n) => ({
        id: `si_${n}`, quantity: n + 1,
        price: { id: `price_${n}`, currency: "usd", unit_amount: 1000, product: { id: "prod_1" }, recurring: { interval: "month", interval_count: 1 } },
      })) },
    }])) as typeof fetch;
    const page = await read("list_subscriptions");
    const items = page.data[0].items as { data: Array<{ quantity: number; price: { unit_amount: number; product: string } }>; has_more: boolean };
    assert.equal(page.coverage.statusScope, "not_canceled");
    assert.equal(items.data.length, 5);
    assert.equal(items.has_more, true);
    assert.equal(items.data[0].price.unit_amount, 1000);
    assert.equal(items.data[0].price.product, "prod_1");
  });

  test("an empty filtered first page is complete only for the reported scope", async () => {
    globalThis.fetch = (async (url) => {
      assert.equal(new URL(String(url)).searchParams.get("created[gte]"), "0");
      return response([]);
    }) as typeof fetch;
    const page = await read("list_customers", { email: "nobody@example.com", createdGte: 0 });
    assert.deepEqual(page.data, []);
    assert.equal(page.coverage.completeFromStart, true);
    assert.deepEqual(page.coverage.filters, { email: "nobody@example.com", "created[gte]": 0 });
    assert.equal(page.coverage.oldestCreated, null);
  });

  test("invalid bounds and malformed provider pages cannot masquerade as full coverage", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return response([]); }) as typeof fetch;
    await assert.rejects(read("list_charges", { createdGte: 100, createdLt: 100 }), /earlier/);
    await assert.rejects(read("list_charges", { createdGte: -1 }));
    await assert.rejects(read("list_charges", { startingAfter: " " }));
    assert.equal(calls, 0);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }))) as typeof fetch;
    await assert.rejects(read("list_charges"), /coverage could not be established/);
    globalThis.fetch = (async () => response([], true)) as typeof fetch;
    await assert.rejects(read("list_charges"), /advancing cursor/);
    globalThis.fetch = (async () => response([{ id: "ch_1" }], true)) as typeof fetch;
    await assert.rejects(read("list_charges", { startingAfter: "ch_1" }), /advancing cursor/);
  });
});
