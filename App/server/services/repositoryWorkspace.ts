import fs from "node:fs";
import path from "node:path";
import { Repository } from "../db/entities/Repository.js";
import { repositoryWorkspaceCheckout, repositoryWorkspaceRoot } from "./paths.js";
import {
  assertSafeCredentialToken,
  assertSafeGitRemoteUrl,
  inlineEnvCredentialHelper,
} from "./gitCredentialHelper.js";
import { runWorkspaceGit } from "./workspaceGit.js";
import {
  buildPrivateFetchSshCommand,
  cloneWorkspaceGitRemote,
  fetchWorkspaceGitRemote,
} from "./workspaceGitRemote.js";
import { decryptRepositorySecret } from "./repositories.js";
import { readRepositoryKnownHosts, persistRepositoryKnownHosts } from "./repositorySshFiles.js";

/**
 * The App-owned working copy of a Repository.
 *
 * Everything a Member does to a repository from the web UI — listing the
 * tree, opening a file, saving an edit, staging a commit, switching a branch,
 * pushing — happens here, in a checkout under
 * `data/.private/repositories/<companyId>/<repositoryId>/checkout`.
 *
 * Why a second checkout, when employees already get one? Because the two have
 * opposite trust properties, and collapsing them would cost the feature its
 * security story:
 *
 *   - the employee's checkout is *model-writable*, so it never receives a
 *     credential, a credentialed push URL, or a reusable helper;
 *   - this checkout is *model-unreachable*, so it may hold a real `origin`
 *     and push with the company's stored token or key.
 *
 * A branch moves from the first to the second only when a Member reviews it
 * and says so — see `repositoryWorkSessions.ts`.
 *
 * Every Git child spawned here passes `serverOwned: true`, which is what
 * exempts it from the coding-runtime gate. See the option's own comment in
 * `workspaceGit.ts` for why that exemption is sound; the short version is
 * that the gate protects against Git reading executable configuration out of
 * a tree the model controls, and the model does not control this tree.
 */

/**
 * The largest file the browser editor will open, and the largest a save
 * request may carry. Deliberately one number rather than two.
 *
 * The ceiling comes from the save path: a save travels as a JSON string, where
 * escaping newlines and quotes can nearly double the byte count, and the App's
 * global body limit is 1 MB (`express.json` in `server/index.ts`). Reading
 * could afford to be more generous — but a file you can open and then cannot
 * save is a worse experience than one that says plainly it is too big, and it
 * would need its own state in the editor to express. If you raise this, raise
 * the body limit first.
 */
export const MAX_EDITABLE_FILE_BYTES = 256 * 1024;

/** Reads and writes share one ceiling; see above. */
export const MAX_VIEWABLE_FILE_BYTES = MAX_EDITABLE_FILE_BYTES;

/** Cap on a single diff response so one enormous commit can't wedge the UI. */
export const MAX_DIFF_BYTES = 1024 * 1024;

/** Cap on how many entries one directory listing returns. */
export const MAX_TREE_ENTRIES = 2000;

export type RepositoryTreeEntry = {
  name: string;
  /** Repository-root-relative POSIX path. */
  path: string;
  type: "file" | "directory";
  size: number;
};

export type RepositoryFileContent = {
  path: string;
  /** Absent when the file is binary or over {@link MAX_VIEWABLE_FILE_BYTES}. */
  content: string | null;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  /** Readable but too big to save back — the editor opens it read-only. */
  readOnly: boolean;
  /** Set when the content came from history rather than the working tree. */
  ref: string | null;
};

export type RepositoryChange = {
  path: string;
  /** Renames carry where the file came from. */
  fromPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
};

export type RepositoryStatus = {
  branch: string | null;
  /** True before the first commit, when HEAD points at a branch that has none. */
  unborn: boolean;
  detached: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
  changes: RepositoryChange[];
};

export type RepositoryCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  parents: string[];
};

export type RepositoryBranch = {
  name: string;
  remote: boolean;
  current: boolean;
  sha: string;
  subject: string;
  committedAt: string;
};

