import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { ProviderRequestError } from "../providerErrors.js";
import type { IntegrationRuntimeContext } from "../types.js";
import {
  BrexApiError,
  type BrexCashAccount,
  brexDateTime,
  brexProvider,
  getBrexCardTransactionsPage,
  getBrexCashTransactionsPage,
  listBrexCashAccounts,
  parseBrexDateTimeInput,
  summarizeBrexCashAccount,
} from "./brex.js";

/**
 * The Brex provider reads cash accounts, cash transactions and card
 * transactions from api.brex.com with a user token, and nothing else. These
 * tests pin the requests it makes, the errors its failures become, and what
 * an AI Employee is shown — above all the date filter on transactions.
 *
 * Brex reads `posted_at_start` as a date and time with no offset (every
 * date-time filter in its reference has an example like
 * `2022-12-12T23:59:59.999`) and refuses one with an offset with a bare 400
 * "Bad request". Genosyn sent `toISOString()`, whose `Z` is an offset, so
 * every sync after an account's first was refused — the first sends no date.
 * The stand-in here refuses such a date the same way, so a regression fails
 * these tests instead of every Banking account.
 */

const originalFetch = globalThis.fetch;
const originalTimeZone = process.env.TZ;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

const TOKEN = "bxt_test_token_1234";

type Call = { url: URL; headers: Headers; signal: AbortSignal | null | undefined };

function respond(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
  statusText?: string,
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A date and time with no offset, to the nanosecond — what Brex's date filters read. */
const BREX_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

/** Answer every request with `route` after Brex's own check of the date filter, recording each one. */
function mockBrex(route: (url: URL) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal });
    const since = url.searchParams.get("posted_at_start");
    if (since !== null && !BREX_DATE_TIME.test(since)) return respond({ message: "Bad request" }, 400);
    return route(url);
  }) as typeof fetch;
  return calls;
}

function cashAccount(id: string, name: string, primary: boolean): BrexCashAccount {
  return {
    id,
    name,
    status: "ACTIVE",
    current_balance: { amount: 4_821_000, currency: "USD" },
    available_balance: { amount: 4_800_000, currency: "USD" },
    account_number: "000123456789",
    routing_number: "121000000",
    primary,
  };
}

const PRIMARY = cashAccount("dpacc_primary", "Primary checking", true);
const RESERVE = cashAccount("dpacc_reserve", "Reserve", false);

const CASH_TXN = {
  id: "ctx_1",
  description: "Wire from Globex",
  amount: { amount: 125_000, currency: "USD" },
  initiated_at_date: "2026-10-20",
  posted_at_date: "2026-10-21",
  type: "WIRE",
  transfer_id: "tr_1",
};

const CARD_TXN = {
  id: "cctx_1",
  card_id: "card_1",
  description: "Delta Air Lines",
  amount: { amount: 18_900, currency: "USD" },
  initiated_at_date: "2026-10-19",
  posted_at_date: "2026-10-20",
  type: "PURCHASE",
};

/** A Brex with one page of everything, for the tests that only look at the request. */
function brexWithEverything(): Call[] {
  return mockBrex((url) => {
    if (url.pathname === "/v2/accounts/cash") return respond({ items: [PRIMARY, RESERVE], next_cursor: null });
    if (url.pathname.startsWith("/v2/transactions/cash/")) return respond({ items: [CASH_TXN], next_cursor: null });
    if (url.pathname === "/v2/transactions/card/primary") return respond({ items: [CARD_TXN], next_cursor: null });
    return respond({ message: `unexpected ${url.pathname}` }, 500);
  });
}

const ctx: IntegrationRuntimeContext = {
  authMode: "apikey",
  config: { userToken: TOKEN },
  companyId: "co_brex",
  connectionId: "conn_brex",
};

function tool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return brexProvider.invokeTool(name, args, ctx);
}

