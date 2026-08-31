/**
 * The HTTP layer shared by every git forge Genosyn speaks to.
 *
 * GitHub and the Forgejo/Gitea family expose the same REST surface with three
 * mechanical differences — where the API root lives, how a token is presented,
 * and what the page-size parameter is called. Everything above this module
 * (the Integration tools, the pull-request flow, publishing a Genosyn-only
 * repository to a remote) is written once against a {@link ForgeEndpoint} and
 * works on both.
 *
 * The alternative was a second copy of `github.ts` with `api.github.com`
 * replaced. That copy would have drifted the first time either file was
 * touched, and the divergences worth knowing about — Forgejo has no code
 * search, its pull-request lookup is a path rather than a filter — would have
 * been invisible instead of commented at the one place they matter.
 *
 * An endpoint is always constructed from something a human configured: the
 * github.com constant, or a Connection's own base URL. Nothing here derives a
 * host from a repository URL, an API payload, or a redirect, because the whole
 * safety property of this feature is that a token only ever reaches the host
 * its owner issued it for.
 */

export type ForgeFlavor = "github" | "forgejo";

/**
 * One repository on a Connection's allowlist — the subset a granted employee
 * gets materialized into its working directory before a spawn.
 *
 * `defaultBranch` is captured once at pick time so the runner does not need a
 * round trip before each spawn. Staleness is fine here: the employee can
 * always `git fetch` and switch branches itself.
 */
export type ForgeRepoRef = {
  owner: string;
  name: string;
  defaultBranch: string;
};

/**
 * One forge's coordinates.
 *
 * `apiBase` is the absolute REST root with no trailing slash — for GitHub the
 * separate `api.github.com` origin, for Forgejo `<instance>/api/v1`.
 * `webBase` is where repositories are browsed and cloned from, which for
 * GitHub is a different origin entirely and for Forgejo is the instance root.
 * Both are kept because neither can be derived from the other.
 */
export type ForgeEndpoint = {
  flavor: ForgeFlavor;
  apiBase: string;
  webBase: string;
};

/** github.com, the only forge whose coordinates are a constant. */
export const GITHUB_ENDPOINT: ForgeEndpoint = {
  flavor: "github",
  apiBase: "https://api.github.com",
  webBase: "https://github.com",
};

/**
 * A Forgejo / Gitea instance's coordinates from the base URL an operator typed.
 *
 * Tolerant of the shapes people actually paste — a trailing slash, an
 * accidentally included `/api/v1`, a sub-path install — because the field is
 * filled in once, by hand, and a base URL that is right apart from its last
 * three characters should not become a support ticket.
 *
 * Throws rather than guessing on anything that is not an http(s) URL: an
 * endpoint built from nonsense fails later as an unreadable fetch error, and
 * the connect form is the place to say so.
 */
