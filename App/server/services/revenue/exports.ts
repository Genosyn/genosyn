import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import { listFollowUps } from "./followUps.js";

export const REVENUE_EXPORT_RESOURCES = [
  "accounts",
  "contacts",
  "deals",
  "partnerships",
  "buying_committees",
  "follow_ups",
  "documents",
  "stage_definitions",
  "custom_fields",
  "import_reconciliation",
] as const;

export type RevenueExportResource = (typeof REVENUE_EXPORT_RESOURCES)[number];

export type RevenueExportPage = {
  resource: RevenueExportResource;
  generatedAt: Date;
  offset: number;
  limit: number;
  total: number | null;
  nextOffset: number | null;
  rows: Array<Record<string, unknown>>;
};

function plain(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

export async function exportRevenueSnapshotPage(
  companyId: string,
  resource: RevenueExportResource,
  opts: { limit?: number; offset?: number } = {},
): Promise<RevenueExportPage> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (resource === "follow_ups") {
    const items = await listFollowUps(companyId, {
      state: "all",
      closedDeals: "include",
      limit: limit + 1,
      offset,
    });
    const hasMore = items.length > limit;
    return {
      resource,
      generatedAt: new Date(),
      offset,
      limit,
      total: null,
      nextOffset: hasMore ? offset + limit : null,
      rows: items.slice(0, limit).map(plain),
    };
  }
  const entity =
    resource === "accounts"
      ? Customer
      : resource === "contacts"
        ? Contact
        : resource === "deals"
          ? Deal
          : resource === "partnerships"
            ? Partnership
            : resource === "buying_committees"
              ? DealContact
              : resource === "documents"
                ? RevenueDocument
                : resource === "stage_definitions"
                  ? DealStage
                  : resource === "custom_fields"
                    ? RevenueCustomField
                    : RevenueImportRow;
  const repo = AppDataSource.getRepository(entity);
  const qb = repo
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy(resource === "import_reconciliation" ? "row.sortOrder" : "row.createdAt", "ASC")
    .addOrderBy("row.id", "ASC")
    .skip(offset)
    .take(limit)
    .getMany();
  return {
    resource,
    generatedAt: new Date(),
    offset,
    limit,
    total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    rows: rows.map(plain),
  };
}

function csvValue(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function revenueExportCsv(page: RevenueExportPage): string {
  const columns = [...new Set(page.rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return "";
  return [
    columns.map(csvValue).join(","),
    ...page.rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
}
