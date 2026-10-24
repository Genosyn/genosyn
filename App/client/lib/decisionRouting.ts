import type { DecisionPolicyRule } from "./api";

/** How one routing rule reads on Decision stack → Settings: "<asking> → <decider>". */
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
 * Label one routing rule. Kept out of the page so the retired
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

/** True when any rule is a retired "their manager" rule, so the page explains them once. */
export function hasRetiredRoutingRules(
  rules: ReadonlyArray<Pick<DecisionPolicyRule, "deciderKind">>,
): boolean {
  return rules.some((rule) => rule.deciderKind !== "employee");
}

/**
 * The closed Advanced line on Decision stack → Settings: what routing is set,
 * so a rule is never invisible while the disclosure is shut (AGENTS.md §8).
 * `null` is a list still loading, or one that could not load.
 *
 *   []                        → "No routing rules · every question goes to people"
 *   [named]                   → "1 routing rule"
 *   [named, named (off)]      → "2 routing rules · 1 off"
 *   [their manager, named]    → "2 routing rules · 1 no longer routes"
 */
export function describeDecisionRouting(
  rules: ReadonlyArray<Pick<DecisionPolicyRule, "enabled" | "deciderKind">> | null,
): string {
  if (rules === null) return "Routing rules";
  if (rules.length === 0) return "No routing rules · every question goes to people";
  const parts = [`${rules.length} routing rule${rules.length === 1 ? "" : "s"}`];
  // A retired rule never routes, on or off, so it is counted once, as that.
  const retired = rules.filter((rule) => rule.deciderKind !== "employee").length;
  const off = rules.filter((rule) => rule.deciderKind === "employee" && !rule.enabled).length;
  if (off > 0) parts.push(`${off} off`);
  if (retired > 0) parts.push(`${retired} no longer route${retired === 1 ? "s" : ""}`);
  return parts.join(" · ");
}
