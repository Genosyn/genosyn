import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import type { CodeRepoAuthMode } from "../db/entities/CodeRepository.js";
import {
  EmployeeCodeRepositoryGrant,
  CODE_REPO_ACCESS_RANK,
} from "../db/entities/EmployeeCodeRepositoryGrant.js";
import type { CodeRepoAccessLevel } from "../db/entities/EmployeeCodeRepositoryGrant.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { toSlug } from "../lib/slug.js";

/**
 * Code Repository seam — the provider-agnostic cousin of `repoSync.ts`.
 *
 * Where `repoSync` materializes repos that ride on a GitHub *Connection*
 * (OAuth / App / PAT) and an allowlist, this module materializes
 * first-class **Code Repository** rows the company added directly: any
 * HTTPS or SSH git URL, with credentials stored encrypted on the row and
 * access handed out per-employee via {@link EmployeeCodeRepositoryGrant}.
 *
 * Before each chat / routine spawn the runner calls
 * {@link materializeCodeReposForEmployee}, which drops a real `git clone`
 * of every granted repo into `<employeeDir>/code-repos/<slug>/` and wires
 * up credentials so the agent's ordinary `git fetch` / `commit` / `push`
 * Just Work. As in `repoSync`, we only ever `fetch` on an existing
 * checkout (never `reset --hard`) so the agent's WIP between spawns is
 * never trampled.
 *
 * Credential handling mirrors `repoSync`'s "token never lands on disk"
 * rule for HTTPS: the token is handed to git through a per-repo env var
 * (`GENOSYN_REPO_TOKEN_<id>`) the runner sets at spawn time, read back by
 * a tiny credential-helper script. SSH is the one exception — git needs a
 * private-key *file*, so the key is written under the employee's data dir
 * (gitignored) with mode 0600 and pinned via `core.sshCommand`.
 */

const exec = promisify(execFile);

// ───────────────────────────── slugs ────────────────────────────────────

export async function uniqueCodeRepoSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(CodeRepository);
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

