import { Brackets, In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Customer } from "../../db/entities/Customer.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { uniqueCustomerSlug } from "../finance.js";
import { toSlug } from "../../lib/slug.js";
import { matchingResourceIds } from "./customFields.js";
import { assertRevenueOwner } from "./integrity.js";
import {
  mergeRevenueRecords,
  previewRevenueMerge,
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
  operationId?: string;
};

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
  return {
    source,
    target,
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
    operationId: preview.operationId,
  };
}

export async function previewRevenueAccountMerge(
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<AccountMergePreview> {
  const preview = await previewRevenueMerge(companyId, "account", sourceId, targetId);
  return accountMergePreview(companyId, sourceId, targetId, preview);
}

/**
 * Consolidate every Account reference into one destination without deleting
 * the source row. Existing destination fields and custom values win; missing
 * custom values move across. Document numbers and slugs remain unchanged, so
 * issued finance history keeps its immutable public identity.
 */
export async function mergeRevenueAccounts(
  companyId: string,
  sourceId: string,
  targetId: string,
  confirmSourceName: string,
  actor: RevenueOperationActor = {},
): Promise<AccountMergePreview> {
  const preview = await mergeRevenueRecords(
    companyId,
    "account",
    sourceId,
    targetId,
    confirmSourceName,
    actor,
  );
  return accountMergePreview(companyId, sourceId, targetId, preview);
}
