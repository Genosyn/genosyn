import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import {
  RevenueFieldEvidence,
  type RevenueEvidenceSourceType,
  type RevenueEvidenceStatus,
} from "../../db/entities/RevenueFieldEvidence.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { getProvider } from "../../integrations/index.js";
import { safeFetchBuffer } from "../../lib/outboundUrl.js";
import { decryptConnectionConfig } from "../integrations.js";
import { normalizeAccountDomain } from "./accounts.js";
import { liveDealHistoryKey, recordDealHistoryEvent } from "./dealHistory.js";
import type { RevenueOperationActor } from "./operations.js";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "yandex.com",
  "zoho.com",
]);

const KNOWN_HOST_PREFIXES = new Set([
  "careers",
  "contractor",
  "corp",
  "email",
  "mail",
  "partners",
  "smtp",
  "www",
]);

export type CommercialValue = {
  amountCents: number;
  currency: string;
  revenueType: "one_time" | "recurring";
  billingInterval?: "month" | "quarter" | "year" | null;
  quantity?: number | null;
  seats?: number | null;
  mrrCents?: number | null;
  arrCents?: number | null;
  acvCents?: number | null;
};

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function registrableCandidate(domain: string): { domain: string; alias: string | null } {
  const normalized = normalizeAccountDomain(domain);
  const parts = normalized.split(".");
  if (parts.length > 2 && KNOWN_HOST_PREFIXES.has(parts[0])) {
    return { domain: parts.slice(1).join("."), alias: normalized };
  }
  return { domain: normalized, alias: null };
}

function domainConfidence(accountName: string, domain: string, base: number): number {
  const company = normalizedText(accountName);
  const label = normalizedText(domain.split(".")[0] ?? "");
  if (!company || !label) return Math.min(base, 50);
  if (company.includes(label) || label.includes(company)) return Math.min(base + 10, 98);
  const tokens = accountName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizedText)
    .filter((token) => token.length >= 3);
  return tokens.some((token) => label.includes(token))
    ? Math.min(base + 5, 95)
    : Math.min(base, 65);
}

async function proposeEvidence(input: {
  companyId: string;
  resourceType: "account" | "contact" | "deal" | "partnership";
  resourceId: string;
  fieldKey: string;
  sourceType: RevenueEvidenceSourceType;
  sourceId: string;
  sourceLabel?: string;
  extractedValue: unknown;
  normalizedValue: string;
  confidence: number;
  extractedAt?: Date;
  metadata?: unknown;
}): Promise<{ evidence: RevenueFieldEvidence; created: boolean }> {
  const repo = AppDataSource.getRepository(RevenueFieldEvidence);
  const existing = await repo.findOneBy({
    companyId: input.companyId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    fieldKey: input.fieldKey,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    normalizedValue: input.normalizedValue,
  });
  if (existing) return { evidence: existing, created: false };
  const evidence = await repo.save(
    repo.create({
      companyId: input.companyId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      fieldKey: input.fieldKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel ?? "",
      extractedValueJson: JSON.stringify(input.extractedValue),
      normalizedValue: input.normalizedValue,
      confidence: Math.min(Math.max(Math.round(input.confidence), 0), 100),
      status: "proposed",
      extractedAt: input.extractedAt ?? new Date(),
      lastVerifiedAt: null,
      humanConfirmedAt: null,
      humanConfirmedById: null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
    }),
  );
  return { evidence, created: true };
}

async function recordDomainCollision(
  companyId: string,
  accountId: string,
  otherAccountId: string,
  domain: string,
): Promise<void> {
  if (accountId === otherAccountId) return;
  const [leftId, rightId] = [accountId, otherAccountId].sort();
  const repo = AppDataSource.getRepository(RevenueDuplicateCandidate);
  const existing = await repo.findOneBy({
    companyId,
    resourceType: "account",
    leftId,
    rightId,
  });
  const reason = { kind: "domain_collision", domain, weight: 100 };
  if (existing) {
    const reasons = JSON.parse(existing.reasonsJson || "[]") as unknown[];
    if (!reasons.some((item) => JSON.stringify(item) === JSON.stringify(reason))) {
      existing.reasonsJson = JSON.stringify([...reasons, reason]);
      existing.score = Math.max(existing.score, 100);
      if (existing.status === "dismissed") existing.status = "open";
      await repo.save(existing);
    }
    return;
  }
  await repo.save(
    repo.create({
      companyId,
      resourceType: "account",
      leftId,
      rightId,
      score: 100,
      reasonsJson: JSON.stringify([reason]),
      status: "open",
      mergeOperationId: null,
      detectedAt: new Date(),
      resolvedAt: null,
      resolvedByUserId: null,
    }),
  );
}

