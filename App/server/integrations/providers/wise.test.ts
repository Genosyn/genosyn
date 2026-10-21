import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { ConnectionAuthError, type IntegrationRuntimeContext } from "../types.js";
import {
  describeWiseTransaction,
  getWiseBalanceStatement,
  listWiseBalances,
  listWiseProfiles,
  readWiseId,
  WISE_API_VERSION,
  WISE_SCA_MESSAGE,
  WiseApiError,
  WiseScaRequiredError,
  type WiseStatementTransaction,
  wiseAmountCents,
  wiseProfileName,
  wiseProvider,
  wiseTransactionKey,
} from "./wise.js";

/**
 * The Wise provider reads three things straight from api.wise.com with a
 * personal API token — profiles, balances, and balance statements — and
 * nothing else. These tests pin the requests it makes, the sentences its
 * failures become, and what an AI Employee is shown.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TOKEN = "wise-personal-token-1234";
const V = `/${WISE_API_VERSION}`;

type Call = {
  url: URL;
  method: string;
  headers: Headers;
  signal: AbortSignal | null | undefined;
};

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Answer every request with `route`, recording each one. */
function mockWise(route: (url: URL) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      signal: init?.signal,
    });
    return route(url);
  }) as typeof fetch;
  return calls;
}

const BUSINESS = {
  id: 30000001,
  type: "BUSINESS",
  businessName: "Acme Inc",
  fullName: "Acme Inc",
  email: "finance@acme.example",
  currentState: "VISIBLE",
  address: { countryIso2Code: "US" },
  contactDetails: { email: "finance@acme.example", phoneNumber: "+15550100" },
};

const PERSONAL = {
  id: 30000002,
  type: "PERSONAL",
  firstName: "Ada",
  lastName: "Lovelace",
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  dateOfBirth: "1815-12-10",
  phoneNumber: "+15550199",
  currentState: "VISIBLE",
  address: { countryIso2Code: "US" },
};

const USD = {
  id: 200001,
  currency: "USD",
  type: "STANDARD",
  name: null,
  amount: { value: 12345.67, currency: "USD" },
  reservedAmount: { value: 10, currency: "USD" },
  cashAmount: { value: 12355.67, currency: "USD" },
  totalWorth: { value: 12355.67, currency: "USD" },
  investmentState: "NOT_INVESTED",
  creationTime: "2024-01-15T10:00:00.000Z",
  modificationTime: "2026-10-03T18:02:11.832Z",
  visible: true,
};

const EUR = {
  ...USD,
  id: 200002,
  currency: "EUR",
  amount: { value: 310.86, currency: "EUR" },
  reservedAmount: { value: 0, currency: "EUR" },
  cashAmount: { value: 310.86, currency: "EUR" },
  totalWorth: { value: 310.86, currency: "EUR" },
};

const GBP = { ...USD, id: 200003, currency: "GBP", amount: { value: 5, currency: "GBP" } };

const DEPOSIT: WiseStatementTransaction = {
  type: "CREDIT",
  date: "2026-10-01T09:15:00.000Z",
  amount: { value: 1500, currency: "USD" },
  totalFees: { value: 0, currency: "USD" },
  details: {
    type: "DEPOSIT",
    description: "Received money from GLOBEX LLC with reference INV-0042",
    senderName: "GLOBEX LLC",
    senderAccount: "US12 3456 7890 1234",
    paymentReference: "INV-0042",
  },
  runningBalance: { value: 13845.67, currency: "USD" },
  referenceNumber: "TRANSFER-34188888",
};

const CARD: WiseStatementTransaction = {
  type: "DEBIT",
  date: "2026-10-03T18:02:11.832Z",
  amount: { value: -7.76, currency: "USD" },
  totalFees: { value: 0.04, currency: "USD" },
  details: {
    type: "CARD",
    description: "Card transaction of 6.80 GBP issued by Tfl.gov.uk/cp TFL TRAVEL CH",
    merchant: { name: "Tfl.gov.uk/cp" },
  },
  runningBalance: { value: 13837.91, currency: "USD" },
  referenceNumber: "CARD-249281",
};

const BALANCES_PATH = new RegExp(`^${V}/profiles/(\\d+)/balances$`);
const STATEMENT_PATH = new RegExp(`^${V}/profiles/(\\d+)/balance-statements/(\\d+)/statement\\.json$`);

