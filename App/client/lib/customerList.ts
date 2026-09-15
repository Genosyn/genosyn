export const CUSTOMER_LIST_PAGE_SIZE = 25;
export const CUSTOMER_LIST_QUERY_MAX_LENGTH = 200;
const MAX_CUSTOMER_LIST_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / CUSTOMER_LIST_PAGE_SIZE) + 1;

export type CustomerListUrlState = {
  query: string;
  page: number;
  showArchived: boolean;
};

export type CustomerListPageRange = {
  page: number;
  pageCount: number;
  offset: number;
  start: number;
  end: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

function normalizedQuery(value: string): string {
  return value.trim().slice(0, CUSTOMER_LIST_QUERY_MAX_LENGTH);
}

function normalizedPage(value: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_CUSTOMER_LIST_PAGE ? value : 1;
}

function pageFromParam(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return normalizedPage(Number(value));
}

function normalizedPageSize(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : CUSTOMER_LIST_PAGE_SIZE;
}

function normalizedTotal(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Read the list state encoded in the Customers page URL, with safe defaults. */
export function parseCustomerListParams(params: URLSearchParams): CustomerListUrlState {
  return {
    query: normalizedQuery(params.get("q") ?? ""),
    page: pageFromParam(params.get("page")),
    showArchived: params.get("archived") === "true",
  };
}

/**
 * Change one part of the Customers URL without discarding unrelated params.
 * A changed search or archive scope always starts again on page one.
 */
export function patchCustomerListParams(
  current: URLSearchParams,
  patch: Partial<CustomerListUrlState>,
): URLSearchParams {
  const previous = parseCustomerListParams(current);
  const query = patch.query === undefined ? previous.query : normalizedQuery(patch.query);
  const showArchived = patch.showArchived ?? previous.showArchived;
  const scopeChanged = query !== previous.query || showArchived !== previous.showArchived;
  const page = scopeChanged ? 1 : normalizedPage(patch.page ?? previous.page);
  const next = new URLSearchParams(current);

  next.delete("q");
  next.delete("page");
  next.delete("archived");
  if (query) next.set("q", query);
  if (page > 1) next.set("page", String(page));
  if (showArchived) next.set("archived", "true");
  return next;
}

/** Query parameters for the server-backed page endpoint. */
export function customerListApiParams(
  state: CustomerListUrlState,
  pageSize = CUSTOMER_LIST_PAGE_SIZE,
): URLSearchParams {
  const size = normalizedPageSize(pageSize);
  const params = new URLSearchParams({
    limit: String(size),
    offset: String(customerPageOffset(state.page, size)),
  });
  const query = normalizedQuery(state.query);
  if (query) params.set("q", query);
  if (state.showArchived) params.set("archived", "true");
  return params;
}

/** A stable identity for the rows represented by one Customers URL state. */
export function customerListViewKey(state: CustomerListUrlState): string {
  return customerListApiParams(state).toString();
}

export function customerPageOffset(page: number, pageSize = CUSTOMER_LIST_PAGE_SIZE): number {
  const offset = (normalizedPage(page) - 1) * normalizedPageSize(pageSize);
  return Number.isSafeInteger(offset) ? offset : 0;
}

/** Keep a requested page inside the range the latest server total permits. */
export function clampCustomerPage(
  page: number,
  total: number,
  pageSize = CUSTOMER_LIST_PAGE_SIZE,
): number {
  const size = normalizedPageSize(pageSize);
  const pageCount = Math.max(1, Math.ceil(normalizedTotal(total) / size));
  return Math.min(normalizedPage(page), pageCount);
}

/** Everything the pagination footer needs, derived from one authoritative total. */
export function customerListPageRange(
  requestedPage: number,
  total: number,
  pageSize = CUSTOMER_LIST_PAGE_SIZE,
): CustomerListPageRange {
  const size = normalizedPageSize(pageSize);
  const safeTotal = normalizedTotal(total);
  const pageCount = Math.max(1, Math.ceil(safeTotal / size));
  const page = clampCustomerPage(requestedPage, safeTotal, size);
  const offset = customerPageOffset(page, size);
  return {
    page,
    pageCount,
    offset,
    start: safeTotal === 0 ? 0 : offset + 1,
    end: Math.min(offset + size, safeTotal),
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

export function customerListRangeLabel(
  requestedPage: number,
  total: number,
  pageSize = CUSTOMER_LIST_PAGE_SIZE,
): string {
  const safeTotal = normalizedTotal(total);
  const range = customerListPageRange(requestedPage, safeTotal, pageSize);
  if (safeTotal === 0) return "0 customers";
  return `${range.start}–${range.end} of ${safeTotal} customer${safeTotal === 1 ? "" : "s"}`;
}
