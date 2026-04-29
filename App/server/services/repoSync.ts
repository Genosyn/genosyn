import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
  loadEmployeeConnections,
} from "./integrations.js";
import {
  readGithubRepos,
  resolveGithubCredentials,
} from "../integrations/providers/github.js";

/**
 * Repo sync seam — materializes git checkouts of every allowlisted repo on
 * each granted GitHub Connection into the AI employee's working directory
 * before each chat / routine spawn.
 *
 * Engineering AI employees are *editor-shaped*, not API-shaped — they need a
 * working tree to read, edit, branch, commit, and push. Calling the github
 * REST API for every operation is the wrong primitive for that workload, so
 * the runner's pre-spawn step now drops a real `git clone` of each repo into
 * `<employeeDir>/repos/<owner>/<name>/` and leaves it there. The agent uses
 * normal `git` to do its work; PR creation is the only operation that needs
 * to cross back into Genosyn (via the `create_pull_request` MCP tool).
 *
 * **Concurrency.** Two spawns on the same employee+connection serialize
 * through an in-process mutex so the second one's fetch can't trample the
 * first's working tree mid-clone. Cross-process / multi-replica concurrency
 * is out of scope for the MVP — most self-hosters run a single Genosyn
 * process today, and the worktree-per-routine refinement (deferred from
 * M12) is the right answer for full parallelism.
 *
 * **Working tree handling.** We only `git fetch --all --prune` on existing
 * checkouts — never `git reset --hard`. Hard-resetting would destroy the
 * agent's WIP between spawns (e.g. a feature branch the previous routine
 * pushed but didn't merge). The agent is in charge of its own working tree;
 * we keep `origin/*` refs fresh and stay out of the way.
 *
 * **Credential helper.** Each cloned repo gets a tiny shell script at
 * `.git/genosyn-cred.sh` that prints the token from a per-connection env
 * var (`GENOSYN_GH_TOKEN_<sanitized-connId>`). The runner sets that env
 * var for the spawn so `git push` / `gh` Just Work, then the env vars are
 * scoped to the spawn process and don't leak to other employees.
 */

const exec = promisify(execFile);

export type SyncedRepo = {
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Absolute path to the materialized checkout. */
  path: string;
};

export type RepoSyncError = {
  /** "<connId>" or "<owner>/<name>". */
  scope: string;
  message: string;
};

export type RepoSyncResult = {
  /** Env vars to merge into the spawn so the agent's `git push` finds the
   * matching token. Keys: `GENOSYN_GH_TOKEN_<sanitized-connId>`. */
  extraEnv: Record<string, string>;
  /** Repos successfully cloned or fetched this round. */
  repos: SyncedRepo[];
  /** Non-fatal failures the runner should log but not abort on. */
  errors: RepoSyncError[];
};