/** A Wise account with a business and a personal profile, as most tokens see it. */
function wiseAccount(
  world: {
    profiles?: unknown;
    balances?: Record<string, unknown>;
    statement?: (url: URL) => Response;
  } = {},
): Call[] {
  return mockWise((url) => {
    if (url.pathname === `${V}/profiles`) return respond(world.profiles ?? [BUSINESS, PERSONAL]);
    const balances = BALANCES_PATH.exec(url.pathname);
    if (balances) {
      const defaults: Record<string, unknown> = {
        [BUSINESS.id]: [USD, EUR],
        [PERSONAL.id]: [GBP],
      };
      return respond({ ...defaults, ...world.balances }[balances[1]] ?? []);
    }
    if (STATEMENT_PATH.test(url.pathname)) {
      return world.statement
        ? world.statement(url)
        : respond({
            transactions: [DEPOSIT, CARD],
            endOfStatementBalance: { value: 13837.91, currency: "USD" },
          });
    }
    return respond({ message: `unexpected ${url.pathname}` }, 500);
  });
}

const ctx: IntegrationRuntimeContext = {
  authMode: "apikey",
  config: { apiToken: TOKEN },
  companyId: "co_wise",
  connectionId: "conn_wise",
};

function tool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return wiseProvider.invokeTool(name, args, ctx);
}

describe("Wise catalog entry", () => {
  test("connects with one secret API token and offers only reading tools", () => {
    const { catalog, tools } = wiseProvider;
    assert.equal(catalog.provider, "wise");
    assert.equal(catalog.category, "Payments");
    assert.equal(catalog.authMode, "apikey");
    assert.equal(catalog.enabled, true);
    assert.deepEqual(
      catalog.fields?.map((field) => [field.key, field.type, field.required]),
      [["apiToken", "password", true]],
    );
    // Profiles, balances, statements — nothing that sends, converts or funds.
    assert.deepEqual(
      tools.map((t) => t.name),
      ["list_profiles", "list_balances", "get_balance_statement"],
    );
    for (const t of tools) {
      assert.doesNotMatch(t.name, /send|transfer|convert|fund|pay|create|delete|update/);
    }
    assert.match(catalog.description ?? "", /never sends or converts money/);
    assert.match(catalog.description ?? "", /US, Canada, Australia, New Zealand, Singapore and Malaysia/);
  });
});

