import { EntityManager, In, type EntityTarget, type ObjectLiteral } from "typeorm";
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
import { DealStage } from "../../db/entities/DealStage.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { RecurringInvoice } from "../../db/entities/RecurringInvoice.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueDocument } from "../../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../../db/entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueFirmographicLookup } from "../../db/entities/RevenueFirmographicLookup.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { RevenueRecordAlias, type RevenueAliasType } from "../../db/entities/RevenueRecordAlias.js";
import { SequenceEnrollment } from "../../db/entities/SequenceEnrollment.js";
import { SignalEvent } from "../../db/entities/SignalEvent.js";
import { Suppression } from "../../db/entities/Suppression.js";
import {
  appendRevenueOperationRows,
  createRevenueOperation,
  type OperationRowWrite,
  type RevenueOperationActor,
} from "./operations.js";

export type MergeResourceType = "account" | "contact" | "deal" | "partnership";

type MergeRecord = Customer | Contact | Deal | Partnership;

export type MergeFieldConflict = {
  field: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  resolution: "source" | "target";
  resolvedValue: unknown;
};

export type MergeCustomFieldConflict = MergeFieldConflict & {
  fieldId: string;
  fieldKey: string;
};

export type RevenueMergePreview = {
  resourceType: MergeResourceType;
  source: { id: string; label: string; archivedAt: Date | null };
  target: { id: string; label: string; archivedAt: Date | null };
  fieldConflicts: MergeFieldConflict[];
  relationshipCounts: Record<string, number>;
  customValuesCopied: number;
  customValueConflicts: number;
  customFieldConflicts: MergeCustomFieldConflict[];
  operationId?: string;
};

export type MergeConflictResolutions = Record<string, "source" | "target">;

type MergeDescriptor = {
  labelKey: "name" | "title";
  fields: Array<{ key: string; label: string; sourceWhenTargetEmpty?: boolean }>;
  aliases: Array<{ key: string; type: RevenueAliasType }>;
};

const DESCRIPTORS: Record<MergeResourceType, MergeDescriptor> = {
  account: {
    labelKey: "name",
    fields: [
      { key: "name", label: "Name" },
      { key: "email", label: "Billing email" },
      { key: "phone", label: "Phone" },
      { key: "accountStatus", label: "Account status" },
      { key: "domain", label: "Domain" },
      { key: "websiteUrl", label: "Website" },
      { key: "industry", label: "Industry" },
      { key: "employeeCount", label: "Employee count" },
      { key: "headquartersAddress", label: "Headquarters address" },
      { key: "parentCompanyName", label: "Parent company name" },
      { key: "parentCompanyDomain", label: "Parent company domain" },
      { key: "ownerId", label: "Member owner" },
      { key: "ownerEmployeeId", label: "AI Employee owner" },
      { key: "billingAddress", label: "Billing address" },
      { key: "shippingAddress", label: "Shipping address" },
      { key: "taxNumber", label: "Tax number" },
      { key: "currency", label: "Currency" },
      { key: "annualContractValueCents", label: "Annual Contract Value" },
      { key: "notes", label: "Notes" },
    ],
    aliases: [
      { key: "id", type: "merged_record_id" },
      { key: "name", type: "name" },
      { key: "domain", type: "domain" },
      { key: "websiteUrl", type: "website" },
    ],
  },
  contact: {
    labelKey: "name",
    fields: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "phone", label: "Phone" },
      { key: "title", label: "Title" },
      { key: "linkedinUrl", label: "LinkedIn URL" },
      { key: "websiteUrl", label: "Website" },
      { key: "customerId", label: "Account" },
      { key: "companyName", label: "Company name" },
      { key: "lifecycleStage", label: "Lifecycle" },
      { key: "ownerId", label: "Member owner" },
      { key: "ownerEmployeeId", label: "AI Employee owner" },
      { key: "source", label: "Source" },
      { key: "sourceDetail", label: "Source detail" },
      { key: "score", label: "Score" },
      { key: "notes", label: "Notes" },
      { key: "doNotContact", label: "Do not contact" },
      { key: "unsubscribedAt", label: "Unsubscribed at" },
      { key: "bouncedAt", label: "Bounced at" },
    ],
    aliases: [
      { key: "id", type: "merged_record_id" },
      { key: "name", type: "name" },
      { key: "email", type: "email" },
      { key: "websiteUrl", type: "website" },
    ],
  },
  deal: {
    labelKey: "title",
    fields: [
      { key: "title", label: "Title" },
      { key: "description", label: "Description" },
      { key: "customerId", label: "Account" },
      { key: "primaryContactId", label: "Primary Contact" },
      { key: "stageId", label: "Deal Stage" },
      { key: "amountCents", label: "Amount" },
      { key: "currency", label: "Currency" },
      { key: "probabilityOverride", label: "Probability" },
      { key: "expectedCloseDate", label: "Expected close" },
      { key: "status", label: "Status" },
      { key: "closedAt", label: "Closed at" },
      { key: "lostReason", label: "Lost reason" },
      { key: "source", label: "Source" },
      { key: "ownerId", label: "Member owner" },
      { key: "ownerEmployeeId", label: "AI Employee owner" },
      { key: "nextStep", label: "Next step" },
      {
        key: "nextFollowUpAt",
        label: "Next follow-up",
        sourceWhenTargetEmpty: true,
      },
      {
        key: "followUpReminderAt",
        label: "Follow-up reminder",
        sourceWhenTargetEmpty: true,
      },
    ],
    aliases: [
      { key: "id", type: "merged_record_id" },
      { key: "title", type: "name" },
    ],
  },
  partnership: {
    labelKey: "name",
    fields: [
      { key: "name", label: "Name" },
      { key: "type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "customerId", label: "Account" },
      { key: "websiteUrl", label: "Website" },
      { key: "integrationContext", label: "Integration context" },
      { key: "channelContext", label: "Channel context" },
      { key: "notes", label: "Notes" },
      { key: "ownerId", label: "Member owner" },
      { key: "ownerEmployeeId", label: "AI Employee owner" },
      {
        key: "nextFollowUpAt",
        label: "Next follow-up",
        sourceWhenTargetEmpty: true,
      },
      { key: "reminderAt", label: "Reminder", sourceWhenTargetEmpty: true },
    ],
    aliases: [
      { key: "id", type: "merged_record_id" },
      { key: "name", type: "name" },
      { key: "websiteUrl", type: "website" },
    ],
  },
};

