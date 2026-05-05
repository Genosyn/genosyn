import fs from "node:fs";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { companyDir } from "./paths.js";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Account } from "../db/entities/Account.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Approval } from "../db/entities/Approval.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseView } from "../db/entities/BaseView.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Currency } from "../db/entities/Currency.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../db/entities/EmployeeNotebookGrant.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { Handoff } from "../db/entities/Handoff.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { McpServer } from "../db/entities/McpServer.js";
import { Membership } from "../db/entities/Membership.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Notification } from "../db/entities/Notification.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { Product } from "../db/entities/Product.js";
import { Project } from "../db/entities/Project.js";
import { Resource } from "../db/entities/Resource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Secret } from "../db/entities/Secret.js";
import { Skill } from "../db/entities/Skill.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { Team } from "../db/entities/Team.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { Vendor } from "../db/entities/Vendor.js";

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
    const employeeIds = (
      await m.find(AIEmployee, { where: { companyId }, select: ["id"] })
    ).map((e) => e.id);
    const channelIds = (
      await m.find(Channel, { where: { companyId }, select: ["id"] })
    ).map((c) => c.id);
    const baseIds = (
      await m.find(Base, { where: { companyId }, select: ["id"] })
    ).map((b) => b.id);
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
    const projectIds = (
      await m.find(Project, { where: { companyId }, select: ["id"] })
    ).map((p) => p.id);
    const todoIds = projectIds.length
      ? (
          await m.find(Todo, {
            where: { projectId: In(projectIds) },
            select: ["id"],
          })
        ).map((t) => t.id)
      : [];
    const billIds = (
      await m.find(Bill, { where: { companyId }, select: ["id"] })
    ).map((b) => b.id);
    const invoiceIds = (
      await m.find(Invoice, { where: { companyId }, select: ["id"] })
    ).map((i) => i.id);
    const pipelineIds = (
      await m.find(Pipeline, { where: { companyId }, select: ["id"] })
    ).map((p) => p.id);
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
      await m.delete(McpServer, { employeeId: In(employeeIds) });
      await m.delete(JournalEntry, { employeeId: In(employeeIds) });
      await m.delete(AIModel, { employeeId: In(employeeIds) });
      await m.delete(Conversation, { employeeId: In(employeeIds) });
    }

    // ── 3. Direct companyId rows (order is mostly free now) ────────────
    await m.delete(LedgerLine, { companyId });
    await m.delete(LedgerEntry, { companyId });
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
    await m.delete(IntegrationConnection, { companyId });
    await m.delete(EmailLog, { companyId });
    await m.delete(EmailProvider, { companyId });
    await m.delete(AuditEvent, { companyId });
    await m.delete(ApiKey, { companyId });
    await m.delete(Secret, { companyId });
    await m.delete(Resource, { companyId });
    await m.delete(Pipeline, { companyId });
    await m.delete(Team, { companyId });
    await m.delete(Channel, { companyId });
    await m.delete(Base, { companyId });
    await m.delete(AIEmployee, { companyId });
    await m.delete(Invitation, { companyId });
    await m.delete(Membership, { companyId });
    await m.delete(Company, { id: companyId });
  });

  // ── 4. Filesystem (best-effort) ──────────────────────────────────────
  try {
    fs.rmSync(companyDir(companySlug), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[companyDelete] failed to remove ${companyDir(companySlug)}: ${
        (err as Error).message
      }`,
    );
  }
}
