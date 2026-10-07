import { Brackets, In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Customer } from "../../db/entities/Customer.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { uniqueCustomerSlug } from "../finance.js";
import { toSlug } from "../../lib/slug.js";
import type { RevenueBulkJob } from "./bulkJobs.js";
import { matchingResourceIds } from "./customFields.js";
import { assertRevenueOwner } from "./integrity.js";
import {
  mergeRevenueRecords,
  previewRevenueMerge,
  type MergeConflictResolutions,
  type MergeCustomFieldConflict,
  type MergeFieldConflict,
  type RevenueMergePreview,
} from "./merge.js";
import { findMergedRecordRedirect, type RevenueOperationActor } from "./operations.js";

export type AccountWrite = {
  name?: string;
  email?: string;
  phone?: string;
  accountStatus?: "prospect" | "customer" | "former";
  domain?: string;
  websiteUrl?: string;
  industry?: string;
  employeeCount?: number;
  currency?: string;
  annualContractValueCents?: number;
  notes?: string;
  ownerId?: string | null;
  ownerEmployeeId?: string | null;
};

export type AccountMergeCounts = {
  contacts: number;
  deals: number;
  activities: number;
  partnerships: number;
  revenueDocuments: number;
  signalEvents: number;
  billingContacts: number;
  contracts: number;
  invoices: number;
  estimates: number;
  recurringInvoices: number;
  credits: number;
  customValuesCopied: number;
  customValueConflicts: number;
};

export type AccountMergePreview = {
  source: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  target: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  counts: AccountMergeCounts;
  fieldConflicts?: MergeFieldConflict[];
  customFieldConflicts?: MergeCustomFieldConflict[];
  operationId?: string;
};

/**
 * The account fields that exist to bill it. Finance sends invoices to `email`
 * (the default `to` for invoice Send) and prints the billing address and tax
 * number on invoices and estimates; the shipping address is the other address
 * on the same customer form. Like the Customers pages, they follow Finance
 * access: a viewer whose access is None gets every Revenue account payload
 * without them. Everything Revenue's own pages show or edit stays, and so do
 * phone, currency, and Annual Contract Value, which the entity documents as a
 * sales metric.
 */
export const ACCOUNT_BILLING_FIELDS = [
  "email",
  "billingAddress",
  "shippingAddress",
  "taxNumber",
] as const satisfies ReadonlyArray<keyof Customer>;

export type AccountBillingField = (typeof ACCOUNT_BILLING_FIELDS)[number];

const BILLING_FIELDS: ReadonlySet<string> = new Set(ACCOUNT_BILLING_FIELDS);

/**
 * An account without its billing details. `billingWithheld` says they were
 * left out, so a missing `email` is never read as "no billing email on file".
 */
export type AccountWithoutBilling<T> = Omit<T, AccountBillingField> & { billingWithheld: true };

/**
 * One account — a row of a list or an export, or a record — as its viewer may
 * see it: whole when they can read billing details, without them otherwise.
 */
export function accountForViewer<T extends object>(
  account: T,
  billingVisible: boolean,
): T | AccountWithoutBilling<T> {
  if (billingVisible) return account;
  const visible = Object.fromEntries(
    Object.entries(account).filter(([field]) => !BILLING_FIELDS.has(field)),
  );
  return { ...visible, billingWithheld: true } as AccountWithoutBilling<T>;
}

/**
 * An Account merge preview as its viewer may see it. A conflict on a billing
 * field carries both accounts' values, so a viewer without billing access gets
 * the preview without those conflicts and with `billingWithheld` set. Nothing
 * they send resolves them, so the merge keeps the destination's billing
 * details — what it does with any conflict left unresolved.
 *
 * Only for an Account merge: a Contact's `email` conflict is its own address.
 */
