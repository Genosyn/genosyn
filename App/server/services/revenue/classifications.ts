import { AppDataSource } from "../../db/datasource.js";
import { IsNull } from "typeorm";
import {
  REVENUE_CLASSIFICATION_KINDS,
  RevenueClassification,
  type RevenueClassificationKind,
} from "../../db/entities/RevenueClassification.js";

const DEFAULTS: Record<RevenueClassificationKind, string[]> = {
  deal_source: [
    "Inbound",
    "Outbound",
    "Referral",
    "Partner",
    "Product signal",
    "Self-Serve Upgrade",
    "Other",
  ],
  committee_role: [
    "Champion",
    "Decision maker",
    "Economic buyer",
    "Evaluator",
    "Legal",
    "Procurement",
    "Security",
    "User",
  ],
  partnership_type: ["Technology", "Channel", "Referral", "Strategic", "Community", "Other"],
  partnership_status: ["Prospecting", "In discussion", "Active", "Paused", "Ended"],
};

export function classificationValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export async function ensureRevenueClassifications(companyId: string): Promise<void> {
  const repo = AppDataSource.getRepository(RevenueClassification);
  const existing = await repo.find({ where: { companyId } });
  const keys = new Set(existing.map((row) => `${row.kind}:${row.value}`));
  const pending: RevenueClassification[] = [];
  for (const kind of REVENUE_CLASSIFICATION_KINDS) {
    DEFAULTS[kind].forEach((label, sortOrder) => {
      const value = classificationValue(label);
      if (keys.has(`${kind}:${value}`)) return;
      pending.push(
        repo.create({
          companyId,
          kind,
          value,
          label,
          sortOrder,
          archivedAt: null,
        }),
      );
    });
  }
  if (pending.length > 0) await repo.save(pending);
}

export async function listRevenueClassifications(
  companyId: string,
  kind?: RevenueClassificationKind,
  includeArchived = false,
): Promise<RevenueClassification[]> {
  await ensureRevenueClassifications(companyId);
  const qb = AppDataSource.getRepository(RevenueClassification)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId });
  if (kind) qb.andWhere("c.kind = :kind", { kind });
  if (!includeArchived) qb.andWhere("c.archivedAt IS NULL");
  return qb.orderBy("c.kind", "ASC").addOrderBy("c.sortOrder", "ASC").getMany();
}

export async function createRevenueClassification(
  companyId: string,
  input: { kind: RevenueClassificationKind; label: string; value?: string },
): Promise<RevenueClassification> {
  const repo = AppDataSource.getRepository(RevenueClassification);
  const value = classificationValue(input.value || input.label);
  if (!value) throw new Error("Classification value is required");
  const existing = await repo.findOneBy({ companyId, kind: input.kind, value });
  if (existing) throw new Error("That classification already exists");
  const sortOrder = await repo.count({ where: { companyId, kind: input.kind } });
  return repo.save(
    repo.create({
      companyId,
      kind: input.kind,
      value,
      label: input.label.trim(),
      sortOrder,
      archivedAt: null,
    }),
  );
}

export async function updateRevenueClassification(
  companyId: string,
  id: string,
  patch: { label?: string; sortOrder?: number; archived?: boolean },
): Promise<RevenueClassification | null> {
  const repo = AppDataSource.getRepository(RevenueClassification);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  if (patch.label !== undefined) row.label = patch.label.trim();
  if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
  if (patch.archived !== undefined) row.archivedAt = patch.archived ? new Date() : null;
  return repo.save(row);
}

export async function assertClassification(
  companyId: string,
  kind: RevenueClassificationKind,
  value: string,
): Promise<void> {
  if (!value) return;
  await ensureRevenueClassifications(companyId);
  const normalized = classificationValue(value);
  const row = await AppDataSource.getRepository(RevenueClassification).findOneBy({
    companyId,
    kind,
    value: normalized,
    archivedAt: IsNull(),
  });
  if (!row) throw new Error(`Unknown ${kind.replaceAll("_", " ")} classification`);
}
