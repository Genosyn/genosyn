import type { Repository } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import type { MailHandoverMode } from "../../db/entities/MailHandover.js";
import { recordAudit } from "../audit.js";
import { getActiveModel } from "../models.js";
import { isModelConnected } from "../providers.js";
import { performThreadAction } from "./actions.js";
import {
  evaluateAiRuleCondition,
  type MailRuleAiCondition,
  type MailRuleAiDecision,
} from "./aiRuleEvaluator.js";
import { createMailHandover, hasActiveRuleHandover } from "./handovers.js";
import { unsubscribeFromMessage, type MailUnsubscribeResult } from "./unsubscribe.js";

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
  ai?: MailRuleAiCondition;
};

export type MailRuleAction =
  | { type: "applyLabel"; labelName: string }
  | { type: "markRead" }
  | { type: "star" }
  | { type: "archive" }
  | { type: "unsubscribe" }
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
export function messageMatches(conditions: MailRuleConditions, message: MailMessage): boolean {
  const has = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.trim().toLowerCase());
  if (conditions.from?.trim()) {
    const from = `${message.fromName} ${message.fromEmail}`;
    if (!has(from, conditions.from)) return false;
  }
  if (conditions.to?.trim()) {
    const to = `${message.toEmails} ${message.ccEmails}`;
    if (!has(to, conditions.to)) return false;
  }
  if (conditions.subjectContains?.trim()) {
    if (!has(message.subject, conditions.subjectContains)) return false;
  }
  if (conditions.bodyContains?.trim()) {
    if (!has(message.bodyText.slice(0, 100_000), conditions.bodyContains)) {
      return false;
    }
  }
  if (conditions.hasAttachment) {
    try {
      const attachments = JSON.parse(message.attachmentsJson) as unknown;
      if (!Array.isArray(attachments) || attachments.length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export type MailRuleRuntimeDependencies = {
  evaluateAi?: (
    account: MailAccount,
    message: MailMessage,
    condition: MailRuleAiCondition,
  ) => Promise<MailRuleAiDecision>;
  unsubscribe?: (account: MailAccount, message: MailMessage) => Promise<MailUnsubscribeResult>;
};

/**
 * Validate cross-row references and the safety floor for a rule before an HTTP
 * route persists or re-enables it. Runtime repeats the employee/grant/model
 * checks because those rows can change after save.
 */
export async function validateMailRuleConfiguration(args: {
  companyId: string;
  accountId: string;
  conditions: MailRuleConditions;
  actions: MailRuleAction[];
  requireReady?: boolean;
}): Promise<string | null> {
  for (const action of args.actions) {
    if (action.type !== "handToEmployee") continue;
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: action.employeeId,
      companyId: args.companyId,
    });
    if (!employee) return "Rule names an AI Employee that is not in this company";
  }

  if (args.conditions.ai) {
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: args.conditions.ai.employeeId,
      companyId: args.companyId,
    });
    if (!employee) return "AI matching names an AI Employee that is not in this company";
    if (args.requireReady !== false) {
      const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
        employeeId: employee.id,
        accountId: args.accountId,
      });
      if (!grant || MAIL_ACCESS_RANK[grant.accessLevel] < MAIL_ACCESS_RANK.read) {
        return `${employee.name} needs at least Read access to this mailbox for AI matching`;
      }
      const model = await getActiveModel(employee.id);
      if (!model || !isModelConnected(model)) {
        return `${employee.name} needs a connected AI Model for AI matching`;
      }
    }
  }

  if (
    args.actions.some((action) => action.type === "unsubscribe") &&
    !hasConfiguredCondition(args.conditions)
  ) {
    return "Automatic unsubscribe needs at least one static or AI condition";
  }
  return null;
}

export function hasConfiguredCondition(conditions: MailRuleConditions): boolean {
  return Boolean(
    conditions.from?.trim() ||
    conditions.to?.trim() ||
    conditions.subjectContains?.trim() ||
    conditions.bodyContains?.trim() ||
    conditions.hasAttachment ||
    conditions.ai?.instruction.trim(),
  );
}

