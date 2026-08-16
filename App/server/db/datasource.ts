import "reflect-metadata";
import { DataSource } from "typeorm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { config } from "../../config.js";
import { ResourceChangeSubscriber } from "./subscribers/resourceChangeSubscriber.js";
import { User } from "./entities/User.js";
import { Company } from "./entities/Company.js";
import { Membership } from "./entities/Membership.js";
import { Invitation } from "./entities/Invitation.js";
import { AIModel } from "./entities/AIModel.js";
import { AIEmployee } from "./entities/AIEmployee.js";
import { Skill } from "./entities/Skill.js";
import { Routine } from "./entities/Routine.js";
import { Run } from "./entities/Run.js";
import { Project } from "./entities/Project.js";
import { ProjectMember } from "./entities/ProjectMember.js";
import { Todo } from "./entities/Todo.js";
import { TodoComment } from "./entities/TodoComment.js";
import { Conversation } from "./entities/Conversation.js";
import { ConversationMessage } from "./entities/ConversationMessage.js";
import { JournalEntry } from "./entities/JournalEntry.js";
import { Approval } from "./entities/Approval.js";
import { McpServer } from "./entities/McpServer.js";
import { Secret } from "./entities/Secret.js";
import { AuditEvent } from "./entities/AuditEvent.js";
import { Base } from "./entities/Base.js";
import { BaseTable } from "./entities/BaseTable.js";
import { BaseField } from "./entities/BaseField.js";
import { BaseRecord } from "./entities/BaseRecord.js";
import { BaseRecordComment } from "./entities/BaseRecordComment.js";
import { BaseRecordAttachment } from "./entities/BaseRecordAttachment.js";
import { BaseView } from "./entities/BaseView.js";
import { Backup } from "./entities/Backup.js";
import { BackupSchedule } from "./entities/BackupSchedule.js";
import { BackupDestination } from "./entities/BackupDestination.js";
import { IntegrationConnection } from "./entities/IntegrationConnection.js";
import { EmployeeConnectionGrant } from "./entities/EmployeeConnectionGrant.js";
import { EmployeeBaseGrant } from "./entities/EmployeeBaseGrant.js";
import { EmployeeMemory } from "./entities/EmployeeMemory.js";
import { Channel } from "./entities/Channel.js";
import { ChannelMember } from "./entities/ChannelMember.js";
import { ChannelMessage } from "./entities/ChannelMessage.js";
import { MessageReaction } from "./entities/MessageReaction.js";
import { Attachment } from "./entities/Attachment.js";
import { Pipeline } from "./entities/Pipeline.js";
import { PipelineRun } from "./entities/PipelineRun.js";
import { EmailProvider } from "./entities/EmailProvider.js";
import { EmailLog } from "./entities/EmailLog.js";
import { Notebook } from "./entities/Notebook.js";
import { Note } from "./entities/Note.js";
import { EmployeeNoteGrant } from "./entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "./entities/EmployeeNotebookGrant.js";
import { Notification } from "./entities/Notification.js";
import { Team } from "./entities/Team.js";
import { Handoff } from "./entities/Handoff.js";
import { ApiKey } from "./entities/ApiKey.js";
import { Resource } from "./entities/Resource.js";
import { EmployeeResourceGrant } from "./entities/EmployeeResourceGrant.js";
import { CodeRepository } from "./entities/CodeRepository.js";
import { EmployeeCodeRepositoryGrant } from "./entities/EmployeeCodeRepositoryGrant.js";
import { EmployeeFinanceGrant } from "./entities/EmployeeFinanceGrant.js";
import { Customer } from "./entities/Customer.js";
import { CustomerContact } from "./entities/CustomerContact.js";
import { CustomerContract } from "./entities/CustomerContract.js";
import { SignatureEnvelope } from "./entities/SignatureEnvelope.js";
import { SignatureRecipient } from "./entities/SignatureRecipient.js";
import { SignatureField } from "./entities/SignatureField.js";
import { SignatureEvent } from "./entities/SignatureEvent.js";
import { EmployeeSigningGrant } from "./entities/EmployeeSigningGrant.js";
import { Product } from "./entities/Product.js";
import { TaxRate } from "./entities/TaxRate.js";
import { Invoice } from "./entities/Invoice.js";
import { InvoiceLineItem } from "./entities/InvoiceLineItem.js";
import { InvoicePayment } from "./entities/InvoicePayment.js";
import { InvoiceWriteOff } from "./entities/InvoiceWriteOff.js";
import { CustomerCredit } from "./entities/CustomerCredit.js";
import { CustomerCreditLine } from "./entities/CustomerCreditLine.js";
import { CustomerCreditApplication } from "./entities/CustomerCreditApplication.js";
import { CustomerRefund } from "./entities/CustomerRefund.js";
import { VendorCredit } from "./entities/VendorCredit.js";
import { VendorCreditLine } from "./entities/VendorCreditLine.js";
import { VendorCreditApplication } from "./entities/VendorCreditApplication.js";
import { VendorRefund } from "./entities/VendorRefund.js";
import { FinanceProposal } from "./entities/FinanceProposal.js";
import { RecurringInvoice } from "./entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "./entities/RecurringInvoiceLineItem.js";
import { Estimate } from "./entities/Estimate.js";
import { EstimateLineItem } from "./entities/EstimateLineItem.js";
import { Account } from "./entities/Account.js";
import { LedgerEntry } from "./entities/LedgerEntry.js";
import { LedgerLine } from "./entities/LedgerLine.js";
import { BankFeed } from "./entities/BankFeed.js";
import { BankTransaction } from "./entities/BankTransaction.js";
import { CardFeed } from "./entities/CardFeed.js";
import { CardTransaction } from "./entities/CardTransaction.js";
import { Currency } from "./entities/Currency.js";
import { ExchangeRate } from "./entities/ExchangeRate.js";
import { CompanyFinanceSettings } from "./entities/CompanyFinanceSettings.js";
import { AccountingPeriod } from "./entities/AccountingPeriod.js";
import { Vendor } from "./entities/Vendor.js";
import { Bill } from "./entities/Bill.js";
import { BillLineItem } from "./entities/BillLineItem.js";
import { BillPayment } from "./entities/BillPayment.js";
import { BrowserSession } from "./entities/BrowserSession.js";
import { MemberBrowser } from "./entities/MemberBrowser.js";
import { EmployeeMemberBrowserGrant } from "./entities/EmployeeMemberBrowserGrant.js";
import { Chart } from "./entities/Chart.js";
import { Dashboard } from "./entities/Dashboard.js";
import { DashboardCard } from "./entities/DashboardCard.js";
import { EmployeeChartGrant } from "./entities/EmployeeChartGrant.js";
import { EmployeeDashboardGrant } from "./entities/EmployeeDashboardGrant.js";
import { AppSetting } from "./entities/AppSetting.js";
import { PushSubscription } from "./entities/PushSubscription.js";
import { MailAccount } from "./entities/MailAccount.js";
import { MailThread } from "./entities/MailThread.js";
import { MailMessage } from "./entities/MailMessage.js";
import { MailLabel } from "./entities/MailLabel.js";
import { MailRule } from "./entities/MailRule.js";
import { MailHandover } from "./entities/MailHandover.js";
import { MailSavedSearch } from "./entities/MailSavedSearch.js";
import { MailChatMessage } from "./entities/MailChatMessage.js";
import { MailDraftSendBatch } from "./entities/MailDraftSendBatch.js";
import { MailInboundAutomation } from "./entities/MailInboundAutomation.js";
import { EmployeeMailAccountGrant } from "./entities/EmployeeMailAccountGrant.js";
import { AdSpendEvent } from "./entities/AdSpendEvent.js";
import { Tag } from "./entities/Tag.js";
import { TagAssignment } from "./entities/TagAssignment.js";
import { WebAuthnCredential } from "./entities/WebAuthnCredential.js";
import { TotpCredential } from "./entities/TotpCredential.js";
import { AuthRateLimit } from "./entities/AuthRateLimit.js";
import { WorkloadLease } from "./entities/WorkloadLease.js";
import { SchedulerLease } from "./entities/SchedulerLease.js";
import { AuthFlowState } from "./entities/AuthFlowState.js";
import { RealtimeEvent } from "./entities/RealtimeEvent.js";
import { Contact } from "./entities/Contact.js";
import { DealStage } from "./entities/DealStage.js";
import { Deal } from "./entities/Deal.js";
import { DealContact } from "./entities/DealContact.js";
import { Activity } from "./entities/Activity.js";
import { Suppression } from "./entities/Suppression.js";
import { Sequence } from "./entities/Sequence.js";
import { SequenceStep } from "./entities/SequenceStep.js";
import { SequenceEnrollment } from "./entities/SequenceEnrollment.js";
import { SequenceStepRun } from "./entities/SequenceStepRun.js";
import { Signal } from "./entities/Signal.js";
import { SignalEvent } from "./entities/SignalEvent.js";
import { EmployeeRevenueGrant } from "./entities/EmployeeRevenueGrant.js";
import { RevenueClassification } from "./entities/RevenueClassification.js";
import { RevenueCustomField } from "./entities/RevenueCustomField.js";
import { RevenueCustomValue } from "./entities/RevenueCustomValue.js";
import { Partnership } from "./entities/Partnership.js";
import { PartnershipContact } from "./entities/PartnershipContact.js";
import { RevenueDocument } from "./entities/RevenueDocument.js";
import { RevenueImportBatch } from "./entities/RevenueImportBatch.js";
import { RevenueOperation } from "./entities/RevenueOperation.js";
import { RevenueOperationRow } from "./entities/RevenueOperationRow.js";
import { RevenueRecordAlias } from "./entities/RevenueRecordAlias.js";
import { DealHistoryEvent } from "./entities/DealHistoryEvent.js";
import { RevenueImportRow } from "./entities/RevenueImportRow.js";
import { RevenueFieldEvidence } from "./entities/RevenueFieldEvidence.js";
import { RevenueDocumentCandidate } from "./entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "./entities/RevenueDuplicateCandidate.js";
import { RevenueFollowUpView } from "./entities/RevenueFollowUpView.js";
import { RevenueFirmographicLookup } from "./entities/RevenueFirmographicLookup.js";
import { MarketingCampaign } from "./entities/MarketingCampaign.js";
import { MarketingCreative } from "./entities/MarketingCreative.js";
import { MarketingExperiment } from "./entities/MarketingExperiment.js";
import { MarketingPerformanceSnapshot } from "./entities/MarketingPerformanceSnapshot.js";
import { EmployeeMarketingGrant } from "./entities/EmployeeMarketingGrant.js";
import { VaultItem } from "./entities/VaultItem.js";
import { VaultItemMemberAccess } from "./entities/VaultItemMemberAccess.js";
import { EmployeeVaultGrant } from "./entities/EmployeeVaultGrant.js";

