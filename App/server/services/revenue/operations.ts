import {
  type EntityManager,
  type EntityTarget,
  type FindOptionsWhere,
  type ObjectLiteral,
} from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerContact } from "../../db/entities/CustomerContact.js";
import { CustomerContract } from "../../db/entities/CustomerContract.js";
import { CustomerCredit } from "../../db/entities/CustomerCredit.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RecurringInvoice } from "../../db/entities/RecurringInvoice.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import {
  RevenueOperation,
  type RevenueOperationKind,
  type RevenueOperationResourceType,
  type RevenueOperationStatus,
} from "../../db/entities/RevenueOperation.js";
import {
  RevenueOperationRow,
  type RevenueOperationRowStatus,
} from "../../db/entities/RevenueOperationRow.js";
import { RevenueRecordAlias } from "../../db/entities/RevenueRecordAlias.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { SignalEvent } from "../../db/entities/SignalEvent.js";
import { Suppression } from "../../db/entities/Suppression.js";

export type RevenueOperationActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type OperationRowWrite = {
  resourceType: string;
  resourceId: string;
  entityType: string;
  action: string;
  status?: RevenueOperationRowStatus;
  before?: unknown;
  after?: unknown;
  detail?: string;
};

type EntityRow = ObjectLiteral & {
  id: string;
  companyId?: string;
};

const OPERATION_ENTITIES: Record<string, EntityTarget<ObjectLiteral>> = {
  account: Customer,
  customer: Customer,
  contact: Contact,
  deal: Deal,
  partnership: Partnership,
  deal_history_event: DealHistoryEvent,
  activity: Activity,
  customer_contact: CustomerContact,
  customer_contract: CustomerContract,
  customer_credit: CustomerCredit,
  deal_contact: DealContact,
  estimate: Estimate,
  invoice: Invoice,
  partnership_contact: PartnershipContact,
  recurring_invoice: RecurringInvoice,
  revenue_custom_value: RevenueCustomValue,
  revenue_document: RevenueDocument,
  revenue_document_candidate: RevenueDocumentCandidate,
  revenue_duplicate_candidate: RevenueDuplicateCandidate,
  revenue_field_evidence: RevenueFieldEvidence,
  revenue_record_alias: RevenueRecordAlias,
  sequence_enrollment: SequenceEnrollment,
  signal_event: SignalEvent,
  suppression: Suppression,
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parsed(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        comparable(item),
      ]),
    );
  }
  return value;
}

function patchMatches(row: EntityRow, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(
    ([key, value]) => json(comparable(row[key])) === json(comparable(value)),
  );
}

function deserializePatch(row: EntityRow, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    next[key] = row[key] instanceof Date && typeof value === "string" ? new Date(value) : value;
  }
  return next;
}

export async function createRevenueOperation(
  manager: EntityManager,
  input: {
    companyId: string;
    kind: RevenueOperationKind;
    resourceType: RevenueOperationResourceType;
    status: RevenueOperationStatus;
    idempotencyKey?: string | null;
    sourceId?: string | null;
    targetId?: string | null;
    request: unknown;
    summary: unknown;
    actor?: RevenueOperationActor;
    rows: OperationRowWrite[];
  },
): Promise<RevenueOperation> {
  const operation = await manager.save(
    RevenueOperation,
    manager.create(RevenueOperation, {
      companyId: input.companyId,
      kind: input.kind,
      resourceType: input.resourceType,
      status: input.status,
      idempotencyKey: input.idempotencyKey ?? null,
      sourceId: input.sourceId ?? null,
      targetId: input.targetId ?? null,
      requestJson: json(input.request),
      summaryJson: json(input.summary),
      completedAt: new Date(),
      rolledBackAt: null,
      createdByUserId: input.actor?.userId ?? null,
      createdByEmployeeId: input.actor?.employeeId ?? null,
    }),
  );
  await appendRevenueOperationRows(manager, operation, input.rows);
  return operation;
}

