import path from "node:path";
import fs from "node:fs";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  decryptConnectionConfig,
  loadEmployeeConnections,
  persistConnectionConfigIfCurrent,
} from "./integrations.js";
import { readGithubRepos, resolveGithubCredentials } from "../integrations/providers/github.js";
import {
  assertSafeCredentialToken,
  clearEnvCredentialHelper,
  inlineEnvCredentialHelper,
} from "./gitCredentialHelper.js";
import { runWorkspaceGit } from "./workspaceGit.js";
import { cloneWorkspaceGitRemote, fetchWorkspaceGitRemote } from "./workspaceGitRemote.js";

/**
 * Repo sync seam — materializes git checkouts of every allowlisted repo on
 * each granted GitHub Connection into the AI employee's working directory
 * before each chat / routine spawn.
 *
 * Engineering AI employees are *editor-shaped*, not API-shaped — they need a
 * working tree to read, edit, branch, and commit. Calling the github
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
 * **Credentials.** Clone/fetch runs in a server-owned temporary Git workspace.
 * The Connection token never enters the employee checkout or model tool
 * environment. Authenticated pushes therefore need a future governed server
 * action instead of exposing a reusable account credential to model code.
 */

export type SyncedRepo = {
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Absolute path to the materialized checkout. */
  path: string;
};

export type GithubRepoCredential = {
  connectionId: string;
  /** Exact allowlist coordinates, or null when the Connection has no selected
   * repos and can only be used as an unambiguous sole-Connection fallback. */
  owner: string | null;
  name: string | null;
  envKey: string;
  /** Turn-scoped only. Never persist or log this value. */
  token: string;
};

export type RepoSyncError = {
  /** "<connId>" or "<owner>/<name>". */
  scope: string;
  message: string;
};

export type RepoSyncResult = {
  /** Reserved compatibility field. Repository credentials are never exported
   * to the model tool environment, so this is always empty. */
  extraEnv: Record<string, string>;
  /** Repos successfully cloned or fetched this round. */
  repos: SyncedRepo[];
  /** Granted GitHub credentials another materializer may reuse this turn,
   * with allowlist coordinates when present for safe disambiguation. */
  githubRepoCredentials: GithubRepoCredential[];
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
  const result: RepoSyncResult = {
    extraEnv: {},
    repos: [],
    githubRepoCredentials: [],
    errors: [],
  };

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
  const credentialSnapshot = connection.encryptedConfig;
  const cfg = decryptConnectionConfig(connection);
  const creds = await resolveGithubCredentials(cfg, connection.authMode);
  if (!creds) {
    result.errors.push({
      scope: `connection:${connection.id}`,
      message:
        "GitHub Connection is missing credentials. Reconnect it from Settings → Integrations.",
    });
    return;
  }
  assertSafeCredentialToken(creds.accessToken);

  // Persist refreshed OAuth config (token rotation) before we hand the
  // refreshed token to git.
  if (creds.refreshedConfig) {
    const persisted = await persistConnectionConfigIfCurrent({
      connectionId: connection.id,
      companyId: connection.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: creds.refreshedConfig,
      healthy: true,
    });
    if (!persisted) {
      throw new Error(
        "GitHub Connection changed while its credentials were refreshing. Retry repository sync.",
      );
    }
  }

  const repos = readGithubRepos(cfg, connection.authMode);
  const envKey = envKeyFor(connection.id);
  if (repos.length === 0) {
    // A first-class Repository grant is already a repository boundary.
    // Preserve this credential as a fallback when it is the employee's only
    // GitHub Connection, without exporting it into the bash env unless a
    // matching Repository actually needs it.
    result.githubRepoCredentials.push({
      connectionId: connection.id,
      owner: null,
      name: null,
      envKey,
      token: creds.accessToken,
    });
    return;
  }

  for (const repo of repos) {
    result.githubRepoCredentials.push({
      connectionId: connection.id,
      owner: repo.owner,
      name: repo.name,
      envKey,
      token: creds.accessToken,
    });
    try {
      const repoPath = path.join(cwd, "repos", repo.owner, repo.name);
      await syncOneRepo({
        workspaceRoot: cwd,
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
  workspaceRoot: string;
  repoPath: string;
  owner: string;
  name: string;
  defaultBranch: string;
  token: string;
  envKey: string;
}): Promise<void> {
  const cleanRemote = `https://github.com/${args.owner}/${args.name}.git`;
  const isCheckout = fs.existsSync(path.join(args.repoPath, ".git"));
  const credentialEnv = { [args.envKey]: args.token };
  const credentialHelper = inlineEnvCredentialHelper("x-access-token", args.envKey, cleanRemote);

  if (!isCheckout) {
    fs.mkdirSync(path.dirname(args.repoPath), { recursive: true });
    await cloneWorkspaceGitRemote({
      workspaceRoot: args.workspaceRoot,
      destinationPath: args.repoPath,
      remoteUrl: cleanRemote,
      extraEnv: credentialEnv,
      credentialHelper,
    });
    await runWorkspaceGit({
      workspaceRoot: args.workspaceRoot,
      cwd: args.repoPath,
      args: ["remote", "set-url", "origin", cleanRemote],
    });
  } else {
    await runWorkspaceGit({
      workspaceRoot: args.workspaceRoot,
      cwd: args.repoPath,
      args: ["remote", "set-url", "origin", cleanRemote],
    });
    // Fetch only the trusted configured URL. Attacker-added remotes in the
    // writable local config are never visited.
    await fetchWorkspaceGitRemote({
      workspaceRoot: args.workspaceRoot,
      cwd: args.repoPath,
      remoteUrl: cleanRemote,
      extraEnv: credentialEnv,
      credentialHelper,
    });
  }

  // A checkout is model-writable. Remove every reusable credential seam after
  // the short-lived server fetch, including helpers left by an older release.
  await clearEnvCredentialHelper((gitArgs) =>
    runWorkspaceGit({
      workspaceRoot: args.workspaceRoot,
      cwd: args.repoPath,
      args: gitArgs,
    }),
  );
  await runWorkspaceGit({
    workspaceRoot: args.workspaceRoot,
    cwd: args.repoPath,
    args: ["config", "--local", "--unset", "core.sshCommand"],
  }).catch(() => {});
  await runWorkspaceGit({
    workspaceRoot: args.workspaceRoot,
    cwd: args.repoPath,
    args: ["remote", "set-url", "--push", "origin", NO_PUSH_URL],
  });
}

const NO_PUSH_URL = "DISABLED-server-held-credentials.invalid";
