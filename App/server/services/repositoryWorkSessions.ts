import fs from "node:fs";
import path from "node:path";
import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { CHAT_HARD_TIMEOUT_MS, chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";
import { hasRepositoryAccess } from "./repositories.js";
import {
  MAX_EDITABLE_FILE_BYTES,
  assertSafeBranchName,
  ensureRepositoryWorkspace,
  isBinary,
  mergeBranchIntoCurrent,
  normalizeRepositoryPath,
  parseCommits,
  pushRepositoryBranch,
  repositoryWorkspaceRootFor,
  resolveInCheckout,
  runRepositoryGit,
  summarizeDiff,
  type RepositoryCommit,
  type RepositoryDiff,
  type RepositoryTreeEntry,
} from "./repositoryWorkspace.js";
import { toSlug } from "../lib/slug.js";
import { config } from "../../config.js";

/**
 * AI work sessions — "ask an employee to do something in this repository, then
 * review the diff and decide".
 *
 * ## Where the employee works
 *
 * Each session gets its own **git worktree** beside the Member checkout, under
 * `.private/repositories/<companyId>/<repositoryId>/sessions/<sessionId>/`.
 * A worktree shares the repository's object store, so creating one is cheap
 * and the resulting commits are already present in the Member checkout the
 * moment the Member decides to merge them — there is nothing to transfer and
 * no second copy of the history.
 *
 * The employee never gets filesystem or shell access to that worktree. It
 * reaches it only through the `repository_*` tools, which the App executes on
 * its behalf with every path validated. Three consequences follow, and they
 * are the reason this design was chosen over handing the model a checkout:
 *
 *   1. **It works on every install.** The employee needs no coding tools, no
 *      bubblewrap, and no host execution — which the standard Docker install
 *      has switched off. A design that required them would have made "ask AI
 *      to update the strategy doc" unavailable to almost everybody.
 *   2. **The checkout cannot be made hostile to Git.** Every write goes
 *      through {@link normalizeRepositoryPath}, which refuses any path with a
 *      `.git` segment, and through `resolveInCheckout`, which refuses any path
 *      that resolves outside the worktree. The model cannot write
 *      `.git/config`, install a hook, or point a symlink out of the tree, so
 *      the properties that make server-owned Git safe still hold.
 *   3. **Nothing reaches the remote unreviewed.** Credentials live only in the
 *      push path, which only a Member can trigger.
 *
 * The separate per-employee checkout at `<employeeDir>/repositories/<slug>/`
 * is untouched by all of this. It still exists for open-ended chat and Routine
 * work on installs that have coding tools enabled.
 */

/** Hard cap on what a single tool call may write, matching the editor's cap. */
export const MAX_SESSION_WRITE_BYTES = MAX_EDITABLE_FILE_BYTES;

/** How many matches a repository search returns before it stops looking. */
export const MAX_SEARCH_RESULTS = 100;

export type SessionCheckout = { repo: Repository; directory: string };

// ─────────────────────────── worktree lifecycle ─────────────────────────

export function sessionWorktreePath(repo: Repository, sessionId: string): string {
  return path.join(repositoryWorkspaceRootFor(repo), "sessions", sessionId);
}

/**
 * Branch name for a session. Namespaced under `genosyn/` so it is obvious in
 * `git log` and on the remote where the work came from, and suffixed with the
 * session id so two concurrent sessions by the same employee cannot collide.
 */
export function sessionBranchName(employeeSlug: string, sessionId: string): string {
  const slug = toSlug(employeeSlug) || "employee";
  return `genosyn/${slug}/${sessionId.slice(0, 8)}`;
}

export async function createSessionWorktree(
  repo: Repository,
  sessionId: string,
  branch: string,
  baseRef: string,
): Promise<string> {
  assertSafeBranchName(branch);
  const directory = sessionWorktreePath(repo, sessionId);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), [
    "worktree",
    "add",
    "--quiet",
    "-b",
    branch,
    directory,
    baseRef,
  ]);
  return directory;
}

