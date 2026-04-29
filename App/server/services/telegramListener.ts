import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { decryptConnectionConfig } from "./integrations.js";
import { chatWithEmployee } from "./chat.js";
import { telegramFetch } from "../integrations/providers/telegram.js";

/**
 * Inbound Telegram seam.
 *
 * For every `telegram` {@link IntegrationConnection} we run a long-polling
 * loop that pulls updates from Telegram, maps each chat to a
 * {@link Conversation}, and routes the message through `chatWithEmployee`
 * so the responder AI employee replies in their normal voice.
 *
 * Why long-polling and not webhooks: webhooks require a publicly reachable
 * URL — most self-hosted Genosyn instances don't have one. Long-polling
 * works from any machine with outbound HTTPS. We pay the cost of one
 * sticky outbound HTTP connection per bot, which is fine for the bot
 * counts we expect; webhooks can ship later as an optional speed-up.
 *
 * Routing: the responder is the **first** active grant on the connection.
 * Multiple grants are allowed (so other employees can call `send_message`),
 * but only one of them auto-replies on incoming chats.
 *
 * Lifecycle:
 *  - {@link bootTelegramListeners} spins one loop per existing connection.
 *  - {@link refreshTelegramListener} starts/stops/replaces a single loop —
 *    called from the integrations service when a row is created, edited,
 *    or deleted, and from the grant routes when grants change (so a freshly
 *    granted employee starts responding immediately).
 *  - Each loop is owned by a `Worker` record. Calling `cancel()` stops the
 *    loop after the current `getUpdates` poll resolves.
 */

const POLL_TIMEOUT_SECONDS = 30;
// Backoff window after a polling error — keeps us from hammering Telegram
// when the token has been revoked or our network is flaky. The loop wakes
// up sooner if `cancel()` fires.
const ERROR_BACKOFF_MS = 5_000;
// Hard cap on AI-reply length sent back to Telegram. Telegram itself caps
// `sendMessage` at 4096 chars; we leave a small buffer for the truncation
// notice we append.
const TELEGRAM_TEXT_LIMIT = 4000;
// Max prior turns we replay into the chat seam. Mirrors the web SSE route
// (`MAX_REPLAY_TURNS` in employeeSurface.ts) so a Telegram conversation gets
// the same memory window as a web one.
const MAX_REPLAY_TURNS = 24;

type TelegramConfig = {
  botToken: string;
  botId?: number;
  botUsername?: string;
  botName?: string;
};

type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type Worker = {
  connectionId: string;
  cancelled: boolean;
  cancel(): void;
  finished: Promise<void>;
};

const WORKERS = new Map<string, Worker>();

/** Boot every Telegram connection at server startup. */
export async function bootTelegramListeners(): Promise<void> {
  const conns = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { provider: "telegram" },
  });
  for (const c of conns) {
    startWorker(c);
  }
}

/**
 * Re-evaluate the listener for one connection. Called whenever the row
 * changes, including delete (`deleted = true`). Idempotent: stops any
 * in-flight worker before starting a fresh one.
 */
export async function refreshTelegramListener(
  connectionId: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  const existing = WORKERS.get(connectionId);
  if (existing) {
    existing.cancel();
    WORKERS.delete(connectionId);
    await existing.finished.catch(() => {});
  }
  if (opts.deleted) return;
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  if (!conn || conn.provider !== "telegram") return;
  startWorker(conn);
}

function startWorker(conn: IntegrationConnection): void {
  if (WORKERS.has(conn.id)) return;
  let cancelled = false;
  const worker: Worker = {
    connectionId: conn.id,
    cancelled,
    cancel() {
      cancelled = true;
      worker.cancelled = true;
    },
    finished: Promise.resolve(),
  };
  worker.finished = runPollLoop(conn.id, () => cancelled);
  WORKERS.set(conn.id, worker);
}

async function runPollLoop(
  connectionId: string,
  isCancelled: () => boolean,
): Promise<void> {
  let offset = 0;
  while (!isCancelled()) {
    let cfg: TelegramConfig;
    try {
      const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: connectionId,
      });
      if (!conn) return;
      cfg = decryptConnectionConfig(conn) as TelegramConfig;
      if (!cfg.botToken) {
        await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
        continue;
      }
    } catch (err) {
      logErr(connectionId, "config load failed", err);
      await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
      continue;
    }

    let updates: TelegramUpdate[];
    try {
      updates = await telegramFetch<TelegramUpdate[]>(cfg.botToken, "getUpdates", {
        timeout: POLL_TIMEOUT_SECONDS,
        offset,
        allowed_updates: ["message"],
      });
    } catch (err) {
      // Telegram returns 409 if another process is also polling this token,
      // and 401 if the token was revoked. Either way, slow down and retry —
      // the user can re-check the connection from the UI.
      logErr(connectionId, "getUpdates failed", err);
      await sleepCancellable(ERROR_BACKOFF_MS, isCancelled);
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const msg = update.message ?? update.channel_post;
      if (!msg) continue;
      try {
        await handleMessage(connectionId, cfg, msg);
      } catch (err) {
        logErr(connectionId, `handle update ${update.update_id} failed`, err);
      }
      if (isCancelled()) return;
    }
  }
}

