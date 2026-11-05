/**
 * Guards shared by every global key handler in the app.
 *
 * Single-key shortcuts are only safe because these two questions are asked the
 * same way everywhere: is the person typing, and is something modal already
 * holding focus? They started life inside `components/KeyboardShortcuts.tsx`;
 * they live here now so the mail surface can bind `j`/`k`/`e` without either
 * duplicating the rules or importing a provider it does not otherwise need.
 */

/**
 * True when the event landed inside anything text-entry-ish. `closest` rather
 * than a tag check so a keystroke inside a rich-text editor's nested markup
 * still counts as typing.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    ),
  );
}

/** True when a modal owns the screen — its own keys win over page shortcuts. */
export function anotherDialogIsOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
}

/**
 * Whether the global `G` navigation chord is waiting for its second key.
 *
 * A module-level flag rather than context because the pages that need it are
 * plain `window` keydown listeners, and — since React runs child effects before
 * parent ones — a page's listener can be registered *before* the provider's.
 * That ordering means a page cannot rely on the provider having called
 * `preventDefault` first: pressing `G` then `C` in mail would open the composer
 * and swallow "go to Code". There is exactly one provider, so one flag is the
 * honest model.
 */
let chordPending = false;

export function setChordPending(open: boolean): void {
  chordPending = open;
}

/** Just what {@link submitFormOnModEnter} reads from a React keyboard event. */
export type ModEnterEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent: { isComposing?: boolean };
  currentTarget: { form: Pick<HTMLFormElement, "requestSubmit"> | null };
  preventDefault: () => void;
};

/**
 * ⌘/Ctrl+Enter in a multi-line box submits its form, the way Enter does in a
 * one-line field — the "I mean it" key the app already uses for todo comments
 * and work briefs, so a note or brief needs no reach for the button. Keys
 * pressed mid-composition belong to the input method. The form's own submit
 * handler still decides whether there is anything to send. Returns whether it
 * submitted.
 */
export function submitFormOnModEnter(event: ModEnterEvent): boolean {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
  if (event.nativeEvent.isComposing) return false;
  const form = event.currentTarget.form;
  if (!form) return false;
  event.preventDefault();
  form.requestSubmit();
  return true;
}

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

/** Label for {@link isCreateTaskShortcut}, for hints and the keyboard guide. */
export const CREATE_TASK_SHORTCUT = IS_APPLE ? "⌥T" : "Alt T";

/** Just what {@link isCreateTaskShortcut} reads from a keyboard event. */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey"
>;

/**
 * ⌥T / Alt+T opens Create a task. It works from inside a field, so it needs a
 * modifier rather than a letter, and ⌘T / Ctrl+T belong to the browser, which
 * never hands them to a page.
 *
 * A letter in `key` is the answer, so a Dvorak T counts as a T. Otherwise fall
 * back to the physical key: a Mac reports ⌥T as `†`, and a Cyrillic layout
 * reports its own letter. Ctrl+Alt is AltGr on Windows, someone typing a
 * character, and never this.
 */
export function isCreateTaskShortcut(event: ShortcutKeyEvent): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key === "t" : event.code === "KeyT";
}

/**
 * The common bail-out for a page-level single-key shortcut: ignore keystrokes
 * that a modifier claims, that repeat from a held key, that something nearer
 * already handled, that belong to a field or dialog, or that are the second
 * half of a pending navigation chord.
 */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    event.repeat ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    chordPending ||
    isTypingTarget(event.target) ||
    anotherDialogIsOpen()
  );
}