export type RepositoryDiff = {
  /** Raw unified diff, capped at {@link MAX_DIFF_BYTES}. */
  patch: string;
  truncated: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

// ─────────────────────────── path safety ────────────────────────────────

/**
 * Normalize a client-supplied repository path.
 *
 * Everything reachable from the API is expressed as a POSIX path relative to
 * the repository root. A leading slash is taken to mean "from the repository
 * root" and dropped, because that is what someone typing `/docs/plan.md` into
 * a file browser means.
 *
 * `..`, NUL bytes, and anything inside `.git` are rejected outright rather
 * than clamped: a request that tried to leave the repository is a bug or an
 * attack, and silently rewriting it into a different valid path is the worse
 * answer to both.
 */
export function normalizeRepositoryPath(input: string, { allowRoot = false } = {}): string {
  if (input.includes("\0")) throw new Error("Path contains an invalid character.");
  const trimmed = input.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") {
    if (allowRoot) return "";
    throw new Error("A file path is required.");
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Path must not contain empty or relative segments.");
    }
    if (segment === ".git") {
      throw new Error("The .git directory is managed by Genosyn and cannot be edited.");
    }
  }
  return segments.join("/");
}

/**
 * Resolve a repository-relative path to a real filesystem path inside the
 * checkout, refusing anything that escapes it.
 *
 * `realpathSync` on the parent is what closes the symlink hole: a tracked
 * symlink pointing at `/etc` would otherwise let a plain "save this file"
 * request write outside the checkout entirely.
 */
export function resolveInCheckout(checkout: string, relativePath: string): string {
  const normalized = normalizeRepositoryPath(relativePath, { allowRoot: true });
  const checkoutReal = fs.realpathSync(checkout);
  const target = path.join(checkoutReal, normalized);
  const parentReal = existingAncestorRealPath(target);
  const relative = path.relative(checkoutReal, parentReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path escapes the repository.");
  }
  return target;
}

