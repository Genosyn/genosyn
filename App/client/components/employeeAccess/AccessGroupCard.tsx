import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Lock } from "lucide-react";
import {
  accessBadge,
  selectionState,
  sharedLockReason,
  type AccessBadge,
  type AccessGroupView,
  type AccessItem,
} from "@/lib/employeeAccess";
import { Checkbox } from "@/components/ui/Checkbox";
import { clsx } from "@/components/ui/clsx";
import { ACCESS_GROUP_HOME, ACCESS_GROUP_ICON } from "./accessIcons";

const BADGE_TONE: Record<AccessBadge["tone"], string> = {
  granted:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  default:
    "bg-slate-100 text-slate-700 ring-slate-500/15 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-400/20",
  inherited:
    "bg-indigo-50 text-indigo-700 ring-indigo-600/15 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20",
  none: "bg-white text-slate-500 ring-slate-300/70 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-600/60",
  hidden:
    "bg-slate-50 text-slate-400 ring-slate-300/50 dark:bg-slate-900 dark:text-slate-500 dark:ring-slate-700/60",
};

/**
 * One group of the Access page — Mailboxes, Notes and notebooks, Company
 * sections — as a card: a tick-all box in its header, then a row per thing
 * with the employee's access to it. A row the viewer may not change keeps its
 * box disabled and says why, in the words of the kind's own rule.
 */
export function AccessGroupCard({
  companySlug,
  view,
  selected,
  filtering,
  onToggle,
  onToggleAll,
}: {
  companySlug: string;
  view: AccessGroupView;
  selected: ReadonlySet<string>;
  /** A search or filter narrows the list, so an empty group says "nothing matches". */
  filtering: boolean;
  onToggle: (item: AccessItem, event: React.MouseEvent | React.ChangeEvent) => void;
  onToggleAll: (items: AccessItem[], on: boolean) => void;
}) {
  const Icon = ACCESS_GROUP_ICON[view.group.key];
  const home = ACCESS_GROUP_HOME[view.group.key];
  const state = selectionState(view.items, selected);
  const headingId = React.useId();
  const tickable = view.items.some((item) => item.canChange);
  // When every row is locked for the same reason, say it once for the group.
  const sharedReason = sharedLockReason(view.items);

  return (
    <section
      aria-labelledby={headingId}
      data-access-group={view.group.key}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="pt-0.5">
          <Checkbox
            checked={state === "all"}
            indeterminate={state === "some"}
            disabled={!tickable}
            label={`Select every ${view.group.label.toLowerCase()} item shown`}
            title={tickable ? undefined : "Nothing here you can change"}
            onChange={() => onToggleAll(view.items, state !== "all")}
          />
        </div>
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Icon size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {view.group.label}
            </h2>
            {view.total > 0 && (
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {view.withAccess} of {view.total} with access
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{view.group.description}</p>
          {sharedReason && (
            <p className="mt-1 flex items-start gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{sharedReason}</span>
            </p>
          )}
        </div>
        {home && view.total > 0 && (
          <Link
            to={`/c/${companySlug}${home.path}`}
            className="hidden shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800 sm:inline-flex dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            {home.label} <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        )}
      </header>

      {view.unavailable ? (
        <p className="flex items-start gap-2 px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
          <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {view.unavailable}
        </p>
      ) : view.items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
          {filtering ? (
            "Nothing here matches."
          ) : home?.empty ? (
            <>
              {home.empty}{" "}
              <Link
                to={`/c/${companySlug}${home.path}`}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open {home.label}
              </Link>
            </>
          ) : (
            "Nothing to grant here yet."
          )}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {view.items.map((item) => (
            <AccessRow
              key={item.key}
              companySlug={companySlug}
              item={item}
              checked={selected.has(item.key)}
              showReason={!sharedReason}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}

      {view.truncated && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Showing the first ones only. Search to find the rest.
        </p>
      )}
    </section>
  );
}

function AccessRow({
  companySlug,
  item,
  checked,
  showReason,
  onToggle,
}: {
  companySlug: string;
  item: AccessItem;
  checked: boolean;
  /** False when the group's header already says why every row is locked. */
  showReason: boolean;
  onToggle: (item: AccessItem, event: React.MouseEvent | React.ChangeEvent) => void;
}) {
  const badge = accessBadge(item);
  return (
    <li
      data-access-row={item.key}
      data-access-label={item.label}
      onClick={(event) => {
        // The whole row ticks its box, except the link and the box itself.
        if (!item.canChange) return;
        if ((event.target as HTMLElement).closest("a,input,button")) return;
        onToggle(item, event);
      }}
      className={clsx(
        "flex items-start gap-3 px-4 py-2.5",
        item.canChange && "cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/40",
        checked && "bg-indigo-50/50 dark:bg-indigo-500/5",
      )}
    >
      <div className="pt-0.5">
        <Checkbox
          checked={checked}
          disabled={!item.canChange}
          label={`Select ${item.label}`}
          title={item.canChange ? undefined : (item.reason ?? undefined)}
          onChange={(event) => onToggle(item, event)}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            {item.href ? (
              <Link
                to={`/c/${companySlug}${item.href}`}
                className="block truncate text-sm font-medium text-slate-900 hover:text-indigo-700 hover:underline dark:text-slate-100 dark:hover:text-indigo-300"
              >
                {item.label}
              </Link>
            ) : (
              <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {item.label}
              </span>
            )}
            {item.detail && (
              <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{item.detail}</span>
            )}
          </div>
          <span
            data-access-badge
            title={badge.title}
            className={clsx(
              "inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
              BADGE_TONE[badge.tone],
            )}
          >
            {badge.text}
          </span>
        </div>
        {showReason && !item.canChange && item.reason && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{item.reason}</span>
          </p>
        )}
      </div>
    </li>
  );
}
