import {
  instructionsTextLines,
  instructionsTextProblem,
  sameInstructionsText,
  type InstructionsTextLimits,
} from "../../shared/instructionsText";

/**
 * What an instructions box (`components/InstructionsEditor.tsx`) shows while
 * someone edits it: whether there is anything to save, why it cannot be
 * saved, whether Restore default is on offer, and how many instructions the
 * AI Employee will be given — counted exactly as the server will count them.
 *
 * Pure, so each feature that has a box pins its own copy in a test: the
 * mailbox's AI analysis instructions (`mailAnalysis.ts`) and the Decision
 * stack's (`decisionStack.ts`).
 */
export type InstructionsEditState = {
  dirty: boolean;
  /** Why the draft cannot be saved, or null. */
  problem: string | null;
  canSave: boolean;
  /** Restore default is offered once the saved text is the owner's own. */
  canRestore: boolean;
  /** "2 instructions" — what the AI Employee will be given. */
  countLabel: string;
};

export function instructionsEdit(args: {
  draft: string;
  saved: string;
  usingDefault: boolean;
  limits: InstructionsTextLimits;
  /** The count for an emptied box: what "no instructions" means for this box. */
  emptyLabel: string;
}): InstructionsEditState {
  const dirty = !sameInstructionsText(args.draft, args.saved);
  const problem = instructionsTextProblem(args.draft, args.limits);
  const count = instructionsTextLines(args.draft, args.limits.maxLines).length;
  return {
    dirty,
    problem,
    canSave: dirty && !problem,
    canRestore: !args.usingDefault,
    countLabel:
      count === 0 ? args.emptyLabel : `${count} instruction${count === 1 ? "" : "s"}`,
  };
}
