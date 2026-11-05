import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Trash2 } from "lucide-react";

import { useAskAiPageContext } from "@/components/askAi/AskAiProvider";
import { useLiveRefetch } from "@/components/CompanySocket";
import { TodoDetailBody, todoPagePath } from "@/components/todos/TodoDetail";
import { STATUS_LABEL, optimisticTodo } from "@/components/todos/todoShared";
import { Button } from "@/components/ui/Button";
import { useBackgroundAction, useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { api, type Company, type Employee, type Member, type Project, type Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useTasks } from "./TasksLayout";

type Loaded = { project: Project; todo: Todo; related: Todo[] };

/**
 * A Todo with a page to itself: an address to share, and room for a long thread.
 *
 * It's the same `TodoDetailBody` the board's panel and Home's peek render, laid out
 * wide, so there's one Todo view rather than three that drift apart. The board's
 * panel is still where a click on a row goes. This is what "open full page" opens.
 */
export default function TodoPage({ company }: { company: Company }) {
  const { pSlug, todoNumber } = useParams();
  const navigate = useNavigate();
  const background = useBackgroundAction();
  const dialog = useDialog();
  const { reload: reloadProjects } = useTasks();
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  // Only the newest edit of a Todo gets to write its answer back.
  const mutationSeq = React.useRef(new Map<string, number>());
  const boardPath = `/c/${company.slug}/tasks/p/${pSlug}`;

  const reload = React.useCallback(async () => {
    try {
      setLoaded(
        await api.get<Loaded>(`/api/companies/${company.id}/projects/${pSlug}/todos/${todoNumber}`),
      );
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not open this todo."));
    }
  }, [company.id, pSlug, todoNumber]);

  React.useEffect(() => {
    setLoaded(null);
    setError(null);
    void reload();
  }, [reload]);
  useLiveRefetch(["todo", "project"], reload, loaded?.project.id ?? null);

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

  useAskAiPageContext(loaded ? [{ kind: "todo", id: loaded.todo.id }] : null);

  if (error && !loaded) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <FormError message={error} />
        <Link
          to={boardPath}
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline dark:text-indigo-300"
        >
          <ArrowLeft size={14} /> Back to the board
        </Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { project, todo, related } = loaded;
  const canEdit = project.myAccessLevel !== "read";
  const allTodos = [todo, ...related];

  const replace = (next: Todo) =>
    setLoaded((current) =>
      current
        ? {
            ...current,
            todo: current.todo.id === next.id ? next : current.todo,
            related: current.related.map((row) => (row.id === next.id ? next : row)),
          }
        : current,
    );

  const patchTodo = (target: Todo, patch: Partial<Todo>) => {
    const seq = (mutationSeq.current.get(target.id) ?? 0) + 1;
    mutationSeq.current.set(target.id, seq);
    replace(optimisticTodo(target, patch, employees, members));
    background(() => api.patch<Todo>(`/api/companies/${company.id}/todos/${target.id}`, patch), {
      title: "Couldn’t save the todo",
      error: (err) => `${errorMessage(err)} The change was undone.`,
      onSuccess: (updated) => {
        if (mutationSeq.current.get(target.id) === seq) replace(updated);
        void reloadProjects();
      },
      onError: () => {
        if (mutationSeq.current.get(target.id) === seq) replace(target);
      },
    });
  };

  const deleteTodo = async () => {
    const subtasks = related.filter((row) => row.parentTodoId === todo.id).length;
    const ok = await dialog.confirm({
      title: `Delete "${todo.title}"?`,
      message:
        subtasks > 0
          ? `This todo and its ${subtasks} subtask${subtasks === 1 ? "" : "s"} will be permanently removed.`
          : "This todo will be permanently removed.",
      confirmLabel: "Delete todo",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/todos/${todo.id}`);
      void reloadProjects();
      navigate(boardPath);
    } catch (err) {
      setError(errorMessage(err, "Could not delete this todo."));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-8">
        <nav
          aria-label="Breadcrumb"
          className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
        >
          <Link
            to={boardPath}
            className="inline-flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300"
          >
            <ArrowLeft size={13} aria-hidden="true" /> {project.name}
          </Link>
          <span aria-hidden="true">/</span>
          <span className="font-mono">
            {project.key}-{todo.number}
          </span>
          <span aria-hidden="true">·</span>
          <span>{STATUS_LABEL[todo.status]}</span>
        </nav>
        <FormError message={error} className="mb-3" />
        <TodoDetailBody
          key={todo.id}
          wide
          canCreateFinance={company.financeAccess === "full"}
          todo={todo}
          allTodos={allTodos}
          project={project}
          employees={employees}
          members={members}
          companyId={company.id}
          companySlug={company.slug}
          canEdit={canEdit}
          onPatch={(patch) => patchTodo(todo, patch)}
          onPatchTodo={patchTodo}
          onOpenTodo={(id) => {
            const row = allTodos.find((candidate) => candidate.id === id);
            if (row) navigate(todoPagePath(company.slug, project.slug, row.number));
          }}
          onCreated={(created) => {
            setLoaded((current) =>
              current ? { ...current, related: [...current.related, created] } : current,
            );
            void reloadProjects();
          }}
          onReviewResolved={() => void reload()}
        />
        <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Created {new Date(todo.createdAt).toLocaleDateString()}
          </span>
          {canEdit && (
            <Button variant="danger" size="sm" onClick={() => void deleteTodo()}>
              <Trash2 size={13} /> Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