export async function proposeCanonicalDomains(
  companyId: string,
  opts: {
    accountIds?: string[];
    verifiedContactIds?: string[];
    followWebsiteRedirects?: boolean;
  } = {},
): Promise<{
  reviewedAccounts: number;
  proposed: number;
  rejectedPublicProviders: number;
  collisions: number;
  errors: Array<{ accountId: string; error: string }>;
}> {
  const accounts = await AppDataSource.getRepository(Customer).find({
    where: opts.accountIds?.length
      ? { companyId, id: In(opts.accountIds) }
      : { companyId, archivedAt: IsNull() },
  });
  const accountIds = accounts.map((account) => account.id);
  const verifiedIds = new Set(opts.verifiedContactIds ?? []);
  const contacts = accountIds.length
    ? await AppDataSource.getRepository(Contact).find({
        where: { companyId, customerId: In(accountIds), archivedAt: IsNull() },
      })
    : [];
  const confirmedEmailEvidence = contacts.length
    ? await AppDataSource.getRepository(RevenueFieldEvidence).find({
        where: {
          companyId,
          resourceType: "contact",
          resourceId: In(contacts.map((contact) => contact.id)),
          fieldKey: "email",
          status: "accepted",
        },
      })
    : [];
  for (const evidence of confirmedEmailEvidence) {
    if (evidence.humanConfirmedAt) verifiedIds.add(evidence.resourceId);
  }
  const byAccount = new Map<string, Contact[]>();
  for (const contact of contacts) {
    if (!verifiedIds.has(contact.id)) continue;
    const list = byAccount.get(contact.customerId!) ?? [];
    list.push(contact);
    byAccount.set(contact.customerId!, list);
  }
  let proposed = 0;
  let rejectedPublicProviders = 0;
  let collisions = 0;
  const errors: Array<{ accountId: string; error: string }> = [];

  for (const account of accounts) {
    const candidates: Array<{
      domain: string;
      sourceType: RevenueEvidenceSourceType;
      sourceId: string;
      sourceLabel: string;
      baseConfidence: number;
      alias: string | null;
      metadata?: unknown;
    }> = [];
    for (const contact of byAccount.get(account.id) ?? []) {
      const emailDomain = contact.email.split("@")[1] ?? "";
      if (!emailDomain) continue;
      if (PUBLIC_EMAIL_DOMAINS.has(emailDomain)) {
        rejectedPublicProviders += 1;
        continue;
      }
      const candidate = registrableCandidate(emailDomain);
      candidates.push({
        ...candidate,
        sourceType: "email",
        sourceId: contact.id,
        sourceLabel: contact.email,
        baseConfidence: candidate.alias ? 70 : 80,
        metadata: { verifiedContactEmail: true },
      });
    }
    if (account.websiteUrl) {
      try {
        let finalUrl = account.websiteUrl;
        if (opts.followWebsiteRedirects) {
          const response = await safeFetchBuffer(
            account.websiteUrl,
            { method: "HEAD" },
            { maxBytes: 1_024, timeoutMs: 8_000 },
          );
          finalUrl = response.url;
        }
        const host = new URL(finalUrl).hostname;
        const candidate = registrableCandidate(host);
        candidates.push({
          ...candidate,
          sourceType: "website",
          sourceId: account.id,
          sourceLabel: account.websiteUrl,
          baseConfidence: 90,
          metadata: { finalUrl },
        });
      } catch (error) {
        errors.push({ accountId: account.id, error: (error as Error).message });
      }
    }
    const unique = new Map(candidates.map((candidate) => [candidate.domain, candidate]));
    for (const candidate of unique.values()) {
      const existing = await AppDataSource.getRepository(Customer).findOneBy({
        companyId,
        domain: candidate.domain,
        archivedAt: IsNull(),
      });
      if (existing && existing.id !== account.id) {
        await recordDomainCollision(companyId, account.id, existing.id, candidate.domain);
        collisions += 1;
      }
      const result = await proposeEvidence({
        companyId,
        resourceType: "account",
        resourceId: account.id,
        fieldKey: "domain",
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        sourceLabel: candidate.sourceLabel,
        extractedValue: candidate.domain,
        normalizedValue: candidate.domain,
        confidence: domainConfidence(account.name, candidate.domain, candidate.baseConfidence),
        metadata: {
          ...(candidate.metadata as Record<string, unknown> | undefined),
          aliasDomain: candidate.alias,
          currentDomain: account.domain || null,
          collisionAccountId: existing?.id ?? null,
        },
      });
      if (result.created) proposed += 1;
    }
  }
  return {
    reviewedAccounts: accounts.length,
    proposed,
    rejectedPublicProviders,
    collisions,
    errors,
  };
}

