/**
 * Written instructions: plain language a Member types into a box once, one
 * instruction per line, that an AI Employee then applies on its own — a
 * mailbox's AI analysis instructions (`mailAnalysisInstructions.ts`) and the
 * Decision stack's instructions (`decisionStackInstructions.ts`).
 *
 * Both boxes behave the same way, so the rules live here once: what counts as
 * a change, how the text is stored, how it splits into numbered lines (the
 * numbers a model cites back), and what cannot be saved. Each feature keeps
 * its own default text and limits and wraps these in its own names.
 *
 * Shared between client and server so the box's Save button, the API's
 * refusal, and the numbers the model cites can never disagree.
 */

export type InstructionsTextLimits = {
  /** Characters, counted on the stored (normalized) text. */
  maxLength: number;
  /** Instructions — non-blank lines once list markers are stripped. */
  maxLines: number;
};

/**
 * The text as it is stored: Windows and old-Mac line endings made `\n`,
 * trailing spaces dropped from every line, and blank lines trimmed from both
 * ends. Words and inner blank lines are left exactly as typed.
 */
export function normalizeInstructionsText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * A list marker people type out of habit: `-`, `*`, `•`, a dash, or `1.` /
 * `1)`, followed by a space (or nothing, on a line that is only the marker).
 * "-5% coupons" and "1.5x" are words, not markers, and are left alone.
 */
const LIST_MARKER = /^\s*(?:[-*•–—]|\d{1,3}[.)])(?:\s+|$)/;

/** Every non-blank line, without its list marker, uncapped. */
function allInstructionLines(normalized: string): string[] {
  return normalized
    .split("\n")
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .filter(Boolean);
}

/**
 * The instructions one per line, without list markers, skipping blank lines.
 * Capped at `maxLines` so a row written by an older release or a direct
 * database edit still yields a bounded list.
 */
export function instructionsTextLines(value: string, maxLines: number): string[] {
  return allInstructionLines(normalizeInstructionsText(value)).slice(0, maxLines);
}

/**
 * Why this text cannot be saved, in a sentence a person can act on, or null.
 * Checked on the normalized text, which is what would be stored.
 */
export function instructionsTextProblem(
  value: string,
  limits: InstructionsTextLimits,
): string | null {
  const text = normalizeInstructionsText(value);
  if (text.length > limits.maxLength) {
    return `Keep the instructions under ${limits.maxLength.toLocaleString("en-US")} characters.`;
  }
  // Tabs and new lines are how people lay text out; anything else below a
  // space is a broken paste or a probe, and the prompt is no place for it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) {
    return "Instructions can only contain printable characters.";
  }
  if (allInstructionLines(text).length > limits.maxLines) {
    return `Keep it to ${limits.maxLines} instructions or fewer, one per line.`;
  }
  return null;
}

/** Whether two versions of the box say the same thing once stored. */
export function sameInstructionsText(left: string, right: string): boolean {
  return normalizeInstructionsText(left) === normalizeInstructionsText(right);
}
