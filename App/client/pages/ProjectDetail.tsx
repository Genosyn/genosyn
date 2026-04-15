import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Circle,
  CircleDot,
  CircleCheckBig,
  CircleDashed,
  CircleSlash,
  CircleEllipsis,
  LayoutList,
  Columns3,
  Plus,
  Trash2,
  Settings as SettingsIcon,
  AlertTriangle,
  SignalHigh,
  SignalMedium,
  SignalLow,
  Minus,
  X,
  Filter,
  Check,
  Calendar,
  User as UserIcon,
  AtSign,
  MessageSquare,
  Send,
  Bot,
  Sparkles,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  Project,
  Todo,
  TodoComment,
  TodoPriority,
  TodoStatus,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs } from "../components/AppShell";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useToast } from "../components/ui/Toast";
import { useTasks } from "./TasksLayout";
import { clsx } from "../components/ui/clsx";

type ProjectTodos = { project: Project; todos: Todo[] };

// ───────────────────────── constants / small helpers ─────────────────────────

const STATUS_ORDER: TodoStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

const STATUS_LABEL: Record<TodoStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  backlog: "text-slate-400",
  todo: "text-slate-500",
  in_progress: "text-amber-500",
  in_review: "text-violet-500",
  done: "text-emerald-500",
  cancelled: "text-slate-400",
};

function StatusIcon({ status, size = 14 }: { status: TodoStatus; size?: number }) {
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

const PRIORITY_ORDER: TodoPriority[] = ["urgent", "high", "medium", "low", "none"];
const PRIORITY_LABEL: Record<TodoPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
const PRIORITY_BAR: Record<TodoPriority, string> = {
  none: "bg-slate-200",
  low: "bg-slate-400",
  medium: "bg-amber-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

function PriorityIcon({ priority, size = 14 }: { priority: TodoPriority; size?: number }) {
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

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className="flex items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 dark:text-indigo-300"
      title={name}
    >
      {initials(name)}
    </div>
  );
}

function formatDue(iso: string | null): { label: string; cls: string } | null {
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

function StatusPicker({
  value,
  onChange,
  compact,
}: {
  value: TodoStatus;
  onChange: (v: TodoStatus) => void;
  compact?: boolean;
}) {
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={`Status: ${STATUS_LABEL[value]}`}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-left text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            open ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-100 dark:hover:bg-slate-800",
          )}
        >
          <StatusIcon status={value} />
          {!compact && <span className="text-slate-700 dark:text-slate-200">{STATUS_LABEL[value]}</span>}
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

function PriorityPicker({
  value,
  onChange,
  compact,
}: {
  value: TodoPriority;
  onChange: (v: TodoPriority) => void;
  compact?: boolean;
}) {
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={`Priority: ${PRIORITY_LABEL[value]}`}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-left text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            open ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-100 dark:hover:bg-slate-800",
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

function AssigneePicker({
  value,
  employees,
  onChange,
  compact,
}: {
  value: string | null;
  employees: Employee[];
  onChange: (id: string | null) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const current = employees.find((e) => e.id === value) ?? null;
  const filtered = query
    ? employees.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
    : employees;

  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={current ? `Assigned: ${current.name}` : "Unassigned"}
          className={clsx(
            "flex items-center gap-1.5 rounded-md text-xs",
            compact ? "p-0.5" : "px-1.5 py-1",
            open ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-100 dark:hover:bg-slate-800",
          )}
        >
          {current ? (
            <Avatar name={current.name} size={compact ? 20 : 22} />
          ) : (
            <div
              className="flex items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 dark:border-slate-600 dark:text-slate-500"
              style={{ width: compact ? 20 : 22, height: compact ? 20 : 22 }}
            >
              <UserIcon size={compact ? 10 : 12} />
            </div>
          )}
          {!compact && (
            <span className="text-slate-700 dark:text-slate-200">
              {current ? current.name : "Unassigned"}
            </span>
          )}
        </button>
      )}
      onOpenChange={(o) => {
        if (!o) setQuery("");
      }}
      width={240}
    >
      {(close) => (
        <>
          <div className="p-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
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
            label="Unassigned"
            onSelect={() => {
              onChange(null);
              close();
            }}
          />
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-slate-400 dark:text-slate-500">
              No employees
            </div>
          ) : (
            filtered.map((e) => (
              <MenuItem
                key={e.id}
                active={e.id === value}
                icon={<Avatar name={e.name} size={20} />}
                label={
                  <span className="flex flex-col">
                    <span className="truncate text-sm">{e.name}</span>
                    <span className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {e.role}
                    </span>
                  </span>
                }
                onSelect={() => {
                  onChange(e.id);
                  close();
                }}
              />
            ))
          )}
        </>
      )}
    </Menu>
  );
}

