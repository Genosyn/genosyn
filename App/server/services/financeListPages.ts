import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Bill, type BillStatus } from "../db/entities/Bill.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice, type InvoiceStatus } from "../db/entities/Invoice.js";
import { RecurringInvoice, type RecurringInvoiceStatus } from "../db/entities/RecurringInvoice.js";
import { escapeLike, tokenizeQuery } from "./likeSearch.js";
import {
  andWhereDateRange,
  asText,
  type DateRange,
  dateRange,
  decodeCursor,
  filterFingerprint,
  finishPage,
  type KeysetColumn,
  keysetRows,
  type PageInfo,
  type PageLimits,
  pageLimit,
  type PageRequest,
} from "./listPaging.js";

/**
 * Finance's document lists — invoices, bills, recurring invoice schedules and
 * customers — one page at a time (`services/listPaging.ts`).
 *
 * Each AI tool used to stop at 100 or 200 rows with no way past them and no
 * word that it had: the 101st unpaid invoice, the bill due next month, the
 * customer created a year ago could not be reached. They now page by cursor,
 * and the dates a bookkeeper filters these by are filters on the server.
 * `GET /invoices` and `GET /bills` read the same functions when asked for a
 * page, so an API client and an AI Employee reach exactly the same rows.
 */

type Page<T> = PageInfo & { rows: T[] };

/** Fetch a keyset page, present it in one batch, and close it. */
async function pageOf<T extends ObjectLiteral & { id: string }, Out>(args: {
  query: () => SelectQueryBuilder<T>;
  keys: KeysetColumn[];
  scope: string;
  fingerprint: string;
  noun: string;
  limits: PageLimits;
  page: PageRequest & { budgetChars?: number };
  present: (rows: T[]) => Promise<Out[]>;
}): Promise<Page<Out>> {
  const after = args.page.cursor
    ? decodeCursor(args.scope, args.fingerprint, args.page.cursor)
    : null;
  const limit = pageLimit(args.page.limit, args.limits);
  const [total, fetched] = await Promise.all([
    args.query().getCount(),
    keysetRows(args.query(), { keys: args.keys, after, limit, prefix: "page" }),
  ]);
  const kept = fetched.slice(0, limit).map((entry) => entry.row);
  const presented = await args.present(kept);
  const byId = new Map(kept.map((row, index) => [row.id, presented[index]]));
  return finishPage({
    fetched,
    limit,
    total,
    noun: args.noun,
    scope: args.scope,
    fingerprint: args.fingerprint,
    present: (row: T) => byId.get(row.id)!,
    budgetChars: args.page.budgetChars,
  });
}

function rangeKey(range: DateRange) {
  return { gte: range.gte, lt: range.lt, lte: range.lte };
}

// ─────────────────────────────── Invoices ───────────────────────────────

/** 50 by default, at most 100 at once. */
export const INVOICE_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 100 };

export type InvoiceListFilter = {
  status?: InvoiceStatus;
  customerId?: string;
  recurringInvoiceId?: string;
  includeArchived?: boolean;
  /** Issued on or after this day (`YYYY-MM-DD`, UTC) or instant. */
  from?: string;
  /** Issued on or before this day (the whole day) or instant. */
  to?: string;
  /** Due on or after. */
  dueFrom?: string;
  /** Due on or before. */
  dueTo?: string;
};

type InvoiceRanges = { issued: DateRange; due: DateRange };

function invoiceRanges(filter: InvoiceListFilter): InvoiceRanges {
  return {
    issued: dateRange(filter.from, filter.to),
    due: dateRange(filter.dueFrom, filter.dueTo, ["dueFrom", "dueTo"]),
  };
}

/** Invoices matching the filter, unordered: the shared WHERE of the page and the plain list. */
export function invoiceListQuery(companyId: string, filter: InvoiceListFilter) {
  const ranges = invoiceRanges(filter);
  const qb = AppDataSource.getRepository(Invoice)
    .createQueryBuilder("invoice")
    .where("invoice.companyId = :companyId", { companyId });
  if (filter.status) qb.andWhere("invoice.status = :status", { status: filter.status });
  if (filter.customerId)
    qb.andWhere("invoice.customerId = :customerId", { customerId: filter.customerId });
  if (filter.recurringInvoiceId) {
    qb.andWhere("invoice.recurringInvoiceId = :recurringInvoiceId", {
      recurringInvoiceId: filter.recurringInvoiceId,
    });
  }
  // Archived invoices are filed away, so lists leave them out unless asked.
  if (!filter.includeArchived) qb.andWhere("invoice.archivedAt IS NULL");
  andWhereDateRange(qb, "invoice.issueDate", ranges.issued, "issued");
  andWhereDateRange(qb, "invoice.dueDate", ranges.due, "due");
  return qb;
}

