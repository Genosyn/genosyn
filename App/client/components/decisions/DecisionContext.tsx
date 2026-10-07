import React from "react";
import {
  AlignLeft,
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Coins,
  FileSearch,
  History,
  Lightbulb,
  Scale,
  Split,
  type LucideIcon,
} from "lucide-react";
import {
  HUMAN_DECISION_HEADING,
  type DecisionContextSection,
} from "../../../shared/decisionContext";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { clsx } from "@/components/ui/clsx";
import { ReviewTimelineItem } from "@/components/decisions/ReviewTimeline";
import {
  contextSectionKind,
  repeatsHeading,
  type ContextSectionKind,
} from "@/components/decisions/contextSections";

const KIND_ICON: Record<ContextSectionKind, { icon: LucideIcon; cls: string }> = {
  blocked: { icon: Ban, cls: "text-rose-500 dark:text-rose-400" },
  risk: { icon: AlertTriangle, cls: "text-amber-500 dark:text-amber-400" },
  recommendation: { icon: Lightbulb, cls: "text-indigo-500 dark:text-indigo-400" },
  options: { icon: Split, cls: "text-slate-400 dark:text-slate-500" },
  timing: { icon: CalendarClock, cls: "text-slate-400 dark:text-slate-500" },
  cost: { icon: Coins, cls: "text-slate-400 dark:text-slate-500" },
  unknowns: { icon: CircleHelp, cls: "text-slate-400 dark:text-slate-500" },
  evidence: { icon: FileSearch, cls: "text-slate-400 dark:text-slate-500" },
  next: { icon: ArrowRight, cls: "text-slate-400 dark:text-slate-500" },
  background: { icon: History, cls: "text-slate-400 dark:text-slate-500" },
  other: { icon: AlignLeft, cls: "text-slate-400 dark:text-slate-500" },
};

// Literal class names, so Tailwind keeps every clamp the preview can pick.
const CLAMP: Record<number, string> = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
};

/**
 * Whether a clamp under `ref` (any `[data-clamped]` element) hides lines. That
 * depends on the width the card has, so it is measured, and re-measured as the
 * card resizes, rather than guessed from character counts.
 */
function useClipped(ref: React.RefObject<HTMLElement>, active: boolean, content: unknown) {
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const measure = () =>
      setClipped(
        Array.from(root.querySelectorAll<HTMLElement>("[data-clamped]")).some(
          (element) => element.scrollHeight > element.clientHeight + 1,
        ),
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, active, content]);
  return clipped;
}

function ToggleButton({
  open,
  controls,
  label,
  onToggle,
}: {
  open: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
    >
      {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      {open ? "Show less" : label}
    </button>
  );
}

/**
 * The stated reason a human has to decide, as its own step between the story
 * and the choice, so it never sinks into the context around it. A long reason
 * opens on six lines, which on a phone is still most of a screen.
 */
export function DecisionReasonItem({ reason }: { reason: string }) {
  const [open, setOpen] = React.useState(false);
  // Measured apart from the toggle, so showing the toggle never re-measures.
  const textRef = React.useRef<HTMLDivElement>(null);
  const clipped = useClipped(textRef, !open, reason);
  const id = React.useId();
  return (
    <ReviewTimelineItem icon={Scale} title={HUMAN_DECISION_HEADING} tone="warning">
      <div className="rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
        <div ref={textRef}>
          <div
            id={id}
            data-clamped={open ? undefined : ""}
            className={clsx(
              "break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200",
              !open && "line-clamp-6",
            )}
          >
            <ChatMarkdown content={reason} />
          </div>
        </div>
        {(open || clipped) && (
          <div className="mt-2">
            <ToggleButton
              open={open}
              controls={id}
              label="Read the full reason"
              onToggle={() => setOpen((value) => !value)}
            />
          </div>
        )}
      </div>
    </ReviewTimelineItem>
  );
}

/**
 * The employee's context as labelled sections. With `preview`, the card opens
 * on the first sections, clamped to a line budget, and names the rest so the
 * reader knows what "Read the full context" adds before opening it.
 */
export function DecisionContextSections({
  id,
  sections,
  heading,
  preview,
  className,
}: {
  id: string;
  sections: DecisionContextSection[];
  /** The timeline step these sit under; a section repeating it shows no label. */
  heading?: string;
  /** Omit to show everything. */
  preview?: { sections: number; lines: number };
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const collapsed = preview !== undefined && !open;
  const shown = collapsed ? sections.slice(0, preview.sections) : sections;
  const hidden = collapsed ? sections.slice(preview.sections) : [];
  const clamp = collapsed
    ? CLAMP[Math.min(6, Math.max(2, Math.floor(preview.lines / Math.max(1, shown.length))))]
    : undefined;
  const clipped = useClipped(listRef, collapsed, sections);

  return (
    <div
      className={clsx(
        "rounded-lg border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/50",
        className,
      )}
    >
      <div id={id} ref={listRef} className="space-y-3">
        {shown.map((section, index) => {
          const label =
            section.label && !repeatsHeading(section.label, heading) ? section.label : null;
          const { icon: Icon, cls } = KIND_ICON[contextSectionKind(label)];
          return (
            <div key={index} className="min-w-0">
              {label && (
                <h5 className="flex min-w-0 items-start gap-1.5 text-[13px] font-semibold leading-5 text-slate-800 dark:text-slate-100">
                  <Icon size={14} aria-hidden="true" className={clsx("mt-0.5 shrink-0", cls)} />
                  <span className="min-w-0 break-words">{label}</span>
                </h5>
              )}
              <div
                data-clamped={clamp ? "" : undefined}
                className={clsx(
                  "break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300",
                  label && "mt-0.5 sm:pl-5",
                  clamp,
                )}
              >
                <ChatMarkdown content={section.body} />
              </div>
            </div>
          );
        })}
      </div>
      {(open || clipped || hidden.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ToggleButton
            open={open}
            controls={id}
            label="Read the full context"
            onToggle={() => setOpen((value) => !value)}
          />
          {hidden.length > 0 && (
            <ul
              aria-label="Also in the full context"
              className="flex min-w-0 flex-wrap items-center gap-1.5"
            >
              {hidden.map((section, index) => {
                const { icon: Icon, cls } = KIND_ICON[contextSectionKind(section.label)];
                return (
                  <li
                    key={index}
                    className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                  >
                    <Icon size={11} aria-hidden="true" className={clsx("shrink-0", cls)} />
                    <span className="min-w-0 truncate">{section.label ?? "More context"}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
