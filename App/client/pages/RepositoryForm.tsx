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
  Repository,
  RepositoryAuthMode,
  RepositoryKind,
  RepositoryOrigin,
} from "../lib/api";

/**
 * Shared form fields + create modal for a Repository. The detail page
 * reuses {@link RepoFormFields} for in-place editing; the index page uses
 * {@link RepoFormModal} to add a new repo.
 */

export type RepoFormState = {
  name: string;
  origin: RepositoryOrigin;
  kind: RepositoryKind;
  gitUrl: string;
  defaultBranch: string;
  description: string;
  authMode: RepositoryAuthMode;
  httpsUsername: string;
  token: string;
  sshKey: string;
  committerName: string;
  committerEmail: string;
};

export function emptyRepoForm(): RepoFormState {
  return {
    name: "",
    origin: "remote",
    kind: "code",
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

export function repoToForm(repo: Repository): RepoFormState {
  return {
    name: repo.name,
    origin: repo.origin,
    kind: repo.kind,
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
export function repoFormToPayload(form: RepoFormState): Record<string, unknown> {
  const local = form.origin === "local";
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    kind: form.kind,
    // A local repository has no remote, so it can carry neither a URL nor a
    // credential. The server enforces this too; sending them would just earn a
    // validation error the person cannot act on.
    gitUrl: local ? "" : form.gitUrl.trim(),
    defaultBranch: form.defaultBranch.trim() || "main",
    description: form.description.trim(),
    authMode: local ? "none" : form.authMode,
    committerName: form.committerName.trim(),
    committerEmail: form.committerEmail.trim(),
  };
  if (!local) {
    if (form.authMode === "https") body.httpsUsername = form.httpsUsername.trim();
    if (form.token.trim()) body.token = form.token;
    if (form.sshKey.trim()) body.sshKey = form.sshKey;
  }
  return body;
}

export function repoCreatePayload(form: RepoFormState): Record<string, unknown> {
  return { ...repoFormToPayload(form), origin: form.origin };
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
      {mode === "create" && (
        <OriginChoice value={form.origin} onChange={(origin) => patch({ origin })} />
      )}

      <Select
        label="What's in it"
        value={form.kind}
        onChange={(e) => patch({ kind: e.target.value as RepositoryKind })}
      >
        <option value="code">Code</option>
        <option value="documents">Documents</option>
      </Select>
      <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">
        Just a hint — any file can live in either. It decides whether documents open formatted or as
        raw text.
      </p>

      {form.origin === "remote" && (
        <Input
          label="Clone URL"
          value={form.gitUrl}
          onChange={(e) => patch({ gitUrl: e.target.value })}
          placeholder="https://github.com/acme/web.git  or  git@github.com:acme/web.git"
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label={form.origin === "local" ? "Starting branch" : "Default branch"}
          value={form.defaultBranch}
          onChange={(e) => patch({ defaultBranch: e.target.value })}
          placeholder="main"
        />
        {form.origin === "remote" && (
          /* The same field is called "Sign-in" in the Connect-to-GitHub modal
            and on the Overview card; three names for one thing is two too many,
            and "None / GitHub Connection" was an implementation note. */
          <Select
            label="Sign-in"
            value={form.authMode}
            onChange={(e) => patch({ authMode: e.target.value as RepositoryAuthMode })}
          >
            <option value="none">
              None needed — it&apos;s public, or GitHub is already connected
            </option>
            <option value="https">Token or password</option>
            <option value="ssh">SSH private key</option>
          </Select>
        )}
      </div>

      {form.origin === "local" && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {/* Settings has no clone-URL field for a local repository — it has a
            Connect to GitHub card. Pointing at a field that is not there sends
            people hunting. */}
          Genosyn creates the repository and keeps its whole history here. Nothing to sign in to.
          You can publish it to GitHub any time from the repository&apos;s Settings.
        </p>
      )}

      {form.origin === "remote" && form.authMode === "none" && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Public repositories clone anonymously. For an HTTPS GitHub URL, Genosyn can reuse the
          company&apos;s pinned or sole GitHub Connection. Grant that Connection to an AI employee
          too when it should receive its own checkout.
        </p>
      )}

      {form.origin === "remote" && form.authMode === "https" && (
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
            Use the narrowest repository-scoped token available. It is encrypted at rest and
            decrypted only inside a short-lived, server-owned git operation — never into AI tools or
            the checkout.
          </p>
        </div>
      )}

      {form.origin === "remote" && form.authMode === "ssh" && (
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
            Add the matching public key as a deploy key on your git host. The private key is
            encrypted at rest and materialized only in an App-private temporary directory during
            clone or refresh.
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

/**
 * Connect an existing repository, or start an empty one.
 *
 * Offered only at create time. Afterwards the choice is expressed by whether
 * the repository has a clone URL, which the settings page edits directly —
 * two controls that could disagree about the same fact would be worse than
 * one.
 */
function OriginChoice({
  value,
  onChange,
}: {
  value: RepositoryOrigin;
  onChange: (next: RepositoryOrigin) => void;
}) {
  const options: { value: RepositoryOrigin; title: string; blurb: string }[] = [
    {
      value: "remote",
      title: "Connect a repository",
      blurb: "Clone an existing repo from GitHub, GitLab, Bitbucket, or your own server.",
    },
    {
      value: "local",
      title: "Start an empty one",
      blurb: "Genosyn keeps the history. No git host, no credentials — good for documents.",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={
              "rounded-xl border px-4 py-3 text-left transition " +
              (selected
                ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-500/10"
                : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600")
            }
          >
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
              {option.title}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {option.blurb}
            </span>
          </button>
        );
      })}
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
  onSaved: (row: Repository) => void;
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
    // A local repository has nothing to clone from and nothing to authenticate
    // to, so none of the remote checks apply to it.
    if (form.origin === "remote" && !form.gitUrl.trim()) {
      toast("Add a clone URL.", "error");
      return;
    }
    if (form.origin === "remote" && form.authMode === "https" && !form.token.trim()) {
      toast("HTTPS auth needs a token or password.", "error");
      return;
    }
    if (form.origin === "remote" && form.authMode === "ssh" && !form.sshKey.trim()) {
      toast("SSH auth needs a private key.", "error");
      return;
    }
    setBusy(true);
    try {
      const row = await api.post<Repository>(
        `/api/companies/${company.id}/repositories`,
        repoCreatePayload(form),
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
