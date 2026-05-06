import crypto from "node:crypto";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  OauthTokenSet,
} from "../types.js";
import {
  deleteTweetViaBrowser,
  followUserViaBrowser,
  likeTweetViaBrowser,
  postTweetViaBrowser,
  retweetViaBrowser,
  runWithXBrowser,
  unfollowUserViaBrowser,
  unlikeTweetViaBrowser,
  type XBrowserConfig,
} from "./x-browser.js";

/**
 * X.com (Twitter) — OAuth 2.0 + PKCE integration.
 *
 * Each Connection represents one X account. The user registers an OAuth 2.0
 * client at developer.x.com (Type: "Web App, Automated App or Bot",
 * confidential client), supplies its `clientId` + `clientSecret` when
 * creating the Connection, and the standard 3-legged consent flow runs
 * against `https://twitter.com/i/oauth2/authorize`.
 *
 * Token requests use HTTP Basic Auth — X's spec for confidential clients —
 * and the refresh_token rotates on every refresh (X invalidates the old
 * one). The provider saves the new refresh token via `ctx.setConfig` so the
 * outer service layer re-encrypts and persists it.
 *
 * Scope-group bundles let users pick what each Connection can do at consent
 * time — Tweets (post/like/retweet), DMs (read/send), Follows. The
 * `offline.access` and `users.read` baseline scopes are always requested
 * because we need refresh tokens and the bot's own identity for the account
 * hint.
 *
 * Free-tier API caveats apply: writes are heavily rate-limited (~17/day for
 * tweets at the time of writing), and DM endpoints require Basic+ access.
 * We surface the underlying X error verbatim when this bites — there's
 * nothing useful to wrap.
 */

const X_AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const X_API = "https://api.twitter.com/2";

/** Always-included baseline scopes. `offline.access` unlocks refresh
 * tokens; `users.read` is required to call /users/me for the account hint. */
const X_OAUTH_BASELINE_SCOPES = ["offline.access", "users.read"];

/**
 * User-pickable scope bundles. Keys are stable and persisted on the
 * connection so reconnect can prefill the same checkboxes. Adding a new
 * bundle is a single entry here; the UI picks it up automatically.
 */
export const X_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "tweets",
    label: "Tweets",
    description:
      "Read tweets, search recent posts, post new tweets, like, retweet, and reply.",
    scopes: ["tweets.read", "tweets.write", "like.write", "like.read"],
  },
  {
    key: "dms",
    label: "Direct Messages",
    description: "Read DM events and send direct messages.",
    scopes: ["dm.read", "dm.write"],
  },
  {
    key: "follows",
    label: "Follows",
    description: "View and manage who the account follows.",
    scopes: ["follows.read", "follows.write"],
  },
  {
    key: "bookmarks",
    label: "Bookmarks",
    description: "Read and manage the account's bookmarks.",
    scopes: ["bookmark.read", "bookmark.write"],
  },
];

/**
 * Resolve a list of scope-group keys → flat scope list. Unknown keys are
 * silently dropped for forward-compat.
 */
export function resolveXScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(X_SCOPE_GROUPS.map((g) => [g.key, g] as const));
  for (const key of args.scopeGroups) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

// ---------- Config shape ----------

export type XOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  /** Authenticated user's id and handle. Captured at connect time. */
  userId: string;
  username: string;
  name?: string;
  /** Scope-group keys the user picked, persisted for reconnect prefill. */
  scopeGroups?: string[];
};

// ---------- OAuth helpers (used by services/oauth.ts) ----------

import { config as appConfig } from "../../../config.js";

export function xRedirectUri(): string {
  const base = appConfig.publicUrl.replace(/\/+$/, "");
  return `${base}/api/integrations/oauth/callback/x`;
}

/**
 * Generate a high-entropy PKCE code_verifier. RFC 7636 allows 43–128 chars
 * from `[A-Z][a-z][0-9]-._~`. base64url of 32 random bytes lands at 43
 * chars and uses the legal alphabet.
 */
export function generatePkceVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

export function pkceChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