function existingAncestorRealPath(target: string): string {
  let candidate = target;
  for (;;) {
    try {
      return fs.realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

// ───────────────────────────── git plumbing ─────────────────────────────

function checkoutPath(repo: Repository): string {
  return repositoryWorkspaceCheckout(repo.companyId, repo.id);
}

function workspaceRootFor(repo: Repository): string {
  return repositoryWorkspaceRoot(repo.companyId, repo.id);
}

/**
 * Run one Git command anywhere inside this repository's App-owned workspace —
 * the Member checkout, or a session worktree beside it. Both live under the
 * same workspace root, which is what the containment checks pin against.
 */
export async function runRepositoryGit(
  repo: Repository,
  cwd: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const { stdout } = await runWorkspaceGit({
    workspaceRoot: workspaceRootFor(repo),
    cwd,
    args,
    stdin,
    serverOwned: true,
  });
  return stdout;
}

/** Run one Git command inside the Member checkout. */
async function git(repo: Repository, args: string[], stdin?: string): Promise<string> {
  return runRepositoryGit(repo, checkoutPath(repo), args, stdin);
}

/** Same, but a non-zero exit is an expected answer rather than a failure. */
async function gitOrNull(repo: Repository, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

export function repositoryWorkspaceRootFor(repo: Repository): string {
  return workspaceRootFor(repo);
}

export function repositoryCheckoutExists(repo: Repository): boolean {
  return fs.existsSync(path.join(checkoutPath(repo), ".git"));
}

// In-process mutex per repository. Two Members saving different files at once
// is fine; two Git index operations at once is not.
const inflight = new Map<string, Promise<unknown>>();

export function withRepositoryLock<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inflight.get(repositoryId);
  const next = (prior ? prior.catch(() => {}) : Promise.resolve()).then(fn);
  // The queue entry must never be the only reference to a rejected promise:
  // the caller owns the failure, and an uncaught copy sitting in this map is
  // reported as an unhandled rejection that takes the whole process down.
  const queued = next.then(
    () => {},
    () => {},
  );
  inflight.set(
    repositoryId,
    queued.finally(() => {
      if (inflight.get(repositoryId) === queued) inflight.delete(repositoryId);
    }),
  );
  return next;
}

// ───────────────────────── credentials (server-side only) ───────────────

type RemoteCredential = {
  extraEnv: Record<string, string>;
  credentialHelper?: string;
  sshCredential?: { privateKey: string; knownHosts?: string };
};

/**
 * Decrypt the repository's stored credential for one server-owned network
 * operation. The returned material is passed straight to the Git child and is
 * never written into the checkout, so there is nothing to clean up afterwards.
 */
function remoteCredentialFor(repo: Repository): RemoteCredential {
  if (repo.authMode === "https") {
    const token = decryptRepositorySecret(repo.encryptedToken);
    if (!token) {
      throw new Error(
        "The HTTPS token is missing or could not be decrypted. Re-enter it in repository settings.",
      );
    }
    assertSafeCredentialToken(token);
    if (!/^https:\/\//i.test(repo.gitUrl)) {
      throw new Error("HTTPS credentials require an https:// clone URL.");
    }
    const envKey = "GENOSYN_REPO_TOKEN_WORKSPACE";
    const username = (repo.httpsUsername ?? "").trim() || "git";
    return {
      extraEnv: { [envKey]: token },
      credentialHelper: inlineEnvCredentialHelper(username, envKey, repo.gitUrl),
    };
  }
  if (repo.authMode === "ssh") {
    const key = decryptRepositorySecret(repo.encryptedSshKey);
    if (!key) {
      throw new Error(
        "The SSH key is missing or could not be decrypted. Re-enter it in repository settings.",
      );
    }
    return {
      extraEnv: {},
      sshCredential: {
        privateKey: key,
        knownHosts: readRepositoryKnownHosts(repo.companyId, repo.id),
      },
    };
  }
  return { extraEnv: {} };
}

function rememberKnownHosts(repo: Repository, knownHosts: string | undefined): void {
  if (knownHosts === undefined) return;
  persistRepositoryKnownHosts(repo.companyId, repo.id, knownHosts);
}

// ──────────────────────────── lifecycle ─────────────────────────────────

/**
 * Make sure the App-owned checkout exists and, for a remote repository, that
 * its `origin/*` refs are current.
 *
 * Like the employee materializer this never resets the working tree: a Member
 * may have unsaved edits or an unpushed commit in here, and a background
 * refresh that threw those away would be the single worst bug this feature
 * could have.
 */
export async function ensureRepositoryWorkspace(repo: Repository): Promise<string> {
  return withRepositoryLock(repo.id, async () => {
    const checkout = checkoutPath(repo);
    const root = workspaceRootFor(repo);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });

    if (!repositoryCheckoutExists(repo)) {
      if (repo.origin === "local") {
        await initLocalCheckout(repo, checkout);
      } else {
        assertSafeGitRemoteUrl(repo.gitUrl);
        const credential = remoteCredentialFor(repo);
        const result = await cloneWorkspaceGitRemote({
          workspaceRoot: root,
          destinationPath: checkout,
          remoteUrl: repo.gitUrl,
          extraEnv: credential.extraEnv,
          credentialHelper: credential.credentialHelper,
          sshCredential: credential.sshCredential,
          serverOwned: true,
        });
        rememberKnownHosts(repo, result.sshKnownHosts);
        await git(repo, ["remote", "set-url", "origin", repo.gitUrl]);
      }
      await applyCommitterIdentity(repo);
      return checkout;
    }

    if (repo.origin === "remote") {
      assertSafeGitRemoteUrl(repo.gitUrl);
      const credential = remoteCredentialFor(repo);
      const result = await fetchWorkspaceGitRemote({
        workspaceRoot: root,
        cwd: checkout,
        remoteUrl: repo.gitUrl,
        extraEnv: credential.extraEnv,
        credentialHelper: credential.credentialHelper,
        sshCredential: credential.sshCredential,
        serverOwned: true,
      });
      rememberKnownHosts(repo, result.sshKnownHosts);
    }
    await applyCommitterIdentity(repo);
    return checkout;
  });
}

/**
 * A brand-new repository with no remote. `git init` plus one empty commit, so
 * the repository has a HEAD to branch from and diff against immediately —
 * an unborn HEAD makes half of Git's read commands special-case, and the
 * first thing a person does here is create a file.
 */
async function initLocalCheckout(repo: Repository, checkout: string): Promise<void> {
  fs.mkdirSync(checkout, { recursive: true, mode: 0o700 });
  const branch = (repo.defaultBranch || "main").trim() || "main";
  await git(repo, ["init", "--quiet", `--initial-branch=${branch}`]);
  await applyCommitterIdentity(repo);
  await git(repo, ["commit", "--allow-empty", "--quiet", "-m", "Create repository"]);
}

async function applyCommitterIdentity(repo: Repository): Promise<void> {
  const name = (repo.committerName ?? "").trim() || "Genosyn";
  const email = (repo.committerEmail ?? "").trim() || "repositories@genosyn.local";
  await git(repo, ["config", "--local", "user.name", name]);
  await git(repo, ["config", "--local", "user.email", email]);
}

/** Drop the App-owned checkout, e.g. when the repository row is deleted. */
export function removeRepositoryWorkspace(companyId: string, repositoryId: string): void {
  fs.rmSync(repositoryWorkspaceRoot(companyId, repositoryId), {
    recursive: true,
    force: true,
  });
}

// ────────────────────────────── reading ─────────────────────────────────

/**
 * List one directory of the working tree.
 *
 * Read from the filesystem rather than `git ls-tree` on purpose: this is an
 * editor, and an editor has to show the file you just created before you have
 * committed it. `.git` is the only thing hidden.
 */
export async function listRepositoryTree(
  repo: Repository,
  directoryPath: string,
): Promise<RepositoryTreeEntry[]> {
  const checkout = checkoutPath(repo);
  const normalized = normalizeRepositoryPath(directoryPath, { allowRoot: true });
  const absolute = resolveInCheckout(checkout, normalized);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Directory not found.");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new Error("That path is a file, not a directory.");
    }
    throw error;
  }

  const entries: RepositoryTreeEntry[] = [];
  for (const dirent of dirents) {
    if (!normalized && dirent.name === ".git") continue;
    if (dirent.isSymbolicLink()) continue;
    const entryPath = normalized ? `${normalized}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: entryPath, type: "directory", size: 0 });
    } else if (dirent.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(path.join(absolute, dirent.name)).size;
      } catch {
        continue;
      }
      entries.push({ name: dirent.name, path: entryPath, type: "file", size });
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries.slice(0, MAX_TREE_ENTRIES);
}

/** Read a file from the working tree, or from `ref` when one is given. */
export async function readRepositoryFile(
  repo: Repository,
  filePath: string,
  ref?: string | null,
): Promise<RepositoryFileContent> {
  const normalized = normalizeRepositoryPath(filePath);
  if (ref) {
    assertSafeRef(ref);
    const buffer = await gitBuffer(repo, ["show", `${ref}:${normalized}`]);
    if (buffer === null) throw new Error("File not found at that revision.");
    return describeBuffer(normalized, buffer, ref);
  }
  const absolute = resolveInCheckout(checkoutPath(repo), normalized);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("File not found.");
    throw error;
  }
  if (stat.isDirectory()) throw new Error("That path is a directory.");
  if (!stat.isFile()) throw new Error("That path is not a regular file.");
  if (stat.size > MAX_VIEWABLE_FILE_BYTES) {
    return {
      path: normalized,
      content: null,
      size: stat.size,
      binary: false,
      tooLarge: true,
      readOnly: true,
      ref: null,
    };
  }
  return describeBuffer(normalized, fs.readFileSync(absolute), null);
}

function describeBuffer(
  filePath: string,
  buffer: Buffer,
  ref: string | null,
): RepositoryFileContent {
  if (buffer.length > MAX_VIEWABLE_FILE_BYTES) {
    return {
      path: filePath,
      content: null,
      size: buffer.length,
      binary: false,
      tooLarge: true,
      readOnly: true,
      ref,
    };
  }
  const binary = isBinary(buffer);
  return {
    path: filePath,
    content: binary ? null : buffer.toString("utf8"),
    size: buffer.length,
    binary,
    tooLarge: false,
    // History is never editable in place, and neither is anything the save
    // route would reject.
    readOnly: binary || ref !== null || buffer.length > MAX_EDITABLE_FILE_BYTES,
    ref,
  };
}

/** A NUL byte in the first 8 KB is how Git itself decides a blob is binary. */
export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

async function gitBuffer(repo: Repository, args: string[]): Promise<Buffer | null> {
  const out = await gitOrNull(repo, args);
  return out === null ? null : Buffer.from(out, "utf8");
}

/** Working-tree and index state, plus how far the branch is from its upstream. */
export async function repositoryStatus(repo: Repository): Promise<RepositoryStatus> {
  const raw = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "-b"]);
  return parseStatus(raw);
}

/**
 * Parse `git status --porcelain=v1 -z -b`.
 *
 * The NUL-separated form is the only one that survives filenames containing
 * newlines or quotes without a second layer of unescaping. Renames spend two
 * records — the new path then the old — which is why this walks an index
 * rather than mapping over the records.
 */
export function parseStatus(raw: string): RepositoryStatus {
  const records = raw.split("\0");
  const result: RepositoryStatus = {
    branch: null,
    unborn: false,
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    changes: [],
  };

  let index = 0;
  if (records[0]?.startsWith("## ")) {
    const header = records[0].slice(3);
    parseBranchHeader(header, result);
    index = 1;
  }

  for (; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const x = record[0];
    const y = record[1];
    const filePath = record.slice(3);
    if (x === "?" && y === "?") {
      result.changes.push({ path: filePath, fromPath: null, status: "untracked", staged: false });
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      result.changes.push({ path: filePath, fromPath: null, status: "conflicted", staged: false });
      continue;
    }
    if (x === "R" || x === "C") {
      // The record after a rename/copy holds the original path.
      const fromPath = records[index + 1] ?? null;
      index += 1;
      result.changes.push({ path: filePath, fromPath, status: "renamed", staged: true });
      if (y !== " ") {
        result.changes.push({ path: filePath, fromPath: null, status: "modified", staged: false });
      }
      continue;
    }
    if (x !== " " && x !== "?") {
      result.changes.push({
        path: filePath,
        fromPath: null,
        status: letterToStatus(x),
        staged: true,
      });
    }
    if (y !== " " && y !== "?") {
      result.changes.push({
        path: filePath,
        fromPath: null,
        status: letterToStatus(y),
        staged: false,
      });
    }
  }
  return result;
}

function letterToStatus(letter: string): RepositoryChange["status"] {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified";
}

function parseBranchHeader(header: string, result: RepositoryStatus): void {
  if (header.startsWith("HEAD (no branch)")) {
    result.detached = true;
    return;
  }
  // `## main...origin/main [ahead 1, behind 2]`, or `## No commits yet on main`.
  const unborn = header.match(/^No commits yet on (.+)$/);
  if (unborn) {
    result.unborn = true;
    result.branch = unborn[1].trim();
    return;
  }
  const tracking = header.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
  if (!tracking) {
    result.branch = header.trim() || null;
    return;
  }
  result.branch = tracking[1].trim() || null;
  result.upstream = tracking[2] ?? null;
  const counts = tracking[3];
  if (counts) {
    result.ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
    result.behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
  }
}

