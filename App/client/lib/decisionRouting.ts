import type { DecisionPolicyRule } from "./api";

/** How one routing rule reads in the Routing modal: "<asking> → <decider>". */
export type RoutingRuleLabel = {
  asking: string;
  decider: string;
  /**
   * A rule saved as "their manager" before reporting lines were removed. It
   * names nobody, so its askers' questions page people — and, being first in
   * line for them, it keeps any later rule from routing those questions.
   */
  retired: boolean;
};

/** The name shown for an employee a rule points at that no longer exists. */
export const DELETED_EMPLOYEE_LABEL = "(deleted employee)";

/**
 * Label one rule for the Routing modal. Kept out of the page so the retired
 * case — the only rule a Member can still see but no one can create — is
 * pinned by a unit test rather than by a reviewer remembering it exists.
 */
export function routingRuleLabel(
  rule: Pick<DecisionPolicyRule, "askingEmployeeId" | "deciderKind" | "deciderEmployeeId">,
  employeesById: ReadonlyMap<string, { name: string }>,
): RoutingRuleLabel {
  const asking = rule.askingEmployeeId
    ? (employeesById.get(rule.askingEmployeeId)?.name ?? DELETED_EMPLOYEE_LABEL)
    : "Any employee";
  if (rule.deciderKind !== "employee") return { asking, decider: "people", retired: true };
  const decider = rule.deciderEmployeeId
    ? (employeesById.get(rule.deciderEmployeeId)?.name ?? DELETED_EMPLOYEE_LABEL)
    : DELETED_EMPLOYEE_LABEL;
  return { asking, decider, retired: false };
}

/** True when any rule is a retired "their manager" rule, so the modal explains them once. */
export function hasRetiredRoutingRules(
  rules: ReadonlyArray<Pick<DecisionPolicyRule, "deciderKind">>,
): boolean {
  return rules.some((rule) => rule.deciderKind !== "employee");
}