export async function appendRevenueOperationRows(
  manager: EntityManager,
  operation: RevenueOperation,
  rows: OperationRowWrite[],
): Promise<RevenueOperationRow[]> {
  if (rows.length === 0) return [];
  const existingCount = await manager.count(RevenueOperationRow, {
    where: { companyId: operation.companyId, operationId: operation.id },
  });
  return manager.save(
    RevenueOperationRow,
    rows.map((row, index) =>
      manager.create(RevenueOperationRow, {
        companyId: operation.companyId,
        operationId: operation.id,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        entityType: row.entityType,
        action: row.action,
        status: row.status ?? "applied",
        beforeJson: json(row.before),
        afterJson: json(row.after),
        detail: row.detail ?? "",
        sortOrder: existingCount + index,
      }),
    ),
  );
}

export async function listRevenueOperations(
  companyId: string,
  opts: {
    kind?: RevenueOperationKind;
    resourceType?: RevenueOperationResourceType;
    status?: RevenueOperationStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueOperation[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const qb = AppDataSource.getRepository(RevenueOperation)
    .createQueryBuilder("operation")
    .where("operation.companyId = :companyId", { companyId });
  if (opts.kind) qb.andWhere("operation.kind = :kind", { kind: opts.kind });
  if (opts.resourceType) {
    qb.andWhere("operation.resourceType = :resourceType", {
      resourceType: opts.resourceType,
    });
  }
  if (opts.status) qb.andWhere("operation.status = :status", { status: opts.status });
  const total = await qb.clone().getCount();
  const rows = await qb.orderBy("operation.createdAt", "DESC").skip(offset).take(limit).getMany();
  return { rows, total };
}

export async function getRevenueOperation(
  companyId: string,
  id: string,
  opts: { rowLimit?: number; rowOffset?: number } = {},
): Promise<{
  operation: RevenueOperation;
  rows: RevenueOperationRow[];
  rowTotal: number;
} | null> {
  const operation = await AppDataSource.getRepository(RevenueOperation).findOneBy({
    companyId,
    id,
  });
  if (!operation) return null;
  const rowRepo = AppDataSource.getRepository(RevenueOperationRow);
  const rowTotal = await rowRepo.count({ where: { companyId, operationId: id } });
  const rows = await rowRepo.find({
    where: { companyId, operationId: id },
    order: { sortOrder: "ASC" },
    skip: Math.max(opts.rowOffset ?? 0, 0),
    take: Math.min(Math.max(opts.rowLimit ?? 100, 1), 500),
  });
  return { operation, rows, rowTotal };
}

export async function findMergedRecordRedirect(
  companyId: string,
  resourceType: "account" | "contact" | "deal" | "partnership",
  sourceId: string,
): Promise<{ operationId: string; targetId: string } | null> {
  const repo = AppDataSource.getRepository(RevenueOperation);
  const visited = new Set([sourceId]);
  let currentId = sourceId;
  let firstOperationId: string | null = null;

  for (let hop = 0; hop < 100; hop += 1) {
    const row = await repo.findOne({
      where: {
        companyId,
        kind: "merge",
        resourceType,
        sourceId: currentId,
        status: "completed",
      },
      order: { createdAt: "DESC" },
    });
    if (!row?.targetId) {
      return firstOperationId ? { operationId: firstOperationId, targetId: currentId } : null;
    }
    firstOperationId ??= row.id;
    if (visited.has(row.targetId)) {
      throw new Error(`Merge redirect cycle detected for ${resourceType} ${sourceId}`);
    }
    visited.add(row.targetId);
    currentId = row.targetId;
  }

  throw new Error(`Merge redirect chain is too deep for ${resourceType} ${sourceId}`);
}

async function loadOperationEntity(
  manager: EntityManager,
  entityType: string,
  companyId: string,
  id: string,
): Promise<{ target: EntityTarget<ObjectLiteral>; row: EntityRow | null }> {
  const target = OPERATION_ENTITIES[entityType];
  if (!target) throw new Error(`Unsupported rollback entity: ${entityType}`);
  const where = { id, companyId } as FindOptionsWhere<ObjectLiteral>;
  const row = (await manager.getRepository(target).findOne({ where })) as EntityRow | null;
  return { target, row };
}

type RollbackPlan =
  | {
      kind: "update";
      row: RevenueOperationRow;
      target: EntityTarget<ObjectLiteral>;
      current: EntityRow;
      before: Record<string, unknown>;
    }
  | {
      kind: "delete";
      row: RevenueOperationRow;
      target: EntityTarget<ObjectLiteral>;
      current: EntityRow;
    }
  | {
      kind: "restore";
      row: RevenueOperationRow;
      target: EntityTarget<ObjectLiteral>;
      before: EntityRow;
    };

/**
 * Guarded rollback shared by merge and bulk operations.
 *
 * Every row is validated before the first write. If anything no longer equals
 * the operation's recorded `after` state, the entire rollback is refused with
 * explicit conflicts instead of overwriting subsequent work.
 */
export async function rollbackRevenueOperation(
  companyId: string,
  operationId: string,
): Promise<{ operation: RevenueOperation; rolledBack: number }> {
  return AppDataSource.transaction(async (manager) => {
    const operation = await manager.findOneBy(RevenueOperation, {
      companyId,
      id: operationId,
    });
    if (!operation) throw new Error("Revenue operation not found");
    if (operation.status === "rolled_back") {
      return {
        operation,
        rolledBack: await manager.count(RevenueOperationRow, {
          where: { companyId, operationId, status: "rolled_back" },
        }),
      };
    }
    if (operation.status === "queued" || operation.status === "running") {
      throw new Error("A queued or running operation cannot be rolled back");
    }
    if (operation.status === "failed") {
      throw new Error("A failed operation has no applied changes to roll back");
    }
    const rows = await manager.find(RevenueOperationRow, {
      where: { companyId, operationId, status: "applied" },
      order: { sortOrder: "DESC" },
    });
    const plan: RollbackPlan[] = [];
    const conflicts: string[] = [];

    for (const row of rows) {
      const before = parsed(row.beforeJson);
      const after = parsed(row.afterJson);
      const loaded = await loadOperationEntity(manager, row.entityType, companyId, row.resourceId);
      if (before === null && after && typeof after === "object") {
        if (!loaded.row) {
          conflicts.push(`${row.entityType}:${row.resourceId} was already removed`);
        } else if (!patchMatches(loaded.row, after as Record<string, unknown>)) {
          conflicts.push(`${row.entityType}:${row.resourceId} changed after the operation`);
        } else {
          plan.push({ kind: "delete", row, target: loaded.target, current: loaded.row });
        }
        continue;
      }
      if (after === null && before && typeof before === "object") {
        if (loaded.row) {
          conflicts.push(`${row.entityType}:${row.resourceId} was recreated`);
        } else {
          plan.push({
            kind: "restore",
            row,
            target: loaded.target,
            before: before as EntityRow,
          });
        }
        continue;
      }
      if (
        !loaded.row ||
        !before ||
        typeof before !== "object" ||
        !after ||
        typeof after !== "object"
      ) {
        conflicts.push(`${row.entityType}:${row.resourceId} is unavailable for rollback`);
        continue;
      }
      if (!patchMatches(loaded.row, after as Record<string, unknown>)) {
        conflicts.push(`${row.entityType}:${row.resourceId} changed after the operation`);
        continue;
      }
      plan.push({
        kind: "update",
        row,
        target: loaded.target,
        current: loaded.row,
        before: before as Record<string, unknown>,
      });
    }

    if (conflicts.length > 0) {
      throw new Error(`Rollback blocked: ${conflicts.slice(0, 20).join("; ")}`);
    }

    for (const item of plan) {
      const repo = manager.getRepository(item.target);
      if (item.kind === "delete") {
        await repo.delete({ id: item.current.id, companyId } as FindOptionsWhere<ObjectLiteral>);
      } else if (item.kind === "restore") {
        await repo.save(repo.create(item.before));
      } else {
        await repo.update(
          { id: item.current.id, companyId } as FindOptionsWhere<ObjectLiteral>,
          deserializePatch(item.current, item.before),
        );
      }
      item.row.status = "rolled_back";
      await manager.save(RevenueOperationRow, item.row);
    }

    operation.status = "rolled_back";
    operation.rolledBackAt = new Date();
    await manager.save(RevenueOperation, operation);
    return { operation, rolledBack: plan.length };
  });
}