describe("Wise requests", () => {
  test("every request is a GET to the pinned API version with the bearer token and a timeout", async () => {
    const calls = wiseAccount();
    await listWiseProfiles(TOKEN);
    await listWiseBalances(TOKEN, BUSINESS.id);
    await getWiseBalanceStatement(TOKEN, BUSINESS.id, USD.id, {
      currency: "USD",
      intervalStart: new Date("2026-10-01T00:00:00.000Z"),
      intervalEnd: new Date("2026-10-20T00:00:00.000Z"),
    });
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url.origin, "https://api.wise.com");
      assert.ok(call.url.pathname.startsWith(`${V}/`), call.url.pathname);
      assert.equal(call.method, "GET");
      assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.headers.get("accept"), "application/json");
      assert.ok(call.signal instanceof AbortSignal, "every request carries a timeout");
    }
  });

  test("balances are the standard ones, one per currency", async () => {
    const calls = wiseAccount();
    const balances = await listWiseBalances(TOKEN, String(BUSINESS.id));
    assert.deepEqual(
      balances.map((balance) => [balance.id, balance.currency]),
      [
        [200001, "USD"],
        [200002, "EUR"],
      ],
    );
    assert.equal(calls[0].url.pathname, `${V}/profiles/30000001/balances`);
    assert.equal(calls[0].url.searchParams.get("types"), "STANDARD");
  });

  test("a statement asks for one balance, in its currency, over a UTC interval, one line per transaction", async () => {
    const calls = wiseAccount();
    const statement = await getWiseBalanceStatement(TOKEN, BUSINESS.id, USD.id, {
      currency: "USD",
      intervalStart: new Date("2026-10-01T00:00:00+02:00"),
      intervalEnd: new Date("2026-10-20T12:30:00.000Z"),
    });
    assert.equal(statement.transactions.length, 2);
    const url = calls[0].url;
    assert.equal(url.pathname, `${V}/profiles/30000001/balance-statements/200001/statement.json`);
    assert.equal(url.searchParams.get("currency"), "USD");
    assert.equal(url.searchParams.get("intervalStart"), "2026-09-30T22:00:00.000Z");
    assert.equal(url.searchParams.get("intervalEnd"), "2026-10-20T12:30:00.000Z");
    assert.equal(url.searchParams.get("type"), "COMPACT");
  });

  test("an interval Wise would refuse is refused without asking", async () => {
    const calls = wiseAccount();
    const start = new Date("2025-01-01T00:00:00.000Z");
    const read = (end: Date) =>
      getWiseBalanceStatement(TOKEN, BUSINESS.id, USD.id, {
        currency: "USD",
        intervalStart: start,
        intervalEnd: end,
      });
    await assert.rejects(read(start), /intervalEnd must be after intervalStart/);
    await assert.rejects(read(new Date("2024-12-31T00:00:00.000Z")), /after intervalStart/);
    await assert.rejects(
      read(new Date(start.getTime() + 469 * 86_400_000 + 1)),
      /at most 469 days/,
    );
    assert.equal(calls.length, 0);
    // Exactly 469 days is the longest interval Wise accepts.
    await read(new Date(start.getTime() + 469 * 86_400_000));
    assert.equal(calls.length, 1);
  });

  test("ids reach the path only as digits", async () => {
    const calls = wiseAccount();
    const range = {
      currency: "USD",
      intervalStart: new Date("2026-10-01T00:00:00.000Z"),
      intervalEnd: new Date("2026-10-02T00:00:00.000Z"),
    };
    await assert.rejects(listWiseBalances(TOKEN, "../profiles"), /profileId must be a Wise id/);
    await assert.rejects(listWiseBalances(TOKEN, "1/../../v1/transfers"), /must be a Wise id/);
    await assert.rejects(getWiseBalanceStatement(TOKEN, 1, "2?x=1", range), /balanceId must be/);
    assert.equal(calls.length, 0);
  });

  test("an id too large for a JSON number is refused rather than misread", async () => {
    wiseAccount({ profiles: [{ ...BUSINESS, id: 2 ** 53 + 2 }] });
    await assert.rejects(listWiseProfiles(TOKEN), /profile id Genosyn can't read safely/);
    wiseAccount({ profiles: [{ ...BUSINESS, id: "30000001" }] });
    await assert.rejects(listWiseProfiles(TOKEN), /can't read safely/);
    wiseAccount({ balances: { [BUSINESS.id]: [{ ...USD, id: 1.5 }] } });
    await assert.rejects(listWiseBalances(TOKEN, BUSINESS.id), /balance id Genosyn can't read/);
  });

  test("malformed lists and statements are errors, not empty results", async () => {
    wiseAccount({ profiles: { items: [] } });
    await assert.rejects(listWiseProfiles(TOKEN), /unexpected profile list/);
    wiseAccount({ balances: { [BUSINESS.id]: { balances: [] } } });
    await assert.rejects(listWiseBalances(TOKEN, BUSINESS.id), /unexpected balance list/);
    wiseAccount({ balances: { [BUSINESS.id]: [{ ...USD, currency: "usd dollars" }] } });
    await assert.rejects(listWiseBalances(TOKEN, BUSINESS.id), /balance without a currency/);
    wiseAccount({ statement: () => respond({ endOfStatementBalance: null }) });
    await assert.rejects(
      getWiseBalanceStatement(TOKEN, BUSINESS.id, USD.id, {
        currency: "USD",
        intervalStart: new Date("2026-10-01T00:00:00.000Z"),
        intervalEnd: new Date("2026-10-02T00:00:00.000Z"),
      }),
      /statement without transactions/,
    );
  });
});

describe("Wise failures", () => {
  const range = {
    currency: "USD",
    intervalStart: new Date("2026-10-01T00:00:00.000Z"),
    intervalEnd: new Date("2026-10-02T00:00:00.000Z"),
  };

  test("a revoked token is a dead Connection, with what to do about it", async () => {
    mockWise(() =>
      respond({ error: "invalid_token", error_description: "Invalid token" }, 401),
    );
    await assert.rejects(listWiseProfiles(TOKEN), (err: unknown) => {
      assert.ok(err instanceof ConnectionAuthError);
      assert.equal(err.connectionStatus, "expired");
      assert.match(err.message, /rejected the API token/);
      assert.match(err.message, /Connect and manage apps → API tokens/);
      return true;
    });
    // Wise naming the token invalid kills it on any path.
    await assert.rejects(listWiseBalances(TOKEN, BUSINESS.id), ConnectionAuthError);
  });

  test("a 401 for one profile is a mistyped id, not a dead token", async () => {
    mockWise(() => respond({ error: "unauthorized", error_description: "Forbidden profile" }, 401));
    await assert.rejects(listWiseBalances(TOKEN, 99), (err: unknown) => {
      assert.ok(!(err instanceof ConnectionAuthError));
      assert.ok(err instanceof WiseApiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /won't let this token read that profile/);
      return true;
    });
    // Refused for the profile list itself, though, the token is what failed.
    await assert.rejects(listWiseProfiles(TOKEN), ConnectionAuthError);
  });

  test("a statement held for Strong Customer Authentication says where Wise releases statements", async () => {
    mockWise(() =>
      respond({ error: "Forbidden" }, 403, {
        "x-2fa-approval": "5a7e1d8e-0000-4000-8000-000000000000",
        "x-2fa-approval-result": "REJECTED",
      }),
    );
    await assert.rejects(getWiseBalanceStatement(TOKEN, 1, 2, range), (err: unknown) => {
      assert.ok(err instanceof WiseScaRequiredError);
      assert.ok(err instanceof WiseApiError);
      assert.equal(err.status, 403);
      assert.equal(err.message, WISE_SCA_MESSAGE);
      assert.match(err.message, /Strong Customer Authentication/);
      assert.match(err.message, /US, Canada, Australia, New Zealand, Singapore and Malaysia/);
      return true;
    });
    // Either header alone, in any case, is the challenge.
    mockWise(() => respond({}, 403, { "X-2FA-Approval-Result": "rejected" }));
    await assert.rejects(getWiseBalanceStatement(TOKEN, 1, 2, range), WiseScaRequiredError);
    mockWise(() => respond({}, 403, { "X-2FA-APPROVAL": "ott" }));
    await assert.rejects(getWiseBalanceStatement(TOKEN, 1, 2, range), WiseScaRequiredError);
  });

  test("a plain 403 is a permission problem, in Wise's words", async () => {
    mockWise(() => respond({ errors: [{ code: "forbidden", message: "Token lacks access" }] }, 403));
    await assert.rejects(listWiseBalances(TOKEN, 1), (err: unknown) => {
      assert.ok(err instanceof WiseApiError && !(err instanceof WiseScaRequiredError));
      assert.match(err.message, /refused the request: Token lacks access/);
      return true;
    });
  });

  test("a missing profile or balance may have been closed", async () => {
    mockWise(() => respond({ error: "Not Found" }, 404));
    await assert.rejects(getWiseBalanceStatement(TOKEN, 1, 2, range), /may have been closed/);
  });

  test("rate limiting says when to try again", async () => {
    mockWise(() => respond({}, 429, { "retry-after": "7" }));
    await assert.rejects(listWiseProfiles(TOKEN), /Try again in 7 seconds/);
    mockWise(() => respond({}, 429));
    await assert.rejects(listWiseProfiles(TOKEN), /Try again in a minute/);
  });

  test("Wise's several error shapes each become one readable sentence", async () => {
    const cases: Array<[unknown, number, RegExp]> = [
      [{ errors: [{ code: "x" }, { message: "Currency is not supported" }] }, 422, /Wise 422: Currency is not supported/],
      [{ message: "Balance is not active" }, 400, /Wise 400: Balance is not active/],
      [{ error: "bad_request", error_description: "Bad interval" }, 400, /Wise 400: Bad interval/],
      ["upstream exploded", 500, /Wise 500: upstream exploded/],
      ["<html><body>Bad gateway</body></html>", 502, /^Wise 502/],
      ["", 503, /^Wise 503/],
    ];
    for (const [body, status, pattern] of cases) {
      mockWise(() => respond(body, status));
      await assert.rejects(listWiseProfiles(TOKEN), (err: unknown) => {
        assert.ok(err instanceof WiseApiError);
        assert.equal(err.status, status);
        assert.match(err.message, pattern);
        assert.doesNotMatch(err.message, /<html>/);
        return true;
      });
    }
  });

  test("a request Wise never answers says so", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    await assert.rejects(listWiseProfiles(TOKEN), /didn't answer within 30 seconds/);
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(listWiseProfiles(TOKEN), /fetch failed/);
  });
});

describe("Wise connection checks", () => {
  test("a token is checked against the business profile's balances", async () => {
    const calls = wiseAccount();
    const { config, accountHint } = await wiseProvider.validateApiKey!({ apiToken: `  ${TOKEN}\n` });
    assert.deepEqual(config, { apiToken: TOKEN });
    assert.equal(accountHint, "Acme Inc · wis…1234");
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      [`${V}/profiles`, `${V}/profiles/30000001/balances`],
    );
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  test("without a business profile the first active profile names the Connection", async () => {
    const calls = wiseAccount({
      profiles: [{ ...BUSINESS, currentState: "DEACTIVATED" }, PERSONAL],
    });
    const { accountHint } = await wiseProvider.validateApiKey!({ apiToken: TOKEN });
    assert.equal(accountHint, "Ada Lovelace · wis…1234");
    assert.equal(calls[1].url.pathname, `${V}/profiles/30000002/balances`);
  });

  test("a blank token, or one that reads no active profile, is refused", async () => {
    const calls = wiseAccount({ profiles: [] });
    await assert.rejects(wiseProvider.validateApiKey!({ apiToken: "   " }), /API token is required/);
    await assert.rejects(wiseProvider.validateApiKey!({}), /API token is required/);
    assert.equal(calls.length, 0);
    await assert.rejects(
      wiseProvider.validateApiKey!({ apiToken: TOKEN }),
      /no active profiles for this token/,
    );
    wiseAccount({ profiles: [{ ...PERSONAL, currentState: "DEACTIVATED" }] });
    await assert.rejects(wiseProvider.validateApiKey!({ apiToken: TOKEN }), /no active profiles/);
  });

  test("a revoked token fails validation with the reconnect sentence", async () => {
    mockWise(() => respond({ error: "invalid_token" }, 401));
    await assert.rejects(wiseProvider.validateApiKey!({ apiToken: TOKEN }), /rejected the API token/);
  });

  test("the status check is healthy, expired, or an error — never a throw", async () => {
    wiseAccount();
    assert.deepEqual(await wiseProvider.checkStatus!(ctx), { ok: true });

    mockWise(() => respond({ error: "invalid_token" }, 401));
    const expired = await wiseProvider.checkStatus!(ctx);
    assert.equal(expired.ok, false);
    assert.equal(expired.status, "expired");
    assert.match(expired.message ?? "", /rejected the API token/);

    mockWise(() => respond({ message: "maintenance" }, 503));
    const down = await wiseProvider.checkStatus!(ctx);
    assert.equal(down.ok, false);
    assert.equal(down.status, undefined);
    assert.match(down.message ?? "", /Wise 503: maintenance/);

    wiseAccount({ profiles: [] });
    const empty = await wiseProvider.checkStatus!(ctx);
    assert.equal(empty.ok, false);
    assert.match(empty.message ?? "", /no active profiles/);
  });
});

describe("Wise tools", () => {
  test("list_profiles names each profile without personal details", async () => {
    wiseAccount();
    const result = (await tool("list_profiles")) as { items: unknown[] };
    assert.deepEqual(result.items, [
      { profileId: "30000001", type: "BUSINESS", name: "Acme Inc", country: "US", state: "VISIBLE" },
      { profileId: "30000002", type: "PERSONAL", name: "Ada Lovelace", country: "US", state: "VISIBLE" },
    ]);
    const shown = JSON.stringify(result);
    for (const secret of ["ada@example.com", "1815-12-10", "+15550199", "finance@acme.example"]) {
      assert.ok(!shown.includes(secret), `list_profiles leaked ${secret}`);
    }
  });

  test("list_balances reads every active profile, or just the one asked for", async () => {
    const calls = wiseAccount({
      profiles: [BUSINESS, PERSONAL, { ...PERSONAL, id: 30000003, currentState: "DEACTIVATED" }],
    });
    const all = (await tool("list_balances")) as { items: Array<Record<string, unknown>> };
    assert.deepEqual(
      all.items.map((item) => [item.profileName, item.balanceId, item.currency, item.available]),
      [
        ["Acme Inc", "200001", "USD", 12345.67],
        ["Acme Inc", "200002", "EUR", 310.86],
        ["Ada Lovelace", "200003", "GBP", 5],
      ],
    );
    assert.deepEqual(all.items[0], {
      profileId: "30000001",
      profileName: "Acme Inc",
      balanceId: "200001",
      currency: "USD",
      name: null,
      available: 12345.67,
      reserved: 10,
      totalWorth: 12355.67,
      investmentState: "NOT_INVESTED",
    });
    // The deactivated profile's balances are never asked for.
    assert.ok(!calls.some((call) => call.url.pathname.includes("30000003")));

    const before = calls.length;
    const one = (await tool("list_balances", { profileId: 30000002 })) as {
      items: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      one.items.map((item) => item.currency),
      ["GBP"],
    );
    assert.deepEqual(
      calls.slice(before).map((call) => call.url.pathname),
      [`${V}/profiles`, `${V}/profiles/30000002/balances`],
    );
  });

  test("list_balances refuses a profile the token can't read without asking for its balances", async () => {
    const calls = wiseAccount();
    await assert.rejects(tool("list_balances", { profileId: "41" }), /isn't one this token can read/);
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      [`${V}/profiles`],
    );
    // A malformed id is refused before Wise is asked anything.
    await assert.rejects(tool("list_balances", { profileId: "abc" }), /profileId must be a Wise id/);
    assert.equal(calls.length, 1);
  });

  test("get_balance_statement reads the balance's own currency and lists newest first", async () => {
    const calls = wiseAccount();
    const result = (await tool("get_balance_statement", {
      profileId: "30000001",
      balanceId: 200001,
      intervalStart: "2026-10-01T00:00:00Z",
      intervalEnd: "2026-10-20T00:00:00Z",
    })) as Record<string, unknown> & { transactions: Array<Record<string, unknown>> };
    const statementUrl = calls.at(-1)!.url;
    assert.equal(statementUrl.searchParams.get("currency"), "USD");
    assert.equal(statementUrl.searchParams.get("type"), "COMPACT");
    assert.equal(result.currency, "USD");
    assert.equal(result.intervalStart, "2026-10-01T00:00:00.000Z");
    assert.equal(result.intervalEnd, "2026-10-20T00:00:00.000Z");
    assert.equal(result.transactionCount, 2);
    assert.equal(result.returned, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.endOfStatementBalance, 13837.91);
    assert.deepEqual(result.transactions[0], {
      referenceNumber: "CARD-249281",
      type: "DEBIT",
      date: "2026-10-03T18:02:11.832Z",
      amount: -7.76,
      currency: "USD",
      fees: 0.04,
      description: "Card transaction of 6.80 GBP issued by Tfl.gov.uk/cp TFL TRAVEL CH",
      kind: "CARD",
      counterparty: "Tfl.gov.uk/cp",
      paymentReference: null,
      runningBalance: 13837.91,
    });
    assert.deepEqual(result.transactions[1], {
      referenceNumber: "TRANSFER-34188888",
      type: "CREDIT",
      date: "2026-10-01T09:15:00.000Z",
      amount: 1500,
      currency: "USD",
      fees: 0,
      description: "Received money from GLOBEX LLC with reference INV-0042",
      kind: "DEPOSIT",
      counterparty: "GLOBEX LLC",
      paymentReference: "INV-0042",
      runningBalance: 13845.67,
    });
    // The payer's bank account number stays with Wise.
    assert.ok(!JSON.stringify(result).includes("US12 3456 7890 1234"));
    assert.ok(!JSON.stringify(result).includes("senderAccount"));
  });

  test("get_balance_statement bounds its output and says when it cut the list short", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      ...CARD,
      referenceNumber: `CARD-${i}`,
      date: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }));
    wiseAccount({ statement: () => respond({ transactions: many }) });
    const args = {
      profileId: "30000001",
      balanceId: "200001",
      intervalStart: "2026-09-01T00:00:00Z",
      intervalEnd: "2026-10-01T00:00:00Z",
    };
    type Page = { returned: number; transactionCount: number; truncated: boolean; transactions: Array<{ referenceNumber: string }> };
    const fallback = (await tool("get_balance_statement", args)) as Page;
    assert.equal(fallback.returned, 100);
    assert.equal(fallback.transactionCount, 600);
    assert.equal(fallback.truncated, true);
    assert.equal(fallback.transactions[0].referenceNumber, "CARD-599");
    const most = (await tool("get_balance_statement", { ...args, limit: 10_000 })) as Page;
    assert.equal(most.returned, 500);
    const least = (await tool("get_balance_statement", { ...args, limit: 0 })) as Page;
    assert.equal(least.returned, 1);
    assert.equal(least.transactions[0].referenceNumber, "CARD-599");
  });

  test("get_balance_statement ends at now when no end is given", async () => {
    const calls = wiseAccount();
    const before = Date.now();
    await tool("get_balance_statement", {
      profileId: "30000001",
      balanceId: "200001",
      intervalStart: new Date(before - 7 * 86_400_000).toISOString(),
    });
    const end = Date.parse(calls.at(-1)!.url.searchParams.get("intervalEnd") ?? "");
    assert.ok(end >= before && end <= Date.now(), "intervalEnd defaults to the moment of the call");
  });

  test("get_balance_statement refuses bad arguments before asking Wise anything", async () => {
    const calls = wiseAccount();
    const base = { profileId: "30000001", balanceId: "200001" };
    await assert.rejects(tool("get_balance_statement", base), /intervalStart must be an RFC 3339/);
    await assert.rejects(
      tool("get_balance_statement", { ...base, intervalStart: "last tuesday" }),
      /intervalStart must be an RFC 3339/,
    );
    await assert.rejects(
      tool("get_balance_statement", {
        ...base,
        intervalStart: "2026-10-01T00:00:00Z",
        intervalEnd: "yesterday",
      }),
      /intervalEnd must be an RFC 3339/,
    );
    await assert.rejects(
      tool("get_balance_statement", {
        ...base,
        intervalStart: "2024-01-01T00:00:00Z",
        intervalEnd: "2026-01-01T00:00:00Z",
      }),
      /at most 469 days/,
    );
    await assert.rejects(
      tool("get_balance_statement", {
        ...base,
        intervalStart: "2026-10-02T00:00:00Z",
        intervalEnd: "2026-10-01T00:00:00Z",
      }),
      /after intervalStart/,
    );
    await assert.rejects(
      tool("get_balance_statement", { ...base, balanceId: "", intervalStart: "2026-10-01T00:00:00Z" }),
      /balanceId must be a Wise id/,
    );
    assert.equal(calls.length, 0);
  });

  test("get_balance_statement refuses a balance that isn't on the profile", async () => {
    const calls = wiseAccount();
    await assert.rejects(
      tool("get_balance_statement", {
        profileId: "30000001",
        balanceId: "200003",
        intervalStart: "2026-10-01T00:00:00Z",
        intervalEnd: "2026-10-02T00:00:00Z",
      }),
      /balance 200003 isn't on profile 30000001/,
    );
    assert.ok(!calls.some((call) => STATEMENT_PATH.test(call.url.pathname)));
  });

  test("a statement Wise holds for authentication reaches the AI Employee as the same sentence", async () => {
    wiseAccount({
      statement: () => respond({}, 403, { "x-2fa-approval": "ott", "x-2fa-approval-result": "REJECTED" }),
    });
    await assert.rejects(
      tool("get_balance_statement", {
        profileId: "30000001",
        balanceId: "200001",
        intervalStart: "2026-10-01T00:00:00Z",
        intervalEnd: "2026-10-02T00:00:00Z",
      }),
      (err: unknown) => err instanceof WiseScaRequiredError && err.message === WISE_SCA_MESSAGE,
    );
  });

  test("an unknown tool is refused", async () => {
    const calls = wiseAccount();
    await assert.rejects(tool("create_transfer"), /Unknown Wise tool: create_transfer/);
    assert.equal(calls.length, 0);
  });
});

