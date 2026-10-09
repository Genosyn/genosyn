import { z } from "zod";
import { formatHumanDecisionContext } from "../../shared/decisionContext.js";
import { decisionStackInstructionLines } from "../../shared/decisionStackInstructions.js";
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

/**
 * What every employee briefing says instead of {@link HUMAN_DECISION_GUIDANCE}
 * while a company has the Decision stack switched off
 * (`services/decisionStackSettings.ts`). It also overrides older stored text —
 * a starter Routine's brief, a Skill — that still says to raise one, so the
 * briefing never promises a tool the server refuses.
 */
export const DECISION_STACK_OFF_GUIDANCE =
  "Your company has turned the Decision stack off, so you cannot raise new Decisions: " +
  "`request_decision` is unavailable, and any instruction in a Routine, Skill, Soul or handover to " +
  "raise one no longer applies. When you reach a choice you would otherwise ask about, follow your " +
  "instructions, Soul and company Policies; take only allowed steps you can easily undo; record open " +
  "questions and blocked work in your Workstream or work report so a person can pick them up; and " +
  "never take a consequential step you lack the authority for. Decisions already waiting can still be " +
  "answered, and list_decisions reads the answers. Grants, company Policies, delivery restrictions and " +
  "required Approvals, email reviews and work reviews still apply.";

/**
 * The company's own Decision stack instructions, numbered, for an employee's
 * briefing — so it can hold back a question before asking, which is cheaper
 * than the server-side screen that stays authoritative. Empty when the
 * company has cleared its instructions.
 */
export function decisionStackInstructionsGuidance(instructions: string): string {
  const lines = decisionStackInstructionLines(instructions);
  if (lines.length === 0) return "";
  return [
    "Your company's Decision stack instructions, written by its owners and admins. Every question " +
      "is checked against them before it reaches the stack, and a question they keep off creates " +
      "nothing, so check yours against them before you ask:",
    ...lines.map((line, index) => `  ${index + 1}. ${line}`),
  ].join("\n");
}

export const humanDecisionReasonSchema = z
  .string()
  .trim()
  .min(20, "Explain the major stakes and the choice that requires human judgment.")
  .max(1_500);

/** Put the rationale first so it remains visible even in bounded previews,
 * in the form the review cards read back (`shared/decisionContext.ts`).
 * Callers still apply the destination's own length ceiling after composing. */
export function withHumanDecisionReason(context: string, humanDecisionReason: string): string {
  const reason = redactApprovalSummary(humanDecisionReasonSchema.parse(humanDecisionReason)) ?? "";
  const evidence = redactApprovalSummary(context) ?? "";
  return formatHumanDecisionContext(reason, evidence);
}
