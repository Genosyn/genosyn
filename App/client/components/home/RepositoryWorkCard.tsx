import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight, GitPullRequest } from "lucide-react";
import { api, type Company, type HomeRepositoryWork } from "@/lib/api";
import { repositoryWorkHref } from "@/lib/repositoryWorkLink";
import { errorMessage } from "@/lib/errors";
import { SESSION_STATUS_LABEL } from "@/components/repositories/sessionState";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";

/** Company-wide entry points into the existing Repository review workbench. */
export function RepositoryWorkCard({
  company,
  initialItems,
  initialTotal,
}: {
  company: Company;
  initialItems: HomeRepositoryWork[];
  initialTotal: number;
}) {
  const [items, setItems] = React.useState(initialItems);
  const [total, setTotal] = React.useState(initialTotal);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const offset = React.useRef(initialItems.length);

  // Refresh the expanded window too: live activity elsewhere must not fold
  // this queue back to eight rows, or leave old reviews on its later pages.
  React.useEffect(() => {
    const request = ++generation.current;
    const visibleCount = Math.min(offset.current, initialTotal);
    setError(null);

    function resetToPreview() {
      offset.current = initialItems.length;
      setItems(initialItems);
      setTotal(initialTotal);
      setLoading(false);
    }

    if (visibleCount <= initialItems.length) {
      resetToPreview();
    } else {
      setLoading(true);
      void (async () => {
        try {
          const refreshed = [...initialItems];
          let nextOffset = initialItems.length;
          let nextTotal = initialTotal;
          while (nextOffset < Math.min(visibleCount, nextTotal)) {
            const next = await api.get<{ items: HomeRepositoryWork[]; total: number }>(
              `/api/companies/${company.id}/home/repository-work?offset=${nextOffset}&limit=${Math.min(50, visibleCount - nextOffset)}`,
            );
            if (request !== generation.current) return;
            nextTotal = next.total;
            if (next.items.length === 0) break;
            nextOffset += next.items.length;
            const known = new Set(refreshed.map((item) => item.id));
            refreshed.push(...next.items.filter((item) => !known.has(item.id)));
          }
          if (request !== generation.current) return;
          offset.current = nextOffset;
          setItems(refreshed);
          setTotal(nextTotal);
          setLoading(false);
        } catch (err) {
          if (request !== generation.current) return;
          resetToPreview();
          setError(errorMessage(err, "Could not refresh all repository work."));
        }
      })();
    }
    return () => {
      generation.current += 1;
    };
  }, [company.id, initialItems, initialTotal]);

  async function showMore() {
    const request = generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<{ items: HomeRepositoryWork[]; total: number }>(
        `/api/companies/${company.id}/home/repository-work?offset=${offset.current}&limit=8`,
      );
      if (request !== generation.current) return;
      offset.current += next.items.length;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...next.items.filter((item) => !known.has(item.id))];
      });
      setTotal(next.total);
    } catch (err) {
      if (request !== generation.current) return;
      setError(errorMessage(err, "Could not load more repository work."));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  if (total === 0) return null;
  return (
    <section
      aria-label="Repository AI work"
      className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <GitPullRequest size={17} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Repository AI work
        </h2>
        <span className="rounded-full bg-indigo-50 px-2 text-xs font-semibold tabular-nums text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          {total}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">Needs your attention</span>
        <Link
          to={`/c/${company.slug}/repositories`}
          className="ml-auto flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          All repositories <ChevronRight size={12} />
        </Link>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={repositoryWorkHref(company.slug, {
                repositorySlug: item.repository.slug,
                sessionId: item.id,
              })}
              className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 sm:flex-row sm:items-center sm:gap-4 dark:hover:bg-slate-800/60"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
                  {item.title}
                </p>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <span className="max-w-full truncate font-medium">{item.repository.name}</span>
                  {item.employee && (
                    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                      <span aria-hidden="true">·</span>
                      <Avatar
                        name={item.employee.name}
                        src={employeeAvatarUrl(
                          company.id,
                          item.employee.id,
                          item.employee.avatarKey,
                        )}
                        size={16}
                      />
                      <span className="truncate">{item.employee.name}</span>
                    </span>
                  )}
                  {item.filesChanged > 0 && (
                    <span className="tabular-nums">
                      · {item.filesChanged} {item.filesChanged === 1 ? "file" : "files"} · +
                      {item.insertions} −{item.deletions}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    item.status === "failed"
                      ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {SESSION_STATUS_LABEL[item.status]}
                </span>
                <span className="flex items-center gap-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                  {item.status === "ready" || item.status === "proposed"
                    ? "Review work"
                    : "Open session"}
                  <ChevronRight size={13} />
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {(error || offset.current < total) && (
        <div className="space-y-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <FormError message={error} />
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void showMore()}>
            {loading
              ? "Loading…"
              : error
                ? "Try again"
                : `Show more (${Math.max(0, total - offset.current)} remaining)`}
          </Button>
        </div>
      )}
    </section>
  );
}
