import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AtSign,
  Bot,
  Check,
  CornerDownRight,
  CornerUpLeft,
  ListTree,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  ChatResourceReference,
  insertResourceReference,
  ResourceReferencePicker,
  resourceQueryAtCaret,
  useResourceReferences,
} from "@/components/chat/ResourceReferencePicker";
import { Button } from "@/components/ui/Button";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useBackgroundAction } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Employee, Member, Project, Todo, TodoComment } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  AssigneePicker,
  Avatar,
  patchForRef,
  patchForReviewerRef,
  PriorityPicker,
  RecurrencePicker,
  RECURRENCE_LABEL,
  refFromTodo,
  reviewerRefFromTodo,
  StatusPicker,
  STATUS_LABEL,
} from "@/components/todos/todoShared";

/**
 * Everything a Todo is, in one panel: title, description, the six pickers,
 * subtasks, the review hand-off, and the comment thread.
 *
 * The project board docks it beside the list; Home opens it in a modal over
 * whatever you were looking at, so a todo assigned to you can be read, moved
 * and commented on without the page changing underneath you. Both render this
 * component rather than their own version of it — a description editor that
 * only works on one of the two surfaces is the failure this file exists to
 * prevent.
 *
 * The caller supplies the chrome (an `<aside>` on the board, a `<Modal>` on
 * Home) and the mutations, because who owns the todo list differs between
 * them: the board patches its own array, Home refetches its aggregation call.
 */

// ───────────────────────── side-panel peek ───────────────────────────────────

