import { In, IsNull, type EntityManager, type EntityTarget, type ObjectLiteral } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { InvoicePayment } from "../../db/entities/InvoicePayment.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import {
  RevenueFieldEvidence,
  type RevenueEvidenceSourceType,
  type RevenueEvidenceStatus,
} from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueImportBatch } from "../../db/entities/RevenueImportBatch.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { getProvider } from "../../integrations/index.js";
import { emailDomain } from "../../lib/emailAddress.js";
import { safeFetchBuffer } from "../../lib/outboundUrl.js";
import { decryptConnectionConfig } from "../integrations.js";
import { normalizeAccountDomain } from "./accounts.js";
import { liveDealHistoryKey } from "./dealHistory.js";
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

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "mintemail.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

const COMMON_MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "co.za",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "net.au",
  "org.au",
  "org.uk",
]);

const HOSTED_SITE_SUFFIXES = new Set([
  "github.io",
  "herokuapp.com",
  "myshopify.com",
  "netlify.app",
  "notion.site",
  "pages.dev",
  "vercel.app",
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
  tcvCents?: number | null;
  oneTimeCents?: number | null;
};

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function registrableCandidate(domain: string): { domain: string; alias: string | null } {
  const normalized = normalizeAccountDomain(domain);
  const parts = normalized.split(".");
  if (parts.length < 3 || HOSTED_SITE_SUFFIXES.has(parts.slice(-2).join("."))) {
    return { domain: normalized, alias: null };
  }
  const suffixLength = COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(parts.slice(-2).join(".")) ? 2 : 1;
  const registrableLength = suffixLength + 1;
  if (parts.length > registrableLength) {
    return {
      domain: parts.slice(-registrableLength).join("."),
      alias: normalized,
    };
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
      verificationState: "unverified",
      extractionMethod: `${input.sourceType}_candidate_generation`,
      observedAt: input.extractedAt ?? new Date(),
      extractedAt: input.extractedAt ?? new Date(),
      lastVerifiedAt: null,
      humanConfirmedAt: null,
      humanConfirmedById: null,
      verifyingActorType: null,
      verifyingActorId: null,
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
  rejectedDisposableProviders: number;
  collisions: number;
  errors: Array<{ accountId: string; error: string }>;
}> {
  const accounts = await AppDataSource.getRepository(Customer).find({
    where: opts.accountIds?.length
      ? { companyId, id: In(opts.accountIds) }
      : { companyId, archivedAt: IsNull() },
  });
  const accountIds = accounts.map((account) => account.id);
  const verifiedIds = new Set<string>();
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
    if (evidence.verificationState === "verified" || evidence.humanConfirmedAt) {
      verifiedIds.add(evidence.resourceId);
    }
  }
  const byAccount = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const list = byAccount.get(contact.customerId!) ?? [];
    list.push(contact);
    byAccount.set(contact.customerId!, list);
  }
  let proposed = 0;
  let rejectedPublicProviders = 0;
  let rejectedDisposableProviders = 0;
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
      const contactDomain = emailDomain(contact.email);
      if (!contactDomain) continue;
      const candidate = registrableCandidate(contactDomain);
      if (PUBLIC_EMAIL_DOMAINS.has(contactDomain) || PUBLIC_EMAIL_DOMAINS.has(candidate.domain)) {
        rejectedPublicProviders += 1;
        continue;
      }
      if (
        DISPOSABLE_EMAIL_DOMAINS.has(contactDomain) ||
        DISPOSABLE_EMAIL_DOMAINS.has(candidate.domain)
      ) {
        rejectedDisposableProviders += 1;
        continue;
      }
      const verified = verifiedIds.has(contact.id);
      candidates.push({
        ...candidate,
        sourceType: "email",
        sourceId: contact.id,
        sourceLabel: contact.email,
        baseConfidence: verified ? (candidate.alias ? 75 : 85) : candidate.alias ? 55 : 65,
        metadata: {
          verifiedContactEmail: verified,
          requestedAsVerified: opts.verifiedContactIds?.includes(contact.id) ?? false,
        },
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
    rejectedDisposableProviders,
    collisions,
    errors,
  };
}

function validateCommercialValue(value: CommercialValue): CommercialValue {
  if (
    !Number.isInteger(value.amountCents) ||
    value.amountCents < 0 ||
    value.amountCents > 2_000_000_000
  ) {
    throw new Error("Commercial amount must be a non-negative integer in minor units");
  }
  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Error("Commercial currency must be ISO-4217");
  const normalized: CommercialValue = {
    ...value,
    tcvCents: value.tcvCents ?? (value.revenueType === "one_time" ? value.amountCents : null),
    oneTimeCents:
      value.oneTimeCents ?? (value.revenueType === "one_time" ? value.amountCents : null),
  };
  for (const [key, amount] of Object.entries({
    mrrCents: value.mrrCents,
    arrCents: value.arrCents,
    acvCents: value.acvCents,
    tcvCents: normalized.tcvCents,
    oneTimeCents: normalized.oneTimeCents,
  })) {
    if (amount !== undefined && amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return normalized;
}

function recordMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type CommercialProposalBaseline = {
  amountCents: number;
  currency: string;
  updatedAt: string;
};

function commercialProposalBaseline(
  evidence: Pick<RevenueFieldEvidence, "metadataJson">,
): CommercialProposalBaseline | null {
  try {
    const metadata = recordMetadata(JSON.parse(evidence.metadataJson || "{}"));
    const baseline = recordMetadata(metadata.proposalBaseline);
    return Number.isInteger(baseline.amountCents) &&
      typeof baseline.currency === "string" &&
      typeof baseline.updatedAt === "string" &&
      Number.isFinite(new Date(baseline.updatedAt).getTime())
      ? {
          amountCents: Number(baseline.amountCents),
          currency: baseline.currency,
          updatedAt: baseline.updatedAt,
        }
      : null;
  } catch {
    return null;
  }
}

function commercialProposalIsStale(
  evidence: Pick<RevenueFieldEvidence, "metadataJson">,
  deal: Pick<Deal, "amountCents" | "currency" | "updatedAt">,
): boolean | null {
  const baseline = commercialProposalBaseline(evidence);
  if (!baseline) return null;
  return (
    baseline.amountCents !== deal.amountCents ||
    baseline.currency !== deal.currency ||
    new Date(baseline.updatedAt).getTime() !== deal.updatedAt.getTime()
  );
}

function reviewedEvidenceText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} evidence is malformed`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    throw new Error(`${label} evidence is malformed`);
  }
  return trimmed;
}

function reviewedEmployeeCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 2_000_000_000
  ) {
    throw new Error("Employee count evidence is malformed");
  }
  return value;
}

export async function assertRevenueEvidenceSource(
  companyId: string,
  input: {
    sourceType: RevenueEvidenceSourceType;
    sourceId: string;
    metadata?: unknown;
  },
): Promise<void> {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error("Commercial-value evidence needs a source ID");

  if (input.sourceType === "manual") return;

  if (input.sourceType === "website") {
    const account = await AppDataSource.getRepository(Customer).findOneBy({
      companyId,
      id: sourceId,
    });
    if (!account) throw new Error("Source website Account not found in this company");
    return;
  }

  if (input.sourceType === "import") {
    const [batch, row] = await Promise.all([
      AppDataSource.getRepository(RevenueImportBatch).findOneBy({ companyId, id: sourceId }),
      AppDataSource.getRepository(RevenueImportRow).findOneBy({ companyId, id: sourceId }),
    ]);
    if (!batch && !row) throw new Error("Source Revenue import not found in this company");
    return;
  }

  if (input.sourceType === "email") {
    const message = await AppDataSource.getRepository(MailMessage).findOneBy({
      companyId,
      id: sourceId,
    });
    if (!message) throw new Error("Source mail message not found in this company");
    return;
  }

  if (input.sourceType === "document") {
    const document = await AppDataSource.getRepository(RevenueDocument).findOneBy({
      companyId,
      id: sourceId,
    });
    if (!document) throw new Error("Source Revenue document not found in this company");
    return;
  }

  if (input.sourceType === "integration") {
    const connectionId = recordMetadata(input.metadata).connectionId;
    if (typeof connectionId !== "string" || !connectionId) {
      throw new Error("Integration evidence needs metadata.connectionId");
    }
    const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      companyId,
      id: connectionId,
    });
    if (!connection) throw new Error("Source Connection not found in this company");
    return;
  }

  const [invoice, estimate, customer, payment] = await Promise.all([
    AppDataSource.getRepository(Invoice).findOneBy({ companyId, id: sourceId }),
    AppDataSource.getRepository(Estimate).findOneBy({ companyId, id: sourceId }),
    AppDataSource.getRepository(Customer).findOneBy({ companyId, id: sourceId }),
    AppDataSource.getRepository(InvoicePayment).findOneBy({ id: sourceId }),
  ]);
  if (invoice || estimate || customer) return;
  if (payment) {
    const paymentInvoice = await AppDataSource.getRepository(Invoice).findOneBy({
      companyId,
      id: payment.invoiceId,
    });
    if (paymentInvoice) return;
  }
  throw new Error("Source Finance record not found in this company");
}

type CommercialValueProposalInput = {
  dealId: string;
  sourceType: Extract<
    RevenueEvidenceSourceType,
    "email" | "document" | "integration" | "finance" | "manual"
  >;
  sourceId: string;
  sourceLabel?: string;
  sourceVerified: boolean;
  confidence: number;
  value: CommercialValue;
  extractedAt?: Date;
  metadata?: unknown;
};

async function createCommercialValueProposalResult(
  companyId: string,
  input: CommercialValueProposalInput,
): Promise<{ evidence: RevenueFieldEvidence; created: boolean }> {
  const deal = await AppDataSource.getRepository(Deal).findOneBy({
    companyId,
    id: input.dealId,
  });
  if (!deal) throw new Error("Deal not found");
  if (!input.sourceVerified) {
    throw new Error("Unverified prose cannot be used as commercial-value evidence");
  }
  await assertRevenueEvidenceSource(companyId, input);
  const value = validateCommercialValue({
    ...input.value,
    currency: input.value.currency.toUpperCase(),
  });
  return proposeEvidence({
    companyId,
    resourceType: "deal",
    resourceId: deal.id,
    fieldKey: "commercial_value",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    extractedValue: value,
    normalizedValue: [
      value.currency,
      value.amountCents,
      value.revenueType,
      value.billingInterval ?? "",
      value.tcvCents ?? "",
      value.oneTimeCents ?? "",
    ].join(":"),
    confidence: input.confidence,
    extractedAt: input.extractedAt,
    metadata: {
      ...recordMetadata(input.metadata),
      sourceVerified: true,
      proposalBaseline: {
        amountCents: deal.amountCents,
        currency: deal.currency,
        updatedAt: deal.updatedAt.toISOString(),
      },
    },
  });
}

export async function createCommercialValueProposal(
  companyId: string,
  input: CommercialValueProposalInput,
): Promise<RevenueFieldEvidence> {
  return (await createCommercialValueProposalResult(companyId, input)).evidence;
}

export async function proposeCommercialValuesFromFinance(
  companyId: string,
  opts: { dealIds?: string[] } = {},
): Promise<{ proposed: number; ambiguousAccounts: number }> {
  const selectedDealIds = [...new Set(opts.dealIds ?? [])];
  if (selectedDealIds.length > 5_000) {
    throw new Error("Commercial-value reconciliation is limited to 5,000 Deals");
  }
  const deals = await AppDataSource.getRepository(Deal).find({
    where: {
      companyId,
      amountCents: 0,
      status: "open",
      archivedAt: IsNull(),
      ...(opts.dealIds ? { id: In(selectedDealIds) } : {}),
    },
  });
  const accountIds = [
    ...new Set(deals.map((deal) => deal.customerId).filter((id): id is string => Boolean(id))),
  ];
  const [accounts, invoices, acceptedEstimates] = await Promise.all([
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
    accountIds.length
      ? AppDataSource.getRepository(Estimate).find({
          where: { companyId, customerId: In(accountIds), status: "accepted" },
          order: { acceptedAt: "DESC", issueDate: "DESC" },
        })
      : [],
  ]);
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const payments = invoices.length
    ? await AppDataSource.getRepository(InvoicePayment).find({
        where: { invoiceId: In(invoices.map((invoice) => invoice.id)) },
        order: { paidAt: "DESC" },
      })
    : [];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const allEligibleDeals = accountIds.length
    ? await AppDataSource.getRepository(Deal).find({
        where: {
          companyId,
          customerId: In(accountIds),
          amountCents: 0,
          status: "open",
          archivedAt: IsNull(),
        },
      })
    : [];
  const eligibleDealsByAccount = new Map<string, Deal[]>();
  for (const deal of allEligibleDeals) {
    if (!deal.customerId) continue;
    const list = eligibleDealsByAccount.get(deal.customerId) ?? [];
    list.push(deal);
    eligibleDealsByAccount.set(deal.customerId, list);
  }
  let proposed = 0;
  const ambiguousAccountIds = new Set<string>();
  for (const deal of deals) {
    if (!deal.customerId) continue;
    const accountId = deal.customerId;
    if ((eligibleDealsByAccount.get(accountId) ?? []).length !== 1) {
      ambiguousAccountIds.add(accountId);
      continue;
    }
    const account = accountById.get(accountId);
    const acceptedEstimate = acceptedEstimates.find(
      (row) => row.customerId === accountId && row.totalCents > 0,
    );
    const payment = payments.find(
      (row) => invoiceById.get(row.invoiceId)?.customerId === accountId && row.amountCents > 0,
    );
    const paymentInvoice = payment ? invoiceById.get(payment.invoiceId) : undefined;
    const invoice = invoices.find((row) => row.customerId === accountId && row.totalCents > 0);
    if (acceptedEstimate) {
      const result = await createCommercialValueProposalResult(companyId, {
        dealId: deal.id,
        sourceType: "finance",
        sourceId: acceptedEstimate.id,
        sourceLabel: acceptedEstimate.number || acceptedEstimate.slug,
        sourceVerified: true,
        confidence: 99,
        value: {
          amountCents: acceptedEstimate.totalCents,
          currency: acceptedEstimate.currency,
          revenueType: "one_time",
          tcvCents: acceptedEstimate.totalCents,
          oneTimeCents: acceptedEstimate.totalCents,
        },
        extractedAt: acceptedEstimate.acceptedAt ?? acceptedEstimate.issueDate,
        metadata: { financeSource: "accepted_estimate" },
      });
      if (result.created) proposed += 1;
    } else if (payment && paymentInvoice && paymentInvoice.totalCents > 0) {
      const result = await createCommercialValueProposalResult(companyId, {
        dealId: deal.id,
        sourceType: "finance",
        sourceId: payment.id,
        sourceLabel: `${paymentInvoice.number || paymentInvoice.slug} payment`,
        sourceVerified: true,
        confidence: 98,
        value: {
          amountCents: paymentInvoice.totalCents,
          currency: paymentInvoice.currency,
          revenueType: "one_time",
          tcvCents: paymentInvoice.totalCents,
          oneTimeCents: paymentInvoice.totalCents,
        },
        extractedAt: payment.paidAt,
        metadata: {
          financeSource: "invoice_payment",
          invoiceId: paymentInvoice.id,
          paidAmountCents: payment.amountCents,
        },
      });
      if (result.created) proposed += 1;
    } else if (invoice) {
      const result = await createCommercialValueProposalResult(companyId, {
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
        metadata: { financeSource: "invoice", invoiceStatus: invoice.status },
      });
      if (result.created) proposed += 1;
    } else if (account && account.annualContractValueCents > 0) {
      const result = await createCommercialValueProposalResult(companyId, {
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
        metadata: { financeSource: "account_acv" },
      });
      if (result.created) proposed += 1;
    }
  }
  return { proposed, ambiguousAccounts: ambiguousAccountIds.size };
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
  let currency =
    typeof subscription.currency === "string" ? subscription.currency.toUpperCase() : "";
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
  opts: { connectionId?: string; dealIds?: string[] } = {},
): Promise<{
  proposed: number;
  reviewedCustomers: number;
  ambiguousAccounts: number;
  errors: Array<{ connectionId: string; customerId?: string; error: string }>;
}> {
  const selectedDealIds = [...new Set(opts.dealIds ?? [])];
  if (selectedDealIds.length > 5_000) {
    throw new Error("Commercial-value reconciliation is limited to 5,000 Deals");
  }
  const [field, zeroDeals] = await Promise.all([
    AppDataSource.getRepository(RevenueCustomField).findOneBy({
      companyId,
      resourceType: "account",
      key: "stripe_customer_id",
    }),
    AppDataSource.getRepository(Deal).find({
      where: {
        companyId,
        amountCents: 0,
        status: "open",
        archivedAt: IsNull(),
        ...(opts.dealIds ? { id: In(selectedDealIds) } : {}),
      },
    }),
  ]);
  const connections = opts.connectionId
    ? [
        await AppDataSource.getRepository(IntegrationConnection).findOneBy({
          companyId,
          id: opts.connectionId,
          provider: "stripe",
          status: "connected",
        }),
      ].filter((connection): connection is IntegrationConnection => Boolean(connection))
    : await AppDataSource.getRepository(IntegrationConnection).find({
        where: { companyId, provider: "stripe", status: "connected" },
      });
  if (opts.connectionId && connections.length === 0) {
    throw new Error("Connected Stripe Connection not found in this company");
  }
  if (!field || connections.length === 0) {
    return { proposed: 0, reviewedCustomers: 0, ambiguousAccounts: 0, errors: [] };
  }
  const accountIds = [
    ...new Set(zeroDeals.map((deal) => deal.customerId).filter((id): id is string => Boolean(id))),
  ];
  if (accountIds.length === 0) {
    return { proposed: 0, reviewedCustomers: 0, ambiguousAccounts: 0, errors: [] };
  }
  const values = await AppDataSource.getRepository(RevenueCustomValue).find({
    where: {
      companyId,
      fieldId: field.id,
      resourceType: "account",
      resourceId: In(accountIds),
    },
  });
  const allEligibleDeals = await AppDataSource.getRepository(Deal).find({
    where: {
      companyId,
      customerId: In(accountIds),
      amountCents: 0,
      status: "open",
      archivedAt: IsNull(),
    },
  });
  const eligibleDealsByAccount = new Map<string, Deal[]>();
  for (const deal of allEligibleDeals) {
    if (!deal.customerId) continue;
    const list = eligibleDealsByAccount.get(deal.customerId) ?? [];
    list.push(deal);
    eligibleDealsByAccount.set(deal.customerId, list);
  }
  const selectedDealByAccount = new Map(
    zeroDeals
      .filter((deal): deal is Deal & { customerId: string } => Boolean(deal.customerId))
      .map((deal) => [deal.customerId, deal]),
  );
  const provider = getProvider("stripe");
  if (!provider) throw new Error("Stripe Integration is unavailable");
  let proposed = 0;
  let reviewedCustomers = 0;
  const ambiguousAccountIds = new Set<string>();
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
    const eligibleDeals = eligibleDealsByAccount.get(value.resourceId) ?? [];
    const selectedDeal = selectedDealByAccount.get(value.resourceId);
    if (!selectedDeal || eligibleDeals.length !== 1) {
      if (selectedDeal && eligibleDeals.length > 1) ambiguousAccountIds.add(value.resourceId);
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
          provider.invokeTool("list_invoices", { customerId, status: "paid", limit: 100 }, runtime),
        ])) as [{ data?: StripeSubscription[] }, { data?: StripeInvoice[] }];
        const subscriptions = (subscriptionResult.data ?? [])
          .flatMap((subscription) => {
            const commercial = stripeRecurringValue(subscription);
            return commercial && typeof subscription.id === "string"
              ? [{ subscription, commercial, id: subscription.id }]
              : [];
          })
          .sort((left, right) => {
            const statusRank = (status: unknown) =>
              status === "active" ? 3 : status === "trialing" ? 2 : status === "past_due" ? 1 : 0;
            return (
              statusRank(right.subscription.status) - statusRank(left.subscription.status) ||
              Number(right.subscription.created ?? 0) - Number(left.subscription.created ?? 0) ||
              left.id.localeCompare(right.id)
            );
          });
        const invoices = (invoiceResult.data ?? [])
          .flatMap((invoice) => {
            const amountCents = Number(invoice.amount_paid ?? invoice.total);
            return invoice.status === "paid" &&
              typeof invoice.id === "string" &&
              typeof invoice.currency === "string" &&
              Number.isInteger(amountCents) &&
              amountCents > 0
              ? [{ invoice, amountCents, id: invoice.id }]
              : [];
          })
          .sort(
            (left, right) =>
              Number(right.invoice.created ?? 0) - Number(left.invoice.created ?? 0) ||
              left.id.localeCompare(right.id),
          );
        const recurring = subscriptions[0];
        if (recurring) {
          const result = await createCommercialValueProposalResult(companyId, {
            dealId: selectedDeal.id,
            sourceType: "integration",
            sourceId: recurring.id,
            sourceLabel: `${connection.label} · ${recurring.id}`,
            sourceVerified: true,
            confidence: 98,
            value: recurring.commercial,
            extractedAt:
              typeof recurring.subscription.created === "number"
                ? new Date(recurring.subscription.created * 1_000)
                : new Date(),
            metadata: {
              connectionId: connection.id,
              stripeCustomerId: customerId,
              financeSource: "stripe_subscription",
              alternativeSubscriptions: Math.max(subscriptions.length - 1, 0),
              availablePaidInvoices: invoices.length,
            },
          });
          if (result.created) proposed += 1;
        } else if (invoices[0]) {
          const latestInvoice = invoices[0];
          const result = await createCommercialValueProposalResult(companyId, {
            dealId: selectedDeal.id,
            sourceType: "integration",
            sourceId: latestInvoice.id,
            sourceLabel: `${connection.label} · ${latestInvoice.id}`,
            sourceVerified: true,
            confidence: 98,
            value: {
              amountCents: latestInvoice.amountCents,
              currency: String(latestInvoice.invoice.currency).toUpperCase(),
              revenueType: "one_time",
            },
            extractedAt:
              typeof latestInvoice.invoice.created === "number"
                ? new Date(latestInvoice.invoice.created * 1_000)
                : new Date(),
            metadata: {
              connectionId: connection.id,
              stripeCustomerId: customerId,
              financeSource: "stripe_paid_invoice",
              alternativePaidInvoices: Math.max(invoices.length - 1, 0),
            },
          });
          if (result.created) proposed += 1;
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
  return {
    proposed,
    reviewedCustomers,
    ambiguousAccounts: ambiguousAccountIds.size,
    errors,
  };
}

export type CommercialValueBacklogDisposition =
  | "pending_review"
  | "accepted_zero"
  | "ambiguous_account"
  | "unlinked_account"
  | "finance_candidate"
  | "stripe_candidate"
  | "no_evidence";

export type CommercialValueBacklogProposal = {
  id: string;
  status: RevenueEvidenceStatus;
  sourceType: RevenueEvidenceSourceType;
  sourceId: string;
  sourceLabel: string;
  confidence: number;
  extractedAt: Date;
  value: CommercialValue | null;
  stale: boolean | null;
};

export type CommercialValueBacklogRow = {
  dealId: string;
  title: string;
  accountId: string | null;
  accountName: string | null;
  stageId: string;
  stageName: string | null;
  amountCents: number;
  currency: string;
  updatedAt: Date;
  zeroValueDealsOnAccount: number;
  disposition: CommercialValueBacklogDisposition;
  financeCandidate: {
    sourceKind: "accepted_estimate" | "invoice_payment" | "invoice" | "account_acv";
    sourceId: string;
    sourceLabel: string;
    amountCents: number;
    currency: string;
  } | null;
  stripeCandidate: {
    customerId: string;
    connectedConnections: number;
  } | null;
  proposalCounts: Record<RevenueEvidenceStatus, number>;
  proposals: CommercialValueBacklogProposal[];
};

function parsedCommercialValue(evidence: RevenueFieldEvidence): CommercialValue | null {
  try {
    return validateCommercialValue(JSON.parse(evidence.extractedValueJson) as CommercialValue);
  } catch {
    return null;
  }
}

/**
 * Page the actionable zero-value Deal backlog with enough context to explain
 * why each row can or cannot be proposed automatically.
 */
export async function listCommercialValueBacklog(
  companyId: string,
  opts: {
    dealIds?: string[];
    stageIds?: string[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: CommercialValueBacklogRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const selectedDealIds = [...new Set(opts.dealIds ?? [])];
  const selectedStageIds = [...new Set(opts.stageIds ?? [])];
  if (selectedDealIds.length > 5_000) {
    throw new Error("Commercial-value backlog is limited to 5,000 Deal IDs");
  }
  if (selectedStageIds.length > 500) {
    throw new Error("Commercial-value backlog is limited to 500 Deal Stages");
  }

  const qb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("deal")
    .where("deal.companyId = :companyId", { companyId })
    .andWhere("deal.amountCents = 0")
    .andWhere("deal.status = 'open'")
    .andWhere("deal.archivedAt IS NULL");
  if (opts.dealIds) {
    if (selectedDealIds.length === 0) qb.andWhere("1 = 0");
    else qb.andWhere("deal.id IN (:...dealIds)", { dealIds: selectedDealIds });
  }
  if (opts.stageIds) {
    if (selectedStageIds.length === 0) qb.andWhere("1 = 0");
    else qb.andWhere("deal.stageId IN (:...stageIds)", { stageIds: selectedStageIds });
  }
  const total = await qb.clone().getCount();
  const deals = await qb
    .orderBy("deal.createdAt", "ASC")
    .addOrderBy("deal.id", "ASC")
    .skip(offset)
    .take(limit)
    .getMany();
  if (deals.length === 0) return { rows: [], total, limit, offset };

  const dealIds = deals.map((deal) => deal.id);
  const accountIds = [
    ...new Set(deals.map((deal) => deal.customerId).filter((id): id is string => Boolean(id))),
  ];
  const [accounts, stages, evidence, eligibleAccountDeals, estimates, invoices, stripeField] =
    await Promise.all([
      accountIds.length
        ? AppDataSource.getRepository(Customer).find({
            where: { companyId, id: In(accountIds) },
          })
        : [],
      AppDataSource.getRepository(DealStage).find({ where: { companyId } }),
      AppDataSource.getRepository(RevenueFieldEvidence).find({
        where: {
          companyId,
          resourceType: "deal",
          resourceId: In(dealIds),
          fieldKey: "commercial_value",
        },
        order: { createdAt: "DESC" },
      }),
      accountIds.length
        ? AppDataSource.getRepository(Deal).find({
            where: {
              companyId,
              customerId: In(accountIds),
              amountCents: 0,
              status: "open",
              archivedAt: IsNull(),
            },
          })
        : [],
      accountIds.length
        ? AppDataSource.getRepository(Estimate).find({
            where: {
              companyId,
              customerId: In(accountIds),
              status: "accepted",
            },
            order: { acceptedAt: "DESC", issueDate: "DESC" },
          })
        : [],
      accountIds.length
        ? AppDataSource.getRepository(Invoice).find({
            where: {
              companyId,
              customerId: In(accountIds),
              status: In(["sent", "paid"]),
            },
            order: { issueDate: "DESC" },
          })
        : [],
      AppDataSource.getRepository(RevenueCustomField).findOneBy({
        companyId,
        resourceType: "account",
        key: "stripe_customer_id",
      }),
    ]);
  const [payments, stripeValues, connectedStripeConnections] = await Promise.all([
    invoices.length
      ? AppDataSource.getRepository(InvoicePayment).find({
          where: { invoiceId: In(invoices.map((invoice) => invoice.id)) },
          order: { paidAt: "DESC" },
        })
      : [],
    stripeField && accountIds.length
      ? AppDataSource.getRepository(RevenueCustomValue).find({
          where: {
            companyId,
            fieldId: stripeField.id,
            resourceType: "account",
            resourceId: In(accountIds),
          },
        })
      : [],
    AppDataSource.getRepository(IntegrationConnection).countBy({
      companyId,
      provider: "stripe",
      status: "connected",
    }),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const evidenceByDeal = new Map<string, RevenueFieldEvidence[]>();
  for (const row of evidence) {
    const rows = evidenceByDeal.get(row.resourceId) ?? [];
    rows.push(row);
    evidenceByDeal.set(row.resourceId, rows);
  }
  const eligibleCountByAccount = new Map<string, number>();
  for (const deal of eligibleAccountDeals) {
    if (!deal.customerId) continue;
    eligibleCountByAccount.set(
      deal.customerId,
      (eligibleCountByAccount.get(deal.customerId) ?? 0) + 1,
    );
  }
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const stripeCustomerByAccount = new Map<string, string>();
  for (const value of stripeValues) {
    let customerId = value.searchValue.trim();
    if (!customerId) {
      try {
        const parsed = JSON.parse(value.valueJson) as unknown;
        if (typeof parsed === "string") customerId = parsed.trim();
      } catch {
        customerId = "";
      }
    }
    if (customerId.startsWith("cus_")) stripeCustomerByAccount.set(value.resourceId, customerId);
  }

  const rows = deals.map((deal): CommercialValueBacklogRow => {
    const account = deal.customerId ? accountById.get(deal.customerId) : null;
    const accountDealCount = deal.customerId
      ? (eligibleCountByAccount.get(deal.customerId) ?? 0)
      : 0;
    const acceptedEstimate = estimates.find(
      (estimate) => estimate.customerId === deal.customerId && estimate.totalCents > 0,
    );
    const payment = payments.find(
      (candidate) =>
        invoiceById.get(candidate.invoiceId)?.customerId === deal.customerId &&
        candidate.amountCents > 0,
    );
    const paymentInvoice = payment ? invoiceById.get(payment.invoiceId) : null;
    const invoice = invoices.find(
      (candidate) => candidate.customerId === deal.customerId && candidate.totalCents > 0,
    );
    const financeCandidate = acceptedEstimate
      ? {
          sourceKind: "accepted_estimate" as const,
          sourceId: acceptedEstimate.id,
          sourceLabel: acceptedEstimate.number || acceptedEstimate.slug,
          amountCents: acceptedEstimate.totalCents,
          currency: acceptedEstimate.currency,
        }
      : payment && paymentInvoice && paymentInvoice.totalCents > 0
        ? {
            sourceKind: "invoice_payment" as const,
            sourceId: payment.id,
            sourceLabel: `${paymentInvoice.number || paymentInvoice.slug} payment`,
            amountCents: paymentInvoice.totalCents,
            currency: paymentInvoice.currency,
          }
        : invoice
          ? {
              sourceKind: "invoice" as const,
              sourceId: invoice.id,
              sourceLabel: invoice.number || invoice.slug,
              amountCents: invoice.totalCents,
              currency: invoice.currency,
            }
          : account && account.annualContractValueCents > 0
            ? {
                sourceKind: "account_acv" as const,
                sourceId: account.id,
                sourceLabel: `${account.name} Annual Contract Value`,
                amountCents: account.annualContractValueCents,
                currency: account.currency,
              }
            : null;
    const stripeCustomerId = deal.customerId ? stripeCustomerByAccount.get(deal.customerId) : null;
    const stripeCandidate =
      stripeCustomerId && connectedStripeConnections > 0
        ? {
            customerId: stripeCustomerId,
            connectedConnections: connectedStripeConnections,
          }
        : null;
    const dealEvidence = evidenceByDeal.get(deal.id) ?? [];
    const proposalCounts: Record<RevenueEvidenceStatus, number> = {
      proposed: 0,
      accepted: 0,
      rejected: 0,
      superseded: 0,
    };
    for (const proposal of dealEvidence) proposalCounts[proposal.status] += 1;
    const disposition: CommercialValueBacklogDisposition =
      proposalCounts.proposed > 0
        ? "pending_review"
        : proposalCounts.accepted > 0
          ? "accepted_zero"
          : !deal.customerId
            ? "unlinked_account"
            : accountDealCount > 1
              ? "ambiguous_account"
              : financeCandidate
                ? "finance_candidate"
                : stripeCandidate
                  ? "stripe_candidate"
                  : "no_evidence";
    return {
      dealId: deal.id,
      title: deal.title,
      accountId: deal.customerId,
      accountName: account?.name ?? null,
      stageId: deal.stageId,
      stageName: stageById.get(deal.stageId)?.name ?? null,
      amountCents: deal.amountCents,
      currency: deal.currency,
      updatedAt: deal.updatedAt,
      zeroValueDealsOnAccount: accountDealCount,
      disposition,
      financeCandidate,
      stripeCandidate,
      proposalCounts,
      proposals: dealEvidence.map((proposal) => ({
        id: proposal.id,
        status: proposal.status,
        sourceType: proposal.sourceType,
        sourceId: proposal.sourceId,
        sourceLabel: proposal.sourceLabel,
        confidence: proposal.confidence,
        extractedAt: proposal.extractedAt,
        value: parsedCommercialValue(proposal),
        stale: commercialProposalIsStale(proposal, deal),
      })),
    };
  });
  return { rows, total, limit, offset };
}

export async function listRevenueEvidence(
  companyId: string,
  opts: {
    resourceType?: "account" | "contact" | "deal" | "partnership";
    resourceId?: string;
    fieldKey?: string;
    sourceType?: RevenueEvidenceSourceType;
    /** Internal authorization filter; never accepted directly from an API caller. */
    excludeSourceTypes?: RevenueEvidenceSourceType[];
    /** Internal AI authorization scope; never accepted directly from an API caller. */
    allowedEmailAccountIds?: string[];
    /** Internal AI authorization scope; never accepted directly from an API caller. */
    allowedIntegrationConnectionIds?: string[];
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
  if (opts.resourceId)
    qb.andWhere("evidence.resourceId = :resourceId", { resourceId: opts.resourceId });
  if (opts.fieldKey) qb.andWhere("evidence.fieldKey = :fieldKey", { fieldKey: opts.fieldKey });
  if (opts.sourceType)
    qb.andWhere("evidence.sourceType = :sourceType", { sourceType: opts.sourceType });
  if (opts.excludeSourceTypes?.length) {
    qb.andWhere("evidence.sourceType NOT IN (:...excludeSourceTypes)", {
      excludeSourceTypes: [...new Set(opts.excludeSourceTypes)],
    });
  }
  if (opts.allowedEmailAccountIds !== undefined) {
    const allowedAccountIds = [...new Set(opts.allowedEmailAccountIds)];
    const sourceContact = AppDataSource.getRepository(Contact)
      .createQueryBuilder("sourceContact")
      .select("1")
      .where("sourceContact.companyId = :evidenceContactCompanyId", {
        evidenceContactCompanyId: companyId,
      })
      .andWhere("sourceContact.id = evidence.sourceId");
    const anySourceMessage = AppDataSource.getRepository(MailMessage)
      .createQueryBuilder("anySourceMessage")
      .select("1")
      .where("anySourceMessage.companyId = :anyEvidenceMailCompanyId", {
        anyEvidenceMailCompanyId: companyId,
      })
      .andWhere("anySourceMessage.id = evidence.sourceId");
    const allowedSourceMessage =
      allowedAccountIds.length > 0
        ? AppDataSource.getRepository(MailMessage)
            .createQueryBuilder("allowedSourceMessage")
            .select("1")
            .where("allowedSourceMessage.companyId = :evidenceMailCompanyId", {
              evidenceMailCompanyId: companyId,
            })
            .andWhere("allowedSourceMessage.id = evidence.sourceId")
            .andWhere("allowedSourceMessage.accountId IN (:...allowedEvidenceMailAccountIds)", {
              allowedEvidenceMailAccountIds: allowedAccountIds,
            })
        : null;
    qb.andWhere(
      `(evidence.sourceType <> :emailSourceType OR ` +
        `(EXISTS (${sourceContact.getQuery()}) AND NOT EXISTS (${anySourceMessage.getQuery()}))${
          allowedSourceMessage ? ` OR EXISTS (${allowedSourceMessage.getQuery()})` : ""
        })`,
      {
        emailSourceType: "email",
        ...sourceContact.getParameters(),
        ...anySourceMessage.getParameters(),
        ...(allowedSourceMessage?.getParameters() ?? {}),
      },
    );
  }
  if (opts.allowedIntegrationConnectionIds !== undefined) {
    const allowedConnectionIds = new Set(opts.allowedIntegrationConnectionIds);
    const candidates = await AppDataSource.getRepository(RevenueFieldEvidence).find({
      select: { id: true, metadataJson: true },
      where: { companyId, sourceType: "integration" },
    });
    const allowedEvidenceIds = candidates
      .filter((candidate) => {
        try {
          const metadata = JSON.parse(candidate.metadataJson || "{}") as unknown;
          return (
            metadata !== null &&
            typeof metadata === "object" &&
            !Array.isArray(metadata) &&
            typeof (metadata as Record<string, unknown>).connectionId === "string" &&
            allowedConnectionIds.has((metadata as Record<string, unknown>).connectionId as string)
          );
        } catch {
          return false;
        }
      })
      .map((candidate) => candidate.id);
    if (allowedEvidenceIds.length === 0) {
      qb.andWhere("evidence.sourceType <> :integrationSourceType", {
        integrationSourceType: "integration",
      });
    } else {
      qb.andWhere(
        "(evidence.sourceType <> :integrationSourceType OR evidence.id IN (:...allowedIntegrationEvidenceIds))",
        {
          integrationSourceType: "integration",
          allowedIntegrationEvidenceIds: allowedEvidenceIds,
        },
      );
    }
  }
  if (opts.status) qb.andWhere("evidence.status = :status", { status: opts.status });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("evidence.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows, total };
}

const evidenceReviewQueues = new Map<string, Promise<unknown>>();

function withEvidenceReviewQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = evidenceReviewQueues.get(key);
  const next = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(fn);
  const cleanup = () => {
    if (evidenceReviewQueues.get(key) === tail) evidenceReviewQueues.delete(key);
  };
  const tail = next.then(cleanup, cleanup);
  evidenceReviewQueues.set(key, tail);
  return next;
}

function evidenceReviewQueueKey(evidence: RevenueFieldEvidence): string {
  // better-sqlite3 exposes one synchronous connection. Serializing reviews
  // prevents overlapping TypeORM transactions while the database-level
  // transaction remains the durable boundary.
  if (AppDataSource.options.type !== "postgres") return "sqlite";
  return JSON.stringify([
    evidence.companyId,
    evidence.resourceType,
    evidence.resourceId,
    evidence.fieldKey,
  ]);
}

async function lockEvidenceResource<T extends ObjectLiteral>(
  manager: EntityManager,
  entity: EntityTarget<T>,
  companyId: string,
  resourceId: string,
): Promise<T | null> {
  const query = manager
    .getRepository(entity)
    .createQueryBuilder("resource")
    .where("resource.companyId = :companyId", { companyId })
    .andWhere("resource.id = :resourceId", { resourceId });
  if (AppDataSource.options.type === "postgres") query.setLock("pessimistic_write");
  return query.getOne();
}

export async function reviewRevenueEvidence(
  companyId: string,
  evidenceId: string,
  decision: "accept" | "reject",
  actor: RevenueOperationActor,
  options: { supersedeExisting?: boolean } = {},
): Promise<RevenueFieldEvidence> {
  const candidate = await AppDataSource.getRepository(RevenueFieldEvidence).findOneBy({
    companyId,
    id: evidenceId,
  });
  if (!candidate) throw new Error("Evidence not found");

  return withEvidenceReviewQueue(evidenceReviewQueueKey(candidate), () =>
    AppDataSource.transaction("SERIALIZABLE", async (manager) => {
      const repo = manager.getRepository(RevenueFieldEvidence);
      const proposed = await repo.findOneBy({ companyId, id: evidenceId });
      if (!proposed) throw new Error("Evidence not found");
      if (proposed.status !== "proposed") throw new Error("Evidence has already been reviewed");
      if (
        proposed.resourceType === "deal" &&
        proposed.fieldKey === "commercial_value" &&
        !actor.userId
      ) {
        throw new Error("Commercial-value evidence requires review by a human Member");
      }

      const reviewedAt = new Date();
      const verifyingActorType = actor.userId
        ? "member"
        : actor.employeeId
          ? "ai_employee"
          : "system";
      const verifyingActorId = actor.userId ?? actor.employeeId ?? null;
      const claimed = await repo.update(
        { companyId, id: evidenceId, status: "proposed" },
        {
          status: decision === "accept" ? "accepted" : "rejected",
          verificationState: decision === "accept" ? "verified" : "rejected",
          lastVerifiedAt: decision === "accept" ? reviewedAt : proposed.lastVerifiedAt,
          humanConfirmedAt: actor.userId ? reviewedAt : null,
          humanConfirmedById: actor.userId ?? null,
          verifyingActorType,
          verifyingActorId,
        },
      );
      if (claimed.affected !== 1) {
        throw new Error("Evidence has already been reviewed");
      }
      const evidence = await repo.findOneByOrFail({ companyId, id: evidenceId });
      if (decision === "reject") return evidence;

      let account: Customer | null = null;
      let deal: Deal | null = null;
      let contact: Contact | null = null;
      if (evidence.resourceType === "account") {
        account = await lockEvidenceResource(manager, Customer, companyId, evidence.resourceId);
      } else if (evidence.resourceType === "deal" && evidence.fieldKey === "commercial_value") {
        deal = await lockEvidenceResource(manager, Deal, companyId, evidence.resourceId);
      } else if (evidence.resourceType === "contact" && evidence.fieldKey === "email") {
        contact = await lockEvidenceResource(manager, Contact, companyId, evidence.resourceId);
      }

      const existingAccepted = (
        await repo.find({
          where: {
            companyId,
            resourceType: evidence.resourceType,
            resourceId: evidence.resourceId,
            fieldKey: evidence.fieldKey,
            status: "accepted",
          },
        })
      ).filter((row) => row.id !== evidence.id);
      const supersededEvidence = existingAccepted.filter(
        (row) => row.normalizedValue !== evidence.normalizedValue,
      );
      if (supersededEvidence.length > 0 && !options.supersedeExisting) {
        throw new Error("A verified value already exists; set supersedeExisting to replace it");
      }

      const value = JSON.parse(evidence.extractedValueJson) as unknown;
      if (evidence.resourceType === "account") {
        const accountRepo = manager.getRepository(Customer);
        if (!account) throw new Error("Account not found");
        if (evidence.fieldKey === "domain") {
          if (typeof value !== "string") throw new Error("Domain evidence is malformed");
          const domain = normalizeAccountDomain(value);
          const collision = await accountRepo.findOneBy({
            companyId,
            domain,
            archivedAt: IsNull(),
          });
          if (collision && collision.id !== evidence.resourceId) {
            throw new Error(
              `Domain is already verified on ${collision.name}; review the merge candidate`,
            );
          }
          await accountRepo.update({ companyId, id: evidence.resourceId }, { domain });
        } else if (evidence.fieldKey === "website_url") {
          await accountRepo.update(
            { companyId, id: evidence.resourceId },
            { websiteUrl: reviewedEvidenceText(value, "Website URL", 1_000) },
          );
        } else if (evidence.fieldKey === "industry") {
          await accountRepo.update(
            { companyId, id: evidence.resourceId },
            { industry: reviewedEvidenceText(value, "Industry", 200) },
          );
        } else if (evidence.fieldKey === "employee_count") {
          await accountRepo.update(
            { companyId, id: evidence.resourceId },
            { employeeCount: reviewedEmployeeCount(value) },
          );
        } else if (evidence.fieldKey === "headquarters_address") {
          await accountRepo.update(
            { companyId, id: evidence.resourceId },
            {
              headquartersAddress: reviewedEvidenceText(value, "Headquarters address", 5_000),
            },
          );
        } else if (evidence.fieldKey === "parent_company_name") {
          await accountRepo.update(
            { companyId, id: evidence.resourceId },
            { parentCompanyName: reviewedEvidenceText(value, "Parent company name", 255) },
          );
        } else if (evidence.fieldKey === "parent_company_domain") {
          const parentCompanyDomain = normalizeAccountDomain(
            reviewedEvidenceText(value, "Parent company domain", 255),
          );
          if (!parentCompanyDomain || parentCompanyDomain.length > 255) {
            throw new Error("Parent company domain evidence is malformed");
          }
          await accountRepo.update({ companyId, id: evidence.resourceId }, { parentCompanyDomain });
        } else {
          throw new Error("This evidence field cannot be applied automatically");
        }
      } else if (evidence.resourceType === "deal" && evidence.fieldKey === "commercial_value") {
        const commercial = validateCommercialValue(value as CommercialValue);
        const dealRepo = manager.getRepository(Deal);
        if (!deal) throw new Error("Deal not found");
        if (commercialProposalIsStale(evidence, deal)) {
          throw new Error(
            "Commercial-value proposal is stale because the Deal changed after it was generated",
          );
        }
        const changed =
          deal.amountCents !== commercial.amountCents || deal.currency !== commercial.currency;
        if (changed) {
          await dealRepo.update(
            { companyId, id: evidence.resourceId },
            { amountCents: commercial.amountCents, currency: commercial.currency },
          );
          const historyRepo = manager.getRepository(DealHistoryEvent);
          await historyRepo.save(
            historyRepo.create({
              companyId,
              dealId: deal.id,
              kind: "amount_changed",
              occurredAt: reviewedAt,
              fromStageId: null,
              toStageId: null,
              fromAmountCents: deal.amountCents,
              toAmountCents: commercial.amountCents,
              currency: commercial.currency,
              fromOwnerId: null,
              fromOwnerEmployeeId: null,
              toOwnerId: null,
              toOwnerEmployeeId: null,
              lostReason: "",
              sourceKind: "live",
              sourceKey: liveDealHistoryKey(deal.id, "amount_changed"),
              sourceActivityId: null,
              metadataJson: JSON.stringify({ revenueFieldEvidenceId: evidence.id }),
              createdByUserId: actor.userId ?? null,
              createdByEmployeeId: actor.employeeId ?? null,
            }),
          );
        }
      } else if (evidence.resourceType === "contact" && evidence.fieldKey === "email") {
        if (!contact || typeof value !== "string" || contact.email !== value.toLowerCase()) {
          throw new Error("Contact email evidence no longer matches the Contact");
        }
      } else {
        throw new Error("This evidence field cannot be applied automatically");
      }

      if (supersededEvidence.length > 0) {
        for (const previous of supersededEvidence) {
          previous.status = "superseded";
          previous.verificationState = "superseded";
        }
        await repo.save(supersededEvidence);
      }
      return evidence;
    }),
  );
}
