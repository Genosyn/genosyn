import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository } from "../db/entities/Repository.js";
import type { RepositoryAuthMode } from "../db/entities/Repository.js";
import {
  EmployeeRepositoryGrant,
  REPOSITORY_ACCESS_RANK,
} from "../db/entities/EmployeeRepositoryGrant.js";
import type { RepositoryAccessLevel } from "../db/entities/EmployeeRepositoryGrant.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { toSlug } from "../lib/slug.js";
import {
  assertSafeCredentialToken,
  assertSafeGitRemoteUrl,
  clearEnvCredentialHelper,
  inlineEnvCredentialHelper,
} from "./gitCredentialHelper.js";
import type { GithubRepoCredential } from "./repoSync.js";
import { runWorkspaceGit } from "./workspaceGit.js";
import { cloneWorkspaceGitRemote, fetchWorkspaceGitRemote } from "./workspaceGitRemote.js";
import {
  persistRepositoryKnownHosts,
  purgeLegacyRepositorySshFiles,
  readRepositoryKnownHosts,
} from "./repositorySshFiles.js";

/**
 * Repository seam — the provider-agnostic cousin of `repoSync.ts`.
 *
 * Where `repoSync` materializes repos that ride on a GitHub *Connection*
 * (OAuth / App / PAT) and an allowlist, this module materializes
 * first-class **Repository** rows the company added directly: any
 * HTTPS or SSH git URL, with credentials stored encrypted on the row and
 * access handed out per-employee via {@link EmployeeRepositoryGrant}.
 *
 * Before each chat / routine spawn the runner calls
 * {@link materializeRepositoriesForEmployee}, which drops a real `git clone`
 * of every granted repo into `<employeeDir>/repositories/<slug>/`. As in
 * `repoSync`, we only ever `fetch` on an existing
 * checkout (never `reset --hard`) so the employee's WIP between spawns is
 * never trampled.
 *
 * Credentials are handed only to the short-lived, server-owned clone/fetch
 * workspace. Tokens and SSH private keys never enter the model-visible
 * checkout, its Git config, or the model tool environment.
 */

// ───────────────────────────── slugs ────────────────────────────────────

export async function uniqueRepositorySlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Repository);
  const root = toSlug(base) || "repo";
  let slug = root;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

// ────────────────────────── credentials ─────────────────────────────────

export function encryptRepoSecret(plaintext: string, companyId: string): string {
  return encryptSecret(plaintext, `company:${companyId}`);
}

/**
 * Decrypt a stored repository credential, or null when there is none and when
 * the blob no longer decrypts — a lost or rotated instance encryption key
 * should surface as "re-enter the credential", not as a crash.
 */
