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
  User,
  Settings as SettingsIcon,
  AlertTriangle,
  AlertCircle,
  SignalHigh,
  SignalMedium,
  SignalLow,
  Minus,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  Project,
  Todo,
  TodoPriority,
  TodoStatus,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useTasks } from "./TasksLayout";

type ProjectTodos = { project: Project; todos: Todo[] };

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

function StatusIcon({ status, size = 14 }: { status: TodoStatus; size?: number }) {
  const cls = {
    backlog: "text-slate-400",
    todo: "text-slate-500",
    in_progress: "text-amber-500",
    in_review: "text-violet-500",
    done: "text-emerald-500",
    cancelled: "text-slate-400",
  }[status];
  const Icon = {
    backlog: CircleDashed,
    todo: Circle,
    in_progress: CircleEllipsis,
    in_review: CircleDot,
    done: CircleCheckBig,
    cancelled: CircleSlash,
  }[status];
  return <Icon size={size} className={cls} />;
}

const PRIORITY_ORDER: TodoPriority[] = ["urgent", "high", "medium", "low", "none"];
const PRIORITY_LABEL: Record<TodoPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
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
      return <SignalLow size={size} className="text-slate-500" />;
    default:
      return <Minus size={size} className="text-slate-300" />;
  }
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <div
      className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700"
      title={name}
    >
      {initials || "?"}
    </div>
  );
}

export default function ProjectDetail({ company }: { company: Company }) {
  const { pSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { reload: reloadProjects } = useTasks();
  const [data, setData] = React.useState<ProjectTodos | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [view, setView] = React.useState<"list" | "board">("list");
  const [editing, setEditing] = React.useState<Todo | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);

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

  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { project, todos } = data;

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
      reloadProjects();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
              {project.key}
            </span>
            <h1 className="truncate text-lg font-semibold text-slate-900">
              {project.name}
            </h1>
          </div>
          {project.description && (
            <p className="mt-1 truncate text-sm text-slate-500">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
          <button
            onClick={() => setView("list")}
            className={
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs " +
              (view === "list"
                ? "bg-slate-100 text-slate-900"
                : "text-slate-500 hover:text-slate-900")
            }
          >
            <LayoutList size={14} /> List
          </button>
          <button
            onClick={() => setView("board")}
            className={
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs " +
              (view === "board"
                ? "bg-slate-100 text-slate-900"
                : "text-slate-500 hover:text-slate-900")
            }
          >
            <Columns3 size={14} /> Board
          </button>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          title="Project settings"
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {/* New todo row */}
      <NewTodoRow
        companyId={company.id}
        projectSlug={project.slug}
        employees={employees}
        onCreated={(t) => {
          setData((d) => (d ? { ...d, todos: [...d.todos, t] } : d));
          reloadProjects();
        }}
      />

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "list" ? (
          <ListView
            todos={todos}
            project={project}
            employees={employees}
            onEdit={setEditing}
            onPatch={patchTodo}
            onDelete={deleteTodo}
          />
        ) : (
          <BoardView
            todos={todos}
            project={project}
            employees={employees}
            onEdit={setEditing}
            onPatch={patchTodo}
          />
        )}
      </div>

      {editing && (
        <TodoEditModal
          todo={editing}
          employees={employees}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await patchTodo(editing, patch);
            setEditing(null);
          }}
          onDelete={async () => {
            await deleteTodo(editing);
            setEditing(null);
          }}
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

// ----- New todo row -----

function NewTodoRow({
  companyId,
  projectSlug,
  employees,
  onCreated,
}: {
  companyId: string;
  projectSlug: string;
  employees: Employee[];
  onCreated: (t: Todo) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>("");
  const [priority, setPriority] = React.useState<TodoPriority>("none");
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
          assigneeEmployeeId: assignee || null,
        },
      );
      onCreated(t);
      setTitle("");
      setPriority("none");
      setAssignee("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-3"
    >
      <Plus size={14} className="text-slate-400" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a todo…"
        className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
      />
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as TodoPriority)}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
      >
        {PRIORITY_ORDER.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>
      <select
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
      >
        <option value="">Unassigned</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={!title.trim() || busy}>
        {busy ? "…" : "Add"}
      </Button>
    </form>
  );
}

// ----- List view -----

