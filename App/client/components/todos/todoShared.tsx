import React from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  CornerDownRight,
  Circle,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
  CircleSlash,
  ListTree,
  Minus,
  Repeat,
  SignalHigh,
  SignalLow,
  SignalMedium,
  User as UserIcon,
} from "lucide-react";

import { Menu, MenuHeader, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { clsx } from "@/components/ui/clsx";
import type {
  Employee,
  Member,
  Project,
  Todo,
  TodoPriority,
  TodoRecurrence,
  TodoStatus,
} from "@/lib/api";

/**
 * The vocabulary every Todo surface speaks: what the statuses and priorities
 * are called and coloured, how an assignee is picked, what an optimistic patch
 * does to a row.
 *
 * It lived inside `pages/ProjectDetail.tsx` while the project board was the
 * only place a Todo was ever shown. Home now opens a Todo where you clicked it
 * rather than sending you to the board, and a second copy of "what does
 * `in_review` look like" is how two surfaces start disagreeing about the same
 * record. Kept apart from `TodoDetail` so the board can import the labels
 * without importing the whole detail panel.
 */

// ───────────────────────── constants / small helpers ─────────────────────────

export const STATUS_ORDER: TodoStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

export const STATUS_LABEL: Record<TodoStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATUS_COLOR: Record<TodoStatus, string> = {
  backlog: "text-slate-400",
  todo: "text-slate-500",
  in_progress: "text-amber-500",
  in_review: "text-violet-500",
  done: "text-emerald-500",
  cancelled: "text-slate-400",
};

export function StatusIcon({ status, size = 14 }: { status: TodoStatus; size?: number }) {
  const Icon = {
    backlog: CircleDashed,
    todo: Circle,
    in_progress: CircleEllipsis,
    in_review: CircleDot,
    done: CircleCheckBig,
    cancelled: CircleSlash,
  }[status];
  return <Icon size={size} className={STATUS_COLOR[status]} />;
}

export const PRIORITY_ORDER: TodoPriority[] = ["urgent", "high", "medium", "low", "none"];
export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
export const PRIORITY_BAR: Record<TodoPriority, string> = {
  none: "bg-slate-200",
  low: "bg-slate-400",
  medium: "bg-amber-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

export function PriorityIcon({ priority, size = 14 }: { priority: TodoPriority; size?: number }) {
  switch (priority) {
    case "urgent":
      return <AlertTriangle size={size} className="text-red-500" />;
    case "high":
      return <SignalHigh size={size} className="text-orange-500" />;
    case "medium":
      return <SignalMedium size={size} className="text-amber-500" />;
    case "low":
      return <SignalLow size={size} className="text-slate-500 dark:text-slate-400" />;
    default:
      return <Minus size={size} className="text-slate-300" />;
  }
}

export const RECURRENCE_ORDER: TodoRecurrence[] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];
export const RECURRENCE_LABEL: Record<TodoRecurrence, string> = {
  none: "Does not repeat",
  daily: "Daily",
  weekdays: "Every weekday",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  yearly: "Yearly",
};
export const RECURRENCE_SHORT: Record<TodoRecurrence, string> = {
  none: "",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function Avatar({
  name,
  size = 22,
  kind = "human",
}: {
  name: string;
  size?: number;
  kind?: "human" | "ai";
}) {
  const palette =
    kind === "ai"
      ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
      : "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200";
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        palette,
      )}
      title={name}
    >
      {kind === "ai" ? <Bot size={Math.round(size * 0.55)} /> : initials(name)}
    </div>
  );
}

/**
 * Client-side reference to an assignee or reviewer. `null` = unset. The picker
 * operates on this; the route layer decides which DB column to write to.
 */
export type AssigneeRef = { kind: "ai"; id: string } | { kind: "human"; id: string } | null;

export function refFromTodo(t: Todo): AssigneeRef {
  if (t.assigneeEmployeeId) return { kind: "ai", id: t.assigneeEmployeeId };
  if (t.assigneeUserId) return { kind: "human", id: t.assigneeUserId };
  return null;
}

