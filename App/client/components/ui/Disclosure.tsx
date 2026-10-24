import React from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "./clsx";

export type DisclosureProps = {
  /** What is tucked away — "Advanced", "More details", a settings group's name. */
  title: React.ReactNode;
  /**
   * What is configured inside, shown beside the title while the disclosure is
   * closed *and* open. Anything the person set must stay visible without
   * opening it, so say "Approval required · 2 Checks", or that everything is at
   * its default; never leave it blank.
   */
  summary?: React.ReactNode;
  /**
   * `row` is a bordered toggle with the content below it, for a stack of cards
   * that should stay out of the way. `card` makes the whole disclosure one card,
   * for a list of sections that each collapse to a single line.
   */
  variant?: "row" | "card";
  /** Wrap the toggle in a heading, for a title screen readers should be able to jump to. */
  heading?: "h2" | "h3" | "h4";
  /** Controlled state. Leave both `open` and `onOpenChange` off to let it manage itself. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Keep the content mounted (and hidden) while closed. Needed when it loads its
   * own data that the `summary` reports, or holds state that must survive a
   * collapse. Otherwise the content is only rendered while open.
   */
  keepMounted?: boolean;
  className?: string;
  children: React.ReactNode;
};

/**
 * The one way Genosyn tucks options away: show the basics, put everything else
 * behind a single disclosure that is closed by default, and let its summary say
 * what is configured inside so that hiding it never hides a setting.
 */
export function Disclosure({
  title,
  summary,
  variant = "row",
  heading,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  keepMounted = false,
  className,
  children,
}: DisclosureProps) {
  const [openState, setOpenState] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const panelId = React.useId();
  const card = variant === "card";
  const rendered = open || keepMounted;

  function toggle() {
    const next = !open;
    if (!controlled) setOpenState(next);
    onOpenChange?.(next);
  }

  const hasSummary = summary !== undefined && summary !== null && summary !== "";
  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls={rendered ? panelId : undefined}
      className={clsx(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
        // An inset ring: the toggle is as wide as its card, so an outline
        // outside it would be clipped by whatever holds the card.
        "hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus dark:hover:bg-slate-800/60",
        card
          ? open
            ? "rounded-t-xl"
            : "rounded-xl"
          : "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      {card ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
            {title}
          </span>
          {hasSummary && (
            <span className="min-w-0 max-w-[60%] text-right text-xs text-slate-500 dark:text-slate-400">
              {summary}
            </span>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
            {title}
          </span>
          {hasSummary && (
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {summary}
            </span>
          )}
        </span>
      )}
      <ChevronDown
        size={16}
        aria-hidden="true"
        className={clsx(
          "shrink-0 text-slate-400 transition-transform dark:text-slate-500",
          open && "rotate-180",
        )}
      />
    </button>
  );

  const Heading = heading;
  return (
    <div
      className={clsx(
        card &&
          "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {Heading ? <Heading className="m-0">{toggleButton}</Heading> : toggleButton}
      {rendered && (
        <div
          id={panelId}
          hidden={!open}
          className={clsx(card ? "border-t border-slate-100 p-4 dark:border-slate-800" : "mt-4")}
        >
          {children}
        </div>
      )}
    </div>
  );
}
