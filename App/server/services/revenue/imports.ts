import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { In, IsNull, type EntityManager } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Base } from "../../db/entities/Base.js";
import { BaseField } from "../../db/entities/BaseField.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseRecordAttachment } from "../../db/entities/BaseRecordAttachment.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { Contact } from "../../db/entities/Contact.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerContact } from "../../db/entities/CustomerContact.js";
import { CustomerContract } from "../../db/entities/CustomerContract.js";
import { CustomerCredit } from "../../db/entities/CustomerCredit.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RecurringInvoice } from "../../db/entities/RecurringInvoice.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import {
  RevenueCustomField,
  type RevenueResourceType,
} from "../../db/entities/RevenueCustomField.js";
import { RevenueDocument, type RevenueDocumentKind } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueFirmographicLookup } from "../../db/entities/RevenueFirmographicLookup.js";
import {
  RevenueImportBatch,
  type RevenueImportSourceKind,
} from "../../db/entities/RevenueImportBatch.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { SignalEvent } from "../../db/entities/SignalEvent.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { toSlug } from "../../lib/slug.js";
import { resolveBaseAttachmentFile } from "../baseRecordUploads.js";
import { recordAttachmentBytes } from "../uploads.js";
import { normalizeAccountDomain } from "./accounts.js";
import {
  assertClassification,
  classificationValue,
  listRevenueClassifications,
} from "./classifications.js";
import { listCustomFields, type CustomFieldValue } from "./customFields.js";
import { createRevenueDocument, listRevenueDocuments } from "./documents.js";
import { listDealStages } from "./stages.js";

export type ImportRow = {
  sourceId: string;
  values: Record<string, unknown>;
};

export type ImportMapping = Record<string, string>;

export type ImportDecision = {
  sourceId: string;
  action: "create" | "duplicate" | "skip";
  nativeId: string | null;
  reason: string | null;
  preview: Record<string, unknown>;
};

export type ImportReport = {
  resourceType: RevenueResourceType;
  total: number;
  createCount: number;
  duplicateCount: number;
  skippedCount: number;
  decisions: ImportDecision[];
};

export type LinkedImportResource = "account" | "contact" | "deal";
export type LinkedImportMapping = Record<LinkedImportResource, ImportMapping>;
export type LinkedImportDecision = {
  sourceId: string;
  action: "create" | "duplicate" | "skip";
  reason: string | null;
  resources: Record<LinkedImportResource, ImportDecision>;
};
export type LinkedImportReport = {
  resourceType: "account_contact_deal";
  total: number;
  createCount: number;
  duplicateCount: number;
  skippedCount: number;
  resourceCounts: Record<LinkedImportResource, { create: number; duplicate: number; skip: number }>;
  decisions: LinkedImportDecision[];
};

type ImportActor = { userId?: string | null; employeeId?: string | null };

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertImportRowIdentity(rows: ImportRow[]): void {
  if (rows.length > 10_000) throw new Error("Revenue imports are limited to 10,000 rows");
  const seen = new Set<string>();
  for (const row of rows) {
    const sourceId = row.sourceId.trim();
    if (!sourceId) throw new Error("Every Revenue import row needs a source ID");
    if (sourceId !== row.sourceId) {
      throw new Error(`Revenue import source ID "${row.sourceId}" has surrounding whitespace`);
    }
    if (sourceId.length > 500 || hasControlCharacters(sourceId)) {
      throw new Error("Revenue import source IDs must be at most 500 safe text characters");
    }
    if (seen.has(sourceId)) {
      throw new Error(`Revenue import source ID "${sourceId}" appears more than once`);
    }
    seen.add(sourceId);
  }
}

type ImportProvenanceContext = {
  sourceKind: RevenueImportSourceKind;
  sourceLabel: string;
  sourceBaseId?: string | null;
  sourceTableId?: string | null;
  sourceConnectionId?: string | null;
};

function importExtractionMethod(sourceKind: RevenueImportSourceKind): string {
  if (sourceKind === "base") return "base_field_mapping";
  if (sourceKind === "csv") return "csv_column_mapping";
  if (sourceKind === "json") return "json_field_mapping";
  return "connection_field_mapping";
}

function importEvidenceSourceId(
  batchId: string,
  sourceRowId: string,
  resourceType: RevenueResourceType,
): string {
  return `import:${batchId}:${sourceRowId}:${resourceType}`;
}

function importEvidenceMetadata(
  batchId: string,
  sourceRowId: string,
  resourceType: RevenueResourceType,
  input: ImportProvenanceContext,
): Record<string, unknown> {
  return {
    importBatchId: batchId,
    importSourceRowId: sourceRowId,
    importedResourceType: resourceType,
    sourceKind: input.sourceKind,
    sourceBaseId: input.sourceBaseId ?? null,
    sourceTableId: input.sourceTableId ?? null,
    sourceConnectionId: input.sourceConnectionId ?? null,
  };
}

function importVerifyingActor(actor: ImportActor): {
  kind: "member" | "ai_employee" | "system";
  id: string | null;
} {
  if (actor.userId) return { kind: "member", id: actor.userId };
  if (actor.employeeId) return { kind: "ai_employee", id: actor.employeeId };
  return { kind: "system", id: null };
}

