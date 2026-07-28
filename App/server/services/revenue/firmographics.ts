import { createHash } from "node:crypto";
import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Customer } from "../../db/entities/Customer.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import {
  RevenueFirmographicLookup,
  type RevenueFirmographicLookupStatus,
} from "../../db/entities/RevenueFirmographicLookup.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { getProvider } from "../../integrations/index.js";
import type {
  CompanyFirmographicLookupInput,
  CompanyFirmographicProfile,
  IntegrationProvider,
  IntegrationRuntimeContext,
} from "../../integrations/types.js";
import { decryptConnectionConfig } from "../integrations.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { normalizeAccountDomain } from "./accounts.js";

export const MAX_FIRMOGRAPHIC_ACCOUNTS = 100;
const DEFAULT_REFRESH_OLDER_THAN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;
const FIRMOGRAPHIC_CACHE_VERSION = 1;

type FirmographicLookupIdentity = {
  name: string;
  domain: string;
  website: string;
};

type FirmographicCacheEnvelope = {
  cacheVersion: typeof FIRMOGRAPHIC_CACHE_VERSION;
  lookupIdentity: FirmographicLookupIdentity;
  profile: CompanyFirmographicProfile | null;
};

type ParsedFirmographicCache = {
  lookupIdentity: FirmographicLookupIdentity | null;
  profile: CompanyFirmographicProfile | null;
};

export const FIRMOGRAPHIC_EVIDENCE_FIELD_KEYS = [
  "domain",
  "website_url",
  "industry",
  "employee_count",
  "headquarters_address",
  "parent_company_name",
  "parent_company_domain",
] as const;

export type FirmographicEvidenceFieldKey = (typeof FIRMOGRAPHIC_EVIDENCE_FIELD_KEYS)[number];

export type RevenueFirmographicSelection = {
  connectionId: string;
  accountIds?: string[];
  missingOnly?: boolean;
  refreshOlderThanDays?: number;
  limit?: number;
  /** Ignore a fresh matched/no-match cache entry and call the provider again. */
  force?: boolean;
};

export type RevenueFirmographicPreviewRow = {
  accountId: string;
  accountName: string;
  missingFields: FirmographicEvidenceFieldKey[];
  state: "eligible" | "cached_match" | "cached_not_found" | "complete";
  lastAttemptedAt: Date | null;
};

export type RevenueFirmographicPreview = {
  connection: {
    id: string;
    label: string;
    provider: string;
  };
  selectedAccounts: number;
  unavailableAccounts: number;
  eligibleAccounts: number;
  cachedAccounts: number;
  completeAccounts: number;
  estimatedExternalRequests: number;
  rows: RevenueFirmographicPreviewRow[];
};

export type RevenueFirmographicProposalResult = {
  selectedAccounts: number;
  externalRequests: number;
  matched: number;
  notFound: number;
  cached: number;
  skippedComplete: number;
  failed: number;
  proposedEvidence: number;
  existingEvidence: number;
  errors: Array<{ accountId: string; accountName: string; error: string }>;
};

type PreparedAccount = {
  account: Customer;
  lookup: RevenueFirmographicLookup | null;
  cachedProfile: CompanyFirmographicProfile | null;
  lookupIdentity: FirmographicLookupIdentity;
  cacheIdentityMatches: boolean;
  missingFields: FirmographicEvidenceFieldKey[];
  state: RevenueFirmographicPreviewRow["state"];
};

