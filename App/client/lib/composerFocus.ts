import { anotherDialogIsOpen, isTypingTarget } from "./keyboard";

/**
 * Putting the cursor in a message box when someone arrives at it — a chat
 * thread, a channel, the Ask AI panel — saves the click into the box that
 * every first message used to start with.
 *
 * It is only done where it helps. On a touch-first device focusing raises the
 * on-screen keyboard over the conversation the person came to read, so the
 * arrival focus waits for a fine pointer (a mouse or trackpad, which comes
 * with a keyboard). And it never takes focus away from a field the person is
 * already typing in, or from a dialog that owns the screen.
 */

type FocusField = Pick<
  HTMLTextAreaElement,
  "disabled" | "value" | "focus" | "setSelectionRange" | "isConnected"
>;

export type ArrivalFocusContext = {
  /** A mouse or trackpad is the primary pointer. */
  finePointer: boolean;
  /** What holds focus right now, if anything. */
  active: Element | null;
  /** Whether that element is a text-entry field. */
  activeIsTyping: boolean;
  /** Whether a modal dialog owns the screen. */
  dialogOpen: boolean;
};

export type ArrivalFocusOptions = {
  /**
   * The person explicitly asked for this box (opened Ask AI), so it may take
   * focus from another field they were typing in. Never from a dialog.
   */
  overTyping?: boolean;
};

/** Whether the arrival focus should move into `field` now. Pure, for tests. */
export function shouldFocusOnArrival(
  field: Pick<FocusField, "disabled" | "isConnected"> | null,
  context: ArrivalFocusContext,
  options: ArrivalFocusOptions = {},
): boolean {
  if (!field || field.disabled || !field.isConnected || !context.finePointer) return false;
  if (context.active === (field as unknown as Element)) return false;
  if (context.activeIsTyping && !options.overTyping) return false;
  return !context.dialogOpen;
}

/** A mouse or trackpad is the primary pointer, so a keyboard is at hand. */
export function hasFinePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches
  );
}

/**
 * Focus a message box the person just arrived at, with the cursor after any
 * text already in it (a draft carried over, a staged message). Returns whether
 * focus moved.
 */
export function focusOnArrival(
  field: FocusField | null,
  options: ArrivalFocusOptions = {},
): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  const go = shouldFocusOnArrival(
    field,
    {
      finePointer: hasFinePointer(),
      active,
      activeIsTyping: isTypingTarget(active),
      dialogOpen: anotherDialogIsOpen(),
    },
    options,
  );
  if (!go || !field) return false;
  field.focus({ preventScroll: true });
  const end = field.value.length;
  try {
    field.setSelectionRange(end, end);
  } catch {
    // Some input types do not support a selection; focus alone is enough.
  }
  return true;
}
