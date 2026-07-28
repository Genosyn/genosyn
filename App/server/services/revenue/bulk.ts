import { In, IsNull, type EntityManager } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  Activity,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../../db/entities/Activity.js";
import { Contact, type ContactLifecycleStage } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal, type DealStatus } from "../../db/entities/Deal.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage, type DealStageKind } from "../../db/entities/DealStage.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import {
  createRevenueOperation,
  type OperationRowWrite,
  type RevenueOperationActor,
} from "./operations.js";
import { normalizedCustomFieldSearchValue, validateCustomFieldValue } from "./customFields.js";
import { assertRevenueOwner } from "./integrity.js";
import { normalizeAccountDomain } from "./accounts.js";
import { assertClassification, classificationValue } from "./classifications.js";

export type BulkResourceType = "account" | "contact" | "deal" | "partnership" | "follow_up";
export type FollowUpSource = "task" | "deal" | "partnership";

export type BulkTarget = {
  ids?: string[];
  followUpIds?: Array<{ source: FollowUpSource; id: string }>;
  filter?: {
    state?: "all" | "overdue" | "today" | "upcoming";
    q?: string;
    includeArchived?: boolean;
    ownerId?: string;
    ownerEmployeeId?: string;
    assignedUserId?: string;
    assignedEmployeeId?: string;
    unassigned?: boolean;
    accountStatus?: "prospect" | "customer" | "former";
    lifecycleStage?: ContactLifecycleStage;
    dealStatus?: DealStatus;
    dealStageId?: string;
    partnershipStatus?: string;
    source?: FollowUpSource;
    followUpSource?: FollowUpSource;
    status?: ActivityTaskStatus;
    taskStatus?: ActivityTaskStatus;
    priority?: ActivityPriority;
    linkedResourceType?: "account" | "contact" | "deal" | "partnership";
    linkedResourceId?: string;
    dueFrom?: Date;
    dueTo?: Date;
    reminderFrom?: Date;
    reminderTo?: Date;
    overdueMinDays?: number;
    overdueMaxDays?: number;
    staleBefore?: Date;
    createdBefore?: Date;
    closedDeals?: "include" | "only" | "exclude";
    archivedResources?: "include" | "only" | "exclude";
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
  | { type: "move_deal_stage"; stageId: string; lostReason?: string }
  | {
      type: "update_standard_fields";
      confirm: "UPDATE_STANDARD_FIELDS";
      values?: Record<string, unknown>;
      rows?: Array<{ id: string; values: Record<string, unknown> }>;
      notesMode?: "replace" | "append" | "clear";
    }
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
  mode?: "atomic" | "partial";
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

export type BulkExecutionProgress = {
  total: number;
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
};

export class BulkAtomicValidationError extends Error {
  constructor(public readonly result: BulkResult) {
    super(`Atomic bulk operation refused because ${result.failed} record(s) failed validation`);
  }
}

type CoreRow = Customer | Contact | Deal | Partnership;
type FollowUpRow =
  | { source: "task"; row: Activity }
  | { source: "deal"; row: Deal }
  | { source: "partnership"; row: Partnership };
type SelectedRow = CoreRow | FollowUpRow;
const BULK_SELECTION_LIMIT = 5_000;

function isFollowUpRow(row: SelectedRow): row is FollowUpRow {
  return "source" in row && "row" in row;
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])].slice(0, BULK_SELECTION_LIMIT);
}

