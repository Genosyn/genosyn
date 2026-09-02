import React from "react";
import { X } from "lucide-react";
import { clsx } from "./clsx";

/**
 * The chrome every modal surface shares: the scrim, the card, the dismiss
 * button, the action tray, and the keyboard behaviour that makes the thing a
 * dialog rather than a floating div.
 *
 * `Modal` (a titled panel a page opens) and `Dialog` (the promise-returning
 * confirm / prompt / alert stack) both compose these pieces, so the two
 * cannot drift apart again — they had grown two close buttons, two focus
 * traps, two footers and two answers to "what closes when I press Escape".
 */

export type ModalSize = "sm" | "md" | "lg" | "xl";

const widthClass: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
};

/* ── The open-overlay stack ───────────────────────────────────────────────
 *
 * Every open surface pushes an entry; only the last one reacts to Escape and
 * Tab. Ordering used to be decided by which listener happened to run first —
 * `Modal` on `document` bubble, `Dialog` on `window` capture — which meant a
 * Dialog opened over a Modal beat it by accident, and two stacked Modals both
 * closed on one Escape. A stack says it once and says it for every surface.
 *
 * The listener deliberately does not stop propagation: components rendered
 * inside a modal (a `Select` popup, a `Menu`) still see the key, exactly as
 * they did before.
 */

type Overlay = {
  panel: React.RefObject<HTMLDivElement | null>;
  dismiss: () => void;
  /** Consume Escape before it dismisses. True when the surface handled it. */
  escape?: () => boolean;
};

const overlays: Overlay[] = [];

const FOCUSABLE = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[contenteditable="true"]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * What Tab can actually reach inside `panel`.
 *
 * `element.hidden` only reports the HTML attribute, so a selector alone counts
 * `display: none` subtrees and closed `<details>`. A ghost landing first or
 * last in that list makes the wrap-around call `.focus()` on something that
 * cannot take focus, and Tab appears to do nothing. `getClientRects()` rather
 * than `offsetParent`, which is null for `position: fixed` children and would
 * wrongly discard them.
 */
function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.closest("details:not([open])") === null &&
      element.getClientRects().length > 0,
  );
}

