import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Base } from "../../db/entities/Base.js";
import { BaseField } from "../../db/entities/BaseField.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import {
  type RevenueCustomField,
  type RevenueResourceType,
} from "../../db/entities/RevenueCustomField.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueImportBatch } from "../../db/entities/RevenueImportBatch.js";
import { createRevenueAccount, normalizeAccountDomain } from "./accounts.js";
import { assertClassification } from "./classifications.js";
import { createContact } from "./contacts.js";
import { listCustomFields, setCustomValues, type CustomFieldValue } from "./customFields.js";
import { createDeal } from "./deals.js";
import { createPartnership } from "./partnerships.js";

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

type ImportActor = { userId?: string | null; employeeId?: string | null };

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
      : text.split(",").map((value) => value.trim()).filter(Boolean);
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
  const decisions: ImportDecision[] = [];
  const customFields = await listCustomFields(companyId, resourceType);
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
    try {
      if (resourceType === "deal" && preview.source) {
        await assertClassification(companyId, "deal_source", asText(preview.source));
      }
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
      return { sourceId: record.id, values };
    }),
  };
}

async function createImportedResource(
  companyId: string,
  resourceType: RevenueResourceType,
  preview: Record<string, unknown>,
  actor: ImportActor,
): Promise<string> {
  if (resourceType === "contact") {
    return (
      await createContact(
        companyId,
        {
          name: asText(preview.name),
          email: asText(preview.email),
          phone: asText(preview.phone),
          title: asText(preview.title),
          companyName: asText(preview.companyName),
          source: asText(preview.source),
          notes: asText(preview.notes),
        },
        actor,
      )
    ).id;
  }
  if (resourceType === "account") {
    return (
      await createRevenueAccount(
        companyId,
        {
          name: asText(preview.name),
          domain: asText(preview.domain),
          websiteUrl: asText(preview.websiteUrl),
          industry: asText(preview.industry),
          employeeCount: asNumber(preview.employeeCount),
          notes: asText(preview.notes),
        },
        actor,
      )
    ).id;
  }
  if (resourceType === "deal") {
    return (
      await createDeal(
        companyId,
        {
          title: asText(preview.title),
          description: asText(preview.description),
          amountCents: asNumber(preview.amountCents),
          currency: asText(preview.currency),
          source: asText(preview.source),
          nextStep: asText(preview.nextStep),
          nextFollowUpAt:
            preview.nextFollowUpAt instanceof Date ? preview.nextFollowUpAt : null,
          expectedCloseDate:
            preview.expectedCloseDate instanceof Date ? preview.expectedCloseDate : null,
        },
        actor,
      )
    ).id;
  }
  return (
    await createPartnership(
      companyId,
      {
        name: asText(preview.name),
        type: asText(preview.type),
        status: asText(preview.status),
        websiteUrl: asText(preview.websiteUrl),
        integrationContext: asText(preview.integrationContext),
        channelContext: asText(preview.channelContext),
        notes: asText(preview.notes),
        nextFollowUpAt:
          preview.nextFollowUpAt instanceof Date ? preview.nextFollowUpAt : null,
      },
      actor,
    )
  ).id;
}