export async function removeSessionWorktree(repo: Repository, sessionId: string): Promise<void> {
  const directory = sessionWorktreePath(repo, sessionId);
  if (!fs.existsSync(directory)) return;
  try {
    await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), [
      "worktree",
      "remove",
      "--force",
      directory,
    ]);
  } catch {
    // A worktree whose directory was already deleted leaves stale metadata;
    // clearing it is what `prune` is for and it must not fail the caller.
    fs.rmSync(directory, { recursive: true, force: true });
    await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), ["worktree", "prune"]).catch(
      () => {},
    );
  }
}

function repositoryCheckoutDirectory(repo: Repository): string {
  return path.join(repositoryWorkspaceRootFor(repo), "checkout");
}

// ───────────────────── file operations for the tools ────────────────────

/**
 * Every one of these takes the session's own worktree directory, never the
 * Member checkout, and validates the path against it. They are the complete
 * set of things an AI Employee can do to a repository.
 */

export function sessionListFiles(directory: string, subPath: string): RepositoryTreeEntry[] {
  const normalized = normalizeRepositoryPath(subPath, { allowRoot: true });
  const absolute = resolveInCheckout(directory, normalized);
  const entries: RepositoryTreeEntry[] = [];
  for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (!normalized && dirent.name === ".git") continue;
    if (dirent.isSymbolicLink()) continue;
    const entryPath = normalized ? `${normalized}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        path: entryPath,
        type: "directory",
        size: 0,
        ignored: false,
      });
    } else if (dirent.isFile()) {
      entries.push({
        name: dirent.name,
        path: entryPath,
        type: "file",
        size: fs.statSync(path.join(absolute, dirent.name)).size,
        // A session listing is not filtered: an employee asked to change a
        // generated file should still be able to see it.
        ignored: false,
      });
    }
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );
}

export function sessionReadFile(directory: string, filePath: string): string {
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(directory, normalized);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) throw new Error("That path is not a regular file.");
  if (stat.size > MAX_SESSION_WRITE_BYTES) {
    throw new Error("That file is too large to open.");
  }
  const buffer = fs.readFileSync(absolute);
  if (isBinary(buffer)) throw new Error("That file is binary and cannot be read as text.");
  return buffer.toString("utf8");
}

export function sessionWriteFile(directory: string, filePath: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_SESSION_WRITE_BYTES) {
    throw new Error("That file is too large to write.");
  }
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(directory, normalized);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
    throw new Error("That path is a directory.");
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

export function sessionDeleteFile(directory: string, filePath: string): void {
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(directory, normalized);
  if (!fs.existsSync(absolute)) throw new Error("File not found.");
  fs.rmSync(absolute, { recursive: true, force: true });
}

export type SessionSearchHit = { path: string; line: number; text: string };

/**
 * Plain substring search over the worktree's text files.
 *
 * Deliberately not `git grep`: the point of these tools is that they need no
 * child process, so they work identically on an install with command
 * execution switched off.
 */
export function sessionSearch(directory: string, query: string): SessionSearchHit[] {
  if (!query.trim()) throw new Error("Enter something to search for.");
  const needle = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  const walk = (relative: string): void => {
    if (hits.length >= MAX_SEARCH_RESULTS) return;
    const absolute = resolveInCheckout(directory, relative || ".");
    for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (hits.length >= MAX_SEARCH_RESULTS) return;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.name === ".git") continue;
      const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      const full = path.join(absolute, dirent.name);
      if (fs.statSync(full).size > MAX_SESSION_WRITE_BYTES) continue;
      const buffer = fs.readFileSync(full);
      if (isBinary(buffer)) continue;
      const lines = buffer.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        hits.push({ path: entryPath, line: i + 1, text: lines[i].slice(0, 400) });
        if (hits.length >= MAX_SEARCH_RESULTS) return;
      }
    }
  };
  walk("");
  return hits;
}

export async function sessionCommit(
  repo: Repository,
  directory: string,
  message: string,
): Promise<{ sha: string } | null> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("A commit message is required.");
  await runRepositoryGit(repo, directory, ["add", "--all"]);
  const staged = await runRepositoryGit(repo, directory, ["diff", "--cached", "--name-only"]);
  if (staged.trim() === "") return null;
  await runRepositoryGit(repo, directory, ["commit", "--quiet", "-m", trimmed]);
  const sha = (await runRepositoryGit(repo, directory, ["rev-parse", "HEAD"])).trim();
  return { sha };
}

// ──────────────────────────── session flow ──────────────────────────────

export type StartWorkSessionArgs = {
  companyId: string;
  repositoryId: string;
  employeeId: string;
  instruction: string;
  requesterUserId: string;
  requesterSessionVersion: number;
  /** Seam for tests; defaults to the real chat runtime. */
  runChat?: typeof chatWithEmployee;
};

/**
 * Everything {@link runRepositoryWorkSession} needs, already validated.
 *
 * The repository and employee rows are carried across rather than re-read
 * because {@link createRepositoryWorkSession} has just loaded them to check
 * them, and re-reading would only introduce a window where the two halves
 * disagree about what they are working on.
 */
export type PreparedWorkSession = {
  session: RepositoryWorkSession;
  repo: Repository;
  employee: AIEmployee;
  args: StartWorkSessionArgs;
};

/**
 * Validate the request and write the session row — the fast half.
 *
 * Split from the run so a caller can hold a real session id before the model
 * turn starts. Both callers need that. The HTTP route needs it to answer
 * without guessing which row it just created; the `start_repository_work_session`
 * tool needs it because a chat turn cannot sit and wait for work that is
 * allowed to take hours, and telling the Member "I started session X" is only
 * honest if X is known.
 *
 * Every reason a session cannot *be* started is raised here, before any row
 * exists, so a caller gets one clean error instead of a `failed` row to
 * explain. Capacity is the exception and cannot be otherwise: the workload
 * lease is taken when the turn begins, so a company already at its ceiling
 * produces a row that starts and then fails, saying so.
 */
export async function createRepositoryWorkSession(
  args: StartWorkSessionArgs,
): Promise<PreparedWorkSession> {
  // Shared SaaS keeps repositories read-only until git runs in a dedicated
  // egress worker. The browser route enforces that on every mutation; a
  // session is a mutation reached by a second door, so the rule lives with the
  // operation rather than only at the doors.
  if (config.security.multiTenant) {
    throw new Error(
      "Repositories are read-only in shared SaaS mode until git runs in a dedicated egress worker",
    );
  }
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: args.repositoryId,
    companyId: args.companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: args.employeeId,
    companyId: args.companyId,
  });
  if (!employee) throw new Error("Employee not found.");
  if (!(await hasRepositoryAccess(employee.id, repo.id, "read"))) {
    throw new Error(`${employee.name} has not been granted access to this repository.`);
  }
  if (!(await getActiveModel(employee.id))) {
    throw new Error(`${employee.name} has no AI Model connected yet.`);
  }

  const session = await sessionRepo.save(
    sessionRepo.create({
      companyId: args.companyId,
      repositoryId: repo.id,
      employeeId: employee.id,
      requestedByUserId: args.requesterUserId,
      instruction: args.instruction.trim(),
      status: "running",
    }),
  );
  return { session, repo, employee, args };
}

/**
 * Create the session row and its worktree, run the employee's turn, then
 * record what it left behind.
 *
 * Resolves only when the turn is over. Callers that are HTTP handlers start it
 * and return the row immediately; the client polls or listens for the
 * resource-change event.
 */
export async function startRepositoryWorkSession(
  args: StartWorkSessionArgs,
): Promise<RepositoryWorkSession> {
  return runRepositoryWorkSession(await createRepositoryWorkSession(args));
}

/**
 * Cut the worktree, run the employee's turn in it, and record what it left
 * behind — the slow half, which may take as long as any other chat turn.
 *
 * Never rejects for a reason the session itself caused: a failure is written
 * onto the row as `failed` so the Member who asked sees why. That matters more
 * now than it did when only an awaiting HTTP handler called this, because a
 * tool-started session has nobody holding its promise.
 */
export async function runRepositoryWorkSession(
  prepared: PreparedWorkSession,
): Promise<RepositoryWorkSession> {
  const { session, repo, employee, args } = prepared;
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);

  try {
    await ensureRepositoryWorkspace(repo);
    const baseRef = (
      await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), ["rev-parse", "HEAD"])
    ).trim();
    const branch = sessionBranchName(employee.slug, session.id);
    const directory = await createSessionWorktree(repo, session.id, branch, baseRef);
    session.branch = branch;
    session.baseCommit = baseRef;
    await sessionRepo.save(session);

    const runChat = args.runChat ?? chatWithEmployee;
    const result = await runChat(
      args.companyId,
      employee.id,
      composeWorkBrief(repo, args.instruction),
      [],
      {
        requesterUserId: args.requesterUserId,
        requesterSessionVersion: args.requesterSessionVersion,
        repositoryWorkSessionId: session.id,
        extraSystem: composeWorkSystemPrompt(repo, session.id),
        extraToolset: REPOSITORY_SESSION_TOOLS,
      },
    );

    const fresh = await sessionRepo.findOneBy({ id: session.id });
    if (!fresh) return session;
    fresh.reply = result.reply ?? "";
    fresh.finishedAt = new Date();

    if (result.status !== "ok") {
      fresh.status = "failed";
      fresh.error = result.reply || "The work session did not complete.";
      await sessionRepo.save(fresh);
      await removeSessionWorktree(repo, session.id);
      return fresh;
    }

    const outcome = await summarizeSessionWork(repo, directory, baseRef);
    fresh.headCommit = outcome.headCommit;
    fresh.filesChanged = outcome.diff.filesChanged;
    fresh.insertions = outcome.diff.insertions;
    fresh.deletions = outcome.diff.deletions;
    fresh.status = outcome.commits.length > 0 ? "ready" : "empty";
    await sessionRepo.save(fresh);
    // Nothing was committed, so the worktree holds nothing worth reviewing.
    if (fresh.status === "empty") await removeSessionWorktree(repo, session.id);
    return fresh;
  } catch (error) {
    const fresh = (await sessionRepo.findOneBy({ id: session.id })) ?? session;
    fresh.status = "failed";
    fresh.error = error instanceof Error ? error.message : String(error);
    fresh.finishedAt = new Date();
    await sessionRepo.save(fresh);
    await removeSessionWorktree(repo, session.id).catch(() => {});
    return fresh;
  }
}

async function summarizeSessionWork(
  repo: Repository,
  directory: string,
  baseRef: string,
): Promise<{ headCommit: string; commits: RepositoryCommit[]; diff: RepositoryDiff }> {
  const headCommit = (await runRepositoryGit(repo, directory, ["rev-parse", "HEAD"])).trim();
  const log = await runRepositoryGit(repo, directory, [
    "log",
    "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e",
    `${baseRef}..HEAD`,
  ]);
  const patch = await runRepositoryGit(repo, directory, [
    "diff",
    "--no-color",
    "--unified=3",
    "--no-ext-diff",
    baseRef,
    headCommit,
  ]);
  return { headCommit, commits: parseCommits(log), diff: summarizeDiff(patch) };
}

/** The diff a Member reviews for one session. */
export async function repositoryWorkSessionDiff(
  session: RepositoryWorkSession,
): Promise<RepositoryDiff & { commits: RepositoryCommit[] }> {
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId: session.companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  if (!session.baseCommit || !session.headCommit) {
    return {
      patch: "",
      truncated: false,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commits: [],
    };
  }
  const checkout = repositoryCheckoutDirectory(repo);
  const patch = await runRepositoryGit(repo, checkout, [
    "diff",
    "--no-color",
    "--unified=3",
    "--no-ext-diff",
    session.baseCommit,
    session.headCommit,
  ]);
  const log = await runRepositoryGit(repo, checkout, [
    "log",
    "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e",
    `${session.baseCommit}..${session.headCommit}`,
  ]);
  return { ...summarizeDiff(patch), commits: parseCommits(log) };
}

/**
 * Accept an employee's work: merge its branch into the Member checkout and,
 * for a repository with a remote, push the result.
 *
 * This is the governed publish step. It is the only path by which anything a
 * model produced can reach the remote, it requires an authenticated Member,
 * and the credential is used here — never anywhere the model can observe.
 */
export async function publishRepositoryWorkSession(
  sessionId: string,
  options: { push: boolean },
): Promise<RepositoryWorkSession> {
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const session = await sessionRepo.findOneBy({ id: sessionId });
  if (!session) throw new Error("Work session not found.");
  if (session.status !== "ready") {
    throw new Error("This session has no reviewed work waiting to be published.");
  }
  if (!session.branch) throw new Error("This session has no branch.");
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId: session.companyId,
  });
  if (!repo) throw new Error("Repository not found.");

  await mergeBranchIntoCurrent(repo, session.branch);
  if (options.push && repo.origin === "remote") {
    const status = await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const current = status.trim();
    await pushRepositoryBranch(repo, current);
    session.publishedBranch = current;
  }
  session.status = "published";
  await sessionRepo.save(session);
  await removeSessionWorktree(repo, session.id).catch(() => {});
  return session;
}

export async function discardRepositoryWorkSession(
  sessionId: string,
): Promise<RepositoryWorkSession> {
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const session = await sessionRepo.findOneBy({ id: sessionId });
  if (!session) throw new Error("Work session not found.");
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId: session.companyId,
  });
  if (repo) {
    await removeSessionWorktree(repo, session.id).catch(() => {});
    if (session.branch) {
      await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), [
        "branch",
        "-D",
        session.branch,
      ]).catch(() => {});
    }
  }
  session.status = "discarded";
  await sessionRepo.save(session);
  return session;
}

// ──────────────────────────── the briefing ──────────────────────────────

/** Loaded up-front on this surface: the session's whole job is the repository. */
export const REPOSITORY_SESSION_TOOLS = [
  "repository_list_files",
  "repository_read_file",
  "repository_write_file",
  "repository_delete_file",
  "repository_search",
  "repository_commit",
];

export function composeWorkSystemPrompt(repo: Repository, sessionId: string): string {
  const subject =
    repo.kind === "documents"
      ? "a version-controlled set of documents"
      : "a version-controlled codebase";
  return [
    `You are working inside the Genosyn Repository "${repo.name}" — ${subject}.`,
    `Your working copy for this session is isolated: session id \`${sessionId}\`. Nobody else is editing it, and nothing you do here affects anyone until a human reviews your diff and merges it.`,
    "",
    "Use the `repository_*` tools for everything:",
    "- `repository_list_files` and `repository_read_file` to understand what is there before changing it. Read a file before you rewrite it.",
    "- `repository_search` to find where something is mentioned.",
    "- `repository_write_file` writes the whole file, so include the parts you are keeping.",
    "- `repository_commit` records your work. Commit when you have finished a coherent piece, with a message in the imperative mood explaining why the change exists.",
    "",
    "You must commit. Work you leave uncommitted is discarded when the session ends and the human sees nothing.",
    repo.kind === "documents"
      ? "This repository holds documents rather than software. Match the surrounding structure and voice, and keep the prose readable."
      : "Match the conventions of the surrounding code. You have no shell and cannot run tests here, so keep changes reviewable and say plainly in your reply what you could not verify.",
    "",
    "Your reply is shown to the human next to your diff. Make it a short report: what you changed, why, and anything you deliberately left alone or could not do.",
  ].join("\n");
}