function coreLabel(resourceType: Exclude<BulkResourceType, "follow_up">, row: CoreRow): string {
  return resourceType === "deal"
    ? (row as Deal).title
    : (row as Customer | Contact | Partnership).name;
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
  const rows = (await qb
    .orderBy("row.updatedAt", "DESC")
    .take(BULK_SELECTION_LIMIT)
    .getMany()) as CoreRow[];
  const found = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

async function selectedFollowUps(
  manager: EntityManager,
  companyId: string,
  target: BulkTarget,
): Promise<{ rows: FollowUpRow[]; missing: Array<{ source: FollowUpSource; id: string }> }> {
  const requested = target.followUpIds?.slice(0, BULK_SELECTION_LIMIT) ?? [];
  const bySource = (source: FollowUpSource) => [
    ...new Set(requested.filter((item) => item.source === source).map((item) => item.id)),
  ];
  const filter = target.filter ?? {};
  const taskQb = manager
    .getRepository(Activity)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.kind = 'task'")
    .andWhere("row.dueAt IS NOT NULL")
    .leftJoin(Deal, "taskDeal", "taskDeal.companyId = row.companyId AND taskDeal.id = row.dealId")
    .leftJoin(
      Contact,
      "taskContact",
      "taskContact.companyId = row.companyId AND taskContact.id = row.contactId",
    )
    .leftJoin(
      Partnership,
      "taskPartnership",
      "taskPartnership.companyId = row.companyId AND taskPartnership.id = row.partnershipId",
    )
    .leftJoin(
      Customer,
      "taskAccount",
      "taskAccount.companyId = row.companyId AND taskAccount.id = COALESCE(row.customerId, taskDeal.customerId, taskPartnership.customerId)",
    );
  const dealQb = manager
    .getRepository(Deal)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.nextFollowUpAt IS NOT NULL")
    .leftJoin(
      Customer,
      "dealAccount",
      "dealAccount.companyId = row.companyId AND dealAccount.id = row.customerId",
    );
  const partnershipQb = manager
    .getRepository(Partnership)
    .createQueryBuilder("row")
    .where("row.companyId = :companyId", { companyId })
    .andWhere("row.nextFollowUpAt IS NOT NULL")
    .leftJoin(
      Customer,
      "partnershipAccount",
      "partnershipAccount.companyId = row.companyId AND partnershipAccount.id = row.customerId",
    );

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
    const source = filter.source ?? filter.followUpSource;
    const taskStatus = filter.status ?? filter.taskStatus ?? "open";
    const assignedUserId = filter.assignedUserId ?? filter.ownerId;
    const assignedEmployeeId = filter.assignedEmployeeId ?? filter.ownerEmployeeId;
    if (source && source !== "task") taskQb.andWhere("1 = 0");
    if (source && source !== "deal") dealQb.andWhere("1 = 0");
    if (source && source !== "partnership") {
      partnershipQb.andWhere("1 = 0");
    }
    taskQb.andWhere("row.taskStatus = :taskStatus", { taskStatus });
    if (taskStatus !== "open") {
      dealQb.andWhere("1 = 0");
      partnershipQb.andWhere("1 = 0");
    }
    if (filter.archivedResources === "only") {
      taskQb.andWhere(
        "(taskDeal.archivedAt IS NOT NULL OR taskContact.archivedAt IS NOT NULL OR taskPartnership.archivedAt IS NOT NULL OR taskAccount.archivedAt IS NOT NULL)",
      );
      dealQb.andWhere("row.archivedAt IS NOT NULL");
      partnershipQb.andWhere("row.archivedAt IS NOT NULL");
    } else if (filter.archivedResources !== "include") {
      taskQb
        .andWhere("(row.dealId IS NULL OR taskDeal.archivedAt IS NULL)")
        .andWhere("(row.contactId IS NULL OR taskContact.archivedAt IS NULL)")
        .andWhere("(row.partnershipId IS NULL OR taskPartnership.archivedAt IS NULL)")
        .andWhere("(taskAccount.id IS NULL OR taskAccount.archivedAt IS NULL)");
      dealQb.andWhere("row.archivedAt IS NULL");
      partnershipQb.andWhere("row.archivedAt IS NULL");
    }
    if (filter.priority) {
      taskQb.andWhere("row.priority = :priority", { priority: filter.priority });
      dealQb.andWhere("1 = 0");
      partnershipQb.andWhere("1 = 0");
    }
    if (filter.q) {
      const q = `%${filter.q.toLowerCase()}%`;
      taskQb.andWhere("(LOWER(row.subject) LIKE :q OR LOWER(row.bodyText) LIKE :q)", { q });
      dealQb.andWhere("(LOWER(row.title) LIKE :q OR LOWER(row.nextStep) LIKE :q)", { q });
      partnershipQb.andWhere(
        "(LOWER(row.name) LIKE :q OR LOWER(row.notes) LIKE :q OR LOWER(row.integrationContext) LIKE :q)",
        { q },
      );
    }
    if (assignedUserId) {
      taskQb.andWhere("row.assignedUserId = :assignedUserId", { assignedUserId });
      dealQb.andWhere("row.ownerId = :assignedUserId", { assignedUserId });
      partnershipQb.andWhere("row.ownerId = :assignedUserId", { assignedUserId });
    }
    if (assignedEmployeeId) {
      taskQb.andWhere("row.assignedEmployeeId = :assignedEmployeeId", {
        assignedEmployeeId,
      });
      dealQb.andWhere("row.ownerEmployeeId = :assignedEmployeeId", {
        assignedEmployeeId,
      });
      partnershipQb.andWhere("row.ownerEmployeeId = :assignedEmployeeId", {
        assignedEmployeeId,
      });
    }
    if (filter.unassigned) {
      taskQb.andWhere("row.assignedUserId IS NULL AND row.assignedEmployeeId IS NULL");
      dealQb.andWhere("row.ownerId IS NULL AND row.ownerEmployeeId IS NULL");
      partnershipQb.andWhere("row.ownerId IS NULL AND row.ownerEmployeeId IS NULL");
    }
    if (filter.accountStatus) {
      taskQb.andWhere("taskAccount.accountStatus = :accountStatus", {
        accountStatus: filter.accountStatus,
      });
      dealQb.andWhere("dealAccount.accountStatus = :accountStatus", {
        accountStatus: filter.accountStatus,
      });
      partnershipQb.andWhere("partnershipAccount.accountStatus = :accountStatus", {
        accountStatus: filter.accountStatus,
      });
    }
    if (filter.dueFrom) {
      taskQb.andWhere("row.dueAt >= :dueFrom", { dueFrom: filter.dueFrom });
      dealQb.andWhere("row.nextFollowUpAt >= :dueFrom", { dueFrom: filter.dueFrom });
      partnershipQb.andWhere("row.nextFollowUpAt >= :dueFrom", { dueFrom: filter.dueFrom });
    }
    if (filter.dueTo) {
      taskQb.andWhere("row.dueAt <= :dueTo", { dueTo: filter.dueTo });
      dealQb.andWhere("row.nextFollowUpAt <= :dueTo", { dueTo: filter.dueTo });
      partnershipQb.andWhere("row.nextFollowUpAt <= :dueTo", { dueTo: filter.dueTo });
    }
    if (filter.reminderFrom) {
      taskQb.andWhere("row.reminderAt >= :reminderFrom", {
        reminderFrom: filter.reminderFrom,
      });
      dealQb.andWhere("row.followUpReminderAt >= :reminderFrom", {
        reminderFrom: filter.reminderFrom,
      });
      partnershipQb.andWhere("row.reminderAt >= :reminderFrom", {
        reminderFrom: filter.reminderFrom,
      });
    }
    if (filter.reminderTo) {
      taskQb.andWhere("row.reminderAt <= :reminderTo", { reminderTo: filter.reminderTo });
      dealQb.andWhere("row.followUpReminderAt <= :reminderTo", {
        reminderTo: filter.reminderTo,
      });
      partnershipQb.andWhere("row.reminderAt <= :reminderTo", {
        reminderTo: filter.reminderTo,
      });
    }
    const now = new Date();
    const endToday = new Date(now);
    endToday.setHours(23, 59, 59, 999);
    if (filter.state === "overdue") {
      taskQb.andWhere("row.dueAt < :now", { now });
      dealQb.andWhere("row.nextFollowUpAt < :now", { now });
      partnershipQb.andWhere("row.nextFollowUpAt < :now", { now });
    } else if (filter.state === "today") {
      taskQb.andWhere("row.dueAt >= :now AND row.dueAt <= :endToday", { now, endToday });
      dealQb.andWhere("row.nextFollowUpAt >= :now AND row.nextFollowUpAt <= :endToday", {
        now,
        endToday,
      });
      partnershipQb.andWhere("row.nextFollowUpAt >= :now AND row.nextFollowUpAt <= :endToday", {
        now,
        endToday,
      });
    } else if (filter.state === "upcoming") {
      taskQb.andWhere("row.dueAt > :endToday", { endToday });
      dealQb.andWhere("row.nextFollowUpAt > :endToday", { endToday });
      partnershipQb.andWhere("row.nextFollowUpAt > :endToday", { endToday });
    }
    const overdueMinDate =
      filter.overdueMinDays === undefined
        ? null
        : new Date(now.getTime() - Math.max(filter.overdueMinDays, 0) * 86_400_000);
    const overdueMaxDate =
      filter.overdueMaxDays === undefined
        ? null
        : new Date(now.getTime() - Math.max(filter.overdueMaxDays, 0) * 86_400_000);
    if (overdueMinDate) {
      taskQb.andWhere("row.dueAt <= :overdueMinDate", { overdueMinDate });
      dealQb.andWhere("row.nextFollowUpAt <= :overdueMinDate", { overdueMinDate });
      partnershipQb.andWhere("row.nextFollowUpAt <= :overdueMinDate", { overdueMinDate });
    }
    if (overdueMaxDate) {
      taskQb.andWhere("row.dueAt >= :overdueMaxDate", { overdueMaxDate });
      dealQb.andWhere("row.nextFollowUpAt >= :overdueMaxDate", { overdueMaxDate });
      partnershipQb.andWhere("row.nextFollowUpAt >= :overdueMaxDate", { overdueMaxDate });
    }
    if (filter.staleBefore) {
      taskQb.andWhere("row.dueAt <= :staleBefore", { staleBefore: filter.staleBefore });
      dealQb.andWhere("row.nextFollowUpAt <= :staleBefore", {
        staleBefore: filter.staleBefore,
      });
      partnershipQb.andWhere("row.nextFollowUpAt <= :staleBefore", {
        staleBefore: filter.staleBefore,
      });
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
      if (filter.linkedResourceType === "account") {
        taskQb.andWhere(
          "COALESCE(row.customerId, taskDeal.customerId, taskPartnership.customerId) = :linkedResourceId",
          { linkedResourceId: filter.linkedResourceId },
        );
      } else {
        taskQb.andWhere(`row.${filter.linkedResourceType}Id = :linkedResourceId`, {
          linkedResourceId: filter.linkedResourceId,
        });
      }
      if (filter.linkedResourceType === "deal") {
        dealQb.andWhere("row.id = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
        partnershipQb.andWhere("1 = 0");
      } else if (filter.linkedResourceType === "account") {
        dealQb.andWhere("row.customerId = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
        partnershipQb.andWhere("row.customerId = :linkedResourceId", {
          linkedResourceId: filter.linkedResourceId,
        });
      } else if (filter.linkedResourceType === "partnership") {
        dealQb.andWhere("1 = 0");
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
      taskQb.andWhere("taskDeal.stageId = :dealStageId", {
        dealStageId: filter.dealStageId,
      });
    }
    if (filter.dealStatus) {
      dealQb.andWhere("row.status = :dealStatus", { dealStatus: filter.dealStatus });
      taskQb.andWhere("taskDeal.status = :dealStatus", { dealStatus: filter.dealStatus });
    } else if (filter.closedDeals === "only") {
      dealQb.andWhere("row.status IN ('won', 'lost')");
      taskQb.andWhere("taskDeal.status IN ('won', 'lost')");
    } else if (filter.closedDeals !== "include") {
      dealQb.andWhere("row.status = 'open'");
    }
    if (filter.closedDeals === "exclude") {
      taskQb.andWhere("(row.dealId IS NULL OR taskDeal.status = 'open')");
    }
  }

  const [tasks, deals, partnerships] = await Promise.all([
    taskQb
      .orderBy("row.dueAt", "ASC")
      .addOrderBy("row.id", "ASC")
      .take(BULK_SELECTION_LIMIT)
      .getMany(),
    dealQb
      .orderBy("row.nextFollowUpAt", "ASC")
      .addOrderBy("row.id", "ASC")
      .take(BULK_SELECTION_LIMIT)
      .getMany(),
    partnershipQb
      .orderBy("row.nextFollowUpAt", "ASC")
      .addOrderBy("row.id", "ASC")
      .take(BULK_SELECTION_LIMIT)
      .getMany(),
  ]);
  const dueAt = ({ source, row }: FollowUpRow): Date =>
    source === "task" ? (row as Activity).dueAt! : (row as Deal | Partnership).nextFollowUpAt!;
  const rows: FollowUpRow[] = [
    ...tasks.map((row) => ({ source: "task" as const, row })),
    ...deals.map((row) => ({ source: "deal" as const, row })),
    ...partnerships.map((row) => ({ source: "partnership" as const, row })),
  ]
    .sort(
      (a, b) =>
        dueAt(a).getTime() - dueAt(b).getTime() ||
        a.source.localeCompare(b.source) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, BULK_SELECTION_LIMIT);
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
  destinationKind?: DealStageKind,
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
  if (action.type === "move_deal_stage") {
    if (resourceType !== "deal" || !destinationKind) {
      throw new Error("Deal Stage movement applies only to Deals");
    }
    if (destinationKind === "lost" && !action.lostReason?.trim()) {
      throw new Error("A lost reason is required when moving Deals to Closed Lost");
    }
    const deal = current as Deal;
    const now = new Date();
    return {
      before: {
        stageId: deal.stageId,
        status: deal.status,
        closedAt: deal.closedAt,
        lostReason: deal.lostReason,
        nextFollowUpAt: deal.nextFollowUpAt,
        followUpReminderAt: deal.followUpReminderAt,
        lastActivityAt: deal.lastActivityAt,
      },
      after: {
        stageId: action.stageId,
        status: destinationKind,
        closedAt: destinationKind === "open" ? null : (deal.closedAt ?? now),
        lostReason: destinationKind === "lost" ? action.lostReason!.trim() : "",
        nextFollowUpAt: destinationKind === "open" ? deal.nextFollowUpAt : null,
        followUpReminderAt: destinationKind === "open" ? deal.followUpReminderAt : null,
        lastActivityAt: now,
      },
      entityType: "deal",
    };
  }
  if (action.type === "update_standard_fields") {
    throw new Error("Standard-field changes require validated field preparation");
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
      row.source === "deal"
        ? (scheduled as Deal).followUpReminderAt
        : (scheduled as Partnership).reminderAt;
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
      row.source === "deal"
        ? (scheduled as Deal).followUpReminderAt
        : (scheduled as Partnership).reminderAt;
    after[reminderField] = action.reminderAt;
  }
  return { before, after, entityType: row.source };
}

const STANDARD_FIELDS: Record<Exclude<BulkResourceType, "follow_up">, ReadonlySet<string>> = {
  account: new Set([
    "name",
    "email",
    "phone",
    "domain",
    "websiteUrl",
    "industry",
    "employeeCount",
    "billingAddress",
    "shippingAddress",
    "taxNumber",
    "currency",
    "annualContractValueCents",
    "notes",
  ]),
  contact: new Set([
    "name",
    "email",
    "phone",
    "title",
    "linkedinUrl",
    "websiteUrl",
    "customerId",
    "companyName",
    "source",
    "sourceDetail",
    "score",
    "notes",
    "doNotContact",
  ]),
  deal: new Set([
    "title",
    "description",
    "customerId",
    "primaryContactId",
    "amountCents",
    "currency",
    "probabilityOverride",
    "expectedCloseDate",
    "source",
    "nextStep",
    "nextFollowUpAt",
    "followUpReminderAt",
  ]),
  partnership: new Set([
    "name",
    "type",
    "status",
    "customerId",
    "websiteUrl",
    "integrationContext",
    "channelContext",
    "notes",
    "nextFollowUpAt",
    "reminderAt",
  ]),
};

const STANDARD_STRING_LIMITS: Readonly<Record<string, number>> = {
  name: 200,
  title: 300,
  description: 20_000,
  email: 320,
  phone: 100,
  domain: 253,
  websiteUrl: 2_000,
  linkedinUrl: 2_000,
  industry: 200,
  billingAddress: 10_000,
  shippingAddress: 10_000,
  taxNumber: 200,
  currency: 3,
  notes: 20_000,
  companyName: 200,
  source: 120,
  sourceDetail: 500,
  nextStep: 2_000,
  type: 80,
  status: 80,
  integrationContext: 20_000,
  channelContext: 20_000,
};
const STANDARD_INTEGER_LIMITS: Readonly<Record<string, { min: number; max: number }>> = {
  employeeCount: { min: 0, max: 2_000_000_000 },
  annualContractValueCents: { min: 0, max: 2_000_000_000 },
  score: { min: 0, max: 100 },
  amountCents: { min: 0, max: 2_000_000_000 },
};
const STANDARD_DATE_FIELDS = new Set([
  "expectedCloseDate",
  "nextFollowUpAt",
  "followUpReminderAt",
  "reminderAt",
]);
const STANDARD_LINK_FIELDS = new Set(["customerId", "primaryContactId"]);
const STANDARD_URL_FIELDS = new Set(["websiteUrl", "linkedinUrl"]);

function validatedStandardValue(key: string, value: unknown): unknown {
  const stringLimit = STANDARD_STRING_LIMITS[key];
  if (stringLimit !== undefined) {
    if (typeof value !== "string") throw new Error(`${key} must be text`);
    if (value.length > stringLimit) {
      throw new Error(`${key} must be ${stringLimit.toLocaleString()} characters or fewer`);
    }
    if (STANDARD_URL_FIELDS.has(key) && value.trim()) {
      try {
        new URL(value);
      } catch {
        throw new Error(`${key} must be a valid URL`);
      }
    }
    return value;
  }

  const integerLimit = STANDARD_INTEGER_LIMITS[key];
  if (integerLimit) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < integerLimit.min ||
      value > integerLimit.max
    ) {
      throw new Error(`${key} must be an integer from ${integerLimit.min} to ${integerLimit.max}`);
    }
    return value;
  }

  if (key === "probabilityOverride") {
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100)
    ) {
      throw new Error("probabilityOverride must be null or an integer from 0 to 100");
    }
    return value;
  }

  if (key === "doNotContact") {
    if (typeof value !== "boolean") throw new Error("doNotContact must be true or false");
    return value;
  }

  if (STANDARD_DATE_FIELDS.has(key)) {
    if (
      value !== null &&
      (!(value instanceof Date) || Number.isNaN(value.getTime()))
    ) {
      throw new Error(`${key} must be a valid date or null`);
    }
    return value;
  }

  if (STANDARD_LINK_FIELDS.has(key)) {
    if (value !== null && typeof value !== "string") {
      throw new Error(`${key} must be a record id or null`);
    }
    return value;
  }

  throw new Error(`${key} is not a supported standard field`);
}

