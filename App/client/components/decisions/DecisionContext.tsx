import {
  AlignLeft,
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarClock,
  CircleHelp,
  Coins,
  FileSearch,
  History,
  Lightbulb,
  Split,
  type LucideIcon,
} from "lucide-react";
import type { DecisionContextSection } from "../../../shared/decisionContext";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { clsx } from "@/components/ui/clsx";
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

/**
 * The employee's longer context as the labelled sections it wrote ("What I
 * checked", "Risk"), each marked with a matching icon. It only ever renders
 * inside a row's Details, so it shows everything: the row's first lines are
 * what keep the stack short.
 */
export function DecisionContextSections({
  sections,
  heading,
  className,
}: {
  sections: DecisionContextSection[];
  /** The Details section these sit under; a section repeating it shows no label. */
  heading?: string;
  className?: string;
}) {
  return (
    <div className={clsx("space-y-3", className)}>
      {sections.map((section, index) => {
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
              className={clsx(
                "break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300",
                label && "mt-0.5 sm:pl-5",
              )}
            >
              <ChatMarkdown content={section.body} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
