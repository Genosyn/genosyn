import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import {
  WISE_API_VERSION,
  WISE_SCA_MESSAGE,
  type WiseStatementTransaction,
} from "../integrations/providers/wise.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { openInvoicesForBankTransaction } from "./banking.js";
import { setProviderRetrySleepForTests } from "./feedSyncErrors.js";
import { createInvoiceDraft, issueInvoice } from "./finance.js";
import { setHomeCurrency } from "./fx.js";
import { encryptConnectionConfig } from "./integrations.js";
import { recordInvoicePayment } from "./invoicePayments.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { autoMatchFeed, categorizeBankTransaction, syncBankFeed } from "./reconcile.js";
import {
  assertWiseBalanceFeed,
  listWiseBalancesForConnection,
  parseWiseBalanceRef,
  syncWiseBalanceFeed,
  wiseBalanceRef,
} from "./wiseFeeds.js";

/**
 * A Wise balance on Banking: which balances can become an account, the checks
 * before one does, and the update that walks its statement — once in full,
 * then again over a trailing month — without ever adding a line twice.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CO = "co_wise_feeds";
const TOKEN = "wise-token-for-feeds";
const V = `/${WISE_API_VERSION}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-21T12:00:00.000Z");
const REF = "30000001:200001";

const BUSINESS = {
  id: 30000001,
  type: "BUSINESS",
  businessName: "Acme Inc",
  currentState: "VISIBLE",
  address: { countryIso2Code: "US" },
};
const PERSONAL = {
  id: 30000002,
  type: "PERSONAL",
  fullName: "Ada Lovelace",
  currentState: "VISIBLE",
  address: { countryIso2Code: "US" },
};
const USD = {
  id: 200001,
  currency: "USD",
  type: "STANDARD",
  name: null,
  amount: { value: 12345.67, currency: "USD" },
  creationTime: "2024-01-15T10:00:00.000Z",
};
const EUR = { ...USD, id: 200002, currency: "EUR", amount: { value: 310.86, currency: "EUR" } };
const GBP = { ...USD, id: 200003, currency: "GBP", amount: { value: 5, currency: "GBP" } };

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type World = {
  profiles: unknown[];
  balances: Record<string, unknown[]>;
  /** Every line on the USD balance; a statement returns those in its interval. */
  lines: WiseStatementTransaction[];
  /** Answer the nth statement request some other way — a failure, say. */
  statement?: (index: number) => Response | null;
};

type StatementCall = { path: string; currency: string; start: string; end: string };

function world(overrides: Partial<World> = {}): World {
  return {
    profiles: [BUSINESS, PERSONAL],
    balances: { [BUSINESS.id]: [USD, EUR], [PERSONAL.id]: [GBP] },
    lines: [],
    ...overrides,
  };
}

/** Stand in for api.wise.com, answering from `w` and recording each statement asked for. */
function installWise(w: World): { statements: StatementCall[]; requests: URL[] } {
  const statements: StatementCall[] = [];
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://api.wise.com");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    if (url.pathname === `${V}/profiles`) return respond(w.profiles);
    const balances = new RegExp(`^${V}/profiles/(\\d+)/balances$`).exec(url.pathname);
    if (balances) return respond(w.balances[balances[1]] ?? []);
    if (url.pathname.endsWith("/statement.json")) {
      const call = {
        path: url.pathname,
        currency: url.searchParams.get("currency") ?? "",
        start: url.searchParams.get("intervalStart") ?? "",
        end: url.searchParams.get("intervalEnd") ?? "",
      };
      statements.push(call);
      const override = w.statement?.(statements.length - 1);
      if (override) return override;
      const from = Date.parse(call.start);
      const to = Date.parse(call.end);
      return respond({
        // A line whose date can't be read is in every statement — it's how a
        // malformed line from Wise reaches the update.
        transactions: w.lines.filter((line) => {
          const at = Date.parse(line.date);
          return Number.isNaN(at) || (at >= from && at <= to);
        }),
      });
    }
    return respond({ message: `unexpected ${url.pathname}` }, 500);
  }) as typeof fetch;
  return { statements, requests };
}