function standardValuesForRow(
  action: Extract<BulkAction, { type: "update_standard_fields" }>,
  resourceId: string,
): Record<string, unknown> {
  if (action.values) return action.values;
  const match = action.rows?.find((row) => row.id === resourceId);
  if (!match) throw new Error("No standard-field patch was supplied for this selected record");
  return match.values;
}

function notesValue(
  current: string,
  incoming: unknown,
  mode: "replace" | "append" | "clear",
): string {
  if (mode === "clear") return "";
  if (typeof incoming !== "string") throw new Error("notes must be text");
  if (mode === "append") {
    const addition = incoming.trim();
    if (!addition) return current;
    return current.trimEnd() ? `${current.trimEnd()}\n${addition}` : addition;
  }
  return incoming;
}

async function assertManagerLink(
  manager: EntityManager,
  companyId: string,
  entity: typeof Customer | typeof Contact,
  id: unknown,
  label: string,
): Promise<void> {
  if (id === null || id === undefined) return;
  if (typeof id !== "string") throw new Error(`${label} must be a record id or null`);
  const exists = await manager.getRepository(entity).findOneBy({ companyId, id });
  if (!exists) throw new Error(`Unknown ${label}`);
}

async function standardFieldsPatch(
  manager: EntityManager,
  companyId: string,
  resourceType: Exclude<BulkResourceType, "follow_up">,
  row: CoreRow,
  action: Extract<BulkAction, { type: "update_standard_fields" }>,
): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  entityType: string;
}> {
  const values = standardValuesForRow(action, row.id);
  const entries = Object.entries(values);
  if (entries.length === 0 && action.notesMode !== "clear") {
    throw new Error("Choose at least one standard field");
  }
  const allowed = STANDARD_FIELDS[resourceType];
  const unsupported = entries.find(([key]) => !allowed.has(key));
  if (unsupported) {
    throw new Error(`${unsupported[0]} is not an editable ${resourceType} standard field`);
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    before[key] = (row as unknown as Record<string, unknown>)[key];
    after[key] = validatedStandardValue(key, value);
  }
  if (action.notesMode === "clear" && allowed.has("notes") && !("notes" in after)) {
    before.notes = (row as Customer | Contact | Partnership).notes;
    after.notes = "";
  } else if ("notes" in after) {
    after.notes = notesValue(
      (row as Customer | Contact | Partnership).notes,
      after.notes,
      action.notesMode ?? "replace",
    );
  }

  if ("name" in after) {
    const value = String(after.name).trim();
    if (!value) throw new Error("name is required");
    after.name = value;
  }
  if ("title" in after && resourceType === "deal") {
    const value = String(after.title).trim();
    if (!value) throw new Error("title is required");
    after.title = value;
  }
  for (const key of [
    "phone",
    "title",
    "websiteUrl",
    "linkedinUrl",
    "industry",
    "taxNumber",
    "companyName",
    "sourceDetail",
  ]) {
    if (key in after && typeof after[key] === "string") after[key] = after[key].trim();
  }
  if ("currency" in after) {
    const currency = String(after.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code");
    after.currency = currency;
  }

  if (resourceType === "account") {
    if ("email" in after) {
      const raw = String(after.email);
      const email = normalizeEmail(raw) ?? "";
      if (raw.trim() && !email) throw new Error("email is invalid");
      after.email = email;
    }
    if ("domain" in after) {
      after.domain = normalizeAccountDomain(String(after.domain));
      if (after.domain) {
        const clash = await manager.getRepository(Customer).findOneBy({
          companyId,
          domain: String(after.domain),
          archivedAt: IsNull(),
        });
        if (clash && clash.id !== row.id) {
          throw new Error(`An Account already uses the domain ${String(after.domain)}`);
        }
      }
    }
  }

  if (resourceType === "contact") {
    if ("email" in after) {
      const raw = String(after.email);
      const email = normalizeEmail(raw) ?? "";
      if (raw.trim() && !email) throw new Error("email is invalid");
      if (email) {
        const clash = await manager.getRepository(Contact).findOneBy({ companyId, email });
        if (clash && clash.id !== row.id) {
          throw new Error(`A Contact already uses ${email}`);
        }
      }
      after.email = email;
    }
    await assertManagerLink(manager, companyId, Customer, after.customerId, "Account");
  }

  if (resourceType === "deal") {
    await Promise.all([
      assertManagerLink(manager, companyId, Customer, after.customerId, "Account"),
      assertManagerLink(manager, companyId, Contact, after.primaryContactId, "Contact"),
    ]);
    if ("source" in after) {
      after.source = classificationValue(String(after.source));
      await assertClassification(companyId, "deal_source", String(after.source));
    }
  }

  if (resourceType === "partnership") {
    await assertManagerLink(manager, companyId, Customer, after.customerId, "Account");
    for (const [key, kind] of [
      ["type", "partnership_type"],
      ["status", "partnership_status"],
    ] as const) {
      if (!(key in after)) continue;
      after[key] = classificationValue(String(after[key]));
      await assertClassification(companyId, kind, String(after[key]));
    }
  }

  return { before, after, entityType: resourceType };
}

function samePatch(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const normalize = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  return Object.keys(after).every(
    (key) => JSON.stringify(normalize(before[key])) === JSON.stringify(normalize(after[key])),
  );
}

function operationSnapshot(entity: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entity).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

async function recordBulkDealFieldHistory(
  manager: EntityManager,
  companyId: string,
  deal: Deal,
  patch: { before: Record<string, unknown>; after: Record<string, unknown> },
  idempotencyKey: string,
  actor: RevenueOperationActor,
): Promise<OperationRowWrite[]> {
  const now = new Date();
  const events: DealHistoryEvent[] = [];
  const base = {
    companyId,
    dealId: deal.id,
    occurredAt: now,
    fromStageId: null,
    toStageId: null,
    fromAmountCents: null,
    toAmountCents: null,
    currency: String(patch.after.currency ?? deal.currency),
    fromOwnerId: null,
    fromOwnerEmployeeId: null,
    toOwnerId: null,
    toOwnerEmployeeId: null,
    lostReason: "",
    sourceKind: "live" as const,
    sourceActivityId: null,
    createdByUserId: actor.userId ?? null,
    createdByEmployeeId: actor.employeeId ?? null,
  };
  if ("amountCents" in patch.after || "currency" in patch.after) {
    events.push(
      manager.create(DealHistoryEvent, {
        ...base,
        kind: "amount_changed",
        fromAmountCents: deal.amountCents,
        toAmountCents: Number(patch.after.amountCents ?? deal.amountCents),
        sourceKey: `bulk:${idempotencyKey}:deal:${deal.id}:amount`,
        metadataJson: "{}",
      }),
    );
  }
  if ("ownerId" in patch.after || "ownerEmployeeId" in patch.after) {
    events.push(
      manager.create(DealHistoryEvent, {
        ...base,
        kind: "owner_changed",
        fromOwnerId: deal.ownerId,
        fromOwnerEmployeeId: deal.ownerEmployeeId,
        toOwnerId: (patch.after.ownerId as string | null | undefined) ?? null,
        toOwnerEmployeeId: (patch.after.ownerEmployeeId as string | null | undefined) ?? null,
        sourceKey: `bulk:${idempotencyKey}:deal:${deal.id}:owner`,
        metadataJson: "{}",
      }),
    );
  }
  if ("expectedCloseDate" in patch.after) {
    const serializeDate = (value: unknown): string | null =>
      value instanceof Date
        ? value.toISOString()
        : value
          ? new Date(String(value)).toISOString()
          : null;
    events.push(
      manager.create(DealHistoryEvent, {
        ...base,
        kind: "expected_close_changed",
        sourceKey: `bulk:${idempotencyKey}:deal:${deal.id}:expected-close`,
        metadataJson: JSON.stringify({
          fromExpectedCloseDate: serializeDate(deal.expectedCloseDate),
          toExpectedCloseDate: serializeDate(patch.after.expectedCloseDate),
        }),
      }),
    );
  }
  if (events.length === 0) return [];
  const saved = await manager.save(DealHistoryEvent, events);
  return saved.map((event) => ({
    resourceType: "deal",
    resourceId: event.id,
    entityType: "deal_history_event",
    action: event.kind,
    before: null,
    after: operationSnapshot(event),
  }));
}

async function recordBulkCustomFieldEvidence(
  manager: EntityManager,
  companyId: string,
  resourceType: Exclude<BulkResourceType, "follow_up">,
  resourceId: string,
  field: RevenueCustomField,
  value: unknown,
  idempotencyKey: string,
  actor: RevenueOperationActor,
): Promise<OperationRowWrite[]> {
  const rows: OperationRowWrite[] = [];
  const activeEvidence = await manager.find(RevenueFieldEvidence, {
    where: {
      companyId,
      resourceType,
      resourceId,
      fieldKey: `custom:${field.key}`,
      status: In(["proposed", "accepted"]),
    },
  });
  for (const evidence of activeEvidence) {
    const before = {
      status: evidence.status,
      verificationState: evidence.verificationState,
    };
    evidence.status = "superseded";
    evidence.verificationState = "superseded";
    await manager.save(RevenueFieldEvidence, evidence);
    rows.push({
      resourceType,
      resourceId: evidence.id,
      entityType: "revenue_field_evidence",
      action: "supersede_custom_field_evidence",
      before,
      after: {
        status: evidence.status,
        verificationState: evidence.verificationState,
      },
    });
  }

  const observedAt = new Date();
  const verifyingActor = actor.userId
    ? { kind: "member" as const, id: actor.userId }
    : actor.employeeId
      ? { kind: "ai_employee" as const, id: actor.employeeId }
      : { kind: "system" as const, id: null };
  const evidence = await manager.save(
    RevenueFieldEvidence,
    manager.create(RevenueFieldEvidence, {
      companyId,
      resourceType,
      resourceId,
      fieldKey: `custom:${field.key}`,
      sourceType: "manual",
      sourceId: `bulk:${idempotencyKey}:${resourceType}:${resourceId}:${field.key}`,
      sourceLabel: "Revenue bulk operation",
      extractedValueJson: JSON.stringify(value),
      normalizedValue: normalizedCustomFieldSearchValue(
        value as string | number | boolean | string[] | null,
      ),
      confidence: 100,
      status: "accepted",
      verificationState: "verified",
      extractionMethod: "bulk_update",
      observedAt,
      extractedAt: observedAt,
      lastVerifiedAt: observedAt,
      humanConfirmedAt: actor.userId ? observedAt : null,
      humanConfirmedById: actor.userId ?? null,
      verifyingActorType: verifyingActor.kind,
      verifyingActorId: verifyingActor.id,
      metadataJson: JSON.stringify({
        extractionMethod: "bulk_update",
        verificationState: "verified",
        verifyingActor,
        bulkIdempotencyKey: idempotencyKey,
      }),
    }),
  );
  rows.push({
    resourceType,
    resourceId: evidence.id,
    entityType: "revenue_field_evidence",
    action: "create_custom_field_evidence",
    before: null,
    after: operationSnapshot(evidence),
  });
  return rows;
}

async function applyCustomFields(
  manager: EntityManager,
  companyId: string,
  resourceType: Exclude<BulkResourceType, "follow_up">,
  resourceId: string,
  values: Record<string, unknown>,
  apply: boolean,
  idempotencyKey: string | undefined,
  actor: RevenueOperationActor,
): Promise<{
  rows: OperationRowWrite[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  const fields = await manager.find(RevenueCustomField, {
    where: { companyId, resourceType },
  });
  const byKey = new Map(
    fields.filter((field) => !field.archivedAt).map((field) => [field.key, field]),
  );
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
        before: operationSnapshot(existing),
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
          ? operationSnapshot(next)
          : { valueJson: next.valueJson, searchValue: next.searchValue },
      });
    }
    if (apply) {
      if (!idempotencyKey) throw new Error("An idempotency key is required");
      changes.push(
        ...(await recordBulkCustomFieldEvidence(
          manager,
          companyId,
          resourceType,
          resourceId,
          field,
          value,
          idempotencyKey,
          actor,
        )),
      );
    }
  }
  return { rows: changes, before, after };
}

