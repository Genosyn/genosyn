import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Account, BankTransaction, CardTransaction } from "./api.js";
import { rowKey } from "./bankingBulk.js";
import {
  appendRows,
  appliedFilterCount,
  BANKING_MAX_PAGE,
  BANKING_PAGE_SIZE,
  bankingListQuery,
  bankingPageUrl,
  type BankingPageRequest,
  type BankingPageResponse,
  createBankingList,
  describeFilters,
  type FetchBankingPage,
  filterProblems,
  filtersActive,
  narrowedBy,
  NO_FILTERS,
  panelFiltersActive,
  parseAmountCents,
  readWindow,
  rowsOf,
} from "./bankingPages.js";

/**
 * Banking's list reaches every transaction a page at a time, through the same
 * keyset cursor an AI Employee pages with. These pin the parts a person can't
 * see break: that filing rows mid-list never makes Load older skip or repeat
 * one, that the rows on screen are re-read as one chain after a change, and
 * that an answer overtaken by a newer read is never shown.
 */

// ─────────────────────────── a keyset server ───────────────────────────

type Txn = { kind: "bank" | "card"; id: string; date: string; status: "review" | "done" };
type Key = [date: string, rank: number, id: string];

const keyOf = (txn: Txn): Key => [txn.date, txn.kind === "bank" ? 0 : 1, txn.id];

/** The server's order: newest first, a bank line before a card purchase at one instant, then id. */
function compareKeys(a: Key, b: Key): number {
  if (a[0] !== b[0]) return a[0] > b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] > b[2] ? -1 : 1;
  return 0;
}

function record(txn: Txn): BankTransaction | CardTransaction {
  if (txn.kind === "bank") {
    return {
      id: txn.id,
      companyId: "company",
      feedId: "checking",
      externalId: null,
      date: txn.date,
      amountCents: -1_000,
      description: `Bank ${txn.id}`,
      reference: "",
      raw: "",
      matchedPaymentId: null,
      matchedLedgerEntryId: null,
      reconciledAt: txn.status === "done" ? txn.date : null,
      reconciledById: null,
      createdAt: txn.date,
      match: null,
    };
  }
  return {
    id: txn.id,
    companyId: "company",
    feedId: "brex",
    externalId: txn.id,
    cardId: null,
    postedAt: txn.date,
    amountCents: 2_000,
    currency: "USD",
    description: `Card ${txn.id}`,
    providerType: "PURCHASE",
    accountingKind: "expense",
    expenseAccountId: "g-and-a",
    ledgerEntryId: "entry",
    postingError: "",
    raw: "",
    reclassifiedAt: null,
    needsReview: txn.status === "review",
    createdAt: txn.date,
    updatedAt: txn.date,
  };
}

/**
 * The To review list as `GET /banking/transactions?status=review` pages it,
 * over rows a test can file between pages. A cursor is the last row's key.
 */
function keysetServer(rows: Txn[]) {
  const state = { rows, requests: [] as BankingPageRequest[] };
  const list = () =>
    state.rows
      .filter((txn) => txn.status === "review")
      .sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const fetchPage: FetchBankingPage = async (request) => {
    state.requests.push(request);
    const all = list();
    let start = 0;
    if (request.cursor) {
      const after = JSON.parse(request.cursor) as Key;
      start = all.findIndex((txn) => compareKeys(keyOf(txn), after) > 0);
      if (start === -1) start = all.length;
    }
    const page = all.slice(start, start + request.limit);
    const hasMore = start + request.limit < all.length;
    const last = page[page.length - 1];
    return {
      total: all.length,
      hasMore,
      nextCursor: hasMore && last ? JSON.stringify(keyOf(last)) : null,
      transactions: page.map((txn) => ({
        kind: txn.kind,
        id: txn.id,
        date: txn.date,
        record: record(txn),
      })),
    };
  };
  return {
    state,
    fetchPage,
    /** Explain a transaction: it leaves To review. */
    file(id: string) {
      const found = state.rows.find((txn) => txn.id === id);
      assert.ok(found, id);
      found.status = "done";
    },
    reviewIds: () => list().map((txn) => txn.id),
  };
}

/** `count` transactions, three to an instant across both tables, so ties are everywhere. */
function transactions(count: number): Txn[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: index % 2 ? "card" : "bank",
    id: `t${String(index).padStart(4, "0")}`,
    date: new Date(Date.UTC(2023, 0, 1) + Math.floor(index / 3) * 86_400_000).toISOString(),
    status: "review",
  }));
}

