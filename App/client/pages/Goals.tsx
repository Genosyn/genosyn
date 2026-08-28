import React from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  Goal,
  GoalDirection,
  GoalMetricKind,
  GoalStatus,
  Me,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { clsx } from "../components/ui/clsx";
import type { ChartListItem } from "./ExploreLayout";

/**
 * Goals — the measurable objectives AI employees steer toward (M51).
 *
 * A flat company list rendered as a tree: goals nest via `parentGoalId`, and
 * Routines link to one from their Settings tab. Manual goals take reported
 * numbers; chart goals read their current value from an Explore chart, so
 * their rows carry an "auto" hint and a refresh action instead of a report
 * button. Mutations are admin/owner-only — the server enforces it, this page
 * just declines to offer them to plain members.
 */

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  achieved: "Achieved",
  missed: "Missed",
  archived: "Archived",
};

const STATUS_CHIP: Record<GoalStatus, string> = {
  active: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  achieved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  missed: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  archived: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const DIRECTION_LABEL: Record<GoalDirection, string> = {
  increase_to: "Increase to target",
  decrease_to: "Decrease to target",
};

type TreeRow = { goal: Goal; depth: number };

/**
 * Server order, arranged parent-first with children indented beneath. A goal
 * whose parent is somehow absent from the list renders top-level rather than
 * vanishing.
 */
function flattenTree(goals: Goal[]): TreeRow[] {
  const ids = new Set(goals.map((g) => g.id));
  const children = new Map<string, Goal[]>();
  const roots: Goal[] = [];
  for (const goal of goals) {
    if (goal.parentGoalId && ids.has(goal.parentGoalId)) {
      const siblings = children.get(goal.parentGoalId) ?? [];
      siblings.push(goal);
      children.set(goal.parentGoalId, siblings);
    } else {
      roots.push(goal);
    }
  }
  const out: TreeRow[] = [];
  function visit(goal: Goal, depth: number) {
    out.push({ goal, depth });
    for (const child of children.get(goal.id) ?? []) visit(child, depth + 1);
  }
  for (const root of roots) visit(root, 0);
  return out;
}

/** The ids a goal may not have as its parent: itself and everything under it. */
function selfAndDescendants(goals: Goal[], rootId: string): Set<string> {
  const childIds = new Map<string, string[]>();
  for (const goal of goals) {
    if (!goal.parentGoalId) continue;
    const siblings = childIds.get(goal.parentGoalId) ?? [];
    siblings.push(goal.id);
    childIds.set(goal.parentGoalId, siblings);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  for (;;) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const childId of childIds.get(id) ?? []) {
      if (!out.has(childId)) {
        out.add(childId);
        stack.push(childId);
      }
    }
  }
  return out;
}