type PreparedSelection = {
  connection: IntegrationConnection;
  provider: IntegrationProvider;
  rows: PreparedAccount[];
  unavailableAccounts: number;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function cleanAccountIds(accountIds: string[] | undefined): string[] | undefined {
  if (!accountIds) return undefined;
  const ids = [...new Set(accountIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_FIRMOGRAPHIC_ACCOUNTS) {
    throw new Error(`Firmographic enrichment is limited to ${MAX_FIRMOGRAPHIC_ACCOUNTS} Accounts`);
  }
  return ids;
}

function missingFirmographicFields(account: Customer): FirmographicEvidenceFieldKey[] {
  const fields: FirmographicEvidenceFieldKey[] = [];
  if (!account.domain.trim()) fields.push("domain");
  if (!account.websiteUrl.trim()) fields.push("website_url");
  if (!account.industry.trim()) fields.push("industry");
  if (account.employeeCount <= 0) fields.push("employee_count");
  if (!account.headquartersAddress.trim()) fields.push("headquarters_address");
  if (!account.parentCompanyName.trim()) fields.push("parent_company_name");
  if (!account.parentCompanyDomain.trim()) fields.push("parent_company_domain");
  return fields;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function normalizedIdentityName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

function normalizedIdentityWebsite(value: string): string {
  return value.trim().toLowerCase().slice(0, 1_000);
}

function lookupIdentity(
  account: Pick<Customer, "name" | "domain" | "websiteUrl">,
): FirmographicLookupIdentity {
  return {
    name: normalizedIdentityName(account.name),
    domain: normalizeAccountDomain(account.domain).slice(0, 255),
    website: normalizedIdentityWebsite(account.websiteUrl),
  };
}

function parsedLookupIdentity(value: unknown): FirmographicLookupIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.domain !== "string" ||
    typeof candidate.website !== "string"
  ) {
    return null;
  }
  return {
    name: normalizedIdentityName(candidate.name),
    domain: normalizeAccountDomain(candidate.domain).slice(0, 255),
    website: normalizedIdentityWebsite(candidate.website),
  };
}

function identityKey(identity: FirmographicLookupIdentity): string {
  return JSON.stringify(identity);
}

function sameLookupIdentity(
  left: FirmographicLookupIdentity | null,
  right: FirmographicLookupIdentity,
): boolean {
  return left !== null && identityKey(left) === identityKey(right);
}

function observedDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Revalidate the normalized boundary before persisting it. Provider modules
 * are trusted code, but this keeps a future adapter from leaking a raw
 * response or an unbounded value into the reconciliation cache.
 */
function sanitizeProfile(profile: CompanyFirmographicProfile): CompanyFirmographicProfile {
  const providerRecordId = nullableString(profile.providerRecordId, 500);
  if (!providerRecordId) throw new Error("Firmographic provider returned no record ID");
  const employeeCount =
    Number.isInteger(profile.employeeCount) &&
    profile.employeeCount !== null &&
    profile.employeeCount >= 0 &&
    profile.employeeCount <= 2_000_000_000
      ? profile.employeeCount
      : null;
  const parentRecordId = nullableString(profile.parentCompany?.providerRecordId, 500);
  const parentName = nullableString(profile.parentCompany?.name, 255);
  const parentDomain = normalizeAccountDomain(profile.parentCompany?.domain ?? "") || null;
  const parentCompany =
    parentRecordId || parentName || parentDomain
      ? {
          providerRecordId: parentRecordId,
          name: parentName,
          domain: parentDomain,
        }
      : null;
  return {
    providerRecordId,
    name: nullableString(profile.name, 255),
    domain: normalizeAccountDomain(profile.domain ?? "") || null,
    websiteUrl: nullableString(profile.websiteUrl, 1_000),
    industry: nullableString(profile.industry, 200),
    employeeCount,
    headquartersAddress: nullableString(profile.headquartersAddress, 5_000),
    parentCompany,
    confidence: Math.min(Math.max(Math.round(profile.confidence), 0), 100),
    observedAt: observedDate(profile.observedAt).toISOString(),
  };
}

function parseFirmographicCache(lookup: RevenueFirmographicLookup): ParsedFirmographicCache {
  try {
    const parsed = JSON.parse(lookup.normalizedSnapshotJson) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).cacheVersion === FIRMOGRAPHIC_CACHE_VERSION
    ) {
      const envelope = parsed as Partial<FirmographicCacheEnvelope>;
      return {
        lookupIdentity: parsedLookupIdentity(envelope.lookupIdentity),
        profile:
          lookup.status === "matched" && envelope.profile
            ? sanitizeProfile(envelope.profile)
            : null,
      };
    }
    // Legacy rows stored the normalized profile directly and did not retain
    // the Account identity used for the lookup. They are intentionally
    // refreshed once rather than risking reuse after an identity change.
    return {
      lookupIdentity: null,
      profile:
        lookup.status === "matched" ? sanitizeProfile(parsed as CompanyFirmographicProfile) : null,
    };
  } catch {
    return { lookupIdentity: null, profile: null };
  }
}