/** Invoices, newest first, one page at a time. */
export async function pageInvoices<Out>(
  companyId: string,
  filter: InvoiceListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (rows: Invoice[]) => Promise<Out[]>,
): Promise<Page<Out>> {
  const ranges = invoiceRanges(filter);
  return pageOf({
    query: () => invoiceListQuery(companyId, filter),
    // Finance → Invoices' order: SQLite stamps `createdAt` to the second, and
    // a new invoice's issue date is to the millisecond.
    keys: [
      { column: "invoice.createdAt", direction: "DESC", type: "timestamp" },
      { column: "invoice.issueDate", direction: "DESC", type: "timestamp" },
      { column: "invoice.id", direction: "DESC", type: "string" },
    ],
    scope: "finance.invoices",
    fingerprint: filterFingerprint(companyId, {
      status: filter.status,
      customerId: filter.customerId,
      recurringInvoiceId: filter.recurringInvoiceId,
      includeArchived: !!filter.includeArchived,
      issued: rangeKey(ranges.issued),
      due: rangeKey(ranges.due),
    }),
    noun: "invoices",
    limits: INVOICE_PAGE,
    page,
    present,
  });
}

/** The date filters `GET /invoices` and `list_invoices` share. */
export const invoiceDateFilterShape = {
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  dueFrom: z.string().min(1).max(40).optional(),
  dueTo: z.string().min(1).max(40).optional(),
};

// ──────────────────────────────── Bills ─────────────────────────────────

/** 50 by default, at most 200 at once. */
export const BILL_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

export type BillListFilter = {
  status?: BillStatus;
  vendorId?: string;
  /** Issued on or after / on or before. */
  from?: string;
  to?: string;
  /** Due on or after / on or before. */
  dueFrom?: string;
  dueTo?: string;
};

/** Bills matching the filter, unordered. */
export function billListQuery(companyId: string, filter: BillListFilter) {
  const issued = dateRange(filter.from, filter.to);
  const due = dateRange(filter.dueFrom, filter.dueTo, ["dueFrom", "dueTo"]);
  const qb = AppDataSource.getRepository(Bill)
    .createQueryBuilder("bill")
    .where("bill.companyId = :companyId", { companyId });
  if (filter.status) qb.andWhere("bill.status = :status", { status: filter.status });
  if (filter.vendorId) qb.andWhere("bill.vendorId = :vendorId", { vendorId: filter.vendorId });
  andWhereDateRange(qb, "bill.issueDate", issued, "issued");
  andWhereDateRange(qb, "bill.dueDate", due, "due");
  return qb;
}

/** Bills, the soonest due first — what to pay next at the top — one page at a time. */
export async function pageBills<Out>(
  companyId: string,
  filter: BillListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (rows: Bill[]) => Promise<Out[]>,
): Promise<Page<Out>> {
  return pageOf({
    query: () => billListQuery(companyId, filter),
    keys: [
      { column: "bill.dueDate", direction: "ASC", type: "timestamp" },
      { column: "bill.id", direction: "ASC", type: "string" },
    ],
    scope: "finance.bills",
    fingerprint: filterFingerprint(companyId, {
      status: filter.status,
      vendorId: filter.vendorId,
      issued: rangeKey(dateRange(filter.from, filter.to)),
      due: rangeKey(dateRange(filter.dueFrom, filter.dueTo, ["dueFrom", "dueTo"])),
    }),
    noun: "bills",
    limits: BILL_PAGE,
    page,
    present,
  });
}

// ────────────────────────── Recurring invoices ──────────────────────────

/** 50 by default, at most 100 at once. */
export const RECURRING_INVOICE_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 100 };

export type RecurringInvoiceListFilter = {
  status?: RecurringInvoiceStatus;
  customerId?: string;
  includeArchived?: boolean;
};