function validateCommercialValue(value: CommercialValue): CommercialValue {
  if (!Number.isInteger(value.amountCents) || value.amountCents < 0 || value.amountCents > 2_000_000_000) {
    throw new Error("Commercial amount must be a non-negative integer in minor units");
  }
  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Error("Commercial currency must be ISO-4217");
  for (const [key, amount] of Object.entries({
    mrrCents: value.mrrCents,
    arrCents: value.arrCents,
    acvCents: value.acvCents,
  })) {
    if (amount !== undefined && amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return value;
}

export async function createCommercialValueProposal(
  companyId: string,
  input: {
    dealId: string;
    sourceType: Extract<RevenueEvidenceSourceType, "email" | "document" | "integration" | "finance" | "manual">;
    sourceId: string;
    sourceLabel?: string;
    sourceVerified: boolean;
    confidence: number;
    value: CommercialValue;
    extractedAt?: Date;
    metadata?: unknown;
  },
): Promise<RevenueFieldEvidence> {
  const deal = await AppDataSource.getRepository(Deal).findOneBy({
    companyId,
    id: input.dealId,
  });
  if (!deal) throw new Error("Deal not found");
  if (!input.sourceVerified) {
    throw new Error("Unverified prose cannot be used as commercial-value evidence");
  }
  const value = validateCommercialValue({
    ...input.value,
    currency: input.value.currency.toUpperCase(),
  });
  const result = await proposeEvidence({
    companyId,
    resourceType: "deal",
    resourceId: deal.id,
    fieldKey: "commercial_value",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    extractedValue: value,
    normalizedValue: `${value.currency}:${value.amountCents}:${value.revenueType}:${value.billingInterval ?? ""}`,
    confidence: input.confidence,
    extractedAt: input.extractedAt,
    metadata: { ...((input.metadata as Record<string, unknown>) ?? {}), sourceVerified: true },
  });
  return result.evidence;
}

export async function proposeCommercialValuesFromFinance(
  companyId: string,
): Promise<{ proposed: number; ambiguousAccounts: number }> {
  const deals = await AppDataSource.getRepository(Deal).find({
    where: { companyId, amountCents: 0, archivedAt: IsNull() },
  });
  const accountIds = [
    ...new Set(deals.map((deal) => deal.customerId).filter((id): id is string => Boolean(id))),
  ];
  const [accounts, invoices] = await Promise.all([
    accountIds.length
      ? AppDataSource.getRepository(Customer).find({
          where: { companyId, id: In(accountIds) },
        })
      : [],
    accountIds.length
      ? AppDataSource.getRepository(Invoice).find({
          where: { companyId, customerId: In(accountIds), status: In(["sent", "paid"]) },
          order: { issueDate: "DESC" },
        })
      : [],
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const dealsByAccount = new Map<string, Deal[]>();
  for (const deal of deals) {
    if (!deal.customerId) continue;
    const list = dealsByAccount.get(deal.customerId) ?? [];
    list.push(deal);
    dealsByAccount.set(deal.customerId, list);
  }
  let proposed = 0;
  let ambiguousAccounts = 0;
  for (const [accountId, accountDeals] of dealsByAccount) {
    if (accountDeals.length !== 1) {
      ambiguousAccounts += 1;
      continue;
    }
    const deal = accountDeals[0];
    const account = accountById.get(accountId);
    const invoice = invoices.find((row) => row.customerId === accountId);
    if (invoice && invoice.totalCents > 0) {
      await createCommercialValueProposal(companyId, {
        dealId: deal.id,
        sourceType: "finance",
        sourceId: invoice.id,
        sourceLabel: invoice.number || invoice.slug,
        sourceVerified: true,
        confidence: 95,
        value: {
          amountCents: invoice.totalCents,
          currency: invoice.currency,
          revenueType: "one_time",
        },
        extractedAt: invoice.issueDate,
      });
      proposed += 1;
    } else if (account && account.annualContractValueCents > 0) {
      await createCommercialValueProposal(companyId, {
        dealId: deal.id,
        sourceType: "finance",
        sourceId: account.id,
        sourceLabel: `${account.name} Annual Contract Value`,
        sourceVerified: true,
        confidence: 80,
        value: {
          amountCents: account.annualContractValueCents,
          currency: account.currency,
          revenueType: "recurring",
          billingInterval: "year",
          mrrCents: Math.round(account.annualContractValueCents / 12),
          arrCents: account.annualContractValueCents,
          acvCents: account.annualContractValueCents,
        },
      });
      proposed += 1;
    }
  }
  return { proposed, ambiguousAccounts };
}

type StripeSubscription = {
  id?: unknown;
  status?: unknown;
  customer?: unknown;
  currency?: unknown;
  created?: unknown;
  items?: {
    data?: Array<{
      quantity?: unknown;
      price?: {
        unit_amount?: unknown;
        currency?: unknown;
        recurring?: { interval?: unknown; interval_count?: unknown };
      };
    }>;
  };
};

type StripeInvoice = {
  id?: unknown;
  status?: unknown;
  amount_paid?: unknown;
  total?: unknown;
  currency?: unknown;
  created?: unknown;
};

function stripeRecurringValue(subscription: StripeSubscription): CommercialValue | null {
  if (!["active", "past_due", "trialing"].includes(String(subscription.status ?? ""))) {
    return null;
  }
  const items = subscription.items?.data ?? [];
  let annualCents = 0;
  let monthlyCents = 0;
  let currency = typeof subscription.currency === "string" ? subscription.currency.toUpperCase() : "";
  let quantity = 0;
  for (const item of items) {
    const unitAmount = Number(item.price?.unit_amount);
    const itemQuantity = Math.max(1, Number(item.quantity) || 1);
    const intervalCount = Math.max(1, Number(item.price?.recurring?.interval_count) || 1);
    const interval = String(item.price?.recurring?.interval ?? "");
    const itemCurrency =
      typeof item.price?.currency === "string" ? item.price.currency.toUpperCase() : currency;
    if (!Number.isInteger(unitAmount) || unitAmount < 0 || !itemCurrency) continue;
    if (currency && itemCurrency !== currency) return null;
    currency = itemCurrency;
    const billedCents = unitAmount * itemQuantity;
    if (interval === "month") {
      monthlyCents += billedCents / intervalCount;
      annualCents += (billedCents * 12) / intervalCount;
    } else if (interval === "year") {
      monthlyCents += billedCents / (12 * intervalCount);
      annualCents += billedCents / intervalCount;
    } else if (interval === "week") {
      monthlyCents += (billedCents * 52) / (12 * intervalCount);
      annualCents += (billedCents * 52) / intervalCount;
    } else if (interval === "day") {
      monthlyCents += (billedCents * 365) / (12 * intervalCount);
      annualCents += (billedCents * 365) / intervalCount;
    } else {
      continue;
    }
    quantity += itemQuantity;
  }
  if (!currency || annualCents <= 0) return null;
  const arrCents = Math.round(annualCents);
  return validateCommercialValue({
    amountCents: arrCents,
    currency,
    revenueType: "recurring",
    billingInterval: "year",
    quantity: quantity || undefined,
    seats: quantity || undefined,
    mrrCents: Math.round(monthlyCents),
    arrCents,
    acvCents: arrCents,
  });
}

export async function proposeCommercialValuesFromStripe(
  companyId: string,
): Promise<{
  proposed: number;
  reviewedCustomers: number;
  ambiguousAccounts: number;
  errors: Array<{ connectionId: string; customerId?: string; error: string }>;
}> {
  const [field, connections, zeroDeals] = await Promise.all([
    AppDataSource.getRepository(RevenueCustomField).findOneBy({
      companyId,
      resourceType: "account",
      key: "stripe_customer_id",
    }),
    AppDataSource.getRepository(IntegrationConnection).find({
      where: { companyId, provider: "stripe", status: "connected" },
    }),
    AppDataSource.getRepository(Deal).find({
      where: { companyId, amountCents: 0, archivedAt: IsNull() },
    }),
  ]);
  if (!field || connections.length === 0) {
    return { proposed: 0, reviewedCustomers: 0, ambiguousAccounts: 0, errors: [] };
  }
  const values = await AppDataSource.getRepository(RevenueCustomValue).find({
    where: { companyId, fieldId: field.id, resourceType: "account" },
  });
  const dealsByAccount = new Map<string, Deal[]>();
  for (const deal of zeroDeals) {
    if (!deal.customerId) continue;
    const list = dealsByAccount.get(deal.customerId) ?? [];
    list.push(deal);
    dealsByAccount.set(deal.customerId, list);
  }
  const provider = getProvider("stripe");
  if (!provider) throw new Error("Stripe Integration is unavailable");
  let proposed = 0;
  let reviewedCustomers = 0;
  let ambiguousAccounts = 0;
  const errors: Array<{ connectionId: string; customerId?: string; error: string }> = [];
  for (const value of values) {
    let customerId = value.searchValue.trim();
    if (!customerId) {
      try {
        const parsed = JSON.parse(value.valueJson) as unknown;
        if (typeof parsed === "string") customerId = parsed.trim();
      } catch {
        customerId = "";
      }
    }
    if (!customerId.startsWith("cus_")) continue;
    const deals = dealsByAccount.get(value.resourceId) ?? [];
    if (deals.length !== 1) {
      if (deals.length > 1) ambiguousAccounts += 1;
      continue;
    }
    reviewedCustomers += 1;
    for (const connection of connections) {
      try {
        const runtime = {
          authMode: connection.authMode,
          config: decryptConnectionConfig(connection),
          connectionId: connection.id,
          companyId,
        };
        const [subscriptionResult, invoiceResult] = (await Promise.all([
          provider.invokeTool(
            "list_subscriptions",
            { customerId, status: "all", limit: 100 },
            runtime,
          ),
          provider.invokeTool(
            "list_invoices",
            { customerId, status: "paid", limit: 100 },
            runtime,
          ),
        ])) as [{ data?: StripeSubscription[] }, { data?: StripeInvoice[] }];
        for (const subscription of subscriptionResult.data ?? []) {
          const commercial = stripeRecurringValue(subscription);
          if (!commercial || typeof subscription.id !== "string") continue;
          const evidence = await createCommercialValueProposal(companyId, {
            dealId: deals[0].id,
            sourceType: "integration",
            sourceId: subscription.id,
            sourceLabel: `${connection.label} · ${subscription.id}`,
            sourceVerified: true,
            confidence: 98,
            value: commercial,
            extractedAt:
              typeof subscription.created === "number"
                ? new Date(subscription.created * 1_000)
                : new Date(),
            metadata: { connectionId: connection.id, stripeCustomerId: customerId },
          });
          if (evidence.status === "proposed") proposed += 1;
        }
        for (const invoice of invoiceResult.data ?? []) {
          if (
            invoice.status !== "paid" ||
            typeof invoice.id !== "string" ||
            typeof invoice.currency !== "string"
          ) {
            continue;
          }
          const amountCents = Number(invoice.amount_paid ?? invoice.total);
          if (!Number.isInteger(amountCents) || amountCents <= 0) continue;
          const evidence = await createCommercialValueProposal(companyId, {
            dealId: deals[0].id,
            sourceType: "integration",
            sourceId: invoice.id,
            sourceLabel: `${connection.label} · ${invoice.id}`,
            sourceVerified: true,
            confidence: 98,
            value: {
              amountCents,
              currency: invoice.currency.toUpperCase(),
              revenueType: "one_time",
            },
            extractedAt:
              typeof invoice.created === "number"
                ? new Date(invoice.created * 1_000)
                : new Date(),
            metadata: { connectionId: connection.id, stripeCustomerId: customerId },
          });
          if (evidence.status === "proposed") proposed += 1;
        }
      } catch (error) {
        errors.push({
          connectionId: connection.id,
          customerId,
          error: (error as Error).message,
        });
      }
    }
  }
  return { proposed, reviewedCustomers, ambiguousAccounts, errors };
}

export async function listRevenueEvidence(
  companyId: string,
  opts: {
    resourceType?: "account" | "contact" | "deal" | "partnership";
    resourceId?: string;
    fieldKey?: string;
    sourceType?: RevenueEvidenceSourceType;
    status?: RevenueEvidenceStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueFieldEvidence[]; total: number }> {
  const qb = AppDataSource.getRepository(RevenueFieldEvidence)
    .createQueryBuilder("evidence")
    .where("evidence.companyId = :companyId", { companyId });
  if (opts.resourceType) {
    qb.andWhere("evidence.resourceType = :resourceType", {
      resourceType: opts.resourceType,
    });
  }
  if (opts.resourceId) qb.andWhere("evidence.resourceId = :resourceId", { resourceId: opts.resourceId });
  if (opts.fieldKey) qb.andWhere("evidence.fieldKey = :fieldKey", { fieldKey: opts.fieldKey });
  if (opts.sourceType) qb.andWhere("evidence.sourceType = :sourceType", { sourceType: opts.sourceType });
  if (opts.status) qb.andWhere("evidence.status = :status", { status: opts.status });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("evidence.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows, total };
}

export async function reviewRevenueEvidence(
  companyId: string,
  evidenceId: string,
  decision: "accept" | "reject",
  actor: RevenueOperationActor,
): Promise<RevenueFieldEvidence> {
  const repo = AppDataSource.getRepository(RevenueFieldEvidence);
  const evidence = await repo.findOneBy({ companyId, id: evidenceId });
  if (!evidence) throw new Error("Evidence not found");
  if (evidence.status !== "proposed") throw new Error("Evidence has already been reviewed");
  if (decision === "reject") {
    evidence.status = "rejected";
    evidence.humanConfirmedAt = new Date();
    evidence.humanConfirmedById = actor.userId ?? null;
    return repo.save(evidence);
  }
  const value = JSON.parse(evidence.extractedValueJson) as unknown;
  if (evidence.resourceType === "account" && evidence.fieldKey === "domain") {
    if (typeof value !== "string") throw new Error("Domain evidence is malformed");
    const domain = normalizeAccountDomain(value);
    const collision = await AppDataSource.getRepository(Customer).findOneBy({
      companyId,
      domain,
      archivedAt: IsNull(),
    });
    if (collision && collision.id !== evidence.resourceId) {
      throw new Error(`Domain is already verified on ${collision.name}; review the merge candidate`);
    }
    const accepted = await repo.findOne({
      where: {
        companyId,
        resourceType: "account",
        resourceId: evidence.resourceId,
        fieldKey: "domain",
        status: "accepted",
      },
      order: { humanConfirmedAt: "DESC" },
    });
    if (accepted && accepted.normalizedValue !== domain) {
      throw new Error("A verified domain already exists; supersede it explicitly before accepting");
    }
    await AppDataSource.getRepository(Customer).update(
      { companyId, id: evidence.resourceId },
      { domain },
    );
  } else if (evidence.resourceType === "deal" && evidence.fieldKey === "commercial_value") {
    const commercial = validateCommercialValue(value as CommercialValue);
    const deal = await AppDataSource.getRepository(Deal).findOneBy({
      companyId,
      id: evidence.resourceId,
    });
    if (!deal) throw new Error("Deal not found");
    await AppDataSource.getRepository(Deal).update(
      { companyId, id: evidence.resourceId },
      { amountCents: commercial.amountCents, currency: commercial.currency },
    );
    await recordDealHistoryEvent(companyId, {
      dealId: deal.id,
      kind: "amount_changed",
      occurredAt: new Date(),
      fromAmountCents: deal.amountCents,
      toAmountCents: commercial.amountCents,
      currency: commercial.currency,
      sourceKind: "live",
      sourceKey: liveDealHistoryKey(deal.id, "amount_changed"),
      metadata: { revenueFieldEvidenceId: evidence.id },
      actor,
    });
  } else if (evidence.resourceType === "contact" && evidence.fieldKey === "email") {
    const contact = await AppDataSource.getRepository(Contact).findOneBy({
      companyId,
      id: evidence.resourceId,
    });
    if (!contact || typeof value !== "string" || contact.email !== value.toLowerCase()) {
      throw new Error("Contact email evidence no longer matches the Contact");
    }
  } else {
    throw new Error("This evidence field cannot be applied automatically");
  }
  evidence.status = "accepted";
  evidence.lastVerifiedAt = new Date();
  evidence.humanConfirmedAt = evidence.lastVerifiedAt;
  evidence.humanConfirmedById = actor.userId ?? null;
  return repo.save(evidence);
}
