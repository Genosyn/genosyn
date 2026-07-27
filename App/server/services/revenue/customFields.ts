import { In, IsNull, MoreThan, type EntityManager } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import {
  RevenueCustomField,
  type RevenueCustomFieldType,
  type RevenueResourceType,
} from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import {
  RevenueFieldEvidence,
  type RevenueEvidenceSourceType,
} from "../../db/entities/RevenueFieldEvidence.js";
import type { RevenueOperationActor } from "./operations.js";

export type CustomFieldValue = string | number | boolean | string[] | null;
export type CustomValueProvenance = {
  sourceType: RevenueEvidenceSourceType;
  sourceId: string;
  sourceLabel?: string;
  extractionMethod?: string;
  confidence?: number;
  observedAt?: Date;
  verificationState: "verified" | "unverified";
  lastVerifiedAt?: Date | null;
  metadata?: Record<string, unknown>;
};

type CustomValueResult = {
  field: RevenueCustomField;
  value: CustomFieldValue;
  provenance: RevenueFieldEvidence | null;
  provenanceHistoryCount: number;
};

function currentValueProvenance(
  history: RevenueFieldEvidence[],
  value: CustomFieldValue,
): RevenueFieldEvidence | null {
  const matchesCurrentValue = (evidence: RevenueFieldEvidence): boolean => {
    try {
      return JSON.stringify(JSON.parse(evidence.extractedValueJson)) === JSON.stringify(value);
    } catch {
      return false;
    }
  };
  return (
    history.find((evidence) => evidence.status === "accepted" && matchesCurrentValue(evidence)) ??
    history.find((evidence) => evidence.status === "proposed" && matchesCurrentValue(evidence)) ??
    null
  );
}

export const BASE_MIGRATION_CUSTOM_FIELDS: Array<{
  resourceType: RevenueResourceType;
  name: string;
  key: string;
  fieldType: RevenueCustomFieldType;
}> = [
  {
    resourceType: "account",
    name: "Current monitoring stack",
    key: "current_monitoring_stack",
    fieldType: "text",
  },
  {
    resourceType: "deal",
    name: "Competitor or current provider",
    key: "competitor_current_provider",
    fieldType: "text",
  },
  {
    resourceType: "deal",
    name: "Plan or product interest",
    key: "plan_product_interest",
    fieldType: "text",
  },
  {
    resourceType: "account",
    name: "Company or infrastructure size",
    key: "company_infrastructure_size",
    fieldType: "text",
  },
  {
    resourceType: "account",
    name: "Geographic or compliance requirements",
    key: "geographic_compliance_requirements",
    fieldType: "text",
  },
  {
    resourceType: "account",
    name: "Stripe customer ID",
    key: "stripe_customer_id",
    fieldType: "text",
  },
  {
    resourceType: "deal",
    name: "Qualification score",
    key: "qualification_score",
    fieldType: "number",
  },
  {
    resourceType: "deal",
    name: "Qualification signals",
    key: "qualification_signals",
    fieldType: "text",
  },
  {
    resourceType: "deal",
    name: "Procurement or security status",
    key: "procurement_security_status",
    fieldType: "text",
  },
  {
    resourceType: "account",
    name: "Original Base row ID",
    key: "original_base_row_id",
    fieldType: "text",
  },
  {
    resourceType: "contact",
    name: "Original Base row ID",
    key: "original_base_row_id",
    fieldType: "text",
  },
  {
    resourceType: "deal",
    name: "Original Base row ID",
    key: "original_base_row_id",
    fieldType: "text",
  },
];