function labelOf(type: MergeResourceType, row: MergeRecord): string {
  const descriptor = DESCRIPTORS[type];
  return String((row as unknown as Record<string, unknown>)[descriptor.labelKey] ?? "");
}

function empty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || value === 0;
}

function same(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function fieldConflicts(
  type: MergeResourceType,
  source: MergeRecord,
  target: MergeRecord,
  resolutions: MergeConflictResolutions = {},
): MergeFieldConflict[] {
  const sourceValues = source as unknown as Record<string, unknown>;
  const targetValues = target as unknown as Record<string, unknown>;
  return DESCRIPTORS[type].fields
    .filter(({ key }) => !same(sourceValues[key], targetValues[key]))
    .filter(({ key }) => !empty(sourceValues[key]) || !empty(targetValues[key]))
    .map(({ key, label, sourceWhenTargetEmpty }) => {
      const resolution =
        resolutions[key] ??
        (sourceWhenTargetEmpty && empty(targetValues[key]) ? "source" : "target");
      return {
        field: key,
        label,
        sourceValue: sourceValues[key] ?? null,
        targetValue: targetValues[key] ?? null,
        resolution,
        resolvedValue:
          resolution === "source" ? (sourceValues[key] ?? null) : (targetValues[key] ?? null),
      };
    });
}

function resolvedSurvivor(
  type: MergeResourceType,
  source: MergeRecord,
  target: MergeRecord,
  resolutions: MergeConflictResolutions,
): MergeRecord {
  const survivor = { ...target } as unknown as Record<string, unknown>;
  for (const conflict of fieldConflicts(type, source, target, resolutions)) {
    if (conflict.resolution === "source") survivor[conflict.field] = conflict.sourceValue;
  }
  return survivor as unknown as MergeRecord;
}

async function assertSurvivorInvariants(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  survivor: MergeRecord,
): Promise<void> {
  const owned = survivor as MergeRecord & {
    ownerId: string | null;
    ownerEmployeeId: string | null;
  };
  if (owned.ownerId && owned.ownerEmployeeId) {
    throw new Error(`Merged ${type} cannot have both a Member owner and an AI Employee owner`);
  }
  if (type !== "deal") return;

  const deal = survivor as Deal;
  const stage = await manager.findOneBy(DealStage, {
    companyId,
    id: deal.stageId,
  });
  if (!stage) {
    throw new Error(`Merged Deal stage ${deal.stageId} does not belong to this company`);
  }
  if (deal.status !== stage.kind) {
    throw new Error(
      `Merged Deal status ${deal.status} does not match Deal Stage kind ${stage.kind}`,
    );
  }

  const validClosedAt = deal.closedAt instanceof Date && !Number.isNaN(deal.closedAt.getTime());
  if (stage.kind === "open") {
    if (deal.closedAt !== null || deal.lostReason.trim() !== "") {
      throw new Error("Merged open Deal cannot have a close date or lost reason");
    }
    return;
  }
  if (!validClosedAt) {
    throw new Error("Merged terminal Deal must have a valid close date");
  }
  if (stage.kind === "won" && deal.lostReason.trim() !== "") {
    throw new Error("Merged won Deal cannot have a lost reason");
  }
}

async function loadRecord(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  id: string,
): Promise<MergeRecord | null> {
  switch (type) {
    case "account":
      return manager.findOneBy(Customer, { companyId, id });
    case "contact":
      return manager.findOneBy(Contact, { companyId, id });
    case "deal":
      return manager.findOneBy(Deal, { companyId, id });
    case "partnership":
      return manager.findOneBy(Partnership, { companyId, id });
  }
}

async function loadPair(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
): Promise<{ source: MergeRecord; target: MergeRecord }> {
  if (sourceId === targetId) throw new Error("A record cannot be merged into itself");
  const [source, target] = await Promise.all([
    loadRecord(manager, companyId, type, sourceId),
    loadRecord(manager, companyId, type, targetId),
  ]);
  if (!source) throw new Error(`Source ${type} not found`);
  if (!target) throw new Error(`Destination ${type} not found`);
  if (target.archivedAt) {
    throw new Error(`Restore the destination ${type} before merging into it`);
  }
  const prior = await manager.findOneBy(RevenueOperation, {
    companyId,
    kind: "merge",
    resourceType: type,
    sourceId,
    status: "completed",
  });
  if (prior) throw new Error(`Source ${type} is already merged into ${prior.targetId}`);
  return { source, target };
}

async function countWhere(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
  where: Record<string, unknown>,
): Promise<number> {
  return manager.getRepository(entity).count({ where });
}

async function relationshipCounts(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
): Promise<Record<string, number>> {
  const [evidence, documentCandidates] = await Promise.all([
    countWhere(manager, RevenueFieldEvidence, {
      companyId,
      resourceType: type,
      resourceId: sourceId,
    }),
    countWhere(manager, RevenueDocumentCandidate, {
      companyId,
      proposedResourceType: type,
      proposedResourceId: sourceId,
    }),
  ]);
  const sharedCounts = { evidence, documentCandidates };
  if (type === "account") {
    const [
      contacts,
      deals,
      activities,
      partnerships,
      documents,
      signalEvents,
      billingContacts,
      contracts,
      invoices,
      estimates,
      recurringInvoices,
      credits,
      firmographicLookups,
      firmographicLookupConflicts,
    ] = await Promise.all([
      countWhere(manager, Contact, { companyId, customerId: sourceId }),
      countWhere(manager, Deal, { companyId, customerId: sourceId }),
      countWhere(manager, Activity, { companyId, customerId: sourceId }),
      countWhere(manager, Partnership, { companyId, customerId: sourceId }),
      countWhere(manager, RevenueDocument, { companyId, customerId: sourceId }),
      countWhere(manager, SignalEvent, { companyId, customerId: sourceId }),
      countWhere(manager, CustomerContact, { companyId, customerId: sourceId }),
      countWhere(manager, CustomerContract, { companyId, customerId: sourceId }),
      countWhere(manager, Invoice, { companyId, customerId: sourceId }),
      countWhere(manager, Estimate, { companyId, customerId: sourceId }),
      countWhere(manager, RecurringInvoice, { companyId, customerId: sourceId }),
      countWhere(manager, CustomerCredit, { companyId, customerId: sourceId }),
      countWhere(manager, RevenueFirmographicLookup, { companyId, customerId: sourceId }),
      manager
        .getRepository(RevenueFirmographicLookup)
        .createQueryBuilder("source")
        .innerJoin(
          RevenueFirmographicLookup,
          "target",
          "target.companyId = source.companyId AND target.customerId = :targetId AND target.connectionId = source.connectionId",
          { targetId },
        )
        .where("source.companyId = :companyId", { companyId })
        .andWhere("source.customerId = :sourceId", { sourceId })
        .getCount(),
    ]);
    return {
      ...sharedCounts,
      contacts,
      deals,
      activities,
      partnerships,
      documents,
      signalEvents,
      billingContacts,
      contracts,
      invoices,
      estimates,
      recurringInvoices,
      credits,
      firmographicLookups,
      firmographicLookupConflicts,
    };
  }
  if (type === "contact") {
    const [
      activities,
      primaryDeals,
      dealCommittees,
      partnershipContacts,
      documents,
      enrollments,
      signalEvents,
      suppressions,
      dealCommitteeConflicts,
      partnershipContactConflicts,
      enrollmentConflicts,
    ] = await Promise.all([
      countWhere(manager, Activity, { companyId, contactId: sourceId }),
      countWhere(manager, Deal, { companyId, primaryContactId: sourceId }),
      countWhere(manager, DealContact, { companyId, contactId: sourceId }),
      countWhere(manager, PartnershipContact, { companyId, contactId: sourceId }),
      countWhere(manager, RevenueDocument, { companyId, contactId: sourceId }),
      countWhere(manager, SequenceEnrollment, { companyId, contactId: sourceId }),
      countWhere(manager, SignalEvent, { companyId, contactId: sourceId }),
      countWhere(manager, Suppression, { companyId, contactId: sourceId }),
      manager
        .getRepository(DealContact)
        .createQueryBuilder("source")
        .innerJoin(
          DealContact,
          "target",
          "target.companyId = source.companyId AND target.dealId = source.dealId AND target.contactId = :targetId",
          { targetId },
        )
        .where("source.companyId = :companyId", { companyId })
        .andWhere("source.contactId = :sourceId", { sourceId })
        .getCount(),
      manager
        .getRepository(PartnershipContact)
        .createQueryBuilder("source")
        .innerJoin(
          PartnershipContact,
          "target",
          "target.companyId = source.companyId AND target.partnershipId = source.partnershipId AND target.contactId = :targetId",
          { targetId },
        )
        .where("source.companyId = :companyId", { companyId })
        .andWhere("source.contactId = :sourceId", { sourceId })
        .getCount(),
      manager
        .getRepository(SequenceEnrollment)
        .createQueryBuilder("source")
        .innerJoin(
          SequenceEnrollment,
          "target",
          "target.companyId = source.companyId AND target.sequenceId = source.sequenceId AND target.contactId = :targetId",
          { targetId },
        )
        .where("source.companyId = :companyId", { companyId })
        .andWhere("source.contactId = :sourceId", { sourceId })
        .getCount(),
    ]);
    return {
      ...sharedCounts,
      activities,
      primaryDeals,
      dealCommittees,
      partnershipContacts,
      documents,
      enrollments,
      signalEvents,
      suppressions,
      dealCommitteeConflicts,
      partnershipContactConflicts,
      enrollmentConflicts,
    };
  }
  if (type === "deal") {
    const [
      activities,
      committeeMembers,
      documents,
      enrollments,
      signalEvents,
      historyEvents,
      committeeConflicts,
    ] = await Promise.all([
      countWhere(manager, Activity, { companyId, dealId: sourceId }),
      countWhere(manager, DealContact, { companyId, dealId: sourceId }),
      countWhere(manager, RevenueDocument, { companyId, dealId: sourceId }),
      countWhere(manager, SequenceEnrollment, { companyId, dealId: sourceId }),
      countWhere(manager, SignalEvent, { companyId, dealId: sourceId }),
      countWhere(manager, DealHistoryEvent, { companyId, dealId: sourceId }),
      manager
        .getRepository(DealContact)
        .createQueryBuilder("source")
        .innerJoin(
          DealContact,
          "target",
          "target.companyId = source.companyId AND target.dealId = :targetId AND target.contactId = source.contactId",
          { targetId },
        )
        .where("source.companyId = :companyId", { companyId })
        .andWhere("source.dealId = :sourceId", { sourceId })
        .getCount(),
    ]);
    return {
      ...sharedCounts,
      activities,
      committeeMembers,
      documents,
      enrollments,
      signalEvents,
      historyEvents,
      committeeConflicts,
    };
  }
  const [activities, contacts, documents, contactConflicts] = await Promise.all([
    countWhere(manager, Activity, { companyId, partnershipId: sourceId }),
    countWhere(manager, PartnershipContact, { companyId, partnershipId: sourceId }),
    countWhere(manager, RevenueDocument, { companyId, partnershipId: sourceId }),
    manager
      .getRepository(PartnershipContact)
      .createQueryBuilder("source")
      .innerJoin(
        PartnershipContact,
        "target",
        "target.companyId = source.companyId AND target.partnershipId = :targetId AND target.contactId = source.contactId",
        { targetId },
      )
      .where("source.companyId = :companyId", { companyId })
      .andWhere("source.partnershipId = :sourceId", { sourceId })
      .getCount(),
  ]);
  return { ...sharedCounts, activities, contacts, documents, contactConflicts };
}

async function customValuePreview(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  resolutions: MergeConflictResolutions = {},
): Promise<{
  copied: number;
  conflicts: number;
  fieldConflicts: MergeCustomFieldConflict[];
}> {
  const [source, target, fields] = await Promise.all([
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: sourceId },
    }),
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: targetId },
    }),
    manager.find(RevenueCustomField, { where: { companyId, resourceType: type } }),
  ]);
  const targetByField = new Map(target.map((value) => [value.fieldId, value]));
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const conflicting = source.filter((value) => targetByField.has(value.fieldId));
  return {
    copied: source.length - conflicting.length,
    conflicts: conflicting.length,
    fieldConflicts: conflicting.map((sourceValue) => {
      const targetValue = targetByField.get(sourceValue.fieldId)!;
      const field = fieldsById.get(sourceValue.fieldId);
      const key = `custom:${sourceValue.fieldId}`;
      const resolution = resolutions[key] ?? "target";
      const parsedSource = JSON.parse(sourceValue.valueJson) as unknown;
      const parsedTarget = JSON.parse(targetValue.valueJson) as unknown;
      return {
        field: key,
        fieldId: sourceValue.fieldId,
        fieldKey: field?.key ?? sourceValue.fieldId,
        label: field?.name ?? field?.key ?? "Custom field",
        sourceValue: parsedSource,
        targetValue: parsedTarget,
        resolution,
        resolvedValue: resolution === "source" ? parsedSource : parsedTarget,
      };
    }),
  };
}

