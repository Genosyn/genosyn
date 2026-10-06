import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, Check, Eye, Info, MessageSquare, PenLine } from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { useBackgroundAction } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import {
  api,
  type ResourceLibraryAccessLevel,
  type ResourceLibraryAccessResponse,
  type ResourceLibraryAccessRow,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  DEFAULT_RESOURCE_LIBRARY_LEVEL,
  RESOURCE_LIBRARY_LEVELS,
  replaceResourceLibraryRow,
  summarizeResourceLibraryAccess,
  withResourceLibraryAccess,
} from "../lib/resourceAiAccess";
import type { ResourcesOutletCtx } from "./ResourcesLayout";

/**
 * Resources → AI access. One row per AI Employee, each at Read + write (the
 * default) or Read only, across the whole library.
 *
 * Every Member can see the roster — what has been delegated is not a secret —
 * but only owners and admins can change it, the same split as the sibling AI
 * access pages. A change is optimistic: the toggle moves at once and snaps back
 * with an explanation if the server refuses it.
 */

const LEVEL_ICONS: Record<ResourceLibraryAccessLevel, React.ReactNode> = {
  read: <Eye size={14} />,
  write: <PenLine size={14} />,
};

/**
 * Each level keeps one colour on the legend and on the selected toggle, so a
 * long roster can be scanned for the read-only exceptions at a glance.
 */
const LEVEL_STYLES: Record<ResourceLibraryAccessLevel, { chip: string; selected: string }> = {
  read: {
    chip: "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300",
    selected:
      "bg-white text-amber-700 shadow-sm ring-1 ring-amber-200 dark:bg-slate-900 dark:text-amber-300 dark:ring-amber-500/30",
  },
  write: {
    chip: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
    selected:
      "bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-200 dark:bg-slate-900 dark:text-indigo-300 dark:ring-indigo-500/30",
  },
};