export function reviewerRefFromTodo(t: Todo): AssigneeRef {
  if (t.reviewerEmployeeId) return { kind: "ai", id: t.reviewerEmployeeId };
  if (t.reviewerUserId) return { kind: "human", id: t.reviewerUserId };
  return null;
}

export function patchForRef(ref: AssigneeRef): Partial<Todo> {
  if (ref === null) return { assigneeEmployeeId: null, assigneeUserId: null };
  if (ref.kind === "ai") {
    return { assigneeEmployeeId: ref.id, assigneeUserId: null };
  }
  return { assigneeUserId: ref.id, assigneeEmployeeId: null };
}

export function patchForReviewerRef(ref: AssigneeRef): Partial<Todo> {
  if (ref === null) return { reviewerEmployeeId: null, reviewerUserId: null };
  if (ref.kind === "ai") {
    return { reviewerEmployeeId: ref.id, reviewerUserId: null };
  }
  return { reviewerUserId: ref.id, reviewerEmployeeId: null };
}

export function optimisticTodo(
  todo: Todo,
  patch: Partial<Todo>,
  employees: Employee[],
  members: Member[],
): Todo {
  const next = { ...todo, ...patch, updatedAt: new Date().toISOString() };
  if ("assigneeEmployeeId" in patch || "assigneeUserId" in patch) {
    const employee = employees.find((item) => item.id === next.assigneeEmployeeId);
    const member = members.find((item) => item.userId === next.assigneeUserId);
    next.assignee = employee
      ? {
          kind: "ai",
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          role: employee.role,
        }
      : member
        ? {
            kind: "human",
            id: member.userId,
            name: member.name ?? member.email ?? "Member",
            email: member.email,
          }
        : null;
  }
  if ("reviewerEmployeeId" in patch || "reviewerUserId" in patch) {
    const employee = employees.find((item) => item.id === next.reviewerEmployeeId);
    const member = members.find((item) => item.userId === next.reviewerUserId);
    next.reviewer = employee
      ? {
          kind: "ai",
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          role: employee.role,
        }
      : member
        ? {
            kind: "human",
            id: member.userId,
            name: member.name ?? member.email ?? "Member",
            email: member.email,
          }
        : null;
  }
  return next;
}

export function formatDue(iso: string | null): { label: string; cls: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const ms = d.getTime() - now.getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  const month = d.toLocaleString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { label: month, cls: "text-red-600" };
  if (days === 0) return { label: "Today", cls: "text-amber-600" };
  if (days === 1) return { label: "Tomorrow", cls: "text-amber-600" };
  if (days < 7) return { label: month, cls: "text-slate-600" };
  return { label: month, cls: "text-slate-500" };
}

// ───────────────────────── pickers (custom popover menus) ────────────────────