async function brexFailure(request: Promise<unknown>): Promise<BrexApiError> {
  try {
    await request;
  } catch (err) {
    assert.ok(err instanceof BrexApiError, `expected a BrexApiError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected Brex to refuse the request");
}

// ─────────────────────────── the date filter ───────────────────────────

describe("brexDateTime", () => {
  test("is the UTC date and time with no offset, the shape of Brex's own examples", () => {
    assert.equal(brexDateTime(new Date("2026-07-10T17:46:35.598Z")), "2026-07-10T17:46:35.598");
    assert.equal(brexDateTime(new Date("2022-12-12T23:59:59.999Z")), "2022-12-12T23:59:59.999");
    assert.match(brexDateTime(new Date()), BREX_DATE_TIME);
  });

  test("keeps the moment: written with another offset, it is the same instant in UTC", () => {
    assert.equal(brexDateTime(new Date("2026-07-10T19:46:35.598+02:00")), "2026-07-10T17:46:35.598");
    assert.equal(brexDateTime(new Date("2026-07-10T12:46:35.598-05:00")), "2026-07-10T17:46:35.598");
  });

  test("never carries an offset, and Brex reading it as UTC gets the moment back", () => {
    const moments = [
      new Date(0),
      new Date("2024-02-29T00:00:00.000Z"),
      new Date("2026-03-29T01:30:00.000Z"),
      new Date("2026-10-25T00:59:59.999Z"),
      new Date("2026-12-31T23:59:59.999Z"),
    ];
    for (let hour = 0; hour < 24 * 14; hour += 7) {
      moments.push(new Date(Date.UTC(2026, 6, 1) + hour * 3_600_000 + 123));
    }
    for (const at of moments) {
      const sent = brexDateTime(at);
      assert.match(sent, BREX_DATE_TIME, `${sent} has an offset`);
      assert.equal(Date.parse(`${sent}Z`), at.getTime(), sent);
    }
  });

  test("doesn't depend on the server's time zone", () => {
    const at = new Date("2026-07-10T23:30:00.000Z");
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"]) {
      process.env.TZ = zone;
      assert.equal(brexDateTime(at), "2026-07-10T23:30:00.000", zone);
    }
  });
});

describe("parseBrexDateTimeInput", () => {
  test("reads an RFC 3339 date-time, whatever its offset, as the moment it names", () => {
    assert.equal(parseBrexDateTimeInput("2026-07-10T17:46:35Z")?.toISOString(), "2026-07-10T17:46:35.000Z");
    assert.equal(parseBrexDateTimeInput("2026-07-10T17:46:35.598z")?.toISOString(), "2026-07-10T17:46:35.598Z");
    assert.equal(parseBrexDateTimeInput("2026-07-10T19:46:35+02:00")?.toISOString(), "2026-07-10T17:46:35.000Z");
    assert.equal(parseBrexDateTimeInput("2026-07-10T12:46:35-05:00")?.toISOString(), "2026-07-10T17:46:35.000Z");
  });

  test("reads a date and time without an offset, as Brex writes them, as UTC — not the server's time", () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
      process.env.TZ = zone;
      assert.equal(parseBrexDateTimeInput("2022-12-12T23:59:59.999")?.toISOString(), "2022-12-12T23:59:59.999Z", zone);
      assert.equal(parseBrexDateTimeInput("2026-07-10T17:46")?.toISOString(), "2026-07-10T17:46:00.000Z", zone);
      assert.equal(parseBrexDateTimeInput("2026-07-10 17:46:35")?.toISOString(), "2026-07-10T17:46:35.000Z", zone);
      assert.equal(parseBrexDateTimeInput("2026-07-10")?.toISOString(), "2026-07-10T00:00:00.000Z", zone);
    }
  });

  test("trims, and is null for anything that isn't a date", () => {
    assert.equal(parseBrexDateTimeInput("  2026-07-10T17:46:35Z\n")?.toISOString(), "2026-07-10T17:46:35.000Z");
    for (const value of ["", "   ", "yesterday", "2026-13-45T99:99:99", "not a date"]) {
      assert.equal(parseBrexDateTimeInput(value), null, JSON.stringify(value));
    }
  });
});

// ─────────────────────────── requests ───────────────────────────

describe("transaction pages", () => {
  test("Brex refuses toISOString()'s date, and the card page now sends the date it reads", async () => {
    const calls = brexWithEverything();
    const since = new Date("2026-07-10T17:46:35.598Z");

    // What every sync after the first used to send.
    const refused = await fetch(
      `https://api.brex.com/v2/transactions/card/primary?limit=100&posted_at_start=${since.toISOString()}`,
    );
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { message: "Bad request" });

    const page = await getBrexCardTransactionsPage(TOKEN, { postedAtStart: since });
    assert.deepEqual(page, { items: [CARD_TXN], next_cursor: null });
    const sent = calls[1].url;
    assert.equal(sent.pathname, "/v2/transactions/card/primary");
    assert.equal(sent.searchParams.get("posted_at_start"), "2026-07-10T17:46:35.598");
    assert.equal(sent.searchParams.get("limit"), "100");
    assert.equal(sent.searchParams.has("cursor"), false);
  });

  test("a cash page sends the same date, under the account it names", async () => {
    const calls = brexWithEverything();
    const page = await getBrexCashTransactionsPage(TOKEN, "dpacc_x/y", {
      postedAtStart: new Date("2026-07-11T09:01:17.542Z"),
      cursor: "cur_2",
      limit: 25,
    });
    assert.deepEqual(page.items, [CASH_TXN]);
    const [{ url }] = calls;
    assert.equal(url.pathname, "/v2/transactions/cash/dpacc_x%2Fy", "the account id is one path segment");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      cursor: "cur_2",
      limit: "25",
      posted_at_start: "2026-07-11T09:01:17.542",
    });
  });

  test("every page of a window carries the same date, the cursor beside it", async () => {
    const pages: Record<string, { items: unknown[]; next_cursor: string | null }> = {
      "": { items: [{ ...CARD_TXN, id: "a" }], next_cursor: "p2" },
      p2: { items: [{ ...CARD_TXN, id: "b" }], next_cursor: "p3" },
      p3: { items: [{ ...CARD_TXN, id: "c" }], next_cursor: null },
    };
    const calls = mockBrex((url) => respond(pages[url.searchParams.get("cursor") ?? ""]));
    const since = new Date("2026-10-17T06:00:00.000Z");
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const page = await getBrexCardTransactionsPage(TOKEN, { cursor, postedAtStart: since });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.deepEqual(
      calls.map((call) => [call.url.searchParams.get("cursor"), call.url.searchParams.get("posted_at_start")]),
      [
        [null, "2026-10-17T06:00:00.000"],
        ["p2", "2026-10-17T06:00:00.000"],
        ["p3", "2026-10-17T06:00:00.000"],
      ],
    );
  });

  test("without a date there is no filter: the first sync's walk of the whole history", async () => {
    const calls = brexWithEverything();
    await getBrexCardTransactionsPage(TOKEN);
    await getBrexCashTransactionsPage(TOKEN, "dpacc_primary");
    assert.equal(calls.length, 2);
    for (const { url } of calls) {
      assert.equal(url.searchParams.has("posted_at_start"), false, url.pathname);
      assert.equal(url.searchParams.get("limit"), "100");
    }
  });

  test("the token travels only in the Authorization header, with a timeout on every request", async () => {
    const calls = brexWithEverything();
    await listBrexCashAccounts(TOKEN);
    await getBrexCashTransactionsPage(TOKEN, "dpacc_primary", { postedAtStart: new Date() });
    await getBrexCardTransactionsPage(TOKEN, { postedAtStart: new Date() });
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url.origin, "https://api.brex.com");
      assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.headers.get("accept"), "application/json");
      assert.equal(call.url.href.includes(TOKEN), false, "never in the URL");
      assert.ok(call.signal, "a request that hangs is given up on");
    }
  });
});

