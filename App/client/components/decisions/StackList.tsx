import { Mail, ShieldCheck } from "lucide-react";
import type { Company } from "@/lib/api";
import { clsx } from "@/components/ui/clsx";
import { DecisionStackCard } from "@/components/decisions/DecisionStackCard";
import { groupHeading, groupStackItems } from "@/components/decisions/stackStatus";
import type {
  DecisionFollowUps,
  DecisionStackItem,
} from "@/components/decisions/useDecisionFollowUps";

/**
 * The Decision stack as a short list: one compact row per item, with email
 * reviews (and work reviews) gathered under one heading so a run of them
 * reads at a glance. Home's Active decisions, the stack's sections and its
 * "Assigned to other Members" all draw it, so they look and behave alike.
 */
export function StackList({
  company,
  items,
  followUps,
  onResolved,
  canAnswer = true,
  onEditingChange,
  viewerId,
  bare = false,
}: {
  company: Company;
  /** Already in the order they should read. */
  items: DecisionStackItem[];
  followUps: DecisionFollowUps;
  /** After an action on a row; `kind` names the feed that row belongs to. */
  onResolved: (
    announcement: string | undefined,
    kind: "decision" | "review",
  ) => Promise<void> | void;
  canAnswer?: boolean;
  onEditingChange?: (id: string, editing: boolean) => void;
  viewerId?: string | null;
  /** Drop the list's own border, for a surface that already frames it. */
  bare?: boolean;
}) {
  const card = (item: DecisionStackItem, grouped = false) => (
    <DecisionStackCard
      key={item.key}
      company={company}
      item={item}
      followUps={followUps}
      onResolved={(announcement) =>
        onResolved(announcement, item.kind === "loading" ? item.reference.kind : item.kind)
      }
      canAnswer={canAnswer}
      onEditingChange={onEditingChange}
      viewerId={viewerId}
      grouped={grouped}
    />
  );
  return (
    <ul
      data-stack-list
      className={clsx(
        "divide-y divide-slate-100 dark:divide-slate-800",
        !bare &&
          "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      {groupStackItems(items).map((entry) => {
        if (entry.kind === "item") return card(entry.item);
        const heading = groupHeading(entry.group, entry.items);
        const Icon = entry.group === "mail" ? Mail : ShieldCheck;
        return (
          <li key={entry.key} data-stack-group={entry.group}>
            {heading && (
              <p className="flex items-center gap-1.5 px-4 pt-3 text-xs font-medium text-slate-500 sm:px-5 dark:text-slate-400">
                <Icon size={13} aria-hidden="true" /> {heading}
              </p>
            )}
            <ul
              aria-label={heading ?? undefined}
              className="divide-y divide-slate-100 dark:divide-slate-800"
            >
              {entry.items.map((item) => card(item, heading !== null))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