export function TodoDetailBody({
  todo,
  allTodos,
  project,
  employees,
  members,
  companyId,
  companySlug,
  canEdit,
  onPatch,
  onPatchTodo,
  onOpenTodo,
  onCreated,
}: {
  todo: Todo;
  allTodos: Todo[];
  project: Project;
  employees: Employee[];
  members: Member[];
  companyId: string;
  companySlug: string;
  canEdit: boolean;
  onPatch: (patch: Partial<Todo>) => void;
  onPatchTodo: (t: Todo, patch: Partial<Todo>) => void;
  onOpenTodo: (id: string) => void;
  onCreated: (t: Todo) => void;
}) {
  const [title, setTitle] = React.useState(todo.title);
  const [desc, setDesc] = React.useState(todo.description);
  const [descDirty, setDescDirty] = React.useState(false);
  const [descEditing, setDescEditing] = React.useState(false);
  React.useEffect(() => {
    setTitle(todo.title);
    setDesc(todo.description);
    setDescDirty(false);
    setDescEditing(false);
  }, [todo.id, todo.title, todo.description]);

  function commitTitle() {
    const t = title.trim();
    if (t && t !== todo.title) onPatch({ title: t });
    else setTitle(todo.title);
  }
  function commitDesc() {
    if (!descDirty) {
      setDescEditing(false);
      return;
    }
    onPatch({ description: desc });
    setDescDirty(false);
    setDescEditing(false);
  }
  const due = todo.dueAt ? todo.dueAt.slice(0, 10) : "";
  const parent = todo.parentTodoId
    ? (allTodos.find((t) => t.id === todo.parentTodoId) ?? null)
    : null;
  const subtasks = allTodos.filter((t) => t.parentTodoId === todo.id);

  return (
    <div>
      {parent && (
        <button
          onClick={() => onOpenTodo(parent.id)}
          className="mb-2 flex items-center gap-1.5 rounded-md text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-300"
          title="Open parent todo"
        >
          <CornerDownRight size={12} />
          Sub-task of{" "}
          <span className="font-mono">
            {project.key}-{parent.number}
          </span>
          <span className="max-w-[14rem] truncate">· {parent.title}</span>
        </button>
      )}
      <input
        value={title}
        readOnly={!canEdit}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Task title"
        className="w-full bg-transparent text-[17px] font-semibold leading-tight text-slate-900 placeholder:text-slate-300 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-600"
      />

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Description
          </span>
          {!descEditing && desc && canEdit && (
            <button
              onClick={() => setDescEditing(true)}
              className="text-[11px] text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              Edit
            </button>
          )}
        </div>
        {descEditing ? (
          <DescriptionEditor
            value={desc}
            onChange={(v) => {
              setDesc(v);
              setDescDirty(true);
            }}
            onDone={commitDesc}
          />
        ) : desc ? (
          canEdit ? (
            <button
              type="button"
              onClick={() => setDescEditing(true)}
              className="block w-full rounded-lg border border-transparent px-3 py-2 text-left hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-800"
            >
              <MarkdownView source={desc} />
            </button>
          ) : (
            <div className="px-3 py-2">
              <MarkdownView source={desc} />
            </div>
          )
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setDescEditing(true)}
            className="block w-full rounded-lg border border-dashed border-slate-200 px-3 py-2 text-left text-sm text-slate-400 hover:border-slate-300 hover:text-slate-600 dark:border-slate-700 dark:text-slate-500 dark:hover:border-slate-600 dark:hover:text-slate-300"
          >
            Add a description — supports **markdown**, `code`, lists, links…
          </button>
        ) : (
          <p className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">No description.</p>
        )}
      </div>

      <div className="mt-6 grid grid-cols-[88px_1fr] items-center gap-y-2.5 text-sm">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Status
        </span>
        <div>
          <StatusPicker
            value={todo.status}
            onChange={(s) => onPatch({ status: s })}
            disabled={!canEdit}
          />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Priority
        </span>
        <div>
          <PriorityPicker
            value={todo.priority}
            onChange={(p) => onPatch({ priority: p })}
            disabled={!canEdit}
          />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Assignee
        </span>
        <div>
          <AssigneePicker
            value={refFromTodo(todo)}
            employees={employees}
            members={members}
            onChange={(ref) => onPatch(patchForRef(ref))}
            disabled={!canEdit}
          />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Reviewer
        </span>
        <div>
          <AssigneePicker
            value={reviewerRefFromTodo(todo)}
            employees={employees}
            members={members}
            onChange={(ref) => onPatch(patchForReviewerRef(ref))}
            role="reviewer"
            disabled={!canEdit}
          />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Due date
        </span>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={due}
            disabled={!canEdit}
            onChange={(e) =>
              onPatch({
                dueAt: e.target.value ? new Date(e.target.value).toISOString() : null,
              })
            }
          />
          {due && canEdit && (
            <button
              onClick={() => onPatch({ dueAt: null })}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="Clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Repeat
        </span>
        <div>
          <RecurrencePicker
            value={todo.recurrence}
            onChange={(r) => onPatch({ recurrence: r })}
            disabled={!canEdit}
          />
        </div>
      </div>

      {todo.status === "in_review" && (
        <ReviewPanel todo={todo} canEdit={canEdit} onPatch={onPatch} />
      )}

      {todo.recurrence !== "none" && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
          <RefreshCw size={13} className="mt-0.5 shrink-0" />
          <span>
            Repeats <b>{RECURRENCE_LABEL[todo.recurrence].toLowerCase()}</b>. When you mark this
            done, a fresh copy will reappear
            {todo.dueAt ? " on its next scheduled date." : " on the next cycle."}
          </span>
        </div>
      )}

      {/* Subtasks — only top-level todos can hold them (one level deep). */}
      {!todo.parentTodoId && (
        <SubtasksSection
          parent={todo}
          subtasks={subtasks}
          project={project}
          companyId={companyId}
          canEdit={canEdit}
          onPatchTodo={onPatchTodo}
          onOpenTodo={onOpenTodo}
          onCreated={onCreated}
        />
      )}

      <CommentThread
        todo={todo}
        employees={employees}
        companyId={companyId}
        companySlug={companySlug}
        canEdit={canEdit}
      />
    </div>
  );
}

/**
 * The board's docked version: the same body, wrapped in the panel chrome the
 * project page has always had. Home skips this and renders `TodoDetailBody`
 * inside a `<Modal>`, which supplies its own title bar and action tray.
 */
