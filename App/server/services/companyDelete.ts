import fs from "node:fs";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { browserPrivateCompanyDir, codeRepoPrivateCompanyDir, companyDir } from "./paths.js";
import { emitMembershipAuthorizationChange } from "./resourceEvents.js";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Account } from "../db/entities/Account.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Approval } from "../db/entities/Approval.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseView } from "../db/entities/BaseView.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Chart } from "../db/entities/Chart.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { Company } from "../db/entities/Company.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Currency } from "../db/entities/Currency.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { CustomerCreditApplication } from "../db/entities/CustomerCreditApplication.js";
import { CustomerCreditLine } from "../db/entities/CustomerCreditLine.js";
import { CustomerRefund } from "../db/entities/CustomerRefund.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Contact } from "../db/entities/Contact.js";
import { DealStage } from "../db/entities/DealStage.js";
import { Deal } from "../db/entities/Deal.js";
import { DealContact } from "../db/entities/DealContact.js";
import { Activity } from "../db/entities/Activity.js";
import { Suppression } from "../db/entities/Suppression.js";
import { Sequence } from "../db/entities/Sequence.js";
import { SequenceStep } from "../db/entities/SequenceStep.js";
import { SequenceEnrollment } from "../db/entities/SequenceEnrollment.js";
import { SequenceStepRun } from "../db/entities/SequenceStepRun.js";
import { Signal } from "../db/entities/Signal.js";
import { SignalEvent } from "../db/entities/SignalEvent.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { RevenueClassification } from "../db/entities/RevenueClassification.js";
import { RevenueCustomField } from "../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../db/entities/RevenueCustomValue.js";
import { Partnership } from "../db/entities/Partnership.js";
import { PartnershipContact } from "../db/entities/PartnershipContact.js";
import { RevenueDocument } from "../db/entities/RevenueDocument.js";
import { RevenueDocumentCandidate } from "../db/entities/RevenueDocumentCandidate.js";
import { RevenueDuplicateCandidate } from "../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../db/entities/RevenueFieldEvidence.js";
import { RevenueFollowUpView } from "../db/entities/RevenueFollowUpView.js";
import { RevenueFirmographicLookup } from "../db/entities/RevenueFirmographicLookup.js";
import { RevenueImportBatch } from "../db/entities/RevenueImportBatch.js";
import { RevenueImportRow } from "../db/entities/RevenueImportRow.js";
import { RevenueOperation } from "../db/entities/RevenueOperation.js";
import { RevenueOperationRow } from "../db/entities/RevenueOperationRow.js";
import { RevenueRecordAlias } from "../db/entities/RevenueRecordAlias.js";
import { DealHistoryEvent } from "../db/entities/DealHistoryEvent.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { SignatureEvent } from "../db/entities/SignatureEvent.js";
import { SignatureField } from "../db/entities/SignatureField.js";
import { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailChatMessage } from "../db/entities/MailChatMessage.js";
import { MailDraftSendBatch } from "../db/entities/MailDraftSendBatch.js";
import { MailHandover } from "../db/entities/MailHandover.js";
import { MailLabel } from "../db/entities/MailLabel.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailInboundAutomation } from "../db/entities/MailInboundAutomation.js";
import { MailRule } from "../db/entities/MailRule.js";
import { MailSavedSearch } from "../db/entities/MailSavedSearch.js";
import { MailThread } from "../db/entities/MailThread.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { EmployeeChartGrant } from "../db/entities/EmployeeChartGrant.js";
import { EmployeeCodeRepositoryGrant } from "../db/entities/EmployeeCodeRepositoryGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeDashboardGrant } from "../db/entities/EmployeeDashboardGrant.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMarketingGrant } from "../db/entities/EmployeeMarketingGrant.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../db/entities/EmployeeNotebookGrant.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { Handoff } from "../db/entities/Handoff.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { InvoiceWriteOff } from "../db/entities/InvoiceWriteOff.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { McpServer } from "../db/entities/McpServer.js";
import { Membership } from "../db/entities/Membership.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { MarketingCampaign } from "../db/entities/MarketingCampaign.js";
import { MarketingCreative } from "../db/entities/MarketingCreative.js";
import { MarketingExperiment } from "../db/entities/MarketingExperiment.js";
import { MarketingPerformanceSnapshot } from "../db/entities/MarketingPerformanceSnapshot.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Notification } from "../db/entities/Notification.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { Product } from "../db/entities/Product.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { RealtimeEvent } from "../db/entities/RealtimeEvent.js";
import { Resource } from "../db/entities/Resource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Secret } from "../db/entities/Secret.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultItemMemberAccess } from "../db/entities/VaultItemMemberAccess.js";
import { EmployeeVaultGrant } from "../db/entities/EmployeeVaultGrant.js";
import { Skill } from "../db/entities/Skill.js";
import { Tag } from "../db/entities/Tag.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { Team } from "../db/entities/Team.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { Vendor } from "../db/entities/Vendor.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { VendorCreditApplication } from "../db/entities/VendorCreditApplication.js";
import { VendorCreditLine } from "../db/entities/VendorCreditLine.js";
import { VendorRefund } from "../db/entities/VendorRefund.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";