// ───────────────────────── filter model ──────────────────────────────────────

type Filters = {
  statuses: Set<TodoStatus>;
  priorities: Set<TodoPriority>;
  assignees: Set<string | "unassigned">;
};

function emptyFilters(): Filters {
  return { statuses: new Set(), priorities: new Set(), assignees: new Set() };
}

function applyFilters(todos: Todo[], f: Filters): Todo[] {
  return todos.filter((t) => {
    if (f.statuses.size && !f.statuses.has(t.status)) return false;
    if (f.priorities.size && !f.priorities.has(t.priority)) return false;
    if (f.assignees.size) {
      const key = t.assigneeEmployeeId ?? "unassigned";
      if (!f.assignees.has(key)) return false;
    }
    return true;
  });
}

function countActive(f: Filters): number {
  return f.statuses.size + f.priorities.size + f.assignees.size;
}

// ───────────────────────── main page ─────────────────────────────────────────

export default function ProjectDetail({ company }: { company: Company }) {
  const { pSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { reload: reloadProjects } = useTasks();

  const [data, setData] = React.useState<ProjectTodos | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [view, setView] = React.useState<"list" | "board">("list");
  const [peekId, setPeekId] = React.useState<string | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [filters, setFilters] = React.useState<Filters>(emptyFilters);
  const addInputRef = React.useRef<HTMLInputElement>(null);

  const reload = React.useCallback(async () => {
    if (!pSlug) return;
    try {
      const d = await api.get<ProjectTodos>(
        `/api/companies/${company.id}/projects/${pSlug}/todos`,
      );
      setData(d);
    } catch (err) {
      toast((err as Error).message, "error");
      navigate(`/c/${company.slug}/tasks`);
    }
  }, [company.id, company.slug, pSlug, navigate, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  React.useEffect(() => {
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [company.id]);

  // Reset peek when navigating away from the project.
  React.useEffect(() => {
    setPeekId(null);
    setFilters(emptyFilters());
  }, [pSlug]);

  // Global `c` shortcut to jump to the new-todo input, `/` for filter focus.
  // Ignore when any other input is focused so typing stays normal.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "c") {
        e.preventDefault();
        addInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (peekId) setPeekId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peekId]);

  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { project, todos } = data;
  const visibleTodos = applyFilters(todos, filters);
  const peekTodo = peekId ? todos.find((t) => t.id === peekId) ?? null : null;

  async function patchTodo(t: Todo, patch: Partial<Todo>) {
    try {
      const updated = await api.patch<Todo>(
        `/api/companies/${company.id}/todos/${t.id}`,
        patch,
      );
      setData((d) =>
        d
          ? { ...d, todos: d.todos.map((x) => (x.id === updated.id ? updated : x)) }
          : d,
      );
      reloadProjects();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteTodo(t: Todo) {
    if (!confirm(`Delete "${t.title}"?`)) return;
    try {
      await api.del(`/api/companies/${company.id}/todos/${t.id}`);
      setData((d) => (d ? { ...d, todos: d.todos.filter((x) => x.id !== t.id) } : d));
      if (peekId === t.id) setPeekId(null);
      reloadProjects();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const summary = summarize(todos);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
          <div className="min-w-0 flex-1">
            <Breadcrumbs
              items={[
                { label: "Tasks", to: `/c/${company.slug}/tasks` },
                { label: project.name },
              ]}
            />
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {project.key}
              </span>
              <h1 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
                {project.name}
              </h1>
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {summary.open} open · {summary.done} done
              </span>
            </div>
            {project.description && (
              <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">
                {project.description}
              </p>
            )}
          </div>
          <ViewToggle value={view} onChange={setView} />
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Project settings"
          >
            <SettingsIcon size={16} />
          </button>
        </div>

        {/* Filter bar */}
        <FilterBar
          filters={filters}
          setFilters={setFilters}
          employees={employees}
          todos={todos}
        />

        {/* New todo row */}
        <NewTodoRow
          companyId={company.id}
          projectSlug={project.slug}
          employees={employees}
          inputRef={addInputRef}
          onCreated={(t) => {
            setData((d) => (d ? { ...d, todos: [...d.todos, t] } : d));
            reloadProjects();
          }}
        />

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {view === "list" ? (
            <ListView
              todos={visibleTodos}
              totalBeforeFilter={todos.length}
              project={project}
              employees={employees}
              activePeekId={peekId}
              onOpen={setPeekId}
              onPatch={patchTodo}
              onDelete={deleteTodo}
              onRename={(t, title) => patchTodo(t, { title })}
            />
          ) : (
            <BoardView
              todos={visibleTodos}
              project={project}
              onOpen={setPeekId}
              activePeekId={peekId}
              onPatch={patchTodo}
            />
          )}
        </div>
      </div>

      {peekTodo && (
        <TodoPeek
          key={peekTodo.id}
          todo={peekTodo}
          project={project}
          employees={employees}
          companyId={company.id}
          onClose={() => setPeekId(null)}
          onPatch={(patch) => patchTodo(peekTodo, patch)}
          onDelete={() => deleteTodo(peekTodo)}
        />
      )}

      {showSettings && (
        <ProjectSettingsModal
          company={company}
          project={project}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            await reload();
            await reloadProjects();
          }}
          onDeleted={() => {
            setShowSettings(false);
            reloadProjects();
            navigate(`/c/${company.slug}/tasks`);
          }}
        />
      )}
    </div>
  );
}

function summarize(todos: Todo[]) {
  let open = 0;
  let done = 0;
  for (const t of todos) {
    if (t.status === "done") done += 1;
    else if (t.status !== "cancelled") open += 1;
  }
  return { open, done };
}

// ───────────────────────── view toggle ───────────────────────────────────────

function ViewToggle({
  value,
  onChange,
}: {
  value: "list" | "board";
  onChange: (v: "list" | "board") => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 dark:bg-slate-900 dark:border-slate-700">
      {(
        [
          { v: "list" as const, label: "List", Icon: LayoutList },
          { v: "board" as const, label: "Board", Icon: Columns3 },
        ]
      ).map(({ v, label, Icon }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={clsx(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
            value === v
              ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
          )}
        >
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── filter bar ────────────────────────────────────────

function FilterBar({
  filters,
  setFilters,
  employees,
  todos,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  employees: Employee[];
  todos: Todo[];
}) {
  function toggleStatus(s: TodoStatus) {
    const next = new Set(filters.statuses);
    next.has(s) ? next.delete(s) : next.add(s);
    setFilters({ ...filters, statuses: next });
  }
  function togglePriority(p: TodoPriority) {
    const next = new Set(filters.priorities);
    next.has(p) ? next.delete(p) : next.add(p);
    setFilters({ ...filters, priorities: next });
  }
  function toggleAssignee(id: string | "unassigned") {
    const next = new Set(filters.assignees);
    next.has(id) ? next.delete(id) : next.add(id);
    setFilters({ ...filters, assignees: next });
  }

  const assigneeIds = new Set(
    todos.map((t) => t.assigneeEmployeeId ?? "unassigned"),
  );
  const active = countActive(filters);

  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-2 dark:bg-slate-900 dark:border-slate-700">
      <Filter size={14} className="text-slate-400 dark:text-slate-500" />
      <FilterChip
        label="Status"
        count={filters.statuses.size}
        render={(close) => (
          <>
            <MenuHeader>Status</MenuHeader>
            {STATUS_ORDER.map((s) => (
              <MenuItem
                key={s}
                active={filters.statuses.has(s)}
                icon={
                  filters.statuses.has(s) ? (
                    <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                  ) : (
                    <StatusIcon status={s} />
                  )
                }
                label={STATUS_LABEL[s]}
                onSelect={() => toggleStatus(s)}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              label="Clear"
              onSelect={() => {
                setFilters({ ...filters, statuses: new Set() });
                close();
              }}
            />
          </>
        )}
      />
      <FilterChip
        label="Priority"
        count={filters.priorities.size}
        render={(close) => (
          <>
            <MenuHeader>Priority</MenuHeader>
            {PRIORITY_ORDER.map((p) => (
              <MenuItem
                key={p}
                active={filters.priorities.has(p)}
                icon={
                  filters.priorities.has(p) ? (
                    <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                  ) : (
                    <PriorityIcon priority={p} />
                  )
                }
                label={PRIORITY_LABEL[p]}
                onSelect={() => togglePriority(p)}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              label="Clear"
              onSelect={() => {
                setFilters({ ...filters, priorities: new Set() });
                close();
              }}
            />
          </>
        )}
      />
      <FilterChip
        label="Assignee"
        count={filters.assignees.size}
        render={(close) => (
          <>
            <MenuHeader>Assignee</MenuHeader>
            <MenuItem
              active={filters.assignees.has("unassigned")}
              icon={
                filters.assignees.has("unassigned") ? (
                  <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                ) : (
                  <UserIcon size={12} className="text-slate-400 dark:text-slate-500" />
                )
              }
              label="Unassigned"
              onSelect={() => toggleAssignee("unassigned")}
            />
            {employees
              .filter((e) => assigneeIds.has(e.id) || filters.assignees.has(e.id))
              .map((e) => (
                <MenuItem
                  key={e.id}
                  active={filters.assignees.has(e.id)}
                  icon={
                    filters.assignees.has(e.id) ? (
                      <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                    ) : (
                      <Avatar name={e.name} size={20} />
                    )
                  }
                  label={e.name}
                  onSelect={() => toggleAssignee(e.id)}
                />
              ))}
            <MenuSeparator />
            <MenuItem
              label="Clear"
              onSelect={() => {
                setFilters({ ...filters, assignees: new Set() });
                close();
              }}
            />
          </>
        )}
      />
      {active > 0 && (
        <button
          onClick={() => setFilters(emptyFilters())}
          className="ml-auto text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  render,
}: {
  label: string;
  count: number;
  render: (close: () => void) => React.ReactNode;
}) {
  return (
    <Menu
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            count > 0 || open
              ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:border-indigo-800 dark:text-indigo-300"
              : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
          )}
        >
          <span>{label}</span>
          {count > 0 && (
            <span className="rounded bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
              {count}
            </span>
          )}
        </button>
      )}
      width={220}
    >
      {render}
    </Menu>
  );
}

// ───────────────────────── new todo row ──────────────────────────────────────

function NewTodoRow({
  companyId,
  projectSlug,
  employees,
  inputRef,
  onCreated,
}: {
  companyId: string;
  projectSlug: string;
  employees: Employee[];
  inputRef: React.RefObject<HTMLInputElement>;
  onCreated: (t: Todo) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState<TodoPriority>("none");
  const [status, setStatus] = React.useState<TodoStatus>("todo");
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const t = await api.post<Todo>(
        `/api/companies/${companyId}/projects/${projectSlug}/todos`,
        {
          title: title.trim(),
          priority,
          status,
          assigneeEmployeeId: assignee,
        },
      );
      onCreated(t);
      setTitle("");
      setPriority("none");
      setAssignee(null);
      setStatus("todo");
      inputRef.current?.focus();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-2 dark:bg-slate-900 dark:border-slate-700"
    >
      <Plus size={14} className="text-slate-400 dark:text-slate-500" />
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a todo… (c)"
        className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
      />
      <StatusPicker value={status} onChange={setStatus} />
      <PriorityPicker value={priority} onChange={setPriority} />
      <AssigneePicker value={assignee} employees={employees} onChange={setAssignee} />
      <Button type="submit" size="sm" disabled={!title.trim() || busy}>
        {busy ? "…" : "Add"}
      </Button>
    </form>
  );
}

// ───────────────────────── list view ─────────────────────────────────────────

function ListView({
  todos,
  totalBeforeFilter,
  project,
  employees,
  activePeekId,
  onOpen,
  onPatch,
  onDelete,
  onRename,
}: {
  todos: Todo[];
  totalBeforeFilter: number;
  project: Project;
  employees: Employee[];
  activePeekId: string | null;
  onOpen: (id: string) => void;
  onPatch: (t: Todo, patch: Partial<Todo>) => void;
  onDelete: (t: Todo) => void;
  onRename: (t: Todo, title: string) => void;
}) {
  const byStatus = new Map<TodoStatus, Todo[]>();
  STATUS_ORDER.forEach((s) => byStatus.set(s, []));
  for (const t of todos) byStatus.get(t.status)?.push(t);

  if (totalBeforeFilter === 0) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No todos yet — press{" "}
        <kbd className="mx-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300">
          c
        </kbd>{" "}
        or type above to add one.
      </div>
    );
  }
  if (todos.length === 0) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No todos match the current filters.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {STATUS_ORDER.map((status) => {
        const items = byStatus.get(status)!;
        if (items.length === 0) return null;
        return (
          <div key={status} className="border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2 bg-slate-50 px-6 py-1.5 text-xs font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <StatusIcon status={status} />
              <span>{STATUS_LABEL[status]}</span>
              <span className="text-slate-400 dark:text-slate-500">{items.length}</span>
            </div>
            <ul>
              {items.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  project={project}
                  employees={employees}
                  active={activePeekId === t.id}
                  onOpen={() => onOpen(t.id)}
                  onPatch={(patch) => onPatch(t, patch)}
                  onDelete={() => onDelete(t)}
                  onRename={(title) => onRename(t, title)}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TodoRow({
  todo,
  project,
  employees,
  active,
  onOpen,
  onPatch,
  onDelete,
  onRename,
}: {
  todo: Todo;
  project: Project;
  employees: Employee[];
  active: boolean;
  onOpen: () => void;
  onPatch: (patch: Partial<Todo>) => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(todo.title);
  React.useEffect(() => setDraft(todo.title), [todo.title]);
  const due = formatDue(todo.dueAt);

  function commit() {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== todo.title) onRename(t);
    else setDraft(todo.title);
  }

  return (
    <li
      onClick={() => {
        if (!editing) onOpen();
      }}
      className={clsx(
        "group flex items-center gap-2 border-b border-slate-100 px-6 py-1.5 last:border-b-0 dark:border-slate-800",
        active ? "bg-indigo-50/40" : "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800",
      )}
    >
      <StatusPicker
        value={todo.status}
        onChange={(s) => onPatch({ status: s })}
        compact
      />
      <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
        {project.key}-{todo.number}
      </span>
      <PriorityPicker
        value={todo.priority}
        onChange={(p) => onPatch({ priority: p })}
        compact
      />
      <div className="min-w-0 flex-1" onClick={(e) => editing && e.stopPropagation()}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(todo.title);
                setEditing(false);
              }
            }}
            className="w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-sm text-slate-900 focus:outline-none dark:bg-slate-900 dark:text-slate-100"
          />
        ) : (
          <button
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className={clsx(
              "truncate text-left text-sm",
              todo.status === "done" || todo.status === "cancelled"
                ? "text-slate-400 line-through dark:text-slate-500"
                : "text-slate-900 dark:text-slate-100",
            )}
          >
            {todo.title}
          </button>
        )}
      </div>
      {due && (
        <span
          className={clsx(
            "flex shrink-0 items-center gap-1 text-xs",
            due.cls,
          )}
          title={todo.dueAt ?? undefined}
        >
          <Calendar size={12} /> {due.label}
        </span>
      )}
      <AssigneePicker
        value={todo.assigneeEmployeeId}
        employees={employees}
        onChange={(id) => onPatch({ assigneeEmployeeId: id })}
        compact
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="rounded p-1 text-slate-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:text-slate-500"
        title="Delete"
      >
        <Trash2 size={13} />
      </button>
    </li>
  );
}

// ───────────────────────── board view ────────────────────────────────────────

const BOARD_COLUMNS: TodoStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

function BoardView({
  todos,
  project,
  onOpen,
  activePeekId,
  onPatch,
}: {
  todos: Todo[];
  project: Project;
  onOpen: (id: string) => void;
  activePeekId: string | null;
  onPatch: (t: Todo, patch: Partial<Todo>) => void;
}) {
  const byStatus = new Map<TodoStatus, Todo[]>();
  BOARD_COLUMNS.forEach((s) => byStatus.set(s, []));
  for (const t of todos) {
    if (byStatus.has(t.status)) byStatus.get(t.status)!.push(t);
  }

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overCol, setOverCol] = React.useState<TodoStatus | null>(null);

  return (
    <div className="flex h-full min-w-max gap-3 p-4">
      {BOARD_COLUMNS.map((status) => {
        const items = byStatus.get(status)!;
        const isOver = overCol === status;
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              if (overCol !== status) setOverCol(status);
            }}
            onDragLeave={() => setOverCol((c) => (c === status ? null : c))}
            onDrop={() => {
              setOverCol(null);
              if (!dragId) return;
              const t = todos.find((x) => x.id === dragId);
              if (t && t.status !== status) onPatch(t, { status });
              setDragId(null);
            }}
            className={clsx(
              "flex w-72 shrink-0 flex-col rounded-lg border bg-slate-50 transition-colors dark:bg-slate-900",
              isOver ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200 dark:border-slate-700",
            )}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">
              <StatusIcon status={status} />
              <span>{STATUS_LABEL[status]}</span>
              <span className="ml-auto text-slate-400 dark:text-slate-500">{items.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {items.length === 0 ? (
                <div className="rounded border border-dashed border-slate-200 py-6 text-center text-[11px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
                  Drop here
                </div>
              ) : (
                items.map((t) => (
                  <BoardCard
                    key={t.id}
                    todo={t}
                    project={project}
                    active={activePeekId === t.id}
                    onClick={() => onOpen(t.id)}
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardCard({
  todo,
  project,
  active,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  todo: Todo;
  project: Project;
  active: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const due = formatDue(todo.dueAt);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={clsx(
        "group relative cursor-pointer overflow-hidden rounded-lg border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow dark:bg-slate-900",
        active ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200 dark:border-slate-700",
      )}
    >
      <div
        className={clsx("absolute left-0 top-0 h-full w-0.5", PRIORITY_BAR[todo.priority])}
      />
      <div className="p-3 pl-3.5">
        <div className="flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
          <span className="font-mono">
            {project.key}-{todo.number}
          </span>
          <PriorityIcon priority={todo.priority} size={11} />
        </div>
        <div className="mt-1 line-clamp-3 text-sm text-slate-900 dark:text-slate-100">{todo.title}</div>
        <div className="mt-2 flex items-center justify-between">
          {due ? (
            <span className={clsx("flex items-center gap-1 text-[11px]", due.cls)}>
              <Calendar size={11} /> {due.label}
            </span>
          ) : (
            <span />
          )}
          {todo.assignee ? (
            <Avatar name={todo.assignee.name} size={20} />
          ) : (
            <div className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-300 dark:border-slate-600">
              <UserIcon size={10} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── side-panel peek ───────────────────────────────────

function TodoPeek({
  todo,
  project,
  employees,
  companyId,
  onClose,
  onPatch,
  onDelete,
}: {
  todo: Todo;
  project: Project;
  employees: Employee[];
  companyId: string;
  onClose: () => void;
  onPatch: (patch: Partial<Todo>) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = React.useState(todo.title);
  const [desc, setDesc] = React.useState(todo.description);
  const [descDirty, setDescDirty] = React.useState(false);
  React.useEffect(() => {
    setTitle(todo.title);
    setDesc(todo.description);
    setDescDirty(false);
  }, [todo.id, todo.title, todo.description]);

  function commitTitle() {
    const t = title.trim();
    if (t && t !== todo.title) onPatch({ title: t });
    else setTitle(todo.title);
  }
  function commitDesc() {
    if (!descDirty) return;
    onPatch({ description: desc });
    setDescDirty(false);
  }
  const due = todo.dueAt ? todo.dueAt.slice(0, 10) : "";

  return (
    <aside className="flex w-[460px] shrink-0 flex-col border-l border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {project.key}-{todo.number}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {STATUS_LABEL[todo.status]}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full bg-transparent text-lg font-semibold text-slate-900 focus:outline-none dark:text-slate-100"
        />

        <textarea
          value={desc}
          placeholder="Add a description…"
          onChange={(e) => {
            setDesc(e.target.value);
            setDescDirty(true);
          }}
          onBlur={commitDesc}
          rows={6}
          className="mt-3 w-full resize-none rounded-md border border-transparent bg-slate-50 p-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:outline-none dark:bg-slate-900 dark:text-slate-100"
        />

        <div className="mt-6 grid grid-cols-[90px_1fr] items-center gap-y-3 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Status
          </span>
          <div>
            <StatusPicker value={todo.status} onChange={(s) => onPatch({ status: s })} />
          </div>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Priority
          </span>
          <div>
            <PriorityPicker
              value={todo.priority}
              onChange={(p) => onPatch({ priority: p })}
            />
          </div>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Assignee
          </span>
          <div>
            <AssigneePicker
              value={todo.assigneeEmployeeId}
              employees={employees}
              onChange={(id) => onPatch({ assigneeEmployeeId: id })}
            />
          </div>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Due date
          </span>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={due}
              onChange={(e) =>
                onPatch({
                  dueAt: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : null,
                })
              }
            />
            {due && (
              <button
                onClick={() => onPatch({ dueAt: null })}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                title="Clear"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <CommentThread todo={todo} employees={employees} companyId={companyId} />
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 dark:border-slate-700">
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          Created {new Date(todo.createdAt).toLocaleDateString()}
        </span>
        <Button variant="danger" size="sm" onClick={onDelete}>
          <Trash2 size={13} /> Delete
        </Button>
      </div>
    </aside>
  );
}

// ───────────────────────── project settings ──────────────────────────────────

function ProjectSettingsModal({
  company,
  project,
  onClose,
  onSaved,
  onDeleted,
}: {
  company: Company;
  project: Project;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [name, setName] = React.useState(project.name);
  const [key, setKey] = React.useState(project.key);
  const [description, setDescription] = React.useState(project.description);
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/companies/${company.id}/projects/${project.slug}`, {
        name,
        key,
        description,
      });
      await onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete project "${project.name}" and all its todos?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/projects/${project.slug}`);
      onDeleted();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:bg-slate-900 dark:border-slate-700"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold">Project settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Key"
            value={key}
            onChange={(e) =>
              setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
            maxLength={6}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <Button variant="danger" onClick={remove} disabled={busy}>
              <Trash2 size={14} /> Delete project
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={save} disabled={busy || !name.trim() || !key.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── comment thread ────────────────────────────────────

/**
 * The conversation on a todo. Humans and AI employees post into the same
 * stream. A human can @mention an AI employee — when they do, we POST with
 * `mentionEmployeeId`, which causes the server to spin up the CLI for that
 * employee and drop its reply back into the thread. While we're waiting, the
 * server echoes a `pending: true` placeholder so we can show a typing state.
 */
function CommentThread({
  todo,
  employees,
  companyId,
}: {
  todo: Todo;
  employees: Employee[];
  companyId: string;
}) {
  const { toast } = useToast();
  const [comments, setComments] = React.useState<TodoComment[] | null>(null);
  const [body, setBody] = React.useState("");
  const [mentionId, setMentionId] = React.useState<string | null>(null);
  const [posting, setPosting] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    try {
      const list = await api.get<TodoComment[]>(
        `/api/companies/${companyId}/todos/${todo.id}/comments`,
      );
      setComments(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setComments([]);
    }
  }, [companyId, todo.id, toast]);

  React.useEffect(() => {
    setComments(null);
    setBody("");
    setMentionId(null);
    load();
  }, [todo.id, load]);

  // Poll while an AI reply is outstanding — the server fills the pending row
  // in place once the CLI returns. Stop polling as soon as nothing's pending.
  const hasPending = (comments ?? []).some((c) => c.pending);
  React.useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [hasPending, load]);

  // Default the @mention to the todo's current assignee — most common ask is
  // "ping the assignee for a status update".
  React.useEffect(() => {
    if (mentionId === null && todo.assigneeEmployeeId) {
      setMentionId(todo.assigneeEmployeeId);
    }
  }, [todo.assigneeEmployeeId, mentionId]);

  async function submit(withMention: boolean) {
    const text = body.trim();
    if (!text) return;
    setPosting(true);
    try {
      const created = await api.post<TodoComment[]>(
        `/api/companies/${companyId}/todos/${todo.id}/comments`,
        {
          body: text,
          mentionEmployeeId: withMention ? mentionId : null,
        },
      );
      setComments((prev) => [...(prev ?? []), ...created]);
      setBody("");
      requestAnimationFrame(() => {
        scrollerRef.current?.scrollTo({
          top: scrollerRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setPosting(false);
    }
  }

  async function remove(c: TodoComment) {
    try {
      await api.del(`/api/companies/${companyId}/comments/${c.id}`);
      setComments((prev) => (prev ? prev.filter((x) => x.id !== c.id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const mentionEmp = mentionId ? employees.find((e) => e.id === mentionId) : null;

  return (
    <div className="mt-6 border-t border-slate-100 pt-4 dark:border-slate-800">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <MessageSquare size={13} />
        Discussion
        {comments && comments.length > 0 && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {comments.length}
          </span>
        )}
      </div>

      <div ref={scrollerRef} className="flex flex-col gap-3">
        {comments === null ? (
          <div className="flex justify-center py-4">
            <Spinner size={14} />
          </div>
        ) : comments.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No messages yet. Ping a teammate — @mention an AI employee to loop
            them in.
          </div>
        ) : (
          comments.map((c) => <CommentRow key={c.id} comment={c} onDelete={remove} />)
        )}
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 bg-white focus-within:border-indigo-400 dark:bg-slate-900 dark:border-slate-700">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit(!!mentionId);
            }
          }}
          placeholder="Write a message…"
          rows={2}
          className="w-full resize-none rounded-t-lg bg-transparent px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
        />
        <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
          <MentionPicker
            value={mentionId}
            employees={employees}
            onChange={setMentionId}
          />
          <div className="flex-1" />
          {mentionEmp ? (
            <Button
              size="sm"
              onClick={() => submit(true)}
              disabled={!body.trim() || posting}
              title="Post and ask the AI employee to reply (⌘⏎)"
            >
              <Sparkles size={13} /> Ask {mentionEmp.name.split(" ")[0]}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => submit(false)}
              disabled={!body.trim() || posting}
              title="Post comment (⌘⏎)"
            >
              <Send size={13} /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  onDelete,
}: {
  comment: TodoComment;
  onDelete: (c: TodoComment) => void;
}) {
  const author = comment.author;
  const name = author?.name ?? "Unknown";
  const isAi = author?.kind === "ai";
  const when = formatWhen(comment.createdAt);

  return (
    <div className="group flex gap-2.5">
      <div className="shrink-0 pt-0.5">
        {isAi ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-violet-700">
            <Bot size={14} />
          </div>
        ) : (
          <Avatar name={name} size={28} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-slate-800 dark:text-slate-100">{name}</span>
          {isAi && (
            <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700">
              AI
            </span>
          )}
          <span className="text-slate-400 dark:text-slate-500">·</span>
          <span className="text-slate-400 dark:text-slate-500">{when}</span>
          <div className="flex-1" />
          <button
            onClick={() => onDelete(comment)}
            title="Delete"
            className="rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100 dark:hover:bg-slate-800"
          >
            <X size={12} />
          </button>
        </div>
        {comment.pending ? (
          <div className="mt-1 flex items-center gap-2 text-xs italic text-slate-400 dark:text-slate-500">
            <Spinner size={12} />
            Thinking…
          </div>
        ) : (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">
            {comment.body}
          </div>
        )}
      </div>
    </div>
  );
}

function MentionPicker({
  value,
  employees,
  onChange,
}: {
  value: string | null;
  employees: Employee[];
  onChange: (v: string | null) => void;
}) {
  const selected = value ? employees.find((e) => e.id === value) : null;
  return (
    <Menu
      width={220}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={clsx(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
            open
              ? "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
              : selected
                ? "text-violet-700 hover:bg-violet-50"
                : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
          )}
          title="Mention an AI employee to reply"
        >
          <AtSign size={12} />
          {selected ? selected.name : "Mention"}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Ask an AI employee</MenuHeader>
          <MenuItem
            active={value === null}
            icon={<X size={12} className="text-slate-400 dark:text-slate-500" />}
            label="No mention"
            onSelect={() => {
              onChange(null);
              close();
            }}
          />
          {employees.length > 0 && <MenuSeparator />}
          {employees.map((e) => (
            <MenuItem
              key={e.id}
              active={value === e.id}
              icon={<Avatar name={e.name} size={16} />}
              label={e.name}
              hint={e.role}
              onSelect={() => {
                onChange(e.id);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}