const entities = [
  User,
  Company,
  Membership,
  Invitation,
  AIModel,
  AIEmployee,
  Skill,
  Routine,
  Run,
  Project,
  ProjectMember,
  Todo,
  TodoComment,
  Conversation,
  ConversationMessage,
  JournalEntry,
  Approval,
  McpServer,
  AdSpendEvent,
  Tag,
  TagAssignment,
  WebAuthnCredential,
  TotpCredential,
  AuthRateLimit,
  WorkloadLease,
  SchedulerLease,
  AuthFlowState,
  RealtimeEvent,
  Secret,
  AuditEvent,
  Base,
  BaseTable,
  BaseField,
  BaseRecord,
  BaseRecordComment,
  BaseRecordAttachment,
  BaseView,
  Backup,
  BackupSchedule,
  BackupDestination,
  IntegrationConnection,
  EmployeeConnectionGrant,
  EmployeeBaseGrant,
  EmployeeMemory,
  Channel,
  ChannelMember,
  ChannelMessage,
  MessageReaction,
  Attachment,
  Pipeline,
  PipelineRun,
  EmailProvider,
  EmailLog,
  Notebook,
  Note,
  EmployeeNoteGrant,
  EmployeeNotebookGrant,
  Notification,
  Team,
  Handoff,
  ApiKey,
  Resource,
  EmployeeResourceGrant,
  CodeRepository,
  EmployeeCodeRepositoryGrant,
  EmployeeFinanceGrant,
  Customer,
  CustomerContact,
  CustomerContract,
  SignatureEnvelope,
  SignatureRecipient,
  SignatureField,
  SignatureEvent,
  EmployeeSigningGrant,
  Product,
  TaxRate,
  Invoice,
  InvoiceLineItem,
  InvoicePayment,
  InvoiceWriteOff,
  CustomerCredit,
  CustomerCreditLine,
  CustomerCreditApplication,
  CustomerRefund,
  VendorCredit,
  VendorCreditLine,
  VendorCreditApplication,
  VendorRefund,
  FinanceProposal,
  RecurringInvoice,
  RecurringInvoiceLineItem,
  Estimate,
  EstimateLineItem,
  Account,
  LedgerEntry,
  LedgerLine,
  BankFeed,
  BankTransaction,
  CardFeed,
  CardTransaction,
  Currency,
  ExchangeRate,
  CompanyFinanceSettings,
  AccountingPeriod,
  Vendor,
  Bill,
  BillLineItem,
  BillPayment,
  BrowserSession,
  MemberBrowser,
  EmployeeMemberBrowserGrant,
  Chart,
  Dashboard,
  DashboardCard,
  EmployeeChartGrant,
  EmployeeDashboardGrant,
  AppSetting,
  PushSubscription,
  MailAccount,
  MailThread,
  MailMessage,
  MailLabel,
  MailRule,
  MailHandover,
  MailSavedSearch,
  MailChatMessage,
  MailDraftSendBatch,
  MailInboundAutomation,
  EmployeeMailAccountGrant,
  // Revenue (M32) — contacts, deals, activities, outbound, signals.
  Contact,
  DealStage,
  Deal,
  DealContact,
  Activity,
  Suppression,
  Sequence,
  SequenceStep,
  SequenceEnrollment,
  SequenceStepRun,
  Signal,
  SignalEvent,
  EmployeeRevenueGrant,
  RevenueClassification,
  RevenueCustomField,
  RevenueCustomValue,
  Partnership,
  PartnershipContact,
  RevenueDocument,
  RevenueImportBatch,
  RevenueOperation,
  RevenueOperationRow,
  RevenueRecordAlias,
  DealHistoryEvent,
  RevenueImportRow,
  RevenueFieldEvidence,
  RevenueDocumentCandidate,
  RevenueDuplicateCandidate,
  RevenueFollowUpView,
  RevenueFirmographicLookup,
  // Marketing agency (M35) — strategy, Creative, Experiments and measurements.
  MarketingCampaign,
  MarketingCreative,
  MarketingExperiment,
  MarketingPerformanceSnapshot,
  EmployeeMarketingGrant,
  VaultItem,
  VaultItemMemberAccess,
  EmployeeVaultGrant,
];