function ListView({
  todos,
  project,
  employees,
  onEdit,
  onPatch,
  onDelete,
}: {
  todos: Todo[];
  project: Project;
  employees: Employee[];
  onEdit: (t: Todo) => void;
  onPatch: (t: Todo, patch: Partial<Todo>) => void;
  onDelete: (t: Todo) => void;
}) {
  // Group by status, in canonical order.
  const byStatus = new Map<TodoStatus, Todo[]>();
  STATUS_ORDER.forEach((s) => byStatus.set(s, []));
  for (const t of todos) byStatus.get(t.status)?.push(t);

  if (todos.length === 0) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500">
        No todos yet — add one above.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {STATUS_ORDER.map((status) => {
        const items = byStatus.get(status)!;
        if (items.length === 0) return null;
        return (
          <div key={status} className="border-b border-slate-100">
            <div className="flex items-center gap-2 bg-slate-50 px-6 py-2 text-xs font-semibold text-slate-600">
              <StatusIcon status={status} />
              <span>{STATUS_LABEL[status]}</span>
              <span className="text-slate-400">{items.length}</span>
            </div>
            <ul>
              {items.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  project={project}
                  employees={employees}
                  onEdit={() => onEdit(t)}
                  onPatch={(patch) => onPatch(t, patch)}
                  onDelete={() => onDelete(t)}
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
  onEdit,
  onPatch,
  onDelete,
}: {
  todo: Todo;
  project: Project;
  employees: Employee[];
  onEdit: () => void;
  onPatch: (patch: Partial<Todo>) => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-center gap-3 border-b border-slate-100 bg-white px-6 py-2 last:border-b-0 hover:bg-slate-50">
      <select
        value={todo.status}
        onChange={(e) => onPatch({ status: e.target.value as TodoStatus })}
        onClick={(e) => e.stopPropagation()}
        className="appearance-none bg-transparent pr-1 text-sm focus:outline-none"
        title="Change status"
      >
        {STATUS_ORDER.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <span className="font-mono text-xs text-slate-400">
        {project.key}-{todo.number}
      </span>
      <PriorityIcon priority={todo.priority} />
      <button
        onClick={onEdit}
        className="min-w-0 flex-1 truncate text-left text-sm text-slate-900"
      >
        {todo.title}
      </button>
      <select
        value={todo.assigneeEmployeeId ?? ""}
        onChange={(e) => onPatch({ assigneeEmployeeId: e.target.value || null })}
        onClick={(e) => e.stopPropagation()}
        className="bg-transparent text-xs text-slate-500 focus:outline-none"
        title="Assignee"
      >
        <option value="">Unassigned</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {todo.assignee ? <Avatar name={todo.assignee.name} /> : <User size={14} className="text-slate-300" />}
      <button
        onClick={onDelete}
        className="rounded p-1 text-slate-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
        title="Delete"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

// ----- Board view -----

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
  employees,
  onEdit,
  onPatch,
}: {
  todos: Todo[];
  project: Project;
  employees: Employee[];
  onEdit: (t: Todo) => void;
  onPatch: (t: Todo, patch: Partial<Todo>) => void;
}) {
  const byStatus = new Map<TodoStatus, Todo[]>();
  BOARD_COLUMNS.forEach((s) => byStatus.set(s, []));
  for (const t of todos) {
    if (byStatus.has(t.status)) byStatus.get(t.status)!.push(t);
  }

  const [dragId, setDragId] = React.useState<string | null>(null);

  return (
    <div className="flex h-full min-w-max gap-3 p-4">
      {BOARD_COLUMNS.map((status) => {
        const items = byStatus.get(status)!;
        return (
          <div
            key={status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (!dragId) return;
              const t = todos.find((x) => x.id === dragId);
              if (t && t.status !== status) onPatch(t, { status });
              setDragId(null);
            }}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-50"
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">
              <StatusIcon status={status} />
              <span>{STATUS_LABEL[status]}</span>
              <span className="ml-auto text-slate-400">{items.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {items.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">—</div>
              ) : (
                items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onClick={() => onEdit(t)}
                    className="cursor-pointer rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:border-indigo-300"
                  >
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      <span className="font-mono">
                        {project.key}-{t.number}
                      </span>
                      <PriorityIcon priority={t.priority} size={12} />
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm text-slate-900">
                      {t.title}
                    </div>
                    <div className="mt-2 flex items-center justify-end">
                      {t.assignee ? (
                        <Avatar name={t.assignee.name} />
                      ) : (
                        <span className="text-[10px] text-slate-400">Unassigned</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----- Edit modal -----

function TodoEditModal({
  todo,
  employees,
  onClose,
  onSave,
  onDelete,
}: {
  todo: Todo;
  employees: Employee[];
  onClose: () => void;
  onSave: (patch: Partial<Todo>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = React.useState(todo.title);
  const [description, setDescription] = React.useState(todo.description);
  const [status, setStatus] = React.useState<TodoStatus>(todo.status);
  const [priority, setPriority] = React.useState<TodoPriority>(todo.priority);
  const [assignee, setAssignee] = React.useState<string>(todo.assigneeEmployeeId ?? "");
  const [dueAt, setDueAt] = React.useState<string>(
    todo.dueAt ? todo.dueAt.slice(0, 10) : "",
  );
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      await onSave({
        title,
        description,
        status,
        priority,
        assigneeEmployeeId: assignee || null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit todo`}>
      <div className="flex flex-col gap-3">
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TodoStatus)}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TodoPriority)}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
          <Select
            label="Assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Unassigned</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </Select>
          <Input
            label="Due date"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <Button variant="danger" onClick={onDelete} disabled={busy}>
            <Trash2 size={14} /> Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !title.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ----- Project settings modal -----

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
    <Modal open onClose={onClose} title="Project settings">
      <div className="flex flex-col gap-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Key"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          maxLength={6}
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
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
    </Modal>
  );
}

// Silence unused-import lint for icons bundled in the switch statement.
void AlertCircle;
