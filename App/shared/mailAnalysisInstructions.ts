/**
 * A mailbox's AI analysis instructions: plain-language lines a Member writes
 * once ("Unsubscribe me automatically from marketing emails.") and the AI
 * Employee reading the mailbox applies to every email that arrives.
 *
 * Shared between client and server so the settings box and the API agree on
 * the same limits, the same notion of "unchanged", and the same split into
 * numbered instructions — the numbers the model cites are the numbers this
 * file assigns, so a disagreement would attribute an action to the wrong line.
 * The rules themselves are the ones every instructions box follows
 * (`instructionsText.ts`); this file holds the mailbox's default and limits.
 */
import {
  instructionsTextLines,
  instructionsTextProblem,
  normalizeInstructionsText,
  sameInstructionsText,
} from "./instructionsText.js";

/**
 * What a mailbox follows until someone writes their own. Kept short and
 * plain on purpose: it is the example people edit, so it has to read like
 * something a person would type.
 */
export const DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS = [
  "Unsubscribe me automatically from marketing emails.",
  "Star emails that need my response and look important.",
].join("\n");

/** Room for a page of instructions, and a hard bound on what reaches every prompt. */
export const MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH = 4_000;

/** Each line is numbered for the model; past this the list stops being instructions. */
export const MAX_MAIL_ANALYSIS_INSTRUCTION_LINES = 30;

/**
 * The text as it is stored: Windows and old-Mac line endings made `\n`,
 * trailing spaces dropped from every line, and blank lines trimmed from both
 * ends. Words and inner blank lines are left exactly as typed.
 */
export function normalizeMailAnalysisInstructions(value: string): string {
  return normalizeInstructionsText(value);
}

/**
 * The instructions one per line, without list markers, skipping blank lines.
 * Capped at {@link MAX_MAIL_ANALYSIS_INSTRUCTION_LINES} so a row written by an
 * older or a direct database edit still yields a bounded list.
 */
export function mailAnalysisInstructionLines(value: string): string[] {
  return instructionsTextLines(value, MAX_MAIL_ANALYSIS_INSTRUCTION_LINES);
}

/**
 * Why this text cannot be saved, in a sentence a person can act on, or null.
 * Checked on the normalized text, which is what would be stored.
 */
export function mailAnalysisInstructionsProblem(value: string): string | null {
  return instructionsTextProblem(value, {
    maxLength: MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH,
    maxLines: MAX_MAIL_ANALYSIS_INSTRUCTION_LINES,
  });
}

/** Whether two versions of the box say the same thing once stored. */
export function sameMailAnalysisInstructions(left: string, right: string): boolean {
  return sameInstructionsText(left, right);
}
