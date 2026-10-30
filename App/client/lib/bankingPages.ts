import { type Account, type BankTransaction, type CardTransaction, formatMoney } from "./api";
import { type BankingRow, rowKey } from "./bankingBulk";

/**
 * Banking's transaction list as the page holds it: one page at a time from
 * `GET …/banking/transactions` — the same list, filters and cursors an AI
 * Employee's `list_banking_transactions` reads (`server/services/bankingQueue.ts`).
 *
 * The page used to load the newest 500 bank lines and 500 card purchases and
 * stop there, so anything older could not be reached at all. Now it reads a
 * page, and Load older follows the server's cursor to the next. The cursor is
 * a keyset position — "after this transaction" — so filing transactions from
 * the To review list between pages never makes Load older skip or repeat one,
 * which an offset would.
 *
 * After anything changes (a row filed, a bulk action, a sync, a live update),
 * the page re-reads the rows it holds from the top as one fresh chain of
 * pages, so what is on screen and the cursor to what follows always come from
 * the same reading. Every request carries the generation it was made in; an
 * answer from an older one — a refresh overtaken by another, a Load older that
 * raced a refresh, a view the person already left — is dropped, never shown.
 */

/** Rows a first page and each Load older brings. */
export const BANKING_PAGE_SIZE = 100;

/** The most one request asks for: the server cuts larger pages to this. */
export const BANKING_MAX_PAGE = 200;

/** Which of Banking's three tabs is open. */
export type BankingTab = "review" | "done" | "all";

/** What narrows the list beside the account and the tab, as the person typed it. */
export type BankingFilters = {
  /** Words that must all appear in the description or a bank line's reference. */
  q: string;
  /** On or after this calendar day, `YYYY-MM-DD`; empty for no bound. */
  from: string;
  /** On or before this calendar day; empty for no bound. */
  to: string;
  direction: "" | "in" | "out";
  /** In the home currency's major units, as typed ("1,250.00"); empty for no bound. */
  minAmount: string;
  maxAmount: string;
  /** A chart-of-accounts account; empty for any category. */
  categoryAccountId: string;
};

export const NO_FILTERS: BankingFilters = {
  q: "",
  from: "",
  to: "",
  direction: "",
  minAmount: "",
  maxAmount: "",
  categoryAccountId: "",
};

/** One row as `view=records` answers it: the compact row and its whole transaction. */
export type BankingPageRow = {
  kind: "bank" | "card";
  id: string;
  date: string;
  record?: BankTransaction | CardTransaction;
};

/** One page of the list, as the server answers it. */
export type BankingPageResponse = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  note?: string;
  transactions: BankingPageRow[];
};

/** Where to read a page from: the start (`cursor` null) or after a previous page. */
export type BankingPageRequest = { cursor: string | null; limit: number };

/** Reads one page of the current view. */
export type FetchBankingPage = (request: BankingPageRequest) => Promise<BankingPageResponse>;

/**
 * An amount typed in major units as cents: "1,250.50" or "$1250.5" is 125050.
 * The sign is dropped (the list filters by size, money in or out alike); null
 * when it is not an amount.
 */
