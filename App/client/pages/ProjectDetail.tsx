import React from "react";
import { Select } from "@/components/ui/Select";
import { useNavigate, useParams } from "react-router-dom";
import {
  LayoutList,
  Columns3,
  Plus,
  Trash2,
  Settings as SettingsIcon,
  X,
  Filter,
  Check,
  Calendar,
  User as UserIcon,
  MessageSquare,
  Repeat,
  RefreshCw,
  ShieldCheck,
  Users,
  Eye,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  Me,
  Member,
  Project,
  ProjectAccessLevel,
  ProjectAccessMode,
  ProjectAccessResponse,
  ProjectMember,
  Todo,
  TodoPriority,
  TodoRecurrence,
  TodoStatus,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { useTasks } from "./TasksLayout";
import { clsx } from "../components/ui/clsx";
import { AsyncResourceTagPicker } from "../components/TagPicker";
import { PlanLimitBanner } from "../components/FeatureGateCard";
import {
  AssigneeRef,
  AssigneePicker,
  Avatar,
  childStatsFor,
  ChildStats,
  formatDue,
  optimisticTodo,
  ParentChip,
  patchForRef,
  patchForReviewerRef,
  PriorityIcon,
  PriorityPicker,
  PRIORITY_BAR,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RecurrencePicker,
  RECURRENCE_LABEL,
  RECURRENCE_SHORT,
  refFromTodo,
  reviewerRefFromTodo,
  StatusIcon,
  StatusPicker,
  SubtaskCountChip,
  STATUS_LABEL,
  STATUS_ORDER,
} from "../components/todos/todoShared";
import { TodoDetailPanel } from "../components/todos/TodoDetail";

type ProjectTodos = { project: Project; todos: Todo[] };

// ───────────────────────── filter model ──────────────────────────────────────

type AssigneeFilterKey = string; // "unassigned" | `ai:${id}` | `user:${id}`

type Filters = {
  statuses: Set<TodoStatus>;
  priorities: Set<TodoPriority>;
  assignees: Set<AssigneeFilterKey>;
};

function emptyFilters(): Filters {
  return { statuses: new Set(), priorities: new Set(), assignees: new Set() };
}

function assigneeKey(t: Todo): AssigneeFilterKey {
  if (t.assigneeEmployeeId) return `ai:${t.assigneeEmployeeId}`;
  if (t.assigneeUserId) return `user:${t.assigneeUserId}`;
  return "unassigned";
}

function applyFilters(todos: Todo[], f: Filters): Todo[] {
  return todos.filter((t) => {
    if (f.statuses.size && !f.statuses.has(t.status)) return false;
    if (f.priorities.size && !f.priorities.has(t.priority)) return false;
    if (f.assignees.size && !f.assignees.has(assigneeKey(t))) return false;
    return true;
  });
}

function countActive(f: Filters): number {
  return f.statuses.size + f.priorities.size + f.assignees.size;
}

// ───────────────────────── main page ─────────────────────────────────────────

export default function ProjectDetail({ company, me }: { company: Company; me: Me }) {
  const { pSlug } = useParams();
  const navigate = useNavigate();
  const background = useBackgroundAction();
  const dialog = useDialog();
  const { reload: reloadProjects } = useTasks();

  const [data, setData] = React.useState<ProjectTodos | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [view, setView] = React.useState<"list" | "board">("list");
  const [peekId, setPeekId] = React.useState<string | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [filters, setFilters] = React.useState<Filters>(emptyFilters);
  const addInputRef = React.useRef<HTMLInputElement>(null);
  const todoMutationSeq = React.useRef(new Map<string, number>());

  // Every write affordance below hangs off this one value. `myAccessLevel` is
  // optional on `Project` (the list endpoint omits it) but always present on
  // the todos response we render from, so in practice it is set. When it IS
  // missing we deliberately fall back to ALLOWING edits: an open project is
  // editable by the whole company, and guessing "read" would strip the UI from
  // every normal user. The server is the real gate — it 403s a viewer who
  // shouldn't write — so an optimistic client is safe, while a pessimistic one
  // would be a regression.
  const canEdit = data ? data.project.myAccessLevel !== "read" : true;

  const reload = React.useCallback(async () => {
    if (!pSlug) return;
    try {
      const d = await api.get<ProjectTodos>(`/api/companies/${company.id}/projects/${pSlug}/todos`);
      setData(d);
    } catch (err) {
      // Nothing of this project survives the failure — we bounce back to the
      // task list, so the message has to travel with us in the modal.
      void dialog.error(err, { title: "Couldn’t open the project" });
      navigate(`/c/${company.slug}/tasks`);
    }
  }, [company.id, company.slug, pSlug, navigate, dialog]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Live board: an AI employee moving a todo, auto-starting on assign, or
  // posting a work-report comment shows up without a refresh. Scoped to this
  // project so other projects' churn doesn't refetch it.
  useLiveRefetch(["todo", "project"], reload, data?.project.id ?? null);

  React.useEffect(() => {
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
    api
      .get<Member[]>(`/api/companies/${company.id}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
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
        // Read-only viewers have no composer to focus — leave `c` alone.
        if (!canEdit) return;
        e.preventDefault();
        addInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (peekId) setPeekId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peekId, canEdit]);

  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { project, todos } = data;
  const visibleTodos = applyFilters(todos, filters);
  const peekTodo = peekId ? (todos.find((t) => t.id === peekId) ?? null) : null;
  const childStats = childStatsFor(todos);
  const todoById = new Map(todos.map((t) => [t.id, t]));

  function patchTodo(t: Todo, patch: Partial<Todo>) {
    const seq = (todoMutationSeq.current.get(t.id) ?? 0) + 1;
    todoMutationSeq.current.set(t.id, seq);
    const optimistic = optimisticTodo(t, patch, employees, members);
    setData((current) =>
      current
        ? {
            ...current,
            todos: current.todos.map((item) => (item.id === t.id ? optimistic : item)),
          }
        : current,
    );

    background(() => api.patch<Todo>(`/api/companies/${company.id}/todos/${t.id}`, patch), {
      title: "Couldn’t save the todo",
      error: (error) => `${errorMessage(error)} The change was undone.`,
      onSuccess: (updated) => {
        if (todoMutationSeq.current.get(t.id) === seq) {
          setData((current) =>
            current
              ? {
                  ...current,
                  todos: current.todos.map((item) => (item.id === updated.id ? updated : item)),
                }
              : current,
          );
        }
        const becameDone =
          patch.status === "done" && t.status !== "done" && t.recurrence !== "none";
        // The refetch is the confirmation: the next occurrence shows up as a
        // new row in the list the user is looking at.
        if (becameDone) void reload();
        void reloadProjects();
      },
      onError: () => {
        if (todoMutationSeq.current.get(t.id) !== seq) return;
        setData((current) =>
          current
            ? {
                ...current,
                todos: current.todos.map((item) => (item.id === t.id ? t : item)),
              }
            : current,
        );
      },
    });
  }

  async function deleteTodo(t: Todo) {
    const subCount = data ? data.todos.filter((x) => x.parentTodoId === t.id).length : 0;
    const ok = await dialog.confirm({
      title: `Delete "${t.title}"?`,
      message:
        subCount > 0
          ? `This todo and its ${subCount} subtask${subCount === 1 ? "" : "s"} will be permanently removed.`
          : "This todo will be permanently removed.",
      confirmLabel: "Delete todo",
      variant: "danger",
    });
    if (!ok) return;
    const removed = todos.filter((item) => item.id === t.id || item.parentTodoId === t.id);
    setData((current) =>
      current
        ? {
            ...current,
            todos: current.todos.filter((item) => item.id !== t.id && item.parentTodoId !== t.id),
          }
        : current,
    );
    if (peekId === t.id) setPeekId(null);

    background(() => api.del(`/api/companies/${company.id}/todos/${t.id}`), {
      title: "Couldn’t delete the todo",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onSuccess: () => void reloadProjects(),
      onError: () => {
        setData((current) =>
          current
            ? {
                ...current,
                todos: [...current.todos, ...removed].sort((a, b) => a.sortOrder - b.sortOrder),
              }
            : current,
        );
      },
    });
  }

  const summary = summarize(todos);

  // Plan-limit upsell (M56). Informational only — the new-todo row stays
  // enabled and the server's 402 surfaces in its own error handling. Note the
  // comparison counts only THIS project's loaded todos while the cap is
  // company-wide across every Project; on the Free plan (1 Project) the two
  // coincide, and the server stays authoritative either way.
  const maxTodos = company.entitlements.maxTodos;
  const atTodoCap = maxTodos !== null && todos.length >= maxTodos;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {atTodoCap && (
          <div className="px-6 pt-4">
            <PlanLimitBanner
              message={`Your Free plan includes ${maxTodos} Todo${maxTodos === 1 ? "" : "s"}.`}
              company={company}
            />
          </div>
        )}
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
          <div className="min-w-0 flex-1">
            <Breadcrumbs
              items={[{ label: "Tasks", to: `/c/${company.slug}/tasks` }, { label: project.name }]}
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
              {!canEdit && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  title="You have view-only access to this project"
                >
                  <Eye size={10} /> View only
                </span>
              )}
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

        <div className="border-b border-slate-200 bg-white px-6 py-2 dark:border-slate-700 dark:bg-slate-900">
          <AsyncResourceTagPicker
            companyId={company.id}
            resourceType="project"
            resourceId={project.id}
          />
        </div>

        {/* Filter bar */}
        <FilterBar
          filters={filters}
          setFilters={setFilters}
          employees={employees}
          members={members}
          todos={todos}
        />

        {/* New todo row — writers only; the server 403s a read-only create. */}
        {canEdit && (
          <NewTodoRow
            companyId={company.id}
            projectSlug={project.slug}
            employees={employees}
            members={members}
            meId={me.id}
            inputRef={addInputRef}
            onCreated={(t) => {
              setData((d) => (d ? { ...d, todos: [...d.todos, t] } : d));
              reloadProjects();
            }}
          />
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {view === "list" ? (
            <ListView
              todos={visibleTodos}
              totalBeforeFilter={todos.length}
              project={project}
              employees={employees}
              members={members}
              activePeekId={peekId}
              childStats={childStats}
              todoById={todoById}
              canEdit={canEdit}
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
              childStats={childStats}
              todoById={todoById}
              canEdit={canEdit}
              onPatch={patchTodo}
            />
          )}
        </div>
      </div>

      {peekTodo && (
        <TodoDetailPanel
          key={peekTodo.id}
          todo={peekTodo}
          allTodos={todos}
          project={project}
          employees={employees}
          members={members}
          companyId={company.id}
          companySlug={company.slug}
          canEdit={canEdit}
          onClose={() => setPeekId(null)}
          onPatch={(patch) => patchTodo(peekTodo, patch)}
          onPatchTodo={patchTodo}
          onDelete={() => deleteTodo(peekTodo)}
          onOpenTodo={setPeekId}
          onCreated={(t) => {
            setData((d) => (d ? { ...d, todos: [...d.todos, t] } : d));
            reloadProjects();
          }}
        />
      )}

      {showSettings && (
        <ProjectSettingsModal
          company={company}
          project={project}
          me={me}
          employees={employees}
          members={members}
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
      {[
        { v: "list" as const, label: "List", Icon: LayoutList },
        { v: "board" as const, label: "Board", Icon: Columns3 },
      ].map(({ v, label, Icon }) => (
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
  members,
  todos,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  employees: Employee[];
  members: Member[];
  todos: Todo[];
}) {
  function toggleStatus(s: TodoStatus) {
    const next = new Set(filters.statuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setFilters({ ...filters, statuses: next });
  }
  function togglePriority(p: TodoPriority) {
    const next = new Set(filters.priorities);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setFilters({ ...filters, priorities: next });
  }
  function toggleAssignee(key: AssigneeFilterKey) {
    const next = new Set(filters.assignees);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFilters({ ...filters, assignees: next });
  }

  const keysInUse = new Set(todos.map(assigneeKey));
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
        render={(close) => {
          const peopleInUse = members.filter(
            (m) => keysInUse.has(`user:${m.userId}`) || filters.assignees.has(`user:${m.userId}`),
          );
          const empsInUse = employees.filter(
            (e) => keysInUse.has(`ai:${e.id}`) || filters.assignees.has(`ai:${e.id}`),
          );
          return (
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
              {peopleInUse.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuHeader>People</MenuHeader>
                  {peopleInUse.map((m) => {
                    const name = m.name ?? m.email ?? "Member";
                    const key = `user:${m.userId}`;
                    return (
                      <MenuItem
                        key={key}
                        active={filters.assignees.has(key)}
                        icon={
                          filters.assignees.has(key) ? (
                            <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                          ) : (
                            <Avatar name={name} size={20} kind="human" />
                          )
                        }
                        label={name}
                        onSelect={() => toggleAssignee(key)}
                      />
                    );
                  })}
                </>
              )}
              {empsInUse.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuHeader>AI employees</MenuHeader>
                  {empsInUse.map((e) => {
                    const key = `ai:${e.id}`;
                    return (
                      <MenuItem
                        key={key}
                        active={filters.assignees.has(key)}
                        icon={
                          filters.assignees.has(key) ? (
                            <Check size={12} className="text-indigo-600 dark:text-indigo-400" />
                          ) : (
                            <Avatar name={e.name} size={20} kind="ai" />
                          )
                        }
                        label={e.name}
                        onSelect={() => toggleAssignee(key)}
                      />
                    );
                  })}
                </>
              )}
              <MenuSeparator />
              <MenuItem
                label="Clear"
                onSelect={() => {
                  setFilters({ ...filters, assignees: new Set() });
                  close();
                }}
              />
            </>
          );
        }}
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
  members,
  meId,
  inputRef,
  onCreated,
}: {
  companyId: string;
  projectSlug: string;
  employees: Employee[];
  members: Member[];
  meId: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onCreated: (t: Todo) => void;
}) {
  // New todos default to the creator — unowned work sits forever. The
  // picker shows it, so one click reassigns or clears before adding.
  const defaultAssignee = React.useMemo<AssigneeRef>(() => ({ kind: "human", id: meId }), [meId]);
  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<AssigneeRef>(defaultAssignee);
  const [reviewer, setReviewer] = React.useState<AssigneeRef>(null);
  const [priority, setPriority] = React.useState<TodoPriority>("none");
  const [status, setStatus] = React.useState<TodoStatus>("todo");
  const [recurrence, setRecurrence] = React.useState<TodoRecurrence>("none");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<Todo>(`/api/companies/${companyId}/projects/${projectSlug}/todos`, {
        title: title.trim(),
        priority,
        status,
        assigneeEmployeeId: assignee?.kind === "ai" ? assignee.id : null,
        assigneeUserId: assignee?.kind === "human" ? assignee.id : null,
        reviewerEmployeeId: reviewer?.kind === "ai" ? reviewer.id : null,
        reviewerUserId: reviewer?.kind === "human" ? reviewer.id : null,
        recurrence,
      });
      onCreated(t);
      setTitle("");
      setPriority("none");
      setAssignee(defaultAssignee);
      setReviewer(null);
      setStatus("todo");
      setRecurrence("none");
      inputRef.current?.focus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700">
      <form onSubmit={submit} className="flex items-center gap-2 px-6 py-2">
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
        <RecurrencePicker value={recurrence} onChange={setRecurrence} />
        <AssigneePicker
          value={assignee}
          employees={employees}
          members={members}
          onChange={setAssignee}
        />
        <AssigneePicker
          value={reviewer}
          employees={employees}
          members={members}
          onChange={setReviewer}
          role="reviewer"
          compact
        />
        <Button type="submit" size="sm" disabled={!title.trim() || busy}>
          {busy ? "…" : "Add"}
        </Button>
      </form>
      <FormError message={error} className="mx-6 mb-2" />
    </div>
  );
}

// ───────────────────────── list view ─────────────────────────────────────────

function ListView({
  todos,
  totalBeforeFilter,
  project,
  employees,
  members,
  activePeekId,
  childStats,
  todoById,
  canEdit,
  onOpen,
  onPatch,
  onDelete,
  onRename,
}: {
  todos: Todo[];
  totalBeforeFilter: number;
  project: Project;
  employees: Employee[];
  members: Member[];
  activePeekId: string | null;
  childStats: Map<string, ChildStats>;
  todoById: Map<string, Todo>;
  canEdit: boolean;
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
        {canEdit ? (
          <>
            No todos yet — press{" "}
            <kbd className="mx-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300">
              c
            </kbd>{" "}
            or type above to add one.
          </>
        ) : (
          "No todos yet."
        )}
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
            <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-6 py-2 text-xs font-medium text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300">
              <StatusIcon status={status} />
              <span>{STATUS_LABEL[status]}</span>
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                {items.length}
              </span>
            </div>
            <ul>
              {items.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  project={project}
                  employees={employees}
                  members={members}
                  active={activePeekId === t.id}
                  parent={t.parentTodoId ? (todoById.get(t.parentTodoId) ?? null) : null}
                  stats={childStats.get(t.id) ?? null}
                  canEdit={canEdit}
                  onOpen={() => onOpen(t.id)}
                  onOpenTodo={onOpen}
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
  members,
  active,
  parent,
  stats,
  canEdit,
  onOpen,
  onOpenTodo,
  onPatch,
  onDelete,
  onRename,
}: {
  todo: Todo;
  project: Project;
  employees: Employee[];
  members: Member[];
  active: boolean;
  parent: Todo | null;
  stats: ChildStats | null;
  canEdit: boolean;
  onOpen: () => void;
  onOpenTodo: (id: string) => void;
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
        "group flex cursor-pointer items-center gap-2 border-b border-slate-100 px-6 py-2 last:border-b-0 dark:border-slate-800",
        active
          ? "bg-indigo-50/60 dark:bg-indigo-500/10"
          : "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60",
      )}
    >
      <StatusPicker
        value={todo.status}
        onChange={(s) => onPatch({ status: s })}
        compact
        disabled={!canEdit}
      />
      <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
        {project.key}-{todo.number}
      </span>
      <PriorityPicker
        value={todo.priority}
        onChange={(p) => onPatch({ priority: p })}
        compact
        disabled={!canEdit}
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
              // Rename is a write — read-only viewers just open the peek.
              if (!canEdit) return;
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
      {parent && (
        <ParentChip parent={parent} project={project} onOpen={() => onOpenTodo(parent.id)} />
      )}
      {stats && <SubtaskCountChip stats={stats} />}
      {todo.description.trim() && (
        <span className="shrink-0 text-slate-300 dark:text-slate-600" title="Has description">
          <MessageSquare size={12} />
        </span>
      )}
      {due && (
        <span
          className={clsx("flex shrink-0 items-center gap-1 text-xs", due.cls)}
          title={todo.dueAt ?? undefined}
        >
          <Calendar size={12} /> {due.label}
        </span>
      )}
      {todo.recurrence !== "none" && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          title={`Repeats ${RECURRENCE_LABEL[todo.recurrence].toLowerCase()}`}
        >
          <Repeat size={10} />
          <span className="hidden sm:inline">{RECURRENCE_SHORT[todo.recurrence]}</span>
        </span>
      )}
      {todo.status === "in_review" && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
          title={todo.reviewer ? `Awaiting review by ${todo.reviewer.name}` : "Awaiting reviewer"}
        >
          <ShieldCheck size={10} />
          <span className="hidden sm:inline">Review</span>
        </span>
      )}
      {(todo.status === "in_review" || todo.reviewer) && (
        <AssigneePicker
          value={reviewerRefFromTodo(todo)}
          employees={employees}
          members={members}
          onChange={(ref) => onPatch(patchForReviewerRef(ref))}
          role="reviewer"
          compact
          disabled={!canEdit}
        />
      )}
      <AssigneePicker
        value={refFromTodo(todo)}
        employees={employees}
        members={members}
        onChange={(ref) => onPatch(patchForRef(ref))}
        compact
        disabled={!canEdit}
      />
      {canEdit && (
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
      )}
    </li>
  );
}

// ───────────────────────── board view ────────────────────────────────────────

const BOARD_COLUMNS: TodoStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];

function BoardView({
  todos,
  project,
  onOpen,
  activePeekId,
  childStats,
  todoById,
  canEdit,
  onPatch,
}: {
  todos: Todo[];
  project: Project;
  onOpen: (id: string) => void;
  activePeekId: string | null;
  childStats: Map<string, ChildStats>;
  todoById: Map<string, Todo>;
  canEdit: boolean;
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
        const isReview = status === "in_review";
        return (
          <div
            key={status}
            onDragOver={(e) => {
              // Dropping issues a status PATCH, so read-only viewers get no
              // drop target at all — their cards aren't draggable either.
              if (!canEdit) return;
              e.preventDefault();
              if (overCol !== status) setOverCol(status);
            }}
            onDragLeave={() => setOverCol((c) => (c === status ? null : c))}
            onDrop={() => {
              if (!canEdit) return;
              setOverCol(null);
              if (!dragId) return;
              const t = todos.find((x) => x.id === dragId);
              if (t && t.status !== status) onPatch(t, { status });
              setDragId(null);
            }}
            className={clsx(
              "flex w-72 shrink-0 flex-col rounded-lg border transition-colors",
              isOver
                ? "border-indigo-400 bg-indigo-50/50"
                : isReview
                  ? "border-violet-200 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/5"
                  : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900",
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
                  {canEdit ? "Drop here" : "Nothing here"}
                </div>
              ) : (
                items.map((t) => (
                  <BoardCard
                    key={t.id}
                    todo={t}
                    project={project}
                    active={activePeekId === t.id}
                    parent={t.parentTodoId ? (todoById.get(t.parentTodoId) ?? null) : null}
                    stats={childStats.get(t.id) ?? null}
                    canEdit={canEdit}
                    onClick={() => onOpen(t.id)}
                    onOpenTodo={onOpen}
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
  parent,
  stats,
  canEdit,
  onClick,
  onOpenTodo,
  onDragStart,
  onDragEnd,
}: {
  todo: Todo;
  project: Project;
  active: boolean;
  parent: Todo | null;
  stats: ChildStats | null;
  canEdit: boolean;
  onClick: () => void;
  onOpenTodo: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const due = formatDue(todo.dueAt);
  const isReview = todo.status === "in_review";
  return (
    <div
      // Dragging a card moves it between columns, which is a status PATCH.
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={clsx(
        "group relative cursor-pointer overflow-hidden rounded-lg border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow dark:bg-slate-900",
        active
          ? "border-indigo-400 ring-2 ring-indigo-100"
          : isReview
            ? "border-violet-300 dark:border-violet-500/40"
            : "border-slate-200 dark:border-slate-700",
      )}
    >
      <div className={clsx("absolute left-0 top-0 h-full w-0.5", PRIORITY_BAR[todo.priority])} />
      <div className="p-3 pl-3.5">
        <div className="flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
          <span className="font-mono">
            {project.key}-{todo.number}
          </span>
          <PriorityIcon priority={todo.priority} size={11} />
          {parent && (
            <ParentChip parent={parent} project={project} onOpen={() => onOpenTodo(parent.id)} />
          )}
          {stats && <SubtaskCountChip stats={stats} />}
          {isReview && (
            <span
              className="ml-auto flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
              title={
                todo.reviewer ? `Awaiting review by ${todo.reviewer.name}` : "Awaiting reviewer"
              }
            >
              <ShieldCheck size={10} /> Review
            </span>
          )}
        </div>
        <div className="mt-1 line-clamp-3 text-sm text-slate-900 dark:text-slate-100">
          {todo.title}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {due && (
              <span className={clsx("flex items-center gap-1 text-[11px]", due.cls)}>
                <Calendar size={11} /> {due.label}
              </span>
            )}
            {todo.recurrence !== "none" && (
              <span
                className="flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-300"
                title={`Repeats ${RECURRENCE_LABEL[todo.recurrence].toLowerCase()}`}
              >
                <Repeat size={11} /> {RECURRENCE_SHORT[todo.recurrence]}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {isReview && todo.reviewer && (
              <span title={`Reviewer: ${todo.reviewer.name}`} className="flex items-center">
                <Avatar
                  name={todo.reviewer.name}
                  size={20}
                  kind={todo.reviewer.kind === "ai" ? "ai" : "human"}
                />
              </span>
            )}
            {todo.assignee ? (
              <Avatar
                name={todo.assignee.name}
                size={20}
                kind={todo.assignee.kind === "ai" ? "ai" : "human"}
              />
            ) : (
              <div className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-300 dark:border-slate-600">
                <UserIcon size={10} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── project settings ──────────────────────────────────

function ProjectSettingsModal({
  company,
  project,
  me,
  employees,
  members,
  onClose,
  onSaved,
  onDeleted,
}: {
  company: Company;
  project: Project;
  me: Me;
  employees: Employee[];
  members: Member[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [tab, setTab] = React.useState<"general" | "access">("general");
  // A viewer served with `read` can't write anything here — the server would
  // 403 every one of these controls, so don't offer them.
  const canEdit = project.myAccessLevel !== "read";
  // The General tab unmounts when you switch to Access, so its field state
  // lives here instead — otherwise a half-typed rename is silently lost on a
  // round-trip to check the member list and back.
  const [name, setName] = React.useState(project.name);
  const [key, setKey] = React.useState(project.key);
  const [description, setDescription] = React.useState(project.description);

  return (
    <Modal open onClose={onClose} title="Project settings" size="lg">
      <div className="-mx-5 -mt-5 mb-5 flex gap-1 border-b border-slate-100 px-5 dark:border-slate-800">
        <TabButton active={tab === "general"} onClick={() => setTab("general")}>
          General
        </TabButton>
        <TabButton active={tab === "access"} onClick={() => setTab("access")}>
          <Users size={12} /> Access
        </TabButton>
      </div>

      {tab === "general" ? (
        <ProjectGeneralTab
          company={company}
          project={project}
          canEdit={canEdit}
          name={name}
          setName={setName}
          projectKey={key}
          setProjectKey={setKey}
          description={description}
          setDescription={setDescription}
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      ) : (
        <ProjectAccessTab
          company={company}
          project={project}
          me={me}
          employees={employees}
          members={members}
          canEdit={canEdit}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition",
        active
          ? "border-indigo-500 text-indigo-700 dark:text-indigo-300"
          : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Field state is owned by `ProjectSettingsModal` — this tab unmounts on a
 * switch to Access, and unsaved edits must survive the round-trip.
 */
function ProjectGeneralTab({
  company,
  project,
  canEdit,
  name,
  setName,
  projectKey,
  setProjectKey,
  description,
  setDescription,
  onClose,
  onSaved,
  onDeleted,
}: {
  company: Company;
  project: Project;
  canEdit: boolean;
  name: string;
  setName: (v: string) => void;
  projectKey: string;
  setProjectKey: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialog = useDialog();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/companies/${company.id}/projects/${project.slug}`, {
        name,
        key: projectKey,
        description,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    const ok = await dialog.confirm({
      title: `Delete "${project.name}"?`,
      message: "The project and all of its todos will be permanently removed.",
      confirmLabel: "Delete project",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/projects/${project.slug}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!canEdit && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
          You have view-only access to this project, so its settings are read-only.
        </p>
      )}
      <Input
        label="Name"
        value={name}
        disabled={!canEdit}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label="Key"
        value={projectKey}
        disabled={!canEdit}
        onChange={(e) => setProjectKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
        maxLength={6}
      />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Description
        </label>
        <textarea
          value={description}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:focus:ring-indigo-500/25"
        />
      </div>
      <FormError message={error} />
      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        {canEdit ? (
          <Button variant="danger" onClick={remove} disabled={busy}>
            <Trash2 size={14} /> Delete project
          </Button>
        ) : (
          <span />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit && (
            <Button onClick={save} disabled={busy || !name.trim() || !projectKey.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── project access ────────────────────────────────────

/**
 * Who can open this project. Access lives on the Project, so the list and the
 * board views inherit it — there is nothing to configure per view.
 *
 *   - open       → everyone in the company can edit (the default)
 *   - restricted → only the humans and AI employees on this list
 *
 * Both principal kinds share one list. Adds and removes apply immediately;
 * there is no Save button on this tab.
 */
function ProjectAccessTab({
  company,
  project,
  me,
  employees,
  members,
  canEdit,
  onClose,
  onSaved,
}: {
  company: Company;
  project: Project;
  me: Me;
  employees: Employee[];
  members: Member[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [access, setAccess] = React.useState<ProjectAccessResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Every control on this tab writes straight through, so they share one
  // banner rather than each growing an error slot of its own.
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [addPick, setAddPick] = React.useState("");
  const [addLevel, setAddLevel] = React.useState<ProjectAccessLevel>("write");

  const base = `/api/companies/${company.id}/projects/${project.slug}`;

  const reloadAccess = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setAccess(await api.get<ProjectAccessResponse>(`${base}/access`));
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load who has access"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => {
    reloadAccess();
  }, [reloadAccess]);

  async function setMode(next: ProjectAccessMode) {
    if (!access || access.accessMode === next) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(base, { accessMode: next });
      // Flipping to restricted seeds the acting user with "Can edit" server
      // side, so the list has to come back from the server, not from here.
      await reloadAccess();
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    if (!addPick) return;
    const [kind, id] = addPick.split(":");
    setBusy(true);
    setError(null);
    try {
      await api.post<ProjectMember>(`${base}/access`, {
        memberKind: kind === "ai" ? "ai" : "user",
        memberId: id,
        accessLevel: addLevel,
      });
      setAddPick("");
      await reloadAccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeLevel(m: ProjectMember, next: ProjectAccessLevel) {
    if (m.accessLevel === next) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/access/${m.id}`, { accessLevel: next });
      await reloadAccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(m: ProjectMember) {
    setError(null);
    const isMe = m.memberKind === "user" && m.userId === me.id;
    if (isMe) {
      const ok = await dialog.confirm({
        title: "Remove yourself from this project?",
        message: "You will lose access to this project and all of its todos.",
        confirmLabel: "Remove",
        variant: "danger",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.del(`${base}/access/${m.id}`);
      if (isMe) {
        // We just handed in our own key — let the page re-check and bounce us
        // out rather than sit here re-fetching a list we can no longer read.
        onClose();
        await onSaved();
        return;
      }
      await reloadAccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !access) {
    return (
      <div className="flex min-h-[12rem] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-[12rem] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={reloadAccess}>
          <RefreshCw size={13} /> Try again
        </Button>
      </div>
    );
  }

  if (!access) return null;

  const restricted = access.accessMode === "restricted";
  // Rows survive a flip back to `open`, so the list can be non-empty while it
  // has no effect. Show it dimmed rather than hiding what is still stored.
  const interactive = canEdit && restricted && !busy;

  const takenUsers = new Set(access.members.flatMap((m) => (m.userId ? [m.userId] : [])));
  const takenEmployees = new Set(
    access.members.flatMap((m) => (m.employeeId ? [m.employeeId] : [])),
  );
  const humanChoices = members.filter((m) => !takenUsers.has(m.userId));
  const aiChoices = employees.filter((e) => !takenEmployees.has(e.id));
  const hasChoices = humanChoices.length + aiChoices.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <FormError message={error} />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Who can open this project
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The list and board are two views of the same project, so this applies to both — and to
          every todo inside it.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <ModeOption
            active={!restricted}
            disabled={!canEdit || busy}
            title="Anyone in the company"
            subtitle="Every member and AI employee can view and edit."
            onClick={() => setMode("open")}
          />
          <ModeOption
            active={restricted}
            disabled={!canEdit || busy}
            title="Only people and AI employees you add"
            subtitle="Everyone else is locked out of the project and its todos."
            onClick={() => setMode("restricted")}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Who has access</h3>
        {!restricted && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Everyone in the company already has access. This list only takes effect once you switch
            to <span className="font-medium">Only people and AI employees you add</span>.
          </p>
        )}
        {access.members.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            No one has been added yet.
          </p>
        ) : (
          <ul
            className={clsx(
              "mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700",
              !restricted && "opacity-60",
            )}
          >
            {access.members.map((m) => {
              const isAi = m.memberKind === "ai";
              const secondary = isAi ? m.slug : m.email;
              const isMe = m.memberKind === "user" && m.userId === me.id;
              return (
                <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={m.name} size={20} kind={isAi ? "ai" : "human"} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {m.name}
                        </span>
                        {isMe && (
                          <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            You
                          </span>
                        )}
                      </div>
                      {secondary && (
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {secondary}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <LevelSelect
                      value={m.accessLevel}
                      disabled={!interactive}
                      onChange={(next) => changeLevel(m, next)}
                    />
                    <button
                      type="button"
                      onClick={() => removeMember(m)}
                      disabled={!interactive}
                      title="Remove from project"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canEdit && restricted && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Add someone</h3>
          {!hasChoices ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Everyone in this company already has access.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={addPick}
                disabled={busy}
                onChange={(e) => setAddPick(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <option value="">Pick a person or AI employee…</option>
                {humanChoices.length > 0 && (
                  <optgroup label="Members">
                    {humanChoices.map((m) => (
                      <option key={m.userId} value={`user:${m.userId}`}>
                        {m.name ?? m.email ?? "Member"}
                      </option>
                    ))}
                  </optgroup>
                )}
                {aiChoices.length > 0 && (
                  <optgroup label="AI employees">
                    {aiChoices.map((e) => (
                      <option key={e.id} value={`ai:${e.id}`}>
                        {e.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              <div className="flex items-center gap-2">
                <LevelSelect value={addLevel} disabled={busy} onChange={setAddLevel} />
                <Button size="sm" onClick={addMember} disabled={busy || !addPick}>
                  <Plus size={13} /> Add
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeOption({
  active,
  disabled,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx(
        "flex flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition disabled:opacity-60",
        active
          ? "border-indigo-500 bg-indigo-50/60 dark:border-indigo-500 dark:bg-indigo-500/10"
          : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-900 dark:text-slate-100">
        {active && <Check size={12} className="shrink-0 text-indigo-600 dark:text-indigo-400" />}
        {title}
      </span>
      <span className="text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</span>
    </button>
  );
}

function LevelSelect({
  value,
  disabled,
  onChange,
}: {
  value: ProjectAccessLevel;
  disabled: boolean;
  onChange: (next: ProjectAccessLevel) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ProjectAccessLevel)}
      className="h-7 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      <option value="read">View only</option>
      <option value="write">Can edit</option>
    </Select>
  );
}