describe("listBrexCashAccounts", () => {
  test("walks every page of accounts", async () => {
    const calls = mockBrex((url) =>
      url.searchParams.get("cursor") === "next"
        ? respond({ items: [RESERVE], next_cursor: null })
        : respond({ items: [PRIMARY], next_cursor: "next" }),
    );
    assert.deepEqual((await listBrexCashAccounts(TOKEN)).map((account) => account.id), [PRIMARY.id, RESERVE.id]);
    assert.deepEqual(
      calls.map((call) => call.url.search),
      ["?limit=100", "?limit=100&cursor=next"],
    );
  });

  test("stops on a cursor Brex already gave, rather than asking forever", async () => {
    const calls = mockBrex(() => respond({ items: [PRIMARY], next_cursor: "same" }));
    await assert.rejects(listBrexCashAccounts(TOKEN), /repeated account cursor/);
    assert.equal(calls.length, 2);
  });

  test("an empty answer is no accounts", async () => {
    mockBrex(() => respond({ next_cursor: null }));
    assert.deepEqual(await listBrexCashAccounts(TOKEN), []);
  });
});

describe("summarizeBrexCashAccount", () => {
  test("keeps the last four digits of the account number and drops the routing number", () => {
    const summary = summarizeBrexCashAccount(PRIMARY);
    assert.deepEqual(summary, {
      id: "dpacc_primary",
      name: "Primary checking",
      status: "ACTIVE",
      primary: true,
      accountNumberLast4: "6789",
      currentBalance: { amount: 4_821_000, currency: "USD" },
      availableBalance: { amount: 4_800_000, currency: "USD" },
    });
    assert.equal(JSON.stringify(summary).includes("121000000"), false);
    assert.equal(JSON.stringify(summary).includes("000123456789"), false);
  });

  test("an account with no status reads as null", () => {
    assert.equal(summarizeBrexCashAccount({ ...PRIMARY, status: undefined }).status, null);
  });
});