export function decryptRepositorySecret(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

/** What the client is allowed to know about a repo's stored credentials —
 *  never the secret itself, only whether one is present. */
export function credentialSummary(repo: Repository): {
  hasToken: boolean;
  hasSshKey: boolean;
} {
  return {
    hasToken: !!repo.encryptedToken,
    hasSshKey: !!repo.encryptedSshKey,
  };
}

// ───────────────────────────── grants ───────────────────────────────────

export async function upsertRepositoryGrant(
  employeeId: string,
  repositoryId: string,
  accessLevel: RepositoryAccessLevel,
): Promise<EmployeeRepositoryGrant> {
  const repo = AppDataSource.getRepository(EmployeeRepositoryGrant);
  const existing = await repo.findOneBy({ employeeId, repositoryId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  const row = repo.create({ employeeId, repositoryId, accessLevel });
  await repo.save(row);
  return row;
}

export async function listDirectRepositoryGrants(
  repositoryId: string,
): Promise<EmployeeRepositoryGrant[]> {
  return AppDataSource.getRepository(EmployeeRepositoryGrant).find({
    where: { repositoryId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForRepository(repositoryId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({
    repositoryId,
  });
}

export async function hasRepositoryAccess(
  employeeId: string,
  repositoryId: string,
  required: RepositoryAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeRepositoryGrant).findOneBy({
    employeeId,
    repositoryId,
  });
  if (!grant) return false;
  return REPOSITORY_ACCESS_RANK[grant.accessLevel] >= REPOSITORY_ACCESS_RANK[required];
}

// ─────────────────────────── git plumbing ───────────────────────────────

/** Convert a UUID into a shell-safe env-var suffix. */
function envKeyFor(repoId: string): string {
  return `GENOSYN_REPO_TOKEN_${repoId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

async function runGit(
  workspaceRoot: string,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  credentialHelper?: string,
  serverOwned = false,
): Promise<{ stdout: string }> {
  return runWorkspaceGit({
    workspaceRoot,
    cwd,
    args,
    extraEnv,
    credentialHelper,
    serverOwned,
  });
}

function httpsUsernameOf(repo: Repository): string {
  const u = (repo.httpsUsername ?? "").trim();
  // Most hosts accept any non-empty username with a token-as-password
  // (GitHub, Gitea). GitLab wants "oauth2", Bitbucket wants the real
  // username — surfaced as an editable field in the UI. "git" is a safe
  // default that GitHub and most self-hosted servers accept.
  return u || "git";
}

function workspaceVisiblePath(workspaceRoot: string, hostPath: string): string {
  if (config.agent.codingTools.executionMode !== "bubblewrap") return hostPath;
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(hostPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SSH key path escapes the employee workspace.");
  }
  return relative ? `/workspace/${relative.split(path.sep).join("/")}` : "/workspace";
}

/**
 * Build the `ssh` command git should use for a given key file: identities
 * pinned to our key only, host keys auto-accepted on first contact (no
 * interactive prompt), and a per-employee known_hosts so we don't touch the
 * operator's `~/.ssh`.
 */
function sshCommandFor(keyPath: string): string {
  const knownHosts = path.join(path.dirname(keyPath), "known_hosts");
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `ssh -i ${q(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(knownHosts)}`;
}

// In-process mutex per (employeeId × repoId) so two concurrent spawns can't
// race on the same checkout.
const inflight = new Map<string, Promise<unknown>>();
function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = inflight.get(key);
  const next = (prior ? prior.catch(() => {}) : Promise.resolve()).then(fn);
  inflight.set(
    key,
    next.finally(() => {
      if (inflight.get(key) === next) inflight.delete(key);
    }),
  );
  return next;
}

const NO_PUSH_URL = "DISABLED-read-only-grant.invalid";

export type SyncedRepository = {
  repositoryId: string;
  name: string;
  slug: string;
  defaultBranch: string;
  accessLevel: RepositoryAccessLevel;
  /** Absolute path to the materialized checkout. */
  path: string;
};

export type RepositorySyncError = { scope: string; message: string };

export type RepositorySyncResult = {
  /** Reserved compatibility field. Repository credentials are never exported
   * to the model tool environment, so this is always empty. */
  extraEnv: Record<string, string>;
  repos: SyncedRepository[];
  errors: RepositorySyncError[];
};

/**
 * Materialize every Repository the employee has been granted into
 * `<cwd>/repositories/<slug>/`. Returns env vars for HTTPS tokens, the list of
 * synced repos (so callers can log / inject context), and non-fatal errors.
 */
export async function materializeRepositoriesForEmployee(args: {
  employeeId: string;
  cwd: string;
  /** Credentials resolved from this employee's granted GitHub Connections
   * earlier in the same turn. */
  githubRepoCredentials?: GithubRepoCredential[];
}): Promise<RepositorySyncResult> {
  const result: RepositorySyncResult = { extraEnv: {}, repos: [], errors: [] };
  if (config.security.multiTenant) return result;

  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: args.employeeId,
  });
  if (!employee) return result;
  purgeLegacyRepositorySshFiles(args.cwd);

  const grants = await AppDataSource.getRepository(EmployeeRepositoryGrant).find({
    where: { employeeId: args.employeeId },
  });
  if (grants.length === 0) return result;

  const repoRepo = AppDataSource.getRepository(Repository);
  for (const grant of grants) {
    const repoRow = await repoRepo.findOneBy({
      id: grant.repositoryId,
      companyId: employee.companyId,
    });
    if (!repoRow) continue;
    const lockKey = `${args.employeeId}:${repoRow.id}`;
    await withMutex(lockKey, async () => {
      try {
        await syncOneRepo(
          repoRow,
          grant.accessLevel,
          employee,
          args.cwd,
          result,
          args.githubRepoCredentials ?? [],
        );
        repoRow.lastSyncedAt = new Date();
        repoRow.lastSyncStatus = "ok";
        repoRow.lastSyncError = "";
        await repoRepo.save(repoRow);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ scope: repoRow.slug, message });
        repoRow.lastSyncedAt = new Date();
        repoRow.lastSyncStatus = "error";
        repoRow.lastSyncError = message;
        await repoRepo.save(repoRow);
      }
    });
  }
  return result;
}


/**
 * Move a checkout left at the pre-rename `code-repos/<slug>` path to
 * `repositories/<slug>`.
 *
 * Without this the materializer would simply not find the old checkout and
 * would clone a fresh one beside it — throwing away whatever the employee had
 * not yet committed, which is exactly the WIP the fetch-only sync exists to
 * protect. One-way and best-effort: if anything about the old path looks
 * wrong, leave it alone and let the clone happen.
 */
export function adoptLegacyCheckout(cwd: string, slug: string, repoPath: string): void {
  if (fs.existsSync(repoPath)) return;
  const legacy = path.join(cwd, "code-repos", slug);
  try {
    if (!fs.existsSync(path.join(legacy, ".git"))) return;
    if (fs.lstatSync(legacy).isSymbolicLink()) return;
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    fs.renameSync(legacy, repoPath);
  } catch {
    // A failed adoption is recoverable — the clone below replaces it.
  }
}

async function syncOneRepo(
  repo: Repository,
  accessLevel: RepositoryAccessLevel,
  employee: AIEmployee,
  cwd: string,
  result: RepositorySyncResult,
  githubRepoCredentials: GithubRepoCredential[],
): Promise<void> {
  const repoPath = path.join(cwd, "repositories", repo.slug);
  adoptLegacyCheckout(cwd, repo.slug, repoPath);
  const isCheckout = fs.existsSync(path.join(repoPath, ".git"));

  // Resolve auth material up front so we can build the right clone command
  // and credential wiring.
  const linkedGithubCredential =
    repo.authMode === "none" ? findGithubRepoCredential(repo.gitUrl, githubRepoCredentials) : null;
  const token =
    repo.authMode === "https"
      ? decryptRepositorySecret(repo.encryptedToken)
      : (linkedGithubCredential?.token ?? null);
  const sshKey = repo.authMode === "ssh" ? decryptRepositorySecret(repo.encryptedSshKey) : null;
  if (repo.authMode === "https" && !token) {
    throw new Error(
      "HTTPS token is missing or could not be decrypted. Re-enter it in the repository settings.",
    );
  }
  if (repo.authMode === "ssh" && !sshKey) {
    throw new Error(
      "SSH key is missing or could not be decrypted. Re-enter it in the repository settings.",
    );
  }
  if (token) assertSafeCredentialToken(token);

  const envKey = linkedGithubCredential?.envKey ?? envKeyFor(repo.id);
  const httpsUsername = linkedGithubCredential ? "x-access-token" : httpsUsernameOf(repo);
  const credentialEnv = token ? { [envKey]: token } : {};
  const credentialHelper = token
    ? inlineEnvCredentialHelper(httpsUsername, envKey, repo.gitUrl)
    : undefined;
  const sshCredential =
    repo.authMode === "ssh" && sshKey
      ? {
          privateKey: sshKey,
          knownHosts: readRepositoryKnownHosts(employee.companyId, employee.id),
        }
      : undefined;
  let syncedKnownHosts: string | undefined;

  if (!isCheckout) {
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    if (token && !/^https:\/\//i.test(repo.gitUrl)) {
      throw new Error("HTTPS credentials require an https:// clone URL.");
    }
    const cloneResult = await cloneWorkspaceGitRemote({
      workspaceRoot: cwd,
      destinationPath: repoPath,
      remoteUrl: repo.gitUrl,
      extraEnv: credentialEnv,
      credentialHelper,
      sshCredential,
    });
    syncedKnownHosts = cloneResult.sshKnownHosts;
    await runGit(cwd, repoPath, ["remote", "set-url", "origin", repo.gitUrl]);
  } else {
    await runGit(cwd, repoPath, ["remote", "set-url", "origin", repo.gitUrl]);
    // Existing checkout: refresh refs from only the trusted configured URL.
    // Never visit remotes an AI Employee added to the writable local config.
    const fetchResult = await fetchWorkspaceGitRemote({
      workspaceRoot: cwd,
      cwd: repoPath,
      remoteUrl: repo.gitUrl,
      extraEnv: credentialEnv,
      credentialHelper,
      sshCredential,
    });
    syncedKnownHosts = fetchResult.sshKnownHosts;
  }

  if (syncedKnownHosts !== undefined) {
    persistRepositoryKnownHosts(employee.companyId, employee.id, syncedKnownHosts);
  }

  // The checkout is model-writable. Remove reusable helpers and key paths left
  // by older releases after the credentialed server operation completes.
  await clearCredentialHelper(cwd, repoPath);
  await runGit(cwd, repoPath, ["config", "--local", "--unset", "core.sshCommand"]).catch(() => {});

  // Only a genuinely credential-free writable remote may be exposed to the
  // model shell. Authenticated remotes are refreshed server-side but never get
  // a reusable credential or credentialed push path.
  if (accessLevel === "write" && repo.authMode === "none" && !linkedGithubCredential) {
    await runGit(cwd, repoPath, ["remote", "set-url", "--push", "origin", repo.gitUrl]);
  } else {
    await runGit(cwd, repoPath, ["remote", "set-url", "--push", "origin", NO_PUSH_URL]);
  }

  // Git identity for commits the agent makes.
  const committerName = (repo.committerName ?? "").trim() || employee.name;
  const committerEmail = (repo.committerEmail ?? "").trim() || `${employee.slug}@genosyn.local`;
  await runGit(cwd, repoPath, ["config", "--local", "user.name", committerName]);
  await runGit(cwd, repoPath, ["config", "--local", "user.email", committerEmail]);

  result.repos.push({
    repositoryId: repo.id,
    name: repo.name,
    slug: repo.slug,
    defaultBranch: repo.defaultBranch,
    accessLevel,
    path: repoPath,
  });
}

/**
 * Match an HTTPS GitHub remote to the credential for the same allowlisted
 * owner/repository. When the employee has exactly one granted GitHub
 * Connection, the Repository grant itself is the repo boundary and that
 * sole Connection is the safe fallback even when it has no M12 allowlist.
 * GitHub paths are case-insensitive; non-GitHub and SSH remotes deliberately
 * do not match because PATs authenticate HTTPS only.
 */
export function findGithubRepoCredential(
  gitUrl: string,
  credentials: readonly GithubRepoCredential[],
): GithubRepoCredential | null {
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0].toLowerCase();
  const name = parts[1].replace(/\.git$/i, "").toLowerCase();
  const exact = credentials.find(
    (credential) =>
      credential.owner !== null &&
      credential.name !== null &&
      credential.owner.toLowerCase() === owner &&
      credential.name.toLowerCase() === name,
  );
  if (exact) return exact;

  const connectionIds = new Set(credentials.map((credential) => credential.connectionId));
  return connectionIds.size === 1 ? (credentials[0] ?? null) : null;
}

async function clearCredentialHelper(workspaceRoot: string, repoPath: string): Promise<void> {
  await clearEnvCredentialHelper((args) => runGit(workspaceRoot, repoPath, args));
}

// ──────────────────────── test connection ───────────────────────────────

export type TestConnectionResult = {
  ok: boolean;
  message: string;
  /** Default branch detected from the remote HEAD, when available. */
  defaultBranch?: string;
};

/**
 * Probe a repo's credentials with `git ls-remote --symref <url> HEAD` in a
 * throwaway temp dir. Surfaces whether the clone URL + credentials actually
 * authenticate, and the remote's default branch, before the operator grants
 * an employee access.
 */
export async function testRepositoryConnection(repo: Repository): Promise<TestConnectionResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-"));
  try {
    assertSafeGitRemoteUrl(repo.gitUrl);
    const env: Record<string, string> = {};
    let credentialHelper: string | undefined;

    if (repo.authMode === "https") {
      const token = decryptRepositorySecret(repo.encryptedToken);
      if (!token) {
        return {
          ok: false,
          message: "No HTTPS token is set. Add one and try again.",
        };
      }
      if (!/^https:\/\//i.test(repo.gitUrl)) {
        return {
          ok: false,
          message: "Auth mode is HTTPS but the clone URL isn't an https:// URL.",
        };
      }
      const envKey = "GENOSYN_REPO_TOKEN_CONNECTION_TEST";
      env[envKey] = token;
      credentialHelper = inlineEnvCredentialHelper(httpsUsernameOf(repo), envKey, repo.gitUrl);
    } else if (repo.authMode === "ssh") {
      const key = decryptRepositorySecret(repo.encryptedSshKey);
      if (!key) {
        return { ok: false, message: "No SSH key is set. Add one and try again." };
      }
      const keyPath = path.join(tmp, "key");
      fs.writeFileSync(keyPath, key.endsWith("\n") ? key : key + "\n", {
        mode: 0o600,
      });
      env.GIT_SSH_COMMAND = sshCommandFor(workspaceVisiblePath(tmp, keyPath));
    }

    // Server-owned: `tmp` is an empty directory this function just created,
    // no model process can reach it, and `ls-remote` writes nothing into it.
    // The coding-runtime gate exists for Git reading executable configuration
    // out of a model-controlled tree, which this is not — and gating it here
    // left the one diagnostic that explains a bad URL or an expired token
    // dead on installs that clone, fetch and push the server-owned checkout
    // over the very same exemption.
    const { stdout } = await runGit(
      tmp,
      tmp,
      ["ls-remote", "--symref", repo.gitUrl, "HEAD"],
      env,
      credentialHelper,
      true,
    );
    const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    return {
      ok: true,
      message: "Connected — credentials are valid.",
      defaultBranch: m?.[1],
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const REPOSITORY_AUTH_MODES: RepositoryAuthMode[] = ["none", "https", "ssh"];

// ──────────────────────── prompt context ────────────────────────────────

/**
 * A ready-made markdown section listing the Repositories this employee
 * can work on and where each is checked out. Injected
 * into the chat / routine prompt so the agent knows the working trees exist
 * without exposing repository credentials. Returns "" when the
 * employee has no repo grants.
 */
export async function composeRepositoriesContext(employeeId: string): Promise<string> {
  if (config.security.multiTenant) return "";
  const grants = await AppDataSource.getRepository(EmployeeRepositoryGrant).find({
    where: { employeeId },
  });
  if (grants.length === 0) return "";

  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
  });
  if (!employee) return "";

  const repos = await AppDataSource.getRepository(Repository).find({
    where: {
      id: In(grants.map((g) => g.repositoryId)),
      companyId: employee.companyId,
    },
  });
  const accessById = new Map(grants.map((g) => [g.repositoryId, g.accessLevel]));

  const lines: string[] = [];
  for (const r of repos) {
    const level = accessById.get(r.id);
    const canPushWithoutCredential = level === "write" && r.authMode === "none";
    lines.push(
      `- **${r.name}** — checked out at \`repositories/${r.slug}/\` (default branch \`${r.defaultBranch}\`). ${
        canPushWithoutCredential
          ? "You may commit and push if the remote accepts unauthenticated writes."
          : level === "write"
            ? "You may edit and commit locally; direct credentialed pushing is disabled."
            : "Read-only — commit locally if useful, but pushing is disabled for you."
      }`,
    );
  }
  if (lines.length === 0) return "";

  return [
    "",
    "## Repositories",
    "You have real git checkouts of these repositories in your working directory. Use ordinary `git` to read, branch, edit, test, and commit. Repository credentials stay server-side and are never available to your shell or files; do not look for, print, or request tokens or private keys.",
    "When a teammate asks you to deliver a code change, create a focused branch, edit the files with your coding tools, run the relevant checks, and commit. For an authenticated remote, report the local branch and commit so a governed server-side or Member workflow can publish it; never claim a push or pull request exists unless the corresponding operation actually succeeded.",
    "",
    ...lines,
  ].join("\n");
}
