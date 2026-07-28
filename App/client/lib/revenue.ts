import type { Customer } from "./api";

export type RevenueResourceType = "contact" | "account" | "deal" | "partnership";
export type RevenueCustomFieldType =
  "text" | "number" | "date" | "boolean" | "select" | "multi_select" | "url";

export type RevenueClassification = {
  id: string;
  companyId: string;
  kind: "deal_source" | "committee_role" | "partnership_type" | "partnership_status";
  value: string;
  label: string;
  sortOrder: number;
  archivedAt: string | null;
};

export type RevenueCustomField = {
  id: string;
  companyId: string;
  resourceType: RevenueResourceType;
  key: string;
  name: string;
  fieldType: RevenueCustomFieldType;
  optionsJson: string;
  required: boolean;
  sortOrder: number;
  archivedAt: string | null;
};

export type RevenueCustomValue = {
  field: RevenueCustomField;
  value: string | number | boolean | string[] | null;
  provenance: {
    id: string;
    sourceType: "email" | "document" | "integration" | "finance" | "website" | "import" | "manual";
    sourceId: string;
    sourceLabel: string;
    confidence: number;
    status: "proposed" | "accepted" | "rejected" | "superseded";
    verificationState: "unverified" | "verified" | "rejected" | "superseded";
    extractionMethod: string;
    observedAt: string | null;
    lastVerifiedAt: string | null;
    verifyingActorType: "member" | "ai_employee" | "system" | null;
    createdAt: string;
  } | null;
  provenanceHistoryCount: number;
};

export type FollowUpItem = {
  id: string;
  source: "task" | "deal" | "partnership";
  title: string;
  dueAt: string;
  reminderAt: string | null;
  status: "open" | "completed" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  overdue: boolean;
  dealId: string | null;
  partnershipId: string | null;
  contactId: string | null;
  customerId: string | null;
  assignedUserId: string | null;
  assignedEmployeeId: string | null;
  assigneeName: string | null;
  recurrenceRule: string | null;
};

export type FollowUpViewFilters = {
  state?: "all" | "overdue" | "today" | "upcoming";
  q?: string;
  source?: "task" | "deal" | "partnership";
  assignedUserId?: string;
  assignedEmployeeId?: string;
  unassigned?: boolean;
  priority?: "low" | "normal" | "high" | "urgent";
  status?: "open" | "completed" | "cancelled";
  linkedResourceType?: "account" | "contact" | "deal" | "partnership";
  linkedResourceId?: string;
  dueFrom?: string;
  dueTo?: string;
  reminderFrom?: string;
  reminderTo?: string;
  overdueMinDays?: number;
  overdueMaxDays?: number;
  createdBefore?: string;
  staleBefore?: string;
  dealStageId?: string;
  dealStatus?: "open" | "won" | "lost";
  closedDeals?: "include" | "only" | "exclude";
  archivedResources?: "include" | "only" | "exclude";
  accountStatus?: "prospect" | "customer" | "former";
};

export type FollowUpView = {
  id: string;
  companyId: string;
  name: string;
  filters: FollowUpViewFilters;
  sortOrder: number;
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RevenueAccount = Customer & {
  contactCount: number;
  openDealCount: number;
};

export type Partnership = {
  id: string;
  companyId: string;
  name: string;
  type: string;
  status: string;
  customerId: string | null;
  websiteUrl: string;
  integrationContext: string;
  channelContext: string;
  notes: string;
  ownerId: string | null;
  ownerEmployeeId: string | null;
  nextFollowUpAt: string | null;
  reminderAt: string | null;
  lastActivityAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PartnershipContact = {
  id: string;
  contactId: string;
  role: string;
  isPrimary: boolean;
  replyAll: boolean;
  sortOrder: number;
  contact: {
    id: string;
    name: string;
    email: string;
    companyName: string;
  };
};

export type RevenueDocumentKind =
  "proposal" | "rfp" | "security_questionnaire" | "contract" | "email_attachment" | "other";

export type RevenueDocument = {
  id: string;
  kind: RevenueDocumentKind;
  title: string;
  notes: string;
  externalUrl: string;
  sourceMailMessageId: string | null;
  sourceGmailMessageId: string;
  sourceGmailThreadId: string;
  sourceGmailAttachmentId: string;
  attachmentId: string | null;
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  } | null;
  createdAt: string;
};

export type RevenueImportBatch = {
  id: string;
  resourceType: RevenueResourceType | "account_contact_deal";
  sourceKind: "base" | "csv" | "json" | "connection";
  sourceLabel: string;
  status: "completed" | "rolled_back" | "failed";
  mappingJson: string;
  rowMapJson: string;
  createdIdsJson: string;
  reportJson: string;
  sourceBaseId: string | null;
  sourceTableId: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RevenueDealHistoryCompleteness = "complete" | "partial" | "snapshot_only" | "missing";

export type RevenueDealHistoryCoverageRow = {
  dealId: string;
  title: string;
  stageId: string;
  stageName: string | null;
  status: "open" | "won" | "lost";
  createdAt: string;
  archivedAt: string | null;
  completeness: RevenueDealHistoryCompleteness;
  historyEventCount: number;
  liveEventCount: number;
  importedEventCount: number;
  activityBackfillEventCount: number;
  firstNativeEventAt: string | null;
  lastHistoryEventAt: string | null;
  eligibleActivityCount: number;
  pendingActivityCount: number;
  migrationImport: boolean;
  recommendation: "none" | "historical_import" | "historical_import_first" | "activity_backfill";
};

export type RevenueDealHistoryCoveragePage = {
  rows: RevenueDealHistoryCoverageRow[];
  total: number;
  limit: number;
  offset: number;
};

export type RevenueDealHistoryActivityBackfillSummary = {
  dryRun: boolean;
  operationId?: string;
  replayed?: boolean;
  selectedDeals: number;
  reviewedActivities: number;
  imported: number;
  skipped: number;
  failed: number;
  migrationSnapshots: number;
  rows: Array<{
    activityId: string;
    dealId: string;
    activityKind: string;
    eventKind: string;
    occurredAt: string;
    migrationSnapshot: boolean;
    status: "ready" | "imported" | "skipped" | "failed";
    reason: string;
  }>;
};

export type RevenueCommercialValueBacklogDisposition =
  | "pending_review"
  | "accepted_zero"
  | "ambiguous_account"
  | "unlinked_account"
  | "finance_candidate"
  | "stripe_candidate"
  | "no_evidence";

export type RevenueCommercialValueBacklogRow = {
  dealId: string;
  title: string;
  accountId: string | null;
  accountName: string | null;
  stageId: string;
  stageName: string | null;
  amountCents: number;
  currency: string;
  updatedAt: string;
  zeroValueDealsOnAccount: number;
  disposition: RevenueCommercialValueBacklogDisposition;
  financeCandidate: {
    sourceKind: "accepted_estimate" | "invoice_payment" | "invoice" | "account_acv";
    sourceId: string;
    sourceLabel: string;
    amountCents: number;
    currency: string;
  } | null;
  stripeCandidate: {
    customerId: string;
    connectedConnections: number;
  } | null;
  proposalCounts: Record<"proposed" | "accepted" | "rejected" | "superseded", number>;
};

export type RevenueCommercialValueBacklogPage = {
  rows: RevenueCommercialValueBacklogRow[];
  total: number;
  limit: number;
  offset: number;
};