/** Every pending promise callback, run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fetch whose answers wait until the test releases them, read from `inner` at release. */
function heldFetch(inner: FetchBankingPage) {
  const calls: Array<{
    request: BankingPageRequest;
    release: () => Promise<void>;
    fail: (error: unknown) => void;
  }> = [];
  const fetchPage: FetchBankingPage = (request) =>
    new Promise<BankingPageResponse>((resolve, reject) => {
      calls.push({
        request,
        release: async () => {
          resolve(await inner(request));
          await settle();
        },
        fail: (error) => reject(error),
      });
    });
  return { fetchPage, calls };
}

const ids = (rows: ReadonlyArray<{ id: string }> | null) => (rows ?? []).map((row) => row.id);

// ─────────────────────────── the query ───────────────────────────

describe("the query a page is read with", () => {
  test("carries the tab, the account and every filter, and always asks for records", () => {
    const query = bankingListQuery({
      feedId: "feed-1",
      tab: "all",
      filters: {
        q: "  google ads ",
        from: "2023-01-01",
        to: "2023-07-31",
        direction: "out",
        minAmount: "1,250.50",
        maxAmount: "$5000",
        categoryAccountId: "acct-6000",
      },
    });
    assert.deepEqual(Object.fromEntries(query), {
      status: "all",
      feedId: "feed-1",
      q: "google ads",
      from: "2023-01-01",
      to: "2023-07-31",
      direction: "out",
      minAmountCents: "125050",
      maxAmountCents: "500000",
      categoryAccountId: "acct-6000",
      view: "records",
    });
  });

  test("sends nothing for an empty filter, and To review as status=review", () => {
    assert.deepEqual(
      Object.fromEntries(bankingListQuery({ feedId: "", tab: "review", filters: NO_FILTERS })),
      { status: "review", view: "records" },
    );
  });

  test("leaves out what can't be applied as typed, rather than sending it to be refused", () => {
    const query = (filters: Partial<typeof NO_FILTERS>) =>
      Object.fromEntries(
        bankingListQuery({ feedId: "", tab: "review", filters: { ...NO_FILTERS, ...filters } }),
      );
    assert.equal(query({ minAmount: "lots" }).minAmountCents, undefined);
    assert.equal(query({ minAmount: "lots", maxAmount: "20" }).maxAmountCents, "2000", "a valid bound stays");
    const backwards = query({ minAmount: "500", maxAmount: "50" });
    assert.equal(backwards.minAmountCents, undefined, "a range nothing can match");
    assert.equal(backwards.maxAmountCents, undefined);
    const dates = query({ from: "2023-08-01", to: "2023-07-31" });
    assert.equal(dates.from, undefined);
    assert.equal(dates.to, undefined);
    assert.equal(query({ q: "x".repeat(250) }).q.length, 200, "cut to what the server takes");
  });

  test("a page's URL adds where it starts and how many it holds", () => {
    const query = bankingListQuery({ feedId: "", tab: "done", filters: NO_FILTERS });
    assert.equal(
      bankingPageUrl("company", query, { cursor: null, limit: 100 }),
      "/api/companies/company/banking/transactions?status=done&view=records&limit=100",
    );
    const next = new URL(
      bankingPageUrl("company", query, { cursor: "abc_-123", limit: 200 }),
      "http://x",
    );
    assert.equal(next.searchParams.get("cursor"), "abc_-123");
    assert.equal(next.searchParams.get("limit"), "200");
    assert.equal(query.get("cursor"), null, "the list's own query is left as it was");
  });
});

