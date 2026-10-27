import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ConnectionAuthError, type IntegrationRuntimeContext } from "../types.js";
import {
  forgetRampTokensForTests,
  RAMP_CREDENTIALS_REJECTED,
  RAMP_GRANT_MISSING,
  RAMP_SCOPES,
  RAMP_SCOPES_MISSING,
  RampApiError,
  rampMinorToCents,
  rampNextCursor,
  rampProvider,
  type RampTransaction,
  rampTransactionAmount,
} from "./ramp.js";

/**
 * The Ramp provider trades a developer app's client ID and secret for an
 * access token, keeps that token in memory only, and reads card activity with
 * it. These tests pin the token exchange, what makes it fail and how each
 * failure reads, the money conversions, and what an AI Employee is shown.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(forgetRampTokensForTests);

const CLIENT = { clientId: "ramp_id_0123456789", clientSecret: "ramp_sec_abcdefghij" };
const BASIC = `Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString("base64")}`;

type Call = { method: string; url: URL; headers: Headers; body: string };

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PURCHASE: RampTransaction = {
  id: "tx-purchase",
  entity_amount: { value: 12_345, currency: "USD" },
  merchant_amount: { value: 11_000, currency: "EUR" },
  minor_unit_conversion_rate: 100,
  amount: 123.45,
  currency_code: "USD",
  state: "CLEARED",
  user_transaction_time: "2026-10-01T15:04:05Z",
  settlement_date: "2026-10-03T00:00:00Z",
  merchant_name: "Lufthansa",
  merchant_descriptor: "LUFTHANSA 2201",
  sk_category_name: "Airlines",
  card_id: "card-1",
  card_holder: { first_name: "Ada", last_name: "Lovelace", department_name: "Engineering" },
  memo: "Berlin offsite",
  original_transaction_id: null,
};

/**
 * Stand in for api.ramp.com: a token endpoint that hands out numbered tokens,
 * and read endpoints that answer from `pages`. Every request is recorded.
 */
function mockRamp(
  options: {
    token?: (call: Call) => Response | null;
    read?: (call: Call, token: string) => Response | null;
  } = {},
): { calls: Call[]; issued: string[] } {
  const calls: Call[] = [];
  const issued: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    assert.equal(url.origin, "https://api.ramp.com");
    if (url.pathname === "/developer/v1/token") {
      const override = options.token?.(call);
      if (override) return override;
      const token = `ramp_business_tok_${issued.length + 1}`;
      issued.push(token);
      return respond({ access_token: token, token_type: "Bearer", expires_in: 864_000, scope: RAMP_SCOPES.join(" ") });
    }
    const token = (call.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const override = options.read?.(call, token);
    if (override) return override;
    if (url.pathname === "/developer/v1/business") {
      return respond({ id: "biz", business_name_legal: "Acme Inc", business_name_on_card: "ACME" });
    }
    if (url.pathname === "/developer/v1/business/balance") {
      return respond({
        card_balance_excluding_pending_amount: { amount: 250_075, currency_code: "USD", minor_unit_conversion_rate: 100 },
        card_balance_including_pending_amount: { amount: 260_000, currency_code: "USD", minor_unit_conversion_rate: 100 },
        statement_balance_amount: { amount: 180_000, currency_code: "USD", minor_unit_conversion_rate: 100 },
        available_card_limit_amount: { amount: 4_749_925, currency_code: "USD", minor_unit_conversion_rate: 100 },
        card_limit_amount: { amount: 5_000_000, currency_code: "USD", minor_unit_conversion_rate: 100 },
        next_billing_date: "2026-11-01",
        prev_billing_date: "2026-10-01",
      });
    }
    if (url.pathname === "/developer/v1/transactions") {
      return respond({
        data: [PURCHASE],
        page: { next: "https://api.ramp.com/developer/v1/transactions?page_size=50&start=tx-purchase" },
      });
    }
    if (url.pathname === "/developer/v1/transfers") {
      return respond({
        data: [{ id: "tr-1", amount: { amount: 180_000, currency_code: "USD", minor_unit_conversion_rate: 100 }, status: "COMPLETED", created_at: "2026-10-05T10:00:00Z" }],
        page: { next: null },
      });
    }
    if (url.pathname === "/developer/v1/cashbacks") {
      return respond({
        data: [{ id: "cb-1", amount: { amount: 2_700, currency_code: "USD", minor_unit_conversion_rate: 100 }, created_at: "2026-10-02T00:00:00Z" }],
        page: { next: null },
      });
    }
    return respond({ error_v2: { error_code: "DEVELOPER_7000", message: `unexpected ${url.pathname}` } }, 500);
  }) as typeof fetch;
  return { calls, issued };
}

function ctx(): IntegrationRuntimeContext {
  return { authMode: "apikey", config: { ...CLIENT } };
}