const COMMIT_FORMAT = "%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P";

/** Commit history, optionally narrowed to one path. */
export async function repositoryLog(
  repo: Repository,
  options: { ref?: string | null; filePath?: string | null; limit?: number } = {},
): Promise<RepositoryCommit[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const args = ["log", `--format=${COMMIT_FORMAT}%x1e`, `--max-count=${limit}`];
  if (options.ref) {
    assertSafeRef(options.ref);
    args.push(options.ref);
  }
  if (options.filePath) {
    args.push("--", normalizeRepositoryPath(options.filePath));
  }
  const raw = await gitOrNull(repo, args);
  // A repository whose HEAD has no commits exits non-zero here; that is an
  // empty history, not an error.
  return raw === null ? [] : parseCommits(raw);
}

export function parseCommits(raw: string): RepositoryCommit[] {
  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, shortSha, subject, body, authorName, authorEmail, authoredAt, parents] =
        record.split("\x1f");
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim(),
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        authoredAt: authoredAt ?? "",
        parents: (parents ?? "").split(" ").filter(Boolean),
      };
    });
}

/** Local branches plus `origin/*`, newest commit first. */
export async function repositoryBranches(repo: Repository): Promise<RepositoryBranch[]> {
  const raw = await gitOrNull(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%1f%(objectname)%1f%(contents:subject)%1f%(committerdate:iso-strict)%1f%(HEAD)",
    "refs/heads/",
    "refs/remotes/origin/",
  ]);
  if (raw === null) return [];
  const branches: RepositoryBranch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [refname, sha, subject, committedAt, head] = line.split("\x1f");
    if (!refname) continue;
    if (refname === "refs/remotes/origin/HEAD") continue;
    const remote = refname.startsWith("refs/remotes/");
    const name = remote
      ? refname.slice("refs/remotes/".length)
      : refname.slice("refs/heads/".length);
    branches.push({
      name,
      remote,
      current: head === "*",
      sha: sha ?? "",
      subject: subject ?? "",
      committedAt: committedAt ?? "",
    });
  }
  return branches;
}