describe("amounts and filter problems", () => {
  test("reads an amount the way people type one", () => {
    assert.equal(parseAmountCents("1,250.50"), 125_050);
    assert.equal(parseAmountCents("$1250.5"), 125_050);
    assert.equal(parseAmountCents(" 50 "), 5_000);
    assert.equal(parseAmountCents(".5"), 50);
    assert.equal(parseAmountCents("12."), 1_200);
    assert.equal(parseAmountCents("-20"), 2_000, "a size, money in or out alike");
    assert.equal(parseAmountCents("0"), 0);
    for (const bad of ["", "abc", "1.234", "1e5", "12-3", "."]) {
      assert.equal(parseAmountCents(bad), null, JSON.stringify(bad));
    }
  });

  test("says why a filter can't apply, beside the field it belongs to", () => {
    assert.deepEqual(filterProblems(NO_FILTERS), {});
    assert.match(filterProblems({ ...NO_FILTERS, minAmount: "ten" }).minAmount ?? "", /amount/);
    assert.match(
      filterProblems({ ...NO_FILTERS, minAmount: "500", maxAmount: "50" }).maxAmount ?? "",
      /at least/,
    );
    assert.match(
      filterProblems({ ...NO_FILTERS, from: "2023-02-01", to: "2023-01-31" }).to ?? "",
      /on or after/,
    );
    assert.deepEqual(filterProblems({ ...NO_FILTERS, from: "2023-01-31", to: "2023-01-31" }), {});
  });

  test("knows when anything narrows the list, and when the panel does", () => {
    assert.equal(filtersActive(NO_FILTERS), false);
    assert.equal(filtersActive({ ...NO_FILTERS, q: "rent" }), true);
    assert.equal(panelFiltersActive({ ...NO_FILTERS, q: "rent" }), false);
    assert.equal(panelFiltersActive({ ...NO_FILTERS, direction: "in" }), true);
    assert.equal(filtersActive({ ...NO_FILTERS, q: "   " }), false);
  });

  test("counts what applies, not what was typed", () => {
    assert.equal(appliedFilterCount(NO_FILTERS), 0);
    assert.equal(
      appliedFilterCount({
        ...NO_FILTERS,
        from: "2023-01-01",
        to: "2023-01-31",
        direction: "out",
        minAmount: "10",
        maxAmount: "20",
        categoryAccountId: "acct",
      }),
      4,
      "dates, direction, amount and category: one each",
    );
    assert.equal(appliedFilterCount({ ...NO_FILTERS, minAmount: "lots" }), 0);
    assert.equal(appliedFilterCount({ ...NO_FILTERS, minAmount: "50", maxAmount: "5" }), 0);
    assert.equal(appliedFilterCount({ ...NO_FILTERS, from: "2023-02-01", to: "2023-01-01" }), 0);
    assert.equal(narrowedBy(NO_FILTERS), null);
    assert.equal(narrowedBy({ ...NO_FILTERS, q: "rent" }), "search");
    assert.equal(narrowedBy({ ...NO_FILTERS, q: "rent", direction: "in" }), "filters");
    assert.equal(narrowedBy({ ...NO_FILTERS, minAmount: "lots" }), null, "nothing applied");
  });
});

describe("what the collapsed Filters control says", () => {
  const ledger = [
    { id: "acct-6000", code: "6000", name: "Software" } as Account,
    { id: "acct-4000", code: "4000", name: "Sales" } as Account,
  ];
  const say = (filters: Partial<typeof NO_FILTERS>) =>
    describeFilters({ ...NO_FILTERS, ...filters }, { homeCurrency: "USD", ledger });

  test("says None rather than nothing", () => {
    assert.equal(say({}), "None");
    assert.equal(say({ q: "rent" }), "None", "the search box speaks for itself");
  });

  test("names the dates as UTC calendar days", () => {
    assert.equal(say({ from: "2023-01-01", to: "2023-03-31" }), "Jan 1 – Mar 31, 2023");
    assert.equal(say({ from: "2022-12-01", to: "2023-01-31" }), "Dec 1, 2022 – Jan 31, 2023");
    assert.equal(say({ from: "2023-07-31", to: "2023-07-31" }), "Jul 31, 2023");
    assert.equal(say({ from: "2023-08-01" }), "From Aug 1, 2023");
    assert.equal(say({ to: "2023-07-31" }), "Through Jul 31, 2023");
    assert.equal(say({ from: "2023-08-01", to: "2023-07-31" }), "None", "a range nothing matches");
  });

  test("names the direction, the amounts and the category", () => {
    assert.equal(
      say({ from: "2023-01-01", to: "2023-03-31", direction: "out", categoryAccountId: "acct-6000" }),
      "Jan 1 – Mar 31, 2023 · Money out · 6000 Software",
    );
    assert.equal(say({ direction: "in" }), "Money in");
    assert.equal(say({ minAmount: "50", maxAmount: "500" }), "$50.00 – $500.00");
    assert.equal(say({ minAmount: "50", maxAmount: "50" }), "Exactly $50.00");
    assert.equal(say({ minAmount: "1250" }), "$1,250.00 or more");
    assert.equal(say({ maxAmount: "99.5" }), "Up to $99.50");
    assert.equal(say({ minAmount: "lots" }), "None");
    assert.equal(say({ categoryAccountId: "gone" }), "One category");
    assert.equal(
      describeFilters({ ...NO_FILTERS, minAmount: "10" }, { homeCurrency: "EUR", ledger }),
      "€10.00 or more",
    );
  });
});