function line(
  referenceNumber: string,
  date: string,
  value: number,
  extra: Partial<WiseStatementTransaction> = {},
): WiseStatementTransaction {
  return {
    type: value < 0 ? "DEBIT" : "CREDIT",
    date,
    amount: { value, currency: "USD" },
    totalFees: { value: 0, currency: "USD" },
    details: { type: value < 0 ? "TRANSFER" : "DEPOSIT", description: `Wise line ${referenceNumber}` },
    referenceNumber,
    ...extra,
  };
}

async function setup() {
  await seedChartOfAccounts(CO);
  const bank = (await accountByCode(CO, "1100"))!;
  const connection = await insert(IntegrationConnection, {
    companyId: CO,
    provider: "wise",
    label: "Wise",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ apiToken: TOKEN }, CO),
  });
  return { bank, connection };
}

async function wiseFeed(connectionId: string, accountId: string, values: Partial<BankFeed> = {}) {
  return insert(BankFeed, {
    companyId: CO,
    name: "Wise USD",
    kind: "wise_balance",
    connectionId,
    externalAccountId: REF,
    accountId,
    lastSyncAt: null,
    ...values,
  });
}

async function linesOn(feedId: string): Promise<BankTransaction[]> {
  return AppDataSource.getRepository(BankTransaction).find({
    where: { feedId },
    order: { date: "ASC" },
  });
}

async function reloadFeed(id: string): Promise<BankFeed> {
  return AppDataSource.getRepository(BankFeed).findOneByOrFail({ id });
}

describe("Wise balance references", () => {
  test("name a balance on a profile, digits only", () => {
    assert.equal(wiseBalanceRef(30000001, "200001"), REF);
    assert.deepEqual(parseWiseBalanceRef(REF), { profileId: "30000001", balanceId: "200001" });
    for (const bad of [null, undefined, "", "30000001", "a:b", "1:2:3", " 1:2", "1:2 ", "1:-2"]) {
      assert.equal(parseWiseBalanceRef(bad), null, String(bad));
    }
  });
});

