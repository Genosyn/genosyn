import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  FolderGit2,
  Plug,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import {
  api,
  Company,
  CodeRepository,
  CodeRepoAccessLevel,
  CodeRepoGrant,
  CodeRepoGrantCandidate,
  CodeRepoGrantsResponse,
  CodeRepoTestResult,
} from "../lib/api";
import {
  RepoFormFields,
  RepoFormState,
  repoToForm,
  repoFormToPayload,
} from "./CodeRepoForm";
import { SyncBadge } from "./CodeReposIndex";

export default function CodeRepoDetail({ company }: { company: Company }) {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();

  const [repo, setRepo] = React.useState<CodeRepository | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [form, setForm] = React.useState<RepoFormState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<CodeRepoTestResult | null>(
    null,
  );

  const reload = React.useCallback(async () => {
    try {
      const row = await api.get<CodeRepository>(
        `/api/companies/${company.id}/code-repositories/${slug}`,
      );
      setRepo(row);
      setForm(repoToForm(row));
    } catch {
      setNotFound(true);
    }
  }, [company.id, slug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const row = await api.patch<CodeRepository>(
        `/api/companies/${company.id}/code-repositories/${slug}`,
        repoFormToPayload(form),
      );
      setRepo(row);
      setForm(repoToForm(row));
      toast("Saved", "success");
      // Slug never changes on rename, so the URL stays valid.
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<CodeRepoTestResult>(
        `/api/companies/${company.id}/code-repositories/${slug}/test`,
      );
      setTestResult(result);
      // The server stamps lastSyncStatus on test — refresh the badge.
      reload();
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!repo) return;
    const ok = await dialog.confirm({
      title: `Delete ${repo.name}?`,
      message:
        "This removes the repository from Genosyn and revokes every employee's access. The remote git repository itself is untouched.",
      confirmLabel: "Delete repository",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/code-repositories/${slug}`);
      toast("Repository deleted", "success");
      navigate(`/c/${company.slug}/code`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  if (notFound) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Repository not found.
      </div>
    );
  }
  if (!repo || !form) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Code", to: `/c/${company.slug}/code` },
            { label: repo.name },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pt-10 pb-16">
          <div className="mb-6 flex items-start gap-3">
            <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-200">
              <FolderGit2 size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {repo.name}
                </h1>
                <SyncBadge status={repo.lastSyncStatus} />
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                {repo.gitUrl}
              </p>
            </div>
          </div>

          {/* Test connection */}
          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Connection
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Verify Genosyn can reach the repository with the stored
                  credentials.
                </div>
              </div>
              <Button variant="secondary" onClick={test} disabled={testing}>
                {testing ? <Spinner size={14} /> : <Plug size={14} />}
                {testing ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {testResult && (
              <div
                className={
                  "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm " +
                  (testResult.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200"
                    : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200")
                }
              >
                {testResult.ok ? (
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="break-words">{testResult.message}</div>
                  {testResult.ok && testResult.defaultBranch && (
                    <div className="mt-0.5 text-xs opacity-80">
                      Remote default branch:{" "}
                      <span className="font-mono">
                        {testResult.defaultBranch}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {!testResult && repo.lastSyncStatus === "error" && repo.lastSyncError && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0 break-words">{repo.lastSyncError}</div>
              </div>
            )}
          </div>

          {/* Access */}
          <AccessSection company={company} repo={repo} onChanged={reload} />

          {/* Settings */}
          <div className="mt-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Settings
            </h2>
            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
              <RepoFormFields
                form={form}
                setForm={setForm}
                mode="edit"
                hasToken={repo.hasToken}
                hasSshKey={repo.hasSshKey}
              />
              <div className="mt-5 flex justify-end">
                <Button onClick={save} disabled={saving}>
                  {saving && <Spinner size={14} />}
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          </div>

          {/* Danger zone */}
          <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50/40 p-4 dark:border-rose-500/20 dark:bg-rose-500/5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-rose-900 dark:text-rose-200">
                  Delete repository
                </div>
                <div className="text-xs text-rose-700/80 dark:text-rose-300/70">
                  Removes it from Genosyn and revokes all access. The remote is
                  not touched.
                </div>
              </div>
              <Button variant="danger" onClick={remove}>
                <Trash2 size={14} /> Delete
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Access ───────────────────────────────────

function AccessSection({
  company,
  repo,
  onChanged,
}: {
  company: Company;
  repo: CodeRepository;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<CodeRepoGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<
    CodeRepoGrantCandidate[]
  >([]);
  const [adding, setAdding] = React.useState(false);
  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<CodeRepoAccessLevel>("write");

  const base = `/api/companies/${company.id}/code-repositories/${repo.slug}`;

  const reload = React.useCallback(async () => {
    try {
      const [g, c] = await Promise.all([
        api.get<CodeRepoGrantsResponse>(`${base}/grants`),
        api.get<CodeRepoGrantCandidate[]>(`${base}/grant-candidates`),
      ]);
      setGrants(g.direct);
      setCandidates(c);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setGrants([]);
    }
    // base is derived from stable ids; intentionally not a dep to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, repo.slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const ungranted = candidates.filter((c) => !c.alreadyGranted);

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
      await reload();
      onChanged();
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
      await reload();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Users size={14} /> Employee access
      </h2>
      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        {/* Add row */}
        <div className="flex flex-col gap-2 border-b border-slate-100 p-4 sm:flex-row sm:items-end dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <Select
              label="Grant access to"
              value={pickEmployee}
              onChange={(e) => setPickEmployee(e.target.value)}
              disabled={ungranted.length === 0}
            >
              <option value="">
                {ungranted.length === 0
                  ? "All employees already have access"
                  : "Choose an employee…"}
              </option>
              {ungranted.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.role}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-full sm:w-40">
            <Select
              label="Level"
              value={pickLevel}
              onChange={(e) =>
                setPickLevel(e.target.value as CodeRepoAccessLevel)
              }
              disabled={ungranted.length === 0}
            >
              <option value="write">Read &amp; push</option>
              <option value="read">Read only</option>
            </Select>
          </div>
          <Button
            onClick={addGrant}
            disabled={adding || !pickEmployee}
            className="shrink-0"
          >
            {adding ? <Spinner size={14} /> : <UserPlus size={14} />}
            Add
          </Button>
        </div>

        {/* Grant list */}
        {grants === null ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : grants.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No employees have access yet. Add one above so it can start working
            on this repository.
          </div>
        ) : (
          <ul>
            {grants.map((g, i) => (
              <li
                key={g.id}
                className={
                  "flex items-center gap-3 px-4 py-3 " +
                  (i > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
                }
              >
                <Avatar
                  name={g.employee?.name ?? "?"}
                  src={
                    g.employee
                      ? employeeAvatarUrl(
                          company.id,
                          g.employee.id,
                          g.employee.avatarKey,
                        )
                      : null
                  }
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {g.employee?.name ?? "Unknown employee"}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {g.employee?.role}
                  </div>
                </div>
                <Select
                  value={g.accessLevel}
                  onChange={(e) =>
                    changeLevel(g, e.target.value as CodeRepoAccessLevel)
                  }
                  className="h-9 w-36"
                  aria-label="Access level"
                >
                  <option value="write">Read &amp; push</option>
                  <option value="read">Read only</option>
                </Select>
                <button
                  onClick={() => revoke(g)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                  aria-label="Revoke access"
                  title="Revoke access"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
