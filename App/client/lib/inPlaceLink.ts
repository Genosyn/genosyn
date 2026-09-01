/**
 * When a link should open where you are instead of taking you somewhere.
 *
 * Several surfaces now answer a click by opening the thing beside or over what
 * you were reading — repository work next to a conversation, an unread channel
 * over Home — rather than replacing the page. All of them have to agree about
 * one thing: which clicks are the browser's and which are ours.
 *
 * The rows stay real anchors precisely so this rule has something to defer to.
 * A `<button>` would be simpler and would quietly cost ⌘-click, middle-click,
 * "open in new tab", and the destination preview in the status bar — browser
 * affordances people already have, traded for a product one they did not ask
 * for.
 */

/** What a click handler needs to know, without depending on the DOM. */
export type LinkClickIntent = {
  /** 0 is the primary button. */
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  /** The anchor's `target` attribute, when it has one. */
  anchorTarget?: string | null;
};

/**
 * Whether this click should be handled in place rather than navigating.
 *
 * Only a plain left click. ⌘/Ctrl-click, shift-click, and middle-click are how
 * people deliberately ask for a new tab or window, and swallowing them would
 * be taking away a browser affordance rather than adding a product one. An
 * anchor aimed at another target already says where it wants to open.
 */
export function shouldOpenInPlace(intent: LinkClickIntent): boolean {
  if (intent.defaultPrevented) return false;
  if ((intent.button ?? 0) !== 0) return false;
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) return false;
  const target = (intent.anchorTarget ?? "").trim().toLowerCase();
  if (target && target !== "_self") return false;
  return true;
}

/**
 * The same question asked of a React mouse event, which is how every caller
 * actually has it. Saves each one restating the six fields.
 */
export function shouldOpenEventInPlace(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return shouldOpenInPlace({
    button: event.button,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    defaultPrevented: event.defaultPrevented,
  });
}
