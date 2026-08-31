import { z } from "zod";

import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { telegramFetch } from "../../integrations/providers/telegram.js";
import type { ChatSurfaceAdapter, InboundChatTurn } from "./types.js";

/**
 * Telegram as a {@link ChatSurfaceAdapter}.
 *
 * Telegram is the surface every other one was generalized from, so this file
 * is also the proof that the seam is real. The shipped listener was ~370
 * lines; almost none of it was about Telegram. Grant routing, Conversation
 * mapping, the replay window, truncation, lease ownership, error backoff and
 * connection discovery all belonged to *any* chat surface and now live in
 * `inbound.ts` and `workers.ts`. What is left here is translation, and
 * translation is all an adapter is allowed to be.
 *
 * Long polling rather than a webhook: a webhook needs a publicly reachable
 * HTTPS URL and most self-hosted Genosyn installs do not have one. One sticky
 * outbound connection per bot works from a laptop behind NAT, which is why
 * `requiresPublicUrl` is false here and true for Microsoft Teams.
 *
 * Nothing above `types.js` is imported from inside the chat-surface core, and
 * that is a rule rather than a preference. `adapters.ts` builds its registry
 * at module-evaluation time out of the four adapter constants, and both
 * `inbound.ts` and `workers.ts` import that registry — so a static edge from
 * here into either of them makes the pair a cycle, and whichever module is
 * loaded first reads `telegramChatSurface` in its temporal dead zone
 * (`ReferenceError: Cannot access 'telegramChatSurface' before
 * initialization`, at import time, from this file's own test). What this file
 * needs from the core it either keeps a local copy of, like the logger below,
 * or resolves at call time, like the two `import()`s in `run()`. Slack's
 * adapter carries the same note for the same reason.
 */

/** How long Telegram holds `getUpdates` open before answering with nothing. */
const POLL_TIMEOUT_SECONDS = 30;
/** Backoff after a transport error — a revoked token must not become a spin. */
const ERROR_BACKOFF_MS = 5_000;
/** `sendMessage` hard-caps at 4096; the rest is room for the truncation notice. */
const TELEGRAM_TEXT_LIMIT = 4000;

/** A local copy of `logSurfaceError`, kept local for the reason above. */
function logTelegramError(connectionId: string | undefined, label: string, err: unknown): void {
  const tag = connectionId ? `[telegram ${connectionId}]` : "[telegram]";
  // eslint-disable-next-line no-console
  console.error(`${tag} ${label}:`, err instanceof Error ? err.message : err);
}

/** The decrypted shape `telegramProvider.validateApiKey` writes. */
type TelegramConfig = {
  botToken?: unknown;
  botId?: unknown;
  botUsername?: unknown;
  botName?: unknown;
};

/** What the group gate needs to recognise itself in a conversation. */
export type TelegramBotIdentity = {
  /** Numeric bot id, when the Connection captured one. */
  id: number | null;
  /** The bot's handle without the leading `@`. */
  username: string | null;
};

const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  username: z.string().nullish(),
});

