import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { ConnectionAuthError, type IntegrationRuntimeContext } from "../types.js";
import {
  describeMercuryTransaction,
  getMercuryTransactionsPage,
  listMercuryAccounts,
  MERCURY_TOKEN_REJECTED,
  MercuryApiError,
  type MercuryAccount,
  type MercuryTransaction,
  mercuryAmountCents,
  mercuryProvider,
  normalizeMercuryToken,
} from "./mercury.js";

/**
 * The Mercury provider reads accounts and transactions from api.mercury.com
 * with a Read Only API token, and nothing else. These tests pin the requests
 * it makes, the sentences its failures become, and what an AI Employee is
 * shown — never a full account or routing number.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TOKEN = "secret-token:mercury_production_rma_abcdef123456";
const CHECKING_ID = "8f3c2a8e-7b6d-4c5e-9f1a-2b3c4d5e6f70";
const SAVINGS_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const CHECKING: MercuryAccount = {
  id: CHECKING_ID,
  name: "Mercury Checking ••1234",
  nickname: "Operating",
  status: "active",
  type: "mercury",
  kind: "checking",
  accountNumber: "202211111234",
  routingNumber: "091311229",
  availableBalance: 48_120.5,
  currentBalance: 48_212.33,
  createdAt: "2023-02-01T15:00:00Z",
  legalBusinessName: "Acme Inc",
  dashboardLink: "https://app.mercury.com/accounts/checking",
};

const SAVINGS: MercuryAccount = {
  ...CHECKING,
  id: SAVINGS_ID,
  name: "Mercury Savings ••9876",
  nickname: null,
  kind: "savings",
  accountNumber: "202211119876",
  availableBalance: 250_000,
  currentBalance: 250_000,
};

const PAYEE: MercuryAccount = {
  ...CHECKING,
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Landlord LLC",
  type: "recipient",
};

const DEPOSIT: MercuryTransaction = {
  id: "11111111-2222-4333-8444-555555555555",
  accountId: CHECKING_ID,
  amount: 1_250,
  status: "sent",
  createdAt: "2026-10-01T09:00:00Z",
  postedAt: "2026-10-02T09:00:00Z",
  kind: "externalTransfer",
  counterpartyId: "cp-1",
  counterpartyName: "Globex Corp",
  counterpartyNickname: null,
  bankDescription: "GLOBEX CORP INV-1042",
  note: null,
  externalMemo: "INV-1042",
  dashboardLink: "https://app.mercury.com/transactions/1",
  mercuryCategory: null,
  details: {
    electronicRoutingInfo: { accountNumber: "999999999", routingNumber: "021000021", bankName: "Chase" },
  },
};

type Call = { url: URL; headers: Headers };

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Answer every request with `route`, recording each one. */
function mockMercury(route: (url: URL) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    assert.equal(url.origin, "https://api.mercury.com");
    return route(url);
  }) as typeof fetch;
  return calls;
}

/** A Mercury that lists `accounts` two to a page, and `transactions` in one. */
function standardMercury(
  accounts: MercuryAccount[] = [CHECKING, SAVINGS, PAYEE],
  transactions: MercuryTransaction[] = [DEPOSIT],
) {
  return mockMercury((url) => {
    if (url.pathname === "/api/v1/accounts") {
      const after = url.searchParams.get("start_after");
      const from = after ? accounts.findIndex((account) => account.id === after) + 1 : 0;
      const page = accounts.slice(from, from + 2);
      const more = from + 2 < accounts.length;
      return respond({ accounts: page, page: more ? { nextPage: page[page.length - 1].id } : {} });
    }
    if (url.pathname === "/api/v1/transactions") {
      return respond({ transactions, page: {} });
    }
    return respond({ errors: { errorCode: "notFound", message: `unexpected ${url.pathname}` } }, 404);
  });
}

function ctx(): IntegrationRuntimeContext {
  return { authMode: "apikey", config: { apiToken: TOKEN } };
}