// Migrations glob -- matches .ts files under server/db/migrations in dev (via tsx)
// and the compiled .js files under dist/server/db/migrations in production.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  config.db.driver === "postgres"
    ? path.join(__dirname, "migrations", "postgres", "*.{ts,js}")
    : path.join(__dirname, "migrations", "*.{ts,js}"),
];

function buildDataSource(): DataSource {
  if (config.db.driver === "postgres") {
    return new DataSource({
      type: "postgres",
      url: config.db.postgresUrl,
      entities,
      migrations,
      synchronize: false,
      logging: false,
    });
  }
  const sqlitePath = path.resolve(config.db.sqlitePath);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  return new DataSource({
    type: "better-sqlite3",
    database: sqlitePath,
    entities,
    migrations,
    synchronize: false,
    logging: false,
  });
}

export const AppDataSource = buildDataSource();

export async function initDb(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    // App-wide live sync: one subscriber turns every content write into a
    // coarse `resource.changed` broadcast. Registered here rather than in the
    // DataSource options so there is exactly one instance; inert until the
    // socket layer wires its sink (`attachRealtime`), so the migrations that
    // run just below never fan out.
    AppDataSource.subscribers.push(new ResourceChangeSubscriber());
  }
  // Run any pending migrations on boot. Idempotent -- already-run migrations
  // are tracked in the `migrations` table that TypeORM manages.
  await AppDataSource.runMigrations();
}