describe("listWiseBalancesForConnection", () => {
  test("lists every balance, business profiles first, offering only the books' currency", async () => {
    const { connection } = await setup();
    installWise(world({ profiles: [PERSONAL, BUSINESS] }));
    assert.deepEqual(await listWiseBalancesForConnection(CO, connection.id), [
      {
        id: "30000001:200001",
        profileName: "Acme Inc",
        profileType: "BUSINESS",
        currency: "USD",
        availableCents: 1_234_567,
        unavailableReason: null,
      },
      {
        id: "30000001:200002",
        profileName: "Acme Inc",
        profileType: "BUSINESS",
        currency: "EUR",
        availableCents: 31_086,
        unavailableReason: "Your books are in USD",
      },
      {
        id: "30000002:200003",
        profileName: "Ada Lovelace",
        profileType: "PERSONAL",
        currency: "GBP",
        availableCents: 500,
        unavailableReason: "Your books are in USD",
      },
    ]);
  });

  test("follows the company's home currency", async () => {
    const { connection } = await setup();
    await setHomeCurrency(CO, "EUR");
    installWise(world());
    const offered = (await listWiseBalancesForConnection(CO, connection.id))
      .filter((choice) => !choice.unavailableReason)
      .map((choice) => choice.currency);
    assert.deepEqual(offered, ["EUR"]);
  });

  test("says when a balance is already on Banking — this company's Banking", async () => {
    const { bank, connection } = await setup();
    await wiseFeed(connection.id, bank.id, { name: "Operating (Wise)" });
    await insert(BankFeed, {
      companyId: "co_someone_else",
      name: "Theirs",
      kind: "wise_balance",
      connectionId: null,
      externalAccountId: "30000001:200002",
      accountId: bank.id,
    });
    installWise(world());
    const choices = await listWiseBalancesForConnection(CO, connection.id);
    assert.equal(choices[0].unavailableReason, "Already on Banking as “Operating (Wise)”");
    assert.equal(choices[1].unavailableReason, "Your books are in USD");
  });

  test("leaves out deactivated profiles", async () => {
    const { connection } = await setup();
    const { requests } = installWise(
      world({ profiles: [BUSINESS, { ...PERSONAL, currentState: "DEACTIVATED" }] }),
    );
    const choices = await listWiseBalancesForConnection(CO, connection.id);
    assert.deepEqual(
      choices.map((choice) => choice.id),
      ["30000001:200001", "30000001:200002"],
    );
    assert.ok(!requests.some((url) => url.pathname.includes(String(PERSONAL.id))));
  });

  test("reads only this company's Wise Connections", async () => {
    const { connection } = await setup();
    const other = await insert(IntegrationConnection, {
      companyId: "co_someone_else",
      provider: "wise",
      label: "Their Wise",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ apiToken: TOKEN }, "co_someone_else"),
    });
    const brex = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "brex",
      label: "Brex",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ userToken: "bxt" }, CO),
    });
    const empty = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "wise",
      label: "Empty",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({}, CO),
    });
    const { requests } = installWise(world());
    await assert.rejects(listWiseBalancesForConnection(CO, other.id), /Wise Connection not found/);
    await assert.rejects(listWiseBalancesForConnection(CO, brex.id), /Wise Connection not found/);
    await assert.rejects(listWiseBalancesForConnection(CO, empty.id), /missing its API token/);
    assert.equal(requests.length, 0);
    assert.equal((await listWiseBalancesForConnection(CO, connection.id)).length, 3);
  });
});

describe("assertWiseBalanceFeed", () => {
  test("accepts a home-currency balance once Wise releases a day of its statement", async () => {
    const { connection } = await setup();
    const { statements } = installWise(world());
    await assertWiseBalanceFeed(CO, connection.id, REF, NOW);
    assert.deepEqual(statements, [
      {
        path: `${V}/profiles/30000001/balance-statements/200001/statement.json`,
        currency: "USD",
        start: new Date(NOW.getTime() - DAY).toISOString(),
        end: NOW.toISOString(),
      },
    ]);
  });

  test("refuses a balance it can't keep books for, and says why", async () => {
    const { bank, connection } = await setup();
    const { requests } = installWise(world());
    await assert.rejects(assertWiseBalanceFeed(CO, connection.id, "200001", NOW), /Choose a Wise balance/);
    assert.equal(requests.length, 0);
    await assert.rejects(
      assertWiseBalanceFeed(CO, connection.id, "30000001:999", NOW),
      /That balance isn't on this Wise Connection/,
    );
    await assert.rejects(
      assertWiseBalanceFeed(CO, connection.id, "30000001:200002", NOW),
      /^Error: This balance is in EUR and your books are in USD\. Banking brings in USD balances only\.$/,
    );
    await wiseFeed(connection.id, bank.id);
    await assert.rejects(
      assertWiseBalanceFeed(CO, connection.id, REF, NOW),
      /This Wise balance is already on Banking as “Wise USD”/,
    );
  });

  test("refuses a balance whose statement Wise holds for Strong Customer Authentication", async () => {
    const { connection } = await setup();
    installWise(
      world({
        statement: () =>
          respond({}, 403, { "x-2fa-approval": "ott-1", "x-2fa-approval-result": "REJECTED" }),
      }),
    );
    await assert.rejects(assertWiseBalanceFeed(CO, connection.id, REF, NOW), (err: unknown) => {
      assert.equal((err as Error).message, WISE_SCA_MESSAGE);
      return true;
    });
  });
});