describe("connecting a token", () => {
  test("reads every page of accounts and one transaction, with the token as a bearer", async () => {
    const calls = standardMercury();
    const result = await mercuryProvider.validateApiKey!({ apiToken: `  ${TOKEN}  ` });
    assert.deepEqual(result.config, { apiToken: TOKEN });
    assert.equal(result.accountHint, "Acme Inc · sec…3456");
    assert.deepEqual(
      calls.map((call) => `${call.url.pathname}?${call.url.searchParams}`),
      [
        "/api/v1/accounts?limit=1000",
        `/api/v1/accounts?limit=1000&start_after=${SAVINGS_ID}`,
        `/api/v1/transactions?accountId=${CHECKING_ID}&order=asc&limit=1`,
      ],
    );
    for (const call of calls) assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  test("a token copied without Mercury's prefix gets it back", () => {
    assert.equal(normalizeMercuryToken("mercury_production_rma_abc"), "secret-token:mercury_production_rma_abc");
    assert.equal(normalizeMercuryToken(` ${TOKEN} `), TOKEN);
    assert.equal(normalizeMercuryToken("something-else"), "something-else");
  });

  test("a token Mercury rejects marks the Connection expired, in a sentence that says what to do", async () => {
    mockMercury(() =>
      respond({ errors: { errorCode: "invalidToken", message: "The API token is invalid" } }, 401),
    );
    await assert.rejects(
      mercuryProvider.validateApiKey!({ apiToken: TOKEN }),
      (err: unknown) =>
        err instanceof ConnectionAuthError &&
        err.connectionStatus === "expired" &&
        err.message === MERCURY_TOKEN_REJECTED,
    );
    assert.deepEqual(await mercuryProvider.checkStatus!(ctx()), {
      ok: false,
      message: MERCURY_TOKEN_REJECTED,
      status: "expired",
    });
  });

  test("a token with no open account at Mercury is refused", async () => {
    standardMercury([{ ...CHECKING, status: "archived" }, PAYEE]);
    await assert.rejects(
      mercuryProvider.validateApiKey!({ apiToken: TOKEN }),
      /Mercury returned no open accounts for this token/,
    );
    await assert.rejects(mercuryProvider.validateApiKey!({ apiToken: " " }), /API token is required/);
  });

  test("other refusals keep Mercury's words, its status, and when to try again", async () => {
    mockMercury(() => respond({ errors: { errorCode: "forbidden", message: "Token lacks scope" } }, 403));
    await assert.rejects(listMercuryAccounts(TOKEN), (err: unknown) => {
      assert.ok(err instanceof MercuryApiError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Token lacks scope/);
      assert.equal(err.request, "GET /api/v1/accounts");
      return true;
    });
    mockMercury(() => respond({}, 429, { "retry-after": "12" }));
    await assert.rejects(listMercuryAccounts(TOKEN), (err: unknown) => {
      assert.ok(err instanceof MercuryApiError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 12_000);
      return true;
    });
    mockMercury(() => respond("<html>Bad gateway</html>", 502));
    await assert.rejects(listMercuryAccounts(TOKEN), (err: unknown) => {
      assert.ok(err instanceof MercuryApiError);
      assert.equal(err.status, 502);
      assert.doesNotMatch(err.message, /html/i);
      return true;
    });
  });

  test("a transaction page keeps its cursor only while it has transactions", async () => {
    mockMercury(() => respond({ transactions: [DEPOSIT], page: { nextPage: DEPOSIT.id } }));
    assert.equal((await getMercuryTransactionsPage(TOKEN)).nextCursor, DEPOSIT.id);
    mockMercury(() => respond({ transactions: [], page: { nextPage: DEPOSIT.id } }));
    assert.equal((await getMercuryTransactionsPage(TOKEN)).nextCursor, null);
    await assert.rejects(
      getMercuryTransactionsPage(TOKEN, { accountId: "../accounts" }),
      /accountId must be a Mercury account id/,
    );
  });
});

describe("money and words", () => {
  test("dollars become cents without floating-point drift", () => {
    assert.equal(mercuryAmountCents(7.76), 776);
    assert.equal(mercuryAmountCents(-0.01), -1);
    assert.equal(mercuryAmountCents(48_212.33), 4_821_233);
    assert.equal(mercuryAmountCents(Number.NaN), null);
    assert.equal(mercuryAmountCents("12.00"), null);
  });

  test("a transaction is described by who it was with, else by what the bank called it", () => {
    assert.equal(describeMercuryTransaction(DEPOSIT), "Globex Corp");
    assert.equal(describeMercuryTransaction({ ...DEPOSIT, counterpartyNickname: "Globex" }), "Globex");
    assert.equal(
      describeMercuryTransaction({ ...DEPOSIT, counterpartyName: " ", counterpartyNickname: null }),
      "GLOBEX CORP INV-1042",
    );
    assert.equal(
      describeMercuryTransaction({ ...DEPOSIT, counterpartyName: "", bankDescription: null }),
      "Mercury transaction",
    );
  });
});

describe("what an AI Employee is shown", () => {
  test("its own accounts, with the last four digits and never a routing number", async () => {
    standardMercury();
    const result = (await mercuryProvider.invokeTool("list_accounts", {}, ctx())) as {
      items: Array<Record<string, unknown>>;
    };
    assert.deepEqual(result.items, [
      {
        accountId: CHECKING_ID,
        name: "Operating",
        kind: "checking",
        status: "active",
        accountNumberLast4: "1234",
        availableBalance: 48_120.5,
        currentBalance: 48_212.33,
        currency: "USD",
      },
      {
        accountId: SAVINGS_ID,
        name: "Mercury Savings ••9876",
        kind: "savings",
        status: "active",
        accountNumberLast4: "9876",
        availableBalance: 250_000,
        currentBalance: 250_000,
        currency: "USD",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /091311229|202211111234/);
  });

  test("transactions newest first, filtered as asked, without the counterparty's bank details", async () => {
    const calls = mockMercury(() =>
      respond({ transactions: [DEPOSIT], page: { nextPage: DEPOSIT.id } }),
    );
    const result = (await mercuryProvider.invokeTool(
      "list_transactions",
      { accountId: CHECKING_ID, status: "sent", start: "2026-10-01", end: "2026-10-31T23:59:59Z", limit: 5000 },
      ctx(),
    )) as { items: Array<Record<string, unknown>>; nextCursor: string | null };
    const params = calls[0].url.searchParams;
    assert.equal(params.get("accountId"), CHECKING_ID);
    assert.deepEqual(params.getAll("status"), ["sent"]);
    assert.equal(params.get("start"), "2026-10-01");
    assert.equal(params.get("end"), "2026-10-31T23:59:59.000Z");
    assert.equal(params.get("order"), "desc");
    assert.equal(params.get("limit"), "1000");
    assert.equal(result.nextCursor, DEPOSIT.id);
    assert.deepEqual(result.items[0], {
      id: DEPOSIT.id,
      accountId: CHECKING_ID,
      status: "sent",
      kind: "externalTransfer",
      amount: 1_250,
      currency: "USD",
      createdAt: "2026-10-01T09:00:00Z",
      postedAt: "2026-10-02T09:00:00Z",
      description: "Globex Corp",
      counterparty: "Globex Corp",
      bankDescription: "GLOBEX CORP INV-1042",
      note: null,
      externalMemo: "INV-1042",
      category: null,
      failedAt: null,
      reasonForFailure: null,
      dashboardLink: "https://app.mercury.com/transactions/1",
    });
    assert.doesNotMatch(JSON.stringify(result), /021000021|999999999/);
  });

  test("refuses inputs it can't pass on safely", async () => {
    standardMercury();
    await assert.rejects(
      mercuryProvider.invokeTool("list_transactions", { status: "settled" }, ctx()),
      /status must be one of pending, sent, cancelled, failed, reversed, blocked/,
    );
    await assert.rejects(
      mercuryProvider.invokeTool("list_transactions", { start: "last month" }, ctx()),
      /start must be a date/,
    );
    await assert.rejects(
      mercuryProvider.invokeTool("list_transactions", { accountId: "checking" }, ctx()),
      /accountId must be a Mercury account id/,
    );
    await assert.rejects(mercuryProvider.invokeTool("send_money", {}, ctx()), /Unknown Mercury tool/);
  });
});