export function parseAmountCents(text: string): number | null {
  const cleaned = text.replace(/[\s,$€£¥₹]/g, "").replace(/^[+-]/, "");
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Why a filter can't be applied as typed, by field; empty when every one can. */
export type BankingFilterProblems = Partial<
  Record<"minAmount" | "maxAmount" | "to", string>
>;

/** An amount field: undefined when empty, null when it isn't an amount. */
function typedAmount(text: string): number | null | undefined {
  return text.trim() ? parseAmountCents(text) : undefined;
}

export function filterProblems(filters: BankingFilters): BankingFilterProblems {
  const problems: BankingFilterProblems = {};
  const min = typedAmount(filters.minAmount);
  const max = typedAmount(filters.maxAmount);
  if (min === null) problems.minAmount = "Enter an amount, like 50 or 1,250.00";
  if (max === null) problems.maxAmount = "Enter an amount, like 50 or 1,250.00";
  if (typeof min === "number" && typeof max === "number" && min > max) {
    problems.maxAmount = "Make this at least the smallest amount";
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    problems.to = "Pick a day on or after the first one";
  }
  return problems;
}

/**
 * The amount bounds that apply, in cents: each one typed as an amount, and
 * neither when the smallest is more than the largest — a range nothing can
 * match, which the field says rather than the list going empty.
 */
function appliedAmounts(filters: BankingFilters): { min?: number; max?: number } {
  const min = typedAmount(filters.minAmount);
  const max = typedAmount(filters.maxAmount);
  if (typeof min === "number" && typeof max === "number" && min > max) return {};
  return {
    ...(typeof min === "number" ? { min } : {}),
    ...(typeof max === "number" ? { max } : {}),
  };
}

/** The date bounds that apply: both, unless the range ends before it starts. */
function appliedDates(filters: BankingFilters): { from?: string; to?: string } {
  if (filters.from && filters.to && filters.from > filters.to) return {};
  return {
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

/**
 * The query a page of the list is read with, cursor and limit aside: the tab
 * as `status`, the account as `feedId`, and every filter that can be applied
 * as typed. One that can't (an amount that isn't one, a range that ends before
 * it starts) is left out rather than sent to be refused, and the page says why
 * beside its field.
 */
export function bankingListQuery(args: {
  feedId: string;
  tab: BankingTab;
  filters: BankingFilters;
}): URLSearchParams {
  const { filters } = args;
  const query = new URLSearchParams();
  query.set("status", args.tab);
  if (args.feedId) query.set("feedId", args.feedId);
  const q = filters.q.trim();
  if (q) query.set("q", q.slice(0, 200));
  const dates = appliedDates(filters);
  if (dates.from) query.set("from", dates.from);
  if (dates.to) query.set("to", dates.to);
  if (filters.direction) query.set("direction", filters.direction);
  const amounts = appliedAmounts(filters);
  if (amounts.min !== undefined) query.set("minAmountCents", String(amounts.min));
  if (amounts.max !== undefined) query.set("maxAmountCents", String(amounts.max));
  if (filters.categoryAccountId) query.set("categoryAccountId", filters.categoryAccountId);
  query.set("view", "records");
  return query;
}

/** The URL of one page: the list's query, then where to start and how many. */
export function bankingPageUrl(
  companyId: string,
  query: URLSearchParams,
  request: BankingPageRequest,
): string {
  const params = new URLSearchParams(query);
  params.set("limit", String(request.limit));
  if (request.cursor) params.set("cursor", request.cursor);
  return `/api/companies/${companyId}/banking/transactions?${params.toString()}`;
}

/** Whether anything beyond the account and tab narrows the list. */
export function filtersActive(filters: BankingFilters): boolean {
  return (Object.keys(NO_FILTERS) as Array<keyof BankingFilters>).some(
    (key) => filters[key].trim() !== "",
  );
}

/** Whether anything is typed in Filters (applied or not), so there is something to clear. */
export function panelFiltersActive(filters: BankingFilters): boolean {
  return filtersActive({ ...filters, q: "" });
}

/**
 * How many of Filters' groups actually narrow the list — dates, money in or
 * out, amount, category — as sent: a range that ends before it starts, or an
 * amount that isn't one, narrows nothing and isn't counted.
 */
export function appliedFilterCount(filters: BankingFilters): number {
  const dates = appliedDates(filters);
  const amounts = appliedAmounts(filters);
  return [
    dates.from || dates.to,
    filters.direction,
    amounts.min !== undefined || amounts.max !== undefined,
    filters.categoryAccountId,
  ].filter(Boolean).length;
}

/** What narrows the list beyond the account and tab, as sent: Filters, the search box, or nothing. */
export function narrowedBy(filters: BankingFilters): "filters" | "search" | null {
  if (appliedFilterCount(filters) > 0) return "filters";
  return filters.q.trim() ? "search" : null;
}

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_NO_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function day(value: string, withYear = true): string {
  const at = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return value;
  return (withYear ? DAY : DAY_NO_YEAR).format(at);
}

/**
 * What the collapsed Filters control says is set — "Jan 1 – Mar 31, 2023 ·
 * Money out · $50 – $500 · 6000 Software" — so closing it never hides a
 * filter. Days read as the UTC calendar days Banking shows.
 */
export function describeFilters(
  filters: BankingFilters,
  context: { homeCurrency: string; ledger: readonly Account[] },
): string {
  const parts: string[] = [];
  const { from, to } = appliedDates(filters);
  if (from && to) {
    parts.push(
      from === to
        ? day(from)
        : from.slice(0, 4) === to.slice(0, 4)
          ? `${day(from, false)} – ${day(to)}`
          : `${day(from)} – ${day(to)}`,
    );
  } else if (from) {
    parts.push(`From ${day(from)}`);
  } else if (to) {
    parts.push(`Through ${day(to)}`);
  }
  if (filters.direction === "in") parts.push("Money in");
  if (filters.direction === "out") parts.push("Money out");
  const { min, max } = appliedAmounts(filters);
  const money = (cents: number) => formatMoney(cents, context.homeCurrency);
  if (min !== undefined && max !== undefined) {
    parts.push(min === max ? `Exactly ${money(min)}` : `${money(min)} – ${money(max)}`);
  } else if (min !== undefined) {
    parts.push(`${money(min)} or more`);
  } else if (max !== undefined) {
    parts.push(`Up to ${money(max)}`);
  }
  if (filters.categoryAccountId) {
    const account = context.ledger.find((item) => item.id === filters.categoryAccountId);
    parts.push(account ? `${account.code} ${account.name}` : "One category");
  }
  return parts.length > 0 ? parts.join(" · ") : "None";
}

/** A page's rows as the page's row components take them. */
export function rowsOf(response: BankingPageResponse): BankingRow[] {
  return response.transactions.map((row): BankingRow => {
    if (!row.record) {
      throw new Error("The transactions came back without their details. Reload the page.");
    }
    return row.kind === "bank"
      ? { kind: "bank", id: row.id, date: row.date, txn: row.record as BankTransaction }
      : { kind: "card", id: row.id, date: row.date, txn: row.record as CardTransaction };
  });
}

/** `incoming` after `existing`, leaving out any row already there. */
export function appendRows(existing: readonly BankingRow[], incoming: readonly BankingRow[]): BankingRow[] {
  const seen = new Set(existing.map(rowKey));
  const added = incoming.filter((row) => {
    const key = rowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length === 0 ? [...existing] : [...existing, ...added];
}

/** A run of pages read from the top in one chain. */
export type BankingWindow = { rows: BankingRow[]; total: number; nextCursor: string | null };

/**
 * Read the list from the top until at least `count` rows are held — one page's
 * worth at the least — or the list ends, following each page's cursor. The
 * rows and the cursor after them come from one reading, so nothing between
 * them can be skipped or repeated.
 */
export async function readWindow(
  fetchPage: FetchBankingPage,
  count: number,
  options: { pageSize?: number; maxPage?: number } = {},
): Promise<BankingWindow> {
  const pageSize = options.pageSize ?? BANKING_PAGE_SIZE;
  const maxPage = options.maxPage ?? BANKING_MAX_PAGE;
  const wanted = Math.max(count, pageSize);
  let rows: BankingRow[] = [];
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage({ cursor, limit: Math.min(maxPage, wanted - rows.length) });
    const fresh = rowsOf(page);
    rows = appendRows(rows, fresh);
    total = page.total;
    const next = page.hasMore ? page.nextCursor : null;
    // A page that brought nothing, or a cursor that did not move, ends the
    // read rather than asking for the same page forever.
    if (!next || fresh.length === 0 || next === cursor) return { rows, total, nextCursor: next };
    cursor = next;
    if (rows.length >= wanted) return { rows, total, nextCursor: cursor };
  }
}

/** What the page draws from. */
export type BankingListSnapshot = {
  /** Null while a view's first page loads. */
  rows: BankingRow[] | null;
  /** Every transaction the view matches. */
  total: number;
  /** More rows follow the ones held. */
  hasMore: boolean;
  /**
   * Why the list couldn't be read. With rows on screen it was a refresh that
   * failed, and the rows are the last good reading.
   */
  error: string | null;
  /** A Load older is under way (or waiting for a refresh to land). */
  loadingOlder: boolean;
  /** Why the last Load older failed. */
  olderError: string | null;
  /** The rows on screen are being read again. */
  refreshing: boolean;
};

const EMPTY: BankingListSnapshot = {
  rows: null,
  total: 0,
  hasMore: false,
  error: null,
  loadingOlder: false,
  olderError: null,
  refreshing: false,
};

function describeErrorDefault(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Couldn't load the transactions";
}

export type BankingList = ReturnType<typeof createBankingList>;

/**
 * The list's state and the reads that change it, apart from React so every
 * race is pinned by a test. The page subscribes with `useSyncExternalStore`.
 */
export function createBankingList(
  options: {
    pageSize?: number;
    maxPage?: number;
    describeError?: (error: unknown) => string;
  } = {},
) {
  const pageSize = options.pageSize ?? BANKING_PAGE_SIZE;
  const maxPage = options.maxPage ?? BANKING_MAX_PAGE;
  const describe = options.describeError ?? describeErrorDefault;
  const listeners = new Set<() => void>();
  let snapshot: BankingListSnapshot = EMPTY;
  let view: FetchBankingPage | null = null;
  /** Bumped by every read that replaces the rows; older answers are dropped. */
  let generation = 0;
  let nextCursor: string | null = null;
  /** The Load older in flight, if any; its answer is dropped once this moves on. */
  let older: object | null = null;
  /** A Load older asked for while a refresh was reading, to run once it lands. */
  let olderQueued = false;

  function set(next: BankingListSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /**
   * Open a view — another account, tab or filter — from its first page. Like
   * every read here, the promise settles when the read does (or is overtaken)
   * and never rejects: a failure lands in the snapshot.
   */
  function show(fetchPage: FetchBankingPage): Promise<void> {
    view = fetchPage;
    const mine = ++generation;
    older = null;
    olderQueued = false;
    nextCursor = null;
    set(EMPTY);
    return readWindow(fetchPage, pageSize, { pageSize, maxPage }).then(
      (window) => {
        if (mine !== generation) return;
        nextCursor = window.nextCursor;
        set({
          ...EMPTY,
          rows: window.rows,
          total: window.total,
          hasMore: window.nextCursor !== null,
        });
      },
      (error: unknown) => {
        if (mine !== generation) return;
        set({ ...EMPTY, rows: [], error: describe(error) });
      },
    );
  }

  /**
   * Read the rows on screen again from the top, as one fresh chain of pages:
   * after a row is filed, a bulk action, a sync, or a live update. A Load
   * older racing it runs again from the refreshed cursor once it lands.
   */
  function refresh(): Promise<void> {
    if (!view) return Promise.resolve();
    if (snapshot.rows === null || (snapshot.rows.length === 0 && snapshot.error)) {
      return show(view);
    }
    const fetchPage = view;
    const mine = ++generation;
    if (older) olderQueued = true;
    older = null;
    const count = snapshot.rows.length;
    set({ ...snapshot, refreshing: true, loadingOlder: olderQueued, olderError: null });
    return readWindow(fetchPage, count, { pageSize, maxPage }).then(
      (window) => {
        if (mine !== generation) return;
        nextCursor = window.nextCursor;
        set({
          ...EMPTY,
          rows: window.rows,
          total: window.total,
          hasMore: window.nextCursor !== null,
        });
        if (olderQueued) {
          olderQueued = false;
          void loadOlder();
        }
      },
      (error: unknown) => {
        if (mine !== generation) return;
        olderQueued = false;
        set({ ...snapshot, refreshing: false, loadingOlder: false, error: describe(error) });
      },
    );
  }

  /** Bring the next page after the rows on screen. */
  function loadOlder(): Promise<void> {
    if (!view || snapshot.rows === null || !nextCursor || older) return Promise.resolve();
    if (snapshot.refreshing) {
      olderQueued = true;
      set({ ...snapshot, loadingOlder: true, olderError: null });
      return Promise.resolve();
    }
    const token = {};
    older = token;
    const mine = generation;
    const cursor = nextCursor;
    set({ ...snapshot, loadingOlder: true, olderError: null });
    return view({ cursor, limit: pageSize }).then(
      (page) => {
        if (older !== token || mine !== generation) return;
        older = null;
        let fresh: BankingRow[];
        try {
          fresh = rowsOf(page);
        } catch (error) {
          set({ ...snapshot, loadingOlder: false, olderError: describe(error) });
          return;
        }
        nextCursor = page.hasMore ? page.nextCursor : null;
        set({
          ...snapshot,
          rows: appendRows(snapshot.rows ?? [], fresh),
          total: page.total,
          hasMore: nextCursor !== null,
          loadingOlder: false,
          olderError: null,
        });
      },
      (error: unknown) => {
        if (older !== token || mine !== generation) return;
        older = null;
        set({ ...snapshot, loadingOlder: false, olderError: describe(error) });
      },
    );
  }

  return {
    show,
    refresh,
    loadOlder,
    /** Try again after a failure: the first page if nothing loaded, else the rows on screen. */
    retry: refresh,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