function mapped(row: ImportRow, mapping: ImportMapping, key: string): unknown {
  const sourceKey = mapping[key];
  return sourceKey ? row.values[sourceKey] : undefined;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  return String(value).trim();
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(asText(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function asDate(value: unknown): Date | null {
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const LEGACY_DEAL_STAGE_ALIASES = new Map([
  ["lead", "new"],
  ["demo_scheduled", "demo"],
  ["proposal_sent", "proposal"],
]);

function resolveImportedDealStage(raw: string, stages: DealStage[]): DealStage | null {
  const normalized = classificationValue(raw);
  const target = LEGACY_DEAL_STAGE_ALIASES.get(normalized) ?? normalized;
  return (
    stages.find(
      (stage) =>
        classificationValue(stage.name) === target || classificationValue(stage.slug) === target,
    ) ?? null
  );
}

type BaseSelectOption = { id: string; label: string };

function baseSelectOptions(field: BaseField): Map<string, string> {
  if (field.type !== "select" && field.type !== "multiselect") return new Map();
  try {
    const config = JSON.parse(field.configJson || "{}") as { options?: unknown };
    if (!Array.isArray(config.options)) return new Map();
    return new Map(
      config.options
        .filter(
          (option): option is BaseSelectOption =>
            !!option &&
            typeof option === "object" &&
            typeof (option as BaseSelectOption).id === "string" &&
            typeof (option as BaseSelectOption).label === "string",
        )
        .map((option) => [option.id, option.label]),
    );
  } catch {
    return new Map();
  }
}

function resolveBaseSelectValue(
  field: BaseField,
  options: Map<string, string>,
  value: unknown,
): unknown {
  if (field.type === "select" && typeof value === "string") {
    return options.get(value) ?? value;
  }
  if (field.type === "multiselect" && Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? (options.get(item) ?? item) : item));
  }
  return value;
}

function customImportValue(
  field: RevenueCustomField,
  raw: unknown,
): { value: CustomFieldValue; error: string | null } {
  const text = asText(raw);
  if (!text) {
    return {
      value: null,
      error: field.required ? `${field.name} is required` : null,
    };
  }
  let options: string[] = [];
  try {
    const parsed = JSON.parse(field.optionsJson);
    options = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    options = [];
  }
  if (field.fieldType === "number") {
    const value = Number(text.replaceAll(",", ""));
    return Number.isFinite(value)
      ? { value, error: null }
      : { value: null, error: `${field.name} must be a number` };
  }
  if (field.fieldType === "boolean") {
    const normalized = text.toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return { value: true, error: null };
    if (["false", "no", "0"].includes(normalized)) return { value: false, error: null };
    return { value: null, error: `${field.name} must be yes or no` };
  }
  if (field.fieldType === "multi_select") {
    const values = Array.isArray(raw)
      ? raw.map(asText).filter(Boolean)
      : text
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
    const unknown = options.length ? values.find((value) => !options.includes(value)) : null;
    return unknown
      ? { value: null, error: `${field.name} contains unknown option ${unknown}` }
      : { value: values, error: null };
  }
  if (field.fieldType === "select" && options.length && !options.includes(text)) {
    return { value: null, error: `${field.name} contains unknown option ${text}` };
  }
  if (field.fieldType === "date" && Number.isNaN(new Date(text).getTime())) {
    return { value: null, error: `${field.name} must be a date` };
  }
  if (field.fieldType === "url") {
    try {
      new URL(text);
    } catch {
      return { value: null, error: `${field.name} must be a URL` };
    }
  }
  return { value: text, error: null };
}

function previewFor(
  resourceType: RevenueResourceType,
  row: ImportRow,
  mapping: ImportMapping,
): Record<string, unknown> {
  if (resourceType === "contact") {
    return {
      name: asText(mapped(row, mapping, "name")),
      email: asText(mapped(row, mapping, "email")).toLowerCase(),
      phone: asText(mapped(row, mapping, "phone")),
      title: asText(mapped(row, mapping, "title")),
      companyName: asText(mapped(row, mapping, "companyName")),
      source: asText(mapped(row, mapping, "source")),
      notes: asText(mapped(row, mapping, "notes")),
    };
  }
  if (resourceType === "account") {
    return {
      name: asText(mapped(row, mapping, "name")),
      domain: normalizeAccountDomain(asText(mapped(row, mapping, "domain"))),
      websiteUrl: asText(mapped(row, mapping, "websiteUrl")),
      industry: asText(mapped(row, mapping, "industry")),
      employeeCount: Math.max(0, Math.round(asNumber(mapped(row, mapping, "employeeCount")))),
      notes: asText(mapped(row, mapping, "notes")),
    };
  }
  if (resourceType === "deal") {
    return {
      title: asText(mapped(row, mapping, "title")),
      description: asText(mapped(row, mapping, "description")),
      amountCents: Math.max(0, Math.round(asNumber(mapped(row, mapping, "amountCents")))),
      currency: asText(mapped(row, mapping, "currency")).toUpperCase() || "USD",
      stage: asText(mapped(row, mapping, "stage")),
      source: asText(mapped(row, mapping, "source")),
      nextStep: asText(mapped(row, mapping, "nextStep")),
      nextFollowUpAt: asDate(mapped(row, mapping, "nextFollowUpAt")),
      expectedCloseDate: asDate(mapped(row, mapping, "expectedCloseDate")),
    };
  }
  return {
    name: asText(mapped(row, mapping, "name")),
    type: asText(mapped(row, mapping, "type")) || "other",
    status: asText(mapped(row, mapping, "status")) || "prospecting",
    websiteUrl: asText(mapped(row, mapping, "websiteUrl")),
    integrationContext: asText(mapped(row, mapping, "integrationContext")),
    channelContext: asText(mapped(row, mapping, "channelContext")),
    notes: asText(mapped(row, mapping, "notes")),
    nextFollowUpAt: asDate(mapped(row, mapping, "nextFollowUpAt")),
  };
}

async function duplicateFor(
  companyId: string,
  resourceType: RevenueResourceType,
  preview: Record<string, unknown>,
): Promise<{ id: string; reason: string } | null> {
  if (resourceType === "contact") {
    const email = asText(preview.email);
    if (!email) return null;
    const row = await AppDataSource.getRepository(Contact).findOneBy({ companyId, email });
    return row ? { id: row.id, reason: `Email already belongs to ${row.name}` } : null;
  }
  if (resourceType === "account") {
    const domain = asText(preview.domain);
    if (domain) {
      const row = await AppDataSource.getRepository(Customer).findOneBy({ companyId, domain });
      if (row) return { id: row.id, reason: `Domain already belongs to ${row.name}` };
    }
    const name = asText(preview.name).toLowerCase();
    const row = await AppDataSource.getRepository(Customer)
      .createQueryBuilder("a")
      .where("a.companyId = :companyId", { companyId })
      .andWhere("LOWER(a.name) = :name", { name })
      .getOne();
    return row ? { id: row.id, reason: `Account name already exists` } : null;
  }
  const nameKey = resourceType === "deal" ? "title" : "name";
  const name = asText(preview[nameKey]).toLowerCase();
  if (!name) return null;
  const entity = resourceType === "deal" ? Deal : Partnership;
  const alias = resourceType === "deal" ? "d" : "p";
  const row = await AppDataSource.getRepository(entity)
    .createQueryBuilder(alias)
    .where(`${alias}.companyId = :companyId`, { companyId })
    .andWhere(`LOWER(${alias}.${nameKey}) = :name`, { name })
    .getOne();
  return row ? { id: row.id, reason: `${resourceType} name already exists` } : null;
}

export async function previewRevenueImport(
  companyId: string,
  resourceType: RevenueResourceType,
  mapping: ImportMapping,
  rows: ImportRow[],
): Promise<ImportReport> {
  assertImportRowIdentity(rows);
  const decisions: ImportDecision[] = [];
  const customFields = await listCustomFields(companyId, resourceType);
  const dealStages = resourceType === "deal" ? await listDealStages(companyId) : [];
  const dealSources =
    resourceType === "deal" ? await listRevenueClassifications(companyId, "deal_source") : [];
  for (const row of rows.slice(0, 10_000)) {
    const preview = previewFor(resourceType, row, mapping);
    const required = asText(preview[resourceType === "deal" ? "title" : "name"]);
    if (!required) {
      decisions.push({
        sourceId: row.sourceId,
        action: "skip",
        nativeId: null,
        reason: `${resourceType === "deal" ? "Title" : "Name"} is required`,
        preview,
      });
      continue;
    }
    const customValues: Record<string, CustomFieldValue> = {};
    let validationError: string | null = null;
    for (const field of customFields) {
      const sourceKey = mapping[`custom:${field.key}`];
      const parsed = customImportValue(field, sourceKey ? row.values[sourceKey] : undefined);
      if (parsed.error) {
        validationError = parsed.error;
        break;
      }
      if (sourceKey || field.required) customValues[field.key] = parsed.value;
    }
    preview.customValues = customValues;
    if (resourceType === "deal") {
      const importedStage = asText(preview.stage);
      const stage = importedStage
        ? resolveImportedDealStage(importedStage, dealStages)
        : (dealStages.find((candidate) => candidate.kind === "open") ?? dealStages[0] ?? null);
      if (!stage) {
        validationError = importedStage
          ? `Unknown Deal Stage: ${importedStage}`
          : "The company has no Deal Stage";
      } else {
        preview.stageId = stage.id;
        preview.stage = stage.name;
      }

      const importedSource = asText(preview.source);
      if (importedSource) {
        const normalizedSource = classificationValue(importedSource);
        const source =
          dealSources.find((candidate) => candidate.value === normalizedSource) ??
          dealSources.find(
            (candidate) => classificationValue(candidate.label) === normalizedSource,
          );
        if (!source) {
          validationError ??= `Unknown deal source classification: ${importedSource}`;
        } else {
          preview.source = source.value;
          preview.sourceLabel = source.label;
        }
      } else {
        preview.source = "";
        preview.sourceLabel = "";
      }
    }
    try {
      if (resourceType === "partnership" && preview.type) {
        await assertClassification(companyId, "partnership_type", asText(preview.type));
      }
      if (resourceType === "partnership" && preview.status) {
        await assertClassification(companyId, "partnership_status", asText(preview.status));
      }
    } catch (error) {
      validationError = error instanceof Error ? error.message : "Invalid classification";
    }
    if (validationError) {
      decisions.push({
        sourceId: row.sourceId,
        action: "skip",
        nativeId: null,
        reason: validationError,
        preview,
      });
      continue;
    }
    const duplicate = await duplicateFor(companyId, resourceType, preview);
    decisions.push({
      sourceId: row.sourceId,
      action: duplicate ? "duplicate" : "create",
      nativeId: duplicate?.id ?? null,
      reason: duplicate?.reason ?? null,
      preview,
    });
  }
  return {
    resourceType,
    total: decisions.length,
    createCount: decisions.filter((row) => row.action === "create").length,
    duplicateCount: decisions.filter((row) => row.action === "duplicate").length,
    skippedCount: decisions.filter((row) => row.action === "skip").length,
    decisions,
  };
}

export async function previewLinkedRevenueImport(
  companyId: string,
  mapping: LinkedImportMapping,
  rows: ImportRow[],
): Promise<LinkedImportReport> {
  const [accounts, contacts, deals, customFields] = await Promise.all([
    previewRevenueImport(companyId, "account", mapping.account, rows),
    previewRevenueImport(companyId, "contact", mapping.contact, rows),
    previewRevenueImport(companyId, "deal", mapping.deal, rows),
    listCustomFields(companyId),
  ]);
  const fieldsWithSourceId = new Set(
    customFields
      .filter((field) => field.key === "original_base_row_id")
      .map((field) => field.resourceType),
  );
  const byResource = {
    account: new Map(accounts.decisions.map((decision) => [decision.sourceId, decision])),
    contact: new Map(contacts.decisions.map((decision) => [decision.sourceId, decision])),
    deal: new Map(deals.decisions.map((decision) => [decision.sourceId, decision])),
  };
  const decisions: LinkedImportDecision[] = rows.slice(0, 10_000).map((row) => {
    const resources = {
      account: byResource.account.get(row.sourceId)!,
      contact: byResource.contact.get(row.sourceId)!,
      deal: byResource.deal.get(row.sourceId)!,
    };
    for (const resourceType of ["account", "contact", "deal"] as const) {
      if (!fieldsWithSourceId.has(resourceType)) continue;
      const customValues =
        resources[resourceType].preview.customValues &&
        typeof resources[resourceType].preview.customValues === "object" &&
        !Array.isArray(resources[resourceType].preview.customValues)
          ? (resources[resourceType].preview.customValues as Record<string, CustomFieldValue>)
          : {};
      resources[resourceType].preview.customValues = {
        ...customValues,
        original_base_row_id: row.sourceId,
      };
    }
    const skipped = (Object.values(resources) as ImportDecision[]).find(
      (decision) => decision.action === "skip",
    );
    const allDuplicate = (Object.values(resources) as ImportDecision[]).every(
      (decision) => decision.action === "duplicate",
    );
    return {
      sourceId: row.sourceId,
      action: skipped ? "skip" : allDuplicate ? "duplicate" : "create",
      reason: skipped?.reason ?? null,
      resources,
    };
  });
  const [matchedContacts, matchedDeals] = await Promise.all([
    AppDataSource.getRepository(Contact).find({
      where: {
        companyId,
        id: In(
          decisions
            .map((decision) => decision.resources.contact.nativeId)
            .filter((id): id is string => !!id),
        ),
      },
    }),
    AppDataSource.getRepository(Deal).find({
      where: {
        companyId,
        id: In(
          decisions
            .map((decision) => decision.resources.deal.nativeId)
            .filter((id): id is string => !!id),
        ),
      },
    }),
  ]);
  const contactsById = new Map(matchedContacts.map((contact) => [contact.id, contact]));
  const dealsById = new Map(matchedDeals.map((deal) => [deal.id, deal]));
  for (const decision of decisions) {
    if (decision.action === "skip") continue;
    const accountId = decision.resources.account.nativeId;
    const contactId = decision.resources.contact.nativeId;
    const matchedContact = contactId ? contactsById.get(contactId) : null;
    if (matchedContact?.customerId && (!accountId || matchedContact.customerId !== accountId)) {
      decision.action = "skip";
      decision.reason = "Matched Contact already belongs to a different Account";
      continue;
    }
    const dealId = decision.resources.deal.nativeId;
    const matchedDeal = dealId ? dealsById.get(dealId) : null;
    if (matchedDeal?.customerId && (!accountId || matchedDeal.customerId !== accountId)) {
      decision.action = "skip";
      decision.reason = "Matched Deal already belongs to a different Account";
      continue;
    }
    if (
      matchedDeal?.primaryContactId &&
      (!contactId || matchedDeal.primaryContactId !== contactId)
    ) {
      decision.action = "skip";
      decision.reason = "Matched Deal already belongs to a different primary Contact";
    }
  }
  const seenAccounts = new Set<string>();
  const seenContacts = new Map<string, string>();
  const seenDeals = new Map<string, { accountKey: string; contactKey: string }>();
  for (const decision of decisions) {
    if (decision.action === "skip") continue;
    const accountPreview = decision.resources.account.preview;
    const contactPreview = decision.resources.contact.preview;
    const dealPreview = decision.resources.deal.preview;
    const accountKey =
      normalizeAccountDomain(asText(accountPreview.domain)) ||
      asText(accountPreview.name).toLowerCase();
    const contactKey = normalizeEmail(asText(contactPreview.email)) ?? "";
    const dealKey = asText(dealPreview.title).toLowerCase();

    if (decision.resources.account.action === "create") {
      if (seenAccounts.has(accountKey)) {
        decision.resources.account.action = "duplicate";
        decision.resources.account.reason = "Matches another source row in this import";
      } else {
        seenAccounts.add(accountKey);
      }
    }
    if (contactKey && decision.resources.contact.action === "create") {
      const priorAccountKey = seenContacts.get(contactKey);
      if (priorAccountKey && priorAccountKey !== accountKey) {
        decision.action = "skip";
        decision.reason = "The same Contact email is mapped to different Accounts in this import";
      } else if (priorAccountKey) {
        decision.resources.contact.action = "duplicate";
        decision.resources.contact.reason = "Matches another source row in this import";
      } else {
        seenContacts.set(contactKey, accountKey);
      }
    }
    if (decision.action === "skip") continue;
    if (decision.resources.deal.action === "create") {
      const priorLinks = seenDeals.get(dealKey);
      if (
        priorLinks &&
        (priorLinks.accountKey !== accountKey || priorLinks.contactKey !== contactKey)
      ) {
        decision.action = "skip";
        decision.reason =
          "The same Deal title is mapped to different Account or Contact links in this import";
      } else if (priorLinks) {
        decision.resources.deal.action = "duplicate";
        decision.resources.deal.reason = "Matches another source row in this import";
      } else {
        seenDeals.set(dealKey, { accountKey, contactKey });
      }
    }
    if (decision.action !== "skip") {
      decision.action = Object.values(decision.resources).every(
        (resource) => resource.action === "duplicate",
      )
        ? "duplicate"
        : "create";
    }
  }
  for (const decision of decisions) {
    if (decision.action !== "skip") continue;
    for (const resource of Object.values(decision.resources)) {
      if (resource.action !== "create") continue;
      resource.action = "skip";
      resource.reason = decision.reason ?? "The linked source row was skipped";
    }
  }
  const resourceCounts = Object.fromEntries(
    (["account", "contact", "deal"] as const).map((resourceType) => {
      const resourceDecisions = decisions.map((decision) => decision.resources[resourceType]);
      return [
        resourceType,
        {
          create: resourceDecisions.filter((decision) => decision.action === "create").length,
          duplicate: resourceDecisions.filter((decision) => decision.action === "duplicate").length,
          skip: resourceDecisions.filter((decision) => decision.action === "skip").length,
        },
      ];
    }),
  ) as LinkedImportReport["resourceCounts"];
  return {
    resourceType: "account_contact_deal",
    total: decisions.length,
    createCount: decisions.filter((decision) => decision.action === "create").length,
    duplicateCount: decisions.filter((decision) => decision.action === "duplicate").length,
    skippedCount: decisions.filter((decision) => decision.action === "skip").length,
    resourceCounts,
    decisions,
  };
}

export async function loadBaseImportRows(
  companyId: string,
  baseId: string,
  tableId: string,
): Promise<{ sourceLabel: string; fields: BaseField[]; rows: ImportRow[] }> {
  const base = await AppDataSource.getRepository(Base).findOneBy({ companyId, id: baseId });
  const table = await AppDataSource.getRepository(BaseTable).findOneBy({ baseId, id: tableId });
  if (!base || !table) throw new Error("Base table not found");
  const [fields, records] = await Promise.all([
    AppDataSource.getRepository(BaseField).find({
      where: { tableId },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(BaseRecord).find({
      where: { tableId },
      order: { sortOrder: "ASC" },
    }),
  ]);
  const selectOptions = new Map(fields.map((field) => [field.id, baseSelectOptions(field)]));
  return {
    sourceLabel: `${base.name} / ${table.name}`,
    fields,
    rows: records.map((record) => {
      let values: Record<string, unknown> = {};
      try {
        values = JSON.parse(record.dataJson) as Record<string, unknown>;
      } catch {
        values = {};
      }
      for (const field of fields) {
        if (!Object.hasOwn(values, field.id)) continue;
        values[field.id] = resolveBaseSelectValue(
          field,
          selectOptions.get(field.id) ?? new Map(),
          values[field.id],
        );
      }
      return { sourceId: record.id, values };
    }),
  };
}

async function createImportedResource(
  manager: EntityManager,
  companyId: string,
  resourceType: RevenueResourceType,
  preview: Record<string, unknown>,
  actor: ImportActor,
  provenance: { batchId: string; sourceRowId: string },
): Promise<string> {
  if (resourceType === "contact") {
    const email = normalizeEmail(asText(preview.email)) ?? "";
    if (email && (await manager.findOneBy(Contact, { companyId, email }))) {
      throw new Error(`A contact with the address ${email} already exists`);
    }
    return (
      await manager.save(
        manager.create(Contact, {
          companyId,
          name: asText(preview.name),
          email,
          phone: asText(preview.phone),
          title: asText(preview.title),
          linkedinUrl: "",
          websiteUrl: "",
          customerId: null,
          companyName: asText(preview.companyName),
          lifecycleStage: "lead",
          ownerId: null,
          ownerEmployeeId: null,
          source: asText(preview.source),
          sourceDetail: "",
          score: 0,
          enrichedJson: null,
          notes: asText(preview.notes),
          doNotContact: false,
          unsubscribedAt: null,
          bouncedAt: null,
          lastActivityAt: null,
          archivedAt: null,
          createdById: actor.userId ?? null,
          createdByEmployeeId: actor.employeeId ?? null,
        }),
      )
    ).id;
  }
  if (resourceType === "account") {
    const domain = normalizeAccountDomain(asText(preview.domain));
    if (
      domain &&
      (await manager.findOneBy(Customer, {
        companyId,
        domain,
        archivedAt: IsNull(),
      }))
    ) {
      throw new Error("An account with that domain already exists");
    }
    return (
      await manager.save(
        manager.create(Customer, {
          companyId,
          name: asText(preview.name),
          slug: await uniqueImportedAccountSlug(manager, companyId, asText(preview.name)),
          email: "",
          phone: "",
          accountStatus: "prospect",
          domain,
          websiteUrl: asText(preview.websiteUrl),
          industry: asText(preview.industry),
          employeeCount: Math.max(0, Math.round(asNumber(preview.employeeCount))),
          ownerId: null,
          ownerEmployeeId: null,
          billingAddress: "",
          shippingAddress: "",
          taxNumber: "",
          currency: "USD",
          annualContractValueCents: 0,
          notes: asText(preview.notes),
          archivedAt: null,
          createdById: actor.userId ?? null,
        }),
      )
    ).id;
  }
  if (resourceType === "deal") {
    const stage = await manager.findOneBy(DealStage, {
      companyId,
      id: asText(preview.stageId),
    });
    if (!stage) throw new Error("Resolved Deal Stage is no longer available");
    return (
      await createImportedDeal(manager, companyId, null, null, stage, preview, actor, provenance)
    ).id;
  }
  return (
    await manager.save(
      manager.create(Partnership, {
        companyId,
        name: asText(preview.name),
        type: classificationValue(asText(preview.type)) || "other",
        status: classificationValue(asText(preview.status)) || "prospecting",
        customerId: null,
        websiteUrl: asText(preview.websiteUrl),
        integrationContext: asText(preview.integrationContext),
        channelContext: asText(preview.channelContext),
        notes: asText(preview.notes),
        ownerId: null,
        ownerEmployeeId: null,
        nextFollowUpAt: preview.nextFollowUpAt instanceof Date ? preview.nextFollowUpAt : null,
        reminderAt: null,
        lastActivityAt: null,
        archivedAt: null,
        createdById: actor.userId ?? null,
        createdByEmployeeId: actor.employeeId ?? null,
      }),
    )
  ).id;
}

export async function commitRevenueImport(
  companyId: string,
  input: {
    resourceType: RevenueResourceType;
    sourceKind: RevenueImportSourceKind;
    sourceLabel: string;
    sourceBaseId?: string | null;
    sourceTableId?: string | null;
    sourceConnectionId?: string | null;
    mapping: ImportMapping;
    rows: ImportRow[];
  },
  actor: ImportActor,
): Promise<RevenueImportBatch> {
  const report = await previewRevenueImport(
    companyId,
    input.resourceType,
    input.mapping,
    input.rows,
  );
  const customFields = await listCustomFields(companyId, input.resourceType);
  const batchId = randomUUID();
  const createdIds: string[] = [];
  return AppDataSource.transaction(async (manager) => {
    for (const decision of report.decisions) {
      if (decision.action !== "create") continue;
      try {
        const id = await manager.transaction(async (rowManager) => {
          const resourceId = await createImportedResource(
            rowManager,
            companyId,
            input.resourceType,
            decision.preview,
            actor,
            { batchId, sourceRowId: decision.sourceId },
          );
          await saveImportedCustomValues(
            rowManager,
            companyId,
            input.resourceType,
            resourceId,
            decision.preview,
            customFields,
            {
              batchId,
              sourceRowId: decision.sourceId,
              input,
              actor,
            },
          );
          return resourceId;
        });
        decision.nativeId = id;
        createdIds.push(id);
      } catch (error) {
        decision.action = "skip";
        decision.reason = error instanceof Error ? error.message : "Import failed";
      }
    }
    report.createCount = createdIds.length;
    report.skippedCount = report.decisions.filter((row) => row.action === "skip").length;
    const rowMap = report.decisions.map(({ sourceId, nativeId, action, reason }) => ({
      sourceId,
      nativeId,
      action,
      reason,
    }));
    const repo = manager.getRepository(RevenueImportBatch);
    const batch = await repo.save(
      repo.create({
        id: batchId,
        companyId,
        resourceType: input.resourceType,
        sourceKind: input.sourceKind,
        sourceLabel: input.sourceLabel,
        sourceBaseId: input.sourceBaseId ?? null,
        sourceTableId: input.sourceTableId ?? null,
        sourceConnectionId: input.sourceConnectionId ?? null,
        status: "completed",
        mappingJson: JSON.stringify(input.mapping),
        rowMapJson: JSON.stringify(rowMap),
        createdIdsJson: JSON.stringify(createdIds),
        reportJson: JSON.stringify(report),
        rolledBackAt: null,
        createdByUserId: actor.userId ?? null,
        createdByEmployeeId: actor.employeeId ?? null,
      }),
    );
    const importRows = report.decisions.map((decision, sortOrder) =>
      manager.create(RevenueImportRow, {
        companyId,
        batchId: batch.id,
        resourceType: input.resourceType,
        sourceId: decision.sourceId,
        nativeId: decision.nativeId,
        action: decision.action,
        status:
          decision.action === "create"
            ? "created"
            : decision.action === "duplicate"
              ? "matched"
              : "skipped",
        reason: decision.reason ?? "",
        decisionJson: JSON.stringify(decision),
        sortOrder,
      }),
    );
    if (importRows.length > 0) {
      await manager.save(RevenueImportRow, importRows, { chunk: 500 });
    }
    return batch;
  });
}

type LinkedCreatedIds = Record<LinkedImportResource, string[]>;

function customSearchValue(value: CustomFieldValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => item.trim().toLowerCase())
      .sort()
      .join("|");
  }
  return String(value).trim().toLowerCase();
}

async function saveImportedCustomValues(
  manager: EntityManager,
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
  preview: Record<string, unknown>,
  fields: RevenueCustomField[],
  provenance: {
    batchId: string;
    sourceRowId: string;
    input: ImportProvenanceContext;
    actor: ImportActor;
  },
): Promise<void> {
  const values =
    preview.customValues &&
    typeof preview.customValues === "object" &&
    !Array.isArray(preview.customValues)
      ? (preview.customValues as Record<string, CustomFieldValue>)
      : {};
  const byKey = new Map(
    fields
      .filter((field) => field.resourceType === resourceType && !field.archivedAt)
      .map((field) => [field.key, field]),
  );
  const verifyingActor = importVerifyingActor(provenance.actor);
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field || value === null) continue;
    await manager.save(
      manager.create(RevenueCustomValue, {
        companyId,
        fieldId: field.id,
        resourceType,
        resourceId,
        valueJson: JSON.stringify(value),
        searchValue: customSearchValue(value),
      }),
    );
    const observedAt = new Date();
    await manager.save(
      RevenueFieldEvidence,
      manager.create(RevenueFieldEvidence, {
        companyId,
        resourceType,
        resourceId,
        fieldKey: `custom:${field.key}`,
        sourceType: "import",
        sourceId: importEvidenceSourceId(provenance.batchId, provenance.sourceRowId, resourceType),
        sourceLabel: `${provenance.input.sourceLabel} / ${provenance.sourceRowId}`,
        extractedValueJson: JSON.stringify(value),
        normalizedValue: customSearchValue(value),
        confidence: 100,
        status: "accepted",
        verificationState: "verified",
        extractionMethod: importExtractionMethod(provenance.input.sourceKind),
        observedAt,
        extractedAt: observedAt,
        lastVerifiedAt: observedAt,
        humanConfirmedAt: provenance.actor.userId ? observedAt : null,
        humanConfirmedById: provenance.actor.userId ?? null,
        verifyingActorType: verifyingActor.kind,
        verifyingActorId: verifyingActor.id,
        metadataJson: JSON.stringify({
          extractionMethod: importExtractionMethod(provenance.input.sourceKind),
          verificationState: "verified",
          verifyingActor,
          ...importEvidenceMetadata(
            provenance.batchId,
            provenance.sourceRowId,
            resourceType,
            provenance.input,
          ),
        }),
      }),
    );
  }
}