// ─────────────────────────── failures ───────────────────────────

describe("when Brex refuses", () => {
  test("a refused request keeps Brex's words, its status and what was asked — never the query", async () => {
    mockBrex(() => respond({ message: "Bad request" }, 400));
    const err = await brexFailure(getBrexCashTransactionsPage(TOKEN, "dpacc_primary", { cursor: "c", limit: 5 }));
    assert.ok(err instanceof ProviderRequestError, "Banking sorts it by status");
    assert.equal(err.name, "BrexApiError");
    assert.equal(err.provider, "Brex");
    assert.equal(err.message, "Bad request");
    assert.equal(err.status, 400);
    assert.equal(err.retryAfterMs, null);
    assert.equal(err.request, "GET /v2/transactions/cash/dpacc_primary");
  });

  test("Brex's words come from `message`, then `error`, then a plain-text body", async () => {
    mockBrex(() => respond({ error: "Invalid cursor" }, 400));
    assert.equal((await brexFailure(getBrexCardTransactionsPage(TOKEN))).message, "Invalid cursor");

    mockBrex(() => respond({ message: "Unauthorized", error: "unauthorized" }, 401));
    assert.equal((await brexFailure(getBrexCardTransactionsPage(TOKEN))).message, "Unauthorized");

    mockBrex(() => respond(`  upstream said no${" !".repeat(400)}`, 403));
    const plain = await brexFailure(getBrexCardTransactionsPage(TOKEN));
    assert.ok(plain.message.startsWith("upstream said no"));
    assert.equal(plain.message.length, 300, "a long body is cut short");
  });

  test("a proxy's HTML page or an empty body falls back to the status line", async () => {
    mockBrex(() => respond("<html><body>Bad Gateway</body></html>", 502, { "content-type": "text/html" }, "Bad Gateway"));
    const html = await brexFailure(getBrexCardTransactionsPage(TOKEN));
    assert.equal(html.message, "Brex 502 Bad Gateway");
    assert.equal(html.status, 502);

    mockBrex(() => respond("", 503, {}, "Service Unavailable"));
    assert.equal((await brexFailure(listBrexCashAccounts(TOKEN))).message, "Brex 503 Service Unavailable");
  });

  test("a busy Brex says how long to wait", async () => {
    mockBrex(() => respond({ message: "Too many requests" }, 429, { "retry-after": "30" }));
    const busy = await brexFailure(getBrexCardTransactionsPage(TOKEN));
    assert.equal(busy.status, 429);
    assert.equal(busy.retryAfterMs, 30_000);
  });

  test("a Brex that never answers is status 0, in words", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    const silent = await brexFailure(getBrexCashTransactionsPage(TOKEN, "dpacc_primary"));
    assert.equal(silent.status, 0);
    assert.equal(silent.message, "Brex didn't answer within 30 seconds. Try again.");
    assert.equal(silent.request, "GET /v2/transactions/cash/dpacc_primary");
  });

  test("a connection that fails outright is thrown as it was, for the sync to sort", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(
      getBrexCardTransactionsPage(TOKEN),
      (err: unknown) => err instanceof TypeError && !(err instanceof BrexApiError),
    );
  });
});

