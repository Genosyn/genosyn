import React from "react";
import { useNavigate } from "react-router-dom";
import { Settings, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { api, CodeRepository } from "../lib/api";
import { RepoFormFields, RepoFormState, repoFormToPayload, repoToForm } from "./CodeRepoForm";
import { useCodeReposContext } from "./CodeReposLayout";

export default function CodeRepoSettings() {
  const { company, repo, reload } = useCodeReposContext();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [form, setForm] = React.useState<RepoFormState | null>(repo ? repoToForm(repo) : null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setForm(repo ? repoToForm(repo) : null);
  }, [repo]);

  if (!repo || !form) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const currentRepo = repo;
  const currentForm = form;

  async function save() {
    setSaving(true);
    try {
      const row = await api.patch<CodeRepository>(
        `/api/companies/${company.id}/code-repositories/${currentRepo.slug}`,
        repoFormToPayload(currentForm),
      );
      setForm(repoToForm(row));
      await reload();
      toast("Repository settings saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
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
    try {
      await api.del(
        `/api/companies/${company.id}/code-repositories/${currentRepo.slug}`,
      );
      toast("Repository deleted", "success");
      await reload();
      navigate(`/c/${company.slug}/code`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
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
            Update the clone URL, credentials, branch, and commit identity for {repo.name}.
          </p>
        </div>
      </div>

      <div className="mt-7 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
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
      </div>
    </div>
  );
}
