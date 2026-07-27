import { AppDataSource } from "../../db/datasource.js";
import { RevenueFollowUpView } from "../../db/entities/RevenueFollowUpView.js";
import type { FollowUpListOptions } from "./followUps.js";

export type FollowUpViewFilters = Omit<FollowUpListOptions, "limit" | "offset" | "cursor">;

export type FollowUpViewActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type FollowUpViewResult = Omit<RevenueFollowUpView, "filtersJson"> & {
  filters: FollowUpViewFilters;
};

function parseFilters(value: string): FollowUpViewFilters {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FollowUpViewFilters)
      : {};
  } catch {
    return {};
  }
}

function serialize(row: RevenueFollowUpView): FollowUpViewResult {
  const { filtersJson: _filtersJson, ...plain } = row;
  return { ...plain, filters: parseFilters(row.filtersJson) };
}

export async function listFollowUpViews(companyId: string): Promise<FollowUpViewResult[]> {
  const rows = await AppDataSource.getRepository(RevenueFollowUpView).find({
    where: { companyId },
    order: { sortOrder: "ASC", name: "ASC", createdAt: "ASC" },
  });
  return rows.map(serialize);
}

export async function createFollowUpView(
  companyId: string,
  input: { name: string; filters: FollowUpViewFilters; sortOrder?: number },
  actor: FollowUpViewActor = {},
): Promise<FollowUpViewResult> {
  const repo = AppDataSource.getRepository(RevenueFollowUpView);
  const name = input.name.trim();
  if (!name) throw new Error("View name is required");
  const row = await repo.save(
    repo.create({
      companyId,
      name,
      filtersJson: JSON.stringify(input.filters),
      sortOrder: input.sortOrder ?? 0,
      createdByUserId: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
  return serialize(row);
}

export async function updateFollowUpView(
  companyId: string,
  viewId: string,
  patch: { name?: string; filters?: FollowUpViewFilters; sortOrder?: number },
): Promise<FollowUpViewResult | null> {
  const repo = AppDataSource.getRepository(RevenueFollowUpView);
  const row = await repo.findOneBy({ companyId, id: viewId });
  if (!row) return null;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("View name is required");
    row.name = name;
  }
  if (patch.filters !== undefined) row.filtersJson = JSON.stringify(patch.filters);
  if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
  return serialize(await repo.save(row));
}

export async function deleteFollowUpView(companyId: string, viewId: string): Promise<boolean> {
  const result = await AppDataSource.getRepository(RevenueFollowUpView).delete({
    companyId,
    id: viewId,
  });
  return (result.affected ?? 0) > 0;
}
