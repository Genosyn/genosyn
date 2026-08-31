import type { IntegrationConfig } from "../../types.js";
import type { ForgejoConfig } from "../forgejo.js";
import {
  GITHUB_ENDPOINT,
  forgejoEndpoint,
  type ForgeEndpoint,
  type ForgeRepoRef,
} from "./client.js";
import {
  readGithubRepos,
  resolveGithubCredentials,
  writeGithubRepos,
  type GithubAuthMode,
} from "../github.js";

/**
 * One Connection, seen as a git forge.
 *
 * The repository subsystem — publishing, pull requests, materializing an
 * employee's checkouts — does not want to know whether a Connection is a
 * GitHub App installation or a Forgejo token. It wants three things: can this
 * Connection speak for that host, what is its API root, and what token do I
 * use. This module is where the two connectors are unified into that answer,
 * and it is deliberately the only place that imports both.
 *
 * Everything else in the subsystem takes a {@link ForgeEndpoint} and a token.
 */

/** Every provider id that is a git forge. Order is not significant. */
export const FORGE_PROVIDERS = ["github", "forgejo"] as const;

export type ForgeProvider = (typeof FORGE_PROVIDERS)[number];

export function isForgeProvider(provider: string): provider is ForgeProvider {
  return (FORGE_PROVIDERS as readonly string[]).includes(provider);
}

/** What to call this forge in a sentence, when there is no Connection label. */
export function forgeProviderName(provider: ForgeProvider): string {
  return provider === "github" ? "GitHub" : "Forgejo";
}

/**
 * Where this Connection's API lives.
 *
 * Throws for a Forgejo Connection whose stored base URL is unusable, which
 * should be impossible — `validateApiKey` normalised it at connect time — but
 * an operator can restore an old database, and a thrown sentence beats a fetch
 * against `undefined/api/v1`.
 */
export function forgeEndpointFor(
  provider: ForgeProvider,
  config: IntegrationConfig,
): ForgeEndpoint {
  if (provider === "github") return GITHUB_ENDPOINT;
  const baseUrl = (config as ForgejoConfig).baseUrl ?? "";
  if (!baseUrl) {
    throw new Error(
      "That Forgejo Connection has no server URL. Reconnect it from Settings → Integrations.",
    );
  }
  return forgejoEndpoint(baseUrl);
}

export type ForgeCredentials = {
  endpoint: ForgeEndpoint;
  accessToken: string;
  /** The account the token authenticates as, when it is knowable. */
  login: string;
  /**
   * Set when resolving rotated the credential and the caller must re-encrypt
   * and persist it. Always null for Forgejo, whose token never expires on its
   * own — the branch exists for GitHub's OAuth refresh and App installation
   * tokens.
   */
  refreshedConfig: IntegrationConfig | null;
};

/**
 * A usable token for this Connection, plus where to send it.
 *
 * Null means the stored config is missing what it needs — an OAuth row whose
 * access token was never saved, a Forgejo row with no token. Callers treat
 * that as a hard skip rather than an error, the same way the GitHub-only
 * version always has.
 */
export async function resolveForgeCredentials(
  provider: ForgeProvider,
  config: IntegrationConfig,
  authMode: string,
): Promise<ForgeCredentials | null> {
  if (provider === "github") {
    const resolved = await resolveGithubCredentials(config, authMode as GithubAuthMode);
    if (!resolved) return null;
    return {
      endpoint: GITHUB_ENDPOINT,
      accessToken: resolved.accessToken,
      login: resolved.login,
      refreshedConfig: resolved.refreshedConfig,
    };
  }
  const cfg = config as ForgejoConfig;
  if (!cfg.apiKey) return null;
  return {
    endpoint: forgeEndpointFor(provider, config),
    accessToken: cfg.apiKey,
    login: cfg.login ?? "",
    refreshedConfig: null,
  };
}

/** The persisted repository allowlist, whatever shape this provider stores it in. */
export function readForgeRepos(
  provider: ForgeProvider,
  config: IntegrationConfig,
  authMode: string,
): ForgeRepoRef[] {
  if (provider === "github") return readGithubRepos(config, authMode as GithubAuthMode);
  return (config as ForgejoConfig).repos ?? [];
}

/** Write a new allowlist back into the config blob. */
export function writeForgeRepos(
  provider: ForgeProvider,
  config: IntegrationConfig,
  authMode: string,
  repos: ForgeRepoRef[],
): IntegrationConfig {
  if (provider === "github") return writeGithubRepos(config, authMode as GithubAuthMode, repos);
  return { ...(config as ForgejoConfig), repos } as unknown as IntegrationConfig;
}

/**
 * The `git` username to pair with this forge's token in a credential helper,
 * or null when this Connection cannot authenticate a push at all.
 *
 * GitHub App installation tokens require the literal `x-access-token`, and
 * GitHub accepts it for personal tokens too, which is why every call site used
 * to hardcode it. Forgejo resolves basic auth by looking the username up and
 * then checking the password against that account's tokens, so the username has
 * to be the token owner's real login — the GitHub literal would fail there, and
 * fail in the quiet way where `git` simply reports authentication failed.
 *
 * A Forgejo Connection always captures its login at connect time, so null here
 * means a row that predates or survived a broken connect. Refusing is right:
 * pushing with a username the server will not recognise buys nothing over
 * saying so.
 */
export function forgeGitUsername(provider: ForgeProvider, login: string): string | null {
  if (provider === "github") return "x-access-token";
  return login.trim() || null;
}
