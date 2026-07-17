import React from "react";
import { Outlet, useLocation, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, FolderGit2, KeyRound, LayoutDashboard, Settings, Users } from "lucide-react";
import { Breadcrumbs, ContextualLayout, SidebarLink } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { api, CodeRepository, Company } from "../lib/api";

export type CodeReposOutletCtx = {
  company: Company;
  repo: CodeRepository | null;
  repositories: CodeRepository[];
  reload: () => Promise<void>;
};

const PAGE_LABELS: Record<string, string> = {
  access: "AI access",
  settings: "Settings",
};

/**
 * Repository section shell. The index gets a compact repository switcher;
 * selecting one replaces it with a focused management menu so the repository
 * is split into Overview, AI access, and Settings instead of one long page.
 */
export default function CodeReposLayout({ company }: { company: Company }) {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { toast } = useToast();
  const [repositories, setRepositories] = React.useState<CodeRepository[] | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setRepositories(
        await api.get<CodeRepository[]>(`/api/companies/${company.id}/code-repositories`),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load repositories", "error");
      setRepositories([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const rows = repositories ?? [];
  const repo = slug ? (rows.find((item) => item.slug === slug) ?? null) : null;
  const base = `/c/${company.slug}/code`;
  const repoBase = repo ? `${base}/${repo.slug}` : null;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <FolderGit2 size={14} /> Code repositories
        </div>
      </div>

      {repositories === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={16} />
        </div>
      ) : repo && repoBase ? (
        <nav className="flex-1 overflow-y-auto p-2">
          <SidebarLink to={base} icon={<ArrowLeft size={14} />} label="All repositories" />
          <div className="mx-2 my-3 border-t border-slate-100 dark:border-slate-800" />
          <div className="px-2 pb-2">
            <div className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
              {repo.name}
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">
              {repo.defaultBranch}
            </div>
          </div>
          <SidebarLink to={repoBase} end icon={<LayoutDashboard size={14} />} label="Overview" />
          <SidebarLink to={`${repoBase}/access`} icon={<Users size={14} />} label="AI access" />
          <SidebarLink to={`${repoBase}/settings`} icon={<Settings size={14} />} label="Settings" />
          <div className="mt-4 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Other repositories
          </div>
          {rows
            .filter((item) => item.id !== repo.id)
            .slice(0, 8)
            .map((item) => (
              <SidebarLink
                key={item.id}
                to={`${base}/${item.slug}`}
                icon={<FolderGit2 size={14} />}
                label={item.name}
              />
            ))}
        </nav>
      ) : (
        <nav className="flex-1 overflow-y-auto p-2">
          <SidebarLink
            to={base}
            end
            icon={<LayoutDashboard size={14} />}
            label="All repositories"
          />
          {rows.length > 0 && (
            <div className="mt-4 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Repositories
            </div>
          )}
          {rows.map((item) => (
            <SidebarLink
              key={item.id}
              to={`${base}/${item.slug}`}
              icon={<FolderGit2 size={14} />}
              label={item.name}
            />
          ))}
        </nav>
      )}

      <div className="border-t border-slate-100 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <div className="flex items-start gap-2">
          <KeyRound size={13} className="mt-0.5 shrink-0" />
          Credentials stay encrypted and are never shown to AI employees.
        </div>
      </div>
    </div>
  );

  const trailingSegment = location.pathname.split("/").filter(Boolean).at(-1);
  const pageLabel = trailingSegment ? PAGE_LABELS[trailingSegment] : undefined;

  return (
    <ContextualLayout sidebar={sidebar}>
      {slug ? (
        <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8">
          <div className="mb-5">
            <Breadcrumbs
              items={[
                { label: "Code", to: base },
                {
                  label: repo?.name ?? slug,
                  to: pageLabel && repoBase ? repoBase : undefined,
                },
                ...(pageLabel ? [{ label: pageLabel }] : []),
              ]}
            />
          </div>
          {repositories !== null && !repo ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              Repository not found.
            </div>
          ) : (
            <Outlet
              context={
                {
                  company,
                  repo,
                  repositories: rows,
                  reload,
                } satisfies CodeReposOutletCtx
              }
            />
          )}
        </div>
      ) : (
        <Outlet
          context={
            {
              company,
              repo: null,
              repositories: rows,
              reload,
            } satisfies CodeReposOutletCtx
          }
        />
      )}
    </ContextualLayout>
  );
}

export function useCodeReposContext(): CodeReposOutletCtx {
  return useOutletContext<CodeReposOutletCtx>();
}