// ─────────────────────────── pages ───────────────────────────

describe("rows and windows", () => {
  test("a page's rows carry their records, and a bank line and a card purchase never collide", async () => {
    const server = keysetServer(transactions(4));
    const rows = rowsOf(await server.fetchPage({ cursor: null, limit: 4 }));
    assert.deepEqual(
      rows.map((row) => [row.kind, row.id, row.txn.id]),
      rows.map((row) => [row.kind, row.id, row.id]),
    );
    assert.throws(
      () =>
        rowsOf({
          total: 1,
          hasMore: false,
          nextCursor: null,
          transactions: [{ kind: "bank", id: "x", date: "2023-01-01T00:00:00.000Z" }],
        }),
      /without their details/,
    );
    const bank = rows.find((row) => row.kind === "bank")!;
    const sameIdCard = { ...rows.find((row) => row.kind === "card")!, id: bank.id };
    assert.equal(appendRows([bank], [sameIdCard]).length, 2, "keys are kind and id");
    assert.equal(appendRows([bank], [bank]).length, 1);
    assert.deepEqual(ids(appendRows(rows, [...rows].reverse())), ids(rows));
  });

  test("a window reads as many rows as were on screen, 200 at most a request", async () => {
    const server = keysetServer(transactions(600));
    const window = await readWindow(server.fetchPage, 250);
    assert.deepEqual(
      server.state.requests.map((request) => request.limit),
      [BANKING_MAX_PAGE, 50],
    );
    assert.equal(server.state.requests[0].cursor, null, "from the top");
    assert.equal(window.rows.length, 250);
    assert.equal(window.total, 600);
    assert.deepEqual(ids(window.rows), server.reviewIds().slice(0, 250));
    assert.ok(window.nextCursor, "and the cursor to what follows");
    const next = await server.fetchPage({ cursor: window.nextCursor, limit: 1 });
    assert.equal(next.transactions[0].id, server.reviewIds()[250]);
  });

  test("a window is a page at the least, and stops where the list ends", async () => {
    const short = keysetServer(transactions(30));
    const window = await readWindow(short.fetchPage, 0);
    assert.deepEqual(short.state.requests, [{ cursor: null, limit: BANKING_PAGE_SIZE }]);
    assert.equal(window.rows.length, 30);
    assert.equal(window.nextCursor, null);

    const ended = keysetServer(transactions(450));
    const all = await readWindow(ended.fetchPage, 1_000);
    assert.equal(all.rows.length, 450);
    assert.equal(all.nextCursor, null);
    assert.deepEqual(
      ended.state.requests.map((request) => request.limit),
      [200, 200, 200],
    );
  });

  test("a server that stops moving its cursor can't keep a window reading forever", async () => {
    const stuck: FetchBankingPage = async () => ({
      total: 10,
      hasMore: true,
      nextCursor: "same",
      transactions: [],
    });
    const window = await readWindow(stuck, 500);
    assert.deepEqual(window.rows, []);
  });
});

// ─────────────────────────── the list ───────────────────────────

