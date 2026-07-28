import type { EntityTarget, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import {
  DealHistoryEvent,
  type DealHistoryEventKind,
  type DealHistorySourceKind,
} from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import {
  RevenueFieldEvidence,
  type RevenueEvidenceSourceType,
  type RevenueEvidenceStatus,
} from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueImportRow } from "../../db/entities/RevenueImportRow.js";
import {
  RevenueOperation,
  type RevenueOperationKind,
  type RevenueOperationResourceType,
  type RevenueOperationStatus,
} from "../../db/entities/RevenueOperation.js";
import { RevenueOperationRow } from "../../db/entities/RevenueOperationRow.js";
import { listFollowUpPage } from "./followUps.js";
import { ensureRevenueImportRowsForCompany } from "./imports.js";

export const REVENUE_EXPORT_RESOURCES = [
  "accounts",
  "contacts",
  "deals",
  "partnerships",
  "partnership_contacts",
  "buying_committees",
  "follow_ups",
  "documents",
  "stage_definitions",
  "custom_fields",
  "custom_values",
  "import_reconciliation",
  "deal_history",
  "field_evidence",
  "duplicate_candidates",
  "operation_audit",
  "document_candidates",
] as const;

export type RevenueExportResource = (typeof REVENUE_EXPORT_RESOURCES)[number];

export type RevenueExportBaseOptions = {
  limit?: number;
  offset?: number;
  /**
   * Opaque stable cursor. It embeds the export's `asOf` boundary so later
   * pages cannot acquire records created after page one.
   */
  cursor?: string;
  asOf?: Date;
};

type RevenueMergeResourceType = "account" | "contact" | "deal" | "partnership";

export type RevenueExportOptionsByResource = {
  accounts: RevenueExportBaseOptions;
  contacts: RevenueExportBaseOptions;
  deals: RevenueExportBaseOptions;
  partnerships: RevenueExportBaseOptions;
  partnership_contacts: RevenueExportBaseOptions;
  buying_committees: RevenueExportBaseOptions;
  follow_ups: RevenueExportBaseOptions;
  documents: RevenueExportBaseOptions;
  stage_definitions: RevenueExportBaseOptions;
  custom_fields: RevenueExportBaseOptions;
  custom_values: RevenueExportBaseOptions;
  import_reconciliation: RevenueExportBaseOptions;
  deal_history: RevenueExportBaseOptions & {
    dealId?: string;
    sourceKind?: DealHistorySourceKind;
    kind?: DealHistoryEventKind;
    from?: Date;
    to?: Date;
  };
  field_evidence: RevenueExportBaseOptions & {
    resourceType?: RevenueMergeResourceType;
    resourceId?: string;
    fieldKey?: string;
    sourceType?: RevenueEvidenceSourceType;
    /** Internal authorization filter; never accepted from a public query. */
    excludeSourceTypes?: RevenueEvidenceSourceType[];
    /** Internal AI authorization scopes; never accepted from a public query. */
    allowedEmailAccountIds?: string[];
    allowedIntegrationConnectionIds?: string[];
    /** Resolved from allowedIntegrationConnectionIds inside this service. */
    allowedIntegrationEvidenceIds?: string[];
    status?: RevenueEvidenceStatus;
  };
  duplicate_candidates: RevenueExportBaseOptions & {
    resourceType?: RevenueMergeResourceType;
    status?: RevenueDuplicateCandidate["status"];
    minScore?: number;
  };
  operation_audit: RevenueExportBaseOptions & {
    kind?: RevenueOperationKind;
    resourceType?: RevenueOperationResourceType;
    status?: RevenueOperationStatus;
  };
  document_candidates: RevenueExportBaseOptions & {
    status?: RevenueDocumentCandidate["status"];
    accountId?: string;
  };
};