function serializedFirmographicCache(
  identity: FirmographicLookupIdentity,
  profile: CompanyFirmographicProfile | null,
): string {
  const envelope: FirmographicCacheEnvelope = {
    cacheVersion: FIRMOGRAPHIC_CACHE_VERSION,
    lookupIdentity: identity,
    profile,
  };
  return JSON.stringify(envelope);
}

async function prepareSelection(
  companyId: string,
  selection: RevenueFirmographicSelection,
): Promise<PreparedSelection> {
  const connectionId = selection.connectionId.trim();
  if (!connectionId) throw new Error("Connection is required");
  const limit = boundedInteger(
    selection.limit,
    MAX_FIRMOGRAPHIC_ACCOUNTS,
    1,
    MAX_FIRMOGRAPHIC_ACCOUNTS,
    "limit",
  );
  const refreshOlderThanDays = boundedInteger(
    selection.refreshOlderThanDays,
    DEFAULT_REFRESH_OLDER_THAN_DAYS,
    1,
    3_650,
    "refreshOlderThanDays",
  );
  const accountIds = cleanAccountIds(selection.accountIds);

  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    companyId,
    id: connectionId,
  });
  if (!connection) throw new Error("Firmographics Connection not found in this company");
  if (connection.status !== "connected") {
    throw new Error("The selected firmographics Connection is not connected");
  }
  const provider = getProvider(connection.provider);
  if (!provider?.lookupCompanyFirmographics) {
    throw new Error("The selected Connection does not support company firmographics");
  }

  const qb = AppDataSource.getRepository(Customer)
    .createQueryBuilder("account")
    .where("account.companyId = :companyId", { companyId })
    .andWhere("account.archivedAt IS NULL");
  if (accountIds) {
    if (accountIds.length === 0) {
      return { connection, provider, rows: [], unavailableAccounts: 0 };
    }
    qb.andWhere("account.id IN (:...accountIds)", { accountIds });
  }
  const accounts = await qb
    .orderBy("account.updatedAt", "DESC")
    .addOrderBy("account.id", "ASC")
    .take(limit)
    .getMany();
  const lookups =
    accounts.length > 0
      ? await AppDataSource.getRepository(RevenueFirmographicLookup).find({
          where: {
            companyId,
            connectionId,
            customerId: In(accounts.map((account) => account.id)),
          },
        })
      : [];
  const byAccount = new Map(lookups.map((lookup) => [lookup.customerId, lookup]));
  const freshAfter = Date.now() - refreshOlderThanDays * DAY_MS;
  const missingOnly = selection.missingOnly ?? true;
  const rows = accounts.map((account): PreparedAccount => {
    const missingFields = missingFirmographicFields(account);
    const lookup = byAccount.get(account.id) ?? null;
    const accountLookupIdentity = lookupIdentity(account);
    const cache = lookup ? parseFirmographicCache(lookup) : { lookupIdentity: null, profile: null };
    const cacheIdentityMatches =
      lookup !== null &&
      lookup.provider === connection.provider &&
      sameLookupIdentity(cache.lookupIdentity, accountLookupIdentity);
    const cachedProfile = cacheIdentityMatches ? cache.profile : null;
    const fresh =
      !selection.force &&
      lookup !== null &&
      cacheIdentityMatches &&
      lookup.status !== "failed" &&
      lookup.lastAttemptedAt.getTime() >= freshAfter &&
      (lookup.status === "not_found" || cachedProfile !== null);
    const state: PreparedAccount["state"] =
      missingOnly && missingFields.length === 0
        ? "complete"
        : fresh && lookup?.status === "matched"
          ? "cached_match"
          : fresh && lookup?.status === "not_found"
            ? "cached_not_found"
            : "eligible";
    return {
      account,
      lookup,
      cachedProfile,
      lookupIdentity: accountLookupIdentity,
      cacheIdentityMatches,
      missingFields,
      state,
    };
  });
  return {
    connection,
    provider,
    rows,
    unavailableAccounts: accountIds ? Math.max(accountIds.length - accounts.length, 0) : 0,
  };
}