describe("signing in with a developer app", () => {
  test("trades the client ID and secret for a token once, asks for every scope, and stores no token", async () => {
    const { calls } = mockRamp();
    const result = await rampProvider.validateApiKey!({ ...CLIENT });
    assert.deepEqual(result.config, CLIENT, "only the client ID and secret are kept");
    assert.equal(result.accountHint, "Acme Inc · ram…6789");

    const tokenCalls = calls.filter((call) => call.url.pathname === "/developer/v1/token");
    assert.equal(tokenCalls.length, 1);
    const [token] = tokenCalls;
    assert.equal(token.method, "POST");
    assert.equal(token.headers.get("authorization"), BASIC);
    assert.equal(token.headers.get("content-type"), "application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.body);
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.deepEqual(form.get("scope")?.split(" "), [...RAMP_SCOPES]);

    // It proved every read a card syncs with, under the one token.
    const reads = calls.filter((call) => call.method === "GET");
    assert.deepEqual(
      reads.map((call) => call.url.pathname),
      ["/developer/v1/business", "/developer/v1/transactions", "/developer/v1/transfers", "/developer/v1/cashbacks"],
    );
    for (const read of reads) {
      assert.equal(read.headers.get("authorization"), "Bearer ramp_business_tok_1");
    }
  });

  test("reuses the token until a request is refused, then gets one new token", async () => {
    let refuse = true;
    const { calls, issued } = mockRamp({
      read: (call, token) => {
        // Ramp answers a token it doesn't know with a 404, not a 401.
        if (token === "ramp_business_tok_1" && refuse && call.url.pathname === "/developer/v1/business/balance") {
          refuse = false;
          return respond(
            {
              error: { error_code: "DEVELOPER_7002", message: "Access token with given access_token not found" },
              error_v2: { error_code: "DEVELOPER_7002", error_id: "1a2b3c4d", message: "Access token with given access_token not found" },
            },
            404,
          );
        }
        return null;
      },
    });
    await rampProvider.invokeTool("list_cashbacks", {}, ctx());
    const balance = (await rampProvider.invokeTool("get_card_balance", {}, ctx())) as Record<string, unknown>;
    assert.deepEqual(issued, ["ramp_business_tok_1", "ramp_business_tok_2"]);
    assert.equal(calls.filter((call) => call.url.pathname === "/developer/v1/business/balance").length, 2);
    assert.equal(balance.cardBalance, 2500.75);
  });

  test("a token refused twice is a credential Ramp rejected", async () => {
    mockRamp({
      read: () => respond({ error_v2: { error_code: "DEVELOPER_7002", message: "not found" } }, 404),
    });
    await assert.rejects(
      rampProvider.invokeTool("list_cashbacks", {}, ctx()),
      (err: unknown) =>
        err instanceof ConnectionAuthError &&
        err.connectionStatus === "expired" &&
        err.message === RAMP_CREDENTIALS_REJECTED,
    );
  });

  test("a wrong client ID or secret marks the Connection expired", async () => {
    mockRamp({ token: () => respond({ error: "invalid_client", error_description: "Client authentication failed" }, 401) });
    await assert.rejects(
      rampProvider.validateApiKey!({ ...CLIENT }),
      (err: unknown) => err instanceof ConnectionAuthError && err.connectionStatus === "expired",
    );
    const status = await rampProvider.checkStatus!(ctx());
    assert.deepEqual(status, { ok: false, message: RAMP_CREDENTIALS_REJECTED, status: "expired" });
  });

  test("an app missing a scope or the grant type is its setup, not its secret", async () => {
    mockRamp({ token: () => respond({ error: "invalid_scope", error_description: "Requested scope is not allowed" }, 400) });
    await assert.rejects(
      rampProvider.validateApiKey!({ ...CLIENT }),
      (err: unknown) => err instanceof RampApiError && err.status === 403 && err.message === RAMP_SCOPES_MISSING,
    );
    forgetRampTokensForTests();
    mockRamp({
      token: () =>
        respond({ error_v2: { error_code: "unauthorized_client", message: "Grant type not allowed" } }, 400),
    });
    await assert.rejects(
      rampProvider.validateApiKey!({ ...CLIENT }),
      (err: unknown) => err instanceof RampApiError && err.status === 403 && err.message === RAMP_GRANT_MISSING,
    );
  });

  test("asks for both halves of the credential", async () => {
    await assert.rejects(rampProvider.validateApiKey!({ clientId: " ", clientSecret: "x" }), /Client ID is required/);
    await assert.rejects(rampProvider.validateApiKey!({ clientId: "x", clientSecret: "" }), /Client secret is required/);
  });
});

describe("money", () => {
  test("Ramp's smallest units become hundredths, whatever the currency's decimals", () => {
    assert.equal(rampMinorToCents(12_345), 12_345);
    assert.equal(rampMinorToCents(12_345, 100), 12_345);
    assert.equal(rampMinorToCents(1_500, 1), 150_000, "1500 yen");
    assert.equal(rampMinorToCents(1_234, 1000), 123, "1.234 dinar, to the hundredth");
    assert.equal(rampMinorToCents(-2_700, 100), -2_700);
    assert.equal(rampMinorToCents(1.5), null);
    assert.equal(rampMinorToCents("100"), null);
  });

  test("a transaction's settled amount comes from entity_amount, signed as Ramp signs it", () => {
    assert.deepEqual(rampTransactionAmount(PURCHASE), { cents: 12_345, currency: "USD" });
    assert.deepEqual(
      rampTransactionAmount({ ...PURCHASE, entity_amount: { value: -4_000, currency: "usd" } }),
      { cents: -4_000, currency: "USD" },
    );
  });

  test("an older transaction with only the deprecated amount is a refund when it names a purchase", () => {
    const old = { ...PURCHASE, entity_amount: null, amount: 40, currency_code: "USD" };
    assert.deepEqual(rampTransactionAmount(old), { cents: 4_000, currency: "USD" });
    assert.deepEqual(
      rampTransactionAmount({ ...old, original_transaction_id: "tx-purchase" }),
      { cents: -4_000, currency: "USD" },
    );
    assert.equal(rampTransactionAmount({ ...old, currency_code: null }), null);
    assert.equal(rampTransactionAmount({ ...old, amount: null }), null);
  });
});

describe("pages", () => {
  test("only the cursor is read from a next link", () => {
    assert.equal(
      rampNextCursor({ page: { next: "https://api.ramp.com/developer/v1/transactions?page_size=2&start=abc" } }),
      "abc",
    );
    assert.equal(rampNextCursor({ page: { next: null } }), null);
    assert.equal(rampNextCursor({ page: { next: "https://api.ramp.com/developer/v1/transactions" } }), null);
    assert.equal(rampNextCursor({}), null);
  });
});

describe("what an AI Employee is shown", () => {
  test("transactions in dollars with the cardholder, the merchant's own currency, and the next cursor", async () => {
    const { calls } = mockRamp();
    const result = (await rampProvider.invokeTool(
      "list_transactions",
      { fromDate: "2026-10-01T00:00:00Z", state: "CLEARED", pageSize: 500 },
      ctx(),
    )) as { items: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.deepEqual(result.items, [
      {
        id: "tx-purchase",
        state: "CLEARED",
        amount: 123.45,
        currency: "USD",
        merchantAmount: { amount: 110, currency: "EUR" },
        transactionTime: "2026-10-01T15:04:05Z",
        settlementDate: "2026-10-03T00:00:00Z",
        merchant: "Lufthansa",
        merchantCategory: "Airlines",
        cardId: "card-1",
        cardholder: "Ada Lovelace",
        department: "Engineering",
        memo: "Berlin offsite",
        refundOf: null,
      },
    ]);
    assert.equal(result.nextCursor, "tx-purchase");
    const request = calls.find((call) => call.url.pathname === "/developer/v1/transactions")!;
    assert.equal(request.url.searchParams.get("page_size"), "100", "clamped to Ramp's largest page");
    assert.equal(request.url.searchParams.get("state"), "CLEARED");
    assert.equal(request.url.searchParams.get("from_date"), "2026-10-01T00:00:00.000Z");
  });

  test("bill payments, cashback, and the card balance", async () => {
    mockRamp();
    assert.deepEqual(await rampProvider.invokeTool("list_bill_payments", {}, ctx()), {
      items: [{ id: "tr-1", status: "COMPLETED", amount: 1800, currency: "USD", createdAt: "2026-10-05T10:00:00Z" }],
      nextCursor: null,
    });
    assert.deepEqual(await rampProvider.invokeTool("list_cashbacks", {}, ctx()), {
      items: [{ id: "cb-1", amount: 27, currency: "USD", createdAt: "2026-10-02T00:00:00Z" }],
      nextCursor: null,
    });
    assert.deepEqual(await rampProvider.invokeTool("get_card_balance", {}, ctx()), {
      cardBalance: 2500.75,
      cardBalanceWithPending: 2600,
      statementBalance: 1800,
      availableCardLimit: 47499.25,
      cardLimit: 50000,
      currency: "USD",
      nextBillingDate: "2026-11-01",
      previousBillingDate: "2026-10-01",
    });
  });

  test("refuses a date it can't read rather than asking Ramp for everything", async () => {
    mockRamp();
    await assert.rejects(
      rampProvider.invokeTool("list_transactions", { fromDate: "last week" }, ctx()),
      /fromDate must be an RFC 3339 date-time/,
    );
    await assert.rejects(rampProvider.invokeTool("move_money", {}, ctx()), /Unknown Ramp tool/);
  });
});