function formatValue(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString();
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "12 → 50 customers" — what the row prints beside (or instead of) the bar. */
function valueLine(goal: Goal, separator: "→" | "/"): string {
  const current = goal.currentValue === null ? "—" : formatValue(goal.currentValue);
  const target = formatValue(goal.targetValue);
  const unit = goal.unit ? ` ${goal.unit}` : "";
  return `${current} ${separator} ${target}${unit}`;
}

export default function Goals({ company }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<Goal[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  // `goal: null` is the create modal; a goal is the edit modal.
  const [modal, setModal] = React.useState<{ goal: Goal | null } | null>(null);
  const [reporting, setReporting] = React.useState<Goal | null>(null);

  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<Goal[]>(`/api/companies/${company.id}/goals`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the goals"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Live: chart refreshes, another Member's edits, and the server settling a
  // goal as achieved/missed all land on this list without a manual reload.
  useLiveRefetch("goal", reload);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (!cancelled) setEmployees(list);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const employeesById = React.useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );
  const tree = React.useMemo(() => flattenTree(rows ?? []), [rows]);

  const newGoalButton = (
    <Button onClick={() => setModal({ goal: null })}>
      <Plus size={14} /> New goal
    </Button>
  );

  return (
    <div className="page-shell p-8">
      <TopBar
        title="Goals"
        right={
          <div className="flex items-center gap-3">
            {rows !== null && rows.length > 0 && (
              <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                {rows.length === 1 ? "1 goal" : `${rows.length} goals`}
              </span>
            )}
            {canManage && newGoalButton}
          </div>
        }
      />

      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No goals yet"
          description="Goals are the measurable objectives your AI employees steer toward. Give one a target number — reported by hand or read from an Explore chart — and link routines to it from their Settings tab."
          action={canManage ? newGoalButton : undefined}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {tree.map(({ goal, depth }) => (
            <GoalRow
              key={goal.id}
              company={company}
              goal={goal}
              depth={depth}
              owner={goal.ownerEmployeeId ? (employeesById.get(goal.ownerEmployeeId) ?? null) : null}
              canManage={canManage}
              onEdit={(g) => setModal({ goal: g })}
              onReport={(g) => setReporting(g)}
              onChanged={reload}
            />
          ))}
        </ul>
      )}

      {modal && (
        <GoalModal
          key={modal.goal?.id ?? "new"}
          company={company}
          goal={modal.goal}
          goals={rows ?? []}
          employees={employees}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
          }}
        />
      )}

      {reporting && (
        <ReportProgressModal
          key={reporting.id}
          company={company}
          goal={reporting}
          onClose={() => setReporting(null)}
          onSaved={() => {
            setReporting(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────── rows ────────────────────────────────────

function GoalRow({
  company,
  goal,
  depth,
  owner,
  canManage,
  onEdit,
  onReport,
  onChanged,
}: {
  company: Company;
  goal: Goal;
  depth: number;
  owner: Employee | null;
  canManage: boolean;
  onEdit: (goal: Goal) => void;
  onReport: (goal: Goal) => void;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [refreshing, setRefreshing] = React.useState(false);

  const descriptionLine = goal.description.split("\n")[0]?.trim() ?? "";
  const progress = goal.progress === null ? null : Math.min(1, Math.max(0, goal.progress));
  const barColor =
    goal.status === "missed"
      ? "bg-red-500 dark:bg-red-400"
      : goal.met || goal.status === "achieved"
        ? "bg-emerald-500 dark:bg-emerald-400"
        : "bg-indigo-500 dark:bg-indigo-400";

  async function refresh() {
    setRefreshing(true);
    try {
      await api.post(`/api/companies/${company.id}/goals/${goal.id}/refresh`, {});
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Could not refresh the goal" });
    } finally {
      setRefreshing(false);
    }
  }

  async function setStatus(status: GoalStatus) {
    try {
      await api.patch(`/api/companies/${company.id}/goals/${goal.id}`, { status });
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Could not update the goal" });
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: `Delete “${goal.title}”?`,
      message:
        "Sub-goals move up to this goal's parent, and routines pointing at it are unlinked — none of them are deleted.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/goals/${goal.id}`);
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Could not delete the goal" });
    }
  }

  return (
    <li className="px-4 py-3">
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
        // The tree is arbitrarily deep, so the indent has to be computed.
        style={depth > 0 ? { paddingLeft: Math.min(depth, 6) * 24 } : undefined}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={clsx(
              "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              STATUS_CHIP[goal.status],
            )}
          >
            {STATUS_LABEL[goal.status]}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {goal.title}
              </span>
              {goal.metricKind === "chart" && (
                <span
                  className="shrink-0 rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  title="The current value updates automatically from a chart"
                >
                  auto
                </span>
              )}
            </div>
            {descriptionLine && (
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {descriptionLine}
              </div>
            )}
            {owner && (
              <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                Owner: {owner.name}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="w-44">
            {progress !== null ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={clsx("h-full rounded-full", barColor)}
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  {valueLine(goal, "→")}
                </div>
              </>
            ) : (
              <div className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                {valueLine(goal, "/")}
              </div>
            )}
          </div>

          {goal.dueAt && (
            <div
              className={clsx(
                "text-xs tabular-nums",
                goal.status === "missed"
                  ? "text-red-600 dark:text-red-400"
                  : "text-slate-500 dark:text-slate-400",
              )}
            >
              Due {formatDue(goal.dueAt)}
            </div>
          )}

          {canManage && goal.metricKind === "manual" && (
            <Button variant="ghost" size="sm" onClick={() => onReport(goal)}>
              Report progress
            </Button>
          )}
          {canManage && goal.metricKind === "chart" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
              title="Run the chart now and update the current value"
              aria-label={`Refresh ${goal.title}`}
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
            </Button>
          )}

          {canManage && (
            <Menu
              align="right"
              width={200}
              trigger={({ ref, onClick }) => (
                <button
                  ref={ref}
                  onClick={onClick}
                  type="button"
                  aria-label={`Actions for ${goal.title}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                >
                  <MoreHorizontal size={16} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Pencil size={14} />}
                    label="Edit"
                    onSelect={() => {
                      close();
                      onEdit(goal);
                    }}
                  />
                  {goal.status === "archived" ? (
                    <MenuItem
                      icon={<ArchiveRestore size={14} />}
                      label="Reactivate"
                      onSelect={() => {
                        close();
                        void setStatus("active");
                      }}
                    />
                  ) : (
                    <MenuItem
                      icon={<Archive size={14} />}
                      label="Archive"
                      onSelect={() => {
                        close();
                        void setStatus("archived");
                      }}
                    />
                  )}
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Delete"
                    className="text-red-600 dark:text-red-400"
                    onSelect={() => {
                      close();
                      void remove();
                    }}
                  />
                </>
              )}
            </Menu>
          )}
        </div>
      </div>
    </li>
  );
}

// ───────────────────────── create / edit modal ───────────────────────────

function GoalModal({
  company,
  goal,
  goals,
  employees,
  onClose,
  onSaved,
}: {
  company: Company;
  /** Null creates; a goal edits it. */
  goal: Goal | null;
  goals: Goal[];
  employees: Employee[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = React.useState(goal?.title ?? "");
  const [description, setDescription] = React.useState(goal?.description ?? "");
  const [parentGoalId, setParentGoalId] = React.useState(goal?.parentGoalId ?? "");
  const [ownerEmployeeId, setOwnerEmployeeId] = React.useState(goal?.ownerEmployeeId ?? "");
  const [metricKind, setMetricKind] = React.useState<GoalMetricKind>(goal?.metricKind ?? "manual");
  const [chartId, setChartId] = React.useState(goal?.chartId ?? "");
  const [startValue, setStartValue] = React.useState(
    goal?.startValue === null || goal === null ? "" : String(goal.startValue),
  );
  const [targetValue, setTargetValue] = React.useState(goal ? String(goal.targetValue) : "");
  const [currentValue, setCurrentValue] = React.useState(
    goal?.currentValue === null || goal === null ? "" : String(goal.currentValue),
  );
  const [direction, setDirection] = React.useState<GoalDirection>(goal?.direction ?? "increase_to");
  const [unit, setUnit] = React.useState(goal?.unit ?? "");
  const [dueAt, setDueAt] = React.useState(goal?.dueAt ? goal.dueAt.slice(0, 10) : "");
  const [charts, setCharts] = React.useState<ChartListItem[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<ChartListItem[]>(`/api/companies/${company.id}/explore/charts`)
      .then((list) => {
        if (!cancelled) setCharts(list);
      })
      .catch(() => {
        if (!cancelled) setCharts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  // A goal cannot be parented to itself or anything beneath it — the tree
  // would loop.
  const excludedParents = React.useMemo(
    () => (goal ? selfAndDescendants(goals, goal.id) : new Set<string>()),
    [goal, goals],
  );
  const parentOptions = goals.filter((g) => !excludedParents.has(g.id));

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = Number(targetValue);
    if (targetValue.trim() === "" || !Number.isFinite(target)) {
      setError("The target must be a number.");
      return;
    }
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {
      title: title.trim(),
      description,
      parentGoalId: parentGoalId || null,
      ownerEmployeeId: ownerEmployeeId || null,
      metricKind,
      chartId: metricKind === "chart" ? chartId || null : null,
      startValue: startValue.trim() === "" ? null : Number(startValue),
      targetValue: target,
      direction,
      unit: unit.trim(),
      dueAt: dueAt || null,
    };
    // A chart goal's current value belongs to the chart — never send one, or
    // an unrelated edit would wipe the last reading until the next refresh.
    if (metricKind === "manual") {
      body.currentValue = currentValue.trim() === "" ? null : Number(currentValue);
    }
    try {
      if (goal) {
        await api.patch(`/api/companies/${company.id}/goals/${goal.id}`, body);
      } else {
        await api.post(`/api/companies/${company.id}/goals`, body);
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save the goal"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={goal ? `Edit: ${goal.title}` : "New goal"}
      description="A measurable objective your AI employees steer toward."
      size="lg"
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {goal ? "Save changes" : "Create goal"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={error} />

        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reach 50 paying customers"
          required
          autoFocus
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-[80px]"
          placeholder="Why this target, and what counts toward it. Optional."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Parent goal"
            value={parentGoalId}
            onChange={(e) => setParentGoalId(e.target.value)}
          >
            <option value="">None — top level</option>
            {parentOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>

          <Select
            label="Owner"
            value={ownerEmployeeId}
            onChange={(e) => setOwnerEmployeeId(e.target.value)}
          >
            <option value="">No owner</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Metric</span>
          <div className="flex w-fit gap-1 rounded-lg border border-slate-200 p-1 dark:border-slate-700">
            {(
              [
                ["manual", "Manual"],
                ["chart", "From a chart"],
              ] as Array<[GoalMetricKind, string]>
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                onClick={() => setMetricKind(kind)}
                className={clsx(
                  "rounded-md px-3 py-1 text-sm font-medium transition",
                  metricKind === kind
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {metricKind === "manual"
              ? "The current value is reported by hand — from the row here, or by an AI employee."
              : "The current value is read from an Explore chart's latest result, on a daily sweep or on demand."}
          </p>
        </div>

        {metricKind === "chart" && (
          <Select
            label="Chart"
            value={chartId}
            onChange={(e) => setChartId(e.target.value)}
            required
            emptyMessage="No charts yet — create one under Explore"
          >
            <option value="">Choose a chart…</option>
            {(charts ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
        )}

        <div className={clsx("grid gap-4", metricKind === "manual" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <Input
            label="Start value"
            type="number"
            step="any"
            value={startValue}
            onChange={(e) => setStartValue(e.target.value)}
            placeholder="0"
          />
          <Input
            label="Target"
            type="number"
            step="any"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
            required
          />
          {metricKind === "manual" && (
            <Input
              label="Current value"
              type="number"
              step="any"
              value={currentValue}
              onChange={(e) => setCurrentValue(e.target.value)}
            />
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as GoalDirection)}
          >
            {(Object.keys(DIRECTION_LABEL) as GoalDirection[]).map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABEL[d]}
              </option>
            ))}
          </Select>
          <Input
            label="Unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="customers, $, %…"
          />
          <Input
            label="Due date"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── report-progress modal ─────────────────────────

function ReportProgressModal({
  company,
  goal,
  onClose,
  onSaved,
}: {
  company: Company;
  goal: Goal;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState(
    goal.currentValue === null ? "" : String(goal.currentValue),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsed)) {
      setError("Enter the current value as a number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/goals/${goal.id}/progress`, { value: parsed });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not report progress"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Report progress"
      description={`${goal.title} — target ${formatValue(goal.targetValue)}${goal.unit ? ` ${goal.unit}` : ""}.`}
      size="sm"
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={error} />
        <Input
          label={goal.unit ? `Current value (${goal.unit})` : "Current value"}
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          autoFocus
        />
      </div>
    </Modal>
  );
}
