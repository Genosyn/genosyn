import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, ExternalLink, Github, Lock, Globe } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Textarea } from "../ui/Textarea";
import { useToast } from "../ui/Toast";
import {
  Company,
  Repository,
  RepositoryAuthMode,
  RepositoryConnectGithubResult,
  RepositoryConnectRemoteResult,
  RepositoryGithubConnection,
  RepositoryGithubConnectionsResponse,
  api,
} from "../../lib/api";

/**
 * Give a Genosyn-only repository somewhere to live on the internet.
 *
 * Two ways in, because people arrive with two different situations: "make me
 * one" and "I already made one and it is sitting there empty". Both end the
 * same way — the repository gets a remote and its whole history is pushed, so
 * nothing that was written here is left behind.
 *
 * The GitHub path never asks for a credential: it goes through a Connection the
 * company already authorised, which is the only reason it can be a two-field
 * form. The other path has to ask, because a private repository on someone
 * else's server has no such thing to fall back on — but it asks here, in the
 * same request as the URL, rather than sending people to Settings and back.
 */

type Tab = "create" | "existing";

export function ConnectGithubModal({
  open,
  company,
  repo,
  onClose,
  onConnected,
}: {
  open: boolean;
  company: Company;
  repo: Repository;
  onClose: () => void;
  /** Fired once the repository has a remote, so the page behind can refresh. */
  onConnected: () => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = React.useState<Tab>("create");
  const [connections, setConnections] = React.useState<RepositoryGithubConnection[] | null>(null);
  const [connectionId, setConnectionId] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [name, setName] = React.useState(repo.slug);
  const [isPrivate, setIsPrivate] = React.useState(true);
  const [gitUrl, setGitUrl] = React.useState("");
  const [authMode, setAuthMode] = React.useState<RepositoryAuthMode>("none");
  const [httpsUsername, setHttpsUsername] = React.useState("");
  const [token, setToken] = React.useState("");
  const [sshKey, setSshKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ gitUrl: string; htmlUrl: string | null } | null>(
    null,
  );
  /** True while a duplicate name has been reported and not yet changed. */
  const [nameTaken, setNameTaken] = React.useState(false);
  // Read through a ref so the reset effect can consult it without listing it as
  // a dependency — depending on `busy` would re-run the reset the moment a
  // request finished and wipe the success panel it had just produced.
  const busyRef = React.useRef(busy);
  busyRef.current = busy;

  const base = `/api/companies/${company.id}/repositories/${repo.slug}`;
  // Connecting rewrites the remote for everyone, which is the bar the server
  // puts on it too. Both call sites gate the trigger; this is the backstop.
  const canConnect = company.role === "owner" || company.role === "admin";

  /**
   * Closing while a create-and-push is in flight is what makes the double
   * create possible, and it also throws away the only screen that shows the
   * clone URL. Every way out of the modal goes through here.
   */
  function requestClose() {
    if (busy) return;
    onClose();
  }

  // A token and a PEM private key have no business outliving the modal that
  // asked for them; the reset below only runs on the way back in.
  React.useEffect(() => {
    if (open) return;
    setToken("");
    setSshKey("");
  }, [open]);

  React.useEffect(() => {
    // Re-arming the form while its request is still running is what lets the
    // same repository be created on GitHub twice: the server only stores the
    // remote after the push, so both calls pass its "not connected yet" check.
    if (!open || busyRef.current) return;
    setTab("create");
    setOwner("");
    setName(repo.slug);
    setIsPrivate(true);
    setGitUrl("");
    setAuthMode("none");
    setHttpsUsername("");
    setToken("");
    setSshKey("");
    setBusy(false);
    setNameTaken(false);
    setResult(null);
    setConnections(null);
    let cancelled = false;
    api
      .get<RepositoryGithubConnectionsResponse>(`${base}/github-connections`)
      .then((response) => {
        if (cancelled) return;
        setConnections(response.connections);
        setConnectionId(response.connections[0]?.id ?? "");
      })
      .catch(() => {
        // An empty list and a failed list read the same to someone standing
        // here: there is no Connection to pick. The Settings link covers both.
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base, open, repo.slug]);

  function finish(next: { gitUrl: string; htmlUrl: string | null }) {
    setResult(next);
    onConnected();
  }

  async function createOnGithub() {
    const trimmedName = name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(trimmedName)) {
      toast("Repository names can use letters, numbers, dot, dash, and underscore.", "error");
      return;
    }
    if (owner.trim() && !/^[A-Za-z0-9-]+$/.test(owner.trim())) {
      toast("An organisation name can use letters, numbers, and dashes.", "error");
      return;
    }
    setBusy(true);
    setNameTaken(false);
    try {
      const response = await api.post<RepositoryConnectGithubResult>(
        `${base}/workspace/connect-github`,
        {
          connectionId,
          name: trimmedName,
          ...(owner.trim() ? { owner: owner.trim() } : {}),
          private: isPrivate,
        },
      );
      finish({ gitUrl: response.gitUrl, htmlUrl: response.htmlUrl });
      toast(response.pushed ? "Connected and pushed" : "Connected", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Creating the repository can succeed and the push that follows can
      // still fail, and the remote is only stored after the push — so the
      // obvious retry hits GitHub's duplicate-name error forever. The empty
      // repository that was just made is exactly what the other tab wants.
      setNameTaken(/already exists/i.test(message));
      toast(message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function connectExisting() {
    const trimmed = gitUrl.trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(trimmed)) {
      toast("Paste the repository's HTTPS or SSH URL.", "error");
      return;
    }
    if (authMode === "https" && !token.trim()) {
      toast("A token or password is needed to push over HTTPS.", "error");
      return;
    }
    if (authMode === "ssh" && !sshKey.trim()) {
      toast("A private key is needed to push over SSH.", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await api.post<RepositoryConnectRemoteResult>(
        `${base}/workspace/connect-remote`,
        {
          gitUrl: trimmed,
          // Only sent when the person picked one; the server treats an absent
          // authMode as "none" and stores no credential.
          ...(authMode === "none"
            ? {}
            : authMode === "https"
              ? { authMode, httpsUsername: httpsUsername.trim(), token }
              : { authMode, sshKey }),
        },
      );
      finish({ gitUrl: response.gitUrl, htmlUrl: null });
      toast(response.pushed ? "Connected and pushed" : "Connected", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const noConnections = connections !== null && connections.length === 0;

  return (
    <Modal open={open} onClose={requestClose} title="Connect to GitHub" size="lg">
      {result ? (
        <Connected result={result} onClose={requestClose} />
      ) : !canConnect ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-400">
          Connecting this repository to a git host changes where it lives for everyone, so an owner
          or an admin has to do it.
        </div>
      ) : (
        <>
          <div className="mb-5 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <TabButton active={tab === "create"} onClick={() => setTab("create")} disabled={busy}>
              Create it for me
            </TabButton>
            <TabButton
              active={tab === "existing"}
              onClick={() => setTab("existing")}
              disabled={busy}
            >
              I already have one
            </TabButton>
          </div>

          {tab === "create" ? (
            connections === null ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner size={20} />
              </div>
            ) : noConnections ? (
              <NoConnections companySlug={company.slug} onClose={requestClose} />
            ) : (
              <div className="flex flex-col gap-4">
                <Select
                  label="GitHub account"
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                  disabled={busy}
                >
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.accountLogin
                        ? `${connection.label} — ${connection.accountLogin}`
                        : connection.label}
                    </option>
                  ))}
                </Select>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="Organisation (optional)"
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                    placeholder="Leave blank for your own account"
                    disabled={busy}
                  />
                  <Input
                    label="Repository name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={repo.slug}
                    disabled={busy}
                  />
                </div>

                <div>
                  <div className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
                    Who can see it
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <VisibilityChoice
                      selected={isPrivate}
                      onClick={() => setIsPrivate(true)}
                      disabled={busy}
                      icon={<Lock size={14} />}
                      title="Private"
                      blurb="Only people you invite on GitHub."
                    />
                    <VisibilityChoice
                      selected={!isPrivate}
                      onClick={() => setIsPrivate(false)}
                      disabled={busy}
                      icon={<Globe size={14} />}
                      title="Public"
                      blurb="Anyone on the internet can read it."
                    />
                  </div>
                </div>

                {nameTaken && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
                    That name is already taken on this account. If Genosyn created it a moment ago
                    and only the push failed, the repository is sitting there empty — switch to{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setTab("existing");
                        setNameTaken(false);
                      }}
                      className="font-medium underline underline-offset-2"
                    >
                      I already have one
                    </button>{" "}
                    and paste its URL. Otherwise pick a different name.
                  </div>
                )}

                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Genosyn creates the repository through the Connection above and pushes everything
                  already committed here. Nothing is deleted, and the files stay editable in Genosyn
                  afterwards.
                </p>

                <div className="flex items-center justify-end gap-2">
                  {busy && (
                    <span className="mr-auto text-xs text-slate-500 dark:text-slate-400">
                      Creating the repository, pushing history…
                    </span>
                  )}
                  <Button variant="secondary" onClick={requestClose} disabled={busy}>
                    Cancel
                  </Button>
                  <Button onClick={createOnGithub} disabled={busy || !connectionId}>
                    {busy ? <Spinner size={14} /> : <Github size={14} />}
                    {busy ? "Connecting…" : "Create and push"}
                  </Button>
                </div>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-4">
              {/* A hard precondition stated after the fields it invalidates is
                only discovered server-side, once the credentials are already
                typed. It goes first. */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-300">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  The repository has to be empty.
                </span>{" "}
                Genosyn pushes this history into it and will not overwrite work that is already
                there. GitHub, GitLab, Bitbucket, Gitea, or your own server all work.
              </div>
              <Input
                label="Repository URL"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder="https://github.com/acme/handbook.git"
                disabled={busy}
              />

              <Select
                label="Sign-in"
                value={authMode}
                onChange={(event) => setAuthMode(event.target.value as RepositoryAuthMode)}
                disabled={busy}
              >
                <option value="none">None needed — it&apos;s public or open to me</option>
                <option value="https">Token or password</option>
                <option value="ssh">SSH private key</option>
              </Select>

              {authMode === "https" && (
                <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-800/30">
                  <Input
                    label="Username"
                    value={httpsUsername}
                    onChange={(event) => setHttpsUsername(event.target.value)}
                    placeholder="x-access-token (GitHub) · oauth2 (GitLab) · your username"
                    disabled={busy}
                  />
                  <Input
                    label="Token or password"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="ghp_… / glpat-… / app password"
                    disabled={busy}
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Encrypted at rest, used only inside a server-owned git command, and never handed
                    to an AI employee.
                  </p>
                </div>
              )}

              {authMode === "ssh" && (
                <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-800/30">
                  <Textarea
                    label="Private key (PEM)"
                    value={sshKey}
                    onChange={(event) => setSshKey(event.target.value)}
                    rows={5}
                    placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
                    className="font-mono text-xs"
                    disabled={busy}
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Add the matching public key as a deploy key on your git host first.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                {busy && (
                  <span className="mr-auto text-xs text-slate-500 dark:text-slate-400">
                    Pushing history…
                  </span>
                )}
                <Button variant="secondary" onClick={requestClose} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={connectExisting} disabled={busy || !gitUrl.trim()}>
                  {busy ? <Spinner size={14} /> : <ArrowRight size={14} />}
                  {busy ? "Connecting…" : "Connect and push"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60 " +
        (active
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100"
          : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}

function VisibilityChoice({
  selected,
  disabled,
  onClick,
  icon,
  title,
  blurb,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  blurb: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={
        "rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 " +
        (selected
          ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-500/10"
          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600")
      }
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
        {icon} {title}
      </span>
      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{blurb}</span>
    </button>
  );
}

function NoConnections({ companySlug, onClose }: { companySlug: string; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-8 text-center dark:border-slate-700 dark:bg-slate-800/30">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300">
        <Github size={19} />
      </div>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        No GitHub account is connected yet
      </h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
        Connect GitHub once for the whole company and Genosyn can create repositories for you
        without ever asking for a token here.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Link to={`/c/${companySlug}/settings/integrations`} onClick={onClose}>
          <Button variant="secondary">
            Connect GitHub in Settings <ArrowRight size={14} />
          </Button>
        </Link>
      </div>
      <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
        Already have an empty repository somewhere? Use the other tab and paste its URL.
      </p>
    </div>
  );
}

function Connected({
  result,
  onClose,
}: {
  result: { gitUrl: string; htmlUrl: string | null };
  onClose: () => void;
}) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
        <CheckCircle2 size={22} />
      </div>
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
        {result.htmlUrl ? "It’s on GitHub" : "It’s connected"}
      </h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
        Every commit made here has been pushed. Keep editing in Genosyn — the Push button on the
        Files page sends new commits along.
      </p>
      <div className="mt-4 break-all rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 font-mono text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
        {result.gitUrl}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {result.htmlUrl && (
          <a href={result.htmlUrl} target="_blank" rel="noreferrer noopener">
            <Button variant="secondary">
              Open on GitHub <ExternalLink size={14} />
            </Button>
          </a>
        )}
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
