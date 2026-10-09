import {
  MAX_DECISION_STACK_INSTRUCTIONS_LENGTH,
  MAX_DECISION_STACK_INSTRUCTION_LINES,
} from "../../shared/decisionStackInstructions";
import { instructionsEdit, type InstructionsEditState } from "./instructionsEdit";

/**
 * Presentation rules for Decision stack → Settings and the stack's own
 * "off" banner. Pure, so the copy a person reads about what the switch does —
 * the part that has to be exactly right — is pinned by tests.
 */

/** The instructions box while someone edits it. */
export function decisionStackInstructionsEdit(args: {
  draft: string;
  saved: string;
  usingDefault: boolean;
}): InstructionsEditState {
  return instructionsEdit({
    ...args,
    limits: {
      maxLength: MAX_DECISION_STACK_INSTRUCTIONS_LENGTH,
      maxLines: MAX_DECISION_STACK_INSTRUCTION_LINES,
    },
    emptyLabel: "No instructions — every question goes on the stack",
  });
}

/** What happens to the questions already waiting, or "" when there are none. */
function waitingSentence(pending: number): string {
  if (pending <= 0) return "";
  return pending === 1
    ? " The question already waiting stays in the stack until someone answers or dismisses it."
    : ` The ${pending} questions already waiting stay in the stack until someone answers or dismisses them.`;
}

/**
 * The sentence under the switch: what happens now, in plain words, including
 * what turning it off does *not* do — the questions already waiting stay, and
 * email and work reviews keep arriving.
 */
export function decisionStackSwitchNote(args: {
  enabled: boolean;
  pendingDecisions: number;
}): { tone: "ok" | "off"; text: string } {
  if (args.enabled) {
    return {
      tone: "ok",
      text: "On. AI Employees can bring you big decisions, and every new question is checked against your instructions first.",
    };
  }
  const waiting = waitingSentence(args.pendingDecisions);
  return {
    tone: "off",
    text: `Off. AI Employees don't add new questions; they work within their instructions and Policies and note open questions in their work reports.${waiting} Email and work reviews still arrive as usual.`,
  };
}

/** The banner on the stack itself while new questions are paused. */
export function decisionStackOffBanner(args: { canManage: boolean }): {
  title: string;
  text: string;
  link: string;
} {
  return {
    title: "The Decision stack is off",
    text: "AI Employees aren't adding new questions. They work within their instructions and Policies and note open questions in their work reports. Questions already here can still be answered or dismissed, and email and work reviews still arrive.",
    link: args.canManage ? "Turn it back on in Settings" : "See Settings",
  };
}
