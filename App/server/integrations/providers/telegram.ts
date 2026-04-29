import type { IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Telegram — an unusual integration in this codebase. Most providers expose
 * tools the AI calls *outbound* (Stripe, Notion, …); Telegram does that too,
 * but its primary purpose is the reverse: human teammates DM a Telegram bot
 * and the AI employee replies. The inbound side is driven by
 * `services/telegramListener.ts`, which long-polls Telegram for each
 * Connection, maps each chat to a {@link Conversation} row, and routes the
 * message through the existing `chatWithEmployee` seam.
 *
 * Auth is a single bot token created via @BotFather on Telegram. We hit
 * `/getMe` on save to validate the token and capture the bot's
 * username/display name for the account hint. No OAuth, no scopes.
 *
 * Routing — which AI employee owns a bot? **The first
 * `EmployeeConnectionGrant` on the Connection wins.** If you grant the
 * connection to multiple employees, the listener still picks the
 * earliest-created grant; the others can only call the outbound tools
 * (`send_message`, …) but won't auto-respond on incoming chats.
 */

const TELEGRAM_API = "https://api.telegram.org";

type TelegramConfig = {
  botToken: string;
  botId?: number;
  botUsername?: string;
  botName?: string;
};

type ApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

export async function telegramFetch<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${TELEGRAM_API}/bot${botToken}/${method}`;
  const init: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "GET" };
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: ApiResponse<T> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as ApiResponse<T>) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok || !parsed || !parsed.ok) {
    const desc =
      parsed?.description ?? `Telegram ${res.status} ${res.statusText}`;
    throw new Error(desc);
  }
  return parsed.result as T;
}

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function chatIdString(v: unknown): string | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) return v.trim();
  throw new Error("chatId is required (number or @channel_username)");
}

export const telegramProvider: IntegrationProvider = {
  catalog: {
    provider: "telegram",
    name: "Telegram",
    category: "Communication",
    tagline: "Chat with AI employees on Telegram.",
    description:
      "Connect a Telegram bot so human teammates can DM your AI employees from anywhere. Create a bot via @BotFather on Telegram, paste its token here, then grant the connection to one AI employee — they'll respond on every incoming chat. The same bot exposes outbound tools (send_message, …) so any granted employee can push proactive updates to known chats.",
    icon: "Send",
    authMode: "apikey",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        type: "password",
        placeholder: "123456:ABC-DEF…",
        required: true,
        hint: "Created with @BotFather on Telegram (use /newbot or /token).",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "get_me",
      description:
        "Return the bot's identity — id, username, display name. Useful as a sanity check.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "send_message",
      description:
        "Send a text message to a Telegram chat the bot can reach. `chatId` is the numeric chat id from an incoming message, or `@channel_username` for public channels the bot is an admin of.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: {
            type: ["string", "number"],
            description:
              "Numeric chat id (e.g. 123456789) or `@channel_username`.",
          },
          text: {
            type: "string",
            description: "Message body. Up to 4096 characters.",
          },
          parse_mode: {
            type: "string",
            enum: ["MarkdownV2", "HTML", "Markdown"],
            description: "Optional formatting mode for the message.",
          },
          reply_to_message_id: {
            type: "integer",
            description:
              "If set, the message is sent as a reply to this message id.",
          },
          disable_notification: { type: "boolean" },
        },
        required: ["chatId", "text"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const botToken = (input.botToken ?? "").trim();
    if (!botToken) throw new Error("Bot token is required");
    const me = await telegramFetch<TelegramUser>(botToken, "getMe");
    if (!me?.id || !me.is_bot) {
      throw new Error("Telegram returned no bot user — token may be invalid.");
    }
    const display = me.first_name ?? me.username ?? `bot ${me.id}`;
    const handle = me.username ? `@${me.username}` : null;
    const config: TelegramConfig = {
      botToken,
      botId: me.id,
      botUsername: me.username,
      botName: display,
    };
    const accountHint = handle
      ? `${display} · ${handle} · ${maskSecret(botToken)}`
      : `${display} · ${maskSecret(botToken)}`;
    return { config, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as TelegramConfig;
    try {
      await telegramFetch(cfg.botToken, "getMe");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as TelegramConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_me":
        return telegramFetch(cfg.botToken, "getMe");

      case "send_message": {
        const chatId = chatIdString(a.chatId);
        const text = requireString(a.text, "text");
        const body: Record<string, unknown> = { chat_id: chatId, text };
        if (typeof a.parse_mode === "string") body.parse_mode = a.parse_mode;
        if (typeof a.reply_to_message_id === "number") {
          body.reply_to_message_id = a.reply_to_message_id;
        }
        if (typeof a.disable_notification === "boolean") {
          body.disable_notification = a.disable_notification;
        }
        return telegramFetch(cfg.botToken, "sendMessage", body);
      }

      default:
        throw new Error(`Unknown Telegram tool: ${name}`);
    }
  },
};
