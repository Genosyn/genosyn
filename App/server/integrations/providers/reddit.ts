import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  OauthTokenSet,
} from "../types.js";
import { config as appConfig } from "../../../config.js";

/**
 * Reddit — OAuth 2.0 integration.
 *
 * Each Connection represents one Reddit account. The user registers a "web
 * app" client at reddit.com/prefs/apps, supplies its `clientId` (the short
 * string under the app name) + `clientSecret` when creating the Connection,
 * and the standard 3-legged consent flow runs against
 * `https://www.reddit.com/api/v1/authorize` with `duration=permanent` so we
 * get a refresh token back.
 *
 * The token endpoint requires HTTP Basic Auth (`clientId:clientSecret`) and
 * Reddit returns a 429 / blocked response if the `User-Agent` header looks
 * like a default fetch UA. We send `genosyn/1.0 (by /u/genosyn-app)` on
 * every request to stay on the friendly side of their bot policy.
 *
 * Refresh tokens do not expire on their own (only when the user revokes
 * authorisation), but access tokens last only one hour. We refresh
 * eagerly when fewer than 60 seconds remain.
 */

const REDDIT_AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API = "https://oauth.reddit.com";
const REDDIT_USER_AGENT = "genosyn/1.0 (by /u/genosyn-app)";

/** Always-included baseline scope. `identity` lets us call /api/v1/me for
 *  the account hint. */
const REDDIT_OAUTH_BASELINE_SCOPES = ["identity"];

export const REDDIT_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "read",
    label: "Read",
    description:
      "Browse posts, comments, search, and read user history across subreddits the account can see.",
    scopes: ["read", "history", "mysubreddits"],
  },
  {
    key: "submit",
    label: "Submit & comment",
    description: "Submit new posts and comment on existing threads.",
    scopes: ["submit", "edit"],
  },
  {
    key: "vote",
    label: "Vote",
    description: "Upvote and downvote posts and comments.",
    scopes: ["vote"],
  },
  {
    key: "save",
    label: "Save",
    description: "Save and unsave posts and comments to the account.",
    scopes: ["save"],
  },
  {
    key: "subscribe",
    label: "Subscribe",
    description: "Subscribe and unsubscribe from subreddits.",
    scopes: ["subscribe"],
  },
  {
    key: "messages",
    label: "Private messages",
    description: "Read the inbox and send private messages.",
    scopes: ["privatemessages"],
  },
];

export function resolveRedditScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(REDDIT_SCOPE_GROUPS.map((g) => [g.key, g] as const));
  for (const key of args.scopeGroups) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

// ---------- Config shape ----------

export type RedditOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  /** Authenticated user's snapshot. */
  username: string;
  userId: string;
  /** Scope-group keys the user picked, persisted for reconnect prefill. */
  scopeGroups?: string[];
};

// ---------- OAuth helpers (used by services/oauth.ts) ----------

export function redditRedirectUri(): string {
  const base = appConfig.publicUrl.replace(/\/+$/, "");
  return `${base}/api/integrations/oauth/callback/reddit`;
}

export function buildRedditAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL(REDDIT_AUTHORIZE_URL);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", args.state);
  u.searchParams.set("redirect_uri", args.redirectUri);
  // `permanent` = issue a refresh token. `temporary` would only give a
  // 1-hour access token with no refresh, which forces the user to redo
  // consent every hour.
  u.searchParams.set("duration", "permanent");
  u.searchParams.set("scope", args.scopes.join(" "));
  return u.toString();
}

export async function exchangeRedditCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ tokens: OauthTokenSet; userInfo: Record<string, unknown> }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  const tokRes = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(args.clientId, args.clientSecret),
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(tokRes)) as Record<string, unknown> | null;
  if (!tokRes.ok || !parsed) {
    throw new Error(redditErrorMessage(parsed, `Token exchange failed: ${tokRes.status}`));
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(redditErrorMessage(parsed, "Reddit did not return an access token"));
  }
  const access = parsed.access_token;
  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = typeof parsed.scope === "string" ? parsed.scope : "";

  // Hit /api/v1/me for the account hint. Always available with `identity`.
  const meRes = await fetch(`${REDDIT_API}/api/v1/me`, {
    headers: {
      Authorization: `Bearer ${access}`,
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
  });
  const me = ((await safeJson(meRes)) ?? {}) as Record<string, unknown>;

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh || undefined,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
      tokenType: "Bearer",
    },
    userInfo: me,
  };
}

// ---------- Tool list ----------