export function customFieldKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function parseOptions(optionsJson: string): string[] {
  try {
    const value = JSON.parse(optionsJson);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function normalizedCustomFieldSearchValue(value: CustomFieldValue): string {
  if (value === null) return "";
  if (Array.isArray(value))
    return value
      .map((item) => item.trim().toLowerCase())
      .sort()
      .join("|");
  return String(value).trim().toLowerCase();
}

export function validateCustomFieldValue(
  field: RevenueCustomField,
  value: unknown,
): CustomFieldValue {
  if (value === null || value === "") {
    if (field.required) throw new Error(`${field.name} is required`);
    return null;
  }
  switch (field.fieldType) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${field.name} must be a number`);
      }
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${field.name} must be true or false`);
      return value;
    case "multi_select": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${field.name} must be a list`);
      }
      const options = new Set(parseOptions(field.optionsJson));
      const selected = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
      if (options.size > 0 && selected.some((item) => !options.has(item))) {
        throw new Error(`${field.name} contains an unknown option`);
      }
      return selected;
    }
    case "select": {
      if (typeof value !== "string") throw new Error(`${field.name} must be text`);
      const options = parseOptions(field.optionsJson);
      if (options.length > 0 && !options.includes(value)) {
        throw new Error(`${field.name} contains an unknown option`);
      }
      return value;
    }
    case "date": {
      if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
        throw new Error(`${field.name} must be an ISO date`);
      }
      return value;
    }
    case "url": {
      if (typeof value !== "string") throw new Error(`${field.name} must be a URL`);
      try {
        new URL(value);
      } catch {
        throw new Error(`${field.name} must be a valid URL`);
      }
      return value;
    }
    case "text":
    default:
      if (typeof value !== "string") throw new Error(`${field.name} must be text`);
      return value.slice(0, 20_000);
  }
}

export async function listCustomFields(
  companyId: string,
  resourceType?: RevenueResourceType,
  includeArchived = false,
): Promise<RevenueCustomField[]> {
  const qb = AppDataSource.getRepository(RevenueCustomField)
    .createQueryBuilder("f")
    .where("f.companyId = :companyId", { companyId });
  if (resourceType) qb.andWhere("f.resourceType = :resourceType", { resourceType });
  if (!includeArchived) qb.andWhere("f.archivedAt IS NULL");
  return qb.orderBy("f.resourceType", "ASC").addOrderBy("f.sortOrder", "ASC").getMany();
}

export async function createCustomField(
  companyId: string,
  input: {
    resourceType: RevenueResourceType;
    name: string;
    key?: string;
    fieldType: RevenueCustomFieldType;
    options?: string[];
    required?: boolean;
  },
): Promise<RevenueCustomField> {
  const repo = AppDataSource.getRepository(RevenueCustomField);
  const key = customFieldKey(input.key || input.name);
  if (!key) throw new Error("Custom field key is required");
  if (await repo.findOneBy({ companyId, resourceType: input.resourceType, key })) {
    throw new Error("That custom field key already exists");
  }
  const sortOrder = await repo.count({ where: { companyId, resourceType: input.resourceType } });
  return repo.save(
    repo.create({
      companyId,
      resourceType: input.resourceType,
      key,
      name: input.name.trim(),
      fieldType: input.fieldType,
      optionsJson: JSON.stringify(input.options ?? []),
      required: input.required ?? false,
      sortOrder,
      archivedAt: null,
    }),
  );
}

export async function updateCustomField(
  companyId: string,
  id: string,
  patch: {
    name?: string;
    options?: string[];
    required?: boolean;
    sortOrder?: number;
    archived?: boolean;
  },
): Promise<RevenueCustomField | null> {
  const repo = AppDataSource.getRepository(RevenueCustomField);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.options !== undefined) row.optionsJson = JSON.stringify(patch.options);
  if (patch.required !== undefined) row.required = patch.required;
  if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
  if (patch.archived !== undefined) row.archivedAt = patch.archived ? new Date() : null;
  return repo.save(row);
}

/**
 * Install the opinionated field set used by the linked Base migration.
 *
 * Idempotent and non-destructive: an existing field with the same stable key
 * wins, including its chosen type/options. An archived match is restored so a
 * second setup run does not fail on the unique key while still leaving the
 * company's definition intact.
 */
export async function installBaseMigrationCustomFields(
  companyId: string,
): Promise<{ created: RevenueCustomField[]; existing: RevenueCustomField[] }> {
  const repo = AppDataSource.getRepository(RevenueCustomField);
  const created: RevenueCustomField[] = [];
  const existing: RevenueCustomField[] = [];
  for (const definition of BASE_MIGRATION_CUSTOM_FIELDS) {
    const current = await repo.findOneBy({
      companyId,
      resourceType: definition.resourceType,
      key: definition.key,
    });
    if (current) {
      if (current.archivedAt) {
        current.archivedAt = null;
        await repo.save(current);
      }
      existing.push(current);
      continue;
    }
    created.push(
      await createCustomField(companyId, {
        ...definition,
        required: false,
      }),
    );
  }
  return { created, existing };
}

export async function getCustomValues(
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
): Promise<CustomValueResult[]> {
  const fields = await listCustomFields(companyId, resourceType);
  if (fields.length === 0) return [];
  const values = await AppDataSource.getRepository(RevenueCustomValue).find({
    where: { companyId, resourceType, resourceId, fieldId: In(fields.map((field) => field.id)) },
  });
  const byField = new Map(values.map((row) => [row.fieldId, row]));
  const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).find({
    where: {
      companyId,
      resourceType,
      resourceId,
      fieldKey: In(fields.map((field) => `custom:${field.key}`)),
    },
    order: { createdAt: "DESC" },
  });
  const evidenceByKey = new Map<string, RevenueFieldEvidence[]>();
  for (const row of evidence) {
    const rows = evidenceByKey.get(row.fieldKey) ?? [];
    rows.push(row);
    evidenceByKey.set(row.fieldKey, rows);
  }
  return fields.map((field) => {
    const row = byField.get(field.id);
    const history = evidenceByKey.get(`custom:${field.key}`) ?? [];
    if (!row) {
      return {
        field,
        value: null,
        provenance: currentValueProvenance(history, null),
        provenanceHistoryCount: history.length,
      };
    }
    try {
      const value = JSON.parse(row.valueJson) as CustomFieldValue;
      return {
        field,
        value,
        provenance: currentValueProvenance(history, value),
        provenanceHistoryCount: history.length,
      };
    } catch {
      return {
        field,
        value: null,
        provenance: null,
        provenanceHistoryCount: history.length,
      };
    }
  });
}

async function recordCustomValueEvidence(
  manager: EntityManager,
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
  field: RevenueCustomField,
  value: CustomFieldValue,
  provenance: CustomValueProvenance | undefined,
  actor: RevenueOperationActor,
): Promise<void> {
  await manager
    .createQueryBuilder()
    .update(RevenueFieldEvidence)
    .set({ status: "superseded", verificationState: "superseded" })
    .where("companyId = :companyId", { companyId })
    .andWhere("resourceType = :resourceType", { resourceType })
    .andWhere("resourceId = :resourceId", { resourceId })
    .andWhere("fieldKey = :fieldKey", { fieldKey: `custom:${field.key}` })
    .andWhere("status IN (:...statuses)", { statuses: ["proposed", "accepted"] })
    .execute();
  const observedAt = provenance?.observedAt ?? new Date();
  const verified = !provenance || provenance.verificationState === "verified";
  const verifyingActor: {
    kind: "member" | "ai_employee" | "system";
    id: string | null;
  } = actor.userId
    ? { kind: "member", id: actor.userId }
    : actor.employeeId
      ? { kind: "ai_employee", id: actor.employeeId }
      : { kind: "system", id: null };
  await manager.save(
    RevenueFieldEvidence,
    manager.create(RevenueFieldEvidence, {
      companyId,
      resourceType,
      resourceId,
      fieldKey: `custom:${field.key}`,
      sourceType: provenance?.sourceType ?? "manual",
      sourceId:
        provenance?.sourceId ??
        `${verifyingActor.kind}:${verifyingActor.id ?? "unknown"}:${resourceId}:${field.key}:${observedAt.toISOString()}`,
      sourceLabel: provenance?.sourceLabel ?? "Direct Revenue field update",
      extractedValueJson: JSON.stringify(value),
      normalizedValue: normalizedCustomFieldSearchValue(value),
      confidence: Math.min(Math.max(Math.round(provenance?.confidence ?? 100), 0), 100),
      status: verified ? "accepted" : "proposed",
      verificationState: verified ? "verified" : "unverified",
      extractionMethod: provenance?.extractionMethod ?? "manual",
      observedAt,
      extractedAt: observedAt,
      lastVerifiedAt: verified ? (provenance?.lastVerifiedAt ?? observedAt) : null,
      humanConfirmedAt: verified && actor.userId ? observedAt : null,
      humanConfirmedById: verified ? (actor.userId ?? null) : null,
      verifyingActorType: verified ? verifyingActor.kind : null,
      verifyingActorId: verified ? verifyingActor.id : null,
      metadataJson: JSON.stringify({
        extractionMethod: provenance?.extractionMethod ?? "manual",
        verificationState: verified ? "verified" : "unverified",
        verifyingActor,
        ...(provenance?.metadata ?? {}),
      }),
    }),
  );
}

export async function setCustomValues(
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
  values: Record<string, unknown>,
  options: { provenance?: CustomValueProvenance; actor?: RevenueOperationActor } = {},
): Promise<CustomValueResult[]> {
  if (options.provenance && options.provenance.verificationState !== "verified") {
    throw new Error(
      "Unverified evidence cannot replace a current custom-field value; review it first",
    );
  }
  await AppDataSource.transaction(async (manager) => {
    const entity =
      resourceType === "contact"
        ? Contact
        : resourceType === "account"
          ? Customer
          : resourceType === "deal"
            ? Deal
            : Partnership;
    if ((await manager.count(entity, { where: { companyId, id: resourceId } })) === 0) {
      throw new Error("Revenue resource not found");
    }
    const fields = await manager.find(RevenueCustomField, {
      where: { companyId, resourceType, archivedAt: IsNull() },
      order: { sortOrder: "ASC" },
    });
    const byKey = new Map(fields.map((field) => [field.key, field]));
    for (const [key, rawValue] of Object.entries(values)) {
      const field = byKey.get(key);
      if (!field) throw new Error(`Unknown custom field: ${key}`);
      const value = validateCustomFieldValue(field, rawValue);
      const existing = await manager.findOneBy(RevenueCustomValue, {
        companyId,
        fieldId: field.id,
        resourceId,
      });
      let existingValue: CustomFieldValue = null;
      if (existing) {
        try {
          existingValue = JSON.parse(existing.valueJson) as CustomFieldValue;
        } catch {
          existingValue = null;
        }
      }
      if (JSON.stringify(existingValue) === JSON.stringify(value) && !options.provenance) {
        continue;
      }
      if (value === null) {
        if (existing) await manager.delete(RevenueCustomValue, { companyId, id: existing.id });
      } else {
        await manager.save(
          RevenueCustomValue,
          manager.create(RevenueCustomValue, {
            ...existing,
            companyId,
            fieldId: field.id,
            resourceType,
            resourceId,
            valueJson: JSON.stringify(value),
            searchValue: normalizedCustomFieldSearchValue(value),
          }),
        );
      }
      await recordCustomValueEvidence(
        manager,
        companyId,
        resourceType,
        resourceId,
        field,
        value,
        options.provenance,
        options.actor ?? {},
      );
    }
  });
  return getCustomValues(companyId, resourceType, resourceId);
}

export async function matchingResourceIds(
  companyId: string,
  resourceType: RevenueResourceType,
  fieldKey: string,
  value: string,
): Promise<string[]> {
  const field = await AppDataSource.getRepository(RevenueCustomField).findOneBy({
    companyId,
    resourceType,
    key: customFieldKey(fieldKey),
    archivedAt: IsNull(),
  });
  if (!field) return [];
  const rows = await AppDataSource.getRepository(RevenueCustomValue).find({
    where: {
      companyId,
      resourceType,
      fieldId: field.id,
      searchValue: value.trim().toLowerCase(),
    },
    select: { resourceId: true },
  });
  return rows.map((row) => row.resourceId);
}

/**
 * Backfill honest provenance for rows created before field-level evidence
 * existed, and normalize metadata on older enrichment evidence. This is
 * deliberately idempotent and runs in bounded pages from Revenue boot.
 */
export async function backfillRevenueProvenanceMetadata(): Promise<{
  evidenceUpdated: number;
  legacyValuesRecorded: number;
}> {
  const evidenceRepo = AppDataSource.getRepository(RevenueFieldEvidence);
  let evidenceUpdated = 0;
  for (;;) {
    const rows = await evidenceRepo.find({
      where: [{ observedAt: IsNull() }, { extractionMethod: "" }],
      order: { id: "ASC" },
      take: 500,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      row.observedAt ??= row.extractedAt;
      row.extractionMethod ||= `${row.sourceType}_legacy`;
      row.verificationState =
        row.status === "accepted"
          ? "verified"
          : row.status === "rejected"
            ? "rejected"
            : row.status === "superseded"
              ? "superseded"
              : "unverified";
      if (row.humanConfirmedById && !row.verifyingActorType) {
        row.verifyingActorType = "member";
        row.verifyingActorId = row.humanConfirmedById;
      }
      if (row.status === "accepted" && !row.lastVerifiedAt) {
        row.lastVerifiedAt = row.humanConfirmedAt ?? row.extractedAt;
      }
    }
    await evidenceRepo.save(rows, { chunk: 500 });
    evidenceUpdated += rows.length;
  }

  const valueRepo = AppDataSource.getRepository(RevenueCustomValue);
  const fieldRepo = AppDataSource.getRepository(RevenueCustomField);
  const fields = new Map((await fieldRepo.find()).map((field) => [field.id, field]));
  let cursor = "";
  let legacyValuesRecorded = 0;
  for (;;) {
    const values = await valueRepo.find({
      where: cursor ? { id: MoreThan(cursor) } : {},
      order: { id: "ASC" },
      take: 250,
    });
    if (values.length === 0) break;
    cursor = values.at(-1)!.id;
    const legacyIds = values.map((value) => `legacy:${value.id}`);
    const existing = new Set(
      (
        await evidenceRepo.find({
          where: { sourceType: "manual", sourceId: In(legacyIds) },
          select: { sourceId: true },
        })
      ).map((row) => row.sourceId),
    );
    const missing = values.flatMap((value) => {
      const field = fields.get(value.fieldId);
      const sourceId = `legacy:${value.id}`;
      if (!field || existing.has(sourceId)) return [];
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(value.valueJson) as unknown;
      } catch {
        parsed = null;
      }
      return [
        evidenceRepo.create({
          companyId: value.companyId,
          resourceType: value.resourceType,
          resourceId: value.resourceId,
          fieldKey: `custom:${field.key}`,
          sourceType: "manual",
          sourceId,
          sourceLabel: "Legacy value — source unknown",
          extractedValueJson: JSON.stringify(parsed),
          normalizedValue: value.searchValue,
          confidence: 0,
          status: "proposed",
          verificationState: "unverified",
          extractionMethod: "legacy_backfill",
          observedAt: value.createdAt,
          extractedAt: value.createdAt,
          lastVerifiedAt: null,
          humanConfirmedAt: null,
          humanConfirmedById: null,
          verifyingActorType: null,
          verifyingActorId: null,
          metadataJson: JSON.stringify({ legacyValueId: value.id }),
        }),
      ];
    });
    if (missing.length > 0) {
      await evidenceRepo.save(missing, { chunk: 250 });
      legacyValuesRecorded += missing.length;
    }
  }
  return { evidenceUpdated, legacyValuesRecorded };
}