export async function previewRevenueMerge(
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  resolutions: MergeConflictResolutions = {},
): Promise<RevenueMergePreview> {
  const manager = AppDataSource.manager;
  const { source, target } = await loadPair(manager, companyId, type, sourceId, targetId);
  const [counts, custom] = await Promise.all([
    relationshipCounts(manager, companyId, type, sourceId, targetId),
    customValuePreview(manager, companyId, type, sourceId, targetId, resolutions),
  ]);
  return {
    resourceType: type,
    source: { id: source.id, label: labelOf(type, source), archivedAt: source.archivedAt },
    target: { id: target.id, label: labelOf(type, target), archivedAt: target.archivedAt },
    fieldConflicts: fieldConflicts(type, source, target, resolutions),
    relationshipCounts: counts,
    customValuesCopied: custom.copied,
    customValueConflicts: custom.conflicts,
    customFieldConflicts: custom.fieldConflicts,
  };
}

function serializeEntity(row: ObjectLiteral): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

type DuplicateReason = { kind?: unknown; value?: unknown; score?: unknown };

function mergedDuplicateEvidence(...serializedReasons: string[]): {
  reasonsJson: string;
  score: number;
} {
  const reasons = new Map<string, DuplicateReason>();
  for (const serialized of serializedReasons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed)) continue;
    for (const reason of parsed) {
      if (!reason || typeof reason !== "object") continue;
      const typed = reason as DuplicateReason;
      reasons.set(JSON.stringify(typed), typed);
    }
  }
  const merged = [...reasons.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  const score = Math.min(
    100,
    merged.reduce(
      (total, reason) =>
        total +
        (typeof reason.score === "number" && Number.isFinite(reason.score) ? reason.score : 0),
      0,
    ),
  );
  return { reasonsJson: JSON.stringify(merged), score };
}