const REDDIT_TOOLS = [
  {
    name: "get_me",
    description:
      "Return the authenticated Reddit account (id, name, karma, created date) this connection is signed in as.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_subreddit_about",
    description: "Fetch metadata about a subreddit (subscribers, description, rules-light fields).",
    inputSchema: {
      type: "object" as const,
      properties: {
        subreddit: {
          type: "string",
          description: "Subreddit name without /r/, e.g. 'webdev'.",
        },
      },
      required: ["subreddit"],
      additionalProperties: false,
    },
  },
  {
    name: "list_subreddit_posts",
    description:
      "List posts in a subreddit. `sort` is one of hot, new, top, rising. `time` only applies to 'top' and is one of hour, day, week, month, year, all.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subreddit: { type: "string" },
        sort: {
          type: "string",
          enum: ["hot", "new", "top", "rising"],
          description: "Default 'hot'.",
        },
        time: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          description: "Window for 'top'. Default 'day'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max posts to return (1-100, default 25).",
        },
        after: {
          type: "string",
          description: "Pagination cursor returned as `after` by a prior call.",
        },
      },
      required: ["subreddit"],
      additionalProperties: false,
    },
  },
  {
    name: "get_post",
    description:
      "Fetch a single post (link or self-post) by its short id (e.g. 'abcd12'). Use `list_subreddit_posts` first to discover ids.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Short id without the `t3_` prefix.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_comments",
    description: "Fetch the comment tree for a post by its short id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        postId: {
          type: "string",
          description: "Short post id without the `t3_` prefix.",
        },
        sort: {
          type: "string",
          enum: ["confidence", "top", "new", "controversial", "old", "qa"],
          description: "Comment sort. Default 'confidence' (Reddit's 'best').",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Soft cap on returned comments (default 100).",
        },
      },
      required: ["postId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_posts",
    description:
      "Search posts. Optional `subreddit` restricts the search. `sort` is relevance, hot, top, new, comments. `time` only applies for top/comments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        subreddit: { type: "string" },
        sort: {
          type: "string",
          enum: ["relevance", "hot", "top", "new", "comments"],
        },
        time: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        after: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_post",
    description:
      "Submit a new post. `kind` is 'self' (text body) or 'link' (URL). For self: pass `text`. For link: pass `url`. Most subreddits also require flair via `flair_id`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subreddit: { type: "string" },
        kind: { type: "string", enum: ["self", "link"] },
        title: { type: "string" },
        text: { type: "string", description: "Markdown body for self-posts." },
        url: { type: "string", description: "Target URL for link posts." },
        flair_id: { type: "string" },
        nsfw: { type: "boolean" },
        spoiler: { type: "boolean" },
        sendreplies: {
          type: "boolean",
          description: "Whether replies should appear in the inbox. Default true.",
        },
      },
      required: ["subreddit", "kind", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_comment",
    description:
      "Reply to a post or another comment. `parentId` is the fullname (`t3_…` for posts, `t1_…` for comments).",
    inputSchema: {
      type: "object" as const,
      properties: {
        parentId: { type: "string" },
        text: { type: "string", description: "Markdown body." },
      },
      required: ["parentId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "vote",
    description:
      "Vote on a post or comment. `dir` is 1 (upvote), -1 (downvote), or 0 (clear).",
    inputSchema: {
      type: "object" as const,
      properties: {
        thingId: {
          type: "string",
          description: "Fullname id (`t3_…` post, `t1_…` comment).",
        },
        dir: { type: "integer", enum: [-1, 0, 1] },
      },
      required: ["thingId", "dir"],
      additionalProperties: false,
    },
  },
  {
    name: "save_thing",
    description: "Save a post or comment to the account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thingId: { type: "string" },
      },
      required: ["thingId"],
      additionalProperties: false,
    },
  },
  {
    name: "unsave_thing",
    description: "Unsave a previously saved post or comment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thingId: { type: "string" },
      },
      required: ["thingId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_my_subscribed",
    description:
      "List subreddits the authenticated account is subscribed to. Useful before `submit_post` to confirm posting access.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        after: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "subscribe_subreddit",
    description: "Subscribe or unsubscribe the authenticated account from a subreddit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subreddit: { type: "string" },
        action: { type: "string", enum: ["sub", "unsub"] },
      },
      required: ["subreddit", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a private message to another Reddit user. `to` is the recipient's username without /u/.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        subject: { type: "string", description: "Subject line (max 100 chars)." },
        text: { type: "string", description: "Markdown body." },
      },
      required: ["to", "subject", "text"],
      additionalProperties: false,
    },
  },
];

// ---------- Provider ----------