export function accountMergePreviewForViewer<P extends { fieldConflicts?: MergeFieldConflict[] }>(
  preview: P,
  billingVisible: boolean,
): P | (P & { billingWithheld: true }) {
  const conflicts = preview.fieldConflicts ?? [];
  const visible = conflicts.filter((conflict) => !BILLING_FIELDS.has(conflict.field));
  if (billingVisible || visible.length === conflicts.length) return preview;
  return { ...preview, fieldConflicts: visible, billingWithheld: true };
}

/**
 * Whether an account write sets a billing detail: a create or an update, or
 * one bulk standard-field patch. Like every change on the Customers pages,
 * that takes Full finance access; an AI Employee needs an `invoice` Finance
 * Grant, the bar `update_customer` holds.
 */
export function setsAccountBilling(values: object): boolean {
  return ACCOUNT_BILLING_FIELDS.some(
    (field) => (values as Record<string, unknown>)[field] !== undefined,
  );
}

/**
 * Whether a bulk request sets an account's billing details: a standard-field
 * update on Accounts whose shared or per-record values name one. A dry run
 * counts too, because its rows return each account's current values as
 * `before`.
 */
export function bulkSetsAccountBilling(request: {
  resourceType: string;
  action: { type: string; values?: object; rows?: ReadonlyArray<{ values: object }> };
}): boolean {
  const { action } = request;
  if (request.resourceType !== "account" || action.type !== "update_standard_fields") {
    return false;
  }
  return [action.values ?? {}, ...(action.rows ?? []).map((row) => row.values)].some((values) =>
    setsAccountBilling(values),
  );
}

/**
 * Whether an Account merge takes a billing detail from its source. A merge
 * keeps the destination's values unless a resolution picks the source's, so
 * only that sets billing details; keeping the destination's needs nothing.
 */
export function mergeTakesSourceBilling(resolutions: MergeConflictResolutions): boolean {
  return ACCOUNT_BILLING_FIELDS.some((field) => resolutions[field] === "source");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A piece of Account history without billing details: each billing field is
 * dropped wherever it is a key (a bulk request's values, a row's before and
 * after, a merge's resolutions), and each merge conflict over one is dropped
 * whole. `withheld` says whether anything was.
 */
function historyWithoutBilling(value: unknown): { value: unknown; withheld: boolean } {
  if (Array.isArray(value)) {
    let withheld = false;
    const items: unknown[] = [];
    for (const item of value) {
      if (isJsonObject(item) && typeof item.field === "string" && BILLING_FIELDS.has(item.field)) {
        withheld = true;
        continue;
      }
      const kept = historyWithoutBilling(item);
      withheld ||= kept.withheld;
      items.push(kept.value);
    }
    return { value: withheld ? items : value, withheld };
  }
  if (!isJsonObject(value)) return { value, withheld: false };
  let withheld = false;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (BILLING_FIELDS.has(key)) {
      withheld = true;
      continue;
    }
    const kept = historyWithoutBilling(item);
    withheld ||= kept.withheld;
    entries.push([key, kept.value]);
  }
  return { value: withheld ? Object.fromEntries(entries) : value, withheld };
}

/**
 * `record` with its history fields, JSON text or JSON already parsed, leaving
 * out billing details, and with `billingWithheld` set when any did. Text that
 * doesn't parse is withheld whole, since nothing says what it holds.
 */
function recordWithoutBilling<T extends object>(
  record: T,
  fields: ReadonlyArray<string>,
): T | (T & { billingWithheld: true }) {
  const kept: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value !== "string") {
      const history = historyWithoutBilling(value);
      if (history.withheld) kept[field] = history.value;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      kept[field] = "null";
      continue;
    }
    const history = historyWithoutBilling(parsed);
    if (history.withheld) kept[field] = JSON.stringify(history.value);
  }
  if (Object.keys(kept).length === 0) return record;
  return { ...record, ...kept, billingWithheld: true };
}

/**
 * A Revenue operation, one entry of the change history, as its viewer may see
 * it. An Account merge or bulk operation records billing details: a merge's
 * field conflicts, a bulk request's values, and the before and after of each
 * row it changed. A viewer who can't read them gets the operation without
 * them, with `billingWithheld` set when anything was left out. Other records'
 * history passes through: a Contact's `email` is its own.
 */