/**
 * Hard-delete a company and every row that hangs off it.
 *
 * Runs inside a single transaction so a partial failure leaves the DB
 * untouched. Each new company-scoped entity needs a line in here — the
 * compile-time entity imports above are the canary: drop one and TS
 * yells.
 *
 * Order matters for the leaf-first sweep: rows that reference a parent
 * within the same company (e.g. ChannelMessage→Channel, BaseRecord→
 * BaseTable→Base) get cleared before their parents. Entities with a
 * direct `companyId` column then go in any order.
 *
 * The on-disk directory at `data/companies/<slug>/` is removed *after*
 * the transaction commits — if filesystem cleanup fails we log it but
 * keep the DB delete, since the data dir is gitignored and an admin can
 * `rm -rf` the leftover later.
 */
export async function deleteCompanyCascade(args: {
  companyId: string;
  companySlug: string;
}): Promise<void> {
  const { companyId, companySlug } = args;

  await AppDataSource.transaction(async (m) => {
    // ── 1. Collect parent IDs we'll cascade through ────────────────────
    const employeeIds = (await m.find(AIEmployee, { where: { companyId }, select: ["id"] })).map(
      (e) => e.id,
    );
    const channelIds = (await m.find(Channel, { where: { companyId }, select: ["id"] })).map(
      (c) => c.id,
    );
    const baseIds = (await m.find(Base, { where: { companyId }, select: ["id"] })).map((b) => b.id);
    const baseTableIds = baseIds.length
      ? (
          await m.find(BaseTable, {
            where: { baseId: In(baseIds) },
            select: ["id"],
          })
        ).map((t) => t.id)
      : [];
    const baseRecordIds = baseTableIds.length
      ? (
          await m.find(BaseRecord, {
            where: { tableId: In(baseTableIds) },
            select: ["id"],
          })
        ).map((r) => r.id)
      : [];
    const projectIds = (await m.find(Project, { where: { companyId }, select: ["id"] })).map(
      (p) => p.id,
    );
    const todoIds = projectIds.length
      ? (
          await m.find(Todo, {
            where: { projectId: In(projectIds) },
            select: ["id"],
          })
        ).map((t) => t.id)
      : [];
    const billIds = (await m.find(Bill, { where: { companyId }, select: ["id"] })).map((b) => b.id);
    const invoiceIds = (await m.find(Invoice, { where: { companyId }, select: ["id"] })).map(
      (i) => i.id,
    );
    const pipelineIds = (await m.find(Pipeline, { where: { companyId }, select: ["id"] })).map(
      (p) => p.id,
    );
    const routineIds = employeeIds.length
      ? (
          await m.find(Routine, {
            where: { employeeId: In(employeeIds) },
            select: ["id"],
          })
        ).map((r) => r.id)
      : [];
    const conversationIds = employeeIds.length
      ? (
          await m.find(Conversation, {
            where: { employeeId: In(employeeIds) },
            select: ["id"],
          })
        ).map((c) => c.id)
      : [];
    const channelMessageIds = channelIds.length
      ? (
          await m.find(ChannelMessage, {
            where: { channelId: In(channelIds) },
            select: ["id"],
          })
        ).map((cm) => cm.id)
      : [];
    const dashboardIds = (await m.find(Dashboard, { where: { companyId }, select: ["id"] })).map(
      (d) => d.id,
    );
    const estimateIds = (await m.find(Estimate, { where: { companyId }, select: ["id"] })).map(
      (e) => e.id,
    );
    const recurringInvoiceIds = (
      await m.find(RecurringInvoice, { where: { companyId }, select: ["id"] })
    ).map((r) => r.id);
    const customerCreditIds = (
      await m.find(CustomerCredit, { where: { companyId }, select: ["id"] })
    ).map((credit) => credit.id);
    const vendorCreditIds = (
      await m.find(VendorCredit, { where: { companyId }, select: ["id"] })
    ).map((credit) => credit.id);
    const tagIds = (await m.find(Tag, { where: { companyId }, select: ["id"] })).map(
      (tag) => tag.id,
    );

    // ── 2. Leaf rows (references → ids we just collected) ──────────────
    if (channelMessageIds.length) {
      await m.delete(MessageReaction, { messageId: In(channelMessageIds) });
    }
    if (channelIds.length) {
      await m.delete(ChannelMessage, { channelId: In(channelIds) });
      await m.delete(ChannelMember, { channelId: In(channelIds) });
    }
    if (routineIds.length) {
      await m.delete(Run, { routineId: In(routineIds) });
    }
    if (baseRecordIds.length) {
      await m.delete(BaseRecordComment, { recordId: In(baseRecordIds) });
    }
    if (baseTableIds.length) {
      await m.delete(BaseRecord, { tableId: In(baseTableIds) });
      await m.delete(BaseField, { tableId: In(baseTableIds) });
      await m.delete(BaseView, { tableId: In(baseTableIds) });
    }
    if (baseIds.length) {
      await m.delete(BaseTable, { baseId: In(baseIds) });
    }
    if (todoIds.length) {
      await m.delete(TodoComment, { todoId: In(todoIds) });
      await m.delete(Todo, { id: In(todoIds) });
    }
    if (projectIds.length) {
      await m.delete(ProjectMember, { projectId: In(projectIds) });
    }
    if (billIds.length) {
      await m.delete(BillLineItem, { billId: In(billIds) });
      await m.delete(BillPayment, { billId: In(billIds) });
    }
    if (invoiceIds.length) {
      await m.delete(InvoiceLineItem, { invoiceId: In(invoiceIds) });
      await m.delete(InvoicePayment, { invoiceId: In(invoiceIds) });
    }
    if (pipelineIds.length) {
      await m.delete(PipelineRun, { pipelineId: In(pipelineIds) });
    }
    if (dashboardIds.length) {
      await m.delete(DashboardCard, { dashboardId: In(dashboardIds) });
    }
    if (estimateIds.length) {
      await m.delete(EstimateLineItem, { estimateId: In(estimateIds) });
    }
    if (recurringInvoiceIds.length) {
      await m.delete(RecurringInvoiceLineItem, {
        recurringInvoiceId: In(recurringInvoiceIds),
      });
    }
    if (customerCreditIds.length) {
      await m.delete(CustomerCreditLine, { creditId: In(customerCreditIds) });
    }
    if (vendorCreditIds.length) {
      await m.delete(VendorCreditLine, { creditId: In(vendorCreditIds) });
    }
    if (tagIds.length) {
      await m.delete(TagAssignment, { tagId: In(tagIds) });
    }
    if (conversationIds.length) {
      await m.delete(ConversationMessage, {
        conversationId: In(conversationIds),
      });
    }
    if (employeeIds.length) {
      await m.delete(Routine, { employeeId: In(employeeIds) });
      await m.delete(Skill, { employeeId: In(employeeIds) });
      await m.delete(EmployeeMemory, { employeeId: In(employeeIds) });
      await m.delete(EmployeeBaseGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeConnectionGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeNotebookGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeNoteGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeResourceGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeChartGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeCodeRepositoryGrant, { employeeId: In(employeeIds) });
      await m.delete(EmployeeDashboardGrant, { employeeId: In(employeeIds) });
      await m.delete(McpServer, { employeeId: In(employeeIds) });
      await m.delete(JournalEntry, { employeeId: In(employeeIds) });
      await m.delete(AIModel, { employeeId: In(employeeIds) });
      await m.delete(Conversation, { employeeId: In(employeeIds) });
    }

    // ── 3. Direct companyId rows (order is mostly free now) ────────────
    await m.delete(WorkloadLease, { companyId });
    await m.delete(RealtimeEvent, { companyId });
    await m.delete(AdSpendEvent, { companyId });
    await m.delete(EmployeeFinanceGrant, { companyId });
    await m.delete(FinanceProposal, { companyId });
    await m.delete(CustomerCreditApplication, { companyId });
    await m.delete(CustomerRefund, { companyId });
    await m.delete(InvoiceWriteOff, { companyId });
    await m.delete(VendorCreditApplication, { companyId });
    await m.delete(VendorRefund, { companyId });
    await m.delete(LedgerLine, { companyId });
    await m.delete(LedgerEntry, { companyId });
    await m.delete(CardTransaction, { companyId });
    await m.delete(CardFeed, { companyId });
    await m.delete(BaseRecordAttachment, { companyId });
    await m.delete(Attachment, { companyId });
    await m.delete(Note, { companyId });
    await m.delete(Notebook, { companyId });
    await m.delete(Notification, { companyId });
    await m.delete(Approval, { companyId });
    await m.delete(Handoff, { companyId });
    await m.delete(Project, { companyId });
    await m.delete(Bill, { companyId });
    await m.delete(Invoice, { companyId });
    await m.delete(CustomerCredit, { companyId });
    await m.delete(VendorCredit, { companyId });
    await m.delete(Customer, { companyId });
    await m.delete(Vendor, { companyId });
    await m.delete(Product, { companyId });
    await m.delete(TaxRate, { companyId });
    await m.delete(Account, { companyId });
    await m.delete(AccountingPeriod, { companyId });
    await m.delete(BankTransaction, { companyId });
    await m.delete(BankFeed, { companyId });
    await m.delete(ExchangeRate, { companyId });
    await m.delete(Currency, { companyId });
    await m.delete(CompanyFinanceSettings, { companyId });
    // The mail-client suite (M25). Grants carry no companyId, so they go by
    // this company's employees; the rest are direct companyId sweeps,
    // leaf-first (messages → threads → labels/rules/handovers/chat → accounts).
    if (employeeIds.length) {
      await m.delete(EmployeeMailAccountGrant, { employeeId: In(employeeIds) });
    }
    await m.delete(MailDraftSendBatch, { companyId });
    await m.delete(MailSavedSearch, { companyId });
    await m.delete(MailInboundAutomation, { companyId });
    await m.delete(MailMessage, { companyId });
    await m.delete(MailThread, { companyId });
    await m.delete(MailLabel, { companyId });
    await m.delete(MailRule, { companyId });
    await m.delete(MailHandover, { companyId });
    await m.delete(MailChatMessage, { companyId });
    await m.delete(MailAccount, { companyId });
    await m.delete(IntegrationConnection, { companyId });
    await m.delete(EmailLog, { companyId });
    await m.delete(EmailProvider, { companyId });
    await m.delete(AuditEvent, { companyId });
    await m.delete(ApiKey, { companyId });
    await m.delete(Secret, { companyId });
    await m.delete(VaultItemMemberAccess, { companyId });
    await m.delete(EmployeeVaultGrant, { companyId });
    await m.delete(VaultItem, { companyId });
    await m.delete(Resource, { companyId });
    // Newer company-scoped surfaces: sales docs (Estimate / RecurringInvoice +
    // their line items and CustomerContact / CustomerContract), Explore
    // (Chart / Dashboard, with DashboardCard + employee grants cleared above),
    // Code repositories, and browser sessions. Line items, dashboard cards,
    // and the three employee grants were removed in the leaf/employee sweeps.
    await m.delete(Estimate, { companyId });
    await m.delete(RecurringInvoice, { companyId });
    // Signing evidence and placed fields are leaves; remove them before their
    // recipients and envelope. The AI access grant is company-scoped.
    await m.delete(SignatureEvent, { companyId });
    await m.delete(SignatureField, { companyId });
    await m.delete(SignatureRecipient, { companyId });
    await m.delete(SignatureEnvelope, { companyId });
    await m.delete(EmployeeSigningGrant, { companyId });
    await m.delete(CustomerContract, { companyId });
    await m.delete(CustomerContact, { companyId });
    // Revenue (M32). Children first so a partial failure never strands a row
    // whose parent is already gone: step runs → enrollments → steps →
    // sequences, and signal events → signals.
    await m.delete(SequenceStepRun, { companyId });
    await m.delete(SequenceEnrollment, { companyId });
    await m.delete(SequenceStep, { companyId });
    await m.delete(Sequence, { companyId });
    await m.delete(SignalEvent, { companyId });
    await m.delete(Signal, { companyId });
    await m.delete(Activity, { companyId });
    await m.delete(RevenueOperationRow, { companyId });
    await m.delete(RevenueRecordAlias, { companyId });
    await m.delete(RevenueOperation, { companyId });
    await m.delete(RevenueImportRow, { companyId });
    await m.delete(RevenueDocumentCandidate, { companyId });
    await m.delete(RevenueDuplicateCandidate, { companyId });
    await m.delete(RevenueFieldEvidence, { companyId });
    await m.delete(RevenueFollowUpView, { companyId });
    await m.delete(RevenueFirmographicLookup, { companyId });
    await m.delete(RevenueDocument, { companyId });
    await m.delete(PartnershipContact, { companyId });
    await m.delete(Partnership, { companyId });
    await m.delete(RevenueCustomValue, { companyId });
    await m.delete(RevenueCustomField, { companyId });
    await m.delete(RevenueClassification, { companyId });
    await m.delete(RevenueImportBatch, { companyId });
    await m.delete(DealContact, { companyId });
    await m.delete(DealHistoryEvent, { companyId });
    await m.delete(Deal, { companyId });
    await m.delete(DealStage, { companyId });
    await m.delete(Contact, { companyId });
    await m.delete(Suppression, { companyId });
    await m.delete(EmployeeRevenueGrant, { companyId });
    await m.delete(MarketingPerformanceSnapshot, { companyId });
    await m.delete(MarketingExperiment, { companyId });
    await m.delete(MarketingCreative, { companyId });
    await m.delete(MarketingCampaign, { companyId });
    await m.delete(EmployeeMarketingGrant, { companyId });
    await m.delete(Chart, { companyId });
    await m.delete(Dashboard, { companyId });
    await m.delete(CodeRepository, { companyId });
    await m.delete(BrowserSession, { companyId });
    await m.delete(Pipeline, { companyId });
    await m.delete(Tag, { companyId });
    await m.delete(Team, { companyId });
    await m.delete(Channel, { companyId });
    await m.delete(Base, { companyId });
    await m.delete(AIEmployee, { companyId });
    await m.delete(Invitation, { companyId });
    await m.delete(Membership, { companyId });
    await m.delete(Company, { id: companyId });
  });
  emitMembershipAuthorizationChange(companyId);

  // ── 4. Filesystem (best-effort) ──────────────────────────────────────
  try {
    fs.rmSync(companyDir(companySlug), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[companyDelete] failed to remove ${companyDir(companySlug)}: ${(err as Error).message}`,
    );
  }
  try {
    fs.rmSync(browserPrivateCompanyDir(companyId), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[companyDelete] failed to remove private Browser state for ${companyId}: ${(err as Error).message}`,
    );
  }
  try {
    fs.rmSync(codeRepoPrivateCompanyDir(companyId), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[companyDelete] failed to remove private Code Repository state for ${companyId}: ${(err as Error).message}`,
    );
  }
}