export async function runRulesForNewMessage(
  account: MailAccount,
  messageRowId: string,
  assertWritable: () => void | Promise<void> = () => {},
  beforeEffect: () => void | Promise<void> = () => {},
  dependencies: MailRuleRuntimeDependencies = {},
): Promise<void> {
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: messageRowId,
    accountId: account.id,
    companyId: account.companyId,
  });
  if (!message) return;
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: message.threadId,
    accountId: account.id,
    companyId: account.companyId,
  });
  if (!thread) return;

  const ruleRepo = AppDataSource.getRepository(MailRule);
  const rules = await ruleRepo.find({
    where: { accountId: account.id, enabled: true },
    order: { position: "ASC", createdAt: "ASC" },
  });

  // An unsubscribe POST is irreversible. Two matching rules on the same
  // message may still label/archive independently, but they must not POST the
  // sender's endpoint twice.
  let unsubscribeAttempted = false;

  for (const rule of rules) {
    await assertWritable();
    let activeRule = await ruleRepo.findOneBy({
      id: rule.id,
      companyId: account.companyId,
      accountId: account.id,
      enabled: true,
    });
    // The ordered list is only a discovery snapshot. A previous AI decision
    // can hold this loop for a minute, so never apply a later rule that a
    // Member edited or disabled while it waited.
    if (!activeRule || !sameRuleRevision(rule, activeRule)) continue;

    const conditions = parseConditions(activeRule.conditionsJson);
    if (!messageMatches(conditions, message)) continue;

    let aiDecision: MailRuleAiDecision | null = null;
    if (conditions.ai) {
      // A paid model call is itself an external effect. Mark it before the
      // request so pausing/recovery cannot silently bill for the same decision
      // twice.
      await beforeEffect();
      try {
        aiDecision = await (dependencies.evaluateAi ?? evaluateAiRuleCondition)(
          account,
          message,
          conditions.ai,
        );
      } catch (error) {
        await auditRuleFailure(account, thread, message, rule, "ai", error, {
          employeeId: conditions.ai.employeeId,
        });
        continue;
      }
      await assertWritable();
      if (!aiDecision.matches) continue;
      const afterAi = await ruleRepo.findOneBy({
        id: activeRule.id,
        companyId: account.companyId,
        accountId: account.id,
        enabled: true,
      });
      // AI is the long-running boundary. A disable, edit, or delete during
      // that call invalidates the decision and all old actions.
      if (!afterAi || !sameRuleRevision(activeRule, afterAi)) continue;
      activeRule = afterAi;
    } else {
      await beforeEffect();
    }

    const claimed = await claimRuleMatch(ruleRepo, activeRule);
    if (!claimed) continue;
    await recordAudit({
      companyId: account.companyId,
      actorKind: "system",
      action: "mail.rule.match",
      targetType: "mail_rule",
      targetId: activeRule.id,
      targetLabel: activeRule.name,
      metadata: {
        threadId: thread.id,
        messageId: message.id,
        subject: message.subject,
        ...(aiDecision
          ? {
              aiEmployeeId: conditions.ai?.employeeId,
              aiReason: aiDecision.reason,
            }
          : {}),
      },
    });

    // A match counter was claimed against the exact revision above. Only run
    // actions while that same enabled configuration remains current.
    const claimedRevision = await ruleRepo.findOneBy({
      id: activeRule.id,
      companyId: account.companyId,
      accountId: account.id,
      enabled: true,
    });
    if (!claimedRevision || !sameRuleConfiguration(activeRule, claimedRevision)) continue;

    for (const action of parseActions(claimedRevision.actionsJson)) {
      const latest = await ruleRepo.findOneBy({
        id: claimedRevision.id,
        companyId: account.companyId,
        accountId: account.id,
        enabled: true,
      });
      if (!latest || !sameRuleRevision(claimedRevision, latest)) break;
      if (action.type === "unsubscribe") {
        if (unsubscribeAttempted) continue;
        unsubscribeAttempted = true;
      }
      try {
        await assertWritable();
        await applyRuleAction(account, thread, message, claimedRevision, action, dependencies);
      } catch (err) {
        // One broken action (deleted label, revoked grant) must not stop
        // the rest of the rule — or the other rules.
        // eslint-disable-next-line no-console
        console.error(`[mail] rule "${claimedRevision.name}" action ${action.type} failed:`, err);
        await auditRuleFailure(account, thread, message, claimedRevision, action.type, err);
      }
    }
  }
}

