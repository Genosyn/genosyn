import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Repository } from "../db/entities/Repository.js";
import type { GithubAuthMode } from "../integrations/providers/github.js";
import { resolveGithubCredentials } from "../integrations/providers/github.js";
import { decryptConnectionConfig, persistConnectionConfigIfCurrent } from "./integrations.js";
import { assertSafeCredentialToken } from "./gitCredentialHelper.js";

/**
 * Publishing a Repository to GitHub through a company's GitHub Connection.
 *
 * This is what makes "start an empty one" a real starting point rather than a
 * dead end: a repository that began its life inside Genosyn can later be
 * created on GitHub and pushed, without anyone generating a personal access
 * token and pasting it into a form. The company already authenticated GitHub
 * once, in Settings → Integrations; this reuses that.
 *
 * The Connection's token is resolved per operation and handed only to the
 * server-owned git child or a direct API call. It is never stored on the
 * Repository row, never returned to the client, and never reaches an employee
 * checkout — the same rule every other credential in this feature follows.
 */

const GITHUB_API = "https://api.github.com";

export type GithubConnectionOption = {
  id: string;
  label: string;
  accountLogin: string | null;
};

/** The company's connected GitHub Connections, for the connect picker. */
export async function listGithubConnections(companyId: string): Promise<GithubConnectionOption[]> {
  const rows = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId, provider: "github", status: "connected" },
    order: { createdAt: "ASC" },
  });
  return rows.map((row) => ({
    id: row.id,
    label: row.label || "GitHub",
    accountLogin: readAccountLogin(row),
  }));
}

/**
 * The account a Connection authenticates as, when it is knowable.
 *
 * Shown in the picker so someone with a personal and an organisation
 * Connection can tell them apart. Decryption failure is not an error here —
 * the picker just loses a label.
 */
function readAccountLogin(connection: IntegrationConnection): string | null {
  try {
    const config = decryptConnectionConfig(connection) as {
      login?: unknown;
      account?: unknown;
    };
    const login = config.login ?? config.account;
    if (typeof login === "string" && login) return login;
    return connection.accountHint || null;
  } catch {
    return null;
  }
}

export type ResolvedGithubToken = { token: string; login: string };

/**
 * Resolve a usable GitHub token from a Connection, rotating and persisting a
 * refreshed OAuth/App credential when one comes back.
 */
export async function resolveConnectionToken(
  connection: IntegrationConnection,
): Promise<ResolvedGithubToken> {
  const snapshot = connection.encryptedConfig;
  const config = decryptConnectionConfig(connection);
  const credentials = await resolveGithubCredentials(config, connection.authMode as GithubAuthMode);
  if (!credentials) {
    throw new Error(
      "That GitHub Connection is missing its credentials. Reconnect it from Settings → Integrations.",
    );
  }
  assertSafeCredentialToken(credentials.accessToken);
  if (credentials.refreshedConfig) {
    await persistConnectionConfigIfCurrent({
      connectionId: connection.id,
      companyId: connection.companyId,
      previousEncryptedConfig: snapshot,
      config: credentials.refreshedConfig,
      healthy: true,
    });
  }
  return { token: credentials.accessToken, login: credentials.login };
}

/**
 * Find the Connection that can authenticate pushes to this repository's
 * remote, for a repository whose own `authMode` is `none`.
 *
 * Deliberately narrow: HTTPS github.com remotes only, because that is the only
 * shape a Connection token can authenticate. Everything else needs its own
 * stored credential, and saying so is better than failing at push time with a
 * confusing Git error.
 */
export async function findConnectionForRemote(
  repo: Repository,
): Promise<IntegrationConnection | null> {
  const resolved = await resolveConnectionForRemote(repo);
  return resolved.kind === "one" ? resolved.connection : null;
}

/**
 * The same question as {@link findConnectionForRemote}, with the reason kept.
 *
 * "No connection" and "several connections and no way to choose" both used to
 * come back as `null`, so both were reported as "connect GitHub in Settings →
 * Integrations" — advice that is actively wrong for the second, where the
 * person has already connected GitHub twice and doing it a third time changes
 * nothing. The caller needs to tell them apart to say anything useful.
 */
export type RemoteConnectionResult =
  | { kind: "one"; connection: IntegrationConnection }
  | { kind: "ambiguous"; connections: IntegrationConnection[] }
  | { kind: "none" };