async function reconcileDuplicateCandidatesAfterMerge(
  manager: EntityManager,
  rows: OperationRowWrite[],
  operation: RevenueOperation,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  actor: RevenueOperationActor,
): Promise<void> {
  const candidates = await manager.find(RevenueDuplicateCandidate, {
    where: [
      { companyId: operation.companyId, resourceType: type, leftId: sourceId },
      { companyId: operation.companyId, resourceType: type, rightId: sourceId },
    ],
  });

  for (const candidate of candidates) {
    const otherId = candidate.leftId === sourceId ? candidate.rightId : candidate.leftId;
    if (otherId === targetId) {
      if (candidate.status === "merged") continue;
      const before = {
        status: candidate.status,
        mergeOperationId: candidate.mergeOperationId,
        resolvedAt: candidate.resolvedAt,
        resolvedByUserId: candidate.resolvedByUserId,
      };
      const after = {
        status: "merged",
        mergeOperationId: operation.id,
        resolvedAt: operation.completedAt,
        resolvedByUserId: actor.userId ?? null,
      };
      rows.push({
        resourceType: type,
        resourceId: candidate.id,
        entityType: "revenue_duplicate_candidate",
        action: "resolve_duplicate_candidate",
        before,
        after,
      });
      Object.assign(candidate, after);
      await manager.save(RevenueDuplicateCandidate, candidate);
      continue;
    }

    if (candidate.status !== "open") continue;
    const [leftId, rightId] = [targetId, otherId].sort();
    const existing = await manager.findOneBy(RevenueDuplicateCandidate, {
      companyId: operation.companyId,
      resourceType: type,
      leftId,
      rightId,
    });
    if (existing && existing.id !== candidate.id) {
      if (existing.status === "open") {
        const before = {
          score: existing.score,
          reasonsJson: existing.reasonsJson,
        };
        const after = mergedDuplicateEvidence(existing.reasonsJson, candidate.reasonsJson);
        if (before.score !== after.score || before.reasonsJson !== after.reasonsJson) {
          rows.push({
            resourceType: type,
            resourceId: existing.id,
            entityType: "revenue_duplicate_candidate",
            action: "combine_duplicate_candidate_evidence",
            before,
            after,
          });
          existing.score = after.score;
          existing.reasonsJson = after.reasonsJson;
          await manager.save(RevenueDuplicateCandidate, existing);
        }
      }
      rows.push({
        resourceType: type,
        resourceId: candidate.id,
        entityType: "revenue_duplicate_candidate",
        action: "deduplicate_duplicate_candidate",
        before: serializeEntity(candidate),
        after: null,
      });
      await manager.delete(RevenueDuplicateCandidate, {
        companyId: operation.companyId,
        id: candidate.id,
      });
      continue;
    }

    rows.push({
      resourceType: type,
      resourceId: candidate.id,
      entityType: "revenue_duplicate_candidate",
      action: "reparent_duplicate_candidate",
      before: { leftId: candidate.leftId, rightId: candidate.rightId },
      after: { leftId, rightId },
    });
    candidate.leftId = leftId;
    candidate.rightId = rightId;
    await manager.save(RevenueDuplicateCandidate, candidate);
  }
}