export async function previewRevenueFirmographics(
  companyId: string,
  selection: RevenueFirmographicSelection,
): Promise<RevenueFirmographicPreview> {
  const prepared = await prepareSelection(companyId, selection);
  const eligibleAccounts = prepared.rows.filter((row) => row.state === "eligible").length;
  const cachedAccounts = prepared.rows.filter((row) => row.state.startsWith("cached_")).length;
  const completeAccounts = prepared.rows.filter((row) => row.state === "complete").length;
  return {
    connection: {
      id: prepared.connection.id,
      label: prepared.connection.label,
      provider: prepared.connection.provider,
    },
    selectedAccounts: prepared.rows.length,
    unavailableAccounts: prepared.unavailableAccounts,
    eligibleAccounts,
    cachedAccounts,
    completeAccounts,
    estimatedExternalRequests: eligibleAccounts,
    rows: prepared.rows.map((row) => ({
      accountId: row.account.id,
      accountName: row.account.name,
      missingFields: row.missingFields,
      state: row.state,
      lastAttemptedAt: row.lookup?.lastAttemptedAt ?? null,
    })),
  };
}

async function saveLookup(
  companyId: string,
  connection: IntegrationConnection,
  account: Customer,
  patch: {
    status: RevenueFirmographicLookupStatus;
    attemptedAt: Date;
    lookupIdentity: FirmographicLookupIdentity;
    profile?: CompanyFirmographicProfile;
    error?: string;
  },
): Promise<RevenueFirmographicLookup> {
  const repo = AppDataSource.getRepository(RevenueFirmographicLookup);
  let lookup = await repo.findOneBy({
    companyId,
    customerId: account.id,
    connectionId: connection.id,
  });
  if (!lookup) {
    lookup = repo.create({
      companyId,
      customerId: account.id,
      connectionId: connection.id,
      provider: connection.provider,
      providerRecordId: "",
      status: patch.status,
      normalizedSnapshotJson: "{}",
      confidence: 0,
      lastAttemptedAt: patch.attemptedAt,
      lastMatchedAt: null,
      observedAt: null,
      lastError: "",
    });
  }
  const existingCache = parseFirmographicCache(lookup);
  const canRetainPriorMatch =
    lookup.provider === connection.provider &&
    sameLookupIdentity(existingCache.lookupIdentity, patch.lookupIdentity);
  lookup.provider = connection.provider;
  lookup.status = patch.status;
  lookup.lastAttemptedAt = patch.attemptedAt;
  lookup.lastError = (patch.error ?? "").slice(0, 2_000);
  if (patch.profile) {
    lookup.providerRecordId = patch.profile.providerRecordId;
    lookup.normalizedSnapshotJson = serializedFirmographicCache(
      patch.lookupIdentity,
      patch.profile,
    );
    lookup.confidence = patch.profile.confidence;
    lookup.lastMatchedAt = patch.attemptedAt;
    lookup.observedAt = observedDate(patch.profile.observedAt);
  } else if (patch.status === "not_found" || !canRetainPriorMatch) {
    lookup.providerRecordId = "";
    lookup.normalizedSnapshotJson = serializedFirmographicCache(patch.lookupIdentity, null);
    lookup.confidence = 0;
    lookup.lastMatchedAt = null;
    lookup.observedAt = null;
  }
  return repo.save(lookup);
}

function evidenceValues(
  profile: CompanyFirmographicProfile,
): Array<{ fieldKey: FirmographicEvidenceFieldKey; value: string | number }> {
  const values: Array<{ fieldKey: FirmographicEvidenceFieldKey; value: string | number }> = [];
  if (profile.domain) values.push({ fieldKey: "domain", value: profile.domain });
  if (profile.websiteUrl) values.push({ fieldKey: "website_url", value: profile.websiteUrl });
  if (profile.industry) values.push({ fieldKey: "industry", value: profile.industry });
  // Customer.employeeCount uses zero as "unknown", so a zero-valued provider
  // result cannot improve the Account and is retained only in the snapshot.
  if (profile.employeeCount !== null && profile.employeeCount > 0) {
    values.push({ fieldKey: "employee_count", value: profile.employeeCount });
  }
  if (profile.headquartersAddress) {
    values.push({ fieldKey: "headquarters_address", value: profile.headquartersAddress });
  }
  if (profile.parentCompany?.name) {
    values.push({ fieldKey: "parent_company_name", value: profile.parentCompany.name });
  }
  if (profile.parentCompany?.domain) {
    values.push({ fieldKey: "parent_company_domain", value: profile.parentCompany.domain });
  }
  return values;
}