export function StatusPicker({
  value,
  onChange,
  compact,
  disabled,
}: {
  value: TodoStatus;
  onChange: (v: TodoStatus) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={`Status: ${STATUS_LABEL[value]}`}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-left text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            disabled
              ? "cursor-default"
              : open
                ? "bg-slate-100 dark:bg-slate-800"
                : "hover:bg-slate-100 dark:hover:bg-slate-800",
          )}
        >
          <StatusIcon status={value} />
          {!compact && (
            <span className="text-slate-700 dark:text-slate-200">{STATUS_LABEL[value]}</span>
          )}
        </button>
      )}
      width={200}
    >
      {(close) => (
        <>
          <MenuHeader>Status</MenuHeader>
          {STATUS_ORDER.map((s) => (
            <MenuItem
              key={s}
              active={s === value}
              icon={<StatusIcon status={s} />}
              label={STATUS_LABEL[s]}
              onSelect={() => {
                onChange(s);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

export function PriorityPicker({
  value,
  onChange,
  compact,
  disabled,
}: {
  value: TodoPriority;
  onChange: (v: TodoPriority) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={`Priority: ${PRIORITY_LABEL[value]}`}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-left text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            disabled
              ? "cursor-default"
              : open
                ? "bg-slate-100 dark:bg-slate-800"
                : "hover:bg-slate-100 dark:hover:bg-slate-800",
          )}
        >
          <PriorityIcon priority={value} />
          {!compact && value !== "none" && (
            <span className="text-slate-700 dark:text-slate-200">{PRIORITY_LABEL[value]}</span>
          )}
        </button>
      )}
      width={200}
    >
      {(close) => (
        <>
          <MenuHeader>Priority</MenuHeader>
          {PRIORITY_ORDER.map((p) => (
            <MenuItem
              key={p}
              active={p === value}
              icon={<PriorityIcon priority={p} />}
              label={PRIORITY_LABEL[p]}
              onSelect={() => {
                onChange(p);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

export function AssigneePicker({
  value,
  employees,
  members,
  onChange,
  compact,
  role = "assignee",
  disabled,
}: {
  value: AssigneeRef;
  employees: Employee[];
  members: Member[];
  onChange: (ref: AssigneeRef) => void;
  compact?: boolean;
  role?: "assignee" | "reviewer";
  disabled?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const unsetLabel = role === "reviewer" ? "No reviewer" : "Unassigned";
  const unsetTitle = role === "reviewer" ? "No reviewer" : "Unassigned";
  const header = role === "reviewer" ? "Reviewer" : "Assignee";
  const currentPrefix = role === "reviewer" ? "Reviewer" : "Assigned";
  const current = React.useMemo(() => {
    if (!value) return null;
    if (value.kind === "ai") {
      const e = employees.find((x) => x.id === value.id);
      return e ? { kind: "ai" as const, id: e.id, name: e.name, role: e.role } : null;
    }
    const m = members.find((x) => x.userId === value.id);
    return m
      ? {
          kind: "human" as const,
          id: m.userId,
          name: m.name ?? m.email ?? "Member",
          role: m.role,
        }
      : null;
  }, [value, employees, members]);

  const q = query.trim().toLowerCase();
  const matchEmp = (e: Employee) => !q || e.name.toLowerCase().includes(q);
  const matchMem = (m: Member) =>
    !q || (m.name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q);

  const filteredEmps = employees.filter(matchEmp);
  const filteredMems = members.filter(matchMem);
  const totalMatches = filteredEmps.length + filteredMems.length;

  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={current ? `${currentPrefix}: ${current.name}` : unsetTitle}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            disabled
              ? "cursor-default"
              : open
                ? "bg-slate-100 dark:bg-slate-800"
                : "hover:bg-slate-100 dark:hover:bg-slate-800",
          )}
        >
          {current ? (
            <Avatar name={current.name} size={compact ? 20 : 22} kind={current.kind} />
          ) : (
            <div
              className="flex items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 dark:border-slate-600 dark:text-slate-500"
              style={{ width: compact ? 20 : 22, height: compact ? 20 : 22 }}
            >
              <UserIcon size={compact ? 10 : 12} />
            </div>
          )}
          {!compact && (
            <span className="truncate text-slate-700 dark:text-slate-200">
              {current ? current.name : unsetLabel}
            </span>
          )}
        </button>
      )}
      onOpenChange={(o) => {
        if (!o) setQuery("");
      }}
      width={260}
    >
      {(close) => (
        <>
          <MenuHeader>{header}</MenuHeader>
          <div className="p-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people or AI employees…"
              className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-sm placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none dark:bg-slate-900 dark:border-slate-700"
            />
          </div>
          <MenuSeparator />
          <MenuItem
            active={value === null}
            icon={
              <div className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 dark:border-slate-600 dark:text-slate-500">
                <UserIcon size={10} />
              </div>
            }
            label={unsetLabel}
            onSelect={() => {
              onChange(null);
              close();
            }}
          />
          {filteredMems.length > 0 && (
            <>
              <MenuSeparator />
              <MenuHeader>People</MenuHeader>
              {filteredMems.map((m) => {
                const name = m.name ?? m.email ?? "Member";
                const active = value?.kind === "human" && value.id === m.userId;
                return (
                  <MenuItem
                    key={m.userId}
                    active={active}
                    icon={<Avatar name={name} size={20} kind="human" />}
                    label={
                      <span className="flex flex-col">
                        <span className="truncate text-sm">{name}</span>
                        <span className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {m.email && m.email !== name ? m.email : m.role}
                        </span>
                      </span>
                    }
                    onSelect={() => {
                      onChange({ kind: "human", id: m.userId });
                      close();
                    }}
                  />
                );
              })}
            </>
          )}
          {filteredEmps.length > 0 && (
            <>
              <MenuSeparator />
              <MenuHeader>AI employees</MenuHeader>
              {filteredEmps.map((e) => {
                const active = value?.kind === "ai" && value.id === e.id;
                return (
                  <MenuItem
                    key={e.id}
                    active={active}
                    icon={<Avatar name={e.name} size={20} kind="ai" />}
                    label={
                      <span className="flex flex-col">
                        <span className="truncate text-sm">{e.name}</span>
                        <span className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {e.role}
                        </span>
                      </span>
                    }
                    onSelect={() => {
                      onChange({ kind: "ai", id: e.id });
                      close();
                    }}
                  />
                );
              })}
            </>
          )}
          {totalMatches === 0 && (
            <div className="px-2 py-3 text-center text-xs text-slate-400 dark:text-slate-500">
              {employees.length + members.length === 0
                ? "No people or AI employees yet"
                : "No matches"}
            </div>
          )}
        </>
      )}
    </Menu>
  );
}

export function RecurrencePicker({
  value,
  onChange,
  compact,
  disabled,
}: {
  value: TodoRecurrence;
  onChange: (v: TodoRecurrence) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const active = value !== "none";
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={active ? `Repeats ${RECURRENCE_LABEL[value].toLowerCase()}` : "Does not repeat"}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-left text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            disabled
              ? clsx(
                  "cursor-default",
                  active
                    ? "text-indigo-600 dark:text-indigo-300"
                    : "text-slate-500 dark:text-slate-400",
                )
              : open
                ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : active
                  ? "text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
                  : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
          )}
        >
          <Repeat size={compact ? 12 : 13} />
          {!compact && active && (
            <span className="text-slate-700 dark:text-slate-200">{RECURRENCE_SHORT[value]}</span>
          )}
        </button>
      )}
      width={220}
    >
      {(close) => (
        <>
          <MenuHeader>Repeat</MenuHeader>
          {RECURRENCE_ORDER.map((r) => (
            <MenuItem
              key={r}
              active={r === value}
              icon={
                r === value ? (
                  <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                ) : r === "none" ? (
                  <Minus size={12} className="text-slate-400 dark:text-slate-500" />
                ) : (
                  <Repeat size={12} className="text-slate-400 dark:text-slate-500" />
                )
              }
              label={RECURRENCE_LABEL[r]}
              onSelect={() => {
                onChange(r);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

// ───────────────────────── subtask helpers ────────────────────────────────────

export type ChildStats = { done: number; total: number };

/** Per-parent progress over its subtasks. Done + cancelled count as closed. */
export function childStatsFor(todos: Todo[]): Map<string, ChildStats> {
  const map = new Map<string, ChildStats>();
  for (const t of todos) {
    if (!t.parentTodoId) continue;
    const s = map.get(t.parentTodoId) ?? { done: 0, total: 0 };
    s.total += 1;
    if (t.status === "done" || t.status === "cancelled") s.done += 1;
    map.set(t.parentTodoId, s);
  }
  return map;
}

/** `↳ KEY-12` chip rendered on subtask rows; clicking peeks the parent. */
export function ParentChip({
  parent,
  project,
  onOpen,
}: {
  parent: Todo;
  project: Project;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
      title={`Sub-task of ${project.key}-${parent.number}: ${parent.title}`}
    >
      <CornerDownRight size={10} />
      {project.key}-{parent.number}
    </button>
  );
}

/** `⊟ 2/5` chip rendered on rows that have subtasks. */
export function SubtaskCountChip({ stats }: { stats: ChildStats }) {
  const allDone = stats.done === stats.total;
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        allDone
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
      )}
      title={`${stats.done} of ${stats.total} subtasks done`}
    >
      <ListTree size={10} />
      {stats.done}/{stats.total}
    </span>
  );
}