/**
 * The diff a Member reviews before committing: everything that differs from
 * HEAD, staged or not, plus the contents of files git has never seen.
 *
 * Untracked files are rendered by hand rather than by asking git. `git diff
 * --no-index` would produce them, but it exits non-zero whenever the files
 * differ — which here is always — and the workspace git runner reports a
 * non-zero exit as a failure without handing back stdout. Staging the files
 * with `--intent-to-add` would work too, at the cost of a read operation
 * quietly mutating the index. Writing the hunk is the only option that is
 * neither lossy nor surprising.
 */
export async function repositoryWorkingDiff(
  repo: Repository,
  filePath?: string | null,
): Promise<RepositoryDiff> {
  const scoped = filePath ? normalizeRepositoryPath(filePath) : null;
  const args = ["diff", "HEAD", "--no-color", "--unified=3", "--no-ext-diff"];
  if (scoped) args.push("--", scoped);
  let patch = (await gitOrNull(repo, args)) ?? "";

  const status = await repositoryStatus(repo);
  for (const change of status.changes) {
    if (change.status !== "untracked") continue;
    if (scoped && change.path !== scoped) continue;
    patch += renderUntrackedFileDiff(checkoutPath(repo), change.path);
    if (Buffer.byteLength(patch) > MAX_DIFF_BYTES) break;
  }
  return summarizeDiff(patch);
}