export type RevenueExportPage = {
  resource: RevenueExportResource;
  generatedAt: Date;
  /** Frozen creation-time boundary used by cursor pagination. */
  asOf?: Date;
  offset: number;
  limit: number;
  total: number | null;
  nextOffset: number | null;
  nextCursor?: string | null;
  rows: Array<Record<string, unknown>>;
};

type RevenueExportCursor = {
  version: 1;
  resource: RevenueExportResource;
  asOf: string;
  timestamp?: string;
  id?: string;
  sortOrder?: number;
  subId?: string;
  innerCursor?: string;
};

type ExportPageContext = {
  resource: RevenueExportResource;
  generatedAt: Date;
  asOf: Date;
  limit: number;
  offset: number;
  cursor: RevenueExportCursor | null;
};

type AdapterPage = {
  total: number | null;
  rows: Array<Record<string, unknown>>;
  nextOffset: number | null;
  nextCursor: string | null;
};

type RevenueExportAdapter<Options extends RevenueExportBaseOptions> = {
  page(companyId: string, options: Options, context: ExportPageContext): Promise<AdapterPage>;
};

type TimestampAdapterConfig<Options extends RevenueExportBaseOptions> = {
  orderColumn?: string;
  configure?: (query: SelectQueryBuilder<ObjectLiteral>, options: Options) => void;
  serialize?: (row: ObjectLiteral) => Record<string, unknown>;
};

type OperationAuditRaw = {
  operation_id: string;
  operation_companyId: string;
  operation_kind: RevenueOperationKind;
  operation_resourceType: RevenueOperationResourceType;
  operation_status: RevenueOperationStatus;
  operation_idempotencyKey: string | null;
  operation_sourceId: string | null;
  operation_targetId: string | null;
  operation_requestJson: string;
  operation_summaryJson: string;
  operation_completedAt: Date | string | null;
  operation_rolledBackAt: Date | string | null;
  operation_createdByUserId: string | null;
  operation_createdByEmployeeId: string | null;
  operation_createdAt: Date | string;
  operation_updatedAt: Date | string;
  row_id: string | null;
  row_resourceType: string | null;
  row_resourceId: string | null;
  row_entityType: string | null;
  row_action: string | null;
  row_status: RevenueOperationRow["status"] | null;
  row_beforeJson: string | null;
  row_afterJson: string | null;
  row_detail: string | null;
  row_sortOrder: number | string | null;
  row_createdAt: Date | string | null;
  row_updatedAt: Date | string | null;
  audit_sortOrder: number | string;
  audit_rowKey: string;
};

function plain(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Export row has an invalid timestamp");
  return parsed.toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function encodeCursor(cursor: RevenueExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, resource: RevenueExportResource): RevenueExportCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid Revenue export cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Revenue export cursor");
  }
  const cursor = parsed as Partial<RevenueExportCursor>;
  if (
    cursor.version !== 1 ||
    cursor.resource !== resource ||
    typeof cursor.asOf !== "string" ||
    Number.isNaN(new Date(cursor.asOf).getTime())
  ) {
    throw new Error("Invalid Revenue export cursor");
  }
  return cursor as RevenueExportCursor;
}

function pageContext(
  resource: RevenueExportResource,
  options: RevenueExportBaseOptions,
): ExportPageContext {
  const generatedAt = new Date();
  const cursor = options.cursor ? decodeCursor(options.cursor, resource) : null;
  const offset = Math.max(options.offset ?? 0, 0);
  if (cursor && offset > 0) {
    throw new Error("Choose a Revenue export cursor or an offset, not both");
  }
  const requestedAsOf = options.asOf ? new Date(options.asOf) : null;
  if (requestedAsOf && Number.isNaN(requestedAsOf.getTime())) {
    throw new Error("Invalid Revenue export asOf timestamp");
  }
  const cursorAsOf = cursor ? new Date(cursor.asOf) : null;
  if (requestedAsOf && cursorAsOf && requestedAsOf.toISOString() !== cursorAsOf.toISOString()) {
    throw new Error("Revenue export cursor belongs to a different asOf snapshot");
  }
  const asOf = cursorAsOf ?? requestedAsOf ?? generatedAt;
  if (asOf.getTime() > generatedAt.getTime()) {
    throw new Error("Revenue export asOf cannot be in the future");
  }
  return {
    resource,
    generatedAt,
    asOf,
    limit: Math.min(Math.max(options.limit ?? 200, 1), 500),
    offset,
    cursor,
  };
}

