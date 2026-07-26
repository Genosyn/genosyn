import { In, IsNull } from "typeorm";
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

export type CustomFieldValue = string | number | boolean | string[] | null;

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

async function resourceExists(
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
): Promise<boolean> {
  const entity =
    resourceType === "contact"
      ? Contact
      : resourceType === "account"
        ? Customer
        : resourceType === "deal"
          ? Deal
          : Partnership;
  return (
    (await AppDataSource.getRepository(entity).count({ where: { companyId, id: resourceId } })) > 0
  );
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
): Promise<Array<{ field: RevenueCustomField; value: CustomFieldValue }>> {
  const fields = await listCustomFields(companyId, resourceType);
  if (fields.length === 0) return [];
  const values = await AppDataSource.getRepository(RevenueCustomValue).find({
    where: { companyId, resourceType, resourceId, fieldId: In(fields.map((field) => field.id)) },
  });
  const byField = new Map(values.map((row) => [row.fieldId, row]));
  return fields.map((field) => {
    const row = byField.get(field.id);
    if (!row) return { field, value: null };
    try {
      return { field, value: JSON.parse(row.valueJson) as CustomFieldValue };
    } catch {
      return { field, value: null };
    }
  });
}

export async function setCustomValues(
  companyId: string,
  resourceType: RevenueResourceType,
  resourceId: string,
  values: Record<string, unknown>,
): Promise<Array<{ field: RevenueCustomField; value: CustomFieldValue }>> {
  if (!(await resourceExists(companyId, resourceType, resourceId))) {
    throw new Error("Revenue resource not found");
  }
  const fields = await listCustomFields(companyId, resourceType);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const repo = AppDataSource.getRepository(RevenueCustomValue);
  for (const [key, rawValue] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) throw new Error(`Unknown custom field: ${key}`);
    const value = validateCustomFieldValue(field, rawValue);
    const existing = await repo.findOneBy({ companyId, fieldId: field.id, resourceId });
    if (value === null) {
      if (existing) await repo.delete({ id: existing.id });
      continue;
    }
    await repo.save(
      repo.create({
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