async function moveSimple<T extends ObjectLiteral & { id: string }>(
  manager: EntityManager,
  rows: OperationRowWrite[],
  input: {
    companyId: string;
    resourceType: MergeResourceType;
    entity: EntityTarget<T>;
    entityType: string;
    field: string;
    sourceId: string;
    targetId: string;
    extraAfter?: Record<string, unknown>;
    extraWhere?: Record<string, unknown>;
  },
): Promise<void> {
  const repo = manager.getRepository(input.entity);
  const found = await repo.find({
    where: {
      companyId: input.companyId,
      [input.field]: input.sourceId,
      ...(input.extraWhere ?? {}),
    } as never,
  });
  if (found.length === 0) return;
  const before = { [input.field]: input.sourceId };
  const after = {
    [input.field]: input.targetId,
    ...(input.extraAfter ?? {}),
  };
  for (const row of found) {
    const rowBefore = { ...before };
    for (const key of Object.keys(input.extraAfter ?? {})) {
      rowBefore[key] = row[key];
    }
    rows.push({
      resourceType: input.resourceType,
      resourceId: row.id,
      entityType: input.entityType,
      action: "reparent",
      before: rowBefore,
      after,
    });
  }
  await repo.update(
    {
      companyId: input.companyId,
      id: In(found.map((row) => row.id)),
      ...(input.extraWhere ?? {}),
    } as never,
    after as never,
  );
}

async function mergeCustomValues(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  resolutions: MergeConflictResolutions,
): Promise<void> {
  const [source, target] = await Promise.all([
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: sourceId },
    }),
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: targetId },
    }),
  ]);
  const targetByField = new Map(target.map((value) => [value.fieldId, value]));
  for (const sourceValue of source) {
    const targetValue = targetByField.get(sourceValue.fieldId);
    if (!targetValue || resolutions[`custom:${sourceValue.fieldId}`] !== "source") continue;
    rows.push({
      resourceType: type,
      resourceId: targetValue.id,
      entityType: "revenue_custom_value",
      action: "resolve_custom_field_conflict",
      before: {
        valueJson: targetValue.valueJson,
        searchValue: targetValue.searchValue,
      },
      after: {
        valueJson: sourceValue.valueJson,
        searchValue: sourceValue.searchValue,
      },
    });
    targetValue.valueJson = sourceValue.valueJson;
    targetValue.searchValue = sourceValue.searchValue;
    await manager.save(RevenueCustomValue, targetValue);
  }
  const targetFields = new Set(targetByField.keys());
  const movable = source.filter((value) => !targetFields.has(value.fieldId));
  for (const value of movable) {
    rows.push({
      resourceType: type,
      resourceId: value.id,
      entityType: "revenue_custom_value",
      action: "reparent_custom_value",
      before: { resourceId: sourceId },
      after: { resourceId: targetId },
    });
  }
  if (movable.length > 0) {
    await manager.update(
      RevenueCustomValue,
      { companyId, id: In(movable.map((value) => value.id)) },
      { resourceId: targetId },
    );
  }
}

type CurrentEvidenceValue =
  | { kind: "exact"; value: unknown }
  | { kind: "commercial"; amountCents: number; currency: string }
  | { kind: "unmatchable" };

function comparableEvidenceValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparableEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, comparableEvidenceValue(item)]),
    );
  }
  return value;
}

function evidenceMatchesCurrentValue(
  evidence: RevenueFieldEvidence,
  currentValues: Map<string, CurrentEvidenceValue>,
): boolean | null {
  const current = currentValues.get(evidence.fieldKey);
  if (!current) return evidence.fieldKey.startsWith("custom:") ? false : null;
  if (current.kind === "unmatchable") return false;

  let extracted: unknown;
  try {
    extracted = JSON.parse(evidence.extractedValueJson) as unknown;
  } catch {
    return false;
  }
  if (current.kind === "commercial") {
    if (!extracted || typeof extracted !== "object") return false;
    const commercial = extracted as Record<string, unknown>;
    return (
      commercial.amountCents === current.amountCents &&
      typeof commercial.currency === "string" &&
      commercial.currency.toUpperCase() === current.currency.toUpperCase()
    );
  }
  return (
    JSON.stringify(comparableEvidenceValue(extracted)) ===
    JSON.stringify(comparableEvidenceValue(current.value))
  );
}

async function reconcileFieldEvidence(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  target: MergeRecord,
): Promise<void> {
  const targetId = target.id;
  const [customFields, customValues, evidenceRows] = await Promise.all([
    manager.find(RevenueCustomField, { where: { companyId, resourceType: type } }),
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: targetId },
    }),
    manager.find(RevenueFieldEvidence, {
      where: [
        { companyId, resourceType: type, resourceId: sourceId },
        { companyId, resourceType: type, resourceId: targetId },
      ],
    }),
  ]);
  const currentValues = new Map<string, CurrentEvidenceValue>();
  const targetValues = target as unknown as Record<string, unknown>;
  for (const { key } of DESCRIPTORS[type].fields) {
    currentValues.set(key, { kind: "exact", value: targetValues[key] ?? null });
  }
  if (type === "deal") {
    const deal = target as Deal;
    currentValues.set("commercial_value", {
      kind: "commercial",
      amountCents: deal.amountCents,
      currency: deal.currency,
    });
  }
  const customValuesByField = new Map(customValues.map((value) => [value.fieldId, value]));
  for (const field of customFields) {
    const fieldKey = `custom:${field.key}`;
    const value = customValuesByField.get(field.id);
    if (!value) {
      currentValues.set(fieldKey, { kind: "exact", value: null });
      continue;
    }
    try {
      currentValues.set(fieldKey, {
        kind: "exact",
        value: JSON.parse(value.valueJson) as unknown,
      });
    } catch {
      currentValues.set(fieldKey, { kind: "unmatchable" });
    }
  }

  for (const evidence of evidenceRows) {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const reparented = evidence.resourceId === sourceId;
    if (reparented) {
      before.resourceId = sourceId;
      after.resourceId = targetId;
    }
    const matchesCurrent = evidenceMatchesCurrentValue(evidence, currentValues);
    const superseded =
      (evidence.status === "accepted" || evidence.status === "proposed") &&
      matchesCurrent === false;
    if (superseded) {
      before.status = evidence.status;
      before.verificationState = evidence.verificationState;
      after.status = "superseded";
      after.verificationState = "superseded";
    }
    if (Object.keys(after).length === 0) continue;

    rows.push({
      resourceType: type,
      resourceId: evidence.id,
      entityType: "revenue_field_evidence",
      action: reparented
        ? superseded
          ? "reparent_and_supersede_evidence"
          : "reparent_evidence"
        : "supersede_conflicting_evidence",
      before,
      after,
      detail: `Reconciled ${evidence.fieldKey} evidence with the merged ${type}`,
    });
    Object.assign(evidence, after);
    await manager.save(RevenueFieldEvidence, evidence);
  }
}

