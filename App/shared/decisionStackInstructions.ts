/**
 * The Decision stack's instructions: plain language an owner or admin writes
 * once about which questions belong on the company's Decision stack. Every
 * question an AI Employee raises is checked against them before it is stacked
 * (`server/services/decisionScreening.ts`), and every employee reads them in
 * its own briefing so it can hold back a question before asking.
 *
 * Shared between client and server so the settings box and the API agree on
 * the same limits, the same notion of "unchanged", and the same numbered
 * lines — the number the screen cites is the number this file assigns. The
 * rules are the ones every instructions box follows (`instructionsText.ts`);
 * this file holds the Decision stack's default and limits.
 */
import {
  instructionsTextLines,
  instructionsTextProblem,
  normalizeInstructionsText,
  sameInstructionsText,
} from "./instructionsText.js";

/**
 * What a company follows until an owner or admin writes its own. Plain,
 * short, and in the voice of the people who answer the stack: it is the
 * example people edit. It says what `HUMAN_DECISION_GUIDANCE` says — only
 * major choices belong on the stack — in words a non-technical owner uses.
 */
export const DEFAULT_DECISION_STACK_INSTRUCTIONS = [
  "Only ask us about big decisions: spending money, contracts and other commitments, and anything that is hard to undo.",
  "Also ask about legal, security or reputation risks, policies that disagree with each other, and choices that change the direction of the company.",
  "Don't ask about routine upkeep, wording, labels, follow-ups, research or duplicates, or anything you can look up yourself.",
  "If a choice is easy to undo, make the safest sensible choice yourself, note what you chose, and carry on.",
].join("\n");

/** Room for a page of instructions, and a hard bound on what reaches every prompt. */
export const MAX_DECISION_STACK_INSTRUCTIONS_LENGTH = 4_000;

/** Each line is numbered for the model; past this the list stops being instructions. */
export const MAX_DECISION_STACK_INSTRUCTION_LINES = 30;

/** The stored shape: see {@link normalizeInstructionsText}. */
export function normalizeDecisionStackInstructions(value: string): string {
  return normalizeInstructionsText(value);
}

/**
 * The instructions one per line, without list markers, skipping blank lines,
 * capped at {@link MAX_DECISION_STACK_INSTRUCTION_LINES}. Instruction `n` is
 * `lines[n - 1]`.
 */
export function decisionStackInstructionLines(value: string): string[] {
  return instructionsTextLines(value, MAX_DECISION_STACK_INSTRUCTION_LINES);
}

/** Why this text cannot be saved, in a sentence a person can act on, or null. */
export function decisionStackInstructionsProblem(value: string): string | null {
  return instructionsTextProblem(value, {
    maxLength: MAX_DECISION_STACK_INSTRUCTIONS_LENGTH,
    maxLines: MAX_DECISION_STACK_INSTRUCTION_LINES,
  });
}

/** Whether two versions of the box say the same thing once stored. */
export function sameDecisionStackInstructions(left: string, right: string): boolean {
  return sameInstructionsText(left, right);
}

/**
 * What a company's stored column means. Null follows the current default —
 * so the default can be improved later and "Restore default" is writing null
 * back — while an empty string is a deliberate "no instructions".
 */
export function effectiveDecisionStackInstructions(stored: string | null | undefined): string {
  return stored === null || stored === undefined ? DEFAULT_DECISION_STACK_INSTRUCTIONS : stored;
}