// ─────────────────────────── the Integration ───────────────────────────

describe("Brex catalog entry", () => {
  test("connects with one secret user token and offers only reading tools", () => {
    const { catalog, tools } = brexProvider;
    assert.equal(catalog.provider, "brex");
    assert.equal(catalog.authMode, "apikey");
    assert.deepEqual(
      catalog.fields?.map((field) => [field.key, field.type, field.required]),
      [["userToken", "password", true]],
    );
    assert.deepEqual(
      tools.map((entry) => entry.name),
      ["list_cash_accounts", "list_cash_transactions", "list_card_transactions"],
    );
  });
});

describe("validateApiKey", () => {
  test("reads the accounts and one transaction of the primary account, with no date filter", async () => {
    const calls = brexWithEverything();
    const { config, accountHint } = await brexProvider.validateApiKey!({ userToken: `  ${TOKEN}\n` });
    assert.deepEqual(config, { userToken: TOKEN }, "the token is trimmed");
    assert.equal(accountHint, "Primary checking · bxt…1234");
    assert.deepEqual(
      calls.map((call) => `${call.url.pathname}${call.url.search}`),
      ["/v2/accounts/cash?limit=100", "/v2/transactions/cash/dpacc_primary?limit=1"],
    );
  });

  test("needs a token, and a token that reaches a Cash account", async () => {
    await assert.rejects(brexProvider.validateApiKey!({ userToken: "   " }), /User token is required/);
    await assert.rejects(brexProvider.validateApiKey!({}), /User token is required/);
    mockBrex(() => respond({ items: [], next_cursor: null }));
    await assert.rejects(brexProvider.validateApiKey!({ userToken: TOKEN }), /accounts\.cash\.readonly/);
  });

  test("falls back to the first account when none is primary", async () => {
    const calls = mockBrex((url) =>
      url.pathname === "/v2/accounts/cash"
        ? respond({ items: [RESERVE], next_cursor: null })
        : respond({ items: [], next_cursor: null }),
    );
    const { accountHint } = await brexProvider.validateApiKey!({ userToken: TOKEN });
    assert.equal(accountHint, "Reserve · bxt…1234");
    assert.equal(calls[1].url.pathname, "/v2/transactions/cash/dpacc_reserve");
  });

  test("a token Brex rejects is not saved", async () => {
    mockBrex(() => respond({ message: "Unauthorized" }, 401));
    await assert.rejects(brexProvider.validateApiKey!({ userToken: TOKEN }), /Unauthorized/);
  });
});

describe("checkStatus", () => {
  test("is ok while Brex answers, and says what Brex said when it doesn't", async () => {
    brexWithEverything();
    assert.deepEqual(await brexProvider.checkStatus!(ctx), { ok: true });

    mockBrex(() => respond({ message: "Unauthorized" }, 401));
    assert.deepEqual(await brexProvider.checkStatus!(ctx), { ok: false, message: "Unauthorized" });

    mockBrex(() => respond({ items: [], next_cursor: null }));
    assert.deepEqual(await brexProvider.checkStatus!(ctx), { ok: false, message: "Brex returned no Cash accounts" });
  });
});