async function mergeContactJoins(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const dealRows = await manager.find(DealContact, {
    where: { companyId, contactId: sourceId },
  });
  for (const source of dealRows) {
    const target = await manager.findOneBy(DealContact, {
      companyId,
      dealId: source.dealId,
      contactId: targetId,
    });
    if (target) {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "deal_contact",
        action: "deduplicate_join",
        before: serializeEntity(source),
        after: null,
        detail: `Destination Contact is already on Deal ${source.dealId}`,
      });
      await manager.delete(DealContact, { companyId, id: source.id });
    } else {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "deal_contact",
        action: "reparent",
        before: { contactId: sourceId },
        after: { contactId: targetId },
      });
      await manager.update(DealContact, { companyId, id: source.id }, { contactId: targetId });
    }
  }

  const partnershipRows = await manager.find(PartnershipContact, {
    where: { companyId, contactId: sourceId },
  });
  for (const source of partnershipRows) {
    const target = await manager.findOneBy(PartnershipContact, {
      companyId,
      partnershipId: source.partnershipId,
      contactId: targetId,
    });
    if (target) {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "partnership_contact",
        action: "deduplicate_join",
        before: serializeEntity(source),
        after: null,
        detail: `Destination Contact is already on Partnership ${source.partnershipId}`,
      });
      await manager.delete(PartnershipContact, { companyId, id: source.id });
    } else {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "partnership_contact",
        action: "reparent",
        before: { contactId: sourceId },
        after: { contactId: targetId },
      });
      await manager.update(
        PartnershipContact,
        { companyId, id: source.id },
        { contactId: targetId },
      );
    }
  }

  const enrollmentRows = await manager.find(SequenceEnrollment, {
    where: { companyId, contactId: sourceId },
  });
  for (const source of enrollmentRows) {
    const target = await manager.findOneBy(SequenceEnrollment, {
      companyId,
      sequenceId: source.sequenceId,
      contactId: targetId,
    });
    if (target) {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "sequence_enrollment",
        action: "deduplicate_join",
        before: serializeEntity(source),
        after: null,
        detail: `Destination Contact is already enrolled in Sequence ${source.sequenceId}`,
      });
      await manager.delete(SequenceEnrollment, { companyId, id: source.id });
    } else {
      rows.push({
        resourceType: "contact",
        resourceId: source.id,
        entityType: "sequence_enrollment",
        action: "reparent",
        before: { contactId: sourceId },
        after: { contactId: targetId },
      });
      await manager.update(
        SequenceEnrollment,
        { companyId, id: source.id },
        { contactId: targetId },
      );
    }
  }
}

async function mergeDealCommittee(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const sourceRows = await manager.find(DealContact, {
    where: { companyId, dealId: sourceId },
  });
  for (const source of sourceRows) {
    const existing = await manager.findOneBy(DealContact, {
      companyId,
      dealId: targetId,
      contactId: source.contactId,
    });
    if (existing) {
      rows.push({
        resourceType: "deal",
        resourceId: source.id,
        entityType: "deal_contact",
        action: "deduplicate_join",
        before: serializeEntity(source),
        after: null,
        detail: `Destination Deal already includes Contact ${source.contactId}`,
      });
      await manager.delete(DealContact, { companyId, id: source.id });
    } else {
      rows.push({
        resourceType: "deal",
        resourceId: source.id,
        entityType: "deal_contact",
        action: "reparent",
        before: { dealId: sourceId },
        after: { dealId: targetId },
      });
      await manager.update(DealContact, { companyId, id: source.id }, { dealId: targetId });
    }
  }
}

async function mergePartnershipContacts(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const sourceRows = await manager.find(PartnershipContact, {
    where: { companyId, partnershipId: sourceId },
  });
  for (const source of sourceRows) {
    const existing = await manager.findOneBy(PartnershipContact, {
      companyId,
      partnershipId: targetId,
      contactId: source.contactId,
    });
    if (existing) {
      rows.push({
        resourceType: "partnership",
        resourceId: source.id,
        entityType: "partnership_contact",
        action: "deduplicate_join",
        before: serializeEntity(source),
        after: null,
        detail: `Destination Partnership already includes Contact ${source.contactId}`,
      });
      await manager.delete(PartnershipContact, { companyId, id: source.id });
    } else {
      rows.push({
        resourceType: "partnership",
        resourceId: source.id,
        entityType: "partnership_contact",
        action: "reparent",
        before: { partnershipId: sourceId },
        after: { partnershipId: targetId },
      });
      await manager.update(
        PartnershipContact,
        { companyId, id: source.id },
        { partnershipId: targetId },
      );
    }
  }
}