/** Recurring invoice schedules, newest first, one page at a time. */
export async function pageRecurringInvoices<Out>(
  companyId: string,
  filter: RecurringInvoiceListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (rows: RecurringInvoice[]) => Promise<Out[]>,
): Promise<Page<Out>> {
  const query = () => {
    const qb = AppDataSource.getRepository(RecurringInvoice)
      .createQueryBuilder("schedule")
      .where("schedule.companyId = :companyId", { companyId });
    if (filter.status) qb.andWhere("schedule.status = :status", { status: filter.status });
    if (filter.customerId) {
      qb.andWhere("schedule.customerId = :customerId", { customerId: filter.customerId });
    }
    // An archived schedule is a paused or ended one a Member filed away.
    if (!filter.includeArchived) qb.andWhere("schedule.archivedAt IS NULL");
    return qb;
  };
  return pageOf({
    query,
    keys: [
      { column: "schedule.createdAt", direction: "DESC", type: "timestamp" },
      { column: "schedule.id", direction: "DESC", type: "string" },
    ],
    scope: "finance.recurring_invoices",
    fingerprint: filterFingerprint(companyId, {
      status: filter.status,
      customerId: filter.customerId,
      includeArchived: !!filter.includeArchived,
    }),
    noun: "recurring invoices",
    limits: RECURRING_INVOICE_PAGE,
    page,
    present,
  });
}

// ─────────────────────────────── Customers ──────────────────────────────

/** 50 by default, at most 200 at once. */
export const CUSTOMER_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

export type CustomerListFilter = {
  /** Words matched, all of them, against the name, domain, email, phone, tax number and contacts. */
  q?: string;
  includeArchived?: boolean;
};

/** Customers, newest first, one page at a time — the search Finance → Customers runs. */
export async function pageCustomers<Out>(
  companyId: string,
  filter: CustomerListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (rows: Customer[]) => Promise<Out[]>,
): Promise<Page<Out>> {
  const tokens = tokenizeQuery(filter.q ?? "");
  const query = () => {
    const qb = AppDataSource.getRepository(Customer)
      .createQueryBuilder("customer")
      .where("customer.companyId = :companyId", { companyId });
    if (!filter.includeArchived) qb.andWhere("customer.archivedAt IS NULL");
    if (tokens.length === 0) return qb;
    // Tokens AND together, columns OR together, matched the way `andWhereTokens`
    // matches them — and a customer matches through any of its contacts, once.
    const q = (name: string) => AppDataSource.driver.escape(name);
    const contactColumn = (field: string) => `${q("contact")}.${q(field)}`;
    tokens.forEach((token, index) => {
      const lo = `customerQLo${index}`;
      const raw = `customerQRaw${index}`;
      const variants = (column: string) =>
        token.raw === token.lo
          ? [`LOWER(${column}) LIKE :${lo} ESCAPE '\\'`]
          : [`LOWER(${column}) LIKE :${lo} ESCAPE '\\'`, `${column} LIKE :${raw} ESCAPE '\\'`];
      const own = [
        "customer.name",
        "customer.domain",
        "customer.email",
        "customer.phone",
        "customer.taxNumber",
      ].flatMap(variants);
      const viaContact = `EXISTS (SELECT 1 FROM ${q("customer_contacts")} ${q("contact")} WHERE ${contactColumn("companyId")} = customer.companyId AND ${contactColumn("customerId")} = ${asText("customer.id")} AND (${["name", "email", "phone", "role"].map(contactColumn).flatMap(variants).join(" OR ")}))`;
      qb.andWhere(`(${[...own, viaContact].join(" OR ")})`, {
        [lo]: `%${escapeLike(token.lo)}%`,
        [raw]: `%${escapeLike(token.raw)}%`,
      });
    });
    return qb;
  };
  return pageOf({
    query,
    keys: [
      { column: "customer.createdAt", direction: "DESC", type: "timestamp" },
      { column: "customer.id", direction: "DESC", type: "string" },
    ],
    scope: "finance.customers",
    fingerprint: filterFingerprint(companyId, {
      q: tokens.length ? tokens.map((token) => token.raw) : undefined,
      includeArchived: !!filter.includeArchived,
    }),
    noun: "customers",
    limits: CUSTOMER_PAGE,
    page,
    present,
  });
}