async function uniqueImportedAccountSlug(
  manager: EntityManager,
  companyId: string,
  name: string,
): Promise<string> {
  const root = toSlug(name) || "account";
  let slug = root;
  let suffix = 1;
  for (;;) {
    if (!(await manager.findOneBy(Customer, { companyId, slug }))) return slug;
    suffix += 1;
    slug = `${root}-${suffix}`;
  }
}

async function existingImportedResource(
  manager: EntityManager,
  companyId: string,
  resourceType: LinkedImportResource,
  preview: Record<string, unknown>,
): Promise<string | null> {
  if (resourceType === "account") {
    const domain = normalizeAccountDomain(asText(preview.domain));
    if (domain) {
      const byDomain = await manager.findOneBy(Customer, {
        companyId,
        domain,
        archivedAt: IsNull(),
      });
      if (byDomain) return byDomain.id;
    }
    const name = asText(preview.name).toLowerCase();
    const byName = await manager
      .createQueryBuilder(Customer, "account")
      .where("account.companyId = :companyId", { companyId })
      .andWhere("LOWER(account.name) = :name", { name })
      .getOne();
    return byName?.id ?? null;
  }
  if (resourceType === "contact") {
    const email = normalizeEmail(asText(preview.email));
    if (!email) return null;
    return (await manager.findOneBy(Contact, { companyId, email }))?.id ?? null;
  }
  const title = asText(preview.title).toLowerCase();
  return (
    (
      await manager
        .createQueryBuilder(Deal, "deal")
        .where("deal.companyId = :companyId", { companyId })
        .andWhere("LOWER(deal.title) = :title", { title })
        .getOne()
    )?.id ?? null
  );
}

