import React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDot,
  Code2,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Plug,
  Users,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useLiveRefetch } from "../components/CompanySocket";
import { api, CodeRepoGrant, CodeRepoGrantsResponse, CodeRepoTestResult } from "../lib/api";
import { SyncBadge } from "./CodeReposIndex";
import { useCodeReposContext } from "./CodeReposLayout";
import { AsyncResourceTagPicker } from "../components/TagPicker";

export default function CodeRepoOverview() {
  const { company, repo, reload } = useCodeReposContext();
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<CodeRepoTestResult | null>(null);
  const [grants, setGrants] = React.useState<CodeRepoGrant[] | null>(null);

  const reloadGrants = React.useCallback(() => {
    if (!repo) return;
    api
      .get<CodeRepoGrantsResponse>(
        `/api/companies/${company.id}/code-repositories/${repo.slug}/grants`,
      )
      .then((response) => setGrants(response.direct))
      .catch(() => setGrants([]));
  }, [company.id, repo]);

  React.useEffect(() => {
    reloadGrants();
  }, [reloadGrants]);

  useLiveRefetch("grant", reloadGrants);

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const currentRepo = repo;
  const base = `/c/${company.slug}/code/${repo.slug}`;
  const writeGrants = grants?.filter((grant) => grant.accessLevel === "write") ?? [];
  const prReady =
    grants?.filter((grant) => grant.accessLevel === "write" && grant.employee?.pullRequestReady) ??
    [];

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<CodeRepoTestResult>(
        `/api/companies/${company.id}/code-repositories/${currentRepo.slug}/test`,
      );
      setTestResult(result);
      await reload();
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="pb-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
            <FolderGit2 size={21} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                {repo.name}
              </h1>
              <SyncBadge status={repo.lastSyncStatus} />
            </div>
            <p className="mt-1 break-all font-mono text-xs text-slate-500 dark:text-slate-400">
              {repo.gitUrl}
            </p>
            {repo.description && (
              <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                {repo.description}
              </p>
            )}
          </div>
        </div>
        <Link to={`${base}/access`} className="shrink-0">
          <Button>
            <Users size={15} /> Manage AI access
          </Button>
        </Link>
      </div>

      <div className="mt-5 max-w-2xl">
        <AsyncResourceTagPicker
          companyId={company.id}
          resourceType="code_repository"
          resourceId={currentRepo.id}
        />
      </div>

      <div className="mt-7 grid gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={<GitBranch size={16} />}
          label="Default branch"
          value={repo.defaultBranch}
        />
        <SummaryCard
          icon={<Users size={16} />}
          label="AI access"
          value={`${repo.grantCount} ${repo.grantCount === 1 ? "employee" : "employees"}`}
        />
        <SummaryCard
          icon={<CircleDot size={16} />}
          label="Authentication"
          value={repo.authMode === "none" ? "Public" : repo.authMode.toUpperCase()}
        />
      </div>

      <section className="mt-8">
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            From request to pull request
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            AI employees have the code tools by default. Repository and GitHub Connection grants
            decide where they may deliver changes.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <WorkflowStep
            number="1"
            icon={<Code2 size={17} />}
            title="Read and edit code"
            detail="Built-in bash, file editing, search, and test tools are available on every run."
            status="Ready"
            ready
          />
          <WorkflowStep
            number="2"
            icon={<GitBranch size={17} />}
            title="Branch, commit, and push"
            detail="A Read & push grant checks out this repository with its credentials and committer identity."
            status={
              grants === null
                ? "Checking…"
                : writeGrants.length > 0
                  ? `${writeGrants.length} ready`
                  : "Grant access"
            }
            ready={writeGrants.length > 0}
          />
          <WorkflowStep
            number="3"
            icon={<GitPullRequest size={17} />}
            title="Open the pull request"
            detail="For GitHub repositories, grant the same employee a connected GitHub Connection to expose the create_pull_request tool."
            status={
              grants === null
                ? "Checking…"
                : prReady.length > 0
                  ? `${prReady.length} ready`
                  : "GitHub grant needed"
            }
            ready={prReady.length > 0}
            last
          />
          <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-800/30 dark:text-slate-300">
            <span>
              Try: “Create a branch, implement this change, run the tests, and send me a draft PR.”
            </span>
            <Link
              to={`${base}/access`}
              className="inline-flex shrink-0 items-center gap-1 font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
            >
              Review readiness <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Connection health
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Verify the clone URL and stored credentials before assigning work.
            </p>
          </div>
          <Button variant="secondary" onClick={test} disabled={testing}>
            {testing ? <Spinner size={14} /> : <Plug size={14} />}
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          {testResult ? (
            <Result result={testResult} />
          ) : repo.lastSyncStatus === "error" && repo.lastSyncError ? (
            <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{repo.lastSyncError}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              {repo.lastSyncStatus === "ok" ? (
                <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Plug size={16} className="text-slate-400" />
              )}
              {repo.lastSyncStatus === "ok"
                ? "The most recent connection check succeeded."
                : "This repository has not been tested yet."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {icon} {label}
      </div>
      <div className="mt-2 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </div>
    </div>
  );
}

function WorkflowStep({
  number,
  icon,
  title,
  detail,
  status,
  ready,
  last = false,
}: {
  number: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
  status: string;
  ready: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={
        "flex items-start gap-3 px-4 py-4 " +
        (!last ? "border-b border-slate-100 dark:border-slate-800" : "")
      }
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Step {number}
          </span>
          <span
            className={
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
              (ready
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")
            }
          >
            {ready && <Check size={10} />} {status}
          </span>
        </div>
        <div className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</div>
      </div>
    </div>
  );
}

function Result({ result }: { result: CodeRepoTestResult }) {
  return (
    <div
      className={
        "flex items-start gap-2 text-sm " +
        (result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")
      }
    >
      {result.ok ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
      ) : (
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
      )}
      <div>
        <div>{result.message}</div>
        {result.ok && result.defaultBranch && (
          <div className="mt-1 text-xs opacity-80">
            Remote default branch: {result.defaultBranch}
          </div>
        )}
      </div>
    </div>
  );
}
