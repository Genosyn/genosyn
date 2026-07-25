import type { Customer } from "./api";

export type RevenueResourceType = "contact" | "account" | "deal" | "partnership";
export type RevenueCustomFieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "multi_select"
  | "url";

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
  | "proposal"
  | "rfp"
  | "security_questionnaire"
  | "contract"
  | "email_attachment"
  | "other";

export type RevenueDocument = {
  id: string;
  kind: RevenueDocumentKind;
  title: string;
  notes: string;
  externalUrl: string;
  sourceMailMessageId: string | null;
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
  sourceKind: "base" | "csv";
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
