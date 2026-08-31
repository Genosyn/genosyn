import React from "react";
import { useNavigate } from "react-router-dom";
import { GitFork, Settings, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { ConnectForgeModal } from "../components/repositories/ConnectForgeModal";
import { api, Repository } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  RepoCommandFields,
  RepoFormFields,
  RepoFormState,
  repoFormToPayload,
  repoToForm,
} from "./RepositoryForm";
import { useRepositoriesContext } from "./RepositoriesLayout";

export default function RepositorySettings() {
  const { company, repo, reload } = useRepositoriesContext();
  const navigate = useNavigate();
  const dialog = useDialog();
  const [form, setForm] = React.useState<RepoFormState | null>(repo ? repoToForm(repo) : null);
  // What the form looked like when it was last in step with the server. Save is
  // pointless without a difference, and leaving with one is a mistake.
  const [baseline, setBaseline] = React.useState<RepoFormState | null>(
    repo ? repoToForm(repo) : null,
  );
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [connectOpen, setConnectOpen] = React.useState(false);

  React.useEffect(() => {
    setForm(repo ? repoToForm(repo) : null);
    setBaseline(repo ? repoToForm(repo) : null);
  }, [repo]);

  const changed =
    form !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);

  React.useEffect(() => {
    if (!changed && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, saving]);

  if (!repo || !form) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const currentRepo = repo;
  const currentForm = form;
  const isLocal = repo.origin === "local";
  const canConnect = company.role === "owner" || company.role === "admin";

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const row = await api.patch<Repository>(
        `/api/companies/${company.id}/repositories/${currentRepo.slug}`,
        repoFormToPayload(currentForm),
      );
      setForm(repoToForm(row));
      setBaseline(repoToForm(row));
      await reload();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: `Delete ${currentRepo.name}?`,
      message:
        "This removes the repository from Genosyn and revokes every AI employee's access. The remote git repository itself is untouched.",
      confirmLabel: "Delete repository",
      variant: "danger",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await api.del(`/api/companies/${company.id}/repositories/${currentRepo.slug}`);
      await reload();
      navigate(`/c/${company.slug}/repositories`);
    } catch (err) {
      setDeleteError(errorMessage(err));
    }
  }

  return (
    <div className="pb-12">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <Settings size={19} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Settings
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            {isLocal
              ? `Rename ${repo.name}, change what it holds, choose the name its edits are signed with, and decide what AI employees may run here.`
              : `Change where ${repo.name} syncs from, its sign-in details, the name its edits are signed with, and what AI employees may run here.`}
          </p>
        </div>
      </div>

      {isLocal && (
        <div className="mt-7 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <GitFork size={17} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Not connected to a git host
                </div>
                <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                  Genosyn keeps the whole history itself. Connecting it to a git host pushes every
                  commit made here and turns on Push, Pull, and pull requests.
                </p>
              </div>
            </div>
            {canConnect ? (
              <Button variant="secondary" className="shrink-0" onClick={() => setConnectOpen(true)}>
                <GitFork size={15} /> Connect to a git host
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                An owner or admin can connect it.
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-7 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <RepoFormFields
          form={form}
          setForm={setForm}
          mode="edit"
          hasToken={repo.hasToken}
          hasSshKey={repo.hasSshKey}
        />
        <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-700">
          <RepoCommandFields form={form} setForm={setForm} />
        </div>
        <FormError message={saveError} className="mt-6" />
        <div className="mt-6 flex items-center justify-end gap-3">
          {changed && !saving && (
            <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>
          )}
          <Button onClick={save} disabled={saving || !changed}>
            {saving && <Spinner size={14} />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50/40 p-4 dark:border-rose-500/20 dark:bg-rose-500/5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <div className="text-sm font-medium text-rose-900 dark:text-rose-200">
              Delete repository
            </div>
            <div className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-300/70">
              Removes it from Genosyn and revokes all access. The remote is not touched.
            </div>
          </div>
          <Button variant="danger" onClick={remove}>
            <Trash2 size={14} /> Delete repository
          </Button>
        </div>
        <FormError message={deleteError} className="mt-3" />
      </div>

      <ConnectForgeModal
        open={connectOpen}
        company={company}
        repo={currentRepo}
        onClose={() => setConnectOpen(false)}
        onConnected={() => void reload()}
      />
    </div>
  );
}