async function handleMessage(
  connectionId: string,
  cfg: TelegramConfig,
  msg: TelegramMessage,
): Promise<void> {
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!text) return;
  if (msg.from?.is_bot) return;

  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  if (!conn) return;

  const responder = await pickResponder(connectionId);
  if (!responder) {
    await sendReplySafely(
      cfg.botToken,
      msg.chat.id,
      "This Telegram bot isn't connected to an AI employee yet. Open Genosyn → Integrations → grant this connection to an employee.",
    );
    return;
  }

  const conversation = await getOrCreateConversation({
    companyId: conn.companyId,
    employeeId: responder,
    connectionId,
    chat: msg.chat,
  });

  const msgRepo = AppDataSource.getRepository(ConversationMessage);
  await msgRepo.save(
    msgRepo.create({
      conversationId: conversation.id,
      role: "user",
      content: text,
      status: null,
    }),
  );

  // Replay the trailing window of the same conversation back into the chat
  // seam, mirroring the web SSE route. We exclude the just-saved user turn
  // because `chatWithEmployee` adds it via the `message` arg.
  const prior = await msgRepo.find({
    where: { conversationId: conversation.id },
    order: { createdAt: "ASC" },
  });
  const replay = prior
    .slice(0, -1)
    .slice(-MAX_REPLAY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));

  // Tag the message with provenance so the AI knows which Telegram chat
  // it's talking to without us touching the saved row. Used when the AI
  // wants to push something via `send_message` later in the same turn.
  const tagged = `[Inbound via Telegram · chat_id ${msg.chat.id}${msg.from?.username ? ` · from @${msg.from.username}` : ""}]\n${text}`;

  const result = await chatWithEmployee(conn.companyId, responder, tagged, replay);

  await msgRepo.save(
    msgRepo.create({
      conversationId: conversation.id,
      role: "assistant",
      content: result.reply,
      status: result.status,
    }),
  );

  const convRepo = AppDataSource.getRepository(Conversation);
  conversation.updatedAt = new Date();
  if (!conversation.title) conversation.title = deriveTitle(text);
  await convRepo.save(conversation);

  await sendReplySafely(cfg.botToken, msg.chat.id, result.reply, msg.message_id);
}

async function pickResponder(connectionId: string): Promise<string | null> {
  const grant = await AppDataSource.getRepository(EmployeeConnectionGrant).findOne({
    where: { connectionId },
    order: { createdAt: "ASC" },
  });
  return grant?.employeeId ?? null;
}

async function getOrCreateConversation(args: {
  companyId: string;
  employeeId: string;
  connectionId: string;
  chat: TelegramChat;
}): Promise<Conversation> {
  const repo = AppDataSource.getRepository(Conversation);
  const externalKey = String(args.chat.id);
  const existing = await repo.findOneBy({
    source: "telegram",
    connectionId: args.connectionId,
    externalKey,
  });
  if (existing) {
    if (existing.employeeId !== args.employeeId) {
      // Responder swap (e.g. the original employee was deleted and re-granted
      // to someone else). Leave the conversation in place — it's the human's
      // history with this bot — but redirect future turns to the new employee.
      existing.employeeId = args.employeeId;
      await repo.save(existing);
    }
    return existing;
  }
  const created = repo.create({
    employeeId: args.employeeId,
    title: deriveChatTitle(args.chat),
    archivedAt: null,
    source: "telegram",
    externalKey,
    connectionId: args.connectionId,
  });
  return repo.save(created);
}

function deriveChatTitle(chat: TelegramChat): string | null {
  if (chat.title) return chat.title.slice(0, 80);
  const handle = chat.username ? `@${chat.username}` : null;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  if (handle && name) return `${name} (${handle})`.slice(0, 80);
  if (handle) return handle.slice(0, 80);
  if (name) return name.slice(0, 80);
  return null;
}

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

async function sendReplySafely(
  botToken: string,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<void> {
  const safe = (text || "").trim() || "(no reply)";
  const truncated =
    safe.length > TELEGRAM_TEXT_LIMIT
      ? `${safe.slice(0, TELEGRAM_TEXT_LIMIT)}\n\n…(truncated)`
      : safe;
  try {
    await telegramFetch(botToken, "sendMessage", {
      chat_id: chatId,
      text: truncated,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    });
  } catch (err) {
    logErr(undefined, `sendMessage to ${chatId} failed`, err);
  }
}

function sleepCancellable(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = 200;
    const start = Date.now();
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, tick);
  });
}

function logErr(connectionId: string | undefined, label: string, err: unknown): void {
  const tag = connectionId ? `[telegram ${connectionId}]` : "[telegram]";
  // eslint-disable-next-line no-console
  console.error(`${tag} ${label}:`, err instanceof Error ? err.message : err);
}