function composeWorkBrief(repo: Repository, instruction: string): string {
  return [`Work on the repository "${repo.name}".`, "", instruction.trim()].join("\n");
}

/**
 * A session this employee still has in flight on this repository, if any.
 *
 * "Still in flight" is deliberately not just `status: "running"`. Nothing
 * reconciles that column at boot, so a process killed mid-session leaves a row
 * that says `running` for good. A caller that refused on the strength of it
 * would refuse for good too.
 *
 * A turn cannot outlive {@link CHAT_HARD_TIMEOUT_MS}, so a `running` row older
 * than that is not a session anybody is waiting on — it is a crash nobody
 * cleaned up, and it should stop standing in the way.
 */
export async function liveRepositoryWorkSession(args: {
  companyId: string;
  repositoryId: string;
  employeeId: string;
}): Promise<RepositoryWorkSession | null> {
  return AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
    companyId: args.companyId,
    repositoryId: args.repositoryId,
    employeeId: args.employeeId,
    status: "running",
    createdAt: MoreThan(new Date(Date.now() - CHAT_HARD_TIMEOUT_MS)),
  });
}

/** Resolve the worktree a tool call belongs to, refusing anything else. */
export async function resolveSessionCheckout(
  companyId: string,
  sessionId: string,
): Promise<SessionCheckout> {
  const session = await AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
    id: sessionId,
    companyId,
  });
  if (!session) throw new Error("Work session not found.");
  if (session.status !== "running") throw new Error("This work session has already finished.");
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  const directory = sessionWorktreePath(repo, session.id);
  if (!fs.existsSync(directory)) throw new Error("This work session has no working copy.");
  return { repo, directory };
}