export function revenueOperationForViewer<
  T extends { resourceType: string; requestJson: string; summaryJson: string },
>(operation: T, billingVisible: boolean): T | (T & { billingWithheld: true }) {
  if (billingVisible || operation.resourceType !== "account") return operation;
  return recordWithoutBilling(operation, ["requestJson", "summaryJson"]);
}

/** One row of an operation as its viewer may see it; see `revenueOperationForViewer`. */
export function revenueOperationRowForViewer<
  T extends { resourceType: string; beforeJson: string; afterJson: string },
>(row: T, billingVisible: boolean): T | (T & { billingWithheld: true }) {
  if (billingVisible || row.resourceType !== "account") return row;
  return recordWithoutBilling(row, ["beforeJson", "afterJson"]);
}

/**
 * A bulk job, with its operation, summary, and rows, as its viewer may see it;
 * see `revenueOperationForViewer`.
 */
export function revenueBulkJobForViewer(
  job: RevenueBulkJob,
  billingVisible: boolean,
): RevenueBulkJob {
  if (billingVisible || job.operation.resourceType !== "account") return job;
  return {
    ...recordWithoutBilling(job, ["summary"]),
    operation: revenueOperationForViewer(job.operation, false),
    rows: job.rows.map((row) => recordWithoutBilling(row, ["before", "after"])),
  };
}

/**
 * One `operation_audit` export row, an operation joined to one of its rows,
 * as its viewer may see it; see `revenueOperationForViewer`.
 */
export function revenueOperationAuditRowForViewer(
  row: Record<string, unknown>,
  billingVisible: boolean,
): Record<string, unknown> {
  if (billingVisible || row.operationResourceType !== "account") return row;
  return recordWithoutBilling(row, ["requestJson", "summaryJson", "beforeJson", "afterJson"]);
}

export function normalizeAccountDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return trimmed
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }
}

function applyAccountWrite(row: Customer, input: AccountWrite): void {
  if (input.name !== undefined) row.name = input.name.trim();
  if (input.email !== undefined) row.email = input.email.trim().toLowerCase();
  if (input.phone !== undefined) row.phone = input.phone.trim();
  if (input.accountStatus !== undefined) row.accountStatus = input.accountStatus;
  if (input.domain !== undefined) row.domain = normalizeAccountDomain(input.domain);
  if (input.websiteUrl !== undefined) row.websiteUrl = input.websiteUrl.trim();
  if (input.industry !== undefined) row.industry = input.industry.trim();
  if (input.employeeCount !== undefined) row.employeeCount = input.employeeCount;
  if (input.currency !== undefined) row.currency = input.currency.toUpperCase();
  if (input.annualContractValueCents !== undefined) {
    row.annualContractValueCents = input.annualContractValueCents;
  }
  if (input.notes !== undefined) row.notes = input.notes;
  if (input.ownerId !== undefined) {
    row.ownerId = input.ownerId;
    if (input.ownerId) row.ownerEmployeeId = null;
  }
  if (input.ownerEmployeeId !== undefined) {
    row.ownerEmployeeId = input.ownerEmployeeId;
    if (input.ownerEmployeeId) row.ownerId = null;
  }
}

