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
  resolution: "destination_wins" | "source_used_when_destination_empty";
};

export type RevenueMergePreview = {
  resourceType: MergeResourceType;
  source: { id: string; label: string; archivedAt: Date | null };
  target: { id: string; label: string; archivedAt: Date | null };
  fieldConflicts: MergeFieldConflict[];
  relationshipCounts: Record<string, number>;
  customValuesCopied: number;
  customValueConflicts: number;
  operationId?: string;
};

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
): MergeFieldConflict[] {
  const sourceValues = source as unknown as Record<string, unknown>;
  const targetValues = target as unknown as Record<string, unknown>;
  return DESCRIPTORS[type].fields
    .filter(({ key }) => !same(sourceValues[key], targetValues[key]))
    .filter(({ key }) => !empty(sourceValues[key]) || !empty(targetValues[key]))
    .map(({ key, label, sourceWhenTargetEmpty }) => ({
      field: key,
      label,
      sourceValue: sourceValues[key] ?? null,
      targetValue: targetValues[key] ?? null,
      resolution:
        sourceWhenTargetEmpty && empty(targetValues[key])
          ? ("source_used_when_destination_empty" as const)
          : ("destination_wins" as const),
    }));
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

async function customValueCounts(
  manager: EntityManager,
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
): Promise<{ copied: number; conflicts: number }> {
  const [source, target] = await Promise.all([
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: sourceId },
      select: { id: true, fieldId: true },
    }),
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: targetId },
      select: { id: true, fieldId: true },
    }),
  ]);
  const targetFields = new Set(target.map((value) => value.fieldId));
  const conflicts = source.filter((value) => targetFields.has(value.fieldId)).length;
  return { copied: source.length - conflicts, conflicts };
}

export async function previewRevenueMerge(
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
): Promise<RevenueMergePreview> {
  const manager = AppDataSource.manager;
  const { source, target } = await loadPair(manager, companyId, type, sourceId, targetId);
  const [counts, custom] = await Promise.all([
    relationshipCounts(manager, companyId, type, sourceId, targetId),
    customValueCounts(manager, companyId, type, sourceId, targetId),
  ]);
  return {
    resourceType: type,
    source: { id: source.id, label: labelOf(type, source), archivedAt: source.archivedAt },
    target: { id: target.id, label: labelOf(type, target), archivedAt: target.archivedAt },
    fieldConflicts: fieldConflicts(type, source, target),
    relationshipCounts: counts,
    customValuesCopied: custom.copied,
    customValueConflicts: custom.conflicts,
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
): Promise<void> {
  const [source, target] = await Promise.all([
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: sourceId },
    }),
    manager.find(RevenueCustomValue, {
      where: { companyId, resourceType: type, resourceId: targetId },
      select: { fieldId: true },
    }),
  ]);
  const targetFields = new Set(target.map((value) => value.fieldId));
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

async function applyFollowUpFallback(
  manager: EntityManager,
  rows: OperationRowWrite[],
  type: MergeResourceType,
  source: MergeRecord,
  target: MergeRecord,
): Promise<void> {
  if (type === "deal") {
    const sourceDeal = source as Deal;
    const targetDeal = target as Deal;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (!targetDeal.nextFollowUpAt && sourceDeal.nextFollowUpAt) {
      before.nextFollowUpAt = null;
      after.nextFollowUpAt = sourceDeal.nextFollowUpAt;
      targetDeal.nextFollowUpAt = sourceDeal.nextFollowUpAt;
    }
    if (!targetDeal.followUpReminderAt && sourceDeal.followUpReminderAt) {
      before.followUpReminderAt = null;
      after.followUpReminderAt = sourceDeal.followUpReminderAt;
      targetDeal.followUpReminderAt = sourceDeal.followUpReminderAt;
    }
    if (Object.keys(after).length > 0) {
      rows.push({
        resourceType: type,
        resourceId: target.id,
        entityType: "deal",
        action: "adopt_follow_up",
        before,
        after,
      });
      await manager.save(Deal, targetDeal);
    }
  }
  if (type === "partnership") {
    const sourcePartnership = source as Partnership;
    const targetPartnership = target as Partnership;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (!targetPartnership.nextFollowUpAt && sourcePartnership.nextFollowUpAt) {
      before.nextFollowUpAt = null;
      after.nextFollowUpAt = sourcePartnership.nextFollowUpAt;
      targetPartnership.nextFollowUpAt = sourcePartnership.nextFollowUpAt;
    }
    if (!targetPartnership.reminderAt && sourcePartnership.reminderAt) {
      before.reminderAt = null;
      after.reminderAt = sourcePartnership.reminderAt;
      targetPartnership.reminderAt = sourcePartnership.reminderAt;
    }
    if (Object.keys(after).length > 0) {
      rows.push({
        resourceType: type,
        resourceId: target.id,
        entityType: "partnership",
        action: "adopt_follow_up",
        before,
        after,
      });
      await manager.save(Partnership, targetPartnership);
    }
  }
}

async function applyRelationships(
  manager: EntityManager,
  rows: OperationRowWrite[],
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
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
    RevenueFieldEvidence,
    "revenue_field_evidence",
    "resourceId",
    undefined,
    { resourceType: type },
  );
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
  await mergeCustomValues(manager, rows, companyId, type, sourceId, targetId);
}

export async function mergeRevenueRecords(
  companyId: string,
  type: MergeResourceType,
  sourceId: string,
  targetId: string,
  confirmSourceLabel: string,
  actor: RevenueOperationActor = {},
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
      customValueCounts(manager, companyId, type, sourceId, targetId),
    ]);
    const preview: RevenueMergePreview = {
      resourceType: type,
      source: { id: source.id, label: sourceLabel, archivedAt: source.archivedAt },
      target: {
        id: target.id,
        label: labelOf(type, target),
        archivedAt: target.archivedAt,
      },
      fieldConflicts: fieldConflicts(type, source, target),
      relationshipCounts: counts,
      customValuesCopied: custom.copied,
      customValueConflicts: custom.conflicts,
    };
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
      },
      summary: preview,
      actor,
      rows: [],
    });
    const rows: OperationRowWrite[] = [];

    await addAliases(manager, rows, operation, type, source, target);
    await applyRelationships(manager, rows, companyId, type, sourceId, targetId);
    await applyFollowUpFallback(manager, rows, type, source, target);

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

    const [leftId, rightId] = [sourceId, targetId].sort();
    const duplicate = await manager.findOneBy(RevenueDuplicateCandidate, {
      companyId,
      resourceType: type,
      leftId,
      rightId,
    });
    if (duplicate) {
      rows.push({
        resourceType: type,
        resourceId: duplicate.id,
        entityType: "revenue_duplicate_candidate",
        action: "resolve_duplicate_candidate",
        before: {
          status: duplicate.status,
          mergeOperationId: duplicate.mergeOperationId,
          resolvedAt: duplicate.resolvedAt,
          resolvedByUserId: duplicate.resolvedByUserId,
        },
        after: {
          status: "merged",
          mergeOperationId: operation.id,
          resolvedAt: operation.completedAt,
          resolvedByUserId: actor.userId ?? null,
        },
      });
      duplicate.status = "merged";
      duplicate.mergeOperationId = operation.id;
      duplicate.resolvedAt = operation.completedAt;
      duplicate.resolvedByUserId = actor.userId ?? null;
      await manager.save(RevenueDuplicateCandidate, duplicate);
    }

    await appendRevenueOperationRows(manager, operation, rows);
    preview.operationId = operation.id;
    operation.summaryJson = JSON.stringify(preview);
    await manager.save(RevenueOperation, operation);
    return preview;
  });
}
