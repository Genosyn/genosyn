import { ConnectionAuthError, type IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Slack — like Telegram, an integration whose primary direction is *inbound*.
 * The outbound tools below are real and useful, but the reason a company
 * connects Slack is so a human can ask an AI Employee something in the channel
 * they are already sitting in. That half lives in
 * `services/chatSurfaces/slack.ts`; this module owns the credential, the
 * catalog entry, and the Web API calls both halves make.
 *
 * Three secrets, because Slack has three and they do different jobs:
 *
 *  - **Bot token** (`xoxb-…`) is the only required one. Everything Genosyn
 *    *says* to Slack goes out under it.
 *  - **App-level token** (`xapp-…`) buys Socket Mode: Genosyn dials Slack
 *    over an outbound WebSocket, so a self-hosted install behind NAT needs no
 *    public URL. This is the path we want people on.
 *  - **Signing secret** is the alternative — the operator points Slack's
 *    Events API at a public HTTPS URL, and the signature is then the only
 *    proof a delivery came from Slack.
 *
 * A Connection with neither of the last two still works; it just never hears
 * anything. That is a legitimate outbound-only setup, so it validates.
 *
 * `botUserId` is captured at connect time and stored in the config because
 * the inbound path cannot work without it: a bot that answers its own
 * messages talks to itself until someone notices.
 */

const SLACK_API = "https://slack.com/api";

export type SlackConfig = {
  botToken: string;
  /** `xapp-…`. Present only when the operator chose Socket Mode. */
  appToken?: string;
  /** Present only when the operator chose the public Events API URL. */
  signingSecret?: string;
  /** The bot's own user id — how the inbound path recognises its own voice. */
  botUserId?: string;
  botId?: string;
  teamId?: string;
  teamName?: string;
  teamUrl?: string;
};

type SlackEnvelope = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

type SlackAuthTest = {
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
};

/**
 * Slack's own error codes, translated once. The code stays in the sentence:
 * it is what an operator will paste into Slack's docs, and what an AI Employee
 * will otherwise invent an explanation for.
 */
const ERROR_SENTENCES: Record<string, string> = {
  invalid_auth: "Slack rejected the token. Re-copy the bot token from OAuth & Permissions.",
  not_authed: "No token reached Slack — the Connection has no bot token stored.",
  account_inactive:
    "The workspace disabled this app's bot user. Re-install the app to the Slack workspace.",
  token_revoked: "The token was revoked in Slack. Install the app again and paste the new one.",
  token_expired: "The token expired. Token rotation is on for this app, so reconnect it.",
  missing_scope:
    "The bot token is missing a scope this call needs. Add it under OAuth & Permissions, then re-install the app.",
  not_in_channel:
    "The bot is not a member of that channel. Invite it there with /invite, then try again.",
  channel_not_found: "Slack does not recognise that channel id.",
  is_archived: "That Slack channel is archived.",
  msg_too_long: "Slack refused the message for being too long.",
  message_not_found: "Slack has no message with that ts in that channel.",
  cant_update_message: "Slack will not let this app edit that message.",
  invalid_name: "Slack has no emoji with that name.",
  already_reacted: "That reaction is already on the message.",
  ratelimited: "Slack is rate-limiting this workspace. Try again in a moment.",
};

/**
 * Codes that mean the *Connection* is dead rather than this one call being
 * wrong — the difference between a red pill in Settings → Integrations and a
 * tool that failed once.
 */
const DEAD_CREDENTIAL_ERRORS: Record<string, "error" | "expired"> = {
  invalid_auth: "error",
  account_inactive: "error",
  token_revoked: "error",
  token_expired: "expired",
};

/** One sentence per Slack failure, always carrying Slack's own code. */
export function slackErrorSentence(method: string, code: string): string {
  const known = ERROR_SENTENCES[code];
  return known ? `Slack ${method} failed (${code}). ${known}` : `Slack ${method} failed (${code}).`;
}

export function slackApiError(method: string, code: string): Error {
  const message = slackErrorSentence(method, code);
  const dead = DEAD_CREDENTIAL_ERRORS[code];
  if (dead) return new ConnectionAuthError(message, dead);
  return new Error(message);
}

/**
 * One Slack Web API call. Slack answers `200 {ok:false,error:"…"}` far more
 * often than it answers a non-2xx status, so the HTTP status is the
 * least interesting part of a failure and `error` is the whole story.
 */
export async function slackFetch<T = SlackEnvelope>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed: SlackEnvelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as SlackEnvelope) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    // A rate limit or an edge failure comes back as HTML or nothing at all.
    throw new Error(`Slack ${method} failed: ${res.status} ${res.statusText}.`);
  }
  if (!parsed.ok) {
    const code =
      typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : "unknown_error";
    throw slackApiError(method, code);
  }
  return parsed as unknown as T;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

/** Slack wants the bare emoji name; models keep sending `:tada:`. */
function emojiName(v: unknown): string {
  return requireString(v, "name").replace(/^:+|:+$/g, "");
}

function clampLimit(v: unknown, fallback: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(v)));
}

