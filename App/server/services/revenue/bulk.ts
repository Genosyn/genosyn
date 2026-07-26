import { type EntityManager } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import {
  Activity,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../../db/entities/Activity.js";
import {
  Contact,
  type ContactLifecycleStage,
} from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal, type DealStatus } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import {
  createRevenueOperation,
  type OperationRowWrite,
  type RevenueOperationActor,
} from "./operations.js";
import {
  normalizedCustomFieldSearchValue,
  validateCustomFieldValue,
} from "./customFields.js";
import { assertRevenueOwner } from "./integrity.js";

export type BulkResourceType = "account" | "contact" | "deal" | "partnership" | "follow_up";
export type FollowUpSource = "task" | "deal" | "partnership";

export type BulkTarget = {
  ids?: string[];
  followUpIds?: Array<{ source: FollowUpSource; id: string }>;
  filter?: {
    q?: string;
    includeArchived?: boolean;
    ownerId?: string;
    ownerEmployeeId?: string;
    unassigned?: boolean;
    accountStatus?: "prospect" | "customer" | "former";
    lifecycleStage?: ContactLifecycleStage;
    dealStatus?: DealStatus;
    dealStageId?: string;
    partnershipStatus?: string;
    followUpSource?: FollowUpSource;
    taskStatus?: ActivityTaskStatus;
    priority?: ActivityPriority;
    linkedResourceType?: "account" | "contact" | "deal" | "partnership";
    linkedResourceId?: string;
    dueFrom?: Date;
    dueTo?: Date;
    staleBefore?: Date;
    createdBefore?: Date;
    closedDeals?: "include" | "only" | "exclude";
  };
};

export type BulkAction =
  | {
      type: "assign_owner";
      ownerId: string | null;
      ownerEmployeeId: string | null;
    }
  | { type: "set_contact_lifecycle"; lifecycleStage: ContactLifecycleStage }
  | { type: "set_account_status"; accountStatus: "prospect" | "customer" | "former" }
  | { type: "set_custom_fields"; values: Record<string, unknown> }
  | { type: "archive"; archived: boolean }
  | {
      type: "update_follow_up";
      taskStatus?: ActivityTaskStatus;
      priority?: ActivityPriority;
      assignedUserId?: string | null;
      assignedEmployeeId?: string | null;
      dueAt?: Date | null;
      reminderAt?: Date | null;
    };

export type BulkRequest = {
  resourceType: BulkResourceType;
  target: BulkTarget;
  action: BulkAction;
  dryRun: boolean;
  idempotencyKey?: string;
};

export type BulkRowResult = {
  resourceType: BulkResourceType;
  resourceId: string;
  source?: FollowUpSource;
  label: string;
  status: "applied" | "valid" | "skipped" | "failed";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  error?: string;
};

export type BulkResult = {
  dryRun: boolean;
  matched: number;
  valid: number;
  applied: number;
  skipped: number;
  failed: number;
  operationId?: string;
  replayed?: boolean;
  rows: BulkRowResult[];
};

type CoreRow = Customer | Contact | Deal | Partnership;
type FollowUpRow =
  | { source: "task"; row: Activity }
  | { source: "deal"; row: Deal }
  | { source: "partnership"; row: Partnership };
type SelectedRow = CoreRow | FollowUpRow;

function isFollowUpRow(row: SelectedRow): row is FollowUpRow {
  return "source" in row && "row" in row;
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])].slice(0, 5_000);
}

function coreLabel(resourceType: Exclude<BulkResourceType, "follow_up">, row: CoreRow): string {
  return resourceType === "deal" ? (row as Deal).title : (row as Customer | Contact | Partnership).name;
}

