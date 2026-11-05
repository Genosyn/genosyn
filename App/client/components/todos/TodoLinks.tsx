import React from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  CircleDot,
  FileText,
  GitBranch,
  LifeBuoy,
  ListTodo,
  Mail,
  Play,
  Receipt,
  ReceiptText,
  Scale,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { useBackgroundAction } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { api, type Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Avatar, StatusIcon, STATUS_LABEL } from "@/components/todos/todoShared";
import {
  TODO_LINK_KIND_LABEL,
  type LinkedTodoView,
  type TodoLinkKind,
  type TodoLinkView,
} from "../../../shared/todoLinks";

const KIND_ICON: Record<TodoLinkKind, LucideIcon> = {
  mail_thread: Mail,
  customer: UserRound,
  contact: UserRound,
  deal: Tags,
  decision: Scale,
  meeting: CalendarDays,
  run: Play,
  work_session: GitBranch,
  estimate: FileText,
  invoice: Receipt,
  bill: ReceiptText,
  ticket: LifeBuoy,
};

/** The words in front of a link: "From email" for where it came from. */
function linkHeading(link: TodoLinkView): string {
  const noun = TODO_LINK_KIND_LABEL[link.kind];
  return link.isSource ? `From ${noun === "Email" ? "email" : noun}` : noun;
}

/**
 * Where a Todo came from and what it is about, at the top of its panel. A link
 * the reader can't open says what kind it is and nothing more, and one whose
 * record has gone keeps its name but has nowhere to go.
 */
export function TodoLinksList({
  todo,
  companyId,
  companySlug,
  canEdit,
}: {
  todo: Pick<Todo, "id" | "links">;
  companyId: string;
  companySlug: string;
  canEdit: boolean;
}) {
  const background = useBackgroundAction();
  // Gone at once; the board's own reload then agrees, or the failure puts it back.
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set());
  const links = (todo.links ?? []).filter((link) => !removed.has(link.id));
  if (links.length === 0) return null;
  const remove = (link: TodoLinkView) => {
    setRemoved((current) => new Set(current).add(link.id));
    background(
      () => api.del(`/api/companies/${companyId}/todos/${todo.id}/links/${link.kind}/${link.targetId}`),
      {
        title: "Could not remove the link",
        onError: () =>
          setRemoved((current) => {
            const next = new Set(current);
            next.delete(link.id);
            return next;
          }),
      },
    );
  };
  return (
    <ul className="mb-3 space-y-1">
      {links.map((link) => {
        const Icon = KIND_ICON[link.kind];
        const name = link.label ?? "You can't open this record";
        return (
          <li key={link.id} className="group flex min-w-0 items-center gap-1.5 text-xs">
            <Icon size={13} aria-hidden className="shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="shrink-0 text-slate-500 dark:text-slate-400">{linkHeading(link)}</span>
            {link.path && link.canRead ? (
              <Link
                to={`/c/${companySlug}${link.path}`}
                title={name}
                className="min-w-0 truncate font-medium text-indigo-600 hover:underline dark:text-indigo-300"
              >
                {name}
              </Link>
            ) : (
              <span title={name} className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                {name}
              </span>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => remove(link)}
                title="Remove link"
                aria-label={`Remove link to ${name}`}
                className="touch-target relative shrink-0 rounded p-0.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 [@media(hover:none)]:opacity-100"
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type LinkedTodosPage = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  todos: LinkedTodoView[];
};

/**
 * The work a record started: the Todos linked to an email thread, Customer,
 * Contact or Deal, limited by the server to Projects this person can open.
 * Says nothing at all when there are none, so a record with no Tasks doesn't
 * grow an empty card.
 */
export function LinkedTodosCard({
  companyId,
  companySlug,
  kind,
  targetId,
  className,
  reloadKey,
}: {
  companyId: string;
  companySlug: string;
  kind: TodoLinkKind;
  targetId: string;
  className?: string;
  /** Bump it to reload now, when this page just created a Todo. */
  reloadKey?: number;
}) {
  const [rows, setRows] = React.useState<LinkedTodoView[]>([]);
  const [total, setTotal] = React.useState(0);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const base = `/api/companies/${companyId}/todo-links?kind=${kind}&targetId=${targetId}`;
  const ticket = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const page = await api.get<LinkedTodosPage>(base);
      if (mine !== ticket.current) return;
      setRows(page.todos);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (mine !== ticket.current) return;
      setError(errorMessage(err, "Could not load the linked tasks."));
    }
  }, [base]);

  React.useEffect(() => {
    setRows([]);
    setTotal(0);
    setCursor(null);
    void load();
  }, [load, reloadKey]);

  useLiveRefetch("todo", () => void load());

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.get<LinkedTodosPage>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setRows((current) => [...current, ...page.todos]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load more tasks."));
    } finally {
      setLoadingMore(false);
    }
  };

  if (!error && rows.length === 0) return null;
  return (
    <section className={className} aria-label="Linked tasks">
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <ListTodo size={14} aria-hidden className="text-slate-400 dark:text-slate-500" />
          Tasks
          {total > 0 && (
            <span className="text-xs font-normal tabular-nums text-slate-500 dark:text-slate-400">
              {total}
            </span>
          )}
        </h2>
        <FormError message={error} className="mb-2" />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((todo) => (
            <li key={todo.id} className="flex min-w-0 items-center gap-2 py-1.5">
              <span title={STATUS_LABEL[todo.status as keyof typeof STATUS_LABEL] ?? todo.status}>
                {todo.status in STATUS_LABEL ? (
                  <StatusIcon status={todo.status as keyof typeof STATUS_LABEL} size={14} />
                ) : (
                  <CircleDot size={14} aria-hidden />
                )}
              </span>
              <span className="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                {todo.key}
              </span>
              <Link
                to={`/c/${companySlug}/tasks/p/${todo.project.slug}?todo=${encodeURIComponent(todo.id)}`}
                title={todo.title}
                className="min-w-0 flex-1 truncate text-sm text-slate-800 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-300"
              >
                {todo.title}
              </Link>
              {todo.assignee && (
                <span title={`Assigned to ${todo.assignee.name}`} className="flex shrink-0 items-center">
                  <Avatar name={todo.assignee.name} size={20} kind={todo.assignee.kind} />
                </span>
              )}
            </li>
          ))}
        </ul>
        {cursor && (
          <div className="mt-2">
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
              Show more
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