describe("the list on the page", () => {
  test("opens on its first page, then Load older brings the next until the end", async () => {
    const server = keysetServer(transactions(250));
    const list = createBankingList();
    let notified = 0;
    const unsubscribe = list.subscribe(() => notified++);
    list.show(server.fetchPage);
    assert.equal(list.getSnapshot().rows, null, "loading");
    await settle();
    const first = list.getSnapshot();
    assert.equal(first.rows?.length, 100);
    assert.equal(first.total, 250);
    assert.equal(first.hasMore, true);
    assert.ok(notified > 0);

    list.loadOlder();
    list.loadOlder(); // a second press while the first is reading is the same request
    assert.equal(list.getSnapshot().loadingOlder, true);
    await settle();
    assert.equal(server.state.requests.length, 2);
    list.loadOlder();
    await settle();
    const end = list.getSnapshot();
    assert.equal(end.rows?.length, 250);
    assert.equal(end.hasMore, false);
    assert.equal(end.loadingOlder, false);
    assert.deepEqual(ids(end.rows), server.reviewIds());
    list.loadOlder();
    await settle();
    assert.equal(server.state.requests.length, 3, "nothing follows the last page");
    unsubscribe();
  });

  test("filing rows mid-list never makes Load older skip or repeat one", async () => {
    const server = keysetServer(transactions(400));
    const original = server.reviewIds();
    const list = createBankingList();
    list.show(server.fetchPage);
    await settle();
    // Explain ten rows in the middle of what is on screen, as a person does
    // from To review — they leave the list on the server.
    for (const id of original.slice(40, 50)) server.file(id);
    list.loadOlder();
    await settle();
    const rows = ids(list.getSnapshot().rows);
    assert.deepEqual(rows.slice(0, 100), original.slice(0, 100), "what was on screen stays");
    assert.deepEqual(
      rows.slice(100),
      original.slice(100, 200),
      "the next page starts right after the last row shown — an offset of 100 would have skipped ten",
    );
    assert.equal(new Set(rows).size, rows.length);
    assert.equal(list.getSnapshot().total, 390);
  });

  test("a refresh re-reads the rows on screen as one chain, and Load older carries on from it", async () => {
    const server = keysetServer(transactions(500));
    const list = createBankingList();
    list.show(server.fetchPage);
    await settle();
    list.loadOlder();
    await settle();
    list.loadOlder();
    await settle();
    assert.equal(list.getSnapshot().rows?.length, 300);
    const before = server.state.requests.length;

    // A bulk action files 25 rows across the window, then the page refreshes.
    const shown = ids(list.getSnapshot().rows);
    const filed = shown.filter((_, index) => index % 12 === 0);
    for (const id of filed) server.file(id);
    list.refresh();
    assert.equal(list.getSnapshot().refreshing, true);
    assert.equal(list.getSnapshot().rows?.length, 300, "the rows stay on screen while it reads");
    await settle();
    assert.deepEqual(
      server.state.requests.slice(before).map((request) => [request.cursor === null, request.limit]),
      [
        [true, 200],
        [false, 100],
      ],
      "from the top, as many rows as were on screen",
    );
    const after = list.getSnapshot();
    assert.equal(after.refreshing, false);
    assert.deepEqual(ids(after.rows), server.reviewIds().slice(0, 300));
    assert.equal(after.total, 500 - filed.length);

    // Read to the end: every transaction still waiting, each exactly once.
    while (list.getSnapshot().hasMore) {
      list.loadOlder();
      await settle();
    }
    assert.deepEqual(ids(list.getSnapshot().rows), server.reviewIds());
  });

  test("an answer overtaken by a newer read is dropped", async () => {
    const server = keysetServer(transactions(300));
    const held = heldFetch(server.fetchPage);
    const list = createBankingList();
    list.show(held.fetchPage);
    await held.calls[0].release();
    assert.equal(list.getSnapshot().rows?.length, 100);

    // Two refreshes; the first answers last, with what was true before the second.
    list.refresh();
    const firstRefresh = held.calls[1];
    server.file(server.reviewIds()[0]);
    list.refresh();
    const secondRefresh = held.calls[2];
    await secondRefresh.release();
    const fresh = ids(list.getSnapshot().rows);
    server.state.rows.find((txn) => txn.id === fresh[0])!.status = "done";
    await firstRefresh.release();
    assert.deepEqual(ids(list.getSnapshot().rows), fresh, "the older refresh's answer is ignored");

    // A view the person already left never draws.
    const other = keysetServer(transactions(5));
    list.show(held.fetchPage);
    const leftView = held.calls[3];
    list.show(other.fetchPage);
    await settle();
    await leftView.release();
    assert.equal(list.getSnapshot().rows?.length, 5);
  });

  test("a Load older that raced a refresh runs again from the refreshed cursor", async () => {
    const server = keysetServer(transactions(400));
    const held = heldFetch(server.fetchPage);
    const list = createBankingList();
    list.show(held.fetchPage);
    await held.calls[0].release();

    list.loadOlder();
    const raced = held.calls[1];
    server.file(server.reviewIds()[3]);
    list.refresh();
    const refresh = held.calls[2];
    assert.equal(list.getSnapshot().loadingOlder, true, "the button keeps saying it is loading");
    await raced.release(); // answered from before the refresh: dropped
    assert.equal(list.getSnapshot().rows?.length, 100);
    await refresh.release();
    const queued = held.calls[3];
    assert.ok(queued, "the Load older asks again once the refresh lands");
    const refreshed = ids(list.getSnapshot().rows);
    assert.equal(
      queued.request.cursor,
      JSON.stringify(keyOf(server.state.rows.find((txn) => txn.id === refreshed.at(-1))!)),
      "from the refreshed cursor",
    );
    await queued.release();
    const rows = ids(list.getSnapshot().rows);
    assert.deepEqual(rows, server.reviewIds().slice(0, 200));
    assert.equal(list.getSnapshot().loadingOlder, false);

    // Asked for while a refresh is reading, it waits for it.
    list.refresh();
    const second = held.calls[4];
    list.loadOlder();
    assert.equal(held.calls.length, 5, "no request until the refresh lands");
    assert.equal(list.getSnapshot().loadingOlder, true);
    await second.release();
    await held.calls[5].release();
    assert.deepEqual(ids(list.getSnapshot().rows), server.reviewIds().slice(0, 300));
  });

  test("failures stay where the person is looking, and trying again recovers", async () => {
    const server = keysetServer(transactions(250));
    const held = heldFetch(server.fetchPage);
    const list = createBankingList({ describeError: (error) => `Failed: ${String(error)}` });

    list.show(held.fetchPage);
    held.calls[0].fail("offline");
    await settle();
    assert.deepEqual(list.getSnapshot().rows, []);
    assert.equal(list.getSnapshot().error, "Failed: offline");
    list.retry();
    assert.equal(list.getSnapshot().rows, null, "a first page that never came loads again");
    await held.calls[1].release();
    assert.equal(list.getSnapshot().error, null);
    assert.equal(list.getSnapshot().rows?.length, 100);

    list.loadOlder();
    held.calls[2].fail("timeout");
    await settle();
    assert.equal(list.getSnapshot().olderError, "Failed: timeout");
    assert.equal(list.getSnapshot().rows?.length, 100, "what was shown stays");
    list.loadOlder();
    assert.equal(list.getSnapshot().olderError, null);
    await held.calls[3].release();
    assert.equal(list.getSnapshot().rows?.length, 200);

    list.refresh();
    held.calls[4].fail("502");
    await settle();
    const failed = list.getSnapshot();
    assert.equal(failed.error, "Failed: 502");
    assert.equal(failed.rows?.length, 200, "the last good reading stays on screen");
    assert.equal(failed.refreshing, false);
    list.retry();
    await held.calls[5].release();
    assert.equal(list.getSnapshot().error, null);
    assert.deepEqual(ids(list.getSnapshot().rows), server.reviewIds().slice(0, 200));
  });

  test("every read settles — landed, failed or overtaken — and never rejects", async () => {
    const list = createBankingList();
    await list.refresh(); // nothing open yet: nothing to read
    await list.loadOlder();
    assert.equal(list.getSnapshot().rows, null);

    const server = keysetServer(transactions(150));
    const held = heldFetch(server.fetchPage);
    const first = list.show(held.fetchPage);
    await held.calls[0].release();
    await first;
    const overtaken = list.refresh();
    const latest = list.refresh();
    await held.calls[2].release();
    await latest;
    held.calls[1].fail(new Error("late"));
    await overtaken;
    assert.equal(list.getSnapshot().error, null, "an overtaken failure is not shown either");

    const failing = list.refresh();
    held.calls[3].fail("down");
    await failing;
    assert.equal(list.getSnapshot().error, "Couldn't load the transactions");
    assert.equal(list.getSnapshot().rows?.length, 100);
  });

  test("a page without records is an error, not a crash", async () => {
    const list = createBankingList();
    list.show(async () => ({
      total: 1,
      hasMore: false,
      nextCursor: null,
      transactions: [{ kind: "card", id: "c1", date: "2023-01-01T00:00:00.000Z" }],
    }));
    await settle();
    assert.match(list.getSnapshot().error ?? "", /without their details/);
    assert.deepEqual(list.getSnapshot().rows, []);
  });

  test("rows keep their kind:id keys for the selection", async () => {
    const server = keysetServer(transactions(6));
    const list = createBankingList();
    list.show(server.fetchPage);
    await settle();
    const keys = (list.getSnapshot().rows ?? []).map(rowKey);
    assert.deepEqual(keys.slice(0, 2), ["bank:t0004", "card:t0005"]);
  });
});