function tryDecrypt(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

/** What the client is allowed to know about a repo's stored credentials —
 *  never the secret itself, only whether one is present. */
export function credentialSummary(repo: CodeRepository): {
  hasToken: boolean;
  hasSshKey: boolean;
} {
  return {
    hasToken: !!repo.encryptedToken,
    hasSshKey: !!repo.encryptedSshKey,
  };
}

// ───────────────────────────── grants ───────────────────────────────────

export async function upsertCodeRepoGrant(
  employeeId: string,
  codeRepositoryId: string,
  accessLevel: CodeRepoAccessLevel,
): Promise<EmployeeCodeRepositoryGrant> {
  const repo = AppDataSource.getRepository(EmployeeCodeRepositoryGrant);
  const existing = await repo.findOneBy({ employeeId, codeRepositoryId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  const row = repo.create({ employeeId, codeRepositoryId, accessLevel });
  await repo.save(row);
  return row;
}

export async function listDirectCodeRepoGrants(
  codeRepositoryId: string,
): Promise<EmployeeCodeRepositoryGrant[]> {
  return AppDataSource.getRepository(EmployeeCodeRepositoryGrant).find({
    where: { codeRepositoryId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForCodeRepo(codeRepositoryId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeCodeRepositoryGrant).delete({
    codeRepositoryId,
  });
}

export async function hasCodeRepoAccess(
  employeeId: string,
  codeRepositoryId: string,
  required: CodeRepoAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeCodeRepositoryGrant).findOneBy({
    employeeId,
    codeRepositoryId,
  });
  if (!grant) return false;
  return CODE_REPO_ACCESS_RANK[grant.accessLevel] >= CODE_REPO_ACCESS_RANK[required];
}

// ─────────────────────────── git plumbing ───────────────────────────────

/** Convert a UUID into a shell-safe env-var suffix. */
function envKeyFor(repoId: string): string {
  return `GENOSYN_REPO_TOKEN_${repoId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

async function runGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string }> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      env: {
        ...process.env,
        // No TTY → fail fast on missing creds instead of hanging the runner.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
        ...extraEnv,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new Error(
        `git is not installed on the Genosyn server, so "git ${args[0]}" could not run. Install git (the official Genosyn Docker image bundles it) and try again.`,
      );
    }
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const tail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`git ${args[0]} failed: ${tail.split("\n").slice(-3).join(" | ")}`);
  }
}

/** Insert `user:token@` into an `https://…` URL. Returns null for non-HTTPS. */
function injectHttpsCreds(gitUrl: string, username: string, token: string): string | null {
  const m = gitUrl.match(/^https:\/\/(.*)$/i);
  if (!m) return null;
  const enc = encodeURIComponent;
  return `https://${enc(username)}:${enc(token)}@${m[1]}`;
}

function httpsUsernameOf(repo: CodeRepository): string {
  const u = (repo.httpsUsername ?? "").trim();
  // Most hosts accept any non-empty username with a token-as-password
  // (GitHub, Gitea). GitLab wants "oauth2", Bitbucket wants the real
  // username — surfaced as an editable field in the UI. "git" is a safe
  // default that GitHub and most self-hosted servers accept.
  return u || "git";
}

function sshKeyDir(cwd: string): string {
  return path.join(cwd, "code-repos", ".ssh");
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

async function writeCredentialHelper(
  repoPath: string,
  username: string,
  envKey: string,
): Promise<void> {
  const helperPath = path.join(repoPath, ".git", "genosyn-cred.sh");
  // POSIX shell only — may run inside a BusyBox sandbox. `printf` is portable.
  const safeUser = username.replace(/'/g, "'\\''");
  const script = [
    "#!/bin/sh",
    "# Auto-generated by Genosyn — do not edit by hand.",
    "# Reads the repo token from a per-repo env var the runner sets at spawn",
    "# time and prints it in git's credential format. Token never on disk.",
    `if [ "$1" = "get" ] && [ -n "$${envKey}" ]; then`,
    `  printf 'username=%s\\npassword=%s\\n' '${safeUser}' "$${envKey}"`,
    "fi",
    "",
  ].join("\n");
  fs.writeFileSync(helperPath, script, { mode: 0o700 });
  await runGit(repoPath, [
    "config",
    "--local",
    "credential.helper",
    `!'${helperPath.replace(/'/g, "'\\''")}'`,
  ]);
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

export type SyncedCodeRepo = {
  codeRepositoryId: string;
  name: string;
  slug: string;
  defaultBranch: string;
  accessLevel: CodeRepoAccessLevel;
  /** Absolute path to the materialized checkout. */
  path: string;
};

export type CodeRepoSyncError = { scope: string; message: string };

export type CodeRepoSyncResult = {
  /** Env vars to merge into the spawn so the agent's `git push` finds the
   *  matching token. Keys: `GENOSYN_REPO_TOKEN_<id>`. */
  extraEnv: Record<string, string>;
  repos: SyncedCodeRepo[];
  errors: CodeRepoSyncError[];
};

/**
 * Materialize every Code Repository the employee has been granted into
 * `<cwd>/code-repos/<slug>/`. Returns env vars for HTTPS tokens, the list of
 * synced repos (so callers can log / inject context), and non-fatal errors.
 */
export async function materializeCodeReposForEmployee(args: {
  employeeId: string;
  cwd: string;
}): Promise<CodeRepoSyncResult> {
  const result: CodeRepoSyncResult = { extraEnv: {}, repos: [], errors: [] };
  if (config.security.multiTenant) return result;

  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: args.employeeId,
  });
  if (!employee) return result;

  const grants = await AppDataSource.getRepository(EmployeeCodeRepositoryGrant).find({
    where: { employeeId: args.employeeId },
  });
  if (grants.length === 0) return result;

  const repoRepo = AppDataSource.getRepository(CodeRepository);
  for (const grant of grants) {
    const repoRow = await repoRepo.findOneBy({
      id: grant.codeRepositoryId,
      companyId: employee.companyId,
    });
    if (!repoRow) continue;
    const lockKey = `${args.employeeId}:${repoRow.id}`;
    await withMutex(lockKey, async () => {
      try {
        await syncOneRepo(repoRow, grant.accessLevel, employee, args.cwd, result);
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

async function syncOneRepo(
  repo: CodeRepository,
  accessLevel: CodeRepoAccessLevel,
  employee: AIEmployee,
  cwd: string,
  result: CodeRepoSyncResult,
): Promise<void> {
  const repoPath = path.join(cwd, "code-repos", repo.slug);
  const isCheckout = fs.existsSync(path.join(repoPath, ".git"));

  // Resolve auth material up front so we can build the right clone command
  // and credential wiring.
  const token = repo.authMode === "https" ? tryDecrypt(repo.encryptedToken) : null;
  const sshKey = repo.authMode === "ssh" ? tryDecrypt(repo.encryptedSshKey) : null;
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

  const envKey = envKeyFor(repo.id);
  let sshCommand: string | undefined;
  let cloneEnv: Record<string, string> = {};

  if (repo.authMode === "ssh" && sshKey) {
    const dir = sshKeyDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, repo.id);
    // Keys must end with a trailing newline or ssh rejects them.
    fs.writeFileSync(keyPath, sshKey.endsWith("\n") ? sshKey : sshKey + "\n", {
      mode: 0o600,
    });
    sshCommand = sshCommandFor(keyPath);
    cloneEnv = { GIT_SSH_COMMAND: sshCommand };
  }
  if (repo.authMode === "https" && token) {
    result.extraEnv[envKey] = token;
  }

  if (!isCheckout) {
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    if (repo.authMode === "https" && token) {
      // Initial clone: temporarily inline the token in the URL, then strip it
      // immediately so it never persists in `.git/config`. From then on git
      // pulls the token from the credential helper / env var.
      const tokenUrl = injectHttpsCreds(repo.gitUrl, httpsUsernameOf(repo), token);
      if (!tokenUrl) {
        throw new Error("Auth mode is HTTPS but the clone URL isn't an https:// URL.");
      }
      await runGit(path.dirname(repoPath), ["clone", "--quiet", tokenUrl, repo.slug]);
      await runGit(repoPath, ["remote", "set-url", "origin", repo.gitUrl]);
    } else {
      // SSH or public: clone the URL as-is (SSH key supplied via env).
      await runGit(path.dirname(repoPath), ["clone", "--quiet", repo.gitUrl, repo.slug], cloneEnv);
    }
  } else {
    // Existing checkout: refresh refs but never touch the working tree.
    await runGit(repoPath, ["fetch", "--all", "--prune", "--quiet"], cloneEnv);
    await runGit(repoPath, ["remote", "set-url", "origin", repo.gitUrl]);
  }

  // Pin per-repo wiring every spawn (idempotent — settings may have changed
  // between spawns, e.g. a grant downgraded from write to read).
  if (sshCommand) {
    await runGit(repoPath, ["config", "--local", "core.sshCommand", sshCommand]);
  } else {
    // Drop any stale sshCommand if the repo flipped away from SSH.
    await runGit(repoPath, ["config", "--local", "--unset", "core.sshCommand"]).catch(() => {});
  }
  if (repo.authMode === "https" && token) {
    await writeCredentialHelper(repoPath, httpsUsernameOf(repo), envKey);
  }

  // Read-only grants get their push URL disabled so an accidental `git push`
  // fails fast with a message naming the missing grant, rather than silently
  // succeeding on a token that happens to carry write scope.
  if (accessLevel === "write") {
    await runGit(repoPath, ["remote", "set-url", "--push", "origin", repo.gitUrl]);
  } else {
    await runGit(repoPath, ["remote", "set-url", "--push", "origin", NO_PUSH_URL]);
  }

  // Git identity for commits the agent makes.
  const committerName = (repo.committerName ?? "").trim() || employee.name;
  const committerEmail = (repo.committerEmail ?? "").trim() || `${employee.slug}@genosyn.local`;
  await runGit(repoPath, ["config", "--local", "user.name", committerName]);
  await runGit(repoPath, ["config", "--local", "user.email", committerEmail]);

  result.repos.push({
    codeRepositoryId: repo.id,
    name: repo.name,
    slug: repo.slug,
    defaultBranch: repo.defaultBranch,
    accessLevel,
    path: repoPath,
  });
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
export async function testCodeRepoConnection(repo: CodeRepository): Promise<TestConnectionResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-"));
  try {
    let url = repo.gitUrl;
    const env: Record<string, string> = {};

    if (repo.authMode === "https") {
      const token = tryDecrypt(repo.encryptedToken);
      if (!token) {
        return {
          ok: false,
          message: "No HTTPS token is set. Add one and try again.",
        };
      }
      const tokenUrl = injectHttpsCreds(url, httpsUsernameOf(repo), token);
      if (!tokenUrl) {
        return {
          ok: false,
          message: "Auth mode is HTTPS but the clone URL isn't an https:// URL.",
        };
      }
      url = tokenUrl;
    } else if (repo.authMode === "ssh") {
      const key = tryDecrypt(repo.encryptedSshKey);
      if (!key) {
        return { ok: false, message: "No SSH key is set. Add one and try again." };
      }
      const keyPath = path.join(tmp, "key");
      fs.writeFileSync(keyPath, key.endsWith("\n") ? key : key + "\n", {
        mode: 0o600,
      });
      env.GIT_SSH_COMMAND = sshCommandFor(keyPath);
    }

    const { stdout } = await runGit(tmp, ["ls-remote", "--symref", url, "HEAD"], env);
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

export const CODE_REPO_AUTH_MODES: CodeRepoAuthMode[] = ["none", "https", "ssh"];

// ──────────────────────── prompt context ────────────────────────────────

/**
 * A ready-made markdown section listing the Code Repositories this employee
 * can work on, where each is checked out, and whether it may push. Injected
 * into the chat / routine prompt so the agent knows the working trees exist
 * and that `git push` is already wired up for it. Returns "" when the
 * employee has no repo grants.
 */
export async function composeCodeReposContext(employeeId: string): Promise<string> {
  if (config.security.multiTenant) return "";
  const grants = await AppDataSource.getRepository(EmployeeCodeRepositoryGrant).find({
    where: { employeeId },
  });
  if (grants.length === 0) return "";

  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
  });
  if (!employee) return "";

  const repos = await AppDataSource.getRepository(CodeRepository).find({
    where: {
      id: In(grants.map((g) => g.codeRepositoryId)),
      companyId: employee.companyId,
    },
  });
  const accessById = new Map(grants.map((g) => [g.codeRepositoryId, g.accessLevel]));

  const lines: string[] = [];
  for (const r of repos) {
    const level = accessById.get(r.id);
    const canPush = level === "write";
    lines.push(
      `- **${r.name}** — checked out at \`code-repos/${r.slug}/\` (default branch \`${r.defaultBranch}\`). ${
        canPush
          ? "You may commit and `git push`."
          : "Read-only — commit locally if useful, but pushing is disabled for you."
      }`,
    );
  }
  if (lines.length === 0) return "";

  return [
    "",
    "## Code Repositories",
    "You have real git checkouts of these repositories in your working directory. Use ordinary `git` to read, branch, commit, and (where allowed) push — credentials and the committer identity are already configured, so you do not need to set up remotes or tokens.",
    "When a teammate asks you to deliver a code change, carry the work through: create a focused branch, edit the files with your coding tools, run the relevant checks, commit, and push. If a matching GitHub `*_create_pull_request` tool is available, call it after pushing to open the requested pull request (draft when requested). Never claim a pull request exists unless the tool returned it; if no PR tool is available, say that a GitHub Connection grant is needed and report the pushed branch instead.",
    "",
    ...lines,
  ].join("\n");
}
