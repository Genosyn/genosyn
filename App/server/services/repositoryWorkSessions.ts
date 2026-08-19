import fs from "node:fs";
import path from "node:path";
import { In, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository } from "../db/entities/Repository.js";
import {
  REVISABLE_WORK_SESSION_STATUSES,
  RepositoryWorkSession,
} from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { CHAT_HARD_TIMEOUT_MS, chatWithEmployee, type ChatTurn } from "./chat.js";
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
import {
  createGithubPullRequest,
  findConnectionForRemote,
  findOpenGithubPullRequest,
  isGithubHttpsUrl,
  parseGithubRemote,
  resolveConnectionToken,
  type GithubPullRequest,
} from "./repositoryGithub.js";
import { decryptRepositorySecret } from "./repositories.js";
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

/**
 * The session's worktree, created if it is not there.
 *
 * A session outlives its worktree on purpose: one that committed nothing has
 * nothing worth keeping on disk, and a follow-up instruction weeks later must
 * still land on the same branch. Recreating from the branch is exact — the
 * branch *is* the work — so the only thing lost is a directory that held no
 * commits.
 */
export async function ensureSessionWorktree(
  repo: Repository,
  session: Pick<RepositoryWorkSession, "id" | "branch" | "baseCommit">,
): Promise<string> {
  const directory = sessionWorktreePath(repo, session.id);
  // A worktree's `.git` is a file pointing back at the parent repository. Its
  // presence is what separates "already materialized" from a leftover
  // directory a failed run left behind.
  if (fs.existsSync(path.join(directory, ".git"))) return directory;
  const branch = session.branch;
  if (!branch) throw new Error("This work session has no branch.");
  assertSafeBranchName(branch);
  const checkout = repositoryCheckoutDirectory(repo);
  fs.rmSync(directory, { recursive: true, force: true });
  // Git refuses to reuse a path it still has metadata for, and a killed
  // process is exactly how that metadata is left behind.
  await runRepositoryGit(repo, checkout, ["worktree", "prune"]).catch(() => {});
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const branchExists = await runRepositoryGit(repo, checkout, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).catch(() => "");
  if (branchExists.trim()) {
    await runRepositoryGit(repo, checkout, ["worktree", "add", "--quiet", directory, branch]);
    return directory;
  }
  const baseRef = session.baseCommit;
  if (!baseRef) throw new Error("This work session has no base commit to branch from.");
  return createSessionWorktree(repo, session.id, branch, baseRef);
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

export type ReviseWorkSessionArgs = {
  companyId: string;
  sessionId: string;
  instruction: string;
  requesterUserId: string;
  requesterSessionVersion: number;
  runChat?: typeof chatWithEmployee;
};

/**
 * Everything {@link runRepositoryWorkSession} needs, already validated.
 *
 * The repository and employee rows are carried across rather than re-read
 * because the preparing half has just loaded them to check them, and
 * re-reading would only introduce a window where the two halves disagree about
 * what they are working on.
 */
export type PreparedWorkSession = {
  session: RepositoryWorkSession;
  /** The turn this run will execute — the last row in the session so far. */
  turn: RepositoryWorkSessionTurn;
  repo: Repository;
  employee: AIEmployee;
  requesterUserId: string;
  requesterSessionVersion: number;
  runChat?: typeof chatWithEmployee;
};

/**
 * A readable label for a session, from the instruction that opened it.
 *
 * The list is how a Member switches between sessions, and an instruction is
 * frequently a paragraph. Take the first sentence's worth, collapse the
 * whitespace, and truncate — the full text is always one click away in the
 * transcript.
 */
export function deriveWorkSessionTitle(instruction: string): string {
  const flat = instruction.replace(/\s+/g, " ").trim();
  if (!flat) return "Untitled session";
  if (flat.length <= WORK_SESSION_TITLE_MAX) return flat;
  const cut = flat.slice(0, WORK_SESSION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export const WORK_SESSION_TITLE_MAX = 72;

/** How many earlier turns are replayed to the employee on a follow-up. */
export const MAX_REPLAYED_TURNS = 12;

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
  assertRepositoryWorkAllowed();
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: args.repositoryId,
    companyId: args.companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  const employee = await loadWorkingEmployee(args.companyId, args.employeeId, repo);
  const instruction = args.instruction.trim();

  const session = await sessionRepo.save(
    sessionRepo.create({
      companyId: args.companyId,
      repositoryId: repo.id,
      employeeId: employee.id,
      requestedByUserId: args.requesterUserId,
      title: deriveWorkSessionTitle(instruction),
      instruction,
      status: "running",
      turnCount: 0,
    }),
  );
  const turn = await appendTurn(session, instruction, args.requesterUserId);
  return {
    session,
    turn,
    repo,
    employee,
    requesterUserId: args.requesterUserId,
    requesterSessionVersion: args.requesterSessionVersion,
    runChat: args.runChat,
  };
}

/**
 * Validate a follow-up instruction and write its turn row — the fast half of
 * a revision.
 *
 * A revision is the same machinery as the opening request pointed at a session
 * that already exists: the same worktree, the same branch, the same tools. The
 * only thing it adds is memory, and the only thing it forbids is talking over
 * a turn that is still running.
 */
export async function prepareWorkSessionRevision(
  args: ReviseWorkSessionArgs,
): Promise<PreparedWorkSession> {
  assertRepositoryWorkAllowed();
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const session = await sessionRepo.findOneBy({ id: args.sessionId, companyId: args.companyId });
  if (!session) throw new Error("Work session not found.");
  if (session.status === "running") {
    throw new Error("That session is still working. Wait for the current turn to finish.");
  }
  if (!REVISABLE_WORK_SESSION_STATUSES.includes(session.status)) {
    throw new Error(
      session.status === "published"
        ? "That work has already been accepted. Start a new session for anything further."
        : "That session was thrown away. Start a new one instead.",
    );
  }
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId: args.companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  const employee = await loadWorkingEmployee(args.companyId, session.employeeId, repo);
  const instruction = args.instruction.trim();

  // A session started before turns existed still has its first exchange to
  // replay; give it a turn row before adding the second.
  await ensureFirstTurn(session);
  session.status = "running";
  session.error = "";
  session.finishedAt = null;
  session.requestedByUserId = args.requesterUserId;
  await sessionRepo.save(session);
  const turn = await appendTurn(session, instruction, args.requesterUserId);
  return {
    session,
    turn,
    repo,
    employee,
    requesterUserId: args.requesterUserId,
    requesterSessionVersion: args.requesterSessionVersion,
    runChat: args.runChat,
  };
}

/** Shared refusals: both halves need the exact same answer to "may this run?". */
function assertRepositoryWorkAllowed(): void {
  // Shared SaaS keeps repositories read-only until git runs in a dedicated
  // egress worker. The browser route enforces that on every mutation; a
  // session is a mutation reached by a second door, so the rule lives with the
  // operation rather than only at the doors.
  if (config.security.multiTenant) {
    throw new Error(
      "Repositories are read-only in shared SaaS mode until git runs in a dedicated egress worker",
    );
  }
}

async function loadWorkingEmployee(
  companyId: string,
  employeeId: string,
  repo: Repository,
): Promise<AIEmployee> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new Error("Employee not found.");
  // Re-checked on every turn rather than only at the first: a grant revoked
  // mid-session must stop the next instruction, not merely the next session.
  if (!(await hasRepositoryAccess(employee.id, repo.id, "read"))) {
    throw new Error(`${employee.name} has not been granted access to this repository.`);
  }
  if (!(await getActiveModel(employee.id))) {
    throw new Error(`${employee.name} has no AI Model connected yet.`);
  }
  return employee;
}

async function appendTurn(
  session: RepositoryWorkSession,
  instruction: string,
  requesterUserId: string,
): Promise<RepositoryWorkSessionTurn> {
  const turnRepo = AppDataSource.getRepository(RepositoryWorkSessionTurn);
  const ordinal = session.turnCount + 1;
  const turn = await turnRepo.save(
    turnRepo.create({
      companyId: session.companyId,
      sessionId: session.id,
      ordinal,
      instruction,
      status: "running",
      requestedByUserId: requesterUserId,
    }),
  );
  session.turnCount = ordinal;
  await AppDataSource.getRepository(RepositoryWorkSession).save(session);
  return turn;
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

/** Prepare and run a follow-up turn on an existing session. */
export async function reviseRepositoryWorkSession(
  args: ReviseWorkSessionArgs,
): Promise<RepositoryWorkSession> {
  return runRepositoryWorkSession(await prepareWorkSessionRevision(args));
}

/**
 * Run the prepared turn in the session's worktree and record what it left
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
  const { session, turn, repo, employee } = prepared;
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);

  try {
    await ensureRepositoryWorkspace(repo);
    if (!session.baseCommit) {
      session.baseCommit = (
        await runRepositoryGit(repo, repositoryCheckoutDirectory(repo), ["rev-parse", "HEAD"])
      ).trim();
    }
    if (!session.branch) session.branch = sessionBranchName(employee.slug, session.id);
    await sessionRepo.save(session);
    const directory = await ensureSessionWorktree(repo, session);

    // The turn's own base is wherever the branch stands now, which is the
    // session base on turn one and the previous turn's head after that.
    const turnBase = (await runRepositoryGit(repo, directory, ["rev-parse", "HEAD"])).trim();
    turn.baseCommit = turnBase;
    await AppDataSource.getRepository(RepositoryWorkSessionTurn).save(turn);

    const history = await composeTurnHistory(session.id, turn.ordinal);
    const runChat = prepared.runChat ?? chatWithEmployee;
    const result = await runChat(
      session.companyId,
      employee.id,
      composeWorkBrief(repo, turn.instruction, turn.ordinal),
      history,
      {
        requesterUserId: prepared.requesterUserId,
        requesterSessionVersion: prepared.requesterSessionVersion,
        repositoryWorkSessionId: session.id,
        extraSystem: composeWorkSystemPrompt(repo, session.id, { revision: turn.ordinal > 1 }),
        extraToolset: REPOSITORY_SESSION_TOOLS,
      },
    );

    const fresh = await sessionRepo.findOneBy({ id: session.id });
    if (!fresh) return session;

    if (result.status !== "ok") {
      return finishTurn({
        repo,
        session: fresh,
        turn,
        directory,
        reply: result.reply ?? "",
        error: result.reply || "The work session did not complete.",
      });
    }
    return finishTurn({
      repo,
      session: fresh,
      turn,
      directory,
      reply: result.reply ?? "",
      error: "",
    });
  } catch (error) {
    const fresh = (await sessionRepo.findOneBy({ id: session.id })) ?? session;
    const message = error instanceof Error ? error.message : String(error);
    fresh.status = "failed";
    fresh.error = message;
    fresh.finishedAt = new Date();
    await sessionRepo.save(fresh);
    await failTurnRow(turn, message);
    await pruneEmptySessionWorktree(repo, fresh).catch(() => {});
    return fresh;
  }
}

/**
 * Write the outcome of a finished turn onto both rows.
 *
 * The turn records what *this instruction* changed; the session records where
 * the branch as a whole now stands. Keeping both is what lets the transcript
 * show a revision's own diff without re-reading everything before it.
 */
async function finishTurn(args: {
  repo: Repository;
  session: RepositoryWorkSession;
  turn: RepositoryWorkSessionTurn;
  directory: string;
  reply: string;
  error: string;
}): Promise<RepositoryWorkSession> {
  const { repo, session, turn, directory, reply, error } = args;
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const turnRepo = AppDataSource.getRepository(RepositoryWorkSessionTurn);
  const now = new Date();

  session.reply = reply;
  session.error = error;
  session.finishedAt = now;
  turn.reply = reply;
  turn.error = error;
  turn.finishedAt = now;

  if (error) {
    session.status = "failed";
    turn.status = "failed";
  } else {
    const sessionOutcome = await summarizeSessionWork(repo, directory, session.baseCommit ?? "");
    const turnOutcome = await summarizeSessionWork(repo, directory, turn.baseCommit ?? "");
    session.headCommit = sessionOutcome.headCommit;
    session.filesChanged = sessionOutcome.diff.filesChanged;
    session.insertions = sessionOutcome.diff.insertions;
    session.deletions = sessionOutcome.diff.deletions;
    // A revision that lands commits on a branch whose pull request is already
    // open puts the branch ahead of the remote again, so it goes back to
    // `ready` — the button becomes "Update pull request" and says so.
    session.status = sessionOutcome.commits.length > 0 ? "ready" : "empty";
    turn.status = "ok";
    turn.headCommit = turnOutcome.headCommit;
    turn.filesChanged = turnOutcome.diff.filesChanged;
    turn.insertions = turnOutcome.diff.insertions;
    turn.deletions = turnOutcome.diff.deletions;
  }

  await turnRepo.save(turn);
  await sessionRepo.save(session);
  await pruneEmptySessionWorktree(repo, session).catch(() => {});
  return session;
}

async function failTurnRow(turn: RepositoryWorkSessionTurn, message: string): Promise<void> {
  const turnRepo = AppDataSource.getRepository(RepositoryWorkSessionTurn);
  const fresh = (await turnRepo.findOneBy({ id: turn.id })) ?? turn;
  fresh.status = "failed";
  fresh.error = message;
  fresh.finishedAt = new Date();
  await turnRepo.save(fresh);
}

/**
 * A worktree holding nothing is worth nothing, and the next turn can recreate
 * it from the branch in a moment. One that holds commits stays, because that
 * is where a follow-up continues from.
 */
async function pruneEmptySessionWorktree(
  repo: Repository,
  session: RepositoryWorkSession,
): Promise<void> {
  if (session.headCommit && session.headCommit !== session.baseCommit) return;
  await removeSessionWorktree(repo, session.id);
}

/**
 * The earlier turns of a session, replayed as chat history.
 *
 * Without this a follow-up would arrive at an employee that has no idea what
 * it just did, in a worktree full of changes it does not remember making — and
 * "no, keep the old heading" would be unanswerable. Only finished turns are
 * replayed, and only the most recent {@link MAX_REPLAYED_TURNS}: a long
 * session's early turns are already reflected in the files the employee can
 * read, so the transcript is the part that can safely age out.
 */
export async function composeTurnHistory(
  sessionId: string,
  beforeOrdinal: number,
): Promise<ChatTurn[]> {
  const rows = await AppDataSource.getRepository(RepositoryWorkSessionTurn).find({
    where: { sessionId, status: In(["ok", "failed"]) },
    order: { ordinal: "ASC" },
  });
  const earlier = rows.filter((row) => row.ordinal < beforeOrdinal).slice(-MAX_REPLAYED_TURNS);
  const history: ChatTurn[] = [];
  for (const row of earlier) {
    history.push({ role: "user", content: row.instruction });
    const reply = row.reply.trim() || row.error.trim();
    if (reply) history.push({ role: "assistant", content: reply });
  }
  return history;
}

/** The turns of a session, oldest first — the transcript a Member reads. */
export async function repositoryWorkSessionTurns(
  sessionId: string,
): Promise<RepositoryWorkSessionTurn[]> {
  const session = await AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
    id: sessionId,
  });
  if (session) await ensureFirstTurn(session);
  return AppDataSource.getRepository(RepositoryWorkSessionTurn).find({
    where: { sessionId },
    order: { ordinal: "ASC" },
  });
}