function timestampCursorValues(
  context: ExportPageContext,
  enforceCreationBoundary: boolean,
): { timestamp: Date; id: string } | null {
  if (!context.cursor) return null;
  if (typeof context.cursor.timestamp !== "string" || typeof context.cursor.id !== "string") {
    throw new Error("Invalid Revenue export cursor");
  }
  const timestamp = new Date(context.cursor.timestamp);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid Revenue export cursor");
  if (enforceCreationBoundary && timestamp.getTime() > context.asOf.getTime()) {
    throw new Error("Invalid Revenue export cursor");
  }
  return { timestamp, id: context.cursor.id };
}

function timestampAdapter<Options extends RevenueExportBaseOptions>(
  entity: EntityTarget<ObjectLiteral>,
  config: TimestampAdapterConfig<Options> = {},
): RevenueExportAdapter<Options> {
  const orderColumn = config.orderColumn ?? "createdAt";
  const serialize = config.serialize ?? plain;
  return {
    async page(companyId, options, context) {
      const query = AppDataSource.getRepository(entity)
        .createQueryBuilder("row")
        .where("row.companyId = :companyId", { companyId })
        .andWhere("row.createdAt <= :asOf", { asOf: context.asOf });
      config.configure?.(query, options);
      const total = await query.clone().getCount();
      const cursor = timestampCursorValues(context, orderColumn === "createdAt");
      if (cursor) {
        query.andWhere(
          `(row.${orderColumn} > :cursorTimestamp OR ` +
            `(row.${orderColumn} = :cursorTimestamp AND row.id > :cursorId))`,
          { cursorTimestamp: cursor.timestamp, cursorId: cursor.id },
        );
      } else if (context.offset > 0) {
        query.skip(context.offset);
      }
      const fetched = await query
        .orderBy(`row.${orderColumn}`, "ASC")
        .addOrderBy("row.id", "ASC")
        .take(context.limit + 1)
        .getMany();
      const hasMore = fetched.length > context.limit;
      const entities = fetched.slice(0, context.limit);
      const last = entities.at(-1) as (ObjectLiteral & { id?: unknown }) | undefined;
      const lastTimestamp = last?.[orderColumn];
      const nextCursor =
        hasMore &&
        last &&
        typeof last.id === "string" &&
        (lastTimestamp instanceof Date || typeof lastTimestamp === "string")
          ? encodeCursor({
              version: 1,
              resource: context.resource,
              asOf: context.asOf.toISOString(),
              timestamp: iso(lastTimestamp),
              id: last.id,
            })
          : null;
      return {
        total,
        rows: entities.map(serialize),
        nextOffset: !context.cursor && hasMore ? context.offset + entities.length : null,
        nextCursor,
      };
    },
  };
}

function dealHistoryRow(value: ObjectLiteral): Record<string, unknown> {
  const row = value as DealHistoryEvent;
  return {
    id: row.id,
    companyId: row.companyId,
    dealId: row.dealId,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    fromStageId: row.fromStageId,
    toStageId: row.toStageId,
    fromAmountCents: row.fromAmountCents,
    toAmountCents: row.toAmountCents,
    currency: row.currency,
    fromOwnerId: row.fromOwnerId,
    fromOwnerEmployeeId: row.fromOwnerEmployeeId,
    toOwnerId: row.toOwnerId,
    toOwnerEmployeeId: row.toOwnerEmployeeId,
    lostReason: row.lostReason,
    sourceKind: row.sourceKind,
    sourceKey: row.sourceKey,
    sourceActivityId: row.sourceActivityId,
    metadataJson: row.metadataJson,
    createdByUserId: row.createdByUserId,
    createdByEmployeeId: row.createdByEmployeeId,
    createdAt: row.createdAt.toISOString(),
  };
}

