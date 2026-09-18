import { z } from "zod";
import { redactApprovalSummary } from "./approvalRedaction.js";

/** Shared by Decision intake and proactive work reviews. This is a statement
 * of the human choice, never an authorization to bypass a Grant or Approval. */
export const HUMAN_DECISION_GUIDANCE =
  "Reserve the Decision stack for major decisions that need human judgment: strategic direction, " +
  "material financial or contractual commitments, significant legal, security or reputational risk, " +
  "conflicting company Policies, or a consequential action that is difficult to reverse. Explain the " +
  "specific stakes and the human choice that existing instructions do not settle. Missing information " +
  "belongs here only when it blocks such a decision and cannot be found in your granted sources. " +
  "Routine CRM maintenance, deduplication, investigation, email preparation, wording, labels and " +
  "ordinary follow-ups do not need a Decision. Complete allowed, reversible work using the existing " +
  "instructions; keep minor unknowns and blocked steps in the Workstream or work report. Never invent " +
  "facts or expand authority to avoid asking. Grants, company Policies, delivery restrictions and " +
  "required action Approvals still apply.";

export const humanDecisionReasonSchema = z
  .string()
  .trim()
  .min(20, "Explain the major stakes and the choice that requires human judgment.")
  .max(1_500);

/** Put the rationale first so it remains visible even in bounded previews.
 * Callers still apply the destination's own length ceiling after composing. */
export function withHumanDecisionReason(context: string, humanDecisionReason: string): string {
  const reason = redactApprovalSummary(humanDecisionReasonSchema.parse(humanDecisionReason)) ?? "";
  const evidence = redactApprovalSummary(context) ?? "";
  return `## Why this needs a human decision\n${reason}\n\n${evidence}`.trim();
}