/**
 * Give a session that predates turns the turn it always had.
 *
 * Its one exchange lives on the session row — `instruction`, `reply`, and the
 * commit range — so nothing is lost, but a transcript built only from turn
 * rows would show an employee that said nothing, and a follow-up would be
 * replayed no history at all. Materializing it on first read is exact, costs
 * one insert per old session ever, and leaves both paths with a single shape
 * to reason about rather than a fallback that has to be remembered everywhere.
 */
async function ensureFirstTurn(session: RepositoryWorkSession): Promise<void> {
  if (session.turnCount > 0) return;
  const turnRepo = AppDataSource.getRepository(RepositoryWorkSessionTurn);
  if ((await turnRepo.countBy({ sessionId: session.id })) > 0) return;
  await turnRepo.save(
    turnRepo.create({
      companyId: session.companyId,
      sessionId: session.id,
      ordinal: 1,
      instruction: session.instruction,
      reply: session.reply,
      error: session.error,
      status:
        session.status === "running" ? "running" : session.status === "failed" ? "failed" : "ok",
      requestedByUserId: session.requestedByUserId,
      baseCommit: session.baseCommit,
      headCommit: session.headCommit,
      filesChanged: session.filesChanged,
      insertions: session.insertions,
      deletions: session.deletions,
      finishedAt: session.finishedAt,
    }),
  );
  session.turnCount = 1;
  if (!session.title.trim()) session.title = deriveWorkSessionTitle(session.instruction);
  await AppDataSource.getRepository(RepositoryWorkSession).save(session);
}

