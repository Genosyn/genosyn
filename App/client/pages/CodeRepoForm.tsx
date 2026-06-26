import React from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import {
  api,
  Company,
  CodeRepository,
  CodeRepoAuthMode,
} from "../lib/api";

/**
 * Shared form fields + create modal for a Code Repository. The detail page
 * reuses {@link RepoFormFields} for in-place editing; the index page uses
 * {@link RepoFormModal} to add a new repo.
 */

export type RepoFormState = {
  name: string;
  gitUrl: string;
  defaultBranch: string;
  description: string;
  authMode: CodeRepoAuthMode;
  httpsUsername: string;
  token: string;
  sshKey: string;
  committerName: string;
  committerEmail: string;
};

export function emptyRepoForm(): RepoFormState {
  return {
    name: "",
    gitUrl: "",
    defaultBranch: "main",
    description: "",
    authMode: "none",
    httpsUsername: "",
    token: "",
    sshKey: "",
    committerName: "",
    committerEmail: "",
  };
}

export function repoToForm(repo: CodeRepository): RepoFormState {
  return {
    name: repo.name,
    gitUrl: repo.gitUrl,
    defaultBranch: repo.defaultBranch,
    description: repo.description,
    authMode: repo.authMode,
    httpsUsername: repo.httpsUsername ?? "",
    token: "",
    sshKey: "",
    committerName: repo.committerName ?? "",
    committerEmail: repo.committerEmail ?? "",
  };
}

/**
 * Build the JSON body for create / patch. Credentials are only sent when the
 * user actually typed one — an empty token / key leaves the stored secret in
 * place on edit (and is rejected by the server's schema on create).
 */
export function repoFormToPayload(
  form: RepoFormState,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    gitUrl: form.gitUrl.trim(),
    defaultBranch: form.defaultBranch.trim() || "main",
    description: form.description.trim(),
    authMode: form.authMode,
    committerName: form.committerName.trim(),
    committerEmail: form.committerEmail.trim(),
  };
  if (form.authMode === "https") body.httpsUsername = form.httpsUsername.trim();
  if (form.token.trim()) body.token = form.token;
  if (form.sshKey.trim()) body.sshKey = form.sshKey;
  return body;
}

export function RepoFormFields({
  form,
  setForm,
  mode,
  hasToken,
  hasSshKey,
}: {
  form: RepoFormState;
  setForm: (next: RepoFormState) => void;
  mode: "create" | "edit";
  hasToken?: boolean;
  hasSshKey?: boolean;
}) {
  const patch = (p: Partial<RepoFormState>) => setForm({ ...form, ...p });

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Name"
        value={form.name}
        onChange={(e) => patch({ name: e.target.value })}
        placeholder="acme-web"
        autoFocus={mode === "create"}
      />
      <Input
        label="Clone URL"
        value={form.gitUrl}
        onChange={(e) => patch({ gitUrl: e.target.value })}
        placeholder="https://github.com/acme/web.git  or  git@github.com:acme/web.git"
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Default branch"
          value={form.defaultBranch}
          onChange={(e) => patch({ defaultBranch: e.target.value })}
          placeholder="main"
        />
        <Select
          label="Authentication"
          value={form.authMode}
          onChange={(e) =>
            patch({ authMode: e.target.value as CodeRepoAuthMode })
          }
        >
          <option value="none">None (public repo)</option>
          <option value="https">HTTPS token / password</option>
          <option value="ssh">SSH private key</option>
        </Select>
      </div>

      {form.authMode === "https" && (
        <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-800/30">
          <Input
            label="Username"
            value={form.httpsUsername}
            onChange={(e) => patch({ httpsUsername: e.target.value })}
            placeholder="x-access-token (GitHub) · oauth2 (GitLab) · your username (Bitbucket)"
          />
          <Input
            label={
              mode === "edit" && hasToken
                ? "Token / password (stored — leave blank to keep)"
                : "Token / password"
            }
            type="password"
            value={form.token}
            onChange={(e) => patch({ token: e.target.value })}
            placeholder="ghp_… / glpat-… / app password"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Use a personal access token with repo read/write scope. It is
            encrypted at rest and handed to git at run time via an environment
            variable — it never lands on disk.
          </p>
        </div>
      )}

      {form.authMode === "ssh" && (
        <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-800/30">
          <Textarea
            label={
              mode === "edit" && hasSshKey
                ? "Private key (stored — leave blank to keep)"
                : "Private key (PEM)"
            }
            value={form.sshKey}
            onChange={(e) => patch({ sshKey: e.target.value })}
            rows={6}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
            className="font-mono text-xs"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Add the matching public key as a deploy key on your git host. The
            private key is encrypted at rest and written to the employee&apos;s
            workspace (gitignored) only while a checkout exists.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Committer name (optional)"
          value={form.committerName}
          onChange={(e) => patch({ committerName: e.target.value })}
          placeholder="Defaults to the employee's name"
        />
        <Input
          label="Committer email (optional)"
          value={form.committerEmail}
          onChange={(e) => patch({ committerEmail: e.target.value })}
          placeholder="Defaults to a derived address"
        />
      </div>

      <Textarea
        label="Description (optional)"
        value={form.description}
        onChange={(e) => patch({ description: e.target.value })}
        rows={2}
        placeholder="What lives here, branch conventions, anything employees should know."
      />
    </div>
  );
}

export function RepoFormModal({
  open,
  company,
  onClose,
  onSaved,
}: {
  open: boolean;
  company: Company;
  onClose: () => void;
  onSaved: (row: CodeRepository) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = React.useState<RepoFormState>(emptyRepoForm());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(emptyRepoForm());
      setBusy(false);
    }
  }, [open]);

  async function submit() {
    if (!form.name.trim()) {
      toast("Give the repository a name.", "error");
      return;
    }
    if (!form.gitUrl.trim()) {
      toast("Add a clone URL.", "error");
      return;
    }
    if (form.authMode === "https" && !form.token.trim()) {
      toast("HTTPS auth needs a token or password.", "error");
      return;
    }
    if (form.authMode === "ssh" && !form.sshKey.trim()) {
      toast("SSH auth needs a private key.", "error");
      return;
    }
    setBusy(true);
    try {
      const row = await api.post<CodeRepository>(
        `/api/companies/${company.id}/code-repositories`,
        repoFormToPayload(form),
      );
      toast("Repository added", "success");
      onSaved(row);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add repository" size="lg">
      <RepoFormFields form={form} setForm={setForm} mode="create" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy && <Spinner size={14} />}
          {busy ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </Modal>
  );
}