export const slackProvider: IntegrationProvider = {
  catalog: {
    provider: "slack",
    name: "Slack",
    category: "Communication",
    tagline: "Talk to your AI Employees in Slack.",
    description:
      "Connect a Slack app so people can reach an AI Employee from the channel they are already in — DM it, or @-mention it in a thread and the answer lands in that thread. Paste the bot token, add an app-level token and Genosyn opens a Socket Mode connection that needs no public URL. Granted employees also get outbound tools (post, edit, react, list channels) so they can push updates without being asked.",
    icon: "Slack",
    authMode: "apikey",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        type: "password",
        placeholder: "xoxb-…",
        required: true,
        hint: "xoxb-… from OAuth & Permissions",
      },
      {
        key: "appToken",
        label: "App-level token",
        type: "password",
        placeholder: "xapp-…",
        required: false,
        hint: "xapp-… App-Level Token with connections:write. With it Genosyn uses Socket Mode and needs no public URL.",
      },
      {
        key: "signingSecret",
        label: "Signing secret",
        type: "password",
        required: false,
        hint: "Only needed if you point Slack's Events API at a public URL instead of using Socket Mode.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "send_message",
      description:
        "Post a message into a Slack channel, private group, or DM. `channel` is a channel id (C…, G…, or D…) or `#channel-name`; the bot must already be a member of a private channel. Set `thread_ts` to answer inside an existing thread instead of posting to the channel. `text` is Slack mrkdwn, not markdown: *bold*, _italic_, `code`, and <https://example.com|labelled links>.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel id (C…, G…, D…) or `#channel-name`.",
          },
          text: { type: "string", description: "Message body in Slack mrkdwn." },
          thread_ts: {
            type: "string",
            description:
              "Timestamp id of the thread parent. Set it to reply in a thread; omit it to post to the channel.",
          },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "update_message",
      description:
        "Rewrite a message this app already posted — use it to correct a number or mark a running status complete instead of posting a second message. `ts` is the timestamp id Slack returned when the message was sent.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel the message is in." },
          ts: { type: "string", description: "Timestamp id of the message to edit." },
          text: { type: "string", description: "Replacement body in Slack mrkdwn." },
        },
        required: ["channel", "ts", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "add_reaction",
      description:
        "Add an emoji reaction to a message — the quiet way to acknowledge something without adding a message to the channel. `name` is the emoji name without colons, e.g. `white_check_mark`.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel the message is in." },
          ts: { type: "string", description: "Timestamp id of the message to react to." },
          name: { type: "string", description: "Emoji name without colons, e.g. `eyes`." },
        },
        required: ["channel", "ts", "name"],
        additionalProperties: false,
      },
    },
    {
      name: "list_channels",
      description:
        "List the workspace's conversations so you can find the id to post into. Returns id, name, whether the channel is private, and whether this bot is a member of it.",
      inputSchema: {
        type: "object",
        properties: {
          types: {
            type: "string",
            description:
              "Comma-separated subset of public_channel, private_channel, mpim, im. Defaults to public_channel.",
          },
          limit: {
            type: "integer",
            description: "How many to return, 1–200. Defaults to 100.",
          },
        },
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const botToken = (input.botToken ?? "").trim();
    const appToken = (input.appToken ?? "").trim();
    const signingSecret = (input.signingSecret ?? "").trim();
    if (!botToken) throw new Error("Bot token is required");
    // Three password fields on one form is three chances to paste the wrong
    // secret, and only the bot token fails loudly. A swapped app token
    // otherwise surfaces hours later as a socket that never opens.
    if (botToken.startsWith("xapp-")) {
      throw new Error(
        "That is an app-level token. The bot token starts with `xoxb-` and lives under OAuth & Permissions.",
      );
    }
    if (appToken && !appToken.startsWith("xapp-")) {
      throw new Error(
        "An app-level token starts with `xapp-`. Create one under Basic Information → App-Level Tokens with the connections:write scope.",
      );
    }

    const auth = await slackFetch<SlackAuthTest>("auth.test", botToken);
    const botUserId = typeof auth.user_id === "string" ? auth.user_id.trim() : "";
    if (!botUserId) {
      throw new Error(
        "Slack accepted the token but named no bot user. Use a bot token (`xoxb-…`) rather than a user token.",
      );
    }

    const config: SlackConfig = {
      botToken,
      ...(appToken ? { appToken } : {}),
      ...(signingSecret ? { signingSecret } : {}),
      botUserId,
      ...(auth.bot_id ? { botId: auth.bot_id } : {}),
      ...(auth.team_id ? { teamId: auth.team_id } : {}),
      ...(auth.team ? { teamName: auth.team } : {}),
      ...(auth.url ? { teamUrl: auth.url } : {}),
    };
    const accountHint = [auth.team, auth.user ? `@${auth.user}` : null, maskSecret(botToken)]
      .filter(Boolean)
      .join(" · ");
    return { config, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as SlackConfig;
    try {
      await slackFetch("auth.test", cfg.botToken);
      return { ok: true };
    } catch (err) {
      if (err instanceof ConnectionAuthError) {
        return { ok: false, message: err.message, status: err.connectionStatus };
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as SlackConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "send_message": {
        const body: Record<string, unknown> = {
          channel: requireString(a.channel, "channel"),
          text: requireString(a.text, "text"),
        };
        if (typeof a.thread_ts === "string" && a.thread_ts.trim()) {
          body.thread_ts = a.thread_ts.trim();
        }
        return slackFetch("chat.postMessage", cfg.botToken, body);
      }

      case "update_message":
        return slackFetch("chat.update", cfg.botToken, {
          channel: requireString(a.channel, "channel"),
          ts: requireString(a.ts, "ts"),
          text: requireString(a.text, "text"),
        });

      case "add_reaction":
        return slackFetch("reactions.add", cfg.botToken, {
          channel: requireString(a.channel, "channel"),
          timestamp: requireString(a.ts, "ts"),
          name: emojiName(a.name),
        });

      case "list_channels":
        return slackFetch("conversations.list", cfg.botToken, {
          types:
            typeof a.types === "string" && a.types.trim() ? a.types.trim() : "public_channel",
          limit: clampLimit(a.limit, 100, 200),
          exclude_archived: true,
        });

      default:
        throw new Error(`Unknown Slack tool: ${name}`);
    }
  },
};