export async function runRevenueBulkOperation(
  companyId: string,
  request: BulkRequest,
  actor: RevenueOperationActor = {},
  onProgress?: (progress: BulkExecutionProgress) => void | Promise<void>,
): Promise<BulkResult> {
  if (
    !request.target.ids?.length &&
    !request.target.followUpIds?.length &&
    !request.target.filter
  ) {
    throw new Error("Choose selected IDs or a filter");
  }
  if (!request.dryRun && !request.idempotencyKey) {
    throw new Error("An idempotency key is required");
  }
  if (request.action.type === "update_standard_fields") {
    if (request.resourceType === "follow_up") {
      throw new Error("Standard fields are available only on Revenue records");
    }
    if (Boolean(request.action.values) === Boolean(request.action.rows?.length)) {
      throw new Error("Supply either one shared field patch or per-record field patches");
    }
    const ids = request.action.rows?.map((row) => row.id) ?? [];
    if (new Set(ids).size !== ids.length) {
      throw new Error("Each per-record field patch must use a unique record id");
    }
    if (request.action.rows?.length) {
      const targetIds = new Set(request.target.ids ?? []);
      if (
        targetIds.size !== request.action.rows.length ||
        request.action.rows.some((row) => !targetIds.has(row.id))
      ) {
        throw new Error("Per-record field patches must exactly match the selected IDs");
      }
    }
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
    const destinationStage =
      request.action.type === "move_deal_stage"
        ? await manager.findOneBy(DealStage, {
            companyId,
            id: request.action.stageId,
            archivedAt: IsNull(),
          })
        : null;
    if (request.action.type === "move_deal_stage" && !destinationStage) {
      throw new Error("Destination Deal Stage not found");
    }
    const rows = selected.rows as SelectedRow[];
    if (
      request.action.type === "update_standard_fields" &&
      request.action.values &&
      rows.length > 1 &&
      ((request.resourceType === "account" && "domain" in request.action.values) ||
        (request.resourceType === "contact" && "email" in request.action.values))
    ) {
      throw new Error(
        "Unique identity fields require a per-record patch when more than one record is selected",
      );
    }
    const results: BulkRowResult[] = [];
    const operationRows: OperationRowWrite[] = [];
    const total = rows.length + selected.missing.length;
    let reported = 0;
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    const reportProgress = async (): Promise<void> => {
      while (reported < results.length) {
        const status = results[reported].status;
        if (status === "applied") applied += 1;
        else if (status === "skipped") skipped += 1;
        else if (status === "failed") failed += 1;
        reported += 1;
      }
      await onProgress?.({
        total,
        processed: reported,
        applied,
        skipped,
        failed,
      });
    };
    for (const missing of selected.missing as Array<
      string | { source: FollowUpSource; id: string }
    >) {
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
      await reportProgress();
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
        : coreLabel(request.resourceType as Exclude<BulkResourceType, "follow_up">, selectedRow);
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
            request.idempotencyKey,
            actor,
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
          if (request.resourceType === "account" && (row as Customer).domain) {
            const clash = await manager.getRepository(Customer).findOneBy({
              companyId,
              domain: (row as Customer).domain,
              archivedAt: IsNull(),
            });
            if (clash && clash.id !== row.id) {
              throw new Error(
                `Restore blocked: ${clash.name} already uses the domain ${(row as Customer).domain}`,
              );
            }
          }
        }
        const patch =
          request.action.type === "update_standard_fields"
            ? await standardFieldsPatch(
                manager,
                companyId,
                request.resourceType as Exclude<BulkResourceType, "follow_up">,
                row as CoreRow,
                request.action,
              )
            : standardPatch(
                request.resourceType,
                selectedRow,
                request.action,
                destinationStage?.kind,
              );
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
          if (
            request.resourceType === "deal" &&
            request.action.type !== "move_deal_stage" &&
            request.idempotencyKey
          ) {
            operationRows.push(
              ...(await recordBulkDealFieldHistory(
                manager,
                companyId,
                row as Deal,
                patch,
                request.idempotencyKey,
                actor,
              )),
            );
          }
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
          if (request.action.type === "move_deal_stage" && destinationStage) {
            const deal = row as Deal;
            const occurredAt = patch.after.lastActivityAt as Date;
            const activity = await manager.save(
              Activity,
              manager.create(Activity, {
                companyId,
                kind:
                  destinationStage.kind === "won"
                    ? "deal_won"
                    : destinationStage.kind === "lost"
                      ? "deal_lost"
                      : "stage_change",
                subject: `Bulk move to ${destinationStage.name}`,
                bodyText: "",
                occurredAt,
                contactId: deal.primaryContactId,
                dealId: deal.id,
                customerId: deal.customerId,
                partnershipId: null,
                mailThreadId: null,
                mailMessageId: null,
                actorUserId: actor.userId ?? null,
                actorEmployeeId: actor.employeeId ?? null,
                metaJson: JSON.stringify({
                  fromStageId: deal.stageId,
                  toStageId: destinationStage.id,
                  lostReason:
                    destinationStage.kind === "lost"
                      ? request.action.lostReason?.trim()
                      : undefined,
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
            const history = await manager.save(
              DealHistoryEvent,
              manager.create(DealHistoryEvent, {
                companyId,
                dealId: deal.id,
                kind:
                  destinationStage.kind === "won"
                    ? "won"
                    : destinationStage.kind === "lost"
                      ? "lost"
                      : "stage_changed",
                occurredAt,
                fromStageId: deal.stageId,
                toStageId: destinationStage.id,
                fromAmountCents: null,
                toAmountCents: deal.amountCents,
                currency: deal.currency,
                fromOwnerId: null,
                fromOwnerEmployeeId: null,
                toOwnerId: null,
                toOwnerEmployeeId: null,
                lostReason:
                  destinationStage.kind === "lost" ? (request.action.lostReason?.trim() ?? "") : "",
                sourceKind: "live",
                sourceKey: `activity:${activity.id}`,
                sourceActivityId: activity.id,
                metadataJson: JSON.stringify({ bulk: true }),
                createdByUserId: actor.userId ?? null,
                createdByEmployeeId: actor.employeeId ?? null,
              }),
            );
            operationRows.push(
              {
                resourceType: "deal",
                resourceId: activity.id,
                entityType: "activity",
                action: "move_deal_stage_activity",
                before: null,
                after: operationSnapshot(activity),
              },
              {
                resourceType: "deal",
                resourceId: history.id,
                entityType: "deal_history_event",
                action: "move_deal_stage_history",
                before: null,
                after: operationSnapshot(history),
              },
            );
          }
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
      } finally {
        await reportProgress();
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
    if (request.mode === "atomic" && result.failed > 0) {
      throw new BulkAtomicValidationError(result);
    }
    const operation = await createRevenueOperation(manager, {
      companyId,
      kind: "bulk",
      resourceType: request.resourceType,
      status: result.failed > 0 ? (result.applied > 0 ? "partial" : "failed") : "completed",
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