export function forgejoEndpoint(baseUrl: string): ForgeEndpoint {
  const raw = (baseUrl ?? "").trim();
  if (!raw) throw new Error("Server URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a valid server URL.`);
  }
  if (parsed.protocol !== "https:") {
    // HTTPS only, and deliberately so. Genosyn would be sending this
    // Connection's token on every call, and `git` would be sending it again on
    // every push — `services/gitCredentialHelper.ts` already refuses to mint a
    // credential for a non-https remote, so accepting `http://` here would buy
    // a Connection whose tools work and whose pushes silently fail anonymously.
    // One rule, enforced at the form, beats that split.
    throw new Error(
      "The server URL must start with https://. Genosyn will not send a token over a plain http connection — put the server behind TLS first.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("The server URL must not contain a username or password.");
  }
  // Query strings and fragments are never part of an API root; keeping them
  // would corrupt every path built from it.
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  const webBase = `${parsed.origin}${path}`;
  return { flavor: "forgejo", apiBase: `${webBase}/api/v1`, webBase };
}

/** What to call a forge in a sentence a person reads. */
export function forgeLabel(flavor: ForgeFlavor): string {
  return flavor === "github" ? "GitHub" : "Forgejo";
}

/**
 * The owner and repository a remote URL names, if this forge can serve it.
 *
 * This is the whole host-matching rule, in one place, and it is a security
 * boundary rather than a convenience: it decides whether a Connection's token
 * may be sent somewhere. Scheme, host and port must match the configured base
 * URL exactly, and the path must sit underneath it — so a Connection for
 * `https://git.acme.com/forge` never speaks for `https://git.acme.com/other`,
 * and never for `https://git.acme.com.evil.test`.
 *
 * The path prefix is why this cannot be `pathname.split("/")`. A Forgejo
 * mounted at `/git` makes `https://example.com/git/acme/web.git` — reading the
 * first two segments off that gives `git/acme`, which is a plausible-looking
 * owner and repository that no forge has ever heard of, and a 404 nobody can
 * explain.
 */
export function parseForgeRemote(
  endpoint: ForgeEndpoint,
  gitUrl: string,
): { owner: string; repo: string } | null {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(gitUrl);
    base = new URL(endpoint.webBase);
  } catch {
    return null;
  }
  // `origin` carries scheme, host and port together, which is exactly the
  // comparison wanted here — and unlike a hostname check it cannot be satisfied
  // by the same name on a different port.
  if (parsed.protocol !== "https:" || parsed.origin !== base.origin) return null;

  const prefix = base.pathname.replace(/\/+$/, "");
  const path = parsed.pathname;
  if (prefix && !path.startsWith(`${prefix}/`)) return null;
  const segments = path.slice(prefix.length).split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** The canonical clone URL for one repository on this forge. */
export function forgeCloneUrl(endpoint: ForgeEndpoint, owner: string, repo: string): string {
  return `${endpoint.webBase}/${owner}/${repo}.git`;
}

/**
 * The page-size parameter.
 *
 * GitHub calls it `per_page` everywhere. Forgejo calls it `limit` everywhere.
 * There is no endpoint on either where the other name also works, so this is
 * applied at the one place queries are built rather than per call site.
 */
export function pageSizeParam(flavor: ForgeFlavor): "per_page" | "limit" {
  return flavor === "github" ? "per_page" : "limit";
}

export type ForgeRequestInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

/**
 * A failed forge call that still carries its parsed body.
 *
 * `message` stays the forge's own plain wording, which is what an AI Employee
 * calling a tool should see. Callers that can name what they were doing —
 * which branch, which repository — build a better sentence with
 * {@link describeForgeError} and the `status` / {@link fieldCode} accessors,
 * because a 422 saying `base invalid` is noise on its own and an instruction
 * once you can name the branch.
 */
export class ForgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly flavor: ForgeFlavor,
  ) {
    super(message);
    this.name = "ForgeApiError";
  }

  /**
   * The `code` the forge attached to a validation error on `field`, if any.
   *
   * GitHub's shape only. Forgejo answers a bad pull request with a flat
   * `{message}` and no `errors` array, so this returns null there and the
   * caller falls through to matching on the message text — which is why
   * {@link describePullRequestFailure} in the work-session service tests both.
   */
  fieldCode(field: string): string | null {
    const errors = (this.body as { errors?: Array<{ field?: unknown; code?: unknown }> } | null)
      ?.errors;
    if (!Array.isArray(errors)) return null;
    for (const entry of errors) {
      if (entry?.field === field && typeof entry?.code === "string") return entry.code;
    }
    return null;
  }

  /** Every `message` the forge attached to the validation errors, joined. */
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
 * Authorization and content negotiation, per flavor.
 *
 * GitHub takes a bearer token and wants its versioned media type pinned so a
 * future default cannot change payload shapes underneath us. Forgejo's own
 * swagger says an API token "must be prepended with `token` followed by a
 * space" — it also accepts `Bearer`, but only on recent versions, and the
 * documented form is the one that works on every install a self-hoster might
 * be running.
 */
function forgeHeaders(
  flavor: ForgeFlavor,
  token: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: flavor === "github" ? `Bearer ${token}` : `token ${token}`,
    Accept: flavor === "github" ? "application/vnd.github+json" : "application/json",
    "User-Agent": "genosyn",
  };
  if (flavor === "github") headers["X-GitHub-Api-Version"] = "2022-11-28";
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * One call against a forge's REST API.
 *
 * `path` is always API-root-relative and already encoded by the caller —
 * building it here would mean this module knowing what an owner or a file path
 * is, which is exactly the knowledge the tool handlers own.
 */