export default function ResourcesAiAccess() {
  const { company } = useOutletContext<ResourcesOutletCtx>();
  const background = useBackgroundAction();
  const [rows, setRows] = React.useState<ResourceLibraryAccessRow[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const canManage = company.role === "owner" || company.role === "admin";
  const base = `/api/companies/${company.id}/resources/ai-access`;
  const routeBase = `/c/${company.slug}/resources`;

  const load = React.useCallback(async () => {
    try {
      const result = await api.get<ResourceLibraryAccessResponse>(base);
      setRows(result.rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load AI access"));
    }
  }, [base]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A level changed elsewhere, or an employee was hired or let go.
  useLiveRefetch(["grant", "employee"], load);

  async function retry() {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }

  function changeLevel(row: ResourceLibraryAccessRow, level: ResourceLibraryAccessLevel) {
    if (row.accessLevel === level) return;
    setRows((current) => (current ? withResourceLibraryAccess(current, row.employee.id, level) : current));
    background(
      () =>
        api.put<{ row: ResourceLibraryAccessRow | null }>(`${base}/${row.employee.id}`, {
          accessLevel: level,
        }),
      {
        title: "Couldn’t update Resources access",
        error: (error) => `${errorMessage(error)} The change was undone.`,
        onSuccess: (result) => {
          if (result.row) {
            const saved = result.row;
            setRows((current) => (current ? replaceResourceLibraryRow(current, saved) : current));
          }
        },
        onError: () => {
          setRows((current) => (current ? replaceResourceLibraryRow(current, row) : current));
        },
      },
    );
  }

  const summary = rows ? summarizeResourceLibraryAccess(rows) : "";

  return (
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs items={[{ label: "Resources", to: routeBase }, { label: "AI access" }]} />

      <div className="mt-5 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Bot size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Choose what each AI employee may do across the Resources library. Every AI employee
            starts at Read + write. Members use Resources as usual &mdash; this only governs what AI
            employees can do through their tools.
          </p>
        </div>
      </div>

      {/* The two levels, narrowest first; the wider one includes the narrower. */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {RESOURCE_LIBRARY_LEVELS.map((level, index) => (
          <div
            key={level.value}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " +
                  LEVEL_STYLES[level.value].chip
                }
              >
                {LEVEL_ICONS[level.value]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {level.label}
                  {level.value === DEFAULT_RESOURCE_LIBRARY_LEVEL && (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Default
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {level.tagline}
                </div>
              </div>
            </div>
            <p className="mt-2.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {level.hint}
            </p>
            {index > 0 && (
              <div className="mt-2.5 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <Check size={11} /> Includes {RESOURCE_LIBRARY_LEVELS[index - 1].label}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
        <Info size={15} className="mt-0.5 shrink-0 text-slate-400" />
        <p>
          Read only overrides each Resource&apos;s Share settings: the employee cannot edit or delete
          a Resource even where it was given Can edit or Can delete. Those settings are kept, and
          apply again as soon as you switch the employee back to Read + write.
        </p>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              AI employees
            </h2>
            {!canManage && (
              <p className="mt-0.5 text-xs text-slate-400">
                Only owners and admins can change access.
              </p>
            )}
          </div>
          {summary && (
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 tabular-nums dark:text-slate-500">
              {summary}
            </span>
          )}
        </div>

        {/* A failed refresh keeps the roster on screen; only a first load replaces it. */}
        {loadError && (
          <div className="flex flex-col items-start gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
            <FormError message={loadError} />
            <Button variant="secondary" size="sm" onClick={() => void retry()} loading={retrying}>
              Try again
            </Button>
          </div>
        )}
        {rows === null ? (
          !loadError && (
            <div className="flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Bot size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              No AI employees yet
            </div>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">
              Every AI employee you hire starts at Read + write and appears here.
            </p>
            {canManage && (
              <Link to={`/c/${company.slug}/employees/new`}>
                <Button className="mt-4" size="sm">
                  Hire an AI employee
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <li
                key={row.employee.id}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar
                    name={row.employee.name}
                    src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                    size="sm"
                    kind="ai"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {row.employee.role}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 sm:justify-end">
                  <AccessToggle
                    employeeName={row.employee.name}
                    value={row.accessLevel}
                    disabled={!canManage}
                    onChange={(level) => changeLevel(row, level)}
                  />
                  <Link
                    to={`/c/${company.slug}/employees/${row.employee.slug}/chat`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    aria-label={`Chat with ${row.employee.name}`}
                    title={`Chat with ${row.employee.name}`}
                  >
                    <MessageSquare size={15} />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * A two-option segmented control, as a radio group: the arrow keys move the
 * selection like any other radio group, and only the selected option is in the
 * tab order. Disabled for Members who can see the setting but not change it.
 */
function AccessToggle({
  employeeName,
  value,
  disabled,
  onChange,
}: {
  employeeName: string;
  value: ResourceLibraryAccessLevel;
  disabled: boolean;
  onChange: (level: ResourceLibraryAccessLevel) => void;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const next = (index + step + RESOURCE_LIBRARY_LEVELS.length) % RESOURCE_LIBRARY_LEVELS.length;
    refs.current[next]?.focus();
    onChange(RESOURCE_LIBRARY_LEVELS[next].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={`Resources access for ${employeeName}`}
      className="inline-flex gap-0.5 rounded-lg border border-slate-200 bg-slate-100/70 p-0.5 dark:border-slate-700 dark:bg-slate-800/60"
    >
      {RESOURCE_LIBRARY_LEVELS.map((level, index) => {
        const active = level.value === value;
        return (
          <button
            key={level.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(level.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed " +
              (active
                ? LEVEL_STYLES[level.value].selected
                : "text-slate-400 enabled:hover:text-slate-700 dark:text-slate-500 dark:enabled:hover:text-slate-200") +
              (disabled && !active ? " opacity-60" : "")
            }
          >
            {LEVEL_ICONS[level.value]}
            {level.label}
          </button>
        );
      })}
    </div>
  );
}