export async function resolveConnectionForRemote(
  repo: Repository,
): Promise<RemoteConnectionResult> {
  if (repo.authMode !== "none" || !isGithubHttpsUrl(repo.gitUrl)) return { kind: "none" };
  const rows = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId: repo.companyId, provider: "github", status: "connected" },
    order: { createdAt: "ASC" },
  });
  if (rows.length === 0) return { kind: "none" };
  if (repo.githubConnectionId) {
    const pinned = rows.find((row) => row.id === repo.githubConnectionId);
    if (pinned) return { kind: "one", connection: pinned };
  }
  // With exactly one GitHub Connection there is nothing to disambiguate. With
  // several and no pin, refuse rather than guess which account should be
  // pushing to the company's code.
  return rows.length === 1 ? { kind: "one", connection: rows[0] } : { kind: "ambiguous", connections: rows };
}

/**
 * Split a GitHub HTTPS remote into the owner and repository the API wants.
 *
 * Only the shape a Connection or stored token can authenticate — the same
 * narrowness {@link findConnectionForRemote} applies, for the same reason:
 * saying "GitHub remotes only" up front beats a confusing 404 from an API call
 * built out of a path that was never a GitHub repository.
 */
export function parseGithubRemote(gitUrl: string): { owner: string; repo: string } | null {
  if (!isGithubHttpsUrl(gitUrl)) return null;
  try {
    const segments = new URL(gitUrl).pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, "");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * The branch GitHub itself considers this repository's trunk.
 *
 * Genosyn stores a `defaultBranch` on the Repository row, but nothing has ever
 * checked it against the remote: the create form pre-fills `main`, a plain
 * `git clone` never contradicts it, and a repository whose trunk is `master`
 * carries the wrong value forever. That is invisible until something has to
 * name the branch to GitHub — at which point a pull request is opened against
 * a branch that does not exist and GitHub answers with a bare "Validation
 * Failed". Asking the API is one request and it is never wrong.
 */
export async function githubDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const payload = (await githubRequest(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    )) as { default_branch?: unknown };
    return typeof payload.default_branch === "string" && payload.default_branch
      ? payload.default_branch
      : null;
  } catch {
    // Not fatal: the caller falls back to what the row says, and the create
    // call reports anything genuinely wrong with the credential.
    return null;
  }
}

export type GithubPullRequest = {
  number: number;
  htmlUrl: string;
  state: string;
};