export const redditProvider: IntegrationProvider = {
  catalog: {
    provider: "reddit",
    name: "Reddit",
    category: "Communication",
    tagline: "Browse, post, comment, vote, and message on Reddit.",
    description:
      "Connect a Reddit account so AI employees can read and search posts, submit new posts and comments, vote, save items, manage subreddit subscriptions, and send private messages. Each Connection brings its own OAuth 2.0 client (reddit.com/prefs/apps → 'create another app…' → type 'web app'). Reddit issues 1-hour access tokens with permanent refresh tokens.",
    icon: "MessageCircle",
    authMode: "oauth2",
    oauth: {
      app: "reddit",
      scopes: REDDIT_OAUTH_BASELINE_SCOPES,
      scopeGroups: REDDIT_SCOPE_GROUPS,
      setupDocs: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
    },
    enabled: true,
  },

  tools: REDDIT_TOOLS,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    if (!tokens.refreshToken) {
      throw new Error(
        "Reddit did not return a refresh token. Make sure the OAuth client is type 'web app' and that `duration=permanent` was sent (Genosyn does this automatically).",
      );
    }
    const username = typeof userInfo.name === "string" ? userInfo.name : "";
    const userId = typeof userInfo.id === "string" ? userInfo.id : "";
    if (!username) {
      throw new Error("Reddit did not return user identity on /api/v1/me.");
    }
    const cfg: RedditOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      username,
      userId,
      scopeGroups,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: `u/${username}`,
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshToken(ctx);
      const cfg = ctx.config as RedditOauthConfig;
      await redditFetch(cfg.accessToken, "/api/v1/me");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    await ensureFreshToken(ctx);
    const cfg = ctx.config as RedditOauthConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_me":
        return redditFetch(cfg.accessToken, "/api/v1/me");

      case "get_subreddit_about": {
        const sub = requireString(a.subreddit, "subreddit").replace(/^\/?r\//, "");
        return redditFetch(
          cfg.accessToken,
          `/r/${encodeURIComponent(sub)}/about`,
        );
      }

      case "list_subreddit_posts": {
        const sub = requireString(a.subreddit, "subreddit").replace(/^\/?r\//, "");
        const sort = strEnum(a.sort, ["hot", "new", "top", "rising"], "hot");
        const query: Record<string, string | number | undefined> = {
          limit: clampInt(a.limit, 1, 100, 25),
          after: strOrUndef(a.after),
          raw_json: 1,
        };
        if (sort === "top") {
          query.t = strEnum(a.time, ["hour", "day", "week", "month", "year", "all"], "day");
        }
        return redditFetch(cfg.accessToken, `/r/${encodeURIComponent(sub)}/${sort}`, {
          query,
        });
      }

      case "get_post": {
        const id = requireString(a.id, "id").replace(/^t3_/, "");
        return redditFetch(cfg.accessToken, `/by_id/t3_${encodeURIComponent(id)}`, {
          query: { raw_json: 1 },
        });
      }

      case "get_comments": {
        const postId = requireString(a.postId, "postId").replace(/^t3_/, "");
        return redditFetch(cfg.accessToken, `/comments/${encodeURIComponent(postId)}`, {
          query: {
            sort: strEnum(
              a.sort,
              ["confidence", "top", "new", "controversial", "old", "qa"],
              "confidence",
            ),
            limit: clampInt(a.limit, 1, 500, 100),
            raw_json: 1,
          },
        });
      }

      case "search_posts": {
        const query = requireString(a.query, "query");
        const sub = strOrUndef(a.subreddit)?.replace(/^\/?r\//, "");
        const path = sub ? `/r/${encodeURIComponent(sub)}/search` : "/search";
        const sort = strEnum(
          a.sort,
          ["relevance", "hot", "top", "new", "comments"],
          "relevance",
        );
        const q: Record<string, string | number | undefined> = {
          q: query,
          sort,
          limit: clampInt(a.limit, 1, 100, 25),
          after: strOrUndef(a.after),
          raw_json: 1,
        };
        if (sub) q.restrict_sr = "on";
        if (sort === "top" || sort === "comments") {
          q.t = strEnum(a.time, ["hour", "day", "week", "month", "year", "all"], "all");
        }
        return redditFetch(cfg.accessToken, path, { query: q });
      }

      case "submit_post": {
        const sr = requireString(a.subreddit, "subreddit").replace(/^\/?r\//, "");
        const kind = strEnum(a.kind, ["self", "link"]);
        if (!kind) throw new Error("kind must be 'self' or 'link'");
        const title = requireString(a.title, "title");
        const form: Record<string, string> = {
          sr,
          kind,
          title,
          api_type: "json",
          resubmit: "true",
          sendreplies: a.sendreplies === false ? "false" : "true",
        };
        if (kind === "self") {
          form.text = typeof a.text === "string" ? a.text : "";
        } else {
          form.url = requireString(a.url, "url");
        }
        if (typeof a.flair_id === "string" && a.flair_id) form.flair_id = a.flair_id;
        if (a.nsfw === true) form.nsfw = "true";
        if (a.spoiler === true) form.spoiler = "true";
        return redditFormPost(cfg.accessToken, "/api/submit", form);
      }

      case "submit_comment": {
        const parent = requireString(a.parentId, "parentId");
        const text = requireString(a.text, "text");
        return redditFormPost(cfg.accessToken, "/api/comment", {
          api_type: "json",
          thing_id: parent,
          text,
        });
      }

      case "vote": {
        const thingId = requireString(a.thingId, "thingId");
        const dir = a.dir;
        if (dir !== 1 && dir !== 0 && dir !== -1) {
          throw new Error("dir must be -1, 0, or 1");
        }
        return redditFormPost(cfg.accessToken, "/api/vote", {
          id: thingId,
          dir: String(dir),
        });
      }

      case "save_thing": {
        const id = requireString(a.thingId, "thingId");
        return redditFormPost(cfg.accessToken, "/api/save", { id });
      }

      case "unsave_thing": {
        const id = requireString(a.thingId, "thingId");
        return redditFormPost(cfg.accessToken, "/api/unsave", { id });
      }

      case "list_my_subscribed": {
        return redditFetch(cfg.accessToken, "/subreddits/mine/subscriber", {
          query: {
            limit: clampInt(a.limit, 1, 100, 25),
            after: strOrUndef(a.after),
            raw_json: 1,
          },
        });
      }

      case "subscribe_subreddit": {
        const sub = requireString(a.subreddit, "subreddit").replace(/^\/?r\//, "");
        const action = strEnum(a.action, ["sub", "unsub"]);
        if (!action) throw new Error("action must be 'sub' or 'unsub'");
        return redditFormPost(cfg.accessToken, "/api/subscribe", {
          action,
          sr_name: sub,
        });
      }

      case "send_message": {
        const to = requireString(a.to, "to").replace(/^\/?u\//, "");
        const subject = requireString(a.subject, "subject");
        const text = requireString(a.text, "text");
        return redditFormPost(cfg.accessToken, "/api/compose", {
          api_type: "json",
          to,
          subject,
          text,
        });
      }

      default:
        throw new Error(`Unknown Reddit tool: ${name}`);
    }
  },
};

// ---------- Token lifecycle ----------

async function ensureFreshToken(ctx: IntegrationRuntimeContext): Promise<void> {
  if (ctx.authMode !== "oauth2") {
    throw new Error(`Reddit connector does not support authMode "${ctx.authMode}"`);
  }
  const cfg = ctx.config as RedditOauthConfig;
  if (cfg.expiresAt > Date.now() + 60_000) return;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  if (!cfg.refreshToken) {
    throw new Error(
      "Connection has no refresh token — reconnect from Settings → Integrations.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
  });
  const res = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(redditErrorMessage(parsed, `Reddit token refresh failed: ${res.status}`));
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(redditErrorMessage(parsed, "Refresh did not return an access token"));
  }
  const access = parsed.access_token;
  // Reddit currently does not rotate refresh tokens, but accept a new one
  // if it ever decides to.
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : cfg.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  const next: RedditOauthConfig = {
    ...cfg,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

// ---------- HTTP helpers ----------

type FetchInit = {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
};

async function redditFetch(
  accessToken: string,
  path: string,
  init: FetchInit = {},
): Promise<unknown> {
  const qs = init.query
    ? "?" +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&")
    : "";
  const url = `${REDDIT_API}${path}${qs}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new Error(
      redditErrorMessage(
        parsed as Record<string, unknown> | null,
        `Reddit ${res.status} ${res.statusText}`,
      ),
    );
  }
  return parsed;
}

async function redditFormPost(
  accessToken: string,
  path: string,
  form: Record<string, string>,
): Promise<unknown> {
  const url = `${REDDIT_API}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(
      redditErrorMessage(parsed, `Reddit ${res.status} ${res.statusText}`),
    );
  }
  // Reddit's `api_type=json` endpoints return errors inside a 200 body
  // under `json.errors`. Surface those so the AI sees something useful
  // ("SUBREDDIT_NOEXIST", "RATELIMIT", etc.).
  const json = (parsed?.json ?? {}) as Record<string, unknown>;
  const errs = json.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const first = errs[0];
    if (Array.isArray(first) && first.length > 0) {
      const code = typeof first[0] === "string" ? first[0] : "";
      const msg = typeof first[1] === "string" ? first[1] : "";
      throw new Error(`Reddit rejected the request: ${code}${msg ? ` — ${msg}` : ""}`);
    }
  }
  return parsed;
}

// ---------- Low-level helpers ----------

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strEnum<T extends string>(
  v: unknown,
  options: readonly T[],
  fallback?: T,
): T | undefined {
  if (typeof v === "string" && (options as readonly string[]).includes(v)) {
    return v as T;
  }
  return fallback;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function redditErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const desc = (parsed as { error_description?: unknown }).error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err) return err;
  const msg = (parsed as { message?: unknown }).message;
  if (typeof msg === "string" && msg) return msg;
  return fallback;
}