export async function commitRevenueImport(
  companyId: string,
  input: {
    resourceType: RevenueResourceType;
    sourceKind: "base" | "csv";
    sourceLabel: string;
    sourceBaseId?: string | null;
    sourceTableId?: string | null;
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
  const createdIds: string[] = [];
  for (const decision of report.decisions) {
    if (decision.action !== "create") continue;
    try {
      const id = await createImportedResource(
        companyId,
        input.resourceType,
        decision.preview,
        actor,
      );
      const customValues =
        decision.preview.customValues &&
        typeof decision.preview.customValues === "object" &&
        !Array.isArray(decision.preview.customValues)
          ? (decision.preview.customValues as Record<string, unknown>)
          : {};
      if (Object.keys(customValues).length > 0) {
        try {
          await setCustomValues(companyId, input.resourceType, id, customValues);
        } catch (error) {
          await AppDataSource.getRepository(RevenueCustomValue).delete({
            companyId,
            resourceId: id,
          });
          if (input.resourceType === "contact") {
            await AppDataSource.getRepository(Contact).delete({ companyId, id });
          } else if (input.resourceType === "account") {
            await AppDataSource.getRepository(Customer).delete({ companyId, id });
          } else if (input.resourceType === "deal") {
            await AppDataSource.getRepository(Activity).delete({ companyId, dealId: id });
            await AppDataSource.getRepository(Deal).delete({ companyId, id });
          } else {
            await AppDataSource.getRepository(Partnership).delete({ companyId, id });
          }
          throw error;
        }
      }
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
  const repo = AppDataSource.getRepository(RevenueImportBatch);
  return repo.save(
    repo.create({
      companyId,
      resourceType: input.resourceType,
      sourceKind: input.sourceKind,
      sourceLabel: input.sourceLabel,
      sourceBaseId: input.sourceBaseId ?? null,
      sourceTableId: input.sourceTableId ?? null,
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
}

export async function listRevenueImports(companyId: string): Promise<RevenueImportBatch[]> {
  return AppDataSource.getRepository(RevenueImportBatch).find({
    where: { companyId },
    order: { createdAt: "DESC" },
    take: 100,
  });
}

export async function rollbackRevenueImport(
  companyId: string,
  id: string,
): Promise<{ batch: RevenueImportBatch; deleted: number; blocked: string[] } | null> {
  const repo = AppDataSource.getRepository(RevenueImportBatch);
  const batch = await repo.findOneBy({ companyId, id });
  if (!batch) return null;
  if (batch.status === "rolled_back") return { batch, deleted: 0, blocked: [] };
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
        const linked = await manager.count(DealContact, { where: { companyId, contactId: resourceId } });
        const partnerLinked = await manager.count(PartnershipContact, {
          where: { companyId, contactId: resourceId },
        });
        const activityCount = await manager.count(Activity, {
          where: { companyId, contactId: resourceId },
        });
        const documentCount = await manager.count(RevenueDocument, {
          where: { companyId, contactId: resourceId },
        });
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          linked + partnerLinked + activityCount + documentCount > 0
        ) {
          blocked.push(resourceId);
          continue;
        }
        deleted += (await manager.delete(Contact, { companyId, id: resourceId })).affected ?? 0;
      } else if (batch.resourceType === "account") {
        const resource = await manager.findOneBy(Customer, { companyId, id: resourceId });
        const invoices = await manager.count(Invoice, { where: { companyId, customerId: resourceId } });
        const contacts = await manager.count(Contact, { where: { companyId, customerId: resourceId } });
        const deals = await manager.count(Deal, { where: { companyId, customerId: resourceId } });
        const partnerships = await manager.count(Partnership, {
          where: { companyId, customerId: resourceId },
        });
        const activities = await manager.count(Activity, {
          where: { companyId, customerId: resourceId },
        });
        const documents = await manager.count(RevenueDocument, {
          where: { companyId, customerId: resourceId },
        });
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          invoices + contacts + deals + partnerships + activities + documents > 0
        ) {
          blocked.push(resourceId);
          continue;
        }
        deleted += (await manager.delete(Customer, { companyId, id: resourceId })).affected ?? 0;
      } else if (batch.resourceType === "deal") {
        const resource = await manager.findOneBy(Deal, { companyId, id: resourceId });
        const nonCreationActivities = await manager
          .createQueryBuilder(Activity, "activity")
          .where("activity.companyId = :companyId", { companyId })
          .andWhere("activity.dealId = :resourceId", { resourceId })
          .andWhere("activity.kind != 'deal_created'")
          .getCount();
        const contacts = await manager.count(DealContact, {
          where: { companyId, dealId: resourceId },
        });
        const documents = await manager.count(RevenueDocument, {
          where: { companyId, dealId: resourceId },
        });
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          nonCreationActivities + contacts + documents > 0
        ) {
          blocked.push(resourceId);
          continue;
        }
        await manager.delete(Activity, { companyId, dealId: resourceId });
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
        if (
          !resource ||
          resource.updatedAt.getTime() > batch.createdAt.getTime() ||
          activities + contacts + documents > 0
        ) {
          blocked.push(resourceId);
          continue;
        }
        deleted += (await manager.delete(Partnership, { companyId, id: resourceId })).affected ?? 0;
      }
      if (!blocked.includes(resourceId)) {
        await manager.delete(RevenueCustomValue, { companyId, resourceId });
      }
    }
    batch.status = "rolled_back";
    batch.rolledBackAt = new Date();
    const report = JSON.parse(batch.reportJson) as ImportReport & {
      rollback?: { deleted: number; blocked: string[] };
    };
    report.rollback = { deleted, blocked };
    batch.reportJson = JSON.stringify(report);
    await manager.save(batch);
  });
  return { batch, deleted, blocked };
}