export type GithubPullRequestArgs = {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

/** Open a pull request for a branch that has already been pushed. */
export async function createGithubPullRequest(
  token: string,
  args: GithubPullRequestArgs,
): Promise<GithubPullRequest> {
  const payload = await githubRequest(
    token,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    {
      method: "POST",
      body: { title: args.title, body: args.body, head: args.head, base: args.base },
    },
  );
  return toPullRequest(payload);
}

/**
 * The open pull request for a branch, if there already is one.
 *
 * Asking first is what makes "open a pull request" safe to press twice: GitHub
 * refuses a duplicate with a validation error, and a Member who revised the
 * work and pressed the button again means "update it", not "fail".
 */
export async function findOpenGithubPullRequest(
  token: string,
  args: { owner: string; repo: string; head: string; number?: number | null },
): Promise<GithubPullRequest | null> {
  // The session may already know which pull request it opened. Asking for it
  // by number is exact, and it is the only lookup that still works for a
  // credential that may create a pull request but may not list them — which
  // otherwise made every press after the first fail with GitHub's "a pull
  // request already exists", forever.
  if (args.number) {
    const byNumber = await getGithubPullRequest(token, {
      owner: args.owner,
      repo: args.repo,
      number: args.number,
    });
    if (byNumber && byNumber.state === "open") return byNumber;
  }
  try {
    const payload = await githubRequest(
      token,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls` +
        `?state=open&head=${encodeURIComponent(`${args.owner}:${args.head}`)}`,
    );
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return toPullRequest(payload[0]);
  } catch {
    // A lookup that fails is not a reason to refuse to open one; the create
    // call below reports anything genuinely wrong with the credential.
    return null;
  }
}

/** One pull request by number, for a session that already recorded it. */
export async function getGithubPullRequest(
  token: string,
  args: { owner: string; repo: string; number: number },
): Promise<GithubPullRequest | null> {
  try {
    const payload = await githubRequest(
      token,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}`,
    );
    return toPullRequest(payload);
  } catch {
    return null;
  }
}

function toPullRequest(payload: unknown): GithubPullRequest {
  const body = payload as { number?: unknown; html_url?: unknown; state?: unknown };
  if (typeof body?.number !== "number" || typeof body?.html_url !== "string") {
    throw new Error("GitHub did not return a usable pull request.");
  }
  return {
    number: body.number,
    htmlUrl: body.html_url,
    state: typeof body.state === "string" ? body.state : "open",
  };
}

export function isGithubHttpsUrl(gitUrl: string): boolean {
  try {
    const parsed = new URL(gitUrl);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export type CreatedGithubRepository = {
  gitUrl: string;
  htmlUrl: string | null;
  defaultBranch: string | null;
};

/**
 * Create a repository on GitHub.
 *
 * Created empty — no README, no licence, no .gitignore — because the point is
 * to push an existing history into it, and an auto-created initial commit
 * would make that push a non-fast-forward the person cannot resolve from here.
 */
export async function createGithubRepository(args: {
  token: string;
  name: string;
  owner?: string | null;
  private: boolean;
  description?: string;
}): Promise<CreatedGithubRepository> {
  const owner = (args.owner ?? "").trim();
  const path = owner ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos";
  const payload = await githubRequest(args.token, path, {
    method: "POST",
    body: {
      name: args.name,
      private: args.private,
      description: args.description || undefined,
      auto_init: false,
    },
  });
  const body = payload as {
    clone_url?: unknown;
    html_url?: unknown;
    default_branch?: unknown;
  };
  const gitUrl = typeof body.clone_url === "string" ? body.clone_url : "";
  if (!gitUrl) {
    throw new Error("GitHub created the repository but did not return a clone URL.");
  }
  return {
    gitUrl,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : null,
  };
}

/** Whether a repository already exists, so we can say so before creating. */
export async function githubRepositoryExists(
  token: string,
  owner: string,
  name: string,
): Promise<boolean> {
  try {
    await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    return true;
  } catch {
    return false;
  }
}

/** The login the token authenticates as, used when no owner was given. */
export async function githubViewerLogin(token: string): Promise<string | null> {
  try {
    const payload = (await githubRequest(token, "/user")) as { login?: unknown };
    return typeof payload.login === "string" ? payload.login : null;
  } catch {
    return null;
  }
}

async function githubRequest(
  token: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "genosyn",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new GithubApiError(describeGithubError(parsed, response.status), response.status, parsed);
  }
  return parsed;
}

/**
 * A failed GitHub call that still carries its parsed body.
 *
 * `describeGithubError` is a good general answer, but the caller usually knows
 * something the HTTP layer cannot: which branch it asked for, which repository
 * it asked about. A 422 saying `base invalid` is noise on its own and an
 * instruction once you can name the branch. Keeping the body lets the caller
 * write that sentence, while `message` stays exactly what it was for every
 * caller that only reads `.message`.
 */
export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GithubApiError";
  }

  /** The `code` GitHub attached to a validation error on `field`, if any. */
  fieldCode(field: string): string | null {
    const errors = (this.body as { errors?: Array<{ field?: unknown; code?: unknown }> } | null)
      ?.errors;
    if (!Array.isArray(errors)) return null;
    for (const entry of errors) {
      if (entry?.field === field && typeof entry?.code === "string") return entry.code;
    }
    return null;
  }

  /** Every `message` GitHub attached to the validation errors, joined. */
  errorMessages(): string {
    const errors = (this.body as { errors?: Array<{ message?: unknown }> } | null)?.errors;
    if (!Array.isArray(errors)) return "";
    return errors
      .map((entry) => (typeof entry?.message === "string" ? entry.message : null))
      .filter((value): value is string => !!value)
      .join("; ");
  }
}

/**
 * Turn GitHub's error body into something a person can act on. Its validation
 * errors carry the useful part in a nested array, and surfacing only the
 * top-level "Repository creation failed." helps nobody.
 */
export function describeGithubError(parsed: unknown, status: number): string {
  const body = parsed as {
    message?: unknown;
    errors?: Array<{ message?: unknown; field?: unknown; code?: unknown }>;
  } | null;
  const detail = Array.isArray(body?.errors)
    ? body.errors
        .map((entry) => {
          if (typeof entry?.message === "string") return entry.message;
          if (typeof entry?.field === "string" && typeof entry?.code === "string") {
            return `${entry.field} ${entry.code}`;
          }
          return null;
        })
        .filter((value): value is string => !!value)
        .join("; ")
    : "";
  const headline =
    typeof body?.message === "string" && body.message ? body.message : `GitHub returned ${status}`;
  if (status === 401 || status === 403) {
    // Every GitHub call in this file lands here, not only repository creation.
    // Naming one operation made the sentence wrong for the others, and told
    // people to go and fix a permission that was never the problem.
    const sentence = headline.endsWith(".") ? headline : `${headline}.`;
    const suffix = detail ? ` ${detail}.` : "";
    return `${sentence}${suffix} The GitHub credential may not have permission for this — reconnect it in Settings → Integrations with repository access.`;
  }
  return detail ? `${headline}: ${detail}` : headline;
}

/** Connections referenced by repositories, for hydration without N queries. */
export async function connectionsById(
  companyId: string,
  ids: string[],
): Promise<Map<string, IntegrationConnection>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId, id: In(unique) },
  });
  return new Map(rows.map((row) => [row.id, row]));
}