export function buildXAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL(X_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("scope", args.scopes.join(" "));
  u.searchParams.set("state", args.state);
  u.searchParams.set("code_challenge", args.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeXCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ tokens: OauthTokenSet; userInfo: Record<string, unknown> }> {
  const body = new URLSearchParams({
    code: args.code,
    grant_type: "authorization_code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  const tokRes = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(args.clientId, args.clientSecret),
    },
    body,
  });
  const parsed = (await safeJson(tokRes)) as Record<string, unknown> | null;
  if (!tokRes.ok || !parsed) {
    throw new Error(xErrorMessage(parsed, `Token exchange failed: ${tokRes.status}`));
  }
  const access = strField(parsed, "access_token");
  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 7200;
  const scope = typeof parsed.scope === "string" ? parsed.scope : "";

  // Hit /users/me for the account hint. We always have users.read.
  const meRes = await fetch(`${X_API}/users/me?user.fields=id,username,name`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const meParsed = (await safeJson(meRes)) as { data?: Record<string, unknown> } | null;
  const me = (meParsed?.data ?? {}) as Record<string, unknown>;

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
      tokenType: "Bearer",
    },
    userInfo: me,
  };
}

// ---------- Tool list ----------

const X_TOOLS = [
  {
    name: "get_me",
    description:
      "Return the authenticated X user (id, username, name) this connection is signed in as.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_user_by_username",
    description: "Look up an X user by their handle (without the leading @).",
    inputSchema: {
      type: "object" as const,
      properties: {
        username: { type: "string", description: "Handle without @, e.g. 'jack'." },
      },
      required: ["username"],
      additionalProperties: false,
    },
  },
  {
    name: "get_user_tweets",
    description:
      "List a user's recent tweets, most recent first. Pass `userId` (use get_user_by_username first if you only have a handle).",
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
        max_results: {
          type: "integer",
          minimum: 5,
          maximum: 100,
          description: "Max tweets to return (5-100, default 10).",
        },
        pagination_token: { type: "string" },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_recent",
    description:
      "Search tweets posted in the last 7 days. `query` follows X's search operators (e.g. 'from:username -is:retweet lang:en').",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 10, maximum: 100 },
        next_token: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_tweet",
    description: "Fetch one tweet by its id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_home_timeline",
    description:
      "Reverse-chronological home timeline of the authenticated user (the 'For you' feed analogue, minus algorithmic ranking).",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_results: { type: "integer", minimum: 5, maximum: 100 },
        pagination_token: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "post_tweet",
    description:
      "Post a new tweet. Optional `replyToTweetId` posts as a reply; `quoteTweetId` quote-tweets it. `text` is required and capped at 280 chars on free tier.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string" },
        replyToTweetId: { type: "string" },
        quoteTweetId: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_tweet",
    description: "Delete one of the authenticated user's own tweets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "like_tweet",
    description: "Like a tweet on behalf of the authenticated user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "unlike_tweet",
    description: "Remove a like from a tweet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "retweet",
    description: "Retweet a tweet on behalf of the authenticated user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "unretweet",
    description: "Undo a retweet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tweetId: { type: "string" },
      },
      required: ["tweetId"],
      additionalProperties: false,
    },
  },
  {
    name: "follow_user",
    description: "Follow a user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    name: "unfollow_user",
    description: "Unfollow a user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dm_conversations",
    description:
      "List the authenticated user's recent DM conversations (1:1 + group). Each row is a conversation, not the messages inside it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_results: { type: "integer", minimum: 1, maximum: 100 },
        pagination_token: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_dm_events",
    description:
      "List DM events. Pass `conversationId` for a specific thread; otherwise returns all DM events the authed user can see.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversationId: {
          type: "string",
          description: "Conversation id from list_dm_conversations.",
        },
        max_results: { type: "integer", minimum: 1, maximum: 100 },
        pagination_token: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_dm",
    description:
      "Send a direct message. Pass `userId` to start (or continue) a 1:1 with that user, or `conversationId` to post into an existing conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string" },
        userId: { type: "string", description: "Recipient user id (1:1 DM)." },
        conversationId: {
          type: "string",
          description: "Existing conversation id (group or 1:1).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

// ---------- Provider ----------

export const xProvider: IntegrationProvider = {
  catalog: {
    provider: "x",
    name: "X (Twitter)",
    category: "Communication",
    tagline: "Tweets, replies, likes, retweets, follows, DMs.",
    description:
      "Connect an X account so AI employees can read tweets, search recent posts, publish on the account's behalf, like and retweet, manage follows, and read or send direct messages. Each Connection brings its own OAuth 2.0 client (developer.x.com → Projects & Apps → User authentication settings → enable OAuth 2.0, type Confidential client). Free-tier writes are heavily rate-limited; DM endpoints require Basic or higher access.",
    icon: "Twitter",
    authMode: "oauth2",
    oauth: {
      app: "x",
      scopes: X_OAUTH_BASELINE_SCOPES,
      scopeGroups: X_SCOPE_GROUPS,
      setupDocs:
        "https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code",
    },
    browserLogin: {
      description:
        "Skip the X dev project entirely. We store the username + password encrypted at rest and drive a headless browser for posts, likes, retweets, replies, and follows. Heavier than OAuth and best-effort against X's anti-automation defences — accounts with 2FA aren't supported, and X may ask for an unusual-activity verification on first login (provide a Verification value below if so).",
      fields: [
        {
          key: "username",
          label: "Username (handle)",
          type: "text",
          placeholder: "yourhandle",
          required: true,
          hint: "Without the leading @. Same value you type into x.com/login.",
        },
        {
          key: "password",
          label: "Password",
          type: "password",
          required: true,
          hint: "Encrypted at rest with the app's session secret.",
        },
        {
          key: "verification",
          label: "Verification email or phone (optional)",
          type: "text",
          required: false,
          placeholder: "you@example.com",
          hint: "Used only when X shows the \"unusual activity\" prompt the first time we log in. Skip if you've never seen that prompt for this account.",
        },
      ],
    },
    enabled: true,
  },

  tools: X_TOOLS,

  async buildBrowserLoginConfig(input) {
    const username = (input.username ?? "").trim().replace(/^@/, "");
    const password = input.password ?? "";
    const verification = (input.verification ?? "").trim();
    if (!username) throw new Error("Username is required");
    if (!password) throw new Error("Password is required");
    const cfg: XBrowserConfig = {
      username,
      password,
      verification: verification || undefined,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: `@${username}`,
    };
  },

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    if (!tokens.refreshToken) {
      throw new Error(
        "X did not return a refresh token. Make sure 'offline.access' is among the requested scopes and that the OAuth 2.0 client is set up as Confidential.",
      );
    }
    const userId = typeof userInfo.id === "string" ? userInfo.id : "";
    const username = typeof userInfo.username === "string" ? userInfo.username : "";
    const name = typeof userInfo.name === "string" ? userInfo.name : undefined;
    if (!userId || !username) {
      throw new Error(
        "X did not return user identity on /users/me — token may be missing users.read scope.",
      );
    }
    const cfg: XOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      userId,
      username,
      name,
      scopeGroups,
    };
    const hint = name ? `@${username} · ${name}` : `@${username}`;
    return { config: cfg as unknown as IntegrationConfig, accountHint: hint };
  },

  async checkStatus(ctx) {
    if (ctx.authMode === "browser") {
      // For browser-mode we don't fire a real login on every status check —
      // that would burn 30+s and trip X's "too many login attempts" gate.
      // We only verify that credentials are present.
      const cfg = ctx.config as XBrowserConfig;
      if (!cfg.username || !cfg.password) {
        return { ok: false, message: "Missing username or password" };
      }
      return { ok: true };
    }
    try {
      await ensureFreshToken(ctx);
      const cfg = ctx.config as XOauthConfig;
      const res = await xFetch(cfg.accessToken, "/users/me");
      if (!res || typeof res !== "object") {
        return { ok: false, message: "Unexpected response from /users/me" };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    if (ctx.authMode === "browser") {
      return invokeXBrowserTool(name, a, ctx);
    }
    await ensureFreshToken(ctx);
    const cfg = ctx.config as XOauthConfig;
    switch (name) {
      case "get_me":
        return xFetch(cfg.accessToken, "/users/me", {
          query: { "user.fields": "id,username,name,description,verified,created_at" },
        });

      case "get_user_by_username": {
        const username = requireString(a.username, "username").replace(/^@/, "");
        return xFetch(
          cfg.accessToken,
          `/users/by/username/${encodeURIComponent(username)}`,
          {
            query: { "user.fields": "id,username,name,description,verified,public_metrics" },
          },
        );
      }

      case "get_user_tweets": {
        const userId = requireString(a.userId, "userId");
        return xFetch(cfg.accessToken, `/users/${encodeURIComponent(userId)}/tweets`, {
          query: {
            max_results: clampInt(a.max_results, 5, 100, 10),
            "tweet.fields": "id,text,created_at,author_id,public_metrics,referenced_tweets",
            pagination_token: strOrUndef(a.pagination_token),
          },
        });
      }

      case "search_recent": {
        const query = requireString(a.query, "query");
        return xFetch(cfg.accessToken, "/tweets/search/recent", {
          query: {
            query,
            max_results: clampInt(a.max_results, 10, 100, 25),
            "tweet.fields": "id,text,created_at,author_id,public_metrics",
            next_token: strOrUndef(a.next_token),
          },
        });
      }

      case "get_tweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(cfg.accessToken, `/tweets/${encodeURIComponent(tweetId)}`, {
          query: {
            "tweet.fields": "id,text,created_at,author_id,public_metrics,referenced_tweets",
            expansions: "author_id",
            "user.fields": "id,username,name",
          },
        });
      }

      case "get_home_timeline": {
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/timelines/reverse_chronological`,
          {
            query: {
              max_results: clampInt(a.max_results, 5, 100, 25),
              "tweet.fields": "id,text,created_at,author_id,public_metrics",
              pagination_token: strOrUndef(a.pagination_token),
            },
          },
        );
      }

      case "post_tweet": {
        const text = requireString(a.text, "text");
        const body: Record<string, unknown> = { text };
        if (typeof a.replyToTweetId === "string" && a.replyToTweetId.trim()) {
          body.reply = { in_reply_to_tweet_id: a.replyToTweetId.trim() };
        }
        if (typeof a.quoteTweetId === "string" && a.quoteTweetId.trim()) {
          body.quote_tweet_id = a.quoteTweetId.trim();
        }
        return xFetch(cfg.accessToken, "/tweets", { method: "POST", body });
      }

      case "delete_tweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(cfg.accessToken, `/tweets/${encodeURIComponent(tweetId)}`, {
          method: "DELETE",
        });
      }

      case "like_tweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/likes`,
          { method: "POST", body: { tweet_id: tweetId } },
        );
      }

      case "unlike_tweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/likes/${encodeURIComponent(tweetId)}`,
          { method: "DELETE" },
        );
      }

      case "retweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/retweets`,
          { method: "POST", body: { tweet_id: tweetId } },
        );
      }

      case "unretweet": {
        const tweetId = requireString(a.tweetId, "tweetId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/retweets/${encodeURIComponent(tweetId)}`,
          { method: "DELETE" },
        );
      }

      case "follow_user": {
        const targetId = requireString(a.userId, "userId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/following`,
          { method: "POST", body: { target_user_id: targetId } },
        );
      }

      case "unfollow_user": {
        const targetId = requireString(a.userId, "userId");
        return xFetch(
          cfg.accessToken,
          `/users/${encodeURIComponent(cfg.userId)}/following/${encodeURIComponent(targetId)}`,
          { method: "DELETE" },
        );
      }

      case "list_dm_conversations": {
        return xFetch(cfg.accessToken, "/dm_conversations", {
          query: {
            max_results: clampInt(a.max_results, 1, 100, 25),
            pagination_token: strOrUndef(a.pagination_token),
          },
        });
      }

      case "list_dm_events": {
        const path =
          typeof a.conversationId === "string" && a.conversationId.trim()
            ? `/dm_conversations/${encodeURIComponent(a.conversationId.trim())}/dm_events`
            : "/dm_events";
        return xFetch(cfg.accessToken, path, {
          query: {
            max_results: clampInt(a.max_results, 1, 100, 25),
            "dm_event.fields": "id,text,created_at,sender_id,dm_conversation_id",
            pagination_token: strOrUndef(a.pagination_token),
          },
        });
      }

      case "send_dm": {
        const text = requireString(a.text, "text");
        const userId = strOrUndef(a.userId);
        const conversationId = strOrUndef(a.conversationId);
        if (!userId && !conversationId) {
          throw new Error("Pass `userId` or `conversationId` to send_dm");
        }
        const path = conversationId
          ? `/dm_conversations/${encodeURIComponent(conversationId)}/messages`
          : `/dm_conversations/with/${encodeURIComponent(userId!)}/messages`;
        return xFetch(cfg.accessToken, path, {
          method: "POST",
          body: { text },
        });
      }

      default:
        throw new Error(`Unknown X tool: ${name}`);
    }
  },
};