describe("tools", () => {
  test("list_cash_accounts shows balances without account or routing numbers", async () => {
    brexWithEverything();
    const result = (await tool("list_cash_accounts")) as { items: Array<{ id: string; accountNumberLast4: string }> };
    assert.deepEqual(
      result.items.map((item) => [item.id, item.accountNumberLast4]),
      [
        ["dpacc_primary", "6789"],
        ["dpacc_reserve", "6789"],
      ],
    );
    assert.equal(JSON.stringify(result).includes("000123456789"), false);
    assert.equal(JSON.stringify(result).includes("121000000"), false);
  });

  test("list_cash_transactions sends its date the way Brex reads it, whatever form it came in", async () => {
    const forms: Array<[string, string]> = [
      ["2026-07-10T17:46:35Z", "2026-07-10T17:46:35.000"],
      ["2026-07-10T19:46:35+02:00", "2026-07-10T17:46:35.000"],
      ["2022-12-12T23:59:59.999", "2022-12-12T23:59:59.999"],
      ["2026-07-10", "2026-07-10T00:00:00.000"],
    ];
    process.env.TZ = "America/Los_Angeles";
    for (const [given, sent] of forms) {
      const calls = brexWithEverything();
      const page = (await tool("list_cash_transactions", { accountId: " dpacc_primary ", postedAtStart: given })) as {
        items: unknown[];
      };
      assert.deepEqual(page.items, [CASH_TXN], given);
      assert.equal(calls[0].url.pathname, "/v2/transactions/cash/dpacc_primary");
      assert.equal(calls[0].url.searchParams.get("posted_at_start"), sent, given);
    }
  });

  test("list_cash_transactions refuses what isn't a date before asking Brex", async () => {
    const calls = brexWithEverything();
    await assert.rejects(
      tool("list_cash_transactions", { accountId: "dpacc_primary", postedAtStart: "last tuesday" }),
      /postedAtStart must be an RFC 3339 date-time/,
    );
    await assert.rejects(tool("list_cash_transactions", { postedAtStart: "2026-07-10" }), /accountId is required/);
    await assert.rejects(tool("list_cash_transactions", { accountId: "   " }), /accountId is required/);
    assert.equal(calls.length, 0);
  });

  test("list_cash_transactions without a date, a blank one included, has no filter", async () => {
    for (const postedAtStart of [undefined, "", "   "]) {
      const calls = brexWithEverything();
      await tool("list_cash_transactions", { accountId: "dpacc_primary", postedAtStart });
      assert.equal(calls[0].url.searchParams.has("posted_at_start"), false, JSON.stringify(postedAtStart));
    }
  });

  test("a page is between 1 and 100 transactions, 50 by default, and the cursor goes through", async () => {
    const limits: Array<[unknown, string]> = [
      [undefined, "50"],
      [0, "1"],
      [-3, "1"],
      [7.9, "7"],
      [100, "100"],
      [5000, "100"],
      ["20", "50"],
    ];
    for (const [limit, sent] of limits) {
      const calls = brexWithEverything();
      await tool("list_cash_transactions", { accountId: "dpacc_primary", limit, cursor: "cur_9" });
      await tool("list_card_transactions", { limit, cursor: "cur_9" });
      for (const call of calls) {
        assert.equal(call.url.searchParams.get("limit"), sent, `${String(limit)} on ${call.url.pathname}`);
        assert.equal(call.url.searchParams.get("cursor"), "cur_9");
      }
    }
  });

  test("list_card_transactions reads the primary card account, unfiltered", async () => {
    const calls = brexWithEverything();
    const page = (await tool("list_card_transactions")) as { items: unknown[] };
    assert.deepEqual(page.items, [CARD_TXN]);
    assert.equal(calls[0].url.pathname, "/v2/transactions/card/primary");
    assert.equal(calls[0].url.searchParams.has("posted_at_start"), false);
    assert.equal(calls[0].url.searchParams.has("cursor"), false);
  });

  test("an unknown tool is refused without asking Brex", async () => {
    const calls = brexWithEverything();
    await assert.rejects(tool("transfer_money"), /Unknown Brex tool: transfer_money/);
    assert.equal(calls.length, 0);
  });
});
