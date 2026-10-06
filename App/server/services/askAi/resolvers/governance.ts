import { AppDataSource } from "../../../db/datasource.js";
import { Decision, type DecisionOption } from "../../../db/entities/Decision.js";
import { Initiative } from "../../../db/entities/Initiative.js";
import { UUID_RE } from "../../bases.js";
import { resolveGoal as loadGoal } from "../../goals.js";
import { clip, day, facts, fenced, stamp, type AskAiResolver } from "../context.js";
import { employeeNames } from "./routines.js";

/**
 * The company's own steering records: Decisions, Goals and Initiatives. All of
 * them are readable by any Member of the company.
 *
 * A Decision is readable by AI Employees only narrowly — `get_decision` serves
 * the employee that raised it and the one it is routed to while pending — so
 * its gate names exactly those employees. Goals and Initiatives are company
 * direction every employee already reads through its tools.
 */

function parseOptions(json: string): DecisionOption[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as DecisionOption[]) : [];
  } catch {
    return [];
  }
}

export const resolveDecision: AskAiResolver = async ({ companyId, ref }) => {
  if (!UUID_RE.test(ref.id)) return [];
  const decision = await AppDataSource.getRepository(Decision).findOneBy({
    id: ref.id,
    companyId,
  });
  if (!decision) return [];
  const names = await employeeNames(companyId, [
    decision.employeeId,
    decision.routedToEmployeeId,
  ]);
  const asker = names.get(decision.employeeId);
  const options = parseOptions(decision.optionsJson);
  const readers = [decision.employeeId];
  if (decision.routedToEmployeeId && decision.status === "pending") {
    readers.push(decision.routedToEmployeeId);
  }
  const body = [
    facts([
      ["Decision id", decision.id],
      ["Asked by", asker ? `${asker.name} (@${asker.slug})` : "an AI Employee that no longer exists"],
      ["Status", decision.status],
      ["Urgency", decision.urgency],
      ["Asked", stamp(decision.createdAt)],
      ["Expires", decision.expiresAt ? stamp(decision.expiresAt) : null],
      ["Chosen", decision.chosenOptionLabel],
      ["Decided", decision.decidedAt ? stamp(decision.decidedAt) : null],
    ]),
    "",
    "### Question",
    fenced(clip(`${decision.title}\n\n${decision.body}`, 6_000), "markdown"),
    "",
    "### Options",
    options.length
      ? options
          .map((o) => `- ${o.label} (id \`${o.id}\`)${o.detail ? ` — ${o.detail}` : ""}`)
          .join("\n")
      : "(none recorded)",
    ...(decision.note ? ["", "### Answer note", fenced(clip(decision.note, 2_000))] : []),
  ].join("\n");
  return [
    {
      kind: "decision",
      id: decision.id,
      label: `Decision ${decision.title.slice(0, 60)}`,
      sublabel: `${decision.status}${asker ? ` · ${asker.name}` : ""}`,
      href: `/decisions#decision-${decision.id}`,
      gate: { type: "employees", employeeIds: readers },
      body,
      tools: ["get_decision"],
      briefing: () =>
        "\n### Decision\nAnswering a Decision is the Member's call — explain the options and their consequences, but never present your view as the answer, and never claim to have answered it.",
      defaultEmployeeIds: [decision.employeeId],
    },
  ];
};

export const resolveGoal: AskAiResolver = async ({ companyId, ref }) => {
  const goal = await loadGoal(companyId, ref.id);
  if (!goal) return [];
  const names = await employeeNames(companyId, [goal.ownerEmployeeId]);
  const owner = goal.ownerEmployeeId ? names.get(goal.ownerEmployeeId) : undefined;
  const body = [
    facts([
      ["Goal", `${goal.title} (slug \`${goal.slug}\`, id ${goal.id})`],
      ["Status", goal.status],
      ["Owner", owner ? `${owner.name} (@${owner.slug})` : null],
      ["Metric", goal.metricKind],
      ["Direction", goal.direction],
      ["Start", goal.startValue === null ? null : `${goal.startValue} ${goal.unit}`.trim()],
      ["Current", goal.currentValue === null ? "not yet measured" : `${goal.currentValue} ${goal.unit}`.trim()],
      ["Target", `${goal.targetValue} ${goal.unit}`.trim()],
      ["Last measured", goal.currentValueUpdatedAt ? stamp(goal.currentValueUpdatedAt) : null],
      ["Due", goal.dueAt ? day(goal.dueAt) : null],
    ]),
    ...(goal.description.trim()
      ? ["", "### Description", fenced(clip(goal.description, 4_000), "markdown")]
      : []),
  ].join("\n");
  return [
    {
      kind: "goal",
      id: goal.id,
      label: `Goal ${goal.title}`,
      sublabel: goal.status,
      href: "/goals",
      gate: { type: "none" },
      body,
      tools: ["get_goal"],
      defaultEmployeeIds: owner ? [owner.id] : undefined,
    },
  ];
};

export const resolveInitiative: AskAiResolver = async ({ companyId, ref }) => {
  if (!UUID_RE.test(ref.id)) return [];
  const initiative = await AppDataSource.getRepository(Initiative).findOneBy({
    id: ref.id,
    companyId,
  });
  if (!initiative) return [];
  const names = await employeeNames(companyId, [initiative.employeeId]);
  const proposer = names.get(initiative.employeeId);
  const body = [
    facts([
      ["Initiative id", initiative.id],
      ["Proposed by", proposer ? `${proposer.name} (@${proposer.slug})` : null],
      ["Status", initiative.status],
      ["Proposed", stamp(initiative.createdAt)],
      ["Decided", initiative.decidedAt ? stamp(initiative.decidedAt) : null],
      ["Created Routine", initiative.createdRoutineId],
    ]),
    "",
    "### Proposal",
    fenced(clip(initiative.proposal, 4_000), "markdown"),
    "",
    "### Evidence",
    fenced(clip(initiative.evidence, 3_000), "markdown"),
    ...(initiative.reviewNote.trim()
      ? ["", "### Review note", fenced(clip(initiative.reviewNote, 1_500))]
      : []),
  ].join("\n");
  return [
    {
      kind: "initiative",
      id: initiative.id,
      label: `Initiative ${initiative.title.slice(0, 60)}`,
      sublabel: `${initiative.status}${proposer ? ` · ${proposer.name}` : ""}`,
      href: "/initiatives",
      gate: { type: "none" },
      body,
      tools: ["get_initiative"],
      defaultEmployeeIds: proposer ? [proposer.id] : undefined,
    },
  ];
};
