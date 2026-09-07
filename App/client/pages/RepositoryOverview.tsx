import React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FileCode,
  Code2,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  Plug,
  Terminal,
  Users,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useLiveRefetch } from "../components/CompanySocket";
import { ConnectForgeModal } from "../components/repositories/ConnectForgeModal";
import { MarkdownPreview } from "../components/repositories/MarkdownPreview";
import { AiWorkOverview } from "../components/repositories/AiWorkOverview";
import { repositoryAiGlanceOf } from "../components/repositories/aiOverview";
import {
  api,
  RepositoryAiOverview,
  RepositoryCommandMode,
  RepositoryFileContent,
  RepositoryGrant,
  RepositoryGrantsResponse,
  RepositoryTestResult,
  RepositoryTreeResponse,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { SyncBadge, signInLabel } from "./RepositoriesIndex";
import { useRepositoriesContext } from "./RepositoriesLayout";
import { AsyncResourceTagPicker } from "../components/TagPicker";

/** What the Settings page's three choices are called on a summary card. */
const COMMAND_MODE_LABEL: Record<RepositoryCommandMode, string> = {
  off: "None",
  allowlist: "Allowed only",
  all: "Any command",
};

/**
 * A Repository, opened.
 *
 * This page used to answer "what is this repository": the default branch, the
 * sign-in mode, the command mode, a grant count, and a three-step explainer of
 * a workflow the reader had used forty times. Every one of those is a setting
 * somebody chose once. Nothing on the page moved between visits, which on a
 * product whose entire premise is that AI employees do the work made the first
 * screen of a repository the least informative one in the section.
 *
 * So the subject is the work now. Who is working here this minute and on what,
 * what has come back and is waiting for a person to decide, what AI work has
 * actually been accepted into the repository, and which employee did it. The
 * settings are still here — they are one disclosure down, under
 * &ldquo;Repository details&rdquo;, where a fact you need twice a quarter
 * belongs.
 *
 * The set-up explainer survives too, and only for as long as it is true: a
 * repository nobody can work in still needs to be told what to grant.
 */
export default function RepositoryOverview() {
  const { company, repo, reload } = useRepositoriesContext();
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<RepositoryTestResult | null>(null);
  const [grants, setGrants] = React.useState<RepositoryGrant[] | null>(null);
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [overview, setOverview] = React.useState<RepositoryAiOverview | null>(null);
  const [overviewError, setOverviewError] = React.useState<string | null>(null);
  /**
   * Which digest read is the current one.
   *
   * Both reads here are refetched by a socket frame, and the AI-work one is
   * refetched on every activity event of a running turn — so two are regularly
   * in flight at once, and switching repositories leaves an older one still
   * running against the page that replaced it. Without this counter the slower
   * answer wins and the page shows another repository's work.
   */
  const overviewRequest = React.useRef(0);
  /** Settings are a reference, not a headline. Closed until somebody asks. */
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  /** Only consulted once every step is green; before that the steps are the point. */
  const [stepsOpen, setStepsOpen] = React.useState(false);
  /** `null` = there is no README; `undefined` = we have not looked yet. */
  const [readmeName, setReadmeName] = React.useState<string | null | undefined>(undefined);
  const [readme, setReadme] = React.useState<string | null>(null);

  const repoSlug = repo?.slug ?? null;
  const repoId = repo?.id ?? null;

  /**
   * Who may work here.
   *
   * A failure leaves `grants` null rather than empty. They used to be the same
   * thing, which was survivable while the list only tinted a badge — but the
   * page now says "No AI employee has access yet" and asks the reader to go
   * and grant one, and printing that because a request failed sends somebody
   * to fix a problem they do not have. Keyed on the slug, not the whole
   * `repo` object: the layout rebuilds that array on every repository frame,
   * and depending on it refetched the grants each time.
   */
  const reloadGrants = React.useCallback(() => {
    if (!repoSlug) return;
    api
      .get<RepositoryGrantsResponse>(`/api/companies/${company.id}/repositories/${repoSlug}/grants`)
      .then((response) => setGrants(response.direct))
      .catch(() => setGrants(null));
  }, [company.id, repoSlug]);

  /**
   * The AI work digest. Read separately from the grants because the two answer
   * different questions and fail independently: a broken grants read must not
   * blank the work, and vice versa.
   */
  const reloadOverview = React.useCallback(async () => {
    if (!repoSlug) return;
    const request = ++overviewRequest.current;
    try {
      const next = await api.get<RepositoryAiOverview>(
        `/api/companies/${company.id}/repositories/${repoSlug}/ai-overview`,
      );
      if (request !== overviewRequest.current) return;
      setOverview(next);
      setOverviewError(null);
    } catch (err) {
      if (request !== overviewRequest.current) return;
      setOverviewError(errorMessage(err, "Could not load the AI work here"));
    }
  }, [company.id, repoSlug]);

  React.useEffect(() => {
    reloadGrants();
  }, [reloadGrants]);

  React.useEffect(() => {
    overviewRequest.current += 1;
    setOverview(null);
    setOverviewError(null);
    setGrants(null);
    // A connection result belongs to the repository it was run against. The
    // component is reused across `:slug` navigations, so without this the
    // previous repository's answer is still on screen under the new name.
    setTestResult(null);
    setDetailsOpen(false);
    void reloadOverview();
  }, [reloadOverview]);

  useLiveRefetch("grant", reloadGrants);
  // Scoped to this repository: every session, turn, and activity event the
  // server writes announces itself as a `repository` change, which is exactly
  // what makes a running turn readable here without a poll.
  useLiveRefetch("repository", reloadOverview, repoId);

  /**
   * Show the README the way every git host does. The root listing comes first
   * because the file is `README.md` on one repository and `readme.md` on the
   * next; asking for a name that is not there is an ordinary answer here and
   * must never surface as an error.
   */
  React.useEffect(() => {
    if (!repoSlug) return;
    setReadmeName(undefined);
    setReadme(null);
    let cancelled = false;
    const base = `/api/companies/${company.id}/repositories/${repoSlug}`;
    api
      .get<RepositoryTreeResponse>(`${base}/workspace/tree?path=`)
      .then((tree) => {
        if (cancelled) return null;
        const entry = tree.entries.find(
          (row) => row.type === "file" && /^readme\.(md|markdown)$/i.test(row.name),
        );
        if (!entry) {
          setReadmeName(null);
          return null;
        }
        setReadmeName(entry.name);
        return api.get<RepositoryFileContent>(
          `${base}/workspace/file?path=${encodeURIComponent(entry.path)}`,
        );
      })
      .then((file) => {
        if (cancelled || !file) return;
        if (file.content === null) setReadmeName(null);
        else setReadme(file.content);
      })
      .catch(() => {
        if (!cancelled) setReadmeName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, repoSlug]);

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const currentRepo = repo;
  const base = `/c/${company.slug}/repositories/${repo.slug}`;
  const writeGrants = grants?.filter((grant) => grant.accessLevel === "write") ?? [];
  const prReady =
    grants?.filter((grant) => grant.accessLevel === "write" && grant.employee?.pullRequestReady) ??
    [];
  const allStepsReady = grants !== null && writeGrants.length > 0 && prReady.length > 0;
  const showSteps = !allStepsReady || stepsOpen;
  // Connecting rewrites the repository's remote for everyone, which is the same
  // bar the server puts on pushing.
  const canConnect = company.role === "owner" || company.role === "admin";

  /**
   * What the headline reasons over.
   *
   * `granted` prefers the grants read over `repo.grantCount` so the two halves
   * of the page cannot disagree about who may work here, and falls back to the
   * stored count while that read is outstanding or has failed.
   */
  const glance = repositoryAiGlanceOf(overview, grants?.length ?? currentRepo.grantCount);

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<RepositoryTestResult>(
        `/api/companies/${company.id}/repositories/${currentRepo.slug}/test`,
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
              {repo.origin === "remote" ? (
                <SyncBadge status={repo.lastSyncStatus} />
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Local
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-slate-500 dark:text-slate-400">
              {repo.origin === "local" ? "Kept in Genosyn" : repo.gitUrl}
            </p>
            {repo.description && (
              <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                {repo.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link to={`${base}/files`}>
            <Button variant="secondary">
              <FileCode size={15} /> Open files
            </Button>
          </Link>
          <Link to={`${base}/access`}>
            <Button variant="secondary">
              <Users size={15} /> Manage AI access
            </Button>
          </Link>
        </div>
      </div>

      <div className="mt-5 max-w-2xl">
        <AsyncResourceTagPicker
          companyId={company.id}
          resourceType="repository"
          resourceId={currentRepo.id}
        />
      </div>

      {repo.origin === "local" && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <GitFork size={17} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  This repository lives only in Genosyn
                </div>
                <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                  That is a perfectly good place for it to stay. Connect it to a git host when you
                  want a backup off this machine, pull requests, or people outside Genosyn reading
                  it — every commit made here goes with it.
                </p>
              </div>
            </div>
            {canConnect ? (
              <Button className="shrink-0" onClick={() => setConnectOpen(true)}>
                <GitFork size={15} /> Connect to a git host
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                An owner or admin can connect it.
              </span>
            )}
          </div>
        </section>
      )}

      <AiWorkOverview
        companyId={company.id}
        overview={overview}
        error={overviewError}
        glance={glance}
        grants={grants}
        aiBase={`${base}/ai`}
        accessHref={`${base}/access`}
        onRetry={reloadOverview}
      />

      {/* The explainer is a tutorial, and a tutorial that has been true for six
        months is furniture. It stays for as long as a step is not green, and
        folds itself away the moment they all are. */}
      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              How work reaches this repository
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {allStepsReady
                ? "Everything is set up — an employee can read this repository, work on it, and hand the result back."
                : "Every AI employee already knows how to read and write. What you grant decides which repositories it may touch, and how far its work can travel."}
            </p>
          </div>
          {allStepsReady && (
            <button
              type="button"
              onClick={() => setStepsOpen((current) => !current)}
              aria-expanded={stepsOpen}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
            >
              {stepsOpen ? "Hide the steps" : "How this works"}
            </button>
          )}
        </div>
        {showSteps && (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <WorkflowStep
              number="1"
              icon={<Code2 size={17} />}
              title="Read and edit the files"
              detail="Reading, editing, searching, and running tests are built in. Nothing to set up."
              status="Ready"
              ready
            />
            <WorkflowStep
              number="2"
              icon={<GitBranch size={17} />}
              title="Work on a branch and commit"
              detail="An employee you grant access to gets its own copy of this repository. It never sees the credentials behind it."
              status={
                grants === null
                  ? "Checking…"
                  : writeGrants.length > 0
                    ? `${writeGrants.length} ready`
                    : "Nobody yet"
              }
              ready={writeGrants.length > 0}
            />
            <WorkflowStep
              number="3"
              icon={<GitPullRequest size={17} />}
              title="Hand the work back to you"
              detail={
                // Three different situations, and only the first has a next
                // step. A remote on a host no Integration covers — a GitLab,
                // a Bitbucket, a plain git server — can never get a pull
                // request button, so promising one is worse than silence:
                // it sends the reader looking for a Connection that does not
                // exist, on a step that will never turn green.
                repo.forge
                  ? `You read the diff and decide whether it lands. Grant the employee a ${repo.forge.name} Connection and it can open the pull request itself.`
                  : repo.origin === "remote"
                    ? "You read the diff and decide whether it lands, then push it from here. Opening a pull request needs GitHub or a Forgejo / Gitea server Genosyn can reach."
                    : "You read the diff and decide whether it lands. Connect this repository to a git host and the employee can open the pull request itself."
              }
              status={
                grants === null
                  ? "Checking…"
                  : prReady.length > 0
                    ? `${prReady.length} ready`
                    : repo.forge
                      ? "Needs a Connection"
                      : "Review here"
              }
              ready={prReady.length > 0}
              last
            />
          </div>
        )}
      </section>

      {readmeName && (
        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <BookOpen size={16} className="text-slate-400" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {readmeName}
            </h2>
            <Link
              to={`${base}/files`}
              className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
            >
              Edit
            </Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            {readme === null ? (
              <div className="flex h-24 items-center justify-center">
                <Spinner size={18} />
              </div>
            ) : (
              <MarkdownPreview source={readme} emptyMessage="This README is empty." />
            )}
          </div>
        </section>
      )}

      {/* Settings, kept and demoted. They were the first thing on this page and
        none of them had changed since the day the repository was added. */}
      <section className="mt-8">
        <button
          type="button"
          onClick={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800/60"
        >
          <span>
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
              Repository details
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              Branch, sign-in, what an employee may run
              {repo.origin === "remote" ? ", and the connection check" : ""}.
            </span>
          </span>
          <ChevronDown
            size={16}
            className={
              "shrink-0 text-slate-400 transition-transform " + (detailsOpen ? "rotate-180" : "")
            }
          />
        </button>

        {detailsOpen && (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                icon={<GitBranch size={16} />}
                label="Default branch"
                value={repo.defaultBranch}
              />
              <SummaryCard
                icon={<Users size={16} />}
                label="AI access"
                // The same source the roster above counts, so the two cannot
                // disagree on one screen: `repo.grantCount` only moves when the
                // layout refetches the repository list, while the roster is
                // refreshed by every grant change.
                value={`${glance.granted} ${glance.granted === 1 ? "employee" : "employees"}`}
              />
              <SummaryCard
                icon={<CircleDot size={16} />}
                label="Sign-in"
                // `authMode.toUpperCase()` printed SSH / HTTPS, which names a
                // protocol rather than answering the question the card asks.
                value={repo.origin === "local" ? "Not needed" : signInLabel(repo)}
              />
              <SummaryCard
                icon={<Terminal size={16} />}
                label="AI commands"
                value={COMMAND_MODE_LABEL[repo.commandMode]}
              />
            </div>

            {repo.origin === "remote" && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      Connection health
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                      Verify the clone URL and available sign-in before assigning work.
                    </p>
                  </div>
                  <Button variant="secondary" onClick={test} disabled={testing}>
                    {testing ? <Spinner size={14} /> : <Plug size={14} />}
                    {testing ? "Testing…" : "Test connection"}
                  </Button>
                </div>
                <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
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
                        <CheckCircle2
                          size={16}
                          className="text-emerald-600 dark:text-emerald-400"
                        />
                      ) : (
                        <Plug size={16} className="text-slate-400" />
                      )}
                      {repo.lastSyncStatus === "ok"
                        ? "The most recent connection check succeeded."
                        : "This repository has not been tested yet."}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </section>

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

function Result({ result }: { result: RepositoryTestResult }) {
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