/** Rename a session, so a list of twenty of them stays navigable. */
export async function renameRepositoryWorkSession(
  companyId: string,
  sessionId: string,
  title: string,
): Promise<RepositoryWorkSession> {
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const session = await sessionRepo.findOneBy({ id: sessionId, companyId });
  if (!session) throw new Error("Work session not found.");
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("A session needs a name.");
  session.title = trimmed.slice(0, WORK_SESSION_TITLE_MAX);
  await sessionRepo.save(session);
  return session;
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
  // `proposed` publishes too: a Member who opened a pull request and then
  // decided to merge it here should not have to throw the session away first.
  if (session.status !== "ready" && session.status !== "proposed") {
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


/**
 * Open (or update) a pull request for this session's branch.
 *
 * The third thing a Member can do with reviewed work, and the one the other
 * two could not express: merging accepts it here and pushing sends it
 * straight to the trunk, while a pull request hands it to whatever review the
 * team already runs on GitHub. Until this existed, work an employee did in
 * Genosyn could only enter a team's normal process by a human re-doing the
 * push by hand.
 *
 * The credential still never leaves the server, and it is still a Member who
 * decides: the employee can commit onto its branch and nothing else. Calling
 * it again after a revision pushes the new commits — GitHub attaches them to
 * the pull request that is already open, so the same button is both "open"
 * and "update" and the row records only the one pull request that exists.
 */
export type WorkSessionPullRequestDeps = {
  push: typeof pushRepositoryBranch;
  resolveToken: (repo: Repository) => Promise<string>;
  createPullRequest: typeof createGithubPullRequest;
  findOpenPullRequest: typeof findOpenGithubPullRequest;
};

export const defaultPullRequestDeps: WorkSessionPullRequestDeps = {
  push: pushRepositoryBranch,
  resolveToken: resolveRepositoryGithubToken,
  createPullRequest: createGithubPullRequest,
  findOpenPullRequest: findOpenGithubPullRequest,
};

export async function openRepositoryWorkSessionPullRequest(args: {
  sessionId: string;
  title?: string;
  body?: string;
  /** Seam for tests; defaults to the real push + GitHub API. */
  deps?: Partial<WorkSessionPullRequestDeps>;
}): Promise<RepositoryWorkSession> {
  const deps = { ...defaultPullRequestDeps, ...(args.deps ?? {}) };
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const session = await sessionRepo.findOneBy({ id: args.sessionId });
  if (!session) throw new Error("Work session not found.");
  if (session.status !== "ready" && session.status !== "proposed") {
    throw new Error("This session has no committed work to propose.");
  }
  if (!session.branch) throw new Error("This session has no branch.");
  const repo = await AppDataSource.getRepository(Repository).findOneBy({
    id: session.repositoryId,
    companyId: session.companyId,
  });
  if (!repo) throw new Error("Repository not found.");
  if (repo.origin !== "remote") {
    throw new Error(
      "This repository lives only in Genosyn, so there is nowhere to open a pull request. Connect it to a remote in settings first.",
    );
  }
  const remote = parseGithubRemote(repo.gitUrl);
  if (!remote) {
    throw new Error(
      "Pull requests are only supported for GitHub remotes. Accept the work here and push it instead.",
    );
  }

  const token = await deps.resolveToken(repo);
  // Push before asking for the pull request: GitHub cannot open one for a
  // branch it has never seen, and a revision's new commits have to be up there
  // before the existing pull request can pick them up.
  await deps.push(repo, session.branch);
  session.publishedBranch = session.branch;

  const existing = await deps.findOpenPullRequest(token, {
    owner: remote.owner,
    repo: remote.repo,
    head: session.branch,
  });
  const pull: GithubPullRequest =
    existing ??
    (await deps.createPullRequest(token, {
      owner: remote.owner,
      repo: remote.repo,
      head: session.branch,
      base: repo.defaultBranch || "main",
      title: (args.title ?? "").trim() || session.title || deriveWorkSessionTitle(session.instruction),
      body: composePullRequestBody(session, args.body),
    }));

  session.pullRequestUrl = pull.htmlUrl;
  session.pullRequestNumber = pull.number;
  session.status = "proposed";
  await sessionRepo.save(session);
  return session;
}

/**
 * What the pull request says when the Member did not write a description.
 *
 * The employee's own report is the honest body: it is what it changed and what
 * it could not verify, written while it still had the work in front of it.
 */
function composePullRequestBody(session: RepositoryWorkSession, override?: string): string {
  const custom = (override ?? "").trim();
  if (custom) return custom;
  const parts = [`**Asked for**`, session.instruction.trim()];
  const reply = session.reply.trim();
  if (reply) parts.push("", "**What the AI employee reported**", reply);
  parts.push("", "_Opened from a Genosyn AI work session._");
  return parts.join("\n");
}

/**
 * A GitHub token that may push to this repository and open pull requests on
 * it.
 *
 * Two shapes are supported because both already exist in the product: a
 * repository carrying its own HTTPS token, and a repository authenticated by
 * the company's GitHub Connection. Anything else is refused with the reason,
 * because failing later inside the API call would report it as a GitHub error
 * rather than a missing credential.
 */
export async function resolveRepositoryGithubToken(repo: Repository): Promise<string> {
  if (!isGithubHttpsUrl(repo.gitUrl)) {
    throw new Error("Pull requests are only supported for https://github.com remotes.");
  }
  if (repo.authMode === "https" && repo.encryptedToken) {
    const token = decryptRepositorySecret(repo.encryptedToken);
    if (token) return token;
  }
  const connection = await findConnectionForRemote(repo);
  if (connection) return (await resolveConnectionToken(connection)).token;
  throw new Error(
    "No GitHub credential is available for this repository. Add a token in its settings, or connect GitHub in Settings → Integrations.",
  );
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

export function composeWorkSystemPrompt(
  repo: Repository,
  sessionId: string,
  options: { revision?: boolean } = {},
): string {
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
    options.revision
      ? "This is a follow-up on work you already did in this same working copy. Your earlier commits are still there and are what the human is looking at, so read the files again rather than trusting your memory of them, change only what has just been asked for, and commit the change as its own commit on top."
      : "",
    repo.kind === "documents"
      ? "This repository holds documents rather than software. Match the surrounding structure and voice, and keep the prose readable."
      : "Match the conventions of the surrounding code. You have no shell and cannot run tests here, so keep changes reviewable and say plainly in your reply what you could not verify.",
    "",
    "Your reply is shown to the human next to your diff. Make it a short report: what you changed, why, and anything you deliberately left alone or could not do.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

function composeWorkBrief(repo: Repository, instruction: string, ordinal: number): string {
  return [
    ordinal > 1
      ? `Continue your work on the repository "${repo.name}". The human has read what you did so far and is asking for this:`
      : `Work on the repository "${repo.name}".`,
    "",
    instruction.trim(),
  ].join("\n");
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