function sameRuleConfiguration(left: MailRule, right: MailRule): boolean {
  return (
    left.id === right.id &&
    left.companyId === right.companyId &&
    left.accountId === right.accountId &&
    left.enabled === right.enabled &&
    left.name === right.name &&
    left.position === right.position &&
    left.conditionsJson === right.conditionsJson &&
    left.actionsJson === right.actionsJson
  );
}

function sameRuleRevision(left: MailRule, right: MailRule): boolean {
  return (
    sameRuleConfiguration(left, right) && left.updatedAt.getTime() === right.updatedAt.getTime()
  );
}

/** Atomically count a match only if the evaluated enabled configuration is still live. */
async function claimRuleMatch(repo: Repository<MailRule>, rule: MailRule): Promise<boolean> {
  const result = await repo
    .createQueryBuilder()
    .update()
    .set({
      matchCount: () => '"matchCount" + 1',
      lastMatchedAt: new Date(),
    })
    .where('"id" = :id', { id: rule.id })
    .andWhere('"companyId" = :companyId', { companyId: rule.companyId })
    .andWhere('"accountId" = :accountId', { accountId: rule.accountId })
    .andWhere('"enabled" = :enabled', { enabled: true })
    .andWhere('"name" = :name', { name: rule.name })
    .andWhere('"position" = :position', { position: rule.position })
    .andWhere('"conditionsJson" = :conditionsJson', {
      conditionsJson: rule.conditionsJson,
    })
    .andWhere('"actionsJson" = :actionsJson', { actionsJson: rule.actionsJson })
    .execute();
  return (result.affected ?? 0) === 1;
}

async function applyRuleAction(
  account: MailAccount,
  thread: MailThread,
  message: MailMessage,
  rule: MailRule,
  action: MailRuleAction,
  dependencies: MailRuleRuntimeDependencies,
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
    case "unsubscribe": {
      const result = await (dependencies.unsubscribe ?? unsubscribeFromMessage)(account, message);
      await recordAudit({
        companyId: account.companyId,
        actorKind: "system",
        action: "mail.rule.unsubscribe",
        targetType: "mail_rule",
        targetId: rule.id,
        targetLabel: rule.name,
        metadata: {
          threadId: thread.id,
          messageId: message.id,
          endpointHost: result.host,
          status: result.status,
        },
      });
      return;
    }
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
      const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
        employeeId: employee.id,
        accountId: account.id,
      });
      const needed = action.mode === "reply" ? "send" : "draft";
      const ok = grant && MAIL_ACCESS_RANK[grant.accessLevel] >= MAIL_ACCESS_RANK[needed];
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

async function auditRuleFailure(
  account: MailAccount,
  thread: MailThread,
  message: MailMessage,
  rule: MailRule,
  stage: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  try {
    await recordAudit({
      companyId: account.companyId,
      actorKind: "system",
      action: stage === "ai" ? "mail.rule.ai_error" : "mail.rule.action_error",
      targetType: "mail_rule",
      targetId: rule.id,
      targetLabel: rule.name,
      metadata: {
        threadId: thread.id,
        messageId: message.id,
        stage,
        error: detail,
        ...metadata,
      },
    });
  } catch (auditError) {
    // The original action is already isolated; a second failure while
    // recording it must not stop later actions or rules either.
    // eslint-disable-next-line no-console
    console.error(`[mail] could not audit rule "${rule.name}" failure:`, auditError);
  }
}