export function TodoDetailPanel(props: {
  todo: Todo;
  allTodos: Todo[];
  project: Project;
  employees: Employee[];
  members: Member[];
  companyId: string;
  companySlug: string;
  canEdit: boolean;
  onClose: () => void;
  onPatch: (patch: Partial<Todo>) => void;
  onPatchTodo: (t: Todo, patch: Partial<Todo>) => void;
  onDelete: () => void;
  onOpenTodo: (id: string) => void;
  onCreated: (t: Todo) => void;
}) {
  const { todo, project, canEdit, onClose, onDelete } = props;
  return (
    <aside className="flex w-[460px] shrink-0 flex-col border-l border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {project.key}-{todo.number}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {STATUS_LABEL[todo.status]}
        </span>
        {todo.status === "in_review" && (
          <span className="flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">
            <ShieldCheck size={10} /> Review
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <TodoDetailBody {...props} />
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 dark:border-slate-700">
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          Created {new Date(todo.createdAt).toLocaleDateString()}
        </span>
        {canEdit && (
          <Button variant="danger" size="sm" onClick={onDelete}>
            <Trash2 size={13} /> Delete
          </Button>
        )}
      </div>
    </aside>
  );
}

// ───────────────────────── subtasks section ─────────────────────────────────

/**
 * Subtask checklist inside the peek panel. Each subtask is a real todo —
 * own status, assignee, comments — so rows link into their own peek; this
 * section is the parent-side overview plus a quick-add composer.
 */
export function SubtasksSection({
  parent,
  subtasks,
  project,
  companyId,
  canEdit,
  onPatchTodo,
  onOpenTodo,
  onCreated,
}: {
  parent: Todo;
  subtasks: Todo[];
  project: Project;
  companyId: string;
  canEdit: boolean;
  onPatchTodo: (t: Todo, patch: Partial<Todo>) => void;
  onOpenTodo: (id: string) => void;
  onCreated: (t: Todo) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const done = subtasks.filter((t) => t.status === "done" || t.status === "cancelled").length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      // Assignee intentionally omitted — the server defaults it to the
      // creator, which is the right owner for a step you just wrote down.
      const t = await api.post<Todo>(`/api/companies/${companyId}/projects/${project.slug}/todos`, {
        title: trimmed,
        parentTodoId: parent.id,
      });
      onCreated(t);
      setTitle("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          <ListTree size={12} /> Subtasks
        </span>
        {subtasks.length > 0 && (
          <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
            {done}/{subtasks.length} done
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.round((done / subtasks.length) * 100)}%` }}
          />
        </div>
      )}

      {subtasks.length > 0 && (
        <ul className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          {subtasks.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 border-b border-slate-100 bg-white px-2.5 py-1.5 last:border-b-0 dark:border-slate-800 dark:bg-slate-900"
            >
              <StatusPicker
                value={s.status}
                onChange={(status) => onPatchTodo(s, { status })}
                compact
                disabled={!canEdit}
              />
              <span className="shrink-0 font-mono text-[10px] text-slate-400 dark:text-slate-500">
                {project.key}-{s.number}
              </span>
              <button
                onClick={() => onOpenTodo(s.id)}
                className={clsx(
                  "min-w-0 flex-1 truncate text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-300",
                  s.status === "done" || s.status === "cancelled"
                    ? "text-slate-400 line-through dark:text-slate-500"
                    : "text-slate-900 dark:text-slate-100",
                )}
                title="Open subtask"
              >
                {s.title}
              </button>
              {s.assignee && (
                <span title={`Assignee: ${s.assignee.name}`}>
                  <Avatar
                    name={s.assignee.name}
                    size={18}
                    kind={s.assignee.kind === "ai" ? "ai" : "human"}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <>
          <FormError message={error} className="mt-2" />
          <form onSubmit={add} className="mt-2 flex items-center gap-2">
            <Plus size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a subtask…"
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
            />
            {title.trim() && (
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "…" : "Add"}
              </Button>
            )}
          </form>
        </>
      )}
      {!canEdit && subtasks.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500">No subtasks.</p>
      )}
    </div>
  );
}

// ───────────────────────── review panel ─────────────────────────────────────

/**
 * Shown on the todo peek when `status === "in_review"`. Makes it obvious
 * a reviewer needs to act, and gives two one-click resolutions:
 *   - Approve → mark the todo done
 *   - Push back → send it back to the assignee (status: in_progress)
 */
export function ReviewPanel({
  todo,
  canEdit,
  onPatch,
}: {
  todo: Todo;
  canEdit: boolean;
  onPatch: (patch: Partial<Todo>) => void;
}) {
  const assigneeName = todo.assignee?.name ?? "the assignee";
  const reviewerName = todo.reviewer?.name;
  const assigneeIsAi = todo.assignee?.kind === "ai";

  return (
    <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/70 p-3 text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-semibold">Under review</div>
          <div className="mt-0.5 text-violet-800/90 dark:text-violet-200/90">
            {reviewerName ? (
              <>
                Waiting on <b>{reviewerName}</b> to sign off on work by <b>{assigneeName}</b>.
              </>
            ) : canEdit ? (
              <>
                <b>{assigneeName}</b> finished this task. Pick a reviewer above to assign sign-off,
                or approve it below.
              </>
            ) : (
              <>
                <b>{assigneeName}</b> finished this task. It is waiting on a reviewer.
              </>
            )}
          </div>
        </div>
      </div>
      {/* Both resolutions PATCH the status, so they are writers-only. */}
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => onPatch({ status: "done" })}
            title="Approve and mark this todo done"
          >
            <Check size={13} /> Approve &amp; mark done
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPatch({ status: "in_progress" })}
            title={
              assigneeIsAi
                ? "Send back to the AI assignee for another pass"
                : "Send back to the assignee for another pass"
            }
          >
            <CornerUpLeft size={13} /> Push back {assigneeIsAi ? "to AI" : "to assignee"}
          </Button>
        </div>
      )}
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
export function CommentThread({
  todo,
  employees,
  companyId,
  companySlug,
  canEdit,
}: {
  todo: Todo;
  employees: Employee[];
  companyId: string;
  companySlug: string;
  canEdit: boolean;
}) {
  const background = useBackgroundAction();
  const [comments, setComments] = React.useState<TodoComment[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [body, setBody] = React.useState("");
  const [mentionId, setMentionId] = React.useState<string | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const [resourceQuery, setResourceQuery] = React.useState<string | null>(null);
  const [resourceStart, setResourceStart] = React.useState<number | null>(null);
  const [resourceIndex, setResourceIndex] = React.useState(0);
  const { references, loading: referencesLoading } = useResourceReferences(
    companyId,
    resourceQuery,
  );

  const load = React.useCallback(async () => {
    try {
      const list = await api.get<TodoComment[]>(
        `/api/companies/${companyId}/todos/${todo.id}/comments`,
      );
      setComments(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the discussion"));
      setComments([]);
    }
  }, [companyId, todo.id]);

  React.useEffect(() => {
    setComments(null);
    setLoadError(null);
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

  function submit(withMention: boolean) {
    const text = body.trim();
    if (!text) return;
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: TodoComment = {
      id: optimisticId,
      todoId: todo.id,
      authorUserId: null,
      authorEmployeeId: null,
      body: text,
      pending: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      author: null,
    };
    setComments((current) => [...(current ?? []), optimistic]);
    setBody("");
    requestAnimationFrame(() => {
      scrollerRef.current?.scrollTo({
        top: scrollerRef.current.scrollHeight,
        behavior: "smooth",
      });
    });

    background(
      () =>
        api.post<TodoComment[]>(`/api/companies/${companyId}/todos/${todo.id}/comments`, {
          body: text,
          mentionEmployeeId: withMention ? mentionId : null,
        }),
      {
        title: "Couldn’t post the comment",
        error: (error) => `${errorMessage(error)} Your text has been restored.`,
        onSuccess: (created) => {
          setComments((current) => [
            ...(current ?? []).filter((comment) => comment.id !== optimisticId),
            ...created,
          ]);
        },
        onError: () => {
          setComments(
            (current) => current?.filter((comment) => comment.id !== optimisticId) ?? current,
          );
          setBody((current) => current || text);
        },
      },
    );
  }

  function refreshResourceState(value: string, caret: number) {
    const match = resourceQueryAtCaret(value, caret);
    setResourceQuery(match?.query ?? null);
    setResourceStart(match?.start ?? null);
    setResourceIndex(0);
  }

  function insertReference(reference: ChatResourceReference) {
    const el = composerRef.current;
    if (!el || resourceStart === null) return;
    const inserted = insertResourceReference({
      value: body,
      caret: el.selectionStart ?? body.length,
      start: resourceStart,
      companySlug,
      reference,
    });
    setBody(inserted.value);
    setResourceQuery(null);
    setResourceStart(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
    });
  }

  function remove(c: TodoComment) {
    const originalIndex = comments?.findIndex((comment) => comment.id === c.id) ?? -1;
    setComments((current) => current?.filter((comment) => comment.id !== c.id) ?? current);
    background(() => api.del(`/api/companies/${companyId}/comments/${c.id}`), {
      title: "Couldn’t delete the comment",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setComments((current) => {
          if (!current || current.some((comment) => comment.id === c.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
          return next;
        });
      },
    });
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
        {loadError ? (
          <FormError message={loadError} />
        ) : comments === null ? (
          <div className="flex justify-center py-4">
            <Spinner size={14} />
          </div>
        ) : comments.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {canEdit
              ? "No messages yet. Ping a teammate — @mention an AI employee to loop them in."
              : "No messages yet."}
          </div>
        ) : (
          comments.map((c) => (
            <CommentRow key={c.id} comment={c} canEdit={canEdit} onDelete={remove} />
          ))
        )}
      </div>

      {/* Posting a comment needs write access — the server 403s otherwise. */}
      {canEdit && (
        <div className="relative mt-3 rounded-lg border border-slate-200 bg-white focus-within:border-indigo-400 dark:bg-slate-900 dark:border-slate-700">
          <textarea
            ref={composerRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              refreshResourceState(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) =>
              refreshResourceState(e.currentTarget.value, e.currentTarget.selectionStart)
            }
            onKeyDown={(e) => {
              if (resourceQuery !== null && references.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setResourceIndex((index) => (index + 1) % references.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setResourceIndex((index) => (index - 1 + references.length) % references.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertReference(references[resourceIndex] ?? references[0]);
                  return;
                }
                if (e.key === "Escape") {
                  setResourceQuery(null);
                  return;
                }
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit(!!mentionId);
              }
            }}
            placeholder="Write a message…"
            rows={2}
            className="w-full resize-none rounded-t-lg bg-transparent px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
          {resourceQuery !== null && (
            <ResourceReferencePicker
              references={references}
              loading={referencesLoading}
              activeIndex={resourceIndex}
              onHover={setResourceIndex}
              onPick={insertReference}
              className="absolute bottom-full left-2 right-2 z-20 mb-2"
            />
          )}
          <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
            <MentionPicker value={mentionId} employees={employees} onChange={setMentionId} />
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              <span className="font-mono">#</span> resource
            </span>
            <div className="flex-1" />
            {mentionEmp ? (
              <Button
                size="sm"
                onClick={() => submit(true)}
                disabled={!body.trim()}
                title="Post and ask the AI employee to reply (⌘⏎)"
              >
                <Sparkles size={13} /> Ask {mentionEmp.name.split(" ")[0]}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => submit(false)}
                disabled={!body.trim()}
                title="Post comment (⌘⏎)"
              >
                <Send size={13} /> Send
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  canEdit,
  onDelete,
}: {
  comment: TodoComment;
  canEdit: boolean;
  onDelete: (c: TodoComment) => void;
}) {
  const author = comment.author;
  const optimistic = comment.id.startsWith("optimistic-");
  const name = optimistic ? "You" : (author?.name ?? "Unknown");
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
          {canEdit && !optimistic && (
            <button
              onClick={() => onDelete(comment)}
              title="Delete"
              className="rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100 dark:hover:bg-slate-800"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {comment.pending ? (
          <div className="mt-1 flex items-center gap-2 text-xs italic text-slate-400 dark:text-slate-500">
            <Spinner size={12} />
            Thinking…
          </div>
        ) : (
          <div className="mt-0.5 break-words text-sm text-slate-800 dark:text-slate-100">
            <ChatMarkdown content={comment.body} />
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
              icon={<Avatar name={e.name} size={16} kind="ai" />}
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

/**
 * Lightweight GFM renderer. DOMPurify strips any script-y bits — task bodies
 * are user-controlled so we don't trust them. Matches the chat bubble look.
 */
export function MarkdownView({ source }: { source: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(raw);
  }, [source]);
  return (
    <div
      className="chat-md break-words text-sm text-slate-800 dark:text-slate-100"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Inline description editor with Write/Preview tabs. ⌘/Ctrl+Enter or the
 * Save button commits; Esc cancels. Stays in the peek panel — no modal.
 */
export function DescriptionEditor({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
}) {
  const [tab, setTab] = React.useState<"write" | "preview">("write");
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (tab === "write") ref.current?.focus();
  }, [tab]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-2 py-1 dark:border-slate-800">
        <div className="flex items-center gap-0.5">
          <EditorTab active={tab === "write"} onClick={() => setTab("write")}>
            Write
          </EditorTab>
          <EditorTab active={tab === "preview"} onClick={() => setTab("preview")}>
            Preview
          </EditorTab>
        </div>
        <div className="flex items-center gap-1 pr-1 text-[11px] text-slate-400 dark:text-slate-500">
          <span className="hidden sm:inline">Markdown · ⌘↵ to save</span>
        </div>
      </div>
      {tab === "write" ? (
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onDone();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
          placeholder="Describe the task — supports **markdown**, `code`, lists, links…"
          rows={8}
          spellCheck={false}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[13px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
        />
      ) : (
        <div className="min-h-[120px] px-3 py-2">
          {value.trim() ? (
            <MarkdownView source={value} />
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">
              Nothing to preview yet.
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
        <Button variant="secondary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function EditorTab({
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
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded px-2 py-1 text-xs font-medium",
        active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
      )}
    >
      {children}
    </button>
  );
}
