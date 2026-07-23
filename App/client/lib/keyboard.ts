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
