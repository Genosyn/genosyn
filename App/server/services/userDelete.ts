import { AppDataSource } from "../db/datasource.js";

import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Approval } from "../db/entities/Approval.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Base } from "../db/entities/Base.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { Bill } from "../db/entities/Bill.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Chart } from "../db/entities/Chart.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Notification } from "../db/entities/Notification.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Product } from "../db/entities/Product.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { Resource } from "../db/entities/Resource.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { Vendor } from "../db/entities/Vendor.js";
import { WebAuthnCredential } from "../db/entities/WebAuthnCredential.js";

/** A company the to-be-deleted user is the registered owner of. */
export interface OwnedCompany {
  id: string;
  name: string;
}

/**
 * Thrown when a delete is refused because the user still owns a company.
 * Deleting them would point `companies.ownerId` at a missing row, leaving
 * the company unmanageable — so we stop and make the operator reassign or
 * delete those companies first.
 */
export class UserOwnsCompaniesError extends Error {
  constructor(public readonly companies: OwnedCompany[]) {
    super(`User owns ${companies.length} company(ies)`);
    this.name = "UserOwnsCompaniesError";
  }
}

/** Counts of the account-scoped rows removed by {@link deleteUserCascade}. */
export interface DeleteUserResult {
  memberships: number;
  apiKeys: number;
  notifications: number;
  channelMembers: number;
  reactions: number;
}

/** Companies where this user is the registered owner (`companies.ownerId`). */
export async function findOwnedCompanies(userId: string): Promise<OwnedCompany[]> {
  return AppDataSource.getRepository(Company).find({
    where: { ownerId: userId },
    select: ["id", "name"],
  });
}

/**
 * Hard-delete a single human user (Member) and clean up every reference to
 * them, in one transaction so a partial failure rolls back.
 *
 * Two kinds of reference, handled differently:
 *
 *  - **Account-scoped rows** (memberships, API keys, notifications, channel
 *    membership, reactions) belong *to* the user — they are deleted.
 *  - **Authored content** (chat messages, todos, journal notes, comments,
 *    finance docs, …) is preserved; we only NULL the author/creator pointer
 *    so history survives and renders as "unknown user". Every such column is
 *    nullable, so unlinking is always valid.
 *
 * Refuses outright (throws {@link UserOwnsCompaniesError}) if the user is the
 * registered owner of any company — that pointer is NOT NULL and orphaning it
 * would brick the company.
 *
 * Like deleteCompanyCascade, the entity imports above are the canary: when a
 * new entity gains a user-reference column, add a line here (DELETE if it is
 * account-scoped, NULL if it is authorship) so the reference can't dangle.
 */
export async function deleteUserCascade(args: {
  userId: string;
}): Promise<DeleteUserResult> {
  const { userId } = args;

  return AppDataSource.transaction(async (m) => {
    // ── Guard: never orphan a company ──────────────────────────────────
    const owned = await m.find(Company, {
      where: { ownerId: userId },
      select: ["id", "name"],
    });
    if (owned.length) {
      throw new UserOwnsCompaniesError(owned.map((c) => ({ id: c.id, name: c.name })));
    }

    // ── 1. Account-scoped rows — delete ────────────────────────────────
    const memberships = (await m.delete(Membership, { userId })).affected ?? 0;
    const apiKeys = (await m.delete(ApiKey, { userId })).affected ?? 0;
    const notifications = (await m.delete(Notification, { userId })).affected ?? 0;
    const channelMembers = (await m.delete(ChannelMember, { userId })).affected ?? 0;
    const reactions = (await m.delete(MessageReaction, { userId })).affected ?? 0;
    await m.delete(WebAuthnCredential, { userId });
    // Project access is an entry, not authorship — so it is deleted here rather
    // than NULLed below. A row with a NULL `userId` would match no principal yet
    // still count toward the "last human with write" quorum in
    // `services/projects.ts`, locking the project for everyone left.
    await m.delete(ProjectMember, { userId });

    // ── 2. Authored content — preserve the row, unlink the author ──────
    await m.update(AIEmployee, { reportsToUserId: userId }, { reportsToUserId: null });
    await m.update(Approval, { decidedByUserId: userId }, { decidedByUserId: null });
    await m.update(AccountingPeriod, { closedById: userId }, { closedById: null });
    await m.update(Attachment, { uploadedByUserId: userId }, { uploadedByUserId: null });
    await m.update(AuditEvent, { actorUserId: userId }, { actorUserId: null });
    await m.update(BankTransaction, { reconciledById: userId }, { reconciledById: null });
    await m.update(BaseRecordAttachment, { uploadedByUserId: userId }, { uploadedByUserId: null });
    await m.update(CustomerContract, { uploadedByUserId: userId }, { uploadedByUserId: null });
    await m.update(BaseRecordComment, { authorUserId: userId }, { authorUserId: null });
    await m.update(Channel, { createdByUserId: userId }, { createdByUserId: null });
    await m.update(ChannelMessage, { authorUserId: userId }, { authorUserId: null });
    await m.update(EmailLog, { triggeredByUserId: userId }, { triggeredByUserId: null });
    // Notifications *to* this user are deleted above (account-scoped); here we
    // only unlink rows where the user was the actor of a notification sent to
    // someone else, so the recipient's history survives as "unknown user".
    await m.update(Notification, { actorId: userId }, { actorId: null });
    await m.update(EmployeeMemory, { authorUserId: userId }, { authorUserId: null });
    await m.update(JournalEntry, { authorUserId: userId }, { authorUserId: null });
    await m.update(TodoComment, { authorUserId: userId }, { authorUserId: null });

    await m.update(Todo, { assigneeUserId: userId }, { assigneeUserId: null });
    await m.update(Todo, { reviewerUserId: userId }, { reviewerUserId: null });
    await m.update(Todo, { createdById: userId }, { createdById: null });

    // `createdById` (human creator) across the rest of the model.
    await m.update(Base, { createdById: userId }, { createdById: null });
    await m.update(Bill, { createdById: userId }, { createdById: null });
    await m.update(BillPayment, { createdById: userId }, { createdById: null });
    await m.update(Chart, { createdById: userId }, { createdById: null });
    await m.update(CodeRepository, { createdById: userId }, { createdById: null });
    await m.update(Customer, { createdById: userId }, { createdById: null });
    await m.update(Dashboard, { createdById: userId }, { createdById: null });
    await m.update(Estimate, { createdById: userId }, { createdById: null });
    await m.update(Invoice, { createdById: userId }, { createdById: null });
    await m.update(InvoicePayment, { createdById: userId }, { createdById: null });
    await m.update(LedgerEntry, { createdById: userId }, { createdById: null });
    await m.update(LedgerEntry, { approvedById: userId }, { approvedById: null });
    await m.update(Note, { createdById: userId }, { createdById: null });
    await m.update(Note, { lastEditedById: userId }, { lastEditedById: null });
    await m.update(Notebook, { createdById: userId }, { createdById: null });
    await m.update(Pipeline, { createdById: userId }, { createdById: null });
    await m.update(Product, { createdById: userId }, { createdById: null });
    await m.update(Project, { createdById: userId }, { createdById: null });
    await m.update(RecurringInvoice, { createdById: userId }, { createdById: null });
    await m.update(Resource, { createdById: userId }, { createdById: null });
    await m.update(Vendor, { createdById: userId }, { createdById: null });

    // ── 3. The user row itself ─────────────────────────────────────────
    await m.delete(User, { id: userId });

    return { memberships, apiKeys, notifications, channelMembers, reactions };
  });
}
