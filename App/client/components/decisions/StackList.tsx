import { Mail, ShieldCheck } from "lucide-react";
import type { Company } from "@/lib/api";
import { Checkbox } from "@/components/ui/Checkbox";
import { clsx } from "@/components/ui/clsx";
import { DecisionStackCard } from "@/components/decisions/DecisionStackCard";
import type { RowSelection } from "@/components/decisions/StackRow";
import { groupHeading, groupStackItems } from "@/components/decisions/stackStatus";
import type {
  DecisionFollowUps,
  DecisionStackItem,
} from "@/components/decisions/useDecisionFollowUps";

/** The stack page's selection, as one list draws it. */
export type StackListSelection = {
  /** What the list is, for its select-all box: "Needs you". */
  label: string;
  /** Whether a row can be ticked: it is waiting, and this viewer may act on it. */
  selectable: (item: DecisionStackItem) => boolean;
  selected: ReadonlySet<string>;
  toggle: (key: string, extend: boolean) => void;
  /** Tick or untick several rows at once: a group's, or the whole list's. */
  setMany: (keys: string[], selected: boolean) => void;
  /** While a bulk action runs. */
  disabled?: boolean;
};

/**
 * The Decision stack as a short list: one compact row per item, with email
 * reviews (and work reviews) gathered under one heading so a run of them
 * reads at a glance. Home's Active decisions, the stack's sections and its
 * "Assigned to other Members" all draw it, so they look and behave alike.
 *
 * With a `selection` — the stack page only — every waiting row gets a tick
 * box, a group heading ticks its own rows, and a strip over the list ticks
 * them all, for the page's bulk bar.
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
  selection,
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
  selection?: StackListSelection;
}) {
  const selectableKeys = (rows: DecisionStackItem[]) =>
    selection ? rows.filter(selection.selectable).map((item) => item.key) : [];
  const rowSelection = (item: DecisionStackItem): RowSelection | undefined =>
    selection?.selectable(item)
      ? {
          selected: selection.selected.has(item.key),
          onToggle: (extend) => selection.toggle(item.key, extend),
          disabled: selection.disabled,
        }
      : undefined;
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
      selection={rowSelection(item)}
    />
  );
  const framed =
    !bare &&
    "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
  const allKeys = selectableKeys(items);
  const list = (
    <ul
      data-stack-list
      className={clsx(
        "divide-y divide-slate-100 dark:divide-slate-800",
        allKeys.length === 0 ? framed : !bare && "bg-white dark:bg-slate-900",
      )}
    >
      {groupStackItems(items).map((entry) => {
        if (entry.kind === "item") return card(entry.item);
        const heading = groupHeading(entry.group, entry.items);
        const Icon = entry.group === "mail" ? Mail : ShieldCheck;
        const groupKeys = selectableKeys(entry.items);
        const title = (
          <>
            <Icon size={13} aria-hidden="true" /> {heading}
          </>
        );
        return (
          <li key={entry.key} data-stack-group={entry.group}>
            {heading &&
              (selection && groupKeys.length > 0 ? (
                <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
                  <SelectBox
                    keys={groupKeys}
                    selection={selection}
                    label={`Select every waiting ${entry.group === "mail" ? "email" : "work plan"}`}
                  />
                  <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {title}
                  </p>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 px-4 pt-3 text-xs font-medium text-slate-500 sm:px-5 dark:text-slate-400">
                  {title}
                </p>
              ))}
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
  if (!selection || allKeys.length === 0) return list;
  const ticked = allKeys.filter((key) => selection.selected.has(key)).length;
  // Clipped, so a ticked row's wash keeps the list's rounded corners.
  return (
    <div className={clsx("overflow-hidden", framed)}>
      <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 sm:px-5 dark:border-slate-800">
        <SelectBox
          keys={allKeys}
          selection={selection}
          label={`Select every waiting item in ${selection.label}`}
        />
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {ticked > 0 ? (
            <span className="font-medium text-indigo-700 dark:text-indigo-300">
              {ticked} selected
            </span>
          ) : (
            "Select all"
          )}
        </span>
      </label>
      {list}
    </div>
  );
}

/** Ticks a set of rows together; part-ticked shows as a dash. */
function SelectBox({
  keys,
  selection,
  label,
}: {
  keys: string[];
  selection: StackListSelection;
  label: string;
}) {
  const ticked = keys.filter((key) => selection.selected.has(key)).length;
  const all = ticked === keys.length;
  return (
    <Checkbox
      checked={all}
      indeterminate={ticked > 0}
      disabled={selection.disabled}
      label={label}
      onChange={() => selection.setMany(keys, !all)}
    />
  );
}
