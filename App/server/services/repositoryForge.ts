import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Repository } from "../db/entities/Repository.js";
import {
  ForgeApiError,
  GITHUB_ENDPOINT,
  describeForgeError,
  forgeFetch,
  forgeLabel,
  parseForgeRemote,
  pathSegment,
  repoPath,
  type ForgeEndpoint,
} from "../integrations/providers/forge/client.js";
import {
  FORGE_PROVIDERS,
  forgeEndpointFor,
  forgeProviderName,
  isForgeProvider,
  resolveForgeCredentials,
  type ForgeProvider,
} from "../integrations/providers/forge/connection.js";
import { decryptConnectionConfig, persistConnectionConfigIfCurrent } from "./integrations.js";
import { assertSafeCredentialToken } from "./gitCredentialHelper.js";

/**
 * Speaking to the git forge a Repository lives on — GitHub, or a Forgejo /
 * Gitea the company hosts itself.
 *
 * Two things happen here. Publishing a repository that began its life inside
 * Genosyn: creating it on the forge and pushing, without anyone generating a
 * personal access token and pasting it into a form, because the company
 * already authenticated the forge once in Settings → Integrations. And opening
 * a pull request for work an AI Employee did, which is how that work enters
 * whatever review the team already runs.
 *
 * **Which forge, and how we know.** This used to be a hostname comparison
 * against `github.com`, which was both the host check and the "can we talk to
 * it" check, because there was only ever one answer. There are now two kinds:
 *
 *   • github.com is a constant. Genosyn can always speak to it, whether or not
 *     the company has a GitHub Connection — a Repository carrying its own
 *     HTTPS token has been able to open pull requests that way from the start,
 *     and still can.
 *   • Every other forge is known only because somebody configured it. A
 *     Forgejo Connection carries the server's base URL, and that base URL is
 *     the *only* thing that makes `https://git.acme.com/team/web.git` a forge
 *     Genosyn will send a token to. Nothing here sniffs, probes, or guesses a
 *     host: an unconfigured server stays a plain git remote that can be cloned
 *     and pushed but has no API.
 *
 * The credential is resolved per operation and handed only to the server-owned
 * git child or a direct API call. It is never stored on the Repository row,
 * never returned to the client, and never reaches an employee checkout — the
 * same rule every other credential in this feature follows.
 */

export type ForgeConnectionOption = {
  id: string;
  label: string;
  provider: ForgeProvider;
  /** "GitHub" / "Forgejo", for a picker that now has two kinds in it. */
  providerName: string;
  accountLogin: string | null;
  /** The server this Connection points at — `github.com`, or the self-hosted
   *  host. Two Forgejo Connections are told apart by this and nothing else. */
  host: string;
};

/** Every connected forge Connection for a company, oldest first. */
async function connectedForgeConnections(companyId: string): Promise<IntegrationConnection[]> {
  return AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId, provider: In([...FORGE_PROVIDERS]), status: "connected" },
    order: { createdAt: "ASC" },
  });
}

/** The company's connected forge Connections, for the connect picker. */
export async function listForgeConnections(companyId: string): Promise<ForgeConnectionOption[]> {
  const rows = await connectedForgeConnections(companyId);
  const options: ForgeConnectionOption[] = [];
  for (const row of rows) {
    if (!isForgeProvider(row.provider)) continue;
    const endpoint = safeEndpointFor(row);
    if (!endpoint) continue;
    options.push({
      id: row.id,
      label: row.label || forgeProviderName(row.provider),
      provider: row.provider,
      providerName: forgeProviderName(row.provider),
      accountLogin: readAccountLogin(row),
      host: hostOf(endpoint),
    });
  }
  return options;
}

function hostOf(endpoint: ForgeEndpoint): string {
  try {
    return new URL(endpoint.webBase).host;
  } catch {
    return endpoint.webBase;
  }
}

/**
 * This Connection's endpoint, or null when its stored config cannot produce
 * one.
 *
 * A row whose base URL is missing or malformed is a row that can never work,
 * and every caller here is building a list or matching a host — neither is a
 * place to throw. The connect and reconnect paths report the real problem.
 */
