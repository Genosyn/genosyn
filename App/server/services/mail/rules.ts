import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant, MAIL_ACCESS_RANK } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import type { MailHandoverMode } from "../../db/entities/MailHandover.js";
import { recordAudit } from "../audit.js";
import { performThreadAction } from "./actions.js";
import { createMailHandover, hasActiveRuleHandover } from "./handovers.js";

/**
 * Inbound-mail automation. The sync engine calls `runRulesForNewMessage`
 * for every message that is new to the mirror, not a draft, and not sent by
 * the account itself — never during a backfill.
 *
 * Every enabled rule that matches fires, in `position` order; labelling a
 * message and handing it to an employee are usually complementary, so there
 * is no stop-on-first-match. Deterministic actions apply at the thread
 * level (Gmail's own filters are message-level, but a mail client acts on
 * conversations); handToEmployee creates a MailHandover on the queue.
 */

export type MailRuleConditions = {
  from?: string;
  to?: string;
  subjectContains?: string;
  bodyContains?: string;
  hasAttachment?: boolean;
};

export type MailRuleAction =
  | { type: "applyLabel"; labelName: string }
  | { type: "markRead" }
  | { type: "star" }
  | { type: "archive" }
  | {
      type: "handToEmployee";
      employeeId: string;
      instruction: string;
      mode: MailHandoverMode;
    };

export function parseConditions(json: string): MailRuleConditions {
  try {
    const parsed = JSON.parse(json) as MailRuleConditions;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function parseActions(json: string): MailRuleAction[] {
  try {
    const parsed = JSON.parse(json) as MailRuleAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** All present condition fields must match (AND); matching is substring,
 * case-insensitive — the same mental model as Gmail's own filters. */
export function messageMatches(
  conditions: MailRuleConditions,
  message: MailMessage,
): boolean {
  const has = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.trim().toLowerCase());
  if (conditions.from) {
    const from = `${message.fromName} ${message.fromEmail}`;
    if (!has(from, conditions.from)) return false;
  }
  if (conditions.to) {
    const to = `${message.toEmails} ${message.ccEmails}`;
    if (!has(to, conditions.to)) return false;
  }
  if (conditions.subjectContains) {
    if (!has(message.subject, conditions.subjectContains)) return false;
  }
  if (conditions.bodyContains) {
    if (!has(message.bodyText.slice(0, 100_000), conditions.bodyContains)) {
      return false;
    }
  }
  if (conditions.hasAttachment) {
    if (message.attachmentsJson === "[]") return false;
  }
  return true;
}

export async function runRulesForNewMessage(
  account: MailAccount,
  messageRowId: string,
): Promise<void> {
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: messageRowId,
  });
  if (!message) return;
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: message.threadId,
  });
  if (!thread) return;

  const ruleRepo = AppDataSource.getRepository(MailRule);
  const rules = await ruleRepo.find({
    where: { accountId: account.id, enabled: true },
    order: { position: "ASC", createdAt: "ASC" },
  });

  for (const rule of rules) {
    if (!messageMatches(parseConditions(rule.conditionsJson), message)) continue;
    rule.matchCount += 1;
    rule.lastMatchedAt = new Date();
    await ruleRepo.save(rule);
    await recordAudit({
      companyId: account.companyId,
      actorKind: "system",
      action: "mail.rule.match",
      targetType: "mail_rule",
      targetId: rule.id,
      targetLabel: rule.name,
      metadata: { threadId: thread.id, subject: message.subject },
    });
    for (const action of parseActions(rule.actionsJson)) {
      try {
        await applyRuleAction(account, thread, rule, action);
      } catch (err) {
        // One broken action (deleted label, revoked grant) must not stop
        // the rest of the rule — or the other rules.
        // eslint-disable-next-line no-console
        console.error(
          `[mail] rule "${rule.name}" action ${action.type} failed:`,
          err,
        );
      }
    }
  }
}

async function applyRuleAction(
  account: MailAccount,
  thread: MailThread,
  rule: MailRule,
  action: MailRuleAction,
): Promise<void> {
  switch (action.type) {
    case "applyLabel":
      await performThreadAction(account, thread, "applyLabel", {
        labelName: action.labelName,
      });
      return;
    case "markRead":
      await performThreadAction(account, thread, "markRead");
      return;
    case "star":
      await performThreadAction(account, thread, "star");
      return;
    case "archive":
      await performThreadAction(account, thread, "archive");
      return;
    case "handToEmployee": {
      const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: action.employeeId,
        companyId: account.companyId,
      });
      if (!employee) {
        throw new Error("Rule names an employee that no longer exists");
      }
      // Don't stack a second handover on a thread this rule is already
      // working — a broad rule that matches several messages in one
      // conversation would otherwise storm the employee.
      if (await hasActiveRuleHandover(thread.id, rule.id)) return;
      // Pre-flight the grant so a misconfigured rule fails loudly on the
      // handover record instead of the employee flailing at 403s.
      const grant = await AppDataSource.getRepository(
        EmployeeMailAccountGrant,
      ).findOneBy({ employeeId: employee.id, accountId: account.id });
      const needed = action.mode === "reply" ? "send" : "draft";
      const ok =
        grant && MAIL_ACCESS_RANK[grant.accessLevel] >= MAIL_ACCESS_RANK[needed];
      await createMailHandover({
        account,
        thread,
        employeeId: employee.id,
        mode: action.mode,
        instruction: action.instruction,
        sourceKind: "rule",
        ruleId: rule.id,
        createdByUserId: null,
        precheckError: ok
          ? null
          : `${employee.name} needs at least the "${needed}" access level on ${account.address} for a "${action.mode}" handover. Grant it under Email → Settings → AI access.`,
      });
      return;
    }
  }
}
