import React from "react";
import { Link } from "react-router-dom";
import {
  GitPullRequest,
  MessageSquare,
  PlugZap,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import {
  api,
  CodeRepoAccessLevel,
  CodeRepoGrant,
  CodeRepoGrantCandidate,
  CodeRepoGrantsResponse,
} from "../lib/api";
import { useCodeReposContext } from "./CodeReposLayout";

export default function CodeRepoAccess() {
  const { company, repo, reload: reloadRepos } = useCodeReposContext();
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<CodeRepoGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<CodeRepoGrantCandidate[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<CodeRepoAccessLevel>("write");

  const base = repo ? `/api/companies/${company.id}/code-repositories/${repo.slug}` : "";

  const reload = React.useCallback(async () => {
    if (!base) return;
    try {
      const [grantRows, candidateRows] = await Promise.all([
        api.get<CodeRepoGrantsResponse>(`${base}/grants`),
        api.get<CodeRepoGrantCandidate[]>(`${base}/grant-candidates`),
      ]);
      setGrants(grantRows.direct);
      setCandidates(candidateRows);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setGrants([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const ungranted = candidates.filter((candidate) => !candidate.alreadyGranted);

  async function addGrant() {
    if (!pickEmployee) return;
    setAdding(true);
    try {
      await api.post(`${base}/grants`, {
        employeeId: pickEmployee,
        accessLevel: pickLevel,
      });
      setPickEmployee("");
      setPickLevel("write");
      await Promise.all([reload(), reloadRepos()]);
      toast("Access granted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setAdding(false);
    }
  }

  async function changeLevel(grant: CodeRepoGrant, level: CodeRepoAccessLevel) {
    try {
      await api.patch(`${base}/grants/${grant.id}`, { accessLevel: level });
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function revoke(grant: CodeRepoGrant) {
    try {
      await api.del(`${base}/grants/${grant.id}`);
      await Promise.all([reload(), reloadRepos()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <div className="pb-12">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <Users size={19} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Choose who may work in {repo.name}, whether they can push, and who has the GitHub tool
            needed to open a pull request.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <ReadinessCard
          icon={<ShieldCheck size={17} />}
          title="Code tools are built in"
          detail="Every AI employee can inspect files, edit code, run commands, and execute tests."
        />
        <ReadinessCard
          icon={<GitPullRequest size={17} />}
          title="PRs use a GitHub Connection"
          detail="Grant a GitHub Connection to expose the create_pull_request tool after the branch is pushed."
          to={`/c/${company.slug}/settings/integrations`}
          linkLabel="Manage integrations"
        />
      </div>

      <div className="mt-8 rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-end dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <Select
              label="Grant access to"
              value={pickEmployee}
              onChange={(event) => setPickEmployee(event.target.value)}
              disabled={ungranted.length === 0}
            >
              <option value="">
                {ungranted.length === 0
                  ? "All employees already have access"
                  : "Choose an AI employee…"}
              </option>
              {ungranted.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {candidate.role}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-full sm:w-44">
            <Select
              label="Repository access"
              value={pickLevel}
              onChange={(event) => setPickLevel(event.target.value as CodeRepoAccessLevel)}
              disabled={ungranted.length === 0}
            >
              <option value="write">Read &amp; push</option>
              <option value="read">Read only</option>
            </Select>
          </div>
          <Button onClick={addGrant} disabled={adding || !pickEmployee} className="shrink-0">
            {adding ? <Spinner size={14} /> : <UserPlus size={14} />}
            Add
          </Button>
        </div>

        {grants === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : grants.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Users size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              No AI employees have access
            </div>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">
              Add one above. Use Read &amp; push when you want it to deliver a branch or pull
              request.
            </p>
          </div>
        ) : (
          <ul>
            {grants.map((grant, index) => (
              <li
                key={grant.id}
                className={
                  "flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center " +
                  (index > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar
                    name={grant.employee?.name ?? "?"}
                    src={
                      grant.employee
                        ? employeeAvatarUrl(company.id, grant.employee.id, grant.employee.avatarKey)
                        : null
                    }
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {grant.employee?.name ?? "Unknown employee"}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {grant.employee?.role}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <DeliveryBadge grant={grant} />
                  <Select
                    value={grant.accessLevel}
                    onChange={(event) =>
                      changeLevel(grant, event.target.value as CodeRepoAccessLevel)
                    }
                    className="h-9 w-36"
                    aria-label="Repository access level"
                  >
                    <option value="write">Read &amp; push</option>
                    <option value="read">Read only</option>
                  </Select>
                  {grant.employee && (
                    <>
                      <Link
                        to={`/c/${company.slug}/employees/${grant.employee.slug}/chat`}
                        className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                        aria-label={`Chat with ${grant.employee.name}`}
                        title={`Chat with ${grant.employee.name}`}
                      >
                        <MessageSquare size={15} />
                      </Link>
                      {!grant.employee.pullRequestReady && grant.accessLevel === "write" && (
                        <Link
                          to={`/c/${company.slug}/employees/${grant.employee.slug}/connections`}
                          className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          aria-label={`Manage ${grant.employee.name}'s Connections`}
                          title="Grant a GitHub Connection"
                        >
                          <PlugZap size={15} />
                        </Link>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => revoke(grant)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                    aria-label="Revoke repository access"
                    title="Revoke repository access"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReadinessCard({
  icon,
  title,
  detail,
  to,
  linkLabel,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  to?: string;
  linkLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
        <span className="text-indigo-600 dark:text-indigo-300">{icon}</span>
        {title}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</p>
      {to && linkLabel && (
        <Link
          to={to}
          className="mt-2 inline-flex text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
        >
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

function DeliveryBadge({ grant }: { grant: CodeRepoGrant }) {
  if (grant.accessLevel === "read") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        Read only
      </span>
    );
  }
  if (grant.employee?.pullRequestReady) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <GitPullRequest size={11} /> PR ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
      <PlugZap size={11} /> GitHub Connection needed
    </span>
  );
}
