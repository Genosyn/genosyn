import { AppDataSource } from "../../db/datasource.js";
import { Decision, type DecisionStatus } from "../../db/entities/Decision.js";
import { expireStaleDecisions, parseDecisionOptions } from "../decisions.js";
import { redactSensitiveText } from "../approvalRedaction.js";

function preview(value: string, cap: number) {
  const text = redactSensitiveText(value);
  return {
    excerpt:
      text.length > cap ? text.slice(0, cap - 1).replace(/[\uD800-\uDBFF]$/, "") + "…" : text,
    truncated: text.length > cap,
  };
}

export function serializeEmployeeDecision(decision: Decision) {
  const context = preview(decision.body, 500);
  return {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    urgency: decision.urgency,
    routedToEmployeeId: decision.routedToEmployeeId,
    contextExcerpt: context.excerpt,
    contextTruncated: context.truncated,
    options: parseDecisionOptions(decision.optionsJson).map((option) => {
      const detail = preview(option.detail ?? "", 120);
      return {
        id: option.id,
        label: option.label,
        detailExcerpt: detail.excerpt,
        detailTruncated: detail.truncated,
      };
    }),
    chosenOptionId: decision.chosenOptionId,
    chosenOptionLabel: decision.chosenOptionLabel,
    note: decision.note,
    decidedAt: decision.decidedAt?.toISOString() ?? null,
    createdAt: decision.createdAt.toISOString(),
  };
}

/** Assigned means a current pending routing; historical routing never widens the inbox. */
export async function listEmployeeDecisionInbox(args: {
  companyId: string;
  employeeId: string;
  direction?: "raised" | "assigned" | "both";
  status?: DecisionStatus;
  limit?: number;
}) {
  await expireStaleDecisions(args.companyId);
  const direction = args.direction ?? "raised";
  const query = AppDataSource.getRepository(Decision)
    .createQueryBuilder("decision")
    .where("decision.companyId = :companyId", { companyId: args.companyId });
  const raised = "decision.employeeId = :employeeId";
  const assigned = "(decision.routedToEmployeeId = :employeeId AND decision.status = :pending)";
  query.andWhere(
    direction === "both"
      ? `(${raised} OR ${assigned})`
      : direction === "assigned"
        ? assigned
        : raised,
    { employeeId: args.employeeId, pending: "pending" },
  );
  if (args.status) query.andWhere("decision.status = :status", { status: args.status });
  return query
    .orderBy("decision.createdAt", "DESC")
    .addOrderBy("decision.id", "ASC")
    .take(args.limit ?? 20)
    .getMany();
}
