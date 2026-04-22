import React from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Bot,
  Check,
  CornerUpLeft,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, Company, ReviewItem } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useTasks } from "./TasksLayout";
import { clsx } from "../components/ui/clsx";

/**
 * Human reviewer inbox — one card per `in_review` todo across every project
 * in the company. Built for speed: each card shows the work (description,
 * assignee, project context) and the two one-click resolutions (approve →
 * done, push back → in_progress). No modals, no navigation required.
 */
export default function TasksReview({ company }: { company: Company }) {
  const { toast } = useToast();
  const { reload: reloadSidebar } = useTasks();
  const [items, setItems] = React.useState<ReviewItem[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<{ todos: ReviewItem[] }>(
        `/api/companies/${company.id}/reviews`,
      );
      setItems(d.todos);
    } catch (err) {
      toast((err as Error).message, "error");
      setItems([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function resolve(t: ReviewItem, status: "done" | "in_progress") {
    setBusyId(t.id);
    try {
      await api.patch(`/api/companies/${company.id}/todos/${t.id}`, { status });
      // Remove from the queue; it no longer qualifies as in_review.
      setItems((list) => (list ? list.filter((x) => x.id !== t.id) : list));
      reloadSidebar();
      toast(
        status === "done" ? "Approved and marked done." : "Sent back for more work.",
        "success",
      );
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs
          items={[
            { label: "Tasks", to: `/c/${company.slug}/tasks` },
            { label: "Review queue" },
          ]}
        />
        <div className="mt-1 flex items-center gap-2">
          <ShieldCheck size={18} className="text-violet-500" />
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Review queue
          </h1>
          {items && items.length > 0 && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">
              {items.length}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Every todo waiting on sign-off, across all projects. Approve to mark
          done, or push back to the assignee for another pass.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {items === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyQueue />
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-4">
            {items.map((t) => (
              <ReviewCard
                key={t.id}
                item={t}
                company={company}
                busy={busyId === t.id}
                onApprove={() => resolve(t, "done")}
                onPushBack={() => resolve(t, "in_progress")}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyQueue() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
        <Check size={20} />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
        All clear
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Nothing is waiting on a reviewer. When an assignee moves a todo to
        &ldquo;In review&rdquo;, it will land here.
      </p>
    </div>
  );
}

function ReviewCard({
  item,
  company,
  busy,
  onApprove,
  onPushBack,
}: {
  item: ReviewItem;
  company: Company;
  busy: boolean;
  onApprove: () => void;
  onPushBack: () => void;
}) {
  const navigate = useNavigate();
  const waitingSince = formatRelative(item.updatedAt);
  const openInProject = () => {
    if (!item.project) return;
    navigate(`/c/${company.slug}/tasks/p/${item.project.slug}`);
  };

  return (
    <li className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        {item.project && (
          <Link
            to={`/c/${company.slug}/tasks/p/${item.project.slug}`}
            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            title={item.project.name}
          >
            {item.project.key}-{item.number}
          </Link>
        )}
        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {item.title}
        </span>
        <span className="ml-auto flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">
          <ShieldCheck size={10} /> In review
        </span>
        {waitingSince && (
          <span
            className="text-[11px] text-slate-400 dark:text-slate-500"
            title={new Date(item.updatedAt).toLocaleString()}
          >
            {waitingSince}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        {item.description.trim() ? (
          <MarkdownBlock source={item.description} />
        ) : (
          <p className="text-sm italic text-slate-400 dark:text-slate-500">
            No description. Open the task for the comment thread.
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <PersonLine
            label="Assignee"
            person={item.assignee}
            placeholder="Unassigned"
          />
          <PersonLine
            label="Reviewer"
            person={item.reviewer}
            placeholder="No reviewer"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
        <Button size="sm" onClick={onApprove} disabled={busy}>
          <Check size={13} /> Approve &amp; mark done
        </Button>
        <Button variant="secondary" size="sm" onClick={onPushBack} disabled={busy}>
          <CornerUpLeft size={13} /> Push back
          {item.assignee?.kind === "ai" ? " to AI" : " to assignee"}
        </Button>
        <button
          onClick={openInProject}
          className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          title="Open in project"
        >
          Open in project <ArrowUpRight size={12} />
        </button>
      </div>
    </li>
  );
}

function PersonLine({
  label,
  person,
  placeholder,
}: {
  label: string;
  person: { kind: "ai" | "human"; name: string } | null;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {label}
      </span>
      {person ? (
        <span className="flex items-center gap-1.5">
          <PersonAvatar kind={person.kind} name={person.name} />
          <span className="truncate text-sm text-slate-700 dark:text-slate-200">
            {person.name}
          </span>
          {person.kind === "ai" && (
            <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">
              AI
            </span>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-slate-400 dark:text-slate-500">
          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-slate-300 dark:border-slate-600">
            <UserIcon size={10} />
          </div>
          {placeholder}
        </span>
      )}
    </div>
  );
}

function PersonAvatar({ kind, name }: { kind: "ai" | "human"; name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={clsx(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        kind === "ai"
          ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
          : "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200",
      )}
    >
      {kind === "ai" ? <Bot size={11} /> : initials || "?"}
    </span>
  );
}

function MarkdownBlock({ source }: { source: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source, {
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

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}
