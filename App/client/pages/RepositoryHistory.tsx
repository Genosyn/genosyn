import React from "react";
import { GitBranch, GitCommitHorizontal, History, RefreshCw, User } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { formatRelative } from "../components/decisions/relative";
import { DiffStats, DiffView } from "../components/repositories/DiffView";
import { api, RepositoryCommit, RepositoryCommitDiff, RepositoryHistoryResponse } from "../lib/api";
import { useRepositoriesContext } from "./RepositoriesLayout";

/**
 * Commit history for the App-owned checkout, with the selected commit's diff
 * beside it.
 *
 * Diffs are loaded on demand rather than with the list: a commit patch is
 * routinely larger than every subject line put together, and someone scanning
 * "what happened last week" reads twenty subjects and opens one of them.
 */

const HISTORY_LIMIT = 100;

export default function RepositoryHistory() {
  const { company, repo } = useRepositoriesContext();
  const { toast } = useToast();

  const base = repo ? `/api/companies/${company.id}/repositories/${repo.slug}` : "";
  const repoId = repo?.id ?? null;

  const [commits, setCommits] = React.useState<RepositoryCommit[] | null>(null);
  const [selectedSha, setSelectedSha] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<RepositoryCommitDiff | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  // Clicking down a long list must not let an earlier, slower diff win.
  const selectTokenRef = React.useRef(0);

  const reload = React.useCallback(async () => {
    if (!base) return;
    try {
      const response = await api.get<RepositoryHistoryResponse>(
        `${base}/workspace/history?limit=${HISTORY_LIMIT}`,
      );
      setCommits(response.commits);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setCommits([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    setCommits(null);
    setSelectedSha(null);
    setDetail(null);
    reload();
  }, [reload]);

  useLiveRefetch("repository", reload, repoId);

  const select = React.useCallback(
    async (sha: string) => {
      if (!base) return;
      const token = selectTokenRef.current + 1;
      selectTokenRef.current = token;
      setSelectedSha(sha);
      setDetail(null);
      setDetailLoading(true);
      try {
        const row = await api.get<RepositoryCommitDiff>(`${base}/workspace/commits/${sha}`);
        if (selectTokenRef.current === token) setDetail(row);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        if (selectTokenRef.current === token) setDetailLoading(false);
      }
    },
    [base, toast],
  );

  async function refresh() {
    setReloading(true);
    try {
      await api.post(`${base}/workspace/refresh`);
      await reload();
      toast("History refreshed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setReloading(false);
    }
  }

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div className="pb-12">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
            <History size={19} />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              History
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              Commits on the branch currently checked out in {repo.name}. Pick one to read its diff.
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={reloading} className="shrink-0">
          {reloading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          Refresh
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-4 lg:flex-row">
        <div className="w-full shrink-0 lg:w-96">
          {commits === null ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : commits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              No commits yet. The first commit from the Files page starts the history.
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              {commits.map((commit, index) => (
                <button
                  key={commit.sha}
                  type="button"
                  onClick={() => void select(commit.sha)}
                  className={
                    "flex w-full items-start gap-3 px-3 py-2.5 text-left transition " +
                    (index > 0 ? "border-t border-slate-100 dark:border-slate-800 " : "") +
                    (selectedSha === commit.sha
                      ? "bg-indigo-50 dark:bg-indigo-500/10"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
                  }
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <GitCommitHorizontal size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {commit.subject || "(no message)"}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400 dark:text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <User size={10} /> {commit.authorName || "unknown"}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{commit.authoredAt ? formatRelative(commit.authoredAt) : "—"}</span>
                      <span aria-hidden>·</span>
                      <span className="font-mono">{commit.shortSha}</span>
                      {commit.parents.length > 1 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            <GitBranch size={10} /> merge
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {selectedSha === null ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center dark:border-slate-700 dark:bg-slate-900">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Select a commit
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                Its full diff loads here, file by file, with the lines it added and removed.
              </p>
            </div>
          ) : detailLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : detail === null ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              That commit&apos;s diff could not be loaded. Try Refresh, or pick another commit.
            </div>
          ) : (
            <div className="min-w-0">
              {detail.commit && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                  <h2 className="break-words text-base font-semibold text-slate-900 dark:text-slate-100">
                    {detail.commit.subject || "(no message)"}
                  </h2>
                  {detail.commit.body.trim() && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300">
                      {detail.commit.body.trim()}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      {detail.commit.authorName}
                      {detail.commit.authorEmail ? ` <${detail.commit.authorEmail}>` : ""}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {detail.commit.authoredAt
                        ? new Date(detail.commit.authoredAt).toLocaleString()
                        : "—"}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{detail.commit.sha}</span>
                  </div>
                  <div className="mt-3">
                    <DiffStats
                      filesChanged={detail.filesChanged}
                      insertions={detail.insertions}
                      deletions={detail.deletions}
                    />
                  </div>
                </div>
              )}
              <DiffView
                patch={detail.patch}
                truncated={detail.truncated}
                emptyMessage="This commit changed no file contents."
                className="mt-3"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
