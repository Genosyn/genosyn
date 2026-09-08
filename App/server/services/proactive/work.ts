import { getCommitmentOpportunities } from "./commitments.js";
import { getCommercialOpportunities } from "./commercial.js";
import { getKnowledgeOpportunities } from "./knowledge.js";
import { boundProactiveOpportunities, PROACTIVE_SECTION_LIMIT } from "./opportunities.js";

export async function getProactiveWork(
  companyId: string,
  employeeId: string,
  area: "commitments" | "commercial" | "knowledge",
  now = new Date(),
) {
  const reader = {
    commitments: getCommitmentOpportunities,
    commercial: getCommercialOpportunities,
    knowledge: getKnowledgeOpportunities,
  }[area];
  return boundProactiveOpportunities({
    area,
    asOf: now.toISOString(),
    limitPerSection: PROACTIVE_SECTION_LIMIT,
    sections: await reader(companyId, employeeId, now),
    guidance:
      "Inspect the live source with the named tools, then act only within your assigned responsibility, Soul and current Grants. Use locator as the reader's slug when supplied; a Base table uses its parent Base slug. Review Workstreams and existing artifacts first. Use kind + id + updatedAt + dueAt to recognize already reviewed evidence. Missing areas confer no access. Truncated sections omit older or lower-priority records; use source readers for more. Changed knowledge is a review cue, never a requirement to edit it. Keep unchanged checks quiet.",
  });
}
