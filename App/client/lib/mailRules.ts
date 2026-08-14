import type { MailAccessLevel, MailRuleAction, MailRuleConditions } from "./mail";

export type RuleEmployeeCandidate = {
  id: string;
  name: string;
  model?: {
    model: string;
    status: "connected" | "not_connected";
  } | null;
};

export type RuleGrantCandidate = {
  employeeId: string;
  accessLevel: MailAccessLevel;
};

export type RuleEmployeeOption<TEmployee extends RuleEmployeeCandidate = RuleEmployeeCandidate> = {
  employee: TEmployee;
  eligible: boolean;
  detail: string;
};

const ACCESS_LABEL: Record<MailAccessLevel, string> = {
  read: "Read",
  draft: "Draft",
  send: "Send",
};

export function ruleEmployeeOptions<TEmployee extends RuleEmployeeCandidate>(
  employees: TEmployee[],
  grants: RuleGrantCandidate[],
): RuleEmployeeOption<TEmployee>[] {
  const grantsByEmployee = new Map(grants.map((grant) => [grant.employeeId, grant]));
  return employees.map((employee) => {
    const grant = grantsByEmployee.get(employee.id);
    const hasConnectedModel = employee.model?.status === "connected";
    const problems: string[] = [];
    if (!grant) problems.push("no mailbox access");
    if (!hasConnectedModel) problems.push("no connected model");
    const eligible = Boolean(grant && hasConnectedModel);
    return {
      employee,
      eligible,
      detail:
        eligible && grant && employee.model
          ? `${ACCESS_LABEL[grant.accessLevel]} access · ${employee.model.model}`
          : problems.join(" · "),
    };
  });
}

/** Normalize editor state for the API and omit response-only display fields. */
export function cleanMailRuleConditions(conditions: MailRuleConditions): MailRuleConditions {
  const out: MailRuleConditions = {};
  if (conditions.from?.trim()) out.from = conditions.from.trim();
  if (conditions.to?.trim()) out.to = conditions.to.trim();
  if (conditions.subjectContains?.trim()) out.subjectContains = conditions.subjectContains.trim();
  if (conditions.bodyContains?.trim()) out.bodyContains = conditions.bodyContains.trim();
  if (conditions.hasAttachment) out.hasAttachment = true;
  if (conditions.ai) {
    out.ai = {
      employeeId: conditions.ai.employeeId.trim(),
      instruction: conditions.ai.instruction.trim(),
    };
  }
  return out;
}

/** Normalize actions for the strict API and omit response-only display fields. */
export function cleanMailRuleActions(actions: MailRuleAction[]): MailRuleAction[] {
  return actions.map((action) => {
    switch (action.type) {
      case "applyLabel":
        return { type: "applyLabel", labelName: action.labelName.trim() };
      case "handToEmployee":
        return {
          type: "handToEmployee",
          employeeId: action.employeeId,
          instruction: action.instruction.trim(),
          mode: action.mode,
        };
      case "markRead":
      case "star":
      case "archive":
      case "unsubscribe":
        return { type: action.type };
    }
  });
}

export function hasMailRuleCondition(conditions: MailRuleConditions): boolean {
  return Boolean(
    conditions.from?.trim() ||
    conditions.to?.trim() ||
    conditions.subjectContains?.trim() ||
    conditions.bodyContains?.trim() ||
    conditions.hasAttachment ||
    conditions.ai?.instruction.trim(),
  );
}

export const CATCH_ALL_UNSUBSCRIBE_ERROR =
  "Add at least one static filter or AI judgment before unsubscribing automatically.";

export function validateUnsubscribeRuleScope(
  conditions: MailRuleConditions,
  actions: MailRuleAction[],
): string | null {
  if (
    actions.some((action) => action.type === "unsubscribe") &&
    !hasMailRuleCondition(conditions)
  ) {
    return CATCH_ALL_UNSUBSCRIBE_ERROR;
  }
  return null;
}

export function compactRuleText(value: string, limit = 96): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export type MailRuleSummaryParts = {
  staticConditions: string[];
  ai: { employeeName: string; instruction: string } | null;
  actions: string[];
};

export function mailRuleSummaryParts(
  conditions: MailRuleConditions,
  actions: MailRuleAction[],
): MailRuleSummaryParts {
  const staticConditions: string[] = [];
  if (conditions.from) staticConditions.push(`from contains "${conditions.from}"`);
  if (conditions.to) staticConditions.push(`to contains "${conditions.to}"`);
  if (conditions.subjectContains) {
    staticConditions.push(`subject contains "${conditions.subjectContains}"`);
  }
  if (conditions.bodyContains) {
    staticConditions.push(`body contains "${conditions.bodyContains}"`);
  }
  if (conditions.hasAttachment) staticConditions.push("has attachment");

  return {
    staticConditions,
    ai: conditions.ai
      ? {
          employeeName: conditions.ai.employeeName ?? "AI employee",
          instruction: compactRuleText(conditions.ai.instruction),
        }
      : null,
    actions: actions.map((action) => {
      switch (action.type) {
        case "applyLabel":
          return `label "${action.labelName}"`;
        case "markRead":
          return "mark read";
        case "star":
          return "star";
        case "archive":
          return "archive";
        case "unsubscribe":
          return "unsubscribe safely";
        case "handToEmployee":
          return `hand to ${action.employeeName ?? "AI"} (${action.mode})`;
      }
    }),
  };
}
