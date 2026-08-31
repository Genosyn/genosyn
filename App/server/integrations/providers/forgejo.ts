import type { IntegrationConfig, IntegrationProvider } from "../types.js";
import { forgeFetch, forgejoEndpoint, type ForgeRepoRef } from "./forge/client.js";
import { forgeToolDefinitions, invokeForgeTool } from "./forge/tools.js";

/**
 * Forgejo / Gitea — repos, issues, pull requests, on a server the company owns.
 *
 * Genosyn could already *clone* from a self-hosted forge: a Repository points
 * at any git URL. What it could not do was talk to one. Browsing repositories,
 * triaging issues, leaving a comment, opening a pull request — every one of
 * those went through `api.github.com`, so a company that runs its own forge got
 * an AI Employee that could write code and then had no way to hand it over.
 * This connector is the other half.
 *
 * One Integration covers the whole family because they share one API. Gitea
 * forked from Gogs, Forgejo forked from Gitea, and all three serve `/api/v1`
 * with the same paths and payloads. Forgejo is the one this was built and
 * tested against; Gitea is the same surface and works; Gogs has drifted and is
 * best-effort, which the docs say rather than implying a support promise
 * nobody is keeping.
 *
 * **Auth is a token, and only a token.** Forgejo does have an OAuth2 provider,
 * but an OAuth app is registered per instance, while Genosyn's instance-wide
 * app registry (Admin → Integrations) holds one app per provider — a shape
 * that fits github.com and fits nothing that a hundred different companies
 * each self-host. A personal access token from
 * `<server>/user/settings/applications` is one field, works on every version,
 * and is what a self-hoster reaches for anyway.
 *
 * The server URL is the second field and it is the interesting one: it is what
 * tells Genosyn that this host speaks the Forgejo API at all, and it is the
 * only thing that authorises sending this token there. Everything downstream —
 * which Connection may open a pull request for which Repository, which clone
 * URL a granted employee gets — is decided by matching a remote against these
 * base URLs, never by guessing from a hostname.
 */

/** Persisted shape for a Forgejo Connection. */
export type ForgejoConfig = {
  /** Instance root as the operator typed it, normalised — no trailing slash,
   *  no `/api/v1`. Every request and every host match is built from this. */
  baseUrl: string;
  apiKey: string;
  login?: string;
  userId?: number;
  userName?: string;
  /** Which repositories the runner may materialize on disk for granted
   *  employees. Same contract as the GitHub Connection's allowlist. */
  repos?: ForgeRepoRef[];
};

export const forgejoProvider: IntegrationProvider = {
  catalog: {
    provider: "forgejo",
    name: "Forgejo / Gitea",
    category: "Developer",
    tagline: "Repos, issues, and pull requests on the git server you host yourself.",
    description:
      "Connect a Forgejo, Gitea, or Gogs server so AI employees can browse repositories, read code, triage issues, and open pull requests against the repositories you allowlist on the Connection. Paste the server URL and an access token from your account's Applications settings — the token needs read and write on repository, issue, and user. Engineering employees with a grant get a fresh `git clone` of each allowlisted repository in their working directory before every spawn, and can call `create_pull_request` to ship work, exactly as they can on GitHub.",
    // lucide ships no Forgejo or Gitea mark, and AGENTS.md allows no other
    // icon set. A neutral git glyph is honest about that rather than borrowing
    // another forge's identity.
    icon: "GitFork",
    authMode: "apikey",
    fields: [
      {
        key: "baseUrl",
        label: "Server URL",
        type: "url",
        placeholder: "https://git.example.com",
        required: true,
        hint: "The root of your Forgejo or Gitea install — not the `/api/v1` path. HTTPS only: Genosyn will not send a token over a plain http connection.",
      },
      {
        key: "apiKey",
        label: "Access token",
        type: "password",
        placeholder: "Generated at Settings → Applications",
        required: true,
        hint: "Create one at `<your server>/user/settings/applications`. Needs repository, issue, and user scopes to clone, push, and open pull requests.",
      },
    ],
    enabled: true,
  },

  tools: forgeToolDefinitions("forgejo"),

  async validateApiKey(input) {
    // `forgejoEndpoint` is what rejects a malformed or non-https URL, and it
    // does it here rather than at first use so the message lands under the
    // field that is wrong instead of inside a failed tool call days later.
    const endpoint = forgejoEndpoint(input.baseUrl ?? "");
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Access token is required");

    const user = (await forgeFetch(endpoint, apiKey, "/user")) as {
      id?: number;
      login?: string;
      full_name?: string;
    };
    if (!user?.login) {
      throw new Error(
        "That server did not return a user for this token. Check the token has not expired, and that the URL is the root of a Forgejo or Gitea install.",
      );
    }
    const config: ForgejoConfig = {
      baseUrl: endpoint.webBase,
      apiKey,
      login: user.login,
      userId: user.id,
      userName: user.full_name || undefined,
      repos: [],
    };
    const display = user.full_name ? `${user.full_name} (@${user.login})` : `@${user.login}`;
    // The host, not a masked token: a company with two Forgejo Connections is
    // telling them apart by which server they point at.
    const host = new URL(endpoint.webBase).host;
    return { config: config as unknown as IntegrationConfig, accountHint: `${display} · ${host}` };
  },

  async checkStatus(ctx) {
    try {
      const cfg = ctx.config as ForgejoConfig;
      if (!cfg.apiKey) throw new Error("This Connection is missing its access token.");
      await forgeFetch(forgejoEndpoint(cfg.baseUrl), cfg.apiKey, "/user");
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as ForgejoConfig;
    if (!cfg.apiKey) {
      throw new Error("This Forgejo Connection is missing its access token.");
    }
    return invokeForgeTool(name, args as Record<string, unknown> | undefined, {
      endpoint: forgejoEndpoint(cfg.baseUrl),
      token: cfg.apiKey,
    });
  },
};