// ---------- Browser-mode dispatch ----------
//
// Browser-mode connections drive the x.com UI through a headless Chromium
// instead of hitting the v2 API. We support the high-value subset of the
// OAuth tool list — post, reply, like / unlike, retweet, delete, follow /
// unfollow. The read-only and DM tools fall through with a clear error
// because the UI doesn't expose them in a stable shape.

async function invokeXBrowserTool(
  name: string,
  a: Record<string, unknown>,
  ctx: IntegrationRuntimeContext,
): Promise<unknown> {
  const cfg = ctx.config as XBrowserConfig;
  if (!cfg.username || !cfg.password) {
    throw new Error(
      "Browser-login connection is missing credentials — reconnect from Settings → Integrations.",
    );
  }
  switch (name) {
    case "get_me":
      return { id: "", username: cfg.username, name: cfg.displayName ?? "" };

    case "post_tweet": {
      const text = requireString(a.text, "text");
      const replyToTweetId = strOrUndef(a.replyToTweetId);
      return runWithXBrowser({
        cfg,
        ctx,
        action: (page) => postTweetViaBrowser(page, { text, replyToTweetId }),
      });
    }

    case "delete_tweet": {
      const tweetId = requireString(a.tweetId, "tweetId");
      return runWithXBrowser({
        cfg,
        ctx,
        action: (page) => deleteTweetViaBrowser(page, { tweetId }),
      });
    }

    case "like_tweet": {
      const tweetId = requireString(a.tweetId, "tweetId");
      return runWithXBrowser({
        cfg,
        ctx,
        action: (page) => likeTweetViaBrowser(page, { tweetId }),
      });
    }

    case "unlike_tweet": {
      const tweetId = requireString(a.tweetId, "tweetId");
      return runWithXBrowser({
        cfg,
        ctx,
        action: (page) => unlikeTweetViaBrowser(page, { tweetId }),
      });
    }

    case "retweet": {
      const tweetId = requireString(a.tweetId, "tweetId");
      return runWithXBrowser({
        cfg,
        ctx,
        action: (page) => retweetViaBrowser(page, { tweetId }),
      });
    }

    case "follow_user": {
      // Browser mode follows by handle (the route is /<handle>); the OAuth
      // tool takes a user id. We accept either: if `userId` was passed and
      // looks numeric, fall back to a clear error rather than guessing.
      const handle = strOrUndef(a.handle) ?? strOrUndef(a.username);
      if (handle) {
        return runWithXBrowser({
          cfg,
          ctx,
          action: (page) => followUserViaBrowser(page, { handle }),
        });
      }
      throw new Error(
        "Browser-login follow_user needs `handle` (the @username), not a numeric userId.",
      );
    }

    case "unfollow_user": {
      const handle = strOrUndef(a.handle) ?? strOrUndef(a.username);
      if (handle) {
        return runWithXBrowser({
          cfg,
          ctx,
          action: (page) => unfollowUserViaBrowser(page, { handle }),
        });
      }
      throw new Error(
        "Browser-login unfollow_user needs `handle` (the @username), not a numeric userId.",
      );
    }

    default:
      throw new Error(
        `Tool "${name}" is not available on browser-login X connections. Use an OAuth connection for read-only and DM tools.`,
      );
  }
}