describe("syncWiseBalanceFeed", () => {
  // Opened 2024-01-15 10:00, so a year a request makes three windows to NOW,
  // the first ending 2025-01-14 10:00 — 2024 had a 29 February.
  const BOUNDARY = "2025-01-14T10:00:00.000Z";

  function history(): WiseStatementTransaction[] {
    return [
      line("TRANSFER-1", "2024-03-01T09:00:00.000Z", 1500, {
        details: {
          type: "DEPOSIT",
          description: "Received money from GLOBEX LLC with reference Q1 retainer",
          senderName: "GLOBEX LLC",
          senderAccount: "US12 3456 7890 1234",
          paymentReference: "Q1 retainer",
        },
      }),
      line("TRANSFER-9", BOUNDARY, 42.5),
      line("CARD-2", "2025-06-10T18:02:11.832Z", -7.76, {
        totalFees: { value: 0.04, currency: "USD" },
        details: { type: "CARD", merchant: { name: "Figma" } },
      }),
      line("TRANSFER-777", "2026-10-05T10:00:00.000Z", -250),
      // The refund of TRANSFER-777 carries its reference number.
      line("TRANSFER-777", "2026-10-07T08:00:00.000Z", 250, { type: "CREDIT" }),
      line("BALANCE-0", "2026-10-08T00:00:00.000Z", 0, {
        details: { type: "BALANCE_ADJUSTMENT", description: "Nothing moved" },
      }),
    ];
  }

  test("the first update walks the whole history a year at a time and brings each line in once", async () => {
    const { bank, connection } = await setup();
    const feed = await wiseFeed(connection.id, bank.id);
    const { statements } = installWise(world({ lines: history() }));

    assert.equal(await syncWiseBalanceFeed(feed, NOW), 5);

    // Contiguous windows, from the day the balance opened to now, none over a year.
    assert.equal(statements.length, 3);
    assert.equal(statements[0].start, USD.creationTime);
    assert.equal(statements[0].end, BOUNDARY);
    assert.equal(statements.at(-1)!.end, NOW.toISOString());
    for (let i = 0; i < statements.length; i += 1) {
      const { start, end, currency, path } = statements[i];
      assert.equal(currency, "USD");
      assert.equal(path, `${V}/profiles/30000001/balance-statements/200001/statement.json`);
      assert.ok(Date.parse(end) - Date.parse(start) <= 365 * DAY);
      if (i > 0) assert.equal(start, statements[i - 1].end);
    }

    const rows = await linesOn(feed.id);
    assert.deepEqual(
      rows.map((row) => [row.reference, row.amountCents, row.description]),
      [
        ["TRANSFER-1", 150_000, "Received money from GLOBEX LLC with reference Q1 retainer"],
        // On both sides of a window boundary, and in once.
        ["TRANSFER-9", 4_250, "Wise line TRANSFER-9"],
        ["CARD-2", -776, "Figma"],
        ["TRANSFER-777", -25_000, "Wise line TRANSFER-777"],
        ["TRANSFER-777", 25_000, "Wise line TRANSFER-777"],
      ],
    );
    const [deposit] = rows;
    assert.equal(deposit.companyId, CO);
    assert.equal(deposit.externalId, "TRANSFER-1|CREDIT|2024-03-01T09:00:00.000Z");
    assert.equal(deposit.date.toISOString(), "2024-03-01T09:00:00.000Z");
    assert.equal(deposit.reconciledAt, null);
    assert.deepEqual(JSON.parse(deposit.raw), history()[0]);
    assert.notEqual(rows[3].externalId, rows[4].externalId);
    assert.equal((await reloadFeed(feed.id)).lastSyncAt?.toISOString(), NOW.toISOString());
  });

  test("a later update looks again at the last 30 days and never adds a line twice", async () => {
    const { bank, connection } = await setup();
    const w = world({ lines: history() });
    const { statements } = installWise(w);
    const feed = await wiseFeed(connection.id, bank.id);
    await syncWiseBalanceFeed(feed, NOW);

    const tomorrow = new Date(NOW.getTime() + DAY);
    statements.length = 0;
    assert.equal(await syncWiseBalanceFeed(await reloadFeed(feed.id), tomorrow), 0);
    assert.deepEqual(
      statements.map(({ start, end }) => [start, end]),
      [[new Date(NOW.getTime() - 30 * DAY).toISOString(), tomorrow.toISOString()]],
    );

    // A line that reached the balance late, dated before the last update.
    w.lines.push(line("CARD-3", new Date(NOW.getTime() - 10 * DAY).toISOString(), -19.99));
    const later = new Date(NOW.getTime() + 2 * DAY);
    assert.equal(await syncWiseBalanceFeed(await reloadFeed(feed.id), later), 1);
    assert.equal(await syncWiseBalanceFeed(await reloadFeed(feed.id), later), 0);
    assert.equal((await linesOn(feed.id)).length, 6);
    assert.equal((await reloadFeed(feed.id)).lastSyncAt?.toISOString(), later.toISOString());
  });

  test("a failed update keeps what it brought in and starts over from the same place", async (t) => {
    const { bank, connection } = await setup();
    let failing = true;
    const lines = [
      line("TRANSFER-1", "2024-03-01T09:00:00.000Z", 100),
      line("TRANSFER-2", "2025-06-01T09:00:00.000Z", 200),
      line("TRANSFER-3", "2026-06-01T09:00:00.000Z", 300),
    ];
    // A 503 is asked again a couple of times before it ends the update, so
    // this one stays down for every request after the first window — and
    // the waits between those tries are skipped.
    const waits: number[] = [];
    setProviderRetrySleepForTests(async (ms) => {
      waits.push(ms);
    });
    t.after(() => setProviderRetrySleepForTests(null));
    const { statements } = installWise(
      world({
        lines,
        statement: (index) =>
          failing && index >= 1 ? respond({ message: "temporarily unavailable" }, 503) : null,
      }),
    );
    const feed = await wiseFeed(connection.id, bank.id);

    await assert.rejects(syncWiseBalanceFeed(feed, NOW), /Wise 503: temporarily unavailable/);
    // The second window was asked for three times, a second and then two apart.
    assert.equal(statements.length, 4);
    assert.deepEqual(waits, [1_000, 2_000]);
    assert.deepEqual(
      (await linesOn(feed.id)).map((row) => row.reference),
      ["TRANSFER-1"],
    );
    assert.equal((await reloadFeed(feed.id)).lastSyncAt, null);

    failing = false;
    statements.length = 0;
    assert.equal(await syncWiseBalanceFeed(await reloadFeed(feed.id), NOW), 2);
    assert.equal(statements[0].start, USD.creationTime, "the walk starts over from the opening day");
    assert.deepEqual(
      (await linesOn(feed.id)).map((row) => row.reference),
      ["TRANSFER-1", "TRANSFER-2", "TRANSFER-3"],
    );
  });

  test("a statement line it can't read stops the update rather than guessing", async () => {
    const recent = { ...USD, creationTime: new Date(NOW.getTime() - 10 * DAY).toISOString() };
    const good = line("TRANSFER-1", new Date(NOW.getTime() - 5 * DAY).toISOString(), 10);
    const at = new Date(NOW.getTime() - 4 * DAY).toISOString();
    const cases: Array<[WiseStatementTransaction, RegExp]> = [
      [
        line("CARD-EUR", at, -5, { amount: { value: -5, currency: "EUR" } }),
        /Wise transaction CARD-EUR is in EUR, not USD/,
      ],
      [line("CARD-WHEN", "the other day", -5), /Wise transaction CARD-WHEN has an invalid date/],
      [
        line("CARD-HOW-MUCH", at, -5, {
          amount: { value: "5.00" as unknown as number, currency: "USD" },
        }),
        /Wise transaction CARD-HOW-MUCH has no usable amount/,
      ],
      [
        line("", at, -5, { referenceNumber: null, amount: { value: -5, currency: "" } }),
        /Wise transaction without a reference number is in no currency, not USD/,
      ],
    ];
    for (const [bad, message] of cases) {
      await resetTestDb();
      const { bank, connection } = await setup();
      const feed = await wiseFeed(connection.id, bank.id);
      installWise(world({ balances: { [BUSINESS.id]: [recent] }, lines: [good, bad] }));
      await assert.rejects(syncWiseBalanceFeed(feed, NOW), message);
      // The whole statement waits: the good line beside the bad one isn't half-kept.
      assert.equal((await linesOn(feed.id)).length, 0);
      assert.equal((await reloadFeed(feed.id)).lastSyncAt, null);
    }
  });

  test("a closed balance, or one no longer in the books' currency, stops the update", async () => {
    const { bank, connection } = await setup();
    const feed = await wiseFeed(connection.id, bank.id);
    const closed = installWise(world({ balances: { [BUSINESS.id]: [EUR] } }));
    await assert.rejects(
      syncWiseBalanceFeed(feed, NOW),
      /This Wise balance is no longer on the Connection — it may have been closed\./,
    );

    const moved = installWise(world());
    await setHomeCurrency(CO, "EUR");
    await assert.rejects(
      syncWiseBalanceFeed(feed, NOW),
      /This balance is in USD and your books are in EUR\. Banking brings in EUR balances only\./,
    );
    assert.equal(closed.statements.length + moved.statements.length, 0);
    assert.equal((await reloadFeed(feed.id)).lastSyncAt, null);
  });

  test("without an opening date the walk starts from when Wise began", async () => {
    const { bank, connection } = await setup();
    const feed = await wiseFeed(connection.id, bank.id);
    const { statements } = installWise(
      world({ balances: { [BUSINESS.id]: [{ ...USD, creationTime: null }] } }),
    );
    await syncWiseBalanceFeed(feed, NOW);
    assert.equal(statements[0].start, "2011-01-01T00:00:00.000Z");
    assert.equal(
      statements.length,
      Math.ceil((NOW.getTime() - Date.parse("2011-01-01T00:00:00.000Z")) / (365 * DAY)),
    );
    assert.equal(statements.at(-1)!.end, NOW.toISOString());
  });

  test("a balance that opens in the future has nothing to walk yet", async () => {
    const { bank, connection } = await setup();
    const feed = await wiseFeed(connection.id, bank.id);
    const { statements } = installWise(
      world({
        balances: {
          [BUSINESS.id]: [{ ...USD, creationTime: new Date(NOW.getTime() + DAY).toISOString() }],
        },
      }),
    );
    assert.equal(await syncWiseBalanceFeed(feed, NOW), 0);
    assert.equal(statements.length, 0);
    assert.equal((await reloadFeed(feed.id)).lastSyncAt?.toISOString(), NOW.toISOString());
  });

  test("a feed that isn't a whole Wise balance is refused before Wise is asked", async () => {
    const { bank, connection } = await setup();
    const { requests } = installWise(world());
    const cases: Array<[Partial<BankFeed>, RegExp]> = [
      [{ kind: "brex_cash" }, /Feed is not a Wise balance feed/],
      [{ connectionId: null }, /Wise feed has no Connection — pick one first/],
      [{ externalAccountId: null }, /Wise feed has no balance — pick one first/],
      [{ externalAccountId: "200001" }, /Wise feed has no balance — pick one first/],
    ];
    for (const [values, message] of cases) {
      const feed = await wiseFeed(connection.id, bank.id, values);
      await assert.rejects(syncWiseBalanceFeed(feed, NOW), message);
    }
    assert.equal(requests.length, 0);
  });
});

