import React from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Clock,
  FolderGit2,
  GitBranch,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { api, Company, CodeRepository } from "../lib/api";
import { RepoFormModal } from "./CodeRepoForm";
import { useCodeReposContext } from "./CodeReposLayout";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Code — the company's git repositories. Humans add any HTTPS / SSH repo and
 * decide which AI employees may work on it. Before each chat / routine spawn
 * the runner clones every granted repo into the employee's workspace, so the
 * agent uses ordinary `git` to read, commit, and push.
 */
export default function CodeReposIndex({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { reload: reloadSidebar } = useCodeReposContext();
  const [items, setItems] = React.useState<CodeRepository[] | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const reload = React.useCallback(async () => {
    try {
      const rows = await api.get<CodeRepository[]>(
        `/api/companies/${company.id}/code-repositories`,
      );
      setItems(rows);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load repositories",
        "error",
      );
      setItems([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("coderepo", reload);

  const filtered = React.useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      (r.name + " " + r.gitUrl + " " + r.description).toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Code" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pt-12 pb-16">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Code Repositories
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                {company.name}
              </h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Add any git repository — GitHub, GitLab, Bitbucket, or a
                self-hosted server — and grant access to the AI employees you
                want working on it. They get a real checkout to read, commit,
                and push.
              </p>
            </div>
            <Button onClick={() => setShowNew(true)} className="shrink-0">
              <Plus size={16} /> Add repository
            </Button>
          </div>

          {items && items.length > 0 && (
            <div className="relative mb-6">
              <Search
                size={18}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search repositories by name or URL…"
                className="w-full rounded-lg border border-slate-200 bg-white py-3 pl-11 pr-4 text-base text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
              />
            </div>
          )}

          {items === null ? (
            <div className="mt-10 flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : items.length === 0 ? (
            <EmptyHero onAdd={() => setShowNew(true)} />
          ) : filtered && filtered.length === 0 ? (
            <div className="mt-10 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              No repositories match <span className="font-medium">{query}</span>.
            </div>
          ) : (
            <RepoList company={company} items={filtered ?? []} />
          )}
        </div>
      </div>

      <RepoFormModal
        open={showNew}
        company={company}
        onClose={() => setShowNew(false)}
        onSaved={(row) => {
          setShowNew(false);
          reload();
          reloadSidebar();
          navigate(`/c/${company.slug}/code/${row.slug}`);
        }}
      />
    </div>
  );
}

function RepoList({
  company,
  items,
}: {
  company: Company;
  items: CodeRepository[];
}) {
  const navigate = useNavigate();
  return (
    <div className="mt-2">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Clock size={12} />
        {items.length} {items.length === 1 ? "repository" : "repositories"}
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        {items.map((r, i) => (
          <button
            key={r.id}
            onClick={() => navigate(`/c/${company.slug}/code/${r.slug}`)}
            className={
              "group flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60 " +
              (i > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
            }
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <FolderGit2 size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {r.name}
                </span>
                <SyncBadge status={r.lastSyncStatus} />
              </span>
              <span className="mt-0.5 block truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                {r.gitUrl}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={11} /> {r.defaultBranch}
                </span>
                <span aria-hidden>·</span>
                <span className="uppercase">{r.authMode}</span>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Users size={11} /> {r.grantCount}{" "}
                  {r.grantCount === 1 ? "employee" : "employees"}
                </span>
              </span>
            </span>
            <ArrowUpRight
              size={14}
              className="mt-1 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-slate-500 dark:text-slate-600"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyHero({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white px-8 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-200">
        <FolderGit2 size={22} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Give your AI employees a codebase
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Point Genosyn at any git repository and pick which employees can work
        on it. They get a real checkout — read, branch, commit, and push, all
        with ordinary git.
      </p>
      <div className="mt-5">
        <Button onClick={onAdd}>
          <Plus size={16} /> Add your first repository
        </Button>
      </div>
    </div>
  );
}

export function SyncBadge({
  status,
}: {
  status: CodeRepository["lastSyncStatus"];
}) {
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      Untested
    </span>
  );
}