function safeEndpointFor(connection: IntegrationConnection): ForgeEndpoint | null {
  if (!isForgeProvider(connection.provider)) return null;
  try {
    return forgeEndpointFor(connection.provider, decryptConnectionConfig(connection));
  } catch {
    return null;
  }
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

export type ResolvedForgeToken = {
  token: string;
  login: string;
  endpoint: ForgeEndpoint;
  provider: ForgeProvider;
};

/**
 * Resolve a usable token from a Connection, rotating and persisting a
 * refreshed OAuth/App credential when one comes back.
 */
export async function resolveConnectionToken(
  connection: IntegrationConnection,
): Promise<ResolvedForgeToken> {
  if (!isForgeProvider(connection.provider)) {
    throw new Error(`${connection.label || connection.provider} is not a git forge Connection.`);
  }
  const provider = connection.provider;
  const name = forgeProviderName(provider);
  const snapshot = connection.encryptedConfig;
  const config = decryptConnectionConfig(connection);
  const credentials = await resolveForgeCredentials(provider, config, connection.authMode);
  if (!credentials) {
    throw new Error(
      `That ${name} Connection is missing its credentials. Reconnect it from Settings → Integrations.`,
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
  return {
    token: credentials.accessToken,
    login: credentials.login,
    endpoint: credentials.endpoint,
    provider,
  };
}

/**
 * Which forge a Repository's remote belongs to, and which Connection speaks
 * for it.
 *
 * `connections` holds every candidate in creation order; `connection` is the
 * one to actually use — the pin on the Repository row if it still exists,
 * otherwise the sole candidate. With several candidates and no pin this is
 * left null and `ambiguous` is set, because guessing which of a company's
 * accounts should be pushing to its code is not an acceptable default.
 *
 * A github.com remote resolves even with no Connection at all: `connections`
 * is empty, `connection` is null, `ambiguous` is false, and a caller that has
 * its own token can still use the endpoint.
 */
export type ForgeRemoteMatch = {
  endpoint: ForgeEndpoint;
  provider: ForgeProvider;
  remote: { owner: string; repo: string };
  connections: IntegrationConnection[];
  connection: IntegrationConnection | null;
  ambiguous: boolean;
};

/**
 * The company's forge Connections paired with their endpoints, decrypted once.
 *
 * Hydrating a list of repositories asks the same question of each one, and
 * decrypting every Connection per row turns a page render into N × M AES
 * operations. Load the candidates once and match against them.
 */
export type ForgeCandidate = { connection: IntegrationConnection; endpoint: ForgeEndpoint };

export async function loadForgeCandidates(companyId: string): Promise<ForgeCandidate[]> {
  const rows = await connectedForgeConnections(companyId);
  const candidates: ForgeCandidate[] = [];
  for (const connection of rows) {
    const endpoint = safeEndpointFor(connection);
    if (endpoint) candidates.push({ connection, endpoint });
  }
  return candidates;
}

export function matchForgeRemote(
  repo: Repository,
  available: readonly ForgeCandidate[],
): ForgeRemoteMatch | null {
  const candidates: Array<{
    connection: IntegrationConnection;
    endpoint: ForgeEndpoint;
    remote: { owner: string; repo: string };
  }> = [];
  for (const { connection, endpoint } of available) {
    const remote = parseForgeRemote(endpoint, repo.gitUrl);
    if (remote) candidates.push({ connection, endpoint, remote });
  }

  if (candidates.length > 0) {
    // Host matching runs before counting, which is what keeps a second forge
    // from making everything ambiguous: a company with one GitHub and one
    // Forgejo Connection has two rows, and exactly one of them can ever speak
    // for a given remote.
    const pinned = repo.githubConnectionId
      ? candidates.find((entry) => entry.connection.id === repo.githubConnectionId)
      : undefined;
    const chosen = pinned ?? (candidates.length === 1 ? candidates[0] : undefined);
    return {
      endpoint: chosen?.endpoint ?? candidates[0].endpoint,
      provider: (chosen ?? candidates[0]).connection.provider as ForgeProvider,
      remote: (chosen ?? candidates[0]).remote,
      connections: candidates.map((entry) => entry.connection),
      connection: chosen?.connection ?? null,
      ambiguous: !chosen,
    };
  }

  // No Connection matched. github.com is still known, because it is a constant
  // rather than something an operator configured — a Repository carrying its
  // own HTTPS token has always been able to open pull requests with no
  // Connection at all, and that has to keep working.
  const github = parseForgeRemote(GITHUB_ENDPOINT, repo.gitUrl);
  if (github) {
    return {
      endpoint: GITHUB_ENDPOINT,
      provider: "github",
      remote: github,
      connections: [],
      connection: null,
      ambiguous: false,
    };
  }
  return null;
}

/**
 * Whether this remote could belong to any forge at all, without asking the
 * database.
 *
 * A token authenticates HTTPS and nothing else, so `parseForgeRemote` refuses
 * every other scheme — which makes an SSH remote, a `file://` path, or a plain
 * `http://` server a decided question before a query is worth running. The old
 * github.com hostname check answered the same question for free, and dropping
 * that short-circuit put a `SELECT` on the credential path of every repository
 * that can never match one.
 */
function couldBeForgeRemote(gitUrl: string): boolean {
  try {
    return new URL(gitUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export async function resolveForgeRemote(repo: Repository): Promise<ForgeRemoteMatch | null> {
  if (!couldBeForgeRemote(repo.gitUrl)) return null;
  return matchForgeRemote(repo, await loadForgeCandidates(repo.companyId));
}

/**
 * What the browser needs to know about a Repository's forge.
 *
 * The client used to work this out for itself by parsing the clone URL and
 * comparing the hostname to `github.com`, which was correct exactly as long as
 * there was one possible answer. It cannot work it out now: deciding whether a
 * host is a forge means reading each Connection's base URL, and the browser
 * never sees a Connection's config. So the server answers, once, on the row
 * the repository pages already load.
 */
export type RepositoryForgeInfo = {
  provider: ForgeProvider;
  /** "GitHub" / "Forgejo" — what the UI calls it in a sentence. */
  name: string;
  /** How a credential for this remote is found, for the sign-in summary. */
  credential: "pinned" | "sole" | "ambiguous" | "none";
};

export function describeRepositoryForge(
  repo: Repository,
  available: readonly ForgeCandidate[],
): RepositoryForgeInfo | null {
  const match = matchForgeRemote(repo, available);
  if (!match) return null;
  const credential: RepositoryForgeInfo["credential"] = match.ambiguous
    ? "ambiguous"
    : match.connection
      ? repo.githubConnectionId === match.connection.id
        ? "pinned"
        : "sole"
      : "none";
  return { provider: match.provider, name: forgeProviderName(match.provider), credential };
}

/**
 * Find the Connection that can authenticate git operations on this
 * repository's remote, for a repository whose own `authMode` is `none`.
 *
 * Deliberately narrow: a repository carrying its own credential uses that one,
 * and this answers only for the repositories that have none.
 */
export async function findConnectionForRemote(
  repo: Repository,
): Promise<IntegrationConnection | null> {
  if (repo.authMode !== "none") return null;
  const match = await resolveForgeRemote(repo);
  return match?.connection ?? null;
}

/**
 * The same question as {@link findConnectionForRemote}, with the reason kept.
 *
 * "No connection" and "several connections and no way to choose" both used to
 * come back as `null`, so both were reported as "connect GitHub in Settings →
 * Integrations" — advice that is actively wrong for the second, where the
 * person has already connected the forge twice and doing it a third time
 * changes nothing. The caller needs to tell them apart to say anything useful.
 */
export type RemoteConnectionResult =
  | { kind: "one"; connection: IntegrationConnection }
  | { kind: "ambiguous"; connections: IntegrationConnection[] }
  | { kind: "none" };

export async function resolveConnectionForRemote(
  repo: Repository,
): Promise<RemoteConnectionResult> {
  if (repo.authMode !== "none") return { kind: "none" };
  const match = await resolveForgeRemote(repo);
  if (!match || match.connections.length === 0) return { kind: "none" };
  if (match.connection) return { kind: "one", connection: match.connection };
  return { kind: "ambiguous", connections: match.connections };
}

/**
 * The branch the forge itself considers this repository's trunk.
 *
 * Genosyn stores a `defaultBranch` on the Repository row, but nothing has ever
 * checked it against the remote: the create form pre-fills `main`, a plain
 * `git clone` never contradicts it, and a repository whose trunk is `master`
 * carries the wrong value forever. That is invisible until something has to
 * name the branch to the forge — at which point a pull request is opened
 * against a branch that does not exist and the answer is a bare "Validation
 * Failed". Asking the API is one request and it is never wrong.
 */
export async function forgeDefaultBranch(
  endpoint: ForgeEndpoint,
  token: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const payload = (await forgeRequest(endpoint, token, repoPath(owner, repo))) as {
      default_branch?: unknown;
    };
    return typeof payload.default_branch === "string" && payload.default_branch
      ? payload.default_branch
      : null;
  } catch {
    // Not fatal: the caller falls back to what the row says, and the create
    // call reports anything genuinely wrong with the credential.
    return null;
  }
}

export type ForgePullRequest = {
  number: number;
  htmlUrl: string;
  state: string;
};

export type ForgePullRequestArgs = {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

/** Open a pull request for a branch that has already been pushed. */
export async function createForgePullRequest(
  endpoint: ForgeEndpoint,
  token: string,
  args: ForgePullRequestArgs,
): Promise<ForgePullRequest> {
  const payload = await forgeRequest(endpoint, token, `${repoPath(args.owner, args.repo)}/pulls`, {
    method: "POST",
    body: { title: args.title, body: args.body, head: args.head, base: args.base },
  });
  return toPullRequest(endpoint, payload);
}

/**
 * The open pull request for a branch, if there already is one.
 *
 * Asking first is what makes "open a pull request" safe to press twice: both
 * forges refuse a duplicate, and a Member who revised the work and pressed the
 * button again means "update it", not "fail".
 *
 * The two forges answer this differently. GitHub filters its pull request list
 * by head branch. Forgejo cannot — it has an exact `pulls/{base}/{head}`
 * lookup instead, but that needs the base branch, and the caller deliberately
 * asks this question *before* working out what the trunk is called so that
 * updating an existing pull request never has to. So Forgejo lists the open
 * pull requests and matches the head branch here, which costs one request and
 * keeps the call order identical on both.
 */
export async function findOpenForgePullRequest(
  endpoint: ForgeEndpoint,
  token: string,
  args: { owner: string; repo: string; head: string; number?: number | null },
): Promise<ForgePullRequest | null> {
  // The session may already know which pull request it opened. Asking for it
  // by number is exact, and it is the only lookup that still works for a
  // credential that may create a pull request but may not list them — which
  // otherwise made every press after the first fail with "a pull request
  // already exists", forever.
  if (args.number) {
    const byNumber = await getForgePullRequest(endpoint, token, {
      owner: args.owner,
      repo: args.repo,
      number: args.number,
    });
    if (byNumber && byNumber.state === "open") return byNumber;
  }
  try {
    if (endpoint.flavor === "forgejo") {
      const payload = await forgeRequest(
        endpoint,
        token,
        `${repoPath(args.owner, args.repo)}/pulls`,
        { query: { state: "open", limit: 100 } },
      );
      if (!Array.isArray(payload)) return null;
      const match = payload.find(
        (entry) => (entry as { head?: { ref?: unknown } })?.head?.ref === args.head,
      );
      return match ? toPullRequest(endpoint, match) : null;
    }
    const payload = await forgeRequest(
      endpoint,
      token,
      `${repoPath(args.owner, args.repo)}/pulls`,
      { query: { state: "open", head: `${args.owner}:${args.head}` } },
    );
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return toPullRequest(endpoint, payload[0]);
  } catch {
    // A lookup that fails is not a reason to refuse to open one; the create
    // call below reports anything genuinely wrong with the credential.
    return null;
  }
}

/** One pull request by number, for a session that already recorded it. */
export async function getForgePullRequest(
  endpoint: ForgeEndpoint,
  token: string,
  args: { owner: string; repo: string; number: number },
): Promise<ForgePullRequest | null> {
  try {
    const payload = await forgeRequest(
      endpoint,
      token,
      `${repoPath(args.owner, args.repo)}/pulls/${args.number}`,
    );
    return toPullRequest(endpoint, payload);
  } catch {
    return null;
  }
}

function toPullRequest(endpoint: ForgeEndpoint, payload: unknown): ForgePullRequest {
  const body = payload as { number?: unknown; html_url?: unknown; state?: unknown };
  if (typeof body?.number !== "number" || typeof body?.html_url !== "string") {
    throw new Error(`${forgeLabel(endpoint.flavor)} did not return a usable pull request.`);
  }
  return {
    number: body.number,
    htmlUrl: body.html_url,
    state: typeof body.state === "string" ? body.state : "open",
  };
}

export type CreatedForgeRepository = {
  gitUrl: string;
  htmlUrl: string | null;
  defaultBranch: string | null;
};

/**
 * Create a repository on the forge.
 *
 * Created empty — no README, no licence, no .gitignore — because the point is
 * to push an existing history into it, and an auto-created initial commit
 * would make that push a non-fast-forward the person cannot resolve from here.
 */
export async function createForgeRepository(args: {
  endpoint: ForgeEndpoint;
  token: string;
  name: string;
  owner?: string | null;
  private: boolean;
  description?: string;
}): Promise<CreatedForgeRepository> {
  const owner = (args.owner ?? "").trim();
  const path = owner ? `/orgs/${pathSegment(owner, "owner")}/repos` : "/user/repos";
  const payload = await forgeRequest(args.endpoint, args.token, path, {
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
    throw new Error(
      `${forgeLabel(args.endpoint.flavor)} created the repository but did not return a clone URL.`,
    );
  }
  return {
    gitUrl,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : null,
  };
}

/**
 * A forge call whose failure carries a sentence a person can act on.
 *
 * The transport's own message is the forge's plain wording, which is the right
 * thing for an AI Employee reading a tool result. These calls are driven by a
 * Member pressing a button, so they get the fuller version — the validation
 * detail GitHub buries in a nested array, and the "the credential may not have
 * permission" hint on a 401 or 403. Status and body are preserved so the
 * caller can still match on them.
 */
async function forgeRequest(
  endpoint: ForgeEndpoint,
  token: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {},
): Promise<unknown> {
  try {
    return await forgeFetch(endpoint, token, path, init);
  } catch (error) {
    if (error instanceof ForgeApiError) {
      throw new ForgeApiError(
        describeForgeError(endpoint.flavor, error.body, error.status),
        error.status,
        error.body,
        error.flavor,
      );
    }
    throw error;
  }
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