/** A unified-diff block presenting a whole new file as additions. */
function renderUntrackedFileDiff(checkout: string, relativePath: string): string {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(resolveInCheckout(checkout, relativePath));
  } catch {
    return "";
  }
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n`;
  if (isBinary(buffer)) {
    return `${header}Binary file ${relativePath} added\n`;
  }
  if (buffer.length > MAX_VIEWABLE_FILE_BYTES) {
    return `${header}File is too large to display\n`;
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  // A trailing newline splits into a final empty element that is not a line.
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();
  if (lines.length === 0) return `${header}--- /dev/null\n+++ b/${relativePath}\n`;
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewline = endsWithNewline ? "" : "\n\\ No newline at end of file";
  return (
    `${header}--- /dev/null\n+++ b/${relativePath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}\n`
  );
}

/** The diff of one commit against its first parent. */
export async function repositoryCommitDiff(
  repo: Repository,
  sha: string,
): Promise<RepositoryDiff & { commit: RepositoryCommit | null }> {
  assertSafeRef(sha);
  const [meta] = parseCommits(
    (await gitOrNull(repo, ["show", "--no-patch", `--format=${COMMIT_FORMAT}%x1e`, sha])) ?? "",
  );
  const patch =
    (await gitOrNull(repo, [
      "show",
      "--no-color",
      "--unified=3",
      "--no-ext-diff",
      "--format=",
      sha,
    ])) ?? "";
  return { ...summarizeDiff(patch), commit: meta ?? null };
}

/** Diff between two refs — used to review an employee's branch. */
export async function repositoryRangeDiff(
  repo: Repository,
  from: string,
  to: string,
): Promise<RepositoryDiff> {
  assertSafeRef(from);
  assertSafeRef(to);
  const patch =
    (await gitOrNull(repo, ["diff", "--no-color", "--unified=3", "--no-ext-diff", from, to])) ?? "";
  return summarizeDiff(patch);
}

/**
 * Derive the file/insertion/deletion counts from the patch we already have
 * rather than paying for a second `--numstat` invocation.
 */
export function summarizeDiff(patch: string): RepositoryDiff {
  const truncated = Buffer.byteLength(patch) > MAX_DIFF_BYTES;
  const body = truncated ? patch.slice(0, MAX_DIFF_BYTES) : patch;
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) filesChanged += 1;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { patch: body, truncated, filesChanged, insertions, deletions };
}

// ────────────────────────────── writing ─────────────────────────────────

export async function writeRepositoryFile(
  repo: Repository,
  filePath: string,
  content: string,
): Promise<void> {
  if (Buffer.byteLength(content) > MAX_EDITABLE_FILE_BYTES) {
    throw new Error("That file is too large to save from the editor.");
  }
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(checkoutPath(repo), normalized);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
    throw new Error("That path is a directory.");
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

export async function deleteRepositoryEntry(repo: Repository, entryPath: string): Promise<void> {
  const normalized = normalizeRepositoryPath(entryPath);
  const absolute = resolveInCheckout(checkoutPath(repo), normalized);
  if (!fs.existsSync(absolute)) throw new Error("File not found.");
  fs.rmSync(absolute, { recursive: true, force: true });
}

export async function moveRepositoryEntry(
  repo: Repository,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const checkout = checkoutPath(repo);
  const from = resolveInCheckout(checkout, normalizeRepositoryPath(fromPath));
  const to = resolveInCheckout(checkout, normalizeRepositoryPath(toPath));
  if (!fs.existsSync(from)) throw new Error("File not found.");
  if (fs.existsSync(to)) throw new Error("Something already exists at that path.");
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

export async function createRepositoryDirectory(
  repo: Repository,
  directoryPath: string,
): Promise<void> {
  const normalized = normalizeRepositoryPath(directoryPath);
  const absolute = resolveInCheckout(checkoutPath(repo), normalized);
  if (fs.existsSync(absolute)) throw new Error("Something already exists at that path.");
  fs.mkdirSync(absolute, { recursive: true });
  // Git has no concept of an empty directory, so keep one until the person
  // puts a real file in it — otherwise the folder they just made vanishes on
  // the next reload.
  fs.writeFileSync(path.join(absolute, ".gitkeep"), "");
}

// ─────────────────────────── version control ────────────────────────────

export type CommitRequest = {
  message: string;
  /** Omit to commit everything that changed. */
  paths?: string[];
  authorName?: string | null;
  authorEmail?: string | null;
};

export async function commitRepositoryChanges(
  repo: Repository,
  request: CommitRequest,
): Promise<{ sha: string } | null> {
  const message = request.message.trim();
  if (!message) throw new Error("A commit message is required.");

  return withRepositoryLock(repo.id, async () => {
    if (request.paths && request.paths.length > 0) {
      const normalized = request.paths.map((p) => normalizeRepositoryPath(p));
      await git(repo, ["add", "--all", "--", ...normalized]);
    } else {
      await git(repo, ["add", "--all"]);
    }

    const staged = await gitOrNull(repo, ["diff", "--cached", "--name-only"]);
    if (!staged || staged.trim() === "") return null;

    const args = ["commit", "--quiet", "-m", message];
    const authorName = (request.authorName ?? "").trim();
    const authorEmail = (request.authorEmail ?? "").trim();
    if (authorName && authorEmail) {
      args.push(`--author=${authorName} <${authorEmail}>`);
    }
    await git(repo, args);
    const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    return { sha };
  });
}

/**
 * Discard working-tree changes. Scoped to explicit paths — there is no
 * "discard everything" button, because on a shared checkout that is a
 * destructive action nobody can undo.
 */
export async function discardRepositoryChanges(
  repo: Repository,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) throw new Error("Select what to discard.");
  const normalized = paths.map((p) => normalizeRepositoryPath(p));
  await withRepositoryLock(repo.id, async () => {
    // Sort the paths first. `git restore` fails outright on a path it has
    // never tracked, and one untracked file in the list would otherwise take
    // the whole restore down with it, silently leaving every edited file
    // exactly as it was.
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const relative of normalized) {
      const known = await gitOrNull(repo, ["ls-files", "--error-unmatch", "--", relative]);
      if (known) tracked.push(relative);
      else untracked.push(relative);
    }
    if (tracked.length > 0) {
      await git(repo, ["restore", "--staged", "--worktree", "--", ...tracked]);
    }
    for (const relative of untracked) {
      const absolute = resolveInCheckout(checkoutPath(repo), relative);
      if (fs.existsSync(absolute)) fs.rmSync(absolute, { recursive: true, force: true });
    }
  });
}

/** Branch names are user input that reaches Git as an argument. */
export function assertSafeBranchName(name: string): void {
  if (!name || name.length > 200) throw new Error("Enter a branch name.");
  if (!/^[A-Za-z0-9._\-/]+$/.test(name)) {
    throw new Error("Branch names may use letters, numbers, dot, dash, underscore, and slash.");
  }
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    throw new Error("That branch name is not valid.");
  }
  if (name.includes("..") || name.includes("//") || name.endsWith(".lock")) {
    throw new Error("That branch name is not valid.");
  }
}

/**
 * Refs reach Git as arguments too, and `show`/`diff` accept a lot of syntax.
 * Keep it to the shapes the UI actually produces.
 */
export function assertSafeRef(ref: string): void {
  if (!ref || ref.length > 250) throw new Error("Enter a revision.");
  if (!/^[A-Za-z0-9._\-/~^]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new Error("That revision is not valid.");
  }
}

export async function createRepositoryBranch(
  repo: Repository,
  name: string,
  from?: string | null,
): Promise<void> {
  assertSafeBranchName(name);
  if (from) assertSafeRef(from);
  await withRepositoryLock(repo.id, async () => {
    const args = ["switch", "--create", name];
    if (from) args.push(from);
    await git(repo, args);
  });
}

export async function checkoutRepositoryBranch(repo: Repository, name: string): Promise<void> {
  assertSafeBranchName(name);
  await withRepositoryLock(repo.id, async () => {
    const local = await gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${name}`]);
    if (local) {
      await git(repo, ["switch", name]);
      return;
    }
    const remote = await gitOrNull(repo, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${name}`,
    ]);
    if (!remote) throw new Error("That branch does not exist.");
    await git(repo, ["switch", "--create", name, "--track", `origin/${name}`]);
  });
}

/**
 * Publish the current branch to the remote.
 *
 * The remote URL is passed explicitly instead of naming `origin` so the push
 * cannot be redirected by anything in the repository's own config, and the
 * credential is scoped to this one command.
 */
export async function pushRepositoryBranch(
  repo: Repository,
  branch: string,
): Promise<{ branch: string }> {
  if (repo.origin === "local") {
    throw new Error("This repository has no remote. Add a git URL in settings to publish it.");
  }
  assertSafeBranchName(branch);
  assertSafeGitRemoteUrl(repo.gitUrl);

  return withRepositoryLock(repo.id, async () => {
    const credential = remoteCredentialFor(repo);
    await withPushSshMaterial(repo, credential, async (extraEnv) => {
      await runWorkspaceGit({
        workspaceRoot: workspaceRootFor(repo),
        cwd: checkoutPath(repo),
        args: ["push", repo.gitUrl, `refs/heads/${branch}:refs/heads/${branch}`],
        extraEnv,
        credentialHelper: credential.credentialHelper,
        serverOwned: true,
      });
    });
    // Reflect the push locally so status stops reporting the branch as ahead.
    await git(repo, [
      "update-ref",
      `refs/remotes/origin/${branch}`,
      `refs/heads/${branch}`,
    ]).catch(() => {});
    return { branch };
  });
}

/**
 * Materialize an SSH key for exactly one push and remove it afterwards.
 *
 * The key lands inside the repository's App-private workspace root — the same
 * directory the checkout lives in, which is why a bubblewrapped git can still
 * see it at `/workspace/...`. Nothing a model can reach is under `.private/`,
 * and the directory is removed in a `finally` whether the push succeeds or
 * not. HTTPS and anonymous repositories skip all of this.
 */
async function withPushSshMaterial(
  repo: Repository,
  credential: RemoteCredential,
  run: (extraEnv: Record<string, string>) => Promise<void>,
): Promise<void> {
  if (!credential.sshCredential) {
    await run(credential.extraEnv);
    return;
  }
  const root = workspaceRootFor(repo);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, ".push-ssh-"));
  fs.chmodSync(directory, 0o700);
  try {
    const keyPath = path.join(directory, "key");
    const knownHostsPath = path.join(directory, "known_hosts");
    const privateKey = credential.sshCredential.privateKey;
    fs.writeFileSync(keyPath, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(knownHostsPath, credential.sshCredential.knownHosts ?? "", { mode: 0o600 });
    await run({
      ...credential.extraEnv,
      GIT_SSH_COMMAND: buildPrivateFetchSshCommand(root, keyPath, knownHostsPath),
    });
    rememberKnownHosts(repo, fs.readFileSync(knownHostsPath, "utf8"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Bring the current branch up to date with its remote counterpart.
 *
 * Fast-forward only. A merge that can conflict needs a conflict-resolution UI
 * to be honest about, and this one does not have one yet — better to say
 * "diverged" than to leave a Member staring at conflict markers in a web
 * editor with no way out.
 */
export async function pullRepositoryBranch(
  repo: Repository,
  branch: string,
): Promise<{ updated: boolean }> {
  if (repo.origin === "local") throw new Error("This repository has no remote to pull from.");
  assertSafeBranchName(branch);
  await ensureRepositoryWorkspace(repo);
  return withRepositoryLock(repo.id, async () => {
    const target = await gitOrNull(repo, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${branch}`,
    ]);
    if (!target) throw new Error("That branch does not exist on the remote yet.");
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
    try {
      await git(repo, ["merge", "--ff-only", `refs/remotes/origin/${branch}`]);
    } catch {
      throw new Error(
        "This branch has diverged from the remote. Publish or discard your local commits first.",
      );
    }
    const after = (await git(repo, ["rev-parse", "HEAD"])).trim();
    return { updated: before !== after };
  });
}