async function addAliases(
  manager: EntityManager,
  rows: OperationRowWrite[],
  operation: RevenueOperation,
  type: MergeResourceType,
  source: MergeRecord,
  target: MergeRecord,
): Promise<void> {
  const sourceAliases = await manager.find(RevenueRecordAlias, {
    where: {
      companyId: operation.companyId,
      resourceType: type,
      recordId: source.id,
    },
  });
  for (const alias of sourceAliases) {
    const duplicate = await manager.findOneBy(RevenueRecordAlias, {
      companyId: operation.companyId,
      resourceType: type,
      recordId: target.id,
      aliasType: alias.aliasType,
      normalizedValue: alias.normalizedValue,
    });
    if (duplicate) {
      rows.push({
        resourceType: type,
        resourceId: alias.id,
        entityType: "revenue_record_alias",
        action: "deduplicate_alias",
        before: serializeEntity(alias),
        after: null,
      });
      await manager.delete(RevenueRecordAlias, { companyId: operation.companyId, id: alias.id });
    } else {
      rows.push({
        resourceType: type,
        resourceId: alias.id,
        entityType: "revenue_record_alias",
        action: "reparent_alias",
        before: { recordId: source.id, operationId: alias.operationId },
        after: { recordId: target.id, operationId: operation.id },
      });
      alias.recordId = target.id;
      alias.operationId = operation.id;
      await manager.save(RevenueRecordAlias, alias);
    }
  }

  const sourceIdFields = await manager
    .getRepository(RevenueCustomValue)
    .createQueryBuilder("value")
    .innerJoin(
      RevenueCustomField,
      "field",
      "field.id = value.fieldId AND field.companyId = value.companyId",
    )
    .where("value.companyId = :companyId", { companyId: operation.companyId })
    .andWhere("value.resourceType = :resourceType", { resourceType: type })
    .andWhere("value.resourceId = :resourceId", { resourceId: source.id })
    .andWhere(
      "(LOWER(field.key) LIKE '%original%id%' OR LOWER(field.key) LIKE '%source%id%' OR LOWER(field.key) LIKE '%external%id%')",
    )
    .select(["value.valueJson AS valueJson", "field.key AS fieldKey"])
    .getRawMany<{ valueJson: string; fieldKey: string }>();
  const dynamicAliases = sourceIdFields.flatMap(({ valueJson, fieldKey }) => {
    try {
      const parsed = JSON.parse(valueJson) as unknown;
      return typeof parsed === "string" && parsed.trim()
        ? [{ key: fieldKey, value: parsed.trim(), type: "source_id" as const }]
        : [];
    } catch {
      return [];
    }
  });
  const sourceValues = source as unknown as Record<string, unknown>;
  for (const definition of [
    ...DESCRIPTORS[type].aliases.map(({ key, type: aliasType }) => ({
      key,
      value: String(sourceValues[key] ?? "").trim(),
      type: aliasType,
    })),
    ...dynamicAliases,
  ]) {
    const value = definition.value;
    const aliasType = definition.type;
    if (!value) continue;
    const normalizedValue = value.toLowerCase();
    const existing = await manager.findOneBy(RevenueRecordAlias, {
      companyId: operation.companyId,
      resourceType: type,
      recordId: target.id,
      aliasType,
      normalizedValue,
    });
    if (existing) continue;
    const alias = await manager.save(
      RevenueRecordAlias,
      manager.create(RevenueRecordAlias, {
        companyId: operation.companyId,
        resourceType: type,
        recordId: target.id,
        aliasType,
        value,
        normalizedValue,
        sourceRecordId: source.id,
        operationId: operation.id,
        provenance:
          aliasType === "source_id"
            ? `merge:${operation.id}:custom-field:${definition.key}`
            : `merge:${operation.id}`,
        verified: aliasType === "merged_record_id",
      }),
    );
    rows.push({
      resourceType: type,
      resourceId: alias.id,
      entityType: "revenue_record_alias",
      action: "create_alias",
      before: null,
      after: serializeEntity(alias),
    });
  }
}