export async function listRevenueAccounts(
  companyId: string,
  opts: {
    q?: string;
    status?: "prospect" | "customer" | "former";
    ownerId?: string;
    ownerEmployeeId?: string;
    customFieldKey?: string;
    customFieldValue?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  rows: Array<Customer & { contactCount: number; openDealCount: number }>;
  total: number;
}> {
  const qb = AppDataSource.getRepository(Customer)
    .createQueryBuilder("a")
    .where("a.companyId = :companyId", { companyId });
  if (!opts.includeArchived) qb.andWhere("a.archivedAt IS NULL");
  if (opts.q) {
    qb.andWhere(
      new Brackets((where) =>
        where
          .where("LOWER(a.name) LIKE :q", { q: `%${opts.q!.toLowerCase()}%` })
          .orWhere("LOWER(a.domain) LIKE :q", { q: `%${opts.q!.toLowerCase()}%` })
          .orWhere("LOWER(a.industry) LIKE :q", { q: `%${opts.q!.toLowerCase()}%` }),
      ),
    );
  }
  if (opts.status) qb.andWhere("a.accountStatus = :status", { status: opts.status });
  if (opts.ownerId) qb.andWhere("a.ownerId = :ownerId", { ownerId: opts.ownerId });
  if (opts.ownerEmployeeId) {
    qb.andWhere("a.ownerEmployeeId = :ownerEmployeeId", { ownerEmployeeId: opts.ownerEmployeeId });
  }
  if (opts.customFieldKey && opts.customFieldValue !== undefined) {
    const ids = await matchingResourceIds(
      companyId,
      "account",
      opts.customFieldKey,
      opts.customFieldValue,
    );
    if (ids.length === 0) return { rows: [], total: 0 };
    qb.andWhere("a.id IN (:...customIds)", { customIds: ids });
  }
  const total = await qb.clone().getCount();
  const accounts = await qb
    .orderBy("a.updatedAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .getMany();
  if (accounts.length === 0) return { rows: [], total };
  const ids = accounts.map((account) => account.id);
  const [contacts, deals] = await Promise.all([
    AppDataSource.getRepository(Contact).find({
      where: { companyId, customerId: In(ids), archivedAt: IsNull() },
      select: { id: true, customerId: true },
    }),
    AppDataSource.getRepository(Deal).find({
      where: { companyId, customerId: In(ids), status: "open", archivedAt: IsNull() },
      select: { id: true, customerId: true },
    }),
  ]);
  return {
    total,
    rows: accounts.map((account) =>
      Object.assign(account, {
        contactCount: contacts.filter((contact) => contact.customerId === account.id).length,
        openDealCount: deals.filter((deal) => deal.customerId === account.id).length,
      }),
    ),
  };
}

export async function getRevenueAccount(
  companyId: string,
  id: string,
): Promise<{
  account: Customer;
  contacts: Contact[];
  deals: Deal[];
} | null> {
  const account = await AppDataSource.getRepository(Customer).findOneBy({ companyId, id });
  if (!account) return null;
  const [contacts, deals] = await Promise.all([
    AppDataSource.getRepository(Contact).find({
      where: { companyId, customerId: account.id, archivedAt: IsNull() },
      order: { lastActivityAt: "DESC" },
    }),
    AppDataSource.getRepository(Deal).find({
      where: { companyId, customerId: account.id, archivedAt: IsNull() },
      order: { updatedAt: "DESC" },
    }),
  ]);
  return { account, contacts, deals };
}

export async function createRevenueAccount(
  companyId: string,
  input: AccountWrite & { name: string },
  actor: { userId?: string | null } = {},
): Promise<Customer> {
  await assertRevenueOwner(companyId, input);
  const repo = AppDataSource.getRepository(Customer);
  const domain = normalizeAccountDomain(input.domain ?? "");
  if (domain && (await repo.findOneBy({ companyId, domain, archivedAt: IsNull() }))) {
    throw new Error("An account with that domain already exists");
  }
  const row = repo.create({
    companyId,
    name: input.name.trim(),
    slug: await uniqueCustomerSlug(companyId, toSlug(input.name)),
    email: "",
    phone: "",
    billingAddress: "",
    shippingAddress: "",
    taxNumber: "",
    currency: "USD",
    annualContractValueCents: 0,
    notes: "",
    accountStatus: "prospect",
    domain: "",
    websiteUrl: "",
    industry: "",
    employeeCount: 0,
    ownerId: null,
    ownerEmployeeId: null,
    archivedAt: null,
    createdById: actor.userId ?? null,
  });
  applyAccountWrite(row, { ...input, domain });
  return repo.save(row);
}

export async function updateRevenueAccount(
  companyId: string,
  id: string,
  patch: AccountWrite,
): Promise<Customer | null> {
  const repo = AppDataSource.getRepository(Customer);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  await assertRevenueOwner(companyId, patch);
  if (patch.domain !== undefined) {
    const domain = normalizeAccountDomain(patch.domain);
    const existing = domain
      ? await repo.findOneBy({ companyId, domain, archivedAt: IsNull() })
      : null;
    if (existing && existing.id !== row.id)
      throw new Error("An account with that domain already exists");
  }
  applyAccountWrite(row, patch);
  return repo.save(row);
}

export async function setRevenueAccountArchived(
  companyId: string,
  id: string,
  archived: boolean,
): Promise<Customer | null> {
  const repo = AppDataSource.getRepository(Customer);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  if (!archived) {
    const redirect = await findMergedRecordRedirect(companyId, "account", id);
    if (redirect) {
      throw new Error(
        `Restore blocked: this Account was merged into ${redirect.targetId}; undo the merge instead`,
      );
    }
  }
  if (!archived && row.domain) {
    const existing = await repo.findOneBy({
      companyId,
      domain: row.domain,
      archivedAt: IsNull(),
    });
    if (existing && existing.id !== row.id) {
      throw new Error(`Restore blocked: ${existing.name} already uses the domain ${row.domain}`);
    }
  }
  row.archivedAt = archived ? new Date() : null;
  return repo.save(row);
}

async function accountMergePreview(
  companyId: string,
  sourceId: string,
  targetId: string,
  preview: RevenueMergePreview,
): Promise<AccountMergePreview> {
  const [source, target] = await Promise.all([
    AppDataSource.getRepository(Customer).findOneBy({ companyId, id: sourceId }),
    AppDataSource.getRepository(Customer).findOneBy({ companyId, id: targetId }),
  ]);
  if (!source) throw new Error("Source account not found");
  if (!target) throw new Error("Destination account not found");
  const count = (key: string) => preview.relationshipCounts[key] ?? 0;
  // Just what the type promises: the whole rows would carry their billing
  // details past `accountMergePreviewForViewer`, which only sees conflicts.
  const summary = ({ id, name, slug, archivedAt }: Customer) => ({ id, name, slug, archivedAt });
  return {
    source: summary(source),
    target: summary(target),
    counts: {
      contacts: count("contacts"),
      deals: count("deals"),
      activities: count("activities"),
      partnerships: count("partnerships"),
      revenueDocuments: count("documents"),
      signalEvents: count("signalEvents"),
      billingContacts: count("billingContacts"),
      contracts: count("contracts"),
      invoices: count("invoices"),
      estimates: count("estimates"),
      recurringInvoices: count("recurringInvoices"),
      credits: count("credits"),
      customValuesCopied: preview.customValuesCopied,
      customValueConflicts: preview.customValueConflicts,
    },
    fieldConflicts: preview.fieldConflicts,
    customFieldConflicts: preview.customFieldConflicts,
    operationId: preview.operationId,
  };
}

export async function previewRevenueAccountMerge(
  companyId: string,
  sourceId: string,
  targetId: string,
  resolutions: MergeConflictResolutions = {},
): Promise<AccountMergePreview> {
  const preview = await previewRevenueMerge(companyId, "account", sourceId, targetId, resolutions);
  return accountMergePreview(companyId, sourceId, targetId, preview);
}

/**
 * Consolidate every Account reference into one destination without deleting
 * the source row. Each conflict uses the operator's source/target choice;
 * missing custom values move across. Document numbers and slugs remain
 * unchanged, so issued finance history keeps its immutable public identity.
 */
export async function mergeRevenueAccounts(
  companyId: string,
  sourceId: string,
  targetId: string,
  confirmSourceName: string,
  actor: RevenueOperationActor = {},
  resolutions: MergeConflictResolutions = {},
): Promise<AccountMergePreview> {
  const preview = await mergeRevenueRecords(
    companyId,
    "account",
    sourceId,
    targetId,
    confirmSourceName,
    actor,
    resolutions,
  );
  return accountMergePreview(companyId, sourceId, targetId, preview);
}
