import { AppDataSource } from "../../db/datasource.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { config } from "../../../config.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import type { MailThread } from "../../db/entities/MailThread.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { recordAudit } from "../audit.js";
import { performThreadAction } from "./actions.js";
import { unsubscribeFromMessage } from "./unsubscribe.js";
import { columnHasLabel } from "./store.js";

/** Inbound filtering is mailbox-local; it never adds an outbound Suppression. */
export async function blockMailSender(
  args: {
    account: MailAccount;
    thread: MailThread;
    message: MailMessage;
    actorEmployeeId?: string | null;
    actorUserId?: string | null;
  },
  dependencies: { fileSpam?: typeof performThreadAction } = {},
): Promise<{ rule: MailRule; email: string }> {
  const { account, thread, message } = args;
  if (
    thread.accountId !== account.id ||
    thread.companyId !== account.companyId ||
    message.accountId !== account.id ||
    message.companyId !== account.companyId ||
    message.threadId !== thread.id
  ) {
    throw new Error("The sender must come from this mailbox's own email thread.");
  }
  const email = normalizeEmail(message.fromEmail);
  if (
    !email ||
    email === normalizeEmail(account.address) ||
    columnHasLabel(message.labelIds, "SENT") ||
    columnHasLabel(message.labelIds, "DRAFT")
  ) {
    throw new Error(
      "Choose an inbound email with a valid sender; the mailbox itself cannot be blocked.",
    );
  }
  if (account.status === "paused") throw new Error("This mailbox is paused.");
  // File first: a provider refusal must not leave a hidden enabled filter.
  await (dependencies.fileSpam ?? performThreadAction)(account, thread, "spam");
  const conditionsJson = JSON.stringify({ fromExact: email });
  const actionsJson = JSON.stringify([{ type: "spam" }]);
  const rule = await withSerializedTransaction(async (manager) => {
    const currentAccount = await manager.getRepository(MailAccount).findOne({
      where: { id: account.id, companyId: account.companyId },
      ...(config.db.driver === "postgres" ? { lock: { mode: "pessimistic_write" as const } } : {}),
    });
    if (!currentAccount || currentAccount.status === "paused")
      throw new Error("The mailbox was paused or removed before the sender rule could be saved.");
    const accounts = manager.getRepository(MailRule);
    const existing = await accounts.findOneBy({
      companyId: account.companyId,
      accountId: account.id,
      conditionsJson,
      actionsJson,
    });
    if (existing) {
      if (!existing.enabled) {
        existing.enabled = true;
        await accounts.save(existing);
      }
      return existing;
    }
    return accounts.save(
      accounts.create({
        companyId: account.companyId,
        accountId: account.id,
        name: `Blocked sender: ${email}`.slice(0, 200),
        enabled: true,
        position: 0,
        conditionsJson,
        actionsJson,
        createdByUserId: args.actorUserId ?? null,
      }),
    );
  });
  await recordAudit({
    companyId: account.companyId,
    actorEmployeeId: args.actorEmployeeId ?? null,
    actorUserId: args.actorUserId ?? null,
    action: "mail.sender.block",
    targetType: "mail_rule",
    targetId: rule.id,
    targetLabel: email,
    metadata: { accountId: account.id, threadId: thread.id, messageId: message.id },
  });
  return { rule, email };
}

/** Exact block rules run before broader work rules, independent of UI ordering. */
export async function findBlockedSenderRule(
  account: MailAccount,
  message: MailMessage,
): Promise<MailRule | null> {
  const email = normalizeEmail(message.fromEmail);
  if (!email) return null;
  return AppDataSource.getRepository(MailRule).findOneBy({
    companyId: account.companyId,
    accountId: account.id,
    enabled: true,
    conditionsJson: JSON.stringify({ fromExact: email }),
    actionsJson: JSON.stringify([{ type: "spam" }]),
  });
}

/** Resolve the actual newest inbound sender on the server, never from model-written email addresses. */
export async function performMailSenderAction(args: {
  operation: "mail_block_sender" | "mail_unsubscribe";
  account: MailAccount;
  thread: MailThread;
  employeeId: string;
}): Promise<Record<string, unknown>> {
  const { account, thread, employeeId } = args;
  if (thread.accountId !== account.id || thread.companyId !== account.companyId) {
    throw new Error("This thread does not belong to the mailbox.");
  }
  if (account.status === "paused") throw new Error("This mailbox is paused.");
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { companyId: account.companyId, accountId: account.id, threadId: thread.id },
    order: { sentAt: "DESC", createdAt: "DESC" },
  });
  const message = messages.find(
    (item) =>
      !columnHasLabel(item.labelIds, "SENT") &&
      !columnHasLabel(item.labelIds, "DRAFT") &&
      normalizeEmail(item.fromEmail) !== normalizeEmail(account.address),
  );
  if (!message) throw new Error("This thread has no inbound sender.");
  if (args.operation === "mail_block_sender") {
    const result = await blockMailSender({ account, thread, message, actorEmployeeId: employeeId });
    return {
      blockedSender: result.email,
      ruleId: result.rule.id,
      note: "Moved to Spam. Future inbound mail from this exact address is moved to Spam while this rule is enabled; pause or delete it under Email → Rules to unblock.",
    };
  }
  const result = await unsubscribeFromMessage(account, message);
  await recordAudit({
    companyId: account.companyId,
    actorEmployeeId: employeeId,
    action: "mail.unsubscribe",
    targetType: "mail_message",
    targetId: message.id,
    targetLabel: message.subject,
    metadata: { endpointHost: result.host, status: result.status },
  });
  return { unsubscribed: true, host: result.host };
}

export async function hasBlockedSender(
  account: MailAccount,
  message: MailMessage,
): Promise<boolean> {
  return Boolean(await findBlockedSenderRule(account, message));
}