function fieldEvidenceRow(value: ObjectLiteral): Record<string, unknown> {
  const row = value as RevenueFieldEvidence;
  return {
    id: row.id,
    companyId: row.companyId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    fieldKey: row.fieldKey,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    extractedValueJson: row.extractedValueJson,
    normalizedValue: row.normalizedValue,
    confidence: row.confidence,
    status: row.status,
    verificationState: row.verificationState,
    extractionMethod: row.extractionMethod,
    observedAt: row.observedAt?.toISOString() ?? null,
    extractedAt: row.extractedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    humanConfirmedAt: row.humanConfirmedAt?.toISOString() ?? null,
    humanConfirmedById: row.humanConfirmedById,
    verifyingActorType: row.verifyingActorType,
    verifyingActorId: row.verifyingActorId,
    metadataJson: row.metadataJson,
    createdAt: row.createdAt.toISOString(),
  };
}

function duplicateCandidateRow(value: ObjectLiteral): Record<string, unknown> {
  const row = value as RevenueDuplicateCandidate;
  return {
    id: row.id,
    companyId: row.companyId,
    resourceType: row.resourceType,
    leftId: row.leftId,
    rightId: row.rightId,
    score: row.score,
    reasonsJson: row.reasonsJson,
    status: row.status,
    mergeOperationId: row.mergeOperationId,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Explicitly selected public fields. In particular, the internal processing
 * lease token is never included in either JSON or CSV export rows.
 */
function documentCandidateRow(value: ObjectLiteral): Record<string, unknown> {
  const row = value as RevenueDocumentCandidate;
  return {
    id: row.id,
    companyId: row.companyId,
    mailMessageId: row.mailMessageId,
    attachmentIndex: row.attachmentIndex,
    gmailMessageId: row.gmailMessageId,
    gmailThreadId: row.gmailThreadId,
    gmailAttachmentId: row.gmailAttachmentId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    proposedKind: row.proposedKind,
    proposedResourceType: row.proposedResourceType,
    proposedResourceId: row.proposedResourceId,
    confidence: row.confidence,
    alternativesJson: row.alternativesJson,
    status: row.status,
    processingAt: row.processingAt?.toISOString() ?? null,
    revenueDocumentId: row.revenueDocumentId,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByUserId: row.reviewedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function operationAuditQuery(
  companyId: string,
  options: RevenueExportOptionsByResource["operation_audit"],
  asOf: Date,
): SelectQueryBuilder<RevenueOperation> {
  const query = AppDataSource.getRepository(RevenueOperation)
    .createQueryBuilder("operation")
    .leftJoin(
      RevenueOperationRow,
      "operationRow",
      "operationRow.companyId = operation.companyId AND operationRow.operationId = operation.id " +
        "AND operationRow.createdAt <= :asOf",
    )
    .where("operation.companyId = :companyId", { companyId })
    .andWhere("operation.createdAt <= :asOf", { asOf });
  if (options.kind) query.andWhere("operation.kind = :kind", { kind: options.kind });
  if (options.resourceType) {
    query.andWhere("operation.resourceType = :resourceType", {
      resourceType: options.resourceType,
    });
  }
  if (options.status) query.andWhere("operation.status = :status", { status: options.status });
  return query;
}

function operationAuditRow(row: OperationAuditRaw): Record<string, unknown> {
  return {
    companyId: row.operation_companyId,
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    operationResourceType: row.operation_resourceType,
    operationStatus: row.operation_status,
    idempotencyKey: row.operation_idempotencyKey,
    sourceId: row.operation_sourceId,
    targetId: row.operation_targetId,
    requestJson: row.operation_requestJson,
    summaryJson: row.operation_summaryJson,
    completedAt: isoOrNull(row.operation_completedAt),
    rolledBackAt: isoOrNull(row.operation_rolledBackAt),
    operationCreatedByUserId: row.operation_createdByUserId,
    operationCreatedByEmployeeId: row.operation_createdByEmployeeId,
    operationCreatedAt: iso(row.operation_createdAt),
    operationUpdatedAt: iso(row.operation_updatedAt),
    rowId: row.row_id,
    rowResourceType: row.row_resourceType,
    rowResourceId: row.row_resourceId,
    entityType: row.row_entityType,
    action: row.row_action,
    rowStatus: row.row_status,
    beforeJson: row.row_beforeJson,
    afterJson: row.row_afterJson,
    detail: row.row_detail,
    sortOrder: row.row_sortOrder === null ? null : Number(row.row_sortOrder),
    rowCreatedAt: isoOrNull(row.row_createdAt),
    rowUpdatedAt: isoOrNull(row.row_updatedAt),
  };
}

const operationAuditAdapter: RevenueExportAdapter<
  RevenueExportOptionsByResource["operation_audit"]
> = {
  async page(companyId, options, context) {
    const base = operationAuditQuery(companyId, options, context.asOf);
    const counted = await base
      .clone()
      .select("COUNT(*)", "count")
      .getRawOne<{ count: number | string }>();
    const total = Number(counted?.count ?? 0);
    const query = base
      .select("operation.id", "operation_id")
      .addSelect("operation.companyId", "operation_companyId")
      .addSelect("operation.kind", "operation_kind")
      .addSelect("operation.resourceType", "operation_resourceType")
      .addSelect("operation.status", "operation_status")
      .addSelect("operation.idempotencyKey", "operation_idempotencyKey")
      .addSelect("operation.sourceId", "operation_sourceId")
      .addSelect("operation.targetId", "operation_targetId")
      .addSelect("operation.requestJson", "operation_requestJson")
      .addSelect("operation.summaryJson", "operation_summaryJson")
      .addSelect("operation.completedAt", "operation_completedAt")
      .addSelect("operation.rolledBackAt", "operation_rolledBackAt")
      .addSelect("operation.createdByUserId", "operation_createdByUserId")
      .addSelect("operation.createdByEmployeeId", "operation_createdByEmployeeId")
      .addSelect("operation.createdAt", "operation_createdAt")
      .addSelect("operation.updatedAt", "operation_updatedAt")
      .addSelect("operationRow.id", "row_id")
      .addSelect("operationRow.resourceType", "row_resourceType")
      .addSelect("operationRow.resourceId", "row_resourceId")
      .addSelect("operationRow.entityType", "row_entityType")
      .addSelect("operationRow.action", "row_action")
      .addSelect("operationRow.status", "row_status")
      .addSelect("operationRow.beforeJson", "row_beforeJson")
      .addSelect("operationRow.afterJson", "row_afterJson")
      .addSelect("operationRow.detail", "row_detail")
      .addSelect("operationRow.sortOrder", "row_sortOrder")
      .addSelect("operationRow.createdAt", "row_createdAt")
      .addSelect("operationRow.updatedAt", "row_updatedAt")
      .addSelect("COALESCE(operationRow.sortOrder, -1)", "audit_sortOrder")
      .addSelect("COALESCE(operationRow.id, '')", "audit_rowKey");

    if (context.cursor) {
      if (
        typeof context.cursor.timestamp !== "string" ||
        typeof context.cursor.id !== "string" ||
        typeof context.cursor.sortOrder !== "number" ||
        typeof context.cursor.subId !== "string"
      ) {
        throw new Error("Invalid Revenue export cursor");
      }
      const timestamp = new Date(context.cursor.timestamp);
      if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid Revenue export cursor");
      if (timestamp.getTime() > context.asOf.getTime()) {
        throw new Error("Invalid Revenue export cursor");
      }
      query.andWhere(
        "(operation.createdAt > :cursorTimestamp OR " +
          "(operation.createdAt = :cursorTimestamp AND operation.id > :cursorId) OR " +
          "(operation.createdAt = :cursorTimestamp AND operation.id = :cursorId " +
          "AND COALESCE(operationRow.sortOrder, -1) > :cursorSortOrder) OR " +
          "(operation.createdAt = :cursorTimestamp AND operation.id = :cursorId " +
          "AND COALESCE(operationRow.sortOrder, -1) = :cursorSortOrder " +
          "AND COALESCE(operationRow.id, '') > :cursorSubId))",
        {
          cursorTimestamp: timestamp,
          cursorId: context.cursor.id,
          cursorSortOrder: context.cursor.sortOrder,
          cursorSubId: context.cursor.subId,
        },
      );
    } else if (context.offset > 0) {
      query.offset(context.offset);
    }

    const fetched = await query
      .orderBy("operation.createdAt", "ASC")
      .addOrderBy("operation.id", "ASC")
      .addOrderBy("audit_sortOrder", "ASC")
      .addOrderBy("audit_rowKey", "ASC")
      .limit(context.limit + 1)
      .getRawMany<OperationAuditRaw>();
    const hasMore = fetched.length > context.limit;
    const pageRows = fetched.slice(0, context.limit);
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            version: 1,
            resource: context.resource,
            asOf: context.asOf.toISOString(),
            timestamp: iso(last.operation_createdAt),
            id: last.operation_id,
            sortOrder: Number(last.audit_sortOrder),
            subId: last.audit_rowKey,
          })
        : null;
    return {
      total,
      rows: pageRows.map(operationAuditRow),
      nextOffset: !context.cursor && hasMore ? context.offset + pageRows.length : null,
      nextCursor,
    };
  },
};

const followUpAdapter: RevenueExportAdapter<RevenueExportBaseOptions> = {
  async page(companyId, _options, context) {
    const page = await listFollowUpPage(companyId, {
      state: "all",
      closedDeals: "include",
      archivedResources: "include",
      createdBefore: context.asOf,
      limit: context.limit,
      offset: context.cursor ? undefined : context.offset,
      cursor: context.cursor?.innerCursor,
    });
    const last = page.rows.at(-1);
    const nextCursor =
      page.nextCursor && last
        ? encodeCursor({
            version: 1,
            resource: context.resource,
            asOf: context.asOf.toISOString(),
            timestamp: last.dueAt.toISOString(),
            id: last.id,
            innerCursor: page.nextCursor,
          })
        : null;
    return {
      total: null,
      rows: page.rows.map(plain),
      nextOffset: !context.cursor && page.nextCursor ? context.offset + page.rows.length : null,
      nextCursor,
    };
  },
};

const revenueExportAdapters: {
  [Resource in RevenueExportResource]: RevenueExportAdapter<
    RevenueExportOptionsByResource[Resource]
  >;
} = {
  accounts: timestampAdapter(Customer),
  contacts: timestampAdapter(Contact),
  deals: timestampAdapter(Deal),
  partnerships: timestampAdapter(Partnership),
  partnership_contacts: timestampAdapter(PartnershipContact),
  buying_committees: timestampAdapter(DealContact),
  follow_ups: followUpAdapter,
  documents: timestampAdapter(RevenueDocument),
  stage_definitions: timestampAdapter(DealStage),
  custom_fields: timestampAdapter(RevenueCustomField),
  custom_values: timestampAdapter(RevenueCustomValue),
  import_reconciliation: timestampAdapter(RevenueImportRow),
  deal_history: timestampAdapter<RevenueExportOptionsByResource["deal_history"]>(DealHistoryEvent, {
    orderColumn: "occurredAt",
    configure(query, options) {
      if (options.dealId) query.andWhere("row.dealId = :dealId", { dealId: options.dealId });
      if (options.sourceKind) {
        query.andWhere("row.sourceKind = :sourceKind", { sourceKind: options.sourceKind });
      }
      if (options.kind) query.andWhere("row.kind = :kind", { kind: options.kind });
      if (options.from) query.andWhere("row.occurredAt >= :from", { from: options.from });
      if (options.to) query.andWhere("row.occurredAt < :to", { to: options.to });
    },
    serialize: dealHistoryRow,
  }),
  field_evidence: timestampAdapter<RevenueExportOptionsByResource["field_evidence"]>(
    RevenueFieldEvidence,
    {
      configure(query, options) {
        if (options.resourceType) {
          query.andWhere("row.resourceType = :resourceType", {
            resourceType: options.resourceType,
          });
        }
        if (options.resourceId) {
          query.andWhere("row.resourceId = :resourceId", { resourceId: options.resourceId });
        }
        if (options.fieldKey) {
          query.andWhere("row.fieldKey = :fieldKey", { fieldKey: options.fieldKey });
        }
        if (options.sourceType) {
          query.andWhere("row.sourceType = :sourceType", { sourceType: options.sourceType });
        }
        if (options.excludeSourceTypes?.length) {
          query.andWhere("row.sourceType NOT IN (:...excludeSourceTypes)", {
            excludeSourceTypes: options.excludeSourceTypes,
          });
        }
        if (options.allowedEmailAccountIds !== undefined) {
          query.leftJoin(
            Contact,
            "evidenceSourceContact",
            "evidenceSourceContact.id = row.sourceId AND evidenceSourceContact.companyId = row.companyId AND row.sourceType = :emailContactSourceType",
            { emailContactSourceType: "email" },
          );
          query.leftJoin(
            MailMessage,
            "evidenceAnySourceMessage",
            "evidenceAnySourceMessage.id = row.sourceId AND evidenceAnySourceMessage.companyId = row.companyId AND row.sourceType = :emailMessageSourceType",
            { emailMessageSourceType: "email" },
          );
          if (options.allowedEmailAccountIds.length === 0) {
            query.andWhere(
              "(row.sourceType <> :emailSourceType OR (evidenceSourceContact.id IS NOT NULL AND evidenceAnySourceMessage.id IS NULL))",
              {
                emailSourceType: "email",
              },
            );
          } else {
            query.andWhere(
              "(row.sourceType <> :emailSourceType OR " +
                "(evidenceSourceContact.id IS NOT NULL AND evidenceAnySourceMessage.id IS NULL) OR " +
                "evidenceAnySourceMessage.accountId IN (:...allowedEvidenceMailAccountIds))",
              {
                emailSourceType: "email",
                allowedEvidenceMailAccountIds: options.allowedEmailAccountIds,
              },
            );
          }
        }
        if (options.allowedIntegrationEvidenceIds !== undefined) {
          if (options.allowedIntegrationEvidenceIds.length === 0) {
            query.andWhere("row.sourceType <> :integrationSourceType", {
              integrationSourceType: "integration",
            });
          } else {
            query.andWhere(
              "(row.sourceType <> :integrationSourceType OR row.id IN (:...allowedIntegrationEvidenceIds))",
              {
                integrationSourceType: "integration",
                allowedIntegrationEvidenceIds: options.allowedIntegrationEvidenceIds,
              },
            );
          }
        }
        if (options.status) query.andWhere("row.status = :status", { status: options.status });
      },
      serialize: fieldEvidenceRow,
    },
  ),
  duplicate_candidates: timestampAdapter<RevenueExportOptionsByResource["duplicate_candidates"]>(
    RevenueDuplicateCandidate,
    {
      orderColumn: "detectedAt",
      configure(query, options) {
        if (options.resourceType) {
          query.andWhere("row.resourceType = :resourceType", {
            resourceType: options.resourceType,
          });
        }
        if (options.status) query.andWhere("row.status = :status", { status: options.status });
        if (options.minScore !== undefined) {
          query.andWhere("row.score >= :minScore", { minScore: options.minScore });
        }
      },
      serialize: duplicateCandidateRow,
    },
  ),
  operation_audit: operationAuditAdapter,
  document_candidates: timestampAdapter<RevenueExportOptionsByResource["document_candidates"]>(
    RevenueDocumentCandidate,
    {
      configure(query, options) {
        if (options.status) query.andWhere("row.status = :status", { status: options.status });
        if (options.accountId) {
          query
            .innerJoin(
              MailMessage,
              "sourceMessage",
              "sourceMessage.id = row.mailMessageId AND sourceMessage.companyId = row.companyId",
            )
            .andWhere("sourceMessage.accountId = :accountId", {
              accountId: options.accountId,
            });
        }
      },
      serialize: documentCandidateRow,
    },
  ),
};

export async function exportRevenueSnapshotPage<Resource extends RevenueExportResource>(
  companyId: string,
  resource: Resource,
  options: RevenueExportOptionsByResource[Resource] = {} as RevenueExportOptionsByResource[Resource],
): Promise<RevenueExportPage> {
  if (resource === "import_reconciliation") {
    await ensureRevenueImportRowsForCompany(companyId);
  }
  let resolvedOptions = options;
  if (resource === "field_evidence") {
    const fieldOptions = options as RevenueExportOptionsByResource["field_evidence"];
    if (fieldOptions.allowedIntegrationConnectionIds !== undefined) {
      const allowedConnectionIds = new Set(fieldOptions.allowedIntegrationConnectionIds);
      const candidates = await AppDataSource.getRepository(RevenueFieldEvidence).find({
        select: { id: true, metadataJson: true },
        where: { companyId, sourceType: "integration" },
      });
      const allowedIntegrationEvidenceIds = candidates
        .filter((candidate) => {
          try {
            const metadata = JSON.parse(candidate.metadataJson || "{}") as unknown;
            return (
              metadata !== null &&
              typeof metadata === "object" &&
              !Array.isArray(metadata) &&
              typeof (metadata as Record<string, unknown>).connectionId === "string" &&
              allowedConnectionIds.has((metadata as Record<string, unknown>).connectionId as string)
            );
          } catch {
            return false;
          }
        })
        .map((candidate) => candidate.id);
      resolvedOptions = {
        ...fieldOptions,
        allowedIntegrationEvidenceIds,
      } as RevenueExportOptionsByResource[Resource];
    }
  }
  const context = pageContext(resource, resolvedOptions);
  const adapter = revenueExportAdapters[resource] as RevenueExportAdapter<
    RevenueExportOptionsByResource[Resource]
  >;
  const result = await adapter.page(companyId, resolvedOptions, context);
  return {
    resource,
    generatedAt: context.generatedAt,
    asOf: context.asOf,
    offset: context.offset,
    limit: context.limit,
    total: result.total,
    nextOffset: result.nextOffset,
    nextCursor: result.nextCursor,
    rows: result.rows,
  };
}

function csvValue(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  // Quoting is not enough to stop spreadsheet applications interpreting
  // attacker-controlled text as a formula. Preserve the text while forcing
  // formula-looking strings (including those hidden behind whitespace or
  // control characters) to be imported as literal cells.
  if (typeof value === "string") {
    let firstVisible = 0;
    while (firstVisible < text.length && text.charCodeAt(firstVisible) <= 0x20) {
      firstVisible += 1;
    }
    if (["=", "+", "-", "@"].includes(text[firstVisible] ?? "")) {
      text = `'${text}`;
    }
  }
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