describe("Wise statement lines", () => {
  test("amounts become exact cents, rounding half away from zero", () => {
    const cases: Array<[unknown, number | null]> = [
      [7.76, 776],
      [-7.76, -776],
      [1500, 150_000],
      [0.1 + 0.2, 30],
      [1234567.89, 123_456_789],
      [0.285, 29],
      [-0.285, -29],
      [0.004, 0],
      [0, 0],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      [1e300, null],
      ["7.76", null],
      [undefined, null],
      [null, null],
    ];
    for (const [value, cents] of cases) {
      assert.equal(wiseAmountCents(value), cents, `${String(value)} → ${String(cents)}`);
    }
  });

  test("a line's key tells a refund from the transfer it reverses", () => {
    const sent: WiseStatementTransaction = {
      ...DEPOSIT,
      type: "DEBIT",
      date: "2026-10-05T10:00:00.000Z",
      amount: { value: -250, currency: "USD" },
      referenceNumber: "TRANSFER-777",
    };
    const refunded: WiseStatementTransaction = {
      ...sent,
      type: "CREDIT",
      date: "2026-10-07T08:00:00.000Z",
      amount: { value: 250, currency: "USD" },
    };
    const sentKey = wiseTransactionKey(sent, new Date(sent.date), -25_000);
    const refundKey = wiseTransactionKey(refunded, new Date(refunded.date), 25_000);
    assert.equal(sentKey, "TRANSFER-777|DEBIT|2026-10-05T10:00:00.000Z");
    assert.equal(refundKey, "TRANSFER-777|CREDIT|2026-10-07T08:00:00.000Z");
    // Two partial refunds of one transfer are two lines.
    const later = wiseTransactionKey(refunded, new Date("2026-10-09T08:00:00.000Z"), 25_000);
    assert.notEqual(later, refundKey);
  });

  test("a line's key ignores how Wise spelled the time and survives a missing reference", () => {
    const at = (date: string) => wiseTransactionKey(CARD, new Date(date), -776);
    assert.equal(at("2026-10-03T18:02:11.832Z"), at("2026-10-03T20:02:11.832+02:00"));
    const fee: WiseStatementTransaction = {
      type: "DEBIT",
      date: "2026-10-04T00:00:00.000Z",
      amount: { value: -1.5, currency: "USD" },
      details: { type: "ACCRUAL_CHARGE" },
      referenceNumber: null,
    };
    assert.equal(
      wiseTransactionKey(fee, new Date(fee.date), -150),
      "ACCRUAL_CHARGE#-150|DEBIT|2026-10-04T00:00:00.000Z",
    );
    // No direction from Wise: the sign says it.
    const untyped = { ...fee, type: "" };
    assert.match(wiseTransactionKey(untyped, new Date(fee.date), -150), /\|DEBIT\|/);
    assert.match(wiseTransactionKey(untyped, new Date(fee.date), 150), /\|CREDIT\|/);
  });

  test("a line is described in Wise's words, else by who paid or where the card was used", () => {
    assert.equal(
      describeWiseTransaction(DEPOSIT),
      "Received money from GLOBEX LLC with reference INV-0042",
    );
    const bare = { type: "DEBIT", date: CARD.date, amount: CARD.amount };
    assert.equal(
      describeWiseTransaction({ ...bare, details: { merchant: { name: " Figma " } } }),
      "Figma",
    );
    assert.equal(
      describeWiseTransaction({
        ...bare,
        details: { description: "  ", senderName: "Initech", paymentReference: "INV-7" },
      }),
      "Received money from Initech with reference INV-7",
    );
    assert.equal(
      describeWiseTransaction({ ...bare, details: { senderName: "Initech" } }),
      "Received money from Initech",
    );
    assert.equal(
      describeWiseTransaction({ ...bare, referenceNumber: "BALANCE-42" }),
      "Wise BALANCE-42",
    );
    assert.equal(describeWiseTransaction({ ...bare, details: null }), "Wise transaction");
  });

  test("a profile is named by its business, then its holder", () => {
    assert.equal(wiseProfileName({ id: 1, type: "BUSINESS", businessName: " Acme Inc " }), "Acme Inc");
    assert.equal(wiseProfileName({ id: 1, type: "PERSONAL", fullName: "Ada Lovelace" }), "Ada Lovelace");
    assert.equal(
      wiseProfileName({ id: 1, type: "PERSONAL", firstName: "Ada", lastName: "Lovelace" }),
      "Ada Lovelace",
    );
    assert.equal(wiseProfileName({ id: 7, type: "PERSONAL" }), "Wise profile 7");
  });

  test("ids are read as digits from strings or safe integers", () => {
    assert.equal(readWiseId(30000001, "profileId"), "30000001");
    assert.equal(readWiseId(" 42 ", "profileId"), "42");
    for (const bad of ["", "12a", "../1", "-1", -1, 0, 1.5, 2 ** 53, null, undefined, {}]) {
      assert.throws(() => readWiseId(bad, "profileId"), /profileId must be a Wise id/, String(bad));
    }
  });
});