// ---------- Token lifecycle ----------

async function ensureFreshToken(ctx: IntegrationRuntimeContext): Promise<void> {
  if (ctx.authMode !== "oauth2") {
    throw new Error(`X connector does not support authMode "${ctx.authMode}"`);
  }
  const cfg = ctx.config as XOauthConfig;
  if (cfg.expiresAt > Date.now() + 60_000) return;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
  });
  const res = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(xErrorMessage(parsed, `X token refresh failed: ${res.status}`));
  }
  const access = strField(parsed, "access_token");
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : cfg.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 7200;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  const next: XOauthConfig = {
    ...cfg,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

// ---------- HTTP helper ----------

type FetchInit = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function xFetch(
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
  const url = `${X_API}${path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new Error(
      xErrorMessage(
        parsed as Record<string, unknown> | null,
        `X ${res.status} ${res.statusText}`,
      ),
    );
  }
  return parsed;
}

// ---------- low-level helpers ----------

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`X response is missing "${key}".`);
  }
  return v;
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

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function xErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  // X v2 errors: { errors: [{ message, ... }] } OR { detail, title } OR
  // { error, error_description } for OAuth/token endpoints.
  const errors = (parsed as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown; detail?: unknown };
    if (typeof first.message === "string" && first.message) return first.message;
    if (typeof first.detail === "string" && first.detail) return first.detail;
  }
  const detail = (parsed as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail) return detail;
  const desc = (parsed as { error_description?: unknown }).error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err) return err;
  return fallback;
}