/** Convert a UUID into a shell-safe env-var suffix. */
function envKeyFor(connectionId: string): string {
  return `GENOSYN_GH_TOKEN_${connectionId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

// In-process mutex per (employeeId × connectionId) so two concurrent spawns
// on the same employee+connection can't race on the same checkout.
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

export async function materializeReposForEmployee(args: {
  employeeId: string;
  cwd: string;
}): Promise<RepoSyncResult> {
  const result: RepoSyncResult = { extraEnv: {}, repos: [], errors: [] };

  const empRepo = AppDataSource.getRepository(AIEmployee);
  const employee = await empRepo.findOneBy({ id: args.employeeId });
  if (!employee) return result;

  const grants = await loadEmployeeConnections(employee);
  const githubGrants = grants.filter((g) => g.connection.provider === "github");
  if (githubGrants.length === 0) return result;

  for (const { connection } of githubGrants) {
    const lockKey = `${args.employeeId}:${connection.id}`;
    await withMutex(lockKey, async () => {
      try {
        await syncConnection(connection, args.cwd, result);
      } catch (err) {
        result.errors.push({
          scope: `connection:${connection.id}`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
  return result;
}

async function syncConnection(
  connection: IntegrationConnection,
  cwd: string,
  result: RepoSyncResult,
): Promise<void> {
  const cfg = decryptConnectionConfig(connection);
  const creds = await resolveGithubCredentials(cfg, connection.authMode);
  if (!creds) {
    result.errors.push({
      scope: `connection:${connection.id}`,
      message: "GitHub Connection is missing credentials. Reconnect it from Settings → Integrations.",
    });
    return;
  }

  // Persist refreshed OAuth config (token rotation) before we hand the
  // refreshed token to git.
  if (creds.refreshedConfig) {
    connection.encryptedConfig = encryptConnectionConfig(creds.refreshedConfig);
    connection.lastCheckedAt = new Date();
    connection.status = "connected";
    connection.statusMessage = "";
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
  }

  const repos = readGithubRepos(cfg, connection.authMode);
  if (repos.length === 0) {
    // Connection is authenticated but no repos picked yet — nothing to do.
    return;
  }

  const envKey = envKeyFor(connection.id);
  result.extraEnv[envKey] = creds.accessToken;

  for (const repo of repos) {
    try {
      const repoPath = path.join(cwd, "repos", repo.owner, repo.name);
      await syncOneRepo({
        repoPath,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        token: creds.accessToken,
        envKey,
      });
      result.repos.push({
        connectionId: connection.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        path: repoPath,
      });
    } catch (err) {
      result.errors.push({
        scope: `${repo.owner}/${repo.name}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function syncOneRepo(args: {
  repoPath: string;
  owner: string;
  name: string;
  defaultBranch: string;
  token: string;
  envKey: string;
}): Promise<void> {
  const cleanRemote = `https://github.com/${args.owner}/${args.name}.git`;
  const isCheckout = fs.existsSync(path.join(args.repoPath, ".git"));

  if (!isCheckout) {
    fs.mkdirSync(path.dirname(args.repoPath), { recursive: true });
    // Initial clone: temporarily inline the token in the URL. We strip it
    // immediately afterward via `remote set-url`, and from this point on
    // git pulls the token from the credential helper instead.
    const tokenUrl = `https://x-access-token:${args.token}@github.com/${args.owner}/${args.name}.git`;
    await runGit(path.dirname(args.repoPath), [
      "clone",
      "--quiet",
      tokenUrl,
      args.name,
    ]);
    await runGit(args.repoPath, ["remote", "set-url", "origin", cleanRemote]);
  } else {
    // Existing checkout: fetch fresh refs but never touch the agent's
    // working tree or current branch. The agent decides when to merge.
    await runGit(args.repoPath, ["fetch", "--all", "--prune", "--quiet"]);
    // Make sure the remote URL doesn't carry a stale token from a previous
    // version of this code or a manual `git remote add`.
    await runGit(args.repoPath, ["remote", "set-url", "origin", cleanRemote]);
  }

  // Idempotent: write/refresh the credential helper script and pin git to
  // it. Token never lands on disk — the helper just echoes the env var the
  // runner sets at spawn time.
  await writeCredentialHelper(args.repoPath, args.envKey);
}

async function writeCredentialHelper(repoPath: string, envKey: string): Promise<void> {
  const helperPath = path.join(repoPath, ".git", "genosyn-cred.sh");
  // POSIX shell only — the script needs to run inside the agent sandbox,
  // which may not have bash. `printf` is portable; here-docs are not on
  // BusyBox.
  const script = [
    "#!/bin/sh",
    "# Auto-generated by Genosyn — do not edit by hand.",
    "# Reads the GitHub access token from a per-connection env var the",
    "# runner sets at spawn time and prints it in git's credential format.",
    `if [ "$1" = "get" ] && [ -n "$${envKey}" ]; then`,
    `  printf 'username=x-access-token\\npassword=%s\\n' "$${envKey}"`,
    "fi",
    "",
  ].join("\n");
  fs.writeFileSync(helperPath, script, { mode: 0o700 });
  // Pin the helper as the only credential source for this repo. The leading
  // `!` tells git to interpret the value as a shell command; we wrap the
  // path in single quotes so spaces in `<employeeDir>` don't break it.
  await runGit(repoPath, [
    "config",
    "--local",
    "credential.helper",
    `!'${helperPath.replace(/'/g, "'\\''")}'`,
  ]);
  // Replace any previous helpers (e.g. an earlier global "store") so the
  // local one wins unambiguously. `--unset-all` is a no-op when nothing's set.
  await runGit(repoPath, ["config", "--local", "--replace-all", "credential.helper", `!'${helperPath.replace(/'/g, "'\\''")}'`]).catch(() => {
    // The replace-all variant errors on freshly-init'd configs; the prior
    // `config` call already established the value, so swallow this.
  });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  try {
    await exec("git", args, {
      cwd,
      // Disable interactive auth prompts. With no TTY git will fail fast on
      // missing creds rather than hanging the runner.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const tail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`git ${args[0]} failed: ${tail.split("\n").slice(-3).join(" | ")}`);
  }
}
