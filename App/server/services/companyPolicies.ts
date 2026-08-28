import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import { Membership } from "../db/entities/Membership.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";

/**
 * The Policy layer (M53): company-wide rules that are more than prompt text.
 * Prose is injected into every employee's system prompt beside the Soul;
 * the two mechanical clause kinds are enforced at their choke points — mail
 * sends and MCP dispatch — with every refusal recorded as a
 * `policy.violation` AuditEvent so drift is legible, not silent.
 */

/** Keep the injected block bounded however much policy prose accrues. */
const PROMPT_POLICIES_MAX_BYTES = 8 * 1024;

/** Discovery must stay reachable or refusals become invisible. */
export const UNFORBIDDABLE_TOOLS = new Set(["find_tools", "call_tool"]);

export class PolicyError extends Error {}

/** Raised at the mail-send choke when a recipient's domain is policy-blocked. */
export class PolicyBlockedRecipientError extends Error {
  readonly policyTitle: string;
  readonly blocked: string[];

  constructor(policyTitle: string, blocked: string[]) {
    super(
      `${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked by the company policy "${policyTitle}"`,
    );
    this.name = "PolicyBlockedRecipientError";
    this.policyTitle = policyTitle;
    this.blocked = blocked;
  }
}

export function parseList(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

async function enabledPolicies(companyId: string): Promise<CompanyPolicy[]> {
  return AppDataSource.getRepository(CompanyPolicy).find({
    where: { companyId, enabled: true },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
}

/**
 * The "## Company policies" system-prompt block — every enabled policy's
 * prose, bounded, empty string when there is nothing to say.
 */
export async function composePoliciesContext(companyId: string): Promise<string> {
  const policies = (await enabledPolicies(companyId)).filter((p) => p.body.trim());
  if (policies.length === 0) return "";
  const parts: string[] = [
    "\n## Company policies\n",
    "These bind every employee, including you. Where a policy names something mechanical — a blocked domain, a forbidden tool — the platform enforces it whether or not you remember it.",
  ];
  let budget = PROMPT_POLICIES_MAX_BYTES;
  for (const policy of policies) {
    const section = `\n### ${policy.title}\n${policy.body.trim()}`;
    if (section.length > budget) {
      parts.push("\n_(further policies elided for length — they are still enforced)_");
      break;
    }
    parts.push(section);
    budget -= section.length;
  }
  return parts.join("\n");
}

/**
 * The mail-send policy gate, called beside the Suppression check at the same
 * choke point, for every sender — a Policy binds the company, not just its
 * models, for exactly the reason Suppression does. Throws naming the policy;
 * the violation is audited whether or not the caller surfaces the error.
 */
export async function assertRecipientsPolicyAllowed(
  companyId: string,
  addresses: string[],
  actor: { employeeId?: string | null; userId?: string | null } = {},
): Promise<void> {
  const normalized = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return;
  const policies = await enabledPolicies(companyId);
  for (const policy of policies) {
    const domains = parseList(policy.blockedRecipientDomains);
    if (domains.length === 0) continue;
    const blocked = normalized.filter((address) => {
      const at = address.lastIndexOf("@");
      if (at < 0) return false;
      const domain = address.slice(at + 1);
      return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
    });
    if (blocked.length > 0) {
      await recordAudit({
        companyId,
        actorEmployeeId: actor.employeeId ?? null,
        actorUserId: actor.userId ?? null,
        action: "policy.violation",
        targetType: "company_policy",
        targetId: policy.id,
        targetLabel: policy.title,
        metadata: { kind: "blocked_recipient_domain", blocked },
      });
      throw new PolicyBlockedRecipientError(policy.title, blocked);
    }
  }
}

/**
 * The MCP-dispatch gate: the first enabled policy forbidding `toolName`, or
 * null. The middleware refuses the call and audits when one matches.
 */
export async function policyForbiddingTool(
  companyId: string,
  toolName: string,
): Promise<CompanyPolicy | null> {
  const policies = await enabledPolicies(companyId);
  for (const policy of policies) {
    if (parseList(policy.forbiddenTools).includes(toolName.toLowerCase())) return policy;
  }
  return null;
}

export async function recordToolPolicyViolation(args: {
  policy: CompanyPolicy;
  toolName: string;
  employeeId: string;
}): Promise<void> {
  await recordAudit({
    companyId: args.policy.companyId,
    actorEmployeeId: args.employeeId,
    action: "policy.violation",
    targetType: "company_policy",
    targetId: args.policy.id,
    targetLabel: args.policy.title,
    metadata: { kind: "forbidden_tool", tool: args.toolName },
  });
}

/**
 * Owners hear about an exhausted Budget once per calendar month — claimed on
 * the row so a retrying employee cannot page on every attempt. Lives here
 * beside the other policy-shaped notification rather than in the ad-spend
 * ledger, which stays a pure arithmetic closure.
 */
export async function notifyBudgetExhaustedOnce(budget: {
  id: string;
  companyId: string;
  name: string;
  lastExhaustedNotifiedAt: Date | null;
}): Promise<void> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { Budget } = await import("../db/entities/Budget.js");
  const repo = AppDataSource.getRepository(Budget);
  const claim = await repo
    .createQueryBuilder()
    .update()
    .set({ lastExhaustedNotifiedAt: new Date() })
    .where("id = :id", { id: budget.id })
    .andWhere(
      '("lastExhaustedNotifiedAt" IS NULL OR "lastExhaustedNotifiedAt" < :monthStart)',
      { monthStart },
    )
    .execute();
  if (claim.affected !== 1) return;
  try {
    const admins = await AppDataSource.getRepository(Membership).find({
      where: { companyId: budget.companyId, role: In(["owner", "admin"]) },
    });
    if (admins.length === 0) return;
    await createNotifications(
      admins.map((m) => ({
        companyId: budget.companyId,
        userId: m.userId,
        kind: "budget_exhausted" as const,
        title: `Budget exhausted: ${budget.name}`,
        body:
          "An ad-spend increase was refused because this month's envelope is spent. " +
          "Raise the budget or wait for the month to roll over.",
        link: `/marketing/budgets`,
        actorKind: "system" as const,
        entityKind: "budget" as const,
        entityId: budget.id,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[budgets] failed to notify exhaustion of ${budget.id}:`, err);
  }
}