function normalizedEvidenceValue(
  fieldKey: FirmographicEvidenceFieldKey,
  value: string | number,
): string {
  if (fieldKey === "domain" || fieldKey === "parent_company_domain") {
    return normalizeAccountDomain(String(value)).slice(0, 255);
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

async function proposeProfileEvidence(
  companyId: string,
  connection: IntegrationConnection,
  account: Customer,
  lookup: RevenueFirmographicLookup,
  profile: CompanyFirmographicProfile,
): Promise<{ created: number; existing: number }> {
  const repo = AppDataSource.getRepository(RevenueFieldEvidence);
  let created = 0;
  let existing = 0;
  for (const candidate of evidenceValues(profile)) {
    const normalizedValue = normalizedEvidenceValue(candidate.fieldKey, candidate.value);
    if (!normalizedValue) continue;
    const sourceId = profile.providerRecordId;
    const prior = await repo.findOneBy({
      companyId,
      resourceType: "account",
      resourceId: account.id,
      fieldKey: candidate.fieldKey,
      sourceType: "integration",
      sourceId,
      normalizedValue,
    });
    if (prior) {
      existing += 1;
      continue;
    }
    const extractedAt = observedDate(profile.observedAt);
    await repo.save(
      repo.create({
        companyId,
        resourceType: "account",
        resourceId: account.id,
        fieldKey: candidate.fieldKey,
        sourceType: "integration",
        sourceId,
        sourceLabel: `${connection.label} · ${profile.name ?? account.name}`.slice(0, 255),
        extractedValueJson: JSON.stringify(candidate.value),
        normalizedValue,
        confidence: profile.confidence,
        status: "proposed",
        verificationState: "unverified",
        extractionMethod: "integration_firmographic_lookup",
        observedAt: extractedAt,
        extractedAt,
        lastVerifiedAt: null,
        humanConfirmedAt: null,
        humanConfirmedById: null,
        verifyingActorType: null,
        verifyingActorId: null,
        metadataJson: JSON.stringify({
          connectionId: connection.id,
          provider: connection.provider,
          providerRecordId: profile.providerRecordId,
          firmographicLookupId: lookup.id,
        }),
      }),
    );
    created += 1;
  }
  return { created, existing };
}

function lookupInput(row: PreparedAccount): CompanyFirmographicLookupInput {
  return {
    providerRecordId:
      row.cacheIdentityMatches && row.lookup?.providerRecordId
        ? row.lookup.providerRecordId
        : undefined,
    name: row.account.name,
    domain: row.account.domain || undefined,
    website: row.account.websiteUrl || undefined,
  };
}

type FirmographicAccountLookupOutcome = {
  lookupIdentityKey: string;
  status: "matched" | "not_found" | "failed" | "identity_changed" | "in_progress";
  externalRequest: boolean;
  evidenceCreated: number;
  evidenceExisting: number;
  error?: string;
};

type FirmographicLookupInFlight = {
  lookupIdentityKey: string;
  promise: Promise<FirmographicAccountLookupOutcome>;
};

const firmographicLookupsInFlight = new Map<string, FirmographicLookupInFlight>();
const COMPLETED_LOOKUP_DEDUPLICATION_MS = 1_000;
const DISTRIBUTED_LOOKUP_LEASE_MS = 5 * 60_000;
const DISTRIBUTED_LOOKUP_POLL_ATTEMPTS = 25;
const DISTRIBUTED_LOOKUP_POLL_MS = 200;

function lookupCoordinationKey(companyId: string, connectionId: string, accountId: string): string {
  return JSON.stringify([companyId, connectionId, accountId]);
}

function distributedLookupLeaseName(
  companyId: string,
  connectionId: string,
  accountId: string,
): string {
  const digest = createHash("sha256")
    .update(lookupCoordinationKey(companyId, connectionId, accountId))
    .digest("hex");
  return `revenue-firmographics:${digest}`;
}

function lookupStateSignature(lookup: RevenueFirmographicLookup | null): string {
  if (!lookup) return "";
  return JSON.stringify({
    provider: lookup.provider,
    providerRecordId: lookup.providerRecordId,
    status: lookup.status,
    normalizedSnapshotJson: lookup.normalizedSnapshotJson,
    lastAttemptedAt: lookup.lastAttemptedAt.toISOString(),
    lastError: lookup.lastError,
    updatedAt: lookup.updatedAt.toISOString(),
  });
}

function distributedCacheOutcome(
  lookup: RevenueFirmographicLookup,
  connection: IntegrationConnection,
  identity: FirmographicLookupIdentity,
): FirmographicAccountLookupOutcome | null {
  const cache = parseFirmographicCache(lookup);
  if (
    lookup.provider !== connection.provider ||
    !sameLookupIdentity(cache.lookupIdentity, identity)
  ) {
    return null;
  }
  const lookupIdentityKey = identityKey(identity);
  if (lookup.status === "matched" && cache.profile) {
    return {
      lookupIdentityKey,
      status: "matched",
      externalRequest: false,
      evidenceCreated: 0,
      evidenceExisting: 0,
    };
  }
  if (lookup.status === "not_found") {
    return {
      lookupIdentityKey,
      status: "not_found",
      externalRequest: false,
      evidenceCreated: 0,
      evidenceExisting: 0,
    };
  }
  if (lookup.status === "failed") {
    return {
      lookupIdentityKey,
      status: "failed",
      externalRequest: false,
      evidenceCreated: 0,
      evidenceExisting: 0,
      error: lookup.lastError || "Firmographic lookup failed in another app instance",
    };
  }
  return null;
}

async function changedDistributedCacheOutcome(
  companyId: string,
  connection: IntegrationConnection,
  row: PreparedAccount,
  initialSignature: string,
): Promise<FirmographicAccountLookupOutcome | null> {
  const current = await AppDataSource.getRepository(RevenueFirmographicLookup).findOneBy({
    companyId,
    customerId: row.account.id,
    connectionId: connection.id,
  });
  if (!current || lookupStateSignature(current) === initialSignature) return null;
  return distributedCacheOutcome(current, connection, row.lookupIdentity);
}

function waitBriefly(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function accountIdentityIsCurrent(companyId: string, row: PreparedAccount): Promise<boolean> {
  const current = await AppDataSource.getRepository(Customer).findOneBy({
    companyId,
    id: row.account.id,
  });
  return (
    current !== null &&
    current.archivedAt === null &&
    sameLookupIdentity(lookupIdentity(current), row.lookupIdentity)
  );
}

async function performFirmographicLookup(
  companyId: string,
  connection: IntegrationConnection,
  lookup: NonNullable<IntegrationProvider["lookupCompanyFirmographics"]>,
  runtime: IntegrationRuntimeContext,
  row: PreparedAccount,
): Promise<FirmographicAccountLookupOutcome> {
  const attemptedAt = new Date();
  const lookupIdentityKey = identityKey(row.lookupIdentity);
  try {
    const found = await lookup(lookupInput(row), runtime);
    if (!(await accountIdentityIsCurrent(companyId, row))) {
      return {
        lookupIdentityKey,
        status: "identity_changed",
        externalRequest: true,
        evidenceCreated: 0,
        evidenceExisting: 0,
        error: "Account identity changed during the firmographic lookup; retry with current data",
      };
    }
    if (!found) {
      await saveLookup(companyId, connection, row.account, {
        status: "not_found",
        attemptedAt,
        lookupIdentity: row.lookupIdentity,
      });
      return {
        lookupIdentityKey,
        status: "not_found",
        externalRequest: true,
        evidenceCreated: 0,
        evidenceExisting: 0,
      };
    }
    const profile = sanitizeProfile(found);
    const savedLookup = await saveLookup(companyId, connection, row.account, {
      status: "matched",
      attemptedAt,
      lookupIdentity: row.lookupIdentity,
      profile,
    });
    const evidence = await proposeProfileEvidence(
      companyId,
      connection,
      row.account,
      savedLookup,
      profile,
    );
    return {
      lookupIdentityKey,
      status: "matched",
      externalRequest: true,
      evidenceCreated: evidence.created,
      evidenceExisting: evidence.existing,
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    try {
      await saveLookup(companyId, connection, row.account, {
        status: "failed",
        attemptedAt,
        lookupIdentity: row.lookupIdentity,
        error: message,
      });
    } catch (cacheError) {
      const cacheMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
      message = `${message}; failed to save lookup state: ${cacheMessage}`;
    }
    return {
      lookupIdentityKey,
      status: "failed",
      externalRequest: true,
      evidenceCreated: 0,
      evidenceExisting: 0,
      error: message,
    };
  }
}

async function performFirmographicLookupWithLease(
  companyId: string,
  connection: IntegrationConnection,
  lookup: NonNullable<IntegrationProvider["lookupCompanyFirmographics"]>,
  runtime: IntegrationRuntimeContext,
  row: PreparedAccount,
): Promise<FirmographicAccountLookupOutcome> {
  const initialSignature = lookupStateSignature(row.lookup);
  const leaseName = distributedLookupLeaseName(companyId, connection.id, row.account.id);
  const leased = await withSchedulerLease(leaseName, DISTRIBUTED_LOOKUP_LEASE_MS, async () => {
    // A second replica can prepare while the first is calling the provider,
    // then acquire the lease immediately after that call finishes. Re-read
    // inside the lease so that hand-off consumes the new cache, not a second
    // provider credit.
    const completed = await changedDistributedCacheOutcome(
      companyId,
      connection,
      row,
      initialSignature,
    );
    if (completed) return completed;
    if (!(await accountIdentityIsCurrent(companyId, row))) {
      return {
        lookupIdentityKey: identityKey(row.lookupIdentity),
        status: "identity_changed" as const,
        externalRequest: false,
        evidenceCreated: 0,
        evidenceExisting: 0,
        error: "Account identity changed before the firmographic lookup; retry with current data",
      };
    }
    return performFirmographicLookup(companyId, connection, lookup, runtime, row);
  });
  if (leased) return leased;

  // Another Postgres-backed app instance owns the billable boundary. Give a
  // quick response a chance to land in the shared cache; otherwise return a
  // retryable result without making another external request.
  for (let attempt = 0; attempt < DISTRIBUTED_LOOKUP_POLL_ATTEMPTS; attempt += 1) {
    await waitBriefly(DISTRIBUTED_LOOKUP_POLL_MS);
    const completed = await changedDistributedCacheOutcome(
      companyId,
      connection,
      row,
      initialSignature,
    );
    if (completed) return completed;
  }
  return {
    lookupIdentityKey: identityKey(row.lookupIdentity),
    status: "in_progress",
    externalRequest: false,
    evidenceCreated: 0,
    evidenceExisting: 0,
    error: "A firmographic lookup is already in progress; retry after it finishes",
  };
}

async function coordinatedFirmographicLookup(
  companyId: string,
  connection: IntegrationConnection,
  lookup: NonNullable<IntegrationProvider["lookupCompanyFirmographics"]>,
  runtime: IntegrationRuntimeContext,
  row: PreparedAccount,
): Promise<{ initiated: boolean; outcome: FirmographicAccountLookupOutcome }> {
  const coordinationKey = lookupCoordinationKey(companyId, connection.id, row.account.id);
  const requestedIdentityKey = identityKey(row.lookupIdentity);
  const existing = firmographicLookupsInFlight.get(coordinationKey);
  if (existing) {
    if (existing.lookupIdentityKey !== requestedIdentityKey) {
      await existing.promise;
      if (firmographicLookupsInFlight.get(coordinationKey) === existing) {
        firmographicLookupsInFlight.delete(coordinationKey);
      }
      return coordinatedFirmographicLookup(companyId, connection, lookup, runtime, row);
    }
    return { initiated: false, outcome: await existing.promise };
  }

  const entry: FirmographicLookupInFlight = {
    lookupIdentityKey: requestedIdentityKey,
    promise: performFirmographicLookupWithLease(companyId, connection, lookup, runtime, row),
  };
  firmographicLookupsInFlight.set(coordinationKey, entry);
  const outcome = await entry.promise;
  const timer = setTimeout(() => {
    if (firmographicLookupsInFlight.get(coordinationKey) === entry) {
      firmographicLookupsInFlight.delete(coordinationKey);
    }
  }, COMPLETED_LOOKUP_DEDUPLICATION_MS);
  timer.unref();
  return { initiated: outcome.externalRequest, outcome };
}

export async function proposeRevenueFirmographics(
  companyId: string,
  selection: RevenueFirmographicSelection,
): Promise<RevenueFirmographicProposalResult> {
  const prepared = await prepareSelection(companyId, selection);
  const result: RevenueFirmographicProposalResult = {
    selectedAccounts: prepared.rows.length,
    externalRequests: 0,
    matched: 0,
    notFound: 0,
    cached: 0,
    skippedComplete: 0,
    failed: 0,
    proposedEvidence: 0,
    existingEvidence: 0,
    errors: [],
  };
  const lookup = prepared.provider.lookupCompanyFirmographics!;
  const runtime = {
    authMode: prepared.connection.authMode,
    config: decryptConnectionConfig(prepared.connection),
    connectionId: prepared.connection.id,
    companyId,
  };

  for (const row of prepared.rows) {
    if (row.state === "complete") {
      result.skippedComplete += 1;
      continue;
    }
    if (row.state === "cached_match" && row.lookup && row.cachedProfile) {
      result.cached += 1;
      const evidence = await proposeProfileEvidence(
        companyId,
        prepared.connection,
        row.account,
        row.lookup,
        row.cachedProfile,
      );
      result.proposedEvidence += evidence.created;
      result.existingEvidence += evidence.existing;
      continue;
    }
    if (row.state === "cached_not_found") {
      result.cached += 1;
      continue;
    }

    const coordinated = await coordinatedFirmographicLookup(
      companyId,
      prepared.connection,
      lookup,
      runtime,
      row,
    );
    if (coordinated.initiated) result.externalRequests += 1;
    if (
      !coordinated.initiated &&
      (coordinated.outcome.status === "matched" || coordinated.outcome.status === "not_found")
    ) {
      result.cached += 1;
      if (coordinated.outcome.status === "matched") {
        result.existingEvidence +=
          coordinated.outcome.evidenceCreated + coordinated.outcome.evidenceExisting;
      }
      continue;
    }
    if (coordinated.outcome.status === "matched") {
      result.matched += 1;
      result.proposedEvidence += coordinated.outcome.evidenceCreated;
      result.existingEvidence += coordinated.outcome.evidenceExisting;
    } else if (coordinated.outcome.status === "not_found") {
      result.notFound += 1;
    } else {
      result.failed += 1;
      result.errors.push({
        accountId: row.account.id,
        accountName: row.account.name,
        error: coordinated.outcome.error ?? "Firmographic lookup failed",
      });
    }
  }
  return result;
}

export async function listRevenueFirmographicLookups(
  companyId: string,
  options: {
    connectionId?: string;
    customerId?: string;
    status?: RevenueFirmographicLookupStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueFirmographicLookup[]; total: number }> {
  const limit = boundedInteger(options.limit, 100, 1, 500, "limit");
  const offset = boundedInteger(options.offset, 0, 0, 1_000_000_000, "offset");
  const qb = AppDataSource.getRepository(RevenueFirmographicLookup)
    .createQueryBuilder("lookup")
    .where("lookup.companyId = :companyId", { companyId });
  if (options.connectionId) {
    qb.andWhere("lookup.connectionId = :connectionId", {
      connectionId: options.connectionId,
    });
  }
  if (options.customerId) {
    qb.andWhere("lookup.customerId = :customerId", { customerId: options.customerId });
  }
  if (options.status) qb.andWhere("lookup.status = :status", { status: options.status });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("lookup.lastAttemptedAt", "DESC")
    .addOrderBy("lookup.id", "ASC")
    .skip(offset)
    .take(limit)
    .getMany();
  return { rows, total };
}