export async function forgeFetch(
  endpoint: ForgeEndpoint,
  token: string,
  path: string,
  init: ForgeRequestInit = {},
): Promise<unknown> {
  const qs = init.query
    ? Object.entries(init.query)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&")
    : "";
  const url = `${endpoint.apiBase}${path}${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: forgeHeaders(endpoint.flavor, token, init.body !== undefined),
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
    throw new ForgeApiError(
      plainForgeMessage(endpoint.flavor, parsed, response.status, response.statusText),
      response.status,
      parsed,
      endpoint.flavor,
    );
  }
  return parsed;
}

/** The forge's own wording, or the status when it did not offer any. */
function plainForgeMessage(
  flavor: ForgeFlavor,
  parsed: unknown,
  status: number,
  statusText: string,
): string {
  const message = (parsed as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message) return message;
  return `${forgeLabel(flavor)} ${status} ${statusText}`;
}

/**
 * Turn a forge's error body into something a person can act on.
 *
 * GitHub's validation errors carry the useful part in a nested array, and
 * surfacing only the top-level "Repository creation failed." helps nobody.
 * Forgejo has no such array and puts everything in `message`, so the detail
 * half is simply empty there and the sentence still reads.
 */
export function describeForgeError(flavor: ForgeFlavor, parsed: unknown, status: number): string {
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
  const label = forgeLabel(flavor);
  const headline =
    typeof body?.message === "string" && body.message
      ? body.message
      : `${label} returned ${status}`;
  if (status === 401 || status === 403) {
    // Every forge call lands here, not only repository creation. Naming one
    // operation made the sentence wrong for the others, and told people to go
    // and fix a permission that was never the problem.
    const sentence = headline.endsWith(".") ? headline : `${headline}.`;
    const suffix = detail ? ` ${detail}.` : "";
    return `${sentence}${suffix} The ${label} credential may not have permission for this — reconnect it in Settings → Integrations with repository access.`;
  }
  return detail ? `${headline}: ${detail}` : headline;
}

// ─────────────────────────── argument helpers ──────────────────────────────
//
// Shared by every tool handler so the tools behave identically on both
// flavors, down to which argument is rejected and what the rejection says.

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

/**
 * An integer argument the forge addresses a resource by — an issue or pull
 * request number.
 *
 * Deliberately not {@link clampInt}: clamping a page size into range is a
 * kindness, but clamping a *number* is a way of addressing the wrong resource.
 * `number: 0` clamped up to the minimum turns "the issue I could not parse"
 * into issue #1, and `add_issue_comment` then writes a public comment on
 * whatever issue #1 happens to be. Out of range is refused, exactly like
 * absent, because there is no correct guess to make.
 */
export function requireResourceNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function requireOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  return {
    owner: requireString(args.owner, "owner"),
    repo: requireString(args.repo, "repo"),
  };
}

/**
 * One path segment built from an argument.
 *
 * `encodeURIComponent` on its own is not enough, and the gap is a security
 * one. `.` and `..` are unreserved characters, so encoding leaves them exactly
 * as they were, and the URL parser inside `fetch` resolves them away before
 * the request goes out — `/repos/../user` is *sent* as `/user`, an endpoint
 * outside the namespace this module means to address, carrying the
 * Connection's token. Since these arguments come from a model whose input can
 * be attacker-influenced (an issue body, a file in the repository), that is a
 * boundary the caller cannot be asked to remember.
 *
 * Encoding the dots is not the remedy either: the URL standard defines a
 * double-dot path segment to include `%2e%2e`, so `%2E%2E` normalises away
 * just the same. The only fix is to refuse the segment.
 */
export function pathSegment(value: string, name: string): string {
  if (value === "." || value === "..") {
    throw new Error(`${name} must not be "${value}"`);
  }
  return encodeURIComponent(value);
}

/** `/repos/<owner>/<repo>`, encoded once so no handler has to remember to. */
export function repoPath(owner: string, repo: string): string {
  return `/repos/${pathSegment(owner, "owner")}/${pathSegment(repo, "repo")}`;
}