describe("a Wise balance on Banking", () => {
  async function invoiceFor(cents: number, issued = new Date("2026-09-15T00:00:00.000Z")) {
    const customer = await insert(Customer, {
      companyId: CO,
      name: "Globex LLC",
      slug: "globex-llc",
      email: "ap@globex.example",
      currency: "USD",
    });
    const draft = await createInvoiceDraft({
      companyId: CO,
      customerId: customer.id,
      currency: "USD",
      issueDate: issued,
      dueDate: new Date(issued.getTime() + 30 * DAY),
      lines: [{ description: "Retainer", quantity: 1, unitPriceCents: cents }],
    });
    return issueInvoice(draft);
  }

  test("Update now brings a deposit in and matches it to the payment already recorded", async () => {
    // `Update now` reads up to the real clock, so this one is dated from it.
    const today = Date.now();
    const { bank, connection } = await setup();
    const invoice = await invoiceFor(120_000, new Date(today - 20 * DAY));
    const recorded = await recordInvoicePayment(
      invoice,
      {
        amountCents: 120_000,
        method: "bank_transfer",
        paidAt: new Date(today - 3 * DAY),
        reference: "GLOBEX-OCT",
      },
      null,
    );
    const feed = await wiseFeed(connection.id, bank.id, { lastSyncAt: new Date(today - DAY) });
    installWise(
      world({ lines: [line("TRANSFER-55", new Date(today - 2 * DAY).toISOString(), 1200)] }),
    );

    assert.equal(await syncBankFeed(feed), 1);
    assert.equal(await autoMatchFeed(feed), 1);

    const [deposit] = await linesOn(feed.id);
    const payment = await AppDataSource.getRepository(InvoicePayment).findOneByOrFail({
      id: recorded.payment!.id,
    });
    assert.equal(payment.bankTransactionId, deposit.id);
    assert.ok(deposit.reconciledAt, "the deposit is done");
  });

  test("a deposit naming the invoice in its reference puts that invoice first", async () => {
    const { bank, connection } = await setup();
    const invoice = await invoiceFor(80_000);
    const feed = await wiseFeed(connection.id, bank.id, {
      lastSyncAt: new Date("2026-10-15T00:00:00.000Z"),
    });
    installWise(
      world({
        lines: [
          line("TRANSFER-56", "2026-10-03T09:30:00.000Z", 800, {
            details: {
              type: "DEPOSIT",
              description: `Received money from GLOBEX LLC with reference ${invoice.number}`,
              senderName: "GLOBEX LLC",
              paymentReference: invoice.number,
            },
          }),
        ],
      }),
    );
    await syncWiseBalanceFeed(feed, NOW);
    const [deposit] = await linesOn(feed.id);
    const options = await openInvoicesForBankTransaction(deposit);
    assert.equal(options.remainingCents, 80_000);
    assert.equal(options.invoices[0].invoiceId, invoice.id);
    assert.equal(options.invoices[0].exactAmount, true);
    assert.equal(options.invoices[0].mentioned, true);
  });

  test("a card payment, fees included, gets a category like any bank line", async () => {
    const { bank, connection } = await setup();
    const feed = await wiseFeed(connection.id, bank.id, {
      lastSyncAt: new Date("2026-10-15T00:00:00.000Z"),
    });
    installWise(
      world({
        lines: [
          line("CARD-249281", "2026-10-03T18:02:11.832Z", -7.76, {
            totalFees: { value: 0.04, currency: "USD" },
            details: { type: "CARD", merchant: { name: "Tfl.gov.uk/cp" } },
          }),
        ],
      }),
    );
    await syncWiseBalanceFeed(feed, NOW);
    const [card] = await linesOn(feed.id);
    const general = (await accountByCode(CO, "6000"))!;
    const done = await categorizeBankTransaction(card, general.id, null);
    const lines = await AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: done.matchedLedgerEntryId! },
    });
    const byAccount = new Map(lines.map((l) => [l.accountId, l]));
    assert.equal(byAccount.get(general.id)?.debitCents, 776);
    assert.equal(byAccount.get(bank.id)?.creditCents, 776);
    assert.ok(done.reconciledAt);
  });
});
