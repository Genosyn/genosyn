import React from "react";
import { Link } from "react-router-dom";
import { Check, CornerUpLeft, ExternalLink } from "lucide-react";

import { TodoDetailBody } from "@/components/todos/TodoDetail";
import { optimisticTodo, STATUS_LABEL } from "@/components/todos/todoShared";
import { Button, buttonClassName } from "@/components/ui/Button";
import { useBackgroundAction } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type { Company, Employee, HomeTodo, Member, Project, Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * A todo from Home, opened where it was clicked.
 *
 * The row used to link to the project board, which does not even scroll to the
 * todo you clicked — you arrived at a list and had to find it again. This
 * shows the whole thing instead: description, pickers, subtasks, comments, and
 * the one or two buttons that are the actual reason a todo is on your Home
 * page. The board is still a button away when you want its context.
 *
 * The body is `TodoDetailBody`, the same component the board docks beside its
 * list, so the two can never disagree about what a todo is. The mutation
 * semantics are deliberately the board's too — optimistic row, server row on
 * success, rollback on failure — because a peek that saves differently from
 * the page it mirrors is worse than no peek.
 */

type ProjectTodos = { project: Project; todos: Todo[] };

export function TodoPeekModal({
  company,
  row,
  /** Review rows get the reviewer's two resolutions instead of "mark done". */
  review,
  employees,
  members,
  onClose,
  onChanged,
}: {
  company: Company;
  row: HomeTodo;
  review: boolean;
  employees: Employee[];
  members: Member[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = React.useState<ProjectTodos | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Which todo the modal is showing. Starts at the row that was clicked and
  // moves when a subtask or the parent chip is opened, so the tree is
  // walkable here rather than only on the board.
  const [focusedId, setFocusedId] = React.useState(row.id);
  const background = useBackgroundAction();
  // Guards a slow PATCH's response from overwriting a newer one, exactly as
  // the board does — two quick picker changes otherwise land out of order.
  const mutationSeq = React.useRef<Map<string, number>>(new Map());

  const boardHref = `/c/${company.slug}/tasks/p/${row.project.slug}`;

  React.useEffect(() => {
    setFocusedId(row.id);
  }, [row.id]);

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    (async () => {
      try {
        // The project's list is the only route to a full Todo — there is no
        // get-one endpoint — and it brings the siblings the subtask section
        // and the parent chip need, plus `myAccessLevel`, along with it.
        const data = await api.get<ProjectTodos>(
          `/api/companies/${company.id}/projects/${row.project.slug}/todos`,
        );
        if (!cancelled) setLoaded(data);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load this todo"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, row.project.slug]);

  const todo = loaded?.todos.find((t) => t.id === focusedId) ?? null;
  // Same fallback the board uses: an absent level means an open project, and
  // guessing "read" would strip the controls from every ordinary member. The
  // server is the real gate either way.
  const canEdit = loaded ? loaded.project.myAccessLevel !== "read" : true;

  function replaceTodo(next: Todo) {
    setLoaded((current) =>
      current
        ? { ...current, todos: current.todos.map((t) => (t.id === next.id ? next : t)) }
        : current,
    );
  }

  /** Patch any todo in the loaded project — the focused one or a subtask. */
  function patchTodo(target: Todo, patchBody: Partial<Todo>) {
    const seq = (mutationSeq.current.get(target.id) ?? 0) + 1;
    mutationSeq.current.set(target.id, seq);
    // `optimisticTodo` rather than a raw spread: a picker sends
    // `{assignedEmployeeId}`, and only this knows to refresh the assignee
    // name beside it. A spread would leave the old name on screen until the
    // server answered.
    replaceTodo(optimisticTodo(target, patchBody, employees, members));

    background(
      () => api.patch<Todo>(`/api/companies/${company.id}/todos/${target.id}`, patchBody),
      {
        title: "Couldn’t save the todo",
        error: (err) => `${errorMessage(err)} The change was undone.`,
        onSuccess: (updated) => {
          if (mutationSeq.current.get(target.id) === seq) replaceTodo(updated);
          onChanged();
        },
        onError: () => {
          if (mutationSeq.current.get(target.id) === seq) replaceTodo(target);
        },
      },
    );
  }

  /** Resolve and close — the row is leaving Home either way. */
  function resolve(status: Todo["status"]) {
    if (!todo) return;
    patchTodo(todo, { status });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        todo && loaded ? `${loaded.project.key}-${todo.number}` : `${row.project.key}-${row.number}`
      }
      description={todo?.title ?? row.title}
      size="lg"
      footer={
        <>
          <Link
            to={boardHref}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            <ExternalLink size={14} /> Open the board
          </Link>
          {/* Only on the todo you came here for. Walking into a subtask
              changes what "mark done" would mean, and a resolve button that
              silently retargets is how the wrong thing gets closed. */}
          {todo && canEdit && todo.id === row.id && (
            <>
              {review && todo.status === "in_review" ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => resolve("in_progress")}>
                    <CornerUpLeft size={14} /> Push back
                  </Button>
                  <Button size="sm" onClick={() => resolve("done")}>
                    <Check size={14} /> Approve &amp; mark done
                  </Button>
                </>
              ) : todo.status === "done" ? null : (
                <Button size="sm" onClick={() => resolve("done")}>
                  <Check size={14} /> Mark done
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      {loadError ? (
        <FormError message={loadError} />
      ) : loaded === null ? (
        <div className="flex min-h-[12rem] items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : todo === null ? (
        <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          This todo is no longer in {loaded.project.name}. It may have been deleted or moved.
        </p>
      ) : (
        <>
          <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {loaded.project.name} · {STATUS_LABEL[todo.status]}
          </div>
          <TodoDetailBody
            todo={todo}
            allTodos={loaded.todos}
            project={loaded.project}
            employees={employees}
            members={members}
            companyId={company.id}
            companySlug={company.slug}
            canEdit={canEdit}
            onPatch={(patchBody) => patchTodo(todo, patchBody)}
            onPatchTodo={patchTodo}
            onOpenTodo={setFocusedId}
            onCreated={(created) => {
              // Into the modal's own list first — `onChanged` only refetches
              // Home, which is not where the subtask section reads from.
              setLoaded((current) =>
                current ? { ...current, todos: [...current.todos, created] } : current,
              );
              onChanged();
            }}
          />
        </>
      )}
    </Modal>
  );
}