/**
 * Merge a branch that already lives in this repository's object store into the
 * Member checkout's current branch.
 *
 * This is how an AI Employee's reviewed work lands: the session worktree
 * shares the object store, so by the time a Member presses the button the
 * commits are already here and nothing has to be transferred.
 *
 * A conflicting merge is aborted rather than left half-applied. A web editor
 * with no conflict-resolution UI has no honest way to hand someone a tree full
 * of conflict markers, and leaving the merge in progress would block every
 * later operation on the checkout.
 */
export async function mergeBranchIntoCurrent(
  repo: Repository,
  branch: string,
): Promise<{ merged: boolean; alreadyUpToDate: boolean }> {
  assertSafeBranchName(branch);
  return withRepositoryLock(repo.id, async () => {
    const status = await repositoryStatus(repo);
    if (status.changes.length > 0) {
      throw new Error(
        "Commit or discard your own changes in this repository before merging other work in.",
      );
    }
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
    try {
      await git(repo, ["merge", "--no-edit", `refs/heads/${branch}`]);
    } catch (error) {
      await gitOrNull(repo, ["merge", "--abort"]);
      throw new Error(
        `That work conflicts with the current branch and was not merged. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      );
    }
    const after = (await git(repo, ["rev-parse", "HEAD"])).trim();
    return { merged: before !== after, alreadyUpToDate: before === after };
  });
}

export function repositoryCheckoutPath(repo: Repository): string {
  return checkoutPath(repo);
}