async function applyFieldResolutions(
  manager: EntityManager,
  rows: OperationRowWrite[],
  type: MergeResourceType,
  source: MergeRecord,
  target: MergeRecord,
  resolutions: MergeConflictResolutions,
): Promise<void> {
  const conflicts = fieldConflicts(type, source, target, resolutions);
  const invalidKeys = Object.keys(resolutions)
    .filter((key) => !key.startsWith("custom:"))
    .filter((key) => !conflicts.some((conflict) => conflict.field === key));
  if (invalidKeys.length > 0) {
    throw new Error(`Unknown or non-conflicting merge field: ${invalidKeys.join(", ")}`);
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const targetValues = target as unknown as Record<string, unknown>;
  for (const conflict of conflicts) {
    if (conflict.resolution !== "source") continue;
    before[conflict.field] = targetValues[conflict.field] ?? null;
    after[conflict.field] = conflict.sourceValue;
    targetValues[conflict.field] = conflict.sourceValue;
  }
  if (Object.keys(after).length === 0) return;
  rows.push({
    resourceType: type,
    resourceId: target.id,
    entityType: type,
    action: "resolve_field_conflicts",
    before,
    after,
  });
  switch (type) {
    case "account":
      await manager.save(Customer, target as Customer);
      break;
    case "contact":
      await manager.save(Contact, target as Contact);
      break;
    case "deal":
      await manager.save(Deal, target as Deal);
      break;
    case "partnership":
      await manager.save(Partnership, target as Partnership);
      break;
  }
}

const FIRMOGRAPHIC_STATE_FIELDS = [
  "provider",
  "providerRecordId",
  "status",
  "normalizedSnapshotJson",
  "confidence",
  "lastAttemptedAt",
  "lastMatchedAt",
  "observedAt",
  "lastError",
] as const;

function firmographicState(row: RevenueFirmographicLookup): Record<string, unknown> {
  return Object.fromEntries(FIRMOGRAPHIC_STATE_FIELDS.map((field) => [field, row[field]]));
}

/**
 * Firmographic lookups were retired in 1.132.0 with the People Data Labs
 * connector; nothing creates new rows. This still runs so a merge reparents,
 * deduplicates, and can undo the historical rows that remain on the table.
 */
async function mergeFirmographicLookups(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const [sourceLookups, targetLookups] = await Promise.all([
    manager.find(RevenueFirmographicLookup, {
      where: { companyId, customerId: sourceId },
    }),
    manager.find(RevenueFirmographicLookup, {
      where: { companyId, customerId: targetId },
    }),
  ]);
  const targetByConnection = new Map(
    targetLookups.map((lookup) => [lookup.connectionId, lookup]),
  );
  for (const sourceLookup of sourceLookups) {
    const targetLookup = targetByConnection.get(sourceLookup.connectionId);
    if (!targetLookup) {
      rows.push({
        resourceType: "account",
        resourceId: sourceLookup.id,
        entityType: "revenue_firmographic_lookup",
        action: "reparent",
        before: { customerId: sourceId },
        after: { customerId: targetId },
      });
      sourceLookup.customerId = targetId;
      await manager.save(RevenueFirmographicLookup, sourceLookup);
      continue;
    }

    if (sourceLookup.lastAttemptedAt.getTime() > targetLookup.lastAttemptedAt.getTime()) {
      const before = firmographicState(targetLookup);
      const after = firmographicState(sourceLookup);
      Object.assign(targetLookup, after);
      await manager.save(RevenueFirmographicLookup, targetLookup);
      rows.push({
        resourceType: "account",
        resourceId: targetLookup.id,
        entityType: "revenue_firmographic_lookup",
        action: "retain_newest_firmographic_lookup",
        before,
        after,
      });
    }

    rows.push({
      resourceType: "account",
      resourceId: sourceLookup.id,
      entityType: "revenue_firmographic_lookup",
      action: "deduplicate_firmographic_lookup",
      before: serializeEntity(sourceLookup),
      after: null,
    });
    await manager.delete(RevenueFirmographicLookup, {
      companyId,
      id: sourceLookup.id,
    });
  }
}

async function applyRelationships(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  resolutions: MergeConflictResolutions,
): Promise<void> {
  const move = <T extends ObjectLiteral & { id: string }>(
    entity: EntityTarget<T>,
    entityType: string,
    field: string,
    extraAfter?: Record<string, unknown>,
    extraWhere?: Record<string, unknown>,
  ) =>
    moveSimple(manager, rows, {
      companyId,
      resourceType: type,
      entity,
      entityType,
      field,
      sourceId,
      targetId,
      extraAfter,
      extraWhere,
    });

  await move(
    RevenueDocumentCandidate,
    "revenue_document_candidate",
    "proposedResourceId",
    undefined,
    { proposedResourceType: type },
  );

  if (type === "account") {
    await move(Contact, "contact", "customerId");
    await move(Deal, "deal", "customerId");
    await move(Activity, "activity", "customerId");
    await move(Partnership, "partnership", "customerId");
    await move(RevenueDocument, "revenue_document", "customerId");
    await move(SignalEvent, "signal_event", "customerId");
    await move(CustomerContact, "customer_contact", "customerId", { isPrimary: false });
    await move(CustomerContract, "customer_contract", "customerId");
    await move(Invoice, "invoice", "customerId");
    await move(Estimate, "estimate", "customerId");
    await move(RecurringInvoice, "recurring_invoice", "customerId");
    await move(CustomerCredit, "customer_credit", "customerId");
    await mergeFirmographicLookups(manager, rows, companyId, sourceId, targetId);
  } else if (type === "contact") {
    await move(Activity, "activity", "contactId");
    await move(Deal, "deal", "primaryContactId");
    await move(RevenueDocument, "revenue_document", "contactId");
    await move(SignalEvent, "signal_event", "contactId");
    await move(Suppression, "suppression", "contactId");
    await mergeContactJoins(manager, rows, companyId, sourceId, targetId);
  } else if (type === "deal") {
    await move(Activity, "activity", "dealId");
    await move(DealHistoryEvent, "deal_history_event", "dealId");
    await move(RevenueDocument, "revenue_document", "dealId");
    await move(SequenceEnrollment, "sequence_enrollment", "dealId");
    await move(SignalEvent, "signal_event", "dealId");
    await mergeDealCommittee(manager, rows, companyId, sourceId, targetId);
  } else {
    await move(Activity, "activity", "partnershipId");
    await move(RevenueDocument, "revenue_document", "partnershipId");
    await mergePartnershipContacts(manager, rows, companyId, sourceId, targetId);
  }
  await mergeCustomValues(manager, rows, companyId, type, sourceId, targetId, resolutions);
}

export async function mergeRevenueRecords(
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  confirmSourceLabel: string,
  actor: RevenueOperationActor = {},
  resolutions: MergeConflictResolutions = {},
): Promise<RevenueMergePreview> {
  return AppDataSource.transaction("SERIALIZABLE", async (manager) => {
    const { source, target } = await loadPair(manager, companyId, type, sourceId, targetId);
    const sourceLabel = labelOf(type, source);
    if (confirmSourceLabel !== sourceLabel) {
      throw new Error(
        type === "account"
          ? "Type the source account name exactly to confirm the merge"
          : `Type the source ${type} label exactly to confirm the merge`,
      );
    }
    const [counts, custom] = await Promise.all([
      relationshipCounts(manager, companyId, type, sourceId, targetId),
      customValuePreview(manager, companyId, type, sourceId, targetId, resolutions),
    ]);
    const preview: RevenueMergePreview = {
      resourceType: type,
      source: { id: source.id, label: sourceLabel, archivedAt: source.archivedAt },
      target: {
        id: target.id,
        label: labelOf(type, target),
        archivedAt: target.archivedAt,
      },
      fieldConflicts: fieldConflicts(type, source, target, resolutions),
      relationshipCounts: counts,
      customValuesCopied: custom.copied,
      customValueConflicts: custom.conflicts,
      customFieldConflicts: custom.fieldConflicts,
    };
    const validResolutionKeys = new Set([
      ...preview.fieldConflicts.map((conflict) => conflict.field),
      ...preview.customFieldConflicts.map((conflict) => conflict.field),
    ]);
    const invalidResolutionKeys = Object.keys(resolutions).filter(
      (key) => !validResolutionKeys.has(key),
    );
    if (invalidResolutionKeys.length > 0) {
      throw new Error(
        `Unknown or non-conflicting merge field: ${invalidResolutionKeys.join(", ")}`,
      );
    }
    await assertSurvivorInvariants(
      manager,
      companyId,
      type,
      resolvedSurvivor(type, source, target, resolutions),
    );
    const operation = await createRevenueOperation(manager, {
      companyId,
      kind: "merge",
      resourceType: type,
      status: "completed",
      sourceId,
      targetId,
      request: {
        sourceId,
        targetId,
        confirmSourceLabel,
        resolutions,
      },
      summary: preview,
      actor,
      rows: [],
    });
    const rows: OperationRowWrite[] = [];

    await addAliases(manager, rows, operation, type, source, target);
    await applyFieldResolutions(manager, rows, type, source, target, resolutions);
    await applyRelationships(manager, rows, companyId, type, sourceId, targetId, resolutions);
    await reconcileFieldEvidence(manager, rows, companyId, type, sourceId, target);

    const beforeArchivedAt = source.archivedAt;
    source.archivedAt = new Date();
    switch (type) {
      case "account":
        await manager.save(Customer, source as Customer);
        break;
      case "contact":
        await manager.save(Contact, source as Contact);
        break;
      case "deal":
        await manager.save(Deal, source as Deal);
        break;
      case "partnership":
        await manager.save(Partnership, source as Partnership);
        break;
    }
    rows.push({
      resourceType: type,
      resourceId: source.id,
      entityType: type,
      action: "archive_tombstone",
      before: { archivedAt: beforeArchivedAt },
      after: { archivedAt: source.archivedAt },
    });

    await reconcileDuplicateCandidatesAfterMerge(
      manager,
      rows,
      operation,
      type,
      sourceId,
      targetId,
      actor,
    );

    await appendRevenueOperationRows(manager, operation, rows);
    preview.operationId = operation.id;
    operation.summaryJson = JSON.stringify(preview);
    await manager.save(RevenueOperation, operation);
    return preview;
  });
}