const telegramChatSchema = z.object({
  id: z.number().int(),
  // Required on purpose. Without it we cannot tell a DM from a channel, and
  // guessing wrong in the permissive direction is the flood this file exists
  // to stop.
  type: z.string(),
  title: z.string().nullish(),
  username: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: telegramUserSchema.nullish(),
  chat: telegramChatSchema,
  text: z.string().nullish(),
  caption: z.string().nullish(),
  // Only the author matters: it is how a reply to one of our own messages is
  // recognised as continuing a conversation with us.
  reply_to_message: z.object({ from: telegramUserSchema.nullish() }).nullish(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z.unknown(),
});

type TelegramUser = z.infer<typeof telegramUserSchema>;

/**
 * Read a `getUpdates` batch one entry at a time.
 *
 * Strictness over the whole array would be a trap. An entry we refuse to parse
 * is an entry whose `update_id` never reaches the next `offset`, and Telegram
 * redelivers everything unconfirmed forever — one unexpected field would wedge
 * a bot in a loop. So a malformed entry is skipped and the batch carries on.
 */
export function readTelegramUpdates(payload: unknown): { updateId: number; message: unknown }[] {
  if (!Array.isArray(payload)) return [];
  const updates: { updateId: number; message: unknown }[] = [];
  for (const entry of payload) {
    const parsed = telegramUpdateSchema.safeParse(entry);
    if (!parsed.success) continue;
    updates.push({ updateId: parsed.data.update_id, message: parsed.data.message ?? null });
  }
  return updates;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the bot's own handle and nothing that merely begins with it — a bot
 * called `@fin` must not consider itself addressed by `@finley`. Telegram
 * handles are case-insensitive, so the match is too, and the lookahead covers
 * the character class Telegram allows in a handle.
 */
function mentionPattern(username: string): RegExp {
  return new RegExp(`@${escapeForRegExp(username)}(?![A-Za-z0-9_])`, "gi");
}

/** Does this text name the bot? */
export function mentionsBot(text: string, username: string | null): boolean {
  if (!username) return false;
  return mentionPattern(username).test(text);
}

/**
 * Remove the bot's handle from a message before the employee reads it.
 * `@finley what's our runway` should reach the model as the question it is,
 * not as a question with a stray address on the front. Newlines survive; runs
 * of horizontal space left behind by the removal do not.
 */
export function stripBotMention(text: string, username: string | null): string {
  if (!username) return text.trim();
  return text
    .replace(mentionPattern(username), " ")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .trim();
}

/**
 * Is this group message actually for us?
 *
 * Either it names the bot, or it continues something the bot itself said.
 * Both are the convention every other bot in a Telegram group follows, and
 * both are things a human does on purpose.
 */
export function isAddressedToBot(args: {
  text: string;
  repliedToAuthor: TelegramUser | null;
  bot: TelegramBotIdentity;
}): boolean {
  if (mentionsBot(args.text, args.bot.username)) return true;
  const author = args.repliedToAuthor;
  if (!author) return false;
  if (args.bot.id !== null && author.id === args.bot.id) return true;
  if (args.bot.username && author.username) {
    return author.username.toLowerCase() === args.bot.username.toLowerCase();
  }
  // A reply whose author we cannot identify is not evidence of anything.
  return false;
}

/**
 * Name a new Conversation after the chat it came from — the group's title, or
 * the human's name and handle. A label only: `inbound.ts` keys the
 * Conversation on `externalKey` and never on this.
 */
export function deriveTelegramChatTitle(chat: {
  title?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string | null {
  if (chat.title) return chat.title.slice(0, 80);
  const handle = chat.username ? `@${chat.username}` : null;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  if (handle && name) return `${name} (${handle})`.slice(0, 80);
  if (handle) return handle.slice(0, 80);
  if (name) return name.slice(0, 80);
  return null;
}

function deriveTelegramUserLabel(from: TelegramUser): string | null {
  const handle = from.username ? `@${from.username}` : null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (name && handle) return `${name} (${handle})`;
  return name || handle || null;
}

/**
 * One Telegram message → one {@link InboundChatTurn}, or null for anything the
 * employee should not answer.
 *
 * Pure on purpose. Every decision below is a *translation* decision — is there
 * a human, is there text, were we spoken to — and none of them is about who
 * the sender is allowed to be, which is `inbound.ts`'s job and only its job.
 */
export function normalizeTelegramMessage(args: {
  connectionId: string;
  companyId: string;
  bot: TelegramBotIdentity;
  message: unknown;
}): InboundChatTurn | null {
  const parsed = telegramMessageSchema.safeParse(args.message);
  if (!parsed.success) return null;
  const msg = parsed.data;

  const from = msg.from;
  // No sender: a service message ("X joined the group") or a channel post.
  // There is nobody to record a sighting for, and a sender is what an
  // ExternalChatIdentity binds.
  if (!from) return null;
  // Our own replies arrive back as updates, so answering a bot is two bots in
  // a loop and a model bill to match. This also drops the anonymous-admin bot
  // Telegram substitutes for hidden group admins.
  if (from.is_bot) return null;

  const raw = (msg.text ?? msg.caption ?? "").trim();
  if (!raw) return null;

  const group = msg.chat.type !== "private";
  let text = raw;
  if (group) {
    // The shipped listener answered *every* post in any group the bot was
    // added to, which makes an AI Employee unusable in a real channel: it
    // interrupts colleagues talking to each other, on every message, forever.
    // In a group the bot now answers only when it was actually addressed. A
    // DM is unchanged — there is nobody else in the room to mistake for us.
    if (
      !isAddressedToBot({
        text: raw,
        repliedToAuthor: msg.reply_to_message?.from ?? null,
        bot: args.bot,
      })
    ) {
      return null;
    }
    text = stripBotMention(raw, args.bot.username);
    // A bare `@bot` with nothing after it is someone starting to type, not a
    // question.
    if (!text) return null;
  }

  return {
    provider: "telegram",
    connectionId: args.connectionId,
    companyId: args.companyId,
    externalKey: String(msg.chat.id),
    externalUserId: String(from.id),
    externalUserLabel: deriveTelegramUserLabel(from),
    threadTitle: deriveTelegramChatTitle(msg.chat),
    text,
    group,
    externalMessageId: String(msg.message_id),
    // Replying to the message threads correctly in a group and still reads as
    // an answer in a DM, which is what the shipped listener already did.
    replyTo: { chatId: msg.chat.id, replyToMessageId: msg.message_id },
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The bot's own handle, which the group gate cannot work without: with no
 * handle to look for, every group message reads as "not addressed to me" and
 * the AI Employee goes quiet in channels.
 *
 * `validateApiKey` captures it when the Connection is saved, so the `getMe`
 * below is only for rows saved before it did — and for those, one round trip
 * per token beats an operator having to reconnect the bot to un-mute it.
 * Returning null means "ask again later" rather than "this bot has no handle".
 */
async function resolveBotIdentity(
  connectionId: string,
  botToken: string,
  cfg: TelegramConfig,
): Promise<TelegramBotIdentity | null> {
  const id = typeof cfg.botId === "number" && Number.isFinite(cfg.botId) ? cfg.botId : null;
  const username = readString(cfg.botUsername);
  if (username) return { id, username };
  try {
    const me = await telegramFetch<{ id?: number; username?: string }>(botToken, "getMe");
    return {
      id: typeof me?.id === "number" ? me.id : id,
      username: readString(me?.username) || null,
    };
  } catch (err) {
    logTelegramError(connectionId, "getMe failed", err);
    return null;
  }
}

export const telegramChatSurface: ChatSurfaceAdapter = {
  provider: "telegram",
  transport: "poll",
  requiresPublicUrl: false,
  textLimit: TELEGRAM_TEXT_LIMIT,

  async send({ config, replyTo, text }) {
    const botToken = readString((config as TelegramConfig).botToken);
    if (!botToken) throw new Error("Telegram connection has no bot token.");
    const chatId = replyTo.chatId;
    if (typeof chatId !== "number" && typeof chatId !== "string") {
      throw new Error("Telegram reply target has no chat id.");
    }
    const replyToMessageId = replyTo.replyToMessageId;
    await telegramFetch(botToken, "sendMessage", {
      chat_id: chatId,
      text,
      ...(typeof replyToMessageId === "number"
        ? {
            reply_to_message_id: replyToMessageId,
            // Someone deleting their question while the employee is thinking
            // must not swallow the answer: without this Telegram rejects the
            // whole send with "message to be replied not found".
            allow_sending_without_reply: true,
          }
        : {}),
    });
  },

  /**
   * The `getUpdates` long poll.
   *
   * Exactly one process may poll a given bot token — Telegram answers 409
   * Conflict to a second poller, and two pollers that did get through would
   * tear each other's updates away mid-conversation. That exclusivity is the
   * scheduler lease in `workers.ts`, not this function's business: by the time
   * `run` is called the lease is held, and returning gives it back.
   *
   * The Connection row is re-read and re-decrypted every pass so a rotated bot
   * token takes effect on the next poll rather than at the next restart.
   */
  async run({ connectionId, isCancelled, deliver }) {
    // Resolved here rather than imported at the top of the file. Both modules
    // sit inside the cycle described in this file's header — `workers.ts`
    // imports the adapter registry, and `services/integrations.ts` is reached
    // by everything that does — so the edges have to be call-time ones. By the
    // time `run()` is invoked every module is long since evaluated, and it is
    // invoked once per lease, so the two `import()`s cost nothing per poll.
    const [{ sleepCancellable }, { decryptConnectionConfig }] = await Promise.all([
      import("./workers.js"),
      import("../integrations.js"),
    ]);

    let offset = 0;
    let identity: TelegramBotIdentity = { id: null, username: null };
    let identityToken = "";

    for (;;) {
      if (isCancelled()) return;

      let snapshot: { companyId: string; botToken: string; config: TelegramConfig } | null = null;
      try {
        const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
          id: connectionId,
        });
        // Deleted while we held the lease. Nothing to poll and nothing to wait
        // for — `workers.ts` drops the worker when the row goes.
        if (!conn) return;
        const config = decryptConnectionConfig(conn) as TelegramConfig;
        const botToken = readString(config.botToken);
        if (botToken) snapshot = { companyId: conn.companyId, botToken, config };
      } catch (err) {
        logTelegramError(connectionId, "config load failed", err);
      }
      if (!snapshot) {
        await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
        continue;
      }

      if (identityToken !== snapshot.botToken) {
        const resolved = await resolveBotIdentity(connectionId, snapshot.botToken, snapshot.config);
        if (!resolved) {
          await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
          continue;
        }
        identity = resolved;
        identityToken = snapshot.botToken;
      }

      let payload: unknown;
      try {
        payload = await telegramFetch<unknown>(snapshot.botToken, "getUpdates", {
          timeout: POLL_TIMEOUT_SECONDS,
          offset,
          // Only plain messages. Channel posts and edits arrive on their own
          // update kinds, and re-answering an edited question reads as the
          // employee talking to itself.
          allowed_updates: ["message"],
        });
      } catch (err) {
        // 409 means another poller beat us to the token, 401 means it was
        // revoked. Both want the same thing from us: stop hammering Telegram
        // and let the operator fix it from the Integrations page.
        logTelegramError(connectionId, "getUpdates failed", err);
        await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
        continue;
      }

      for (const update of readTelegramUpdates(payload)) {
        // Advance first. A message we choose not to answer is still a message
        // we never want to see again.
        offset = Math.max(offset, update.updateId + 1);
        const turn = normalizeTelegramMessage({
          connectionId,
          companyId: snapshot.companyId,
          bot: identity,
          message: update.message,
        });
        if (turn) {
          try {
            await deliver(turn);
          } catch (err) {
            logTelegramError(connectionId, `update ${update.updateId} failed`, err);
          }
        }
        if (isCancelled()) return;
      }
    }
  },
};