function onKeyDown(event: KeyboardEvent) {
  const top = overlays[overlays.length - 1];
  const panel = top?.panel.current;
  if (!panel) return;

  // Mid-composition keys belong to the IME. Escape is how a Japanese, Chinese
  // or Korean writer abandons a candidate, and closing the whole dialog on it
  // is how they lose the message they were writing.
  if (event.isComposing) return;

  if (event.key === "Escape") {
    event.preventDefault();
    // A surface may own the key before the dialog does — an autocomplete
    // inside a modal should close itself on the first Escape, not take the
    // whole modal down with it. Deliberately Escape-only: a *click* on the X
    // was aimed at Close, and must not be eaten by an open popup.
    if (top.escape?.()) return;
    top.dismiss();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = focusableWithin(panel);
  if (focusable.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ── Page scroll lock ─────────────────────────────────────────────────────
 *
 * Refcounted, because a Dialog routinely opens on top of a Modal and the
 * inner one closing must not hand scrolling back to the page. The padding
 * compensates for the scrollbar `overflow: hidden` removes, so the page
 * behind does not jump sideways as the modal opens.
 *
 * Inside the app shell this does nothing on its own — `<main>` is the
 * scroller there, not the document — and what actually stops a wheel over the
 * scrim from scrolling the page behind is the portal: the overlay is no longer
 * a descendant of `<main>`, so scroll cannot chain into it. The lock earns its
 * keep on the routes rendered outside the shell (login, signup, reset, public
 * signing), where the document really is what scrolls.
 */

let scrollLocks = 0;
let releaseScroll: (() => void) | null = null;

function lockPageScroll() {
  scrollLocks += 1;
  if (scrollLocks > 1) return;
  const { body } = document;
  const previousOverflow = body.style.overflow;
  const previousPaddingRight = body.style.paddingRight;
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = "hidden";
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
  releaseScroll = () => {
    body.style.overflow = previousOverflow;
    body.style.paddingRight = previousPaddingRight;
  };
}

function unlockPageScroll() {
  if (scrollLocks === 0) return;
  scrollLocks -= 1;
  if (scrollLocks > 0) return;
  releaseScroll?.();
  releaseScroll = null;
}

/**
 * Focus, keyboard and scroll behaviour for one modal surface. Returns the ref
 * to hand to `<ModalPanel>` and the id to hand to its title.
 *
 * Initial focus goes to the first field the person is meant to fill in, never
 * to the close button (`data-modal-close`), and never at all if the content
 * already claimed it with `autoFocus`.
 */
export function useModalChrome({
  open,
  onDismiss,
  onEscape,
}: {
  open: boolean;
  onDismiss: () => void;
  /** Return true to swallow Escape — see {@link Overlay.escape}. */
  onEscape?: () => boolean;
}) {
  const titleId = React.useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  const escapeRef = React.useRef(onEscape);
  escapeRef.current = onEscape;

  React.useEffect(() => {
    if (!open) return;

    const entry: Overlay = {
      panel: panelRef,
      dismiss: () => dismissRef.current(),
      escape: () => escapeRef.current?.() ?? false,
    };
    overlays.push(entry);
    if (overlays.length === 1) window.addEventListener("keydown", onKeyDown, true);
    lockPageScroll();

    const restoreFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const preferred = focusableWithin(panel).find(
        (element) => !element.hasAttribute("data-modal-close"),
      );
      (preferred ?? panel).focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      overlays.splice(overlays.indexOf(entry), 1);
      if (overlays.length === 0) window.removeEventListener("keydown", onKeyDown, true);
      unlockPageScroll();
      // Only if it is still on the page: the action that closed the modal has
      // often re-rendered the row button that opened it, and focusing a
      // detached node silently drops focus to <body>, restarting the next Tab
      // at the top of the app. When it has genuinely gone — the Home row you
      // opened and then resolved is the everyday case — fall back to the main
      // region the skip link already targets, so focus lands somewhere real.
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus({ preventScroll: true });
      else document.getElementById("main-content")?.focus({ preventScroll: true });
    };
  }, [open]);

  return { titleId, panelRef };
}

/**
 * Which stacking layer a surface belongs to. Naming the rungs is the point:
 * the app had grown `z-50`, `z-[60]`, `z-[70]` and `z-[80]` scattered across
 * a dozen hand-rolled overlays, with nothing saying which beat which.
 *
 * - `modal`   a page's own modal
 * - `nested`  a modal opened from inside another modal or panel
 * - `dialog`  the global confirm / prompt / alert stack, which answers for
 *             everything above — so nothing routine should outrank it
 * - `top`     the rare surface that must cover even a dialog
 */
export type ModalLayer = "modal" | "nested" | "dialog" | "top";

const layerClass: Record<ModalLayer, string> = {
  modal: "z-50",
  nested: "z-[60]",
  dialog: "z-[70]",
  top: "z-[80]",
};

/** The dimmed ground a modal sits on. */
export function ModalScrim({
  layer = "modal",
  onDismiss,
  children,
}: {
  layer?: ModalLayer;
  /** Omit to make the backdrop inert — for a modal that must not be dismissed mid-flight. */
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "fixed inset-0 flex items-center justify-center p-4",
        "animate-scrim-in bg-slate-900/35 motion-reduce:animate-none dark:bg-slate-950/80",
        layerClass[layer],
      )}
      // `mousedown` on the scrim itself, so a selection drag that starts in an
      // input and ends out here does not count as "clicked outside".
      onMouseDown={(event) => {
        if (onDismiss && event.target === event.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}

/**
 * The card. `max-h-full` rather than a viewport unit: it resolves against the
 * scrim's own content box, which already tracks a mobile browser's retracting
 * toolbar, so the panel can never grow taller than the space it is centred in.
 */
export const ModalPanel = React.forwardRef<
  HTMLDivElement,
  {
    size?: ModalSize;
    labelledBy?: string;
    describedBy?: string;
    /** For a surface that intercepts a key of its own before the shared trap sees it. */
    onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
  }
>(function ModalPanel({ size = "md", labelledBy, describedBy, onKeyDown: onKey, children }, ref) {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKey}
      tabIndex={-1}
      className={clsx(
        "flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white",
        // Three layers doing three jobs: a contact shadow that seats the card,
        // a mid blur that gives the corners form, and a wide ambient dark
        // enough to register against an already-dimmed page. `shadow-xl` at
        // 10% black was invisible over the scrim, in dark mode especially.
        "shadow-[0_1px_2px_0_rgba(15,23,42,0.04),0_8px_16px_-6px_rgba(15,23,42,0.10),0_24px_48px_-16px_rgba(15,23,42,0.24)]",
        "animate-panel-in motion-reduce:animate-none",
        "dark:border-slate-700 dark:bg-slate-900",
        "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_24px_48px_-16px_rgba(0,0,0,0.65)]",
        widthClass[size],
      )}
    >
      {children}
    </div>
  );
});

/** The dismiss affordance. 32px of target around an 18px glyph, pulled back
 *  by its own overhang so the header keeps the height it always had. */
export function ModalCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-modal-close
      onClick={onClick}
      aria-label="Close"
      className="-my-1 -mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <X size={18} />
    </button>
  );
}

/**
 * The action tray. Pinned below the scrolling body, so a long form never
 * carries its own Save button off the bottom of the screen, and stacked on a
 * phone so two long labels cannot squeeze each other into ellipses.
 */
export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-slate-200/70 bg-slate-50 px-4 py-3 sm:flex-row sm:justify-end sm:px-5 dark:border-slate-800 dark:bg-slate-950/50">
      {children}
    </div>
  );
}
