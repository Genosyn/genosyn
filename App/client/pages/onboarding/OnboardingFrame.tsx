import React from "react";
import { type LucideIcon } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { clsx } from "../../components/ui/clsx";

/**
 * The shared shell every guide step renders through.
 *
 * Before this existed the four steps each picked their own content width,
 * heading size and card padding, so the frame visibly jumped between steps and
 * the flow read as four forms rather than one guided setup. Everything here is
 * deliberately one option: one width, one heading size, one padding, one footer
 * layout. Steps decide their *content*, never their geometry.
 */

/** The single content width for the whole guide. */
export const STEP_WIDTH = "mx-auto w-full max-w-3xl";

export function StepCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardBody className="p-5 sm:p-6">{children}</CardBody>
    </Card>
  );
}

/** The accent chip that carries a step's icon. Matches `lib/sections.ts`. */
export function AccentTile({
  icon: Icon,
  size = "md",
}: {
  icon: LucideIcon;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
        size === "sm" ? "h-8 w-8" : "h-10 w-10",
      )}
    >
      <Icon size={size === "sm" ? 15 : 18} />
    </span>
  );
}

export function StepHeading({
  icon,
  title,
  description,
  id,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <AccentTile icon={icon} />
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
        )}
      </div>
    </div>
  );
}

/**
 * One footer for every step, so the control the member hunts for on each screen
 * never moves. On mobile the primary action stacks on top (`flex-col-reverse`)
 * and every control goes full width.
 */
export function StepFooter({
  onBack,
  backLabel = "Back",
  secondary,
  children,
}: {
  onBack?: () => void;
  backLabel?: string;
  secondary?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-100 pt-5 sm:flex-row sm:items-center dark:border-slate-800">
      {onBack && (
        // Explicit `type` — a footer inside a step's form would otherwise
        // submit it, because Button leaves the native default alone.
        <Button type="button" variant="ghost" className="w-full sm:w-auto" onClick={onBack}>
          {backLabel}
        </Button>
      )}
      <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center">
        {secondary}
        {children}
      </div>
    </div>
  );
}

/**
 * The escape hatch that appears beside a primary action. A plain link so it
 * never competes with the CTA, but always labelled with what it actually
 * skips — "Skip for now" next to a button that does the same thing taught
 * members that button weight means nothing.
 */
export function SkipLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 sm:py-0 dark:text-slate-400 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

/**
 * A tinted note. `info` teaches, `warn` flags something the member must fix,
 * `success` confirms. One convention for the whole guide so three consecutive
 * screens stop inventing three different grammars for the same thing.
 */
export function Note({
  kind = "info",
  icon: Icon,
  title,
  children,
  className,
}: {
  kind?: "info" | "warn" | "success";
  icon?: LucideIcon;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const tone = {
    info: {
      box: "border-indigo-200 bg-indigo-50/70 dark:border-indigo-500/30 dark:bg-indigo-500/10",
      icon: "text-indigo-600 dark:text-indigo-300",
      title: "text-indigo-950 dark:text-indigo-100",
      body: "text-indigo-900/80 dark:text-indigo-200/80",
    },
    warn: {
      box: "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10",
      icon: "text-amber-600 dark:text-amber-300",
      title: "text-amber-950 dark:text-amber-100",
      body: "text-amber-900/80 dark:text-amber-200/80",
    },
    success: {
      box: "border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10",
      icon: "text-emerald-600 dark:text-emerald-300",
      title: "text-emerald-950 dark:text-emerald-100",
      body: "text-emerald-900/80 dark:text-emerald-200/80",
    },
  }[kind];

  return (
    <div className={clsx("rounded-xl border p-4", tone.box, className)}>
      <div className="flex items-start gap-2.5">
        {Icon && <Icon size={16} className={clsx("mt-0.5 shrink-0", tone.icon)} />}
        <div className="min-w-0 text-sm leading-6">
          {title && <div className={clsx("font-semibold", tone.title)}>{title}</div>}
          <div className={clsx(title ? "mt-0.5" : null, tone.body)}>{children}</div>
        </div>
      </div>
    </div>
  );
}