async function createLinkedAccount(
  manager: EntityManager,
  companyId: string,
  preview: Record<string, unknown>,
  actor: ImportActor,
): Promise<Customer> {
  const name = asText(preview.name);
  return manager.save(
    manager.create(Customer, {
      companyId,
      name,
      slug: await uniqueImportedAccountSlug(manager, companyId, name),
      email: "",
      phone: "",
      accountStatus: "prospect",
      domain: normalizeAccountDomain(asText(preview.domain)),
      websiteUrl: asText(preview.websiteUrl),
      industry: asText(preview.industry),
      employeeCount: Math.max(0, Math.round(asNumber(preview.employeeCount))),
      ownerId: null,
      ownerEmployeeId: null,
      billingAddress: "",
      shippingAddress: "",
      taxNumber: "",
      currency: "USD",
      annualContractValueCents: 0,
      notes: asText(preview.notes),
      archivedAt: null,
      createdById: actor.userId ?? null,
    }),
  );
}

async function createLinkedContact(
  manager: EntityManager,
  companyId: string,
  account: Customer,
  preview: Record<string, unknown>,
  actor: ImportActor,
): Promise<Contact> {
  return manager.save(
    manager.create(Contact, {
      companyId,
      name: asText(preview.name),
      email: normalizeEmail(asText(preview.email)) ?? "",
      phone: asText(preview.phone),
      title: asText(preview.title),
      linkedinUrl: "",
      websiteUrl: "",
      customerId: account.id,
      companyName: asText(preview.companyName) || account.name,
      lifecycleStage: "lead",
      ownerId: null,
      ownerEmployeeId: null,
      source: asText(preview.source),
      sourceDetail: "",
      score: 0,
      enrichedJson: null,
      notes: asText(preview.notes),
      doNotContact: false,
      unsubscribedAt: null,
      bouncedAt: null,
      lastActivityAt: null,
      archivedAt: null,
      createdById: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
}

async function createImportedDeal(
  manager: EntityManager,
  companyId: string,
  account: Customer | null,
  contact: Contact | null,
  stage: DealStage,
  preview: Record<string, unknown>,
  actor: ImportActor,
  provenance: { batchId: string; sourceRowId: string },
): Promise<Deal> {
  const now = new Date();
  const status = stage.kind;
  const deal = await manager.save(
    manager.create(Deal, {
      companyId,
      title: asText(preview.title),
      description: asText(preview.description),
      customerId: account?.id ?? null,
      primaryContactId: contact?.id ?? null,
      stageId: stage.id,
      amountCents: Math.min(2_000_000_000, Math.max(0, Math.round(asNumber(preview.amountCents)))),
      currency: asText(preview.currency).toUpperCase() || "USD",
      probabilityOverride: null,
      expectedCloseDate:
        preview.expectedCloseDate instanceof Date ? preview.expectedCloseDate : null,
      status,
      closedAt: status === "open" ? null : now,
      lostReason: "",
      source: classificationValue(asText(preview.source)),
      ownerId: null,
      ownerEmployeeId: null,
      nextStep: asText(preview.nextStep),
      nextFollowUpAt: preview.nextFollowUpAt instanceof Date ? preview.nextFollowUpAt : null,
      followUpReminderAt: null,
      lastActivityAt: now,
      archivedAt: null,
      createdById: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
  const activity = await manager.save(
    manager.create(Activity, {
      companyId,
      kind: "deal_created",
      subject: deal.title,
      bodyText: "",
      occurredAt: now,
      contactId: contact?.id ?? null,
      dealId: deal.id,
      customerId: account?.id ?? null,
      partnershipId: null,
      mailThreadId: null,
      mailMessageId: null,
      actorUserId: actor.userId ?? null,
      actorEmployeeId: actor.employeeId ?? null,
      metaJson: JSON.stringify({
        stage: stage.name,
        amountCents: deal.amountCents,
        currency: deal.currency,
        revenueImport: provenance,
      }),
      taskStatus: null,
      dueAt: null,
      completedAt: null,
      assignedUserId: null,
      assignedEmployeeId: null,
      priority: null,
      reminderAt: null,
      recurrenceRule: null,
    }),
  );
  const historyMetadata = { revenueImport: provenance };
  await manager.save(
    manager.create(DealHistoryEvent, {
      companyId,
      dealId: deal.id,
      kind: "created",
      occurredAt: now,
      fromStageId: null,
      toStageId: stage.id,
      fromAmountCents: null,
      toAmountCents: deal.amountCents,
      currency: deal.currency,
      fromOwnerId: null,
      fromOwnerEmployeeId: null,
      toOwnerId: null,
      toOwnerEmployeeId: null,
      lostReason: "",
      sourceKind: "live",
      sourceKey: `activity:${activity.id}`,
      sourceActivityId: activity.id,
      metadataJson: JSON.stringify(historyMetadata),
      createdByUserId: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
  if (status === "won" || status === "lost") {
    await manager.save(
      manager.create(DealHistoryEvent, {
        companyId,
        dealId: deal.id,
        kind: status,
        occurredAt: now,
        fromStageId: null,
        toStageId: stage.id,
        fromAmountCents: null,
        toAmountCents: null,
        currency: "",
        fromOwnerId: null,
        fromOwnerEmployeeId: null,
        toOwnerId: null,
        toOwnerEmployeeId: null,
        lostReason: deal.lostReason,
        sourceKind: "live",
        sourceKey: `live:${deal.id}:${status}:${randomUUID()}`,
        sourceActivityId: null,
        metadataJson: JSON.stringify(historyMetadata),
        createdByUserId: actor.userId ?? null,
        createdByEmployeeId: actor.employeeId ?? null,
      }),
    );
  }
  if (contact) {
    contact.lastActivityAt = now;
    await manager.save(contact);
  }
  return deal;
}

export async function commitLinkedRevenueImport(
  companyId: string,
  input: {
    sourceKind: RevenueImportSourceKind;
    sourceLabel: string;
    sourceBaseId?: string | null;
    sourceTableId?: string | null;
    sourceConnectionId?: string | null;
    mapping: LinkedImportMapping;
    rows: ImportRow[];
  },
  actor: ImportActor,
): Promise<RevenueImportBatch> {
  const report = await previewLinkedRevenueImport(companyId, input.mapping, input.rows);
  const stages = await listDealStages(companyId);
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  const customFields = await listCustomFields(companyId);
  const createdIds: LinkedCreatedIds = { account: [], contact: [], deal: [] };
  const batchId = randomUUID();

  return AppDataSource.transaction(async (manager) => {
    for (const decision of report.decisions) {
      if (decision.action === "skip") continue;
      const accountDecision = decision.resources.account;
      let accountId =
        accountDecision.nativeId &&
        (await manager.findOneBy(Customer, { companyId, id: accountDecision.nativeId }))
          ? accountDecision.nativeId
          : await existingImportedResource(manager, companyId, "account", accountDecision.preview);
      if (!accountId) {
        const account = await createLinkedAccount(
          manager,
          companyId,
          accountDecision.preview,
          actor,
        );
        accountId = account.id;
        createdIds.account.push(account.id);
        accountDecision.action = "create";
        await saveImportedCustomValues(
          manager,
          companyId,
          "account",
          account.id,
          accountDecision.preview,
          customFields,
          {
            batchId,
            sourceRowId: decision.sourceId,
            input,
            actor,
          },
        );
      } else if (accountDecision.action === "create") {
        accountDecision.action = "duplicate";
        accountDecision.reason = "Matched another row in this atomic import";
      }
      accountDecision.nativeId = accountId;
      const account = (await manager.findOneBy(Customer, {
        companyId,
        id: accountId,
      }))!;

      const contactDecision = decision.resources.contact;
      let contactId =
        contactDecision.nativeId &&
        (await manager.findOneBy(Contact, { companyId, id: contactDecision.nativeId }))
          ? contactDecision.nativeId
          : await existingImportedResource(manager, companyId, "contact", contactDecision.preview);
      if (!contactId) {
        const contact = await createLinkedContact(
          manager,
          companyId,
          account,
          contactDecision.preview,
          actor,
        );
        contactId = contact.id;
        createdIds.contact.push(contact.id);
        contactDecision.action = "create";
        await saveImportedCustomValues(
          manager,
          companyId,
          "contact",
          contact.id,
          contactDecision.preview,
          customFields,
          {
            batchId,
            sourceRowId: decision.sourceId,
            input,
            actor,
          },
        );
      } else if (contactDecision.action === "create") {
        contactDecision.action = "duplicate";
        contactDecision.reason = "Matched another row in this atomic import";
      }
      contactDecision.nativeId = contactId;
      const contact = (await manager.findOneBy(Contact, {
        companyId,
        id: contactId,
      }))!;
      if (contact.customerId && contact.customerId !== account.id) {
        throw new Error(`Contact ${contact.id} was linked to a different Account during import`);
      }
      if (!contact.customerId) {
        contact.customerId = account.id;
        await manager.save(contact);
      }

      const dealDecision = decision.resources.deal;
      const stage = stagesById.get(asText(dealDecision.preview.stageId));
      if (!stage) {
        throw new Error(`Resolved Deal Stage is no longer available for ${decision.sourceId}`);
      }
      let dealId =
        dealDecision.nativeId &&
        (await manager.findOneBy(Deal, { companyId, id: dealDecision.nativeId }))
          ? dealDecision.nativeId
          : await existingImportedResource(manager, companyId, "deal", dealDecision.preview);
      if (!dealId) {
        const deal = await createImportedDeal(
          manager,
          companyId,
          account,
          contact,
          stage,
          dealDecision.preview,
          actor,
          { batchId, sourceRowId: decision.sourceId },
        );
        dealId = deal.id;
        createdIds.deal.push(deal.id);
        dealDecision.action = "create";
        await saveImportedCustomValues(
          manager,
          companyId,
          "deal",
          deal.id,
          dealDecision.preview,
          customFields,
          {
            batchId,
            sourceRowId: decision.sourceId,
            input,
            actor,
          },
        );
      } else if (dealDecision.action === "create") {
        dealDecision.action = "duplicate";
        dealDecision.reason = "Matched another row in this atomic import";
      }
      dealDecision.nativeId = dealId;
      const deal = (await manager.findOneBy(Deal, { companyId, id: dealId }))!;
      if (deal.customerId && deal.customerId !== account.id) {
        throw new Error(`Deal ${deal.id} was linked to a different Account during import`);
      }
      if (deal.primaryContactId && deal.primaryContactId !== contact.id) {
        throw new Error(`Deal ${deal.id} was linked to a different primary Contact during import`);
      }
      if (!deal.customerId || !deal.primaryContactId) {
        deal.customerId = deal.customerId ?? account.id;
        deal.primaryContactId = deal.primaryContactId ?? contact.id;
        await manager.save(deal);
      }
      const resourceDecisions = Object.values(decision.resources);
      decision.action = resourceDecisions.every((resource) => resource.action === "duplicate")
        ? "duplicate"
        : "create";
    }

    report.createCount = report.decisions.filter((decision) => decision.action === "create").length;
    report.duplicateCount = report.decisions.filter(
      (decision) => decision.action === "duplicate",
    ).length;
    for (const resourceType of ["account", "contact", "deal"] as const) {
      const resourceDecisions = report.decisions.map(
        (decision) => decision.resources[resourceType],
      );
      report.resourceCounts[resourceType] = {
        create: resourceDecisions.filter((decision) => decision.action === "create").length,
        duplicate: resourceDecisions.filter((decision) => decision.action === "duplicate").length,
        skip: resourceDecisions.filter((decision) => decision.action === "skip").length,
      };
    }
    const rowMap = report.decisions.map((decision) => ({
      sourceId: decision.sourceId,
      action: decision.action,
      reason: decision.reason,
      resources: Object.fromEntries(
        (["account", "contact", "deal"] as const).map((resourceType) => {
          const resource = decision.resources[resourceType];
          return [
            resourceType,
            {
              nativeId: resource.nativeId,
              action: resource.action,
              reason: resource.reason,
            },
          ];
        }),
      ),
    }));
    const repo = manager.getRepository(RevenueImportBatch);
    const batch = await repo.save(
      repo.create({
        id: batchId,
        companyId,
        resourceType: "account_contact_deal",
        sourceKind: input.sourceKind,
        sourceLabel: input.sourceLabel,
        sourceBaseId: input.sourceBaseId ?? null,
        sourceTableId: input.sourceTableId ?? null,
        sourceConnectionId: input.sourceConnectionId ?? null,
        status: "completed",
        mappingJson: JSON.stringify(input.mapping),
        rowMapJson: JSON.stringify(rowMap),
        createdIdsJson: JSON.stringify(createdIds),
        reportJson: JSON.stringify(report),
        rolledBackAt: null,
        createdByUserId: actor.userId ?? null,
        createdByEmployeeId: actor.employeeId ?? null,
      }),
    );
    const importRows: RevenueImportRow[] = [];
    for (const [sourceIndex, decision] of report.decisions.entries()) {
      for (const [resourceIndex, resourceType] of (
        ["account", "contact", "deal"] as const
      ).entries()) {
        const resource = decision.resources[resourceType];
        importRows.push(
          manager.create(RevenueImportRow, {
            companyId,
            batchId: batch.id,
            resourceType,
            sourceId: decision.sourceId,
            nativeId: resource.nativeId,
            action: resource.action,
            status:
              resource.action === "create"
                ? "created"
                : resource.action === "duplicate"
                  ? "matched"
                  : "skipped",
            reason: resource.reason ?? decision.reason ?? "",
            decisionJson: JSON.stringify(resource),
            sortOrder: sourceIndex * 3 + resourceIndex,
          }),
        );
      }
    }
    if (importRows.length > 0) {
      await manager.save(RevenueImportRow, importRows, { chunk: 500 });
    }
    return batch;
  });
}

export async function listRevenueImports(companyId: string): Promise<RevenueImportBatch[]> {
  return AppDataSource.getRepository(RevenueImportBatch).find({
    where: { companyId },
    order: { createdAt: "DESC" },
    take: 100,
  });
}

export async function getRevenueImport(
  companyId: string,
  id: string,
): Promise<RevenueImportBatch | null> {
  return AppDataSource.getRepository(RevenueImportBatch).findOneBy({ companyId, id });
}

type CompactRevenueImportBatch = Pick<
  RevenueImportBatch,
  | "id"
  | "companyId"
  | "resourceType"
  | "sourceKind"
  | "sourceLabel"
  | "sourceBaseId"
  | "sourceTableId"
  | "sourceConnectionId"
  | "status"
  | "rolledBackAt"
  | "createdByUserId"
  | "createdByEmployeeId"
  | "createdAt"
  | "updatedAt"
>;

export type RevenueImportSummary = {
  batch: Omit<CompactRevenueImportBatch, "companyId">;
  counts: Record<string, number>;
};

async function getCompactRevenueImport(
  companyId: string,
  id: string,
): Promise<CompactRevenueImportBatch | null> {
  return (await AppDataSource.getRepository(RevenueImportBatch)
    .createQueryBuilder("batch")
    .select([
      "batch.id",
      "batch.companyId",
      "batch.resourceType",
      "batch.sourceKind",
      "batch.sourceLabel",
      "batch.sourceBaseId",
      "batch.sourceTableId",
      "batch.sourceConnectionId",
      "batch.status",
      "batch.rolledBackAt",
      "batch.createdByUserId",
      "batch.createdByEmployeeId",
      "batch.createdAt",
      "batch.updatedAt",
    ])
    .where("batch.companyId = :companyId", { companyId })
    .andWhere("batch.id = :id", { id })
    .getOne()) as CompactRevenueImportBatch | null;
}

export async function getRevenueImportSummary(
  companyId: string,
  id: string,
): Promise<RevenueImportSummary | null> {
  const batch = await getCompactRevenueImport(companyId, id);
  if (!batch) return null;
  await ensureRevenueImportRows(batch);
  const grouped = await AppDataSource.getRepository(RevenueImportRow)
    .createQueryBuilder("row")
    .select("row.status", "status")
    .addSelect("COUNT(*)", "count")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.batchId = :id", { id })
    .groupBy("row.status")
    .getRawMany<{ status: string; count: string | number }>();
  return {
    batch: {
      id: batch.id,
      resourceType: batch.resourceType,
      sourceKind: batch.sourceKind,
      sourceLabel: batch.sourceLabel,
      sourceBaseId: batch.sourceBaseId,
      sourceTableId: batch.sourceTableId,
      sourceConnectionId: batch.sourceConnectionId,
      status: batch.status,
      rolledBackAt: batch.rolledBackAt,
      createdByUserId: batch.createdByUserId,
      createdByEmployeeId: batch.createdByEmployeeId,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    },
    counts: Object.fromEntries(grouped.map((row) => [row.status, Number(row.count)])),
  };
}

export async function queryRevenueImports(
  companyId: string,
  opts: {
    sourceKind?: RevenueImportSourceKind;
    status?: "completed" | "rolled_back" | "failed";
    resourceType?: RevenueImportBatch["resourceType"];
    from?: Date;
    to?: Date;
    summaryOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueImportBatch[]; total: number }> {
  const qb = AppDataSource.getRepository(RevenueImportBatch)
    .createQueryBuilder("batch")
    .where("batch.companyId = :companyId", { companyId });
  if (opts.sourceKind)
    qb.andWhere("batch.sourceKind = :sourceKind", { sourceKind: opts.sourceKind });
  if (opts.status) qb.andWhere("batch.status = :status", { status: opts.status });
  if (opts.resourceType) {
    qb.andWhere("batch.resourceType = :resourceType", { resourceType: opts.resourceType });
  }
  if (opts.from) qb.andWhere("batch.createdAt >= :from", { from: opts.from });
  if (opts.to) qb.andWhere("batch.createdAt < :to", { to: opts.to });
  if (opts.summaryOnly) {
    qb.select([
      "batch.id",
      "batch.companyId",
      "batch.resourceType",
      "batch.sourceKind",
      "batch.sourceLabel",
      "batch.sourceBaseId",
      "batch.sourceTableId",
      "batch.sourceConnectionId",
      "batch.status",
      "batch.rolledBackAt",
      "batch.createdByUserId",
      "batch.createdByEmployeeId",
      "batch.createdAt",
      "batch.updatedAt",
    ]);
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("batch.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .getMany();
  return { rows, total };
}

type LegacyRevenueImportBatch = Pick<
  RevenueImportBatch,
  "id" | "companyId" | "resourceType" | "rowMapJson"
>;

const legacyImportMaterializations = new Map<string, Promise<void>>();

async function materializeLegacyImportRows(
  manager: EntityManager,
  batch: LegacyRevenueImportBatch,
): Promise<void> {
  const repo = manager.getRepository(RevenueImportRow);
  let rowMap: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(batch.rowMapJson) as unknown;
    if (Array.isArray(parsed)) rowMap = parsed as Array<Record<string, unknown>>;
  } catch {
    rowMap = [];
  }
  const rows: RevenueImportRow[] = [];
  for (const [sourceIndex, decision] of rowMap.entries()) {
    const resources =
      decision.resources && typeof decision.resources === "object"
        ? (decision.resources as Record<string, Record<string, unknown>>)
        : null;
    if (resources) {
      for (const [resourceIndex, resourceType] of (
        ["account", "contact", "deal"] as const
      ).entries()) {
        const resource = resources[resourceType] ?? {};
        const action = String(resource.action ?? decision.action ?? "skip");
        rows.push(
          repo.create({
            companyId: batch.companyId,
            batchId: batch.id,
            resourceType,
            sourceId: String(decision.sourceId ?? sourceIndex),
            nativeId: typeof resource.nativeId === "string" ? resource.nativeId : null,
            action,
            status:
              action === "create" ? "created" : action === "duplicate" ? "matched" : "skipped",
            reason: String(resource.reason ?? decision.reason ?? ""),
            decisionJson: JSON.stringify(resource),
            sortOrder: sourceIndex * 3 + resourceIndex,
          }),
        );
      }
    } else {
      const action = String(decision.action ?? "skip");
      rows.push(
        repo.create({
          companyId: batch.companyId,
          batchId: batch.id,
          resourceType: batch.resourceType as RevenueResourceType,
          sourceId: String(decision.sourceId ?? sourceIndex),
          nativeId: typeof decision.nativeId === "string" ? decision.nativeId : null,
          action,
          status: action === "create" ? "created" : action === "duplicate" ? "matched" : "skipped",
          reason: String(decision.reason ?? ""),
          decisionJson: JSON.stringify(decision),
          sortOrder: sourceIndex,
        }),
      );
    }
  }
  if (rows.length > 0) await repo.save(rows, { chunk: 500 });
}

async function materializeLegacyImportRowsTransactionally(
  batch: CompactRevenueImportBatch,
): Promise<void> {
  await AppDataSource.transaction(async (manager) => {
    const batchQb = manager
      .getRepository(RevenueImportBatch)
      .createQueryBuilder("batch")
      .select(["batch.id", "batch.companyId", "batch.resourceType", "batch.rowMapJson"])
      .where("batch.companyId = :companyId", { companyId: batch.companyId })
      .andWhere("batch.id = :id", { id: batch.id });
    if (AppDataSource.options.type === "postgres") {
      batchQb.setLock("pessimistic_write");
    }
    const legacy = (await batchQb.getOne()) as LegacyRevenueImportBatch | null;
    if (!legacy) return;
    if (
      (await manager.count(RevenueImportRow, {
        where: { companyId: batch.companyId, batchId: batch.id },
      })) > 0
    ) {
      return;
    }
    await materializeLegacyImportRows(manager, legacy);
  });
}

async function ensureRevenueImportRows(batch: CompactRevenueImportBatch): Promise<void> {
  if (
    (await AppDataSource.getRepository(RevenueImportRow).count({
      where: { companyId: batch.companyId, batchId: batch.id },
    })) > 0
  ) {
    return;
  }
  const key = `${batch.companyId}:${batch.id}`;
  const active = legacyImportMaterializations.get(key);
  if (active) return active;
  const materialization = materializeLegacyImportRowsTransactionally(batch);
  legacyImportMaterializations.set(key, materialization);
  try {
    await materialization;
  } finally {
    if (legacyImportMaterializations.get(key) === materialization) {
      legacyImportMaterializations.delete(key);
    }
  }
}

export async function ensureRevenueImportRowsForCompany(
  companyId: string,
  resourceTypes?: RevenueImportBatch["resourceType"][],
): Promise<void> {
  const batchQuery = AppDataSource.getRepository(RevenueImportBatch)
    .createQueryBuilder("batch")
    .where("batch.companyId = :companyId", { companyId });
  if (resourceTypes?.length) {
    batchQuery.andWhere("batch.resourceType IN (:...resourceTypes)", { resourceTypes });
  }
  const batches = await batchQuery.orderBy("batch.createdAt", "ASC").getMany();
  if (batches.length === 0) return;
  const existing = await AppDataSource.getRepository(RevenueImportRow)
    .createQueryBuilder("row")
    .select("row.batchId", "batchId")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.batchId IN (:...batchIds)", { batchIds: batches.map((batch) => batch.id) })
    .groupBy("row.batchId")
    .getRawMany<{ batchId: string }>();
  const materialized = new Set(existing.map((row) => row.batchId));
  for (const batch of batches) {
    if (!materialized.has(batch.id)) await ensureRevenueImportRows(batch);
  }
}

export async function getRevenueImportRows(
  companyId: string,
  batchId: string,
  opts: {
    resourceType?: RevenueResourceType;
    status?: RevenueImportRow["status"];
    action?: string;
    q?: string;
    sourceId?: string;
    nativeId?: string;
    error?: string;
    hasError?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  batch: Pick<
    RevenueImportBatch,
    "id" | "resourceType" | "sourceKind" | "sourceLabel" | "status" | "createdAt"
  >;
  rows: RevenueImportRow[];
  total: number;
} | null> {
  const batch = await getCompactRevenueImport(companyId, batchId);
  if (!batch) return null;
  await ensureRevenueImportRows(batch);
  const qb = AppDataSource.getRepository(RevenueImportRow)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.batchId = :batchId", { batchId });
  if (opts.resourceType) {
    qb.andWhere("row.resourceType = :resourceType", { resourceType: opts.resourceType });
  }
  if (opts.status) qb.andWhere("row.status = :status", { status: opts.status });
  if (opts.action) qb.andWhere("row.action = :action", { action: opts.action });
  if (opts.sourceId) qb.andWhere("row.sourceId = :sourceId", { sourceId: opts.sourceId });
  if (opts.nativeId) qb.andWhere("row.nativeId = :nativeId", { nativeId: opts.nativeId });
  if (opts.error) {
    qb.andWhere("LOWER(row.reason) LIKE :error", { error: `%${opts.error.toLowerCase()}%` });
  }
  if (opts.hasError === true) {
    qb.andWhere("(row.status = 'failed' OR row.reason != '')");
  } else if (opts.hasError === false) {
    qb.andWhere("row.status != 'failed'").andWhere("row.reason = ''");
  }
  if (opts.q) {
    qb.andWhere(
      "(LOWER(row.sourceId) LIKE :q OR LOWER(COALESCE(row.nativeId, '')) LIKE :q OR LOWER(row.reason) LIKE :q)",
      {
        q: `%${opts.q.toLowerCase()}%`,
      },
    );
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("row.sortOrder", "ASC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return {
    batch: {
      id: batch.id,
      resourceType: batch.resourceType,
      sourceKind: batch.sourceKind,
      sourceLabel: batch.sourceLabel,
      status: batch.status,
      createdAt: batch.createdAt,
    },
    rows,
    total,
  };
}

type ImportOwnedFieldData = {
  customValueIds: string[];
  evidenceIds: string[];
};

async function importOwnedFieldData(
  manager: EntityManager,
  batch: RevenueImportBatch,
  resourceType: RevenueResourceType,
  resourceId: string,
): Promise<ImportOwnedFieldData | null> {
  const [customValues, evidence] = await Promise.all([
    manager.find(RevenueCustomValue, {
      where: { companyId: batch.companyId, resourceType, resourceId },
    }),
    manager.find(RevenueFieldEvidence, {
      where: { companyId: batch.companyId, resourceType, resourceId },
    }),
  ]);
  const importedBeforeBatch = (date: Date | null | undefined) =>
    !date || date.getTime() <= batch.createdAt.getTime();
  const sourcePrefix = `import:${batch.id}:`;
  if (
    customValues.some(
      (value) =>
        !importedBeforeBatch(value.createdAt) || !importedBeforeBatch(value.updatedAt),
    ) ||
    evidence.some(
      (item) =>
        item.sourceType !== "import" ||
        !item.sourceId.startsWith(sourcePrefix) ||
        !importedBeforeBatch(item.createdAt),
    )
  ) {
    return null;
  }

  const fieldIds = [...new Set(customValues.map((value) => value.fieldId))];
  const fields =
    fieldIds.length > 0
      ? await manager.findBy(RevenueCustomField, {
          companyId: batch.companyId,
          id: In(fieldIds),
        })
      : [];
  const fieldKeys = new Map(fields.map((field) => [field.id, field.key]));
  const evidenceByKey = new Map(evidence.map((item) => [item.fieldKey, item]));
  if (
    customValues.some((value) => {
      const key = fieldKeys.get(value.fieldId);
      const importedEvidence = key ? evidenceByKey.get(`custom:${key}`) : null;
      return !importedEvidence || importedEvidence.extractedValueJson !== value.valueJson;
    })
  ) {
    return null;
  }
  return {
    customValueIds: customValues.map((value) => value.id),
    evidenceIds: evidence.map((item) => item.id),
  };
}

async function deleteImportedFieldData(
  manager: EntityManager,
  fieldData: ImportOwnedFieldData,
): Promise<void> {
  if (fieldData.customValueIds.length > 0) {
    await manager.delete(RevenueCustomValue, { id: In(fieldData.customValueIds) });
  }
  if (fieldData.evidenceIds.length > 0) {
    await manager.delete(RevenueFieldEvidence, { id: In(fieldData.evidenceIds) });
  }
}

async function clearDerivedResourcePointers(
  manager: EntityManager,
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
): Promise<void> {
  await Promise.all([
    manager.delete(RevenueDuplicateCandidate, {
      companyId,
      resourceType,
      leftId: resourceId,
    }),
    manager.delete(RevenueDuplicateCandidate, {
      companyId,
      resourceType,
      rightId: resourceId,
    }),
    manager.update(
      RevenueDocumentCandidate,
      { companyId, proposedResourceType: resourceType, proposedResourceId: resourceId },
      { proposedResourceType: null, proposedResourceId: null },
    ),
  ]);
}

async function accountDependencyCount(
  manager: EntityManager,
  companyId: string,
  resourceId: string,
): Promise<number> {
  const counts = await Promise.all([
    manager.count(Invoice, { where: { companyId, customerId: resourceId } }),
    manager.count(RecurringInvoice, { where: { companyId, customerId: resourceId } }),
    manager.count(Estimate, { where: { companyId, customerId: resourceId } }),
    manager.count(CustomerContract, { where: { companyId, customerId: resourceId } }),
    manager.count(CustomerCredit, { where: { companyId, customerId: resourceId } }),
    manager.count(CustomerContact, { where: { companyId, customerId: resourceId } }),
    manager.count(Contact, { where: { companyId, customerId: resourceId } }),
    manager.count(Deal, { where: { companyId, customerId: resourceId } }),
    manager.count(Partnership, { where: { companyId, customerId: resourceId } }),
    manager.count(Activity, { where: { companyId, customerId: resourceId } }),
    manager.count(RevenueDocument, { where: { companyId, customerId: resourceId } }),
    manager.count(RevenueFirmographicLookup, {
      where: { companyId, customerId: resourceId },
    }),
    manager.count(SignalEvent, { where: { companyId, customerId: resourceId } }),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

async function contactDependencyCount(
  manager: EntityManager,
  companyId: string,
  resourceId: string,
): Promise<number> {
  const counts = await Promise.all([
    manager.count(DealContact, { where: { companyId, contactId: resourceId } }),
    manager.count(PartnershipContact, { where: { companyId, contactId: resourceId } }),
    manager.count(Activity, { where: { companyId, contactId: resourceId } }),
    manager.count(RevenueDocument, { where: { companyId, contactId: resourceId } }),
    manager.count(Deal, { where: { companyId, primaryContactId: resourceId } }),
    manager.count(SequenceEnrollment, { where: { companyId, contactId: resourceId } }),
    manager.count(SignalEvent, { where: { companyId, contactId: resourceId } }),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

async function dealDependencyCount(
  manager: EntityManager,
  companyId: string,
  resourceId: string,
): Promise<number> {
  const counts = await Promise.all([
    manager
      .createQueryBuilder(Activity, "activity")
      .where("activity.companyId = :companyId", { companyId })
      .andWhere("activity.dealId = :resourceId", { resourceId })
      .andWhere("activity.kind != 'deal_created'")
      .getCount(),
    manager.count(DealContact, { where: { companyId, dealId: resourceId } }),
    manager.count(RevenueDocument, { where: { companyId, dealId: resourceId } }),
    manager.count(SequenceEnrollment, { where: { companyId, dealId: resourceId } }),
    manager.count(SignalEvent, { where: { companyId, dealId: resourceId } }),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

function dealHistoryImportBatchId(event: DealHistoryEvent): string | null {
  try {
    const metadata = JSON.parse(event.metadataJson) as {
      revenueImport?: { batchId?: unknown };
    };
    return typeof metadata.revenueImport?.batchId === "string"
      ? metadata.revenueImport.batchId
      : null;
  } catch {
    return null;
  }
}

async function canDeleteImportedDealHistory(
  manager: EntityManager,
  batch: RevenueImportBatch,
  dealId: string,
): Promise<boolean> {
  const [creationActivities, history] = await Promise.all([
    manager.find(Activity, {
      where: { companyId: batch.companyId, dealId, kind: "deal_created" },
    }),
    manager.find(DealHistoryEvent, {
      where: { companyId: batch.companyId, dealId },
    }),
  ]);
  if (creationActivities.length !== 1) return false;
  const [creationActivity] = creationActivities;
  if (creationActivity.createdAt.getTime() > batch.createdAt.getTime()) return false;

  return history.every((event) => {
    if (event.createdAt.getTime() > batch.createdAt.getTime()) return false;
    if (dealHistoryImportBatchId(event) === batch.id) return true;
    if (
      event.kind === "created" &&
      event.sourceKind === "live" &&
      event.sourceActivityId === creationActivity.id &&
      event.sourceKey === `activity:${creationActivity.id}`
    ) {
      return true;
    }
    return (
      (event.kind === "won" || event.kind === "lost") &&
      event.sourceKind === "live" &&
      event.sourceActivityId === null &&
      event.occurredAt.getTime() === creationActivity.occurredAt.getTime() &&
      event.sourceKey.startsWith(`live:${dealId}:${event.kind}:`)
    );
  });
}

async function rollbackLinkedRevenueImport(
  manager: EntityManager,
  batch: RevenueImportBatch,
  created: LinkedCreatedIds,
): Promise<{ deleted: number; blocked: string[] }> {
  const blocked: string[] = [];
  let deleted = 0;
  for (const resourceId of [...created.deal].reverse()) {
    const resource = await manager.findOneBy(Deal, {
      companyId: batch.companyId,
      id: resourceId,
    });
    const dependencies = await dealDependencyCount(
      manager,
      batch.companyId,
      resourceId,
    );
    const historyIsImportOwned = resource
      ? await canDeleteImportedDealHistory(manager, batch, resourceId)
      : false;
    const fieldData = resource
      ? await importOwnedFieldData(manager, batch, "deal", resourceId)
      : null;
    if (
      !resource ||
      resource.updatedAt.getTime() > batch.createdAt.getTime() ||
      dependencies > 0 ||
      !historyIsImportOwned ||
      !fieldData
    ) {
      blocked.push(`deal:${resourceId}`);
      continue;
    }
    await manager.delete(DealHistoryEvent, {
      companyId: batch.companyId,
      dealId: resourceId,
    });
    await manager.delete(Activity, { companyId: batch.companyId, dealId: resourceId });
    await deleteImportedFieldData(manager, fieldData);
    await clearDerivedResourcePointers(manager, batch.companyId, "deal", resourceId);
    deleted +=
      (await manager.delete(Deal, { companyId: batch.companyId, id: resourceId })).affected ?? 0;
  }
  for (const resourceId of [...created.contact].reverse()) {
    const resource = await manager.findOneBy(Contact, {
      companyId: batch.companyId,
      id: resourceId,
    });
    const dependencies = await contactDependencyCount(
      manager,
      batch.companyId,
      resourceId,
    );
    const fieldData = resource
      ? await importOwnedFieldData(manager, batch, "contact", resourceId)
      : null;
    if (
      !resource ||
      resource.updatedAt.getTime() > batch.createdAt.getTime() ||
      dependencies > 0 ||
      !fieldData
    ) {
      blocked.push(`contact:${resourceId}`);
      continue;
    }
    await deleteImportedFieldData(manager, fieldData);
    await clearDerivedResourcePointers(manager, batch.companyId, "contact", resourceId);
    deleted +=
      (await manager.delete(Contact, { companyId: batch.companyId, id: resourceId })).affected ?? 0;
  }
  for (const resourceId of [...created.account].reverse()) {
    const resource = await manager.findOneBy(Customer, {
      companyId: batch.companyId,
      id: resourceId,
    });
    const dependencies = await accountDependencyCount(
      manager,
      batch.companyId,
      resourceId,
    );
    const fieldData = resource
      ? await importOwnedFieldData(manager, batch, "account", resourceId)
      : null;
    if (
      !resource ||
      resource.updatedAt.getTime() > batch.createdAt.getTime() ||
      dependencies > 0 ||
      !fieldData
    ) {
      blocked.push(`account:${resourceId}`);
      continue;
    }
    await deleteImportedFieldData(manager, fieldData);
    await clearDerivedResourcePointers(manager, batch.companyId, "account", resourceId);
    deleted +=
      (await manager.delete(Customer, { companyId: batch.companyId, id: resourceId })).affected ??
      0;
  }
  return { deleted, blocked };
}

export async function rollbackRevenueImport(
  companyId: string,
  id: string,
): Promise<{ batch: RevenueImportBatch; deleted: number; blocked: string[] } | null> {
  const repo = AppDataSource.getRepository(RevenueImportBatch);
  const batch = await repo.findOneBy({ companyId, id });
  if (!batch) return null;
  if (batch.status === "rolled_back") return { batch, deleted: 0, blocked: [] };
  if (batch.resourceType === "account_contact_deal") {
    let created: LinkedCreatedIds = { account: [], contact: [], deal: [] };
    try {
      const parsed = JSON.parse(batch.createdIdsJson) as Partial<LinkedCreatedIds>;
      created = {
        account: Array.isArray(parsed.account) ? parsed.account : [],
        contact: Array.isArray(parsed.contact) ? parsed.contact : [],
        deal: Array.isArray(parsed.deal) ? parsed.deal : [],
      };
    } catch {
      created = { account: [], contact: [], deal: [] };
    }
    let deleted = 0;
    let blocked: string[] = [];
    await AppDataSource.transaction(async (manager) => {
      const result = await rollbackLinkedRevenueImport(manager, batch, created);
      deleted = result.deleted;
      blocked = result.blocked;
      const rolledBackIds = (["account", "contact", "deal"] as const).flatMap((resourceType) =>
        created[resourceType].filter(
          (resourceId) => !blocked.includes(`${resourceType}:${resourceId}`),
        ),
      );
      if (rolledBackIds.length > 0) {
        await manager.update(
          RevenueImportRow,
          { companyId, batchId: batch.id, nativeId: In(rolledBackIds) },
          { status: "rolled_back" },
        );
      }
      batch.status = "rolled_back";
      batch.rolledBackAt = new Date();
      const report = JSON.parse(batch.reportJson) as LinkedImportReport & {
        rollback?: { deleted: number; blocked: string[] };
      };
      report.rollback = { deleted, blocked };
      batch.reportJson = JSON.stringify(report);
      await manager.save(batch);
    });
    return { batch, deleted, blocked };
  }
  let ids: string[] = [];
  try {
    ids = JSON.parse(batch.createdIdsJson) as string[];
  } catch {
    ids = [];
  }
  const blocked: string[] = [];
  let deleted = 0;
  await AppDataSource.transaction(async (manager) => {
    for (const resourceId of ids) {
      if (batch.resourceType === "contact") {
        const resource = await manager.findOneBy(Contact, { companyId, id: resourceId });
        const dependencies = await contactDependencyCount(manager, companyId, resourceId);
        const fieldData = resource
          ? await importOwnedFieldData(manager, batch, "contact", resourceId)
          : null;
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          dependencies > 0 ||
          !fieldData
        ) {
          blocked.push(resourceId);
          continue;
        }
        await deleteImportedFieldData(manager, fieldData);
        await clearDerivedResourcePointers(manager, companyId, "contact", resourceId);
        deleted += (await manager.delete(Contact, { companyId, id: resourceId })).affected ?? 0;
      } else if (batch.resourceType === "account") {
        const resource = await manager.findOneBy(Customer, { companyId, id: resourceId });
        const dependencies = await accountDependencyCount(manager, companyId, resourceId);
        const fieldData = resource
          ? await importOwnedFieldData(manager, batch, "account", resourceId)
          : null;
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          dependencies > 0 ||
          !fieldData
        ) {
          blocked.push(resourceId);
          continue;
        }
        await deleteImportedFieldData(manager, fieldData);
        await clearDerivedResourcePointers(manager, companyId, "account", resourceId);
        deleted += (await manager.delete(Customer, { companyId, id: resourceId })).affected ?? 0;
      } else if (batch.resourceType === "deal") {
        const resource = await manager.findOneBy(Deal, { companyId, id: resourceId });
        const dependencies = await dealDependencyCount(manager, companyId, resourceId);
        const historyIsImportOwned = resource
          ? await canDeleteImportedDealHistory(manager, batch, resourceId)
          : false;
        const fieldData = resource
          ? await importOwnedFieldData(manager, batch, "deal", resourceId)
          : null;
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          dependencies > 0 ||
          !historyIsImportOwned ||
          !fieldData
        ) {
          blocked.push(resourceId);
          continue;
        }
        await manager.delete(DealHistoryEvent, { companyId, dealId: resourceId });
        await manager.delete(Activity, { companyId, dealId: resourceId });
        await deleteImportedFieldData(manager, fieldData);
        await clearDerivedResourcePointers(manager, companyId, "deal", resourceId);
        deleted += (await manager.delete(Deal, { companyId, id: resourceId })).affected ?? 0;
      } else {
        const resource = await manager.findOneBy(Partnership, { companyId, id: resourceId });
        const activities = await manager.count(Activity, {
          where: { companyId, partnershipId: resourceId },
        });
        const contacts = await manager.count(PartnershipContact, {
          where: { companyId, partnershipId: resourceId },
        });
        const documents = await manager.count(RevenueDocument, {
          where: { companyId, partnershipId: resourceId },
        });
        const fieldData = resource
          ? await importOwnedFieldData(manager, batch, "partnership", resourceId)
          : null;
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          activities + contacts + documents > 0 ||
          !fieldData
        ) {
          blocked.push(resourceId);
          continue;
        }
        await deleteImportedFieldData(manager, fieldData);
        await clearDerivedResourcePointers(manager, companyId, "partnership", resourceId);
        deleted += (await manager.delete(Partnership, { companyId, id: resourceId })).affected ?? 0;
      }
    }
    batch.status = "rolled_back";
    batch.rolledBackAt = new Date();
    const report = JSON.parse(batch.reportJson) as ImportReport & {
      rollback?: { deleted: number; blocked: string[] };
    };
    report.rollback = { deleted, blocked };
    batch.reportJson = JSON.stringify(report);
    const rolledBackIds = ids.filter((resourceId) => !blocked.includes(resourceId));
    if (rolledBackIds.length > 0) {
      await manager.update(
        RevenueImportRow,
        { companyId, batchId: batch.id, nativeId: In(rolledBackIds) },
        { status: "rolled_back" },
      );
    }
    await manager.save(batch);
  });
  return { batch, deleted, blocked };
}

export type BaseAttachmentMigrationResult = {
  importId: string;
  targetResourceType: RevenueResourceType;
  total: number;
  migrated: number;
  skipped: number;
  failures: Array<{ sourceAttachmentId: string; error: string }>;
};

function resourceDocumentFilter(
  resourceType: RevenueResourceType,
  resourceId: string,
): {
  dealId?: string;
  customerId?: string;
  partnershipId?: string;
  contactId?: string;
} {
  if (resourceType === "account") return { customerId: resourceId };
  if (resourceType === "deal") return { dealId: resourceId };
  if (resourceType === "contact") return { contactId: resourceId };
  return { partnershipId: resourceId };
}

export async function migrateBaseAttachmentsForImport(
  companyId: string,
  importId: string,
  input: {
    targetResourceType?: RevenueResourceType;
    kind?: RevenueDocumentKind;
  },
  actor: ImportActor,
): Promise<BaseAttachmentMigrationResult> {
  const batch = await getRevenueImport(companyId, importId);
  if (!batch) throw new Error("Import not found");
  if (batch.status !== "completed") {
    throw new Error("Attachments can only be migrated for a completed import");
  }
  if (batch.sourceKind !== "base" || !batch.sourceBaseId) {
    throw new Error("Only imports from a Genosyn Base have Base attachments");
  }
  const targetResourceType =
    input.targetResourceType ??
    (batch.resourceType === "account_contact_deal" ? "deal" : batch.resourceType);
  if (batch.resourceType !== "account_contact_deal" && targetResourceType !== batch.resourceType) {
    throw new Error("The attachment target must match the import resource type");
  }
  if (batch.resourceType === "account_contact_deal" && targetResourceType === "partnership") {
    throw new Error("A linked Account, Contact, and Deal import has no Partnership target");
  }
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new Error("Company not found");

  const resourceBySourceId = new Map<string, string>();
  try {
    const rowMap = JSON.parse(batch.rowMapJson) as Array<{
      sourceId?: unknown;
      nativeId?: unknown;
      resources?: Partial<Record<LinkedImportResource, { nativeId?: unknown }>>;
    }>;
    for (const row of rowMap) {
      if (typeof row.sourceId !== "string") continue;
      const nativeId =
        batch.resourceType === "account_contact_deal"
          ? row.resources?.[targetResourceType as LinkedImportResource]?.nativeId
          : row.nativeId;
      if (typeof nativeId === "string") resourceBySourceId.set(row.sourceId, nativeId);
    }
  } catch {
    throw new Error("The import reconciliation map is unreadable");
  }

  const sourceIds = [...resourceBySourceId.keys()];
  const attachments =
    sourceIds.length === 0
      ? []
      : await AppDataSource.getRepository(BaseRecordAttachment).find({
          where: { companyId, recordId: In(sourceIds) },
          order: { createdAt: "ASC" },
        });
  let migrated = 0;
  let skipped = 0;
  const failures: BaseAttachmentMigrationResult["failures"] = [];
  for (const sourceAttachment of attachments) {
    const resourceId = resourceBySourceId.get(sourceAttachment.recordId);
    if (!resourceId) {
      skipped += 1;
      continue;
    }
    try {
      const filter = resourceDocumentFilter(targetResourceType, resourceId);
      const existing = await listRevenueDocuments(companyId, filter);
      if (
        existing.some(
          (document) =>
            document.attachment?.filename === sourceAttachment.filename &&
            Number(document.attachment.sizeBytes) === Number(sourceAttachment.sizeBytes),
        )
      ) {
        skipped += 1;
        continue;
      }
      const resolved = await resolveBaseAttachmentFile(sourceAttachment.id, companyId);
      if (!resolved) throw new Error("Source file is missing");
      const bytes = await fs.promises.readFile(resolved.absPath);
      const attachment = await recordAttachmentBytes({
        companyId,
        companySlug: company.slug,
        filename: sourceAttachment.filename,
        mimeType: sourceAttachment.mimeType,
        bytes,
        uploadedByUserId: actor.userId ?? null,
      });
      await createRevenueDocument(
        companyId,
        {
          kind: input.kind ?? "other",
          title: sourceAttachment.filename,
          notes: `Migrated from ${batch.sourceLabel}`,
          attachmentId: attachment.id,
          ...filter,
        },
        actor,
      );
      migrated += 1;
    } catch (error) {
      failures.push({
        sourceAttachmentId: sourceAttachment.id,
        error: error instanceof Error ? error.message : "Attachment migration failed",
      });
    }
  }
  return {
    importId,
    targetResourceType,
    total: attachments.length,
    migrated,
    skipped,
    failures,
  };
}
