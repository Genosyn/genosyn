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
import {
  isForgeProvider,
  forgeGitUsername,
  forgeProviderName,
  readForgeRepos,
  resolveForgeCredentials,
} from "../integrations/providers/forge/connection.js";
import { forgeCloneUrl, type ForgeEndpoint } from "../integrations/providers/forge/client.js";
import {
  assertSafeCredentialToken,
  clearEnvCredentialHelper,
  inlineEnvCredentialHelper,
} from "./gitCredentialHelper.js";
import { runWorkspaceGit } from "./workspaceGit.js";
import { cloneWorkspaceGitRemote, fetchWorkspaceGitRemote } from "./workspaceGitRemote.js";

/**
 * Repo sync seam — materializes git checkouts of every allowlisted repo on
 * each granted forge Connection (GitHub, or a self-hosted Forgejo / Gitea)
 * into the AI employee's working directory when the employee asks for them
 * with `sync_repositories`, never ahead of a turn that may not read code.
 *
 * Engineering AI employees are *editor-shaped*, not API-shaped — they need a
 * working tree to read, edit, branch, and commit. Calling the forge's
 * REST API for every operation is the wrong primitive for that workload, so
 * a sync drops a real `git clone` of each repo into
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

export type ForgeRepoCredential = {
  connectionId: string;
  /** Where this Connection's repositories live, so a remote URL can be matched
   *  against it rather than against a hardcoded host. */
  endpoint: ForgeEndpoint;
  /** The `git` basic-auth username this forge expects with the token. */
  username: string;
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
  /** Granted forge credentials another materializer may reuse this turn,
   * with allowlist coordinates when present for safe disambiguation. */
  forgeRepoCredentials: ForgeRepoCredential[];
  /** Non-fatal failures the runner should log but not abort on. */
  errors: RepoSyncError[];
};

/** Convert a UUID into a shell-safe env-var suffix. */
function envKeyFor(connectionId: string): string {
  return `GENOSYN_FORGE_TOKEN_${connectionId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
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

/** One allowlisted repository on a granted forge Connection. */
export type ForgeCheckoutRef = {
  connectionId: string;
  owner: string;
  name: string;
};

export type ForgeCheckout = ForgeCheckoutRef & { defaultBranch: string };

/**
 * The Connection checkouts an employee may sync, read from its Grants and the
 * Connections' allowlists alone. No remote is contacted and no credential is
 * refreshed, so a turn can say what exists without paying for a fetch.
 */
export async function listForgeCheckoutsForEmployee(employeeId: string): Promise<ForgeCheckout[]> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!employee) return [];
  const grants = await loadEmployeeConnections(employee);
  const checkouts: ForgeCheckout[] = [];
  for (const { connection } of grants) {
    if (!isForgeProvider(connection.provider)) continue;
    let repos: ReturnType<typeof readForgeRepos>;
    try {
      repos = readForgeRepos(
        connection.provider,
        decryptConnectionConfig(connection),
        connection.authMode,
      );
    } catch {
      // A Connection whose config no longer decrypts is reported when a sync
      // tries it; it has nothing to offer a listing.
      continue;
    }
    for (const repo of repos) {
      checkouts.push({
        connectionId: connection.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      });
    }
  }
  return checkouts;
}

export async function materializeReposForEmployee(args: {
  employeeId: string;
  cwd: string;
  /**
   * Which allowlisted repositories to clone or fetch. Every granted
   * Connection's credential is still resolved and returned, because a
   * credential-free Repository synced in the same call may need it; only the
   * checkouts this rejects are left untouched. Omitted, every one is synced.
   */
  include?: (repo: ForgeCheckoutRef) => boolean;
}): Promise<RepoSyncResult> {
  const result: RepoSyncResult = {
    extraEnv: {},
    repos: [],
    forgeRepoCredentials: [],
    errors: [],
  };

  const empRepo = AppDataSource.getRepository(AIEmployee);
  const employee = await empRepo.findOneBy({ id: args.employeeId });
  if (!employee) return result;

  const grants = await loadEmployeeConnections(employee);
  const forgeGrants = grants.filter((g) => isForgeProvider(g.connection.provider));
  if (forgeGrants.length === 0) return result;

  for (const { connection } of forgeGrants) {
    const lockKey = `${args.employeeId}:${connection.id}`;
    await withMutex(lockKey, async () => {
      try {
        await syncConnection(connection, args.cwd, result, args.include);
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
  include?: (repo: ForgeCheckoutRef) => boolean,
): Promise<void> {
  if (!isForgeProvider(connection.provider)) return;
  const provider = connection.provider;
  const name = forgeProviderName(provider);
  const credentialSnapshot = connection.encryptedConfig;
  const cfg = decryptConnectionConfig(connection);
  const creds = await resolveForgeCredentials(provider, cfg, connection.authMode);
  if (!creds) {
    result.errors.push({
      scope: `connection:${connection.id}`,
      message: `${name} Connection is missing credentials. Reconnect it from Settings → Integrations.`,
    });
    return;
  }
  assertSafeCredentialToken(creds.accessToken);
  const username = forgeGitUsername(provider, creds.login);
  if (!username) {
    result.errors.push({
      scope: `connection:${connection.id}`,
      message: `${name} Connection does not know which account it authenticates as. Reconnect it from Settings → Integrations.`,
    });
    return;
  }

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
        `${name} Connection changed while its credentials were refreshing. Retry repository sync.`,
      );
    }
  }

  const repos = readForgeRepos(provider, cfg, connection.authMode);
  const envKey = envKeyFor(connection.id);
  if (repos.length === 0) {
    // A first-class Repository grant is already a repository boundary.
    // Preserve this credential as a fallback when it is the employee's only
    // Connection for that server, without exporting it into the bash env
    // unless a matching Repository actually needs it.
    result.forgeRepoCredentials.push({
      connectionId: connection.id,
      endpoint: creds.endpoint,
      username,
      owner: null,
      name: null,
      envKey,
      token: creds.accessToken,
    });
    return;
  }

  for (const repo of repos) {
    result.forgeRepoCredentials.push({
      connectionId: connection.id,
      endpoint: creds.endpoint,
      username,
      owner: repo.owner,
      name: repo.name,
      envKey,
      token: creds.accessToken,
    });
    if (include && !include({ connectionId: connection.id, owner: repo.owner, name: repo.name })) {
      continue;
    }
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
        endpoint: creds.endpoint,
        username,
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
  endpoint: ForgeEndpoint;
  username: string;
}): Promise<void> {
  // Built from the Connection's own base URL rather than a hardcoded host, so
  // a self-hosted forge clones from the server it actually lives on.
  const cleanRemote = forgeCloneUrl(args.endpoint, args.owner, args.name);
  const isCheckout = fs.existsSync(path.join(args.repoPath, ".git"));
  const credentialEnv = { [args.envKey]: args.token };
  const credentialHelper = inlineEnvCredentialHelper(args.username, args.envKey, cleanRemote);

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