async function selectedCoreRows(
  manager: EntityManager,
  companyId: string,
  resourceType: Exclude<BulkResourceType, "follow_up">,
  target: BulkTarget,
): Promise<{ rows: CoreRow[]; missing: string[] }> {
  const ids = uniqueIds(target.ids);
  const entity =
    resourceType === "account"
      ? Customer
      : resourceType === "contact"
        ? Contact
        : resourceType === "deal"
          ? Deal
          : Partnership;
  const qb = manager
    .getRepository(entity)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId });
  if (ids.length > 0) {
    qb.andWhere("row.id IN (:...ids)", { ids });
  } else {
    const filter = target.filter ?? {};
    if (!filter.includeArchived) qb.andWhere("row.archivedAt IS NULL");
    if (filter.ownerId) qb.andWhere("row.ownerId = :ownerId", { ownerId: filter.ownerId });
    if (filter.ownerEmployeeId) {
      qb.andWhere("row.ownerEmployeeId = :ownerEmployeeId", {
        ownerEmployeeId: filter.ownerEmployeeId,
      });
    }
    if (filter.unassigned) {
      qb.andWhere("row.ownerId IS NULL").andWhere("row.ownerEmployeeId IS NULL");
    }
    if (filter.q) {
      const labelField = resourceType === "deal" ? "title" : "name";
      qb.andWhere(`LOWER(row.${labelField}) LIKE :q`, {
        q: `%${filter.q.toLowerCase()}%`,
      });
    }
    if (resourceType === "account" && filter.accountStatus) {
      qb.andWhere("row.accountStatus = :accountStatus", {
        accountStatus: filter.accountStatus,
      });
    }
    if (resourceType === "contact" && filter.lifecycleStage) {
      qb.andWhere("row.lifecycleStage = :lifecycleStage", {
        lifecycleStage: filter.lifecycleStage,
      });
    }
    if (resourceType === "deal") {
      if (filter.dealStatus) {
        qb.andWhere("row.status = :dealStatus", { dealStatus: filter.dealStatus });
      }
      if (filter.dealStageId) {
        qb.andWhere("row.stageId = :dealStageId", { dealStageId: filter.dealStageId });
      }
    }
    if (resourceType === "partnership" && filter.partnershipStatus) {
      qb.andWhere("row.status = :partnershipStatus", {
        partnershipStatus: filter.partnershipStatus,
      });
    }
  }
  const rows = (await qb.orderBy("row.updatedAt", "DESC").take(5_000).getMany()) as CoreRow[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

async function selectedFollowUps(
  manager: EntityManager,
  companyId: string,
  target: BulkTarget,
): Promise<{ rows: FollowUpRow[]; missing: Array<{ source: FollowUpSource; id: string }> }> {
  const requested = target.followUpIds?.slice(0, 5_000) ?? [];
  const bySource = (source: FollowUpSource) =>
    [...new Set(requested.filter((item) => item.source === source).map((item) => item.id))];
  const filter = target.filter ?? {};
  const taskQb = manager
    .getRepository(Activity)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.kind = 'task'");
  const dealQb = manager
    .getRepository(Deal)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.nextFollowUpAt IS NOT NULL");
  const partnershipQb = manager
    .getRepository(Partnership)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.nextFollowUpAt IS NOT NULL");

  if (requested.length > 0) {
    const taskIds = bySource("task");
    const dealIds = bySource("deal");
    const partnershipIds = bySource("partnership");
    if (taskIds.length > 0) taskQb.andWhere("row.id IN (:...taskIds)", { taskIds });
    else taskQb.andWhere("1 = 0");
    if (dealIds.length > 0) dealQb.andWhere("row.id IN (:...dealIds)", { dealIds });
    else dealQb.andWhere("1 = 0");
    if (partnershipIds.length > 0) {
      partnershipQb.andWhere("row.id IN (:...partnershipIds)", { partnershipIds });
    } else partnershipQb.andWhere("1 = 0");
  } else {
    if (filter.followUpSource && filter.followUpSource !== "task") taskQb.andWhere("1 = 0");
    if (filter.followUpSource && filter.followUpSource !== "deal") dealQb.andWhere("1 = 0");
    if (filter.followUpSource && filter.followUpSource !== "partnership") {
      partnershipQb.andWhere("1 = 0");
    }
    taskQb.andWhere("row.taskStatus = :taskStatus", {
      taskStatus: filter.taskStatus ?? "open",
    });
    if (filter.priority) taskQb.andWhere("row.priority = :priority", { priority: filter.priority });
    if (filter.ownerId) {
      taskQb.andWhere("row.assignedUserId = :ownerId", { ownerId: filter.ownerId });
      dealQb.andWhere("row.ownerId = :ownerId", { ownerId: filter.ownerId });
      partnershipQb.andWhere("row.ownerId = :ownerId", { ownerId: filter.ownerId });
    }
    if (filter.ownerEmployeeId) {
      taskQb.andWhere("row.assignedEmployeeId = :ownerEmployeeId", {
        ownerEmployeeId: filter.ownerEmployeeId,
      });
      dealQb.andWhere("row.ownerEmployeeId = :ownerEmployeeId", {
        ownerEmployeeId: filter.ownerEmployeeId,
      });
      partnershipQb.andWhere("row.ownerEmployeeId = :ownerEmployeeId", {
        ownerEmployeeId: filter.ownerEmployeeId,
      });
    }
    if (filter.unassigned) {
      taskQb.andWhere("row.assignedUserId IS NULL AND row.assignedEmployeeId IS NULL");
      dealQb.andWhere("row.ownerId IS NULL AND row.ownerEmployeeId IS NULL");
      partnershipQb.andWhere("row.ownerId IS NULL AND row.ownerEmployeeId IS NULL");
    }
    const dueClauses: Array<[string, Date]> = [];
    if (filter.dueFrom) dueClauses.push([">=", filter.dueFrom]);
    if (filter.dueTo) dueClauses.push(["<=", filter.dueTo]);
    if (filter.staleBefore) dueClauses.push(["<=", filter.staleBefore]);
    for (const [operator, date] of dueClauses) {
      const key = `date${operator === ">=" ? "From" : "To"}${date.getTime()}`;
      taskQb.andWhere(`row.dueAt ${operator} :${key}`, { [key]: date });
      dealQb.andWhere(`row.nextFollowUpAt ${operator} :${key}`, { [key]: date });
      partnershipQb.andWhere(`row.nextFollowUpAt ${operator} :${key}`, { [key]: date });
    }
    if (filter.createdBefore) {
      taskQb.andWhere("row.createdAt <= :createdBefore", {
        createdBefore: filter.createdBefore,
      });
      dealQb.andWhere("row.createdAt <= :createdBefore", {
        createdBefore: filter.createdBefore,
      });
      partnershipQb.andWhere("row.createdAt <= :createdBefore", {
        createdBefore: filter.createdBefore,
      });
    }
    if (filter.linkedResourceType && filter.linkedResourceId) {
      const field =
        filter.linkedResourceType === "account"
          ? "customerId"
          : `${filter.linkedResourceType}Id`;
      taskQb.andWhere(`row.${field} = :linkedResourceId`, {
        linkedResourceId: filter.linkedResourceId,
      });
      if (filter.linkedResourceType === "deal") {
        dealQb.andWhere("row.id = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
      } else if (filter.linkedResourceType === "account") {
        dealQb.andWhere("row.customerId = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
        partnershipQb.andWhere("row.customerId = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
      } else if (filter.linkedResourceType === "partnership") {
        partnershipQb.andWhere("row.id = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
      } else {
        dealQb.andWhere("row.primaryContactId = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
        partnershipQb.andWhere("1 = 0");
      }
    }
    if (filter.dealStageId) {
      dealQb.andWhere("row.stageId = :dealStageId", { dealStageId: filter.dealStageId });
    }
    if (filter.dealStatus) {
      dealQb.andWhere("row.status = :dealStatus", { dealStatus: filter.dealStatus });
    }
    if (filter.closedDeals === "only") dealQb.andWhere("row.status IN ('won', 'lost')");
    if (filter.closedDeals === "exclude") dealQb.andWhere("row.status = 'open'");
  }

  const [tasks, deals, partnerships] = await Promise.all([
    taskQb.orderBy("row.dueAt", "ASC").take(5_000).getMany(),
    dealQb.orderBy("row.nextFollowUpAt", "ASC").take(5_000).getMany(),
    partnershipQb.orderBy("row.nextFollowUpAt", "ASC").take(5_000).getMany(),
  ]);
  const rows: FollowUpRow[] = [
    ...tasks.map((row) => ({ source: "task" as const, row })),
    ...deals.map((row) => ({ source: "deal" as const, row })),
    ...partnerships.map((row) => ({ source: "partnership" as const, row })),
  ];
  const found = new Set(rows.map(({ source, row }) => `${source}:${row.id}`));
  return {
    rows,
    missing: requested.filter((item) => !found.has(`${item.source}:${item.id}`)),
  };
}

function standardPatch(
  resourceType: BulkResourceType,
  row: SelectedRow,
  action: BulkAction,
): { before: Record<string, unknown>; after: Record<string, unknown>; entityType: string } {
  const current = isFollowUpRow(row) ? row.row : row;
  if (action.type === "assign_owner") {
    if (resourceType === "follow_up") throw new Error("Use the follow-up action to reassign");
    const owned = current as CoreRow;
    return {
      before: { ownerId: owned.ownerId, ownerEmployeeId: owned.ownerEmployeeId },
      after: { ownerId: action.ownerId, ownerEmployeeId: action.ownerEmployeeId },
      entityType: resourceType,
    };
  }
  if (action.type === "set_contact_lifecycle") {
    if (resourceType !== "contact") throw new Error("Lifecycle changes apply only to Contacts");
    return {
      before: { lifecycleStage: (current as Contact).lifecycleStage },
      after: { lifecycleStage: action.lifecycleStage },
      entityType: "contact",
    };
  }
  if (action.type === "set_account_status") {
    if (resourceType !== "account") throw new Error("Account status applies only to Accounts");
    return {
      before: { accountStatus: (current as Customer).accountStatus },
      after: { accountStatus: action.accountStatus },
      entityType: "account",
    };
  }
  if (action.type === "archive") {
    if (resourceType === "follow_up") throw new Error("Follow-ups are cancelled, not archived");
    const archivable = current as CoreRow;
    return {
      before: { archivedAt: archivable.archivedAt },
      after: { archivedAt: action.archived ? new Date() : null },
      entityType: resourceType,
    };
  }
  if (action.type !== "update_follow_up" || resourceType !== "follow_up" || !isFollowUpRow(row)) {
    throw new Error("That action does not apply to this resource");
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (row.source === "task") {
    const task = row.row;
    if (action.taskStatus !== undefined) {
      before.taskStatus = task.taskStatus;
      before.completedAt = task.completedAt;
      after.taskStatus = action.taskStatus;
      after.completedAt = action.taskStatus === "completed" ? new Date() : null;
    }
    if (action.priority !== undefined) {
      before.priority = task.priority;
      after.priority = action.priority;
    }
    if (action.assignedUserId !== undefined || action.assignedEmployeeId !== undefined) {
      before.assignedUserId = task.assignedUserId;
      before.assignedEmployeeId = task.assignedEmployeeId;
      after.assignedUserId = action.assignedUserId ?? null;
      after.assignedEmployeeId = action.assignedEmployeeId ?? null;
    }
    if (action.dueAt !== undefined) {
      before.dueAt = task.dueAt;
      after.dueAt = action.dueAt;
    }
    if (action.reminderAt !== undefined) {
      before.reminderAt = task.reminderAt;
      after.reminderAt = action.reminderAt;
    }
    return { before, after, entityType: "activity" };
  }
  if (action.priority !== undefined) {
    throw new Error("Priority is available only on task follow-ups");
  }
  const scheduled = row.row as Deal | Partnership;
  const dueField = "nextFollowUpAt";
  const reminderField = row.source === "deal" ? "followUpReminderAt" : "reminderAt";
  if (action.taskStatus && action.taskStatus !== "open") {
    before[dueField] = scheduled.nextFollowUpAt;
    before[reminderField] =
      row.source === "deal" ? (scheduled as Deal).followUpReminderAt : (scheduled as Partnership).reminderAt;
    after[dueField] = null;
    after[reminderField] = null;
  }
  if (action.assignedUserId !== undefined || action.assignedEmployeeId !== undefined) {
    before.ownerId = scheduled.ownerId;
    before.ownerEmployeeId = scheduled.ownerEmployeeId;
    after.ownerId = action.assignedUserId ?? null;
    after.ownerEmployeeId = action.assignedEmployeeId ?? null;
  }
  if (action.dueAt !== undefined) {
    before[dueField] = scheduled.nextFollowUpAt;
    after[dueField] = action.dueAt;
  }
  if (action.reminderAt !== undefined) {
    before[reminderField] =
      row.source === "deal" ? (scheduled as Deal).followUpReminderAt : (scheduled as Partnership).reminderAt;
    after[reminderField] = action.reminderAt;
  }
  return { before, after, entityType: row.source };
}

function samePatch(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const normalize = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  return Object.keys(after).every(
    (key) => JSON.stringify(normalize(before[key])) === JSON.stringify(normalize(after[key])),
  );
}

async function applyCustomFields(
  manager: EntityManager,
  companyId: string,
  resourceType: Exclude<BulkResourceType, "follow_up">,
  resourceId: string,
  values: Record<string, unknown>,
  apply: boolean,
): Promise<{ rows: OperationRowWrite[]; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const fields = await manager.find(RevenueCustomField, {
    where: { companyId, resourceType },
  });
  const byKey = new Map(fields.filter((field) => !field.archivedAt).map((field) => [field.key, field]));
  const changes: OperationRowWrite[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const validated = Object.entries(values).map(([key, rawValue]) => {
    const field = byKey.get(key);
    if (!field) throw new Error(`Unknown custom field: ${key}`);
    return { key, field, value: validateCustomFieldValue(field, rawValue) };
  });
  for (const { key, field, value } of validated) {
    const existing = await manager.findOneBy(RevenueCustomValue, {
      companyId,
      fieldId: field.id,
      resourceId,
    });
    before[key] = existing ? JSON.parse(existing.valueJson) : null;
    after[key] = value;
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
    if (value === null && existing) {
      changes.push({
        resourceType,
        resourceId: existing.id,
        entityType: "revenue_custom_value",
        action: "clear_custom_field",
        before: Object.fromEntries(
          Object.entries(existing).map(([name, item]) => [
            name,
            item instanceof Date ? item.toISOString() : item,
          ]),
        ),
        after: null,
      });
      if (apply) await manager.delete(RevenueCustomValue, { companyId, id: existing.id });
    } else if (value !== null) {
      const next = manager.create(RevenueCustomValue, {
        ...existing,
        companyId,
        fieldId: field.id,
        resourceType,
        resourceId,
        valueJson: JSON.stringify(value),
        searchValue: normalizedCustomFieldSearchValue(value),
      });
      if (apply) await manager.save(RevenueCustomValue, next);
      changes.push({
        resourceType,
        resourceId: next.id || `${resourceId}:${field.id}`,
        entityType: "revenue_custom_value",
        action: existing ? "update_custom_field" : "create_custom_field_value",
        before: existing
          ? { valueJson: existing.valueJson, searchValue: existing.searchValue }
          : null,
        after: apply
          ? Object.fromEntries(
              Object.entries(next).map(([name, item]) => [
                name,
                item instanceof Date ? item.toISOString() : item,
              ]),
            )
          : { valueJson: next.valueJson, searchValue: next.searchValue },
      });
    }
  }
  return { rows: changes, before, after };
}

export async function runRevenueBulkOperation(
  companyId: string,
  request: BulkRequest,
  actor: RevenueOperationActor = {},
): Promise<BulkResult> {
  if (!request.target.ids?.length && !request.target.followUpIds?.length && !request.target.filter) {
    throw new Error("Choose selected IDs or a filter");
  }
  if (!request.dryRun && !request.idempotencyKey) {
    throw new Error("An idempotency key is required");
  }
  if (request.action.type === "assign_owner") {
    await assertRevenueOwner(companyId, request.action);
  }
  if (request.action.type === "update_follow_up") {
    await assertRevenueOwner(companyId, {
      ownerId: request.action.assignedUserId,
      ownerEmployeeId: request.action.assignedEmployeeId,
    });
  }

  return AppDataSource.transaction("SERIALIZABLE", async (manager) => {
    if (!request.dryRun && request.idempotencyKey) {
      const existing = await manager.findOneBy(RevenueOperation, {
        companyId,
        idempotencyKey: request.idempotencyKey,
      });
      if (existing) {
        if (existing.requestJson !== JSON.stringify(request)) {
          throw new Error("That idempotency key was already used for a different operation");
        }
        return {
          ...(JSON.parse(existing.summaryJson) as BulkResult),
          operationId: existing.id,
          replayed: true,
        };
      }
    }

    const selected =
      request.resourceType === "follow_up"
        ? await selectedFollowUps(manager, companyId, request.target)
        : await selectedCoreRows(manager, companyId, request.resourceType, request.target);
    const rows = selected.rows as SelectedRow[];
    const results: BulkRowResult[] = [];
    const operationRows: OperationRowWrite[] = [];
    for (const missing of selected.missing as Array<string | { source: FollowUpSource; id: string }>) {
      const source = typeof missing === "string" ? undefined : missing.source;
      const resourceId = typeof missing === "string" ? missing : missing.id;
      results.push({
        resourceType: request.resourceType,
        resourceId,
        source,
        label: resourceId,
        status: "failed",
        before: null,
        after: null,
        error: "Record not found",
      });
      operationRows.push({
        resourceType: request.resourceType,
        resourceId,
        entityType: source ?? request.resourceType,
        action: request.action.type,
        status: "failed",
        detail: "Record not found",
      });
    }

    for (const selectedRow of rows) {
      const row = isFollowUpRow(selectedRow) ? selectedRow.row : selectedRow;
      const source = isFollowUpRow(selectedRow) ? selectedRow.source : undefined;
      const label = isFollowUpRow(selectedRow)
        ? selectedRow.source === "task"
          ? (selectedRow.row as Activity).subject || "Follow up"
          : selectedRow.source === "deal"
            ? (selectedRow.row as Deal).title
            : (selectedRow.row as Partnership).name
        : coreLabel(
            request.resourceType as Exclude<BulkResourceType, "follow_up">,
            selectedRow,
          );
      try {
        if (request.action.type === "set_custom_fields") {
          if (request.resourceType === "follow_up") {
            throw new Error("Custom fields are not available on follow-ups");
          }
          const custom = await applyCustomFields(
            manager,
            companyId,
            request.resourceType,
            row.id,
            request.action.values,
            !request.dryRun,
          );
          const skipped = custom.rows.length === 0;
          results.push({
            resourceType: request.resourceType,
            resourceId: row.id,
            source,
            label,
            status: skipped ? "skipped" : request.dryRun ? "valid" : "applied",
            before: custom.before,
            after: custom.after,
          });
          operationRows.push(...custom.rows);
          continue;
        }
        if (
          request.action.type === "archive" &&
          !request.action.archived &&
          request.resourceType !== "follow_up"
        ) {
          const merge = await manager.findOneBy(RevenueOperation, {
            companyId,
            kind: "merge",
            resourceType: request.resourceType,
            sourceId: row.id,
            status: "completed",
          });
          if (merge) {
            throw new Error(
              `Restore blocked: this record was merged into ${merge.targetId}; undo the merge instead`,
            );
          }
        }
        const patch = standardPatch(request.resourceType, selectedRow, request.action);
        if (Object.keys(patch.after).length === 0 || samePatch(patch.before, patch.after)) {
          results.push({
            resourceType: request.resourceType,
            resourceId: row.id,
            source,
            label,
            status: "skipped",
            before: patch.before,
            after: patch.after,
          });
          continue;
        }
        if (!request.dryRun) {
          await manager
            .getRepository(
              patch.entityType === "account"
                ? Customer
                : patch.entityType === "contact"
                  ? Contact
                  : patch.entityType === "deal"
                    ? Deal
                    : patch.entityType === "partnership"
                      ? Partnership
                      : Activity,
            )
            .update({ companyId, id: row.id }, patch.after);
        }
        results.push({
          resourceType: request.resourceType,
          resourceId: row.id,
          source,
          label,
          status: request.dryRun ? "valid" : "applied",
          before: patch.before,
          after: patch.after,
        });
        operationRows.push({
          resourceType: request.resourceType,
          resourceId: row.id,
          entityType: patch.entityType,
          action: request.action.type,
          before: patch.before,
          after: patch.after,
        });
      } catch (error) {
        const message = (error as Error).message;
        results.push({
          resourceType: request.resourceType,
          resourceId: row.id,
          source,
          label,
          status: "failed",
          before: null,
          after: null,
          error: message,
        });
        operationRows.push({
          resourceType: request.resourceType,
          resourceId: row.id,
          entityType: source ?? request.resourceType,
          action: request.action.type,
          status: "failed",
          detail: message,
        });
      }
    }
    const result: BulkResult = {
      dryRun: request.dryRun,
      matched: results.length,
      valid: results.filter((row) => row.status === "valid").length,
      applied: results.filter((row) => row.status === "applied").length,
      skipped: results.filter((row) => row.status === "skipped").length,
      failed: results.filter((row) => row.status === "failed").length,
      rows: results,
    };
    if (request.dryRun) return result;
    const operation = await createRevenueOperation(manager, {
      companyId,
      kind: "bulk",
      resourceType: request.resourceType,
      status:
        result.failed > 0
          ? result.applied > 0
            ? "partial"
            : "failed"
          : "completed",
      idempotencyKey: request.idempotencyKey,
      request,
      summary: result,
      actor,
      rows: operationRows,
    });
    result.operationId = operation.id;
    operation.summaryJson = JSON.stringify(result);
    await manager.save(RevenueOperation, operation);
    return result;
  });
}
