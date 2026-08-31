import crypto from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";

import { constantTimeEqual } from "../../lib/constantTime.js";
import { slackFetch, type SlackConfig } from "../../integrations/providers/slack.js";
import type {
  ChatSurfaceAdapter,
  ChatSurfaceWebhookResult,
  InboundChatTurn,
} from "./types.js";

/**
 * Slack, translated.
 *
 * Everything here is about Slack's wire format and Slack's transports.
 * Nothing here decides who the sender is, what the AI Employee may do for
 * them, or which transcript the turn belongs to — `inbound.ts` owns all of
 * that, on every surface, once.
 *
 * Two transports, because Slack has two and operators are split between them:
 *
 *  - **Socket Mode** (`run`) when an app-level token is configured. Genosyn
 *    dials out, so a laptop or a NAT'd cluster is reachable without a public
 *    URL. This is the path the catalog copy pushes people toward.
 *  - **The Events API** (`webhook`) when the operator would rather point
 *    Slack at an HTTPS URL. That route runs before any session middleware, so
 *    the v0 signature is the *only* thing standing between the handler and
 *    the open internet — which is why it is checked over the raw bytes,
 *    before a single field is parsed.
 *
 * The rule that shapes normalization: **a bot must never answer itself.** A
 * DM answers every message; a channel answers only an @-mention, in the
 * thread the mention was in. Everything else — edits, joins, file shares,
 * anything wearing a `bot_id` — is dropped on the floor.
 */

/**
 * Slack hard-caps a message at 4000 characters. The gap is headroom for the
 * truncation notice `truncateForSurface` appends.
 */
const SLACK_TEXT_LIMIT = 3800;

/** Slack's own replay window for the v0 signature. */
export const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/** How often the socket loop notices that the worker asked it to stop. */
const CANCEL_POLL_MS = 250;

/**
 * How long the socket loop will sit on a connection that has said nothing.
 *
 * Slack pings a live Socket Mode connection about every 30 seconds, so three
 * missed pings is a silence a healthy connection never produces. That the
 * socket is still *open* proves nothing: a TCP session that dies without a
 * FIN — a laptop that sleeps, a NAT table that expires, a middlebox that drops
 * the flow — stays open and mute from this side forever. Waiting on one is
 * worse than crashing, because the process goes on renewing the scheduler
 * lease for a workspace it can no longer hear, so no other replica takes over
 * either.
 */
export const SOCKET_IDLE_TIMEOUT_MS = 95_000;

/**
 * Our own keepalive, on Slack's cadence. `ws` answers Slack's pings by itself;
 * this is the other direction, and it is what holds a NAT mapping open through
 * a quiet night — and draws a pong back from a peer that is still there, which
 * is a frame, which is what the deadline above is measuring.
 */
export const SOCKET_PING_INTERVAL_MS = 30_000;

/* ------------------------------------------------------------------ *
 * Slack's wire format
 * ------------------------------------------------------------------ */

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/**
 * Decoded last, on purpose. Slack escapes `&`, `<` and `>` in message text,
 * so a sender who types `&lt;https://evil.example|payroll&gt;` is quoting a
 * link, not writing one. Decoding first would hand that quote back to the
 * link parser as real markup.
 */
function decodeSlackEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt);/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

function labelledLink(url: string, rawLabel: string): string {
  const target = url.trim();
  const label = rawLabel.trim();
  if (!label) return target;
  // Slack auto-links bare URLs and addresses into `<x|x>`. Echoing "x (x)"
  // back at the reader helps nobody.
  if (label === target || `mailto:${label}` === target) return label;
  return `${label} (${target})`;
}

/**
 * Slack's message text is not plain text: mentions, channels, user groups and
 * links all arrive wrapped in angle brackets, and the AI Employee should read
 * what a human reads.
 */
export function slackWireToPlainText(text: string): string {
  return decodeSlackEntities(
    (text ?? "")
      // The sigil after `<` is the only thing separating these four shapes,
      // so each is claimed before the generic link forms get a look.
      .replace(/<#([A-Za-z0-9]+)(?:\|([^>]*))?>/g, (_all, id: string, label?: string) =>
        label && label.trim() ? `#${label.trim()}` : `#${id}`,
      )
      .replace(/<!subteam\^([A-Za-z0-9]+)(?:\|([^>]*))?>/g, (_all, id: string, label?: string) =>
        label && label.trim() ? `@${label.trim().replace(/^@/, "")}` : `@${id}`,
      )
      .replace(
        /<!(here|channel|everyone)(?:\|[^>]*)?>/gi,
        (_all, keyword: string) => `@${keyword.toLowerCase()}`,
      )
      .replace(/<@([A-Za-z0-9]+)(?:\|([^>]*))?>/g, (_all, id: string, label?: string) =>
        label && label.trim() ? `@${label.trim()}` : `@${id}`,
      )
      .replace(/<([^<>|]+)\|([^<>]*)>/g, (_all, url: string, label: string) =>
        labelledLink(url, label),
      )
      .replace(/<([^<>|]+)>/g, (_all, url: string) => url.trim().replace(/^mailto:/, "")),
  );
}

/** Drop the `<@BOT>` that opens an @-mention, plus the comma people add after it. */
export function stripLeadingBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text;
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^\\s*<@${escaped}(?:\\|[^>]*)?>\\s*[:,]?\\s*`), "");
}

/* ------------------------------------------------------------------ *
 * Markdown → mrkdwn
 * ------------------------------------------------------------------ */

/**
 * Bold is parked here between passes. Slack's bold is a *single* asterisk, so
 * rewriting `**x**` to `*x*` in place would leave the italic pass eating its
 * own output.
 */
const BOLD_SENTINEL = "\u0000";

/**
 * A markdown link, with the parentheses in its URL counted rather than banned.
 *
 * The URL half ends in the same character the link syntax closes with, so
 * `[Q3](https://x.dev/report_(final))` needs the *last* paren to be the
 * closer and the one before it to belong to the URL. Balanced pairs are
 * swallowed — two deep, which is as far as a regular expression can count,
 * and further than any real URL goes — leaving the first paren the URL cannot
 * account for to close the link. A `(` that never closes is still let through
 * as an ordinary character: a URL cut short reads better than a line of
 * literal brackets in front of the channel.
 */
const MARKDOWN_LINK =
  /!?\[([^\]]*)\]\(\s*<?((?:[^\s<>()]|\((?:[^\s<>()]|\([^\s<>()]*\))*\)|\()+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Bold-italic, claimed as one token before either half gets a look.
 *
 * A bold pass and an italic pass run independently over the same characters
 * close each other's markers in the wrong order — `*_x*_`, overlapping rather
 * than nested, which Slack cannot pair up and renders as literal punctuation.
 * Slack's own spelling nests: `*_x_*`.
 */
const BOLD_ITALIC_STARS = /\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/g;
const BOLD_ITALIC_UNDERSCORES = /___(?!\s)([^_\n]+?)(?<!\s)___/g;

function isTableSeparator(line: string): boolean {
  const row = line.trim();
  return row.includes("|") && row.includes("-") && /^[|\s:-]+$/.test(row);
}

function isTableRow(line: string): boolean {
  const row = line.trim();
  return row.startsWith("|") && row.endsWith("|") && row.length > 1;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|"));
}

function convertInlineMarkup(text: string): string {
  return text
    .replace(MARKDOWN_LINK, (_all, label: string, url: string) =>
      label.trim() ? `<${url}|${label.trim()}>` : `<${url}>`,
    )
    .replace(BOLD_ITALIC_STARS, `${BOLD_SENTINEL}_$1_${BOLD_SENTINEL}`)
    .replace(BOLD_ITALIC_UNDERSCORES, `${BOLD_SENTINEL}_$1_${BOLD_SENTINEL}`)
    .replace(/\*\*(.+?)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`)
    .replace(/__(.+?)__/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`)
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "_$1_")
    .split(BOLD_SENTINEL)
    .join("*");
}

function convertInline(text: string): string {
  // Inline code is split out rather than skipped over: a reader who typed
  // `**not bold**` inside backticks asked for those asterisks.
  return text
    .split(/(`+[^`]*`+)/)
    .map((piece, index) => (index % 2 === 1 ? piece : convertInlineMarkup(piece)))
    .join("");
}

function convertBlockLine(line: string): string {
  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    const text = convertInline(heading[2]).trim();
    return text ? `*${text}*` : "";
  }
  if (isTableRow(line)) {
    // Slack has no table. A row of cells reads better as one line than as a
    // wall of pipes that wraps at the third column.
    return splitTableRow(line)
      .map((cell) => convertInline(cell).trim())
      .filter(Boolean)
      .join(" · ");
  }
  return convertInline(line);
}

/**
 * Slack's mrkdwn is not markdown, and the gap is not cosmetic: an AI Employee
 * that answers in markdown gets `**bold**` rendered as literal asterisks and
 * `[label](url)` rendered as literal brackets, in front of the whole channel.
 *
 * Code survives untouched — fenced and inline both. A model explaining
 * markdown, or quoting a shell line full of asterisks, must get back exactly
 * what it wrote.
 */
export function toSlackMrkdwn(markdown: string): string {
  const source = (markdown ?? "").split(BOLD_SENTINEL).join("");
  const out: string[] = [];
  let inFence = false;
  for (const line of source.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (isTableSeparator(line)) continue;
    out.push(convertBlockLine(line));
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

const slackUserProfileSchema = z
  .object({
    display_name: z.string().max(300).nullish(),
    real_name: z.string().max(300).nullish(),
    name: z.string().max(300).nullish(),
  })
  .passthrough();

/**
 * Deliberately forgiving. Slack adds fields constantly and a strict schema
 * would turn a new one into a dropped message; what matters is that every
 * field we *read* is the type we think it is.
 */
const slackEventSchema = z
  .object({
    type: z.string().max(64),
    subtype: z.string().max(64).nullish(),
    hidden: z.boolean().nullish(),
    bot_id: z.string().max(64).nullish(),
    user: z.string().max(64).nullish(),
    username: z.string().max(300).nullish(),
    text: z.string().max(200_000).nullish(),
    ts: z.string().max(64).nullish(),
    thread_ts: z.string().max(64).nullish(),
    channel: z.string().max(64).nullish(),
    channel_type: z.string().max(32).nullish(),
    user_profile: slackUserProfileSchema.nullish(),
  })
  .passthrough();

type SlackEvent = z.infer<typeof slackEventSchema>;

export type NormalizeSlackEventArgs = {
  connectionId: string;
  companyId: string;
  /** The bot's own user id from the Connection config. */
  botUserId: string | null | undefined;
  /** The `event` object out of Slack's envelope. */
  event: unknown;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bestLabel(event: SlackEvent): string | null {
  const profile = event.user_profile ?? null;
  const candidates = [profile?.display_name, profile?.real_name, profile?.name, event.username];
  for (const candidate of candidates) {
    const value = trimmed(candidate);
    if (value) return value.slice(0, 200);
  }
  return null;
}

function isDirectMessageChannel(channelType: unknown, channel: string): boolean {
  const declared = trimmed(channelType);
  if (declared) return declared === "im";
  // `app_mention` does not always carry `channel_type`, and Slack's id
  // prefixes answer the same question: D is a DM, C a channel, G a group.
  return channel.startsWith("D");
}

/**
 * One Slack event → one turn, or null when the event must be ignored.
 *
 * Pure by design. Every rule that decides whether an AI Employee speaks in a
 * channel is in this function, where it can be tested against a hostile
 * payload without a socket, a database, or a workspace.
 */
export function normalizeSlackEvent(args: NormalizeSlackEventArgs): InboundChatTurn | null {
  const parsed = slackEventSchema.safeParse(args.event);
  if (!parsed.success) return null;
  const event = parsed.data;

  // A bot answering itself is the failure mode that matters most, so all
  // four ways Slack can say "software wrote this" are refusals. `bot_id`
  // covers our own posts even on a Connection that never captured a
  // `botUserId`; the id check covers a workspace where the app posts as a
  // user. A subtype means an edit, a join, a file share or a channel-topic
  // change — never a person addressing the employee — and `hidden` is
  // Slack's own flag for a message that was not shown to anyone.
  if (trimmed(event.bot_id)) return null;
  if (event.hidden === true) return null;
  if (trimmed(event.subtype)) return null;

  const user = trimmed(event.user);
  if (!user) return null;
  const botUserId = trimmed(args.botUserId);
  if (botUserId && user === botUserId) return null;

  const channel = trimmed(event.channel);
  const ts = trimmed(event.ts);
  if (!channel || !ts) return null;

  const threadTs = trimmed(event.thread_ts) || null;
  const direct = isDirectMessageChannel(event.channel_type, channel);

  // Each place has exactly one event type that counts. In a DM Slack sends a
  // `message` *and* — when the bot is named — an `app_mention` for the same
  // words, and answering both is answering twice. In a channel the reverse
  // rule is what keeps the employee out of a conversation it was not invited
  // into: only an explicit mention gets a reply.
  if (direct && event.type !== "message") return null;
  if (!direct && event.type !== "app_mention") return null;

  const text = slackWireToPlainText(
    stripLeadingBotMention(typeof event.text === "string" ? event.text : "", botUserId || null),
  ).trim();
  if (!text) return null;

  return {
    provider: "slack",
    connectionId: args.connectionId,
    companyId: args.companyId,
    // A DM is one continuous conversation, so it keys on the channel alone.
    // A threaded mention is its own transcript — two people asking two
    // questions in one channel must not share a memory.
    externalKey: direct ? channel : `${channel}:${threadTs ?? ts}`,
    externalUserId: user,
    externalUserLabel: bestLabel(event),
    threadTitle: null,
    text,
    group: !direct,
    externalMessageId: `${channel}:${ts}`,
    replyTo: direct
      ? { channel, ...(threadTs ? { thread_ts: threadTs } : {}) }
      : // Answer in the thread. A long reply pasted into the channel is the
        // difference between a helpful colleague and a nuisance.
        { channel, thread_ts: threadTs ?? ts },
  };
}

/* ------------------------------------------------------------------ *
 * Events API signature
 * ------------------------------------------------------------------ */

export type SlackSignatureFailure =
  | "no_secret"
  | "missing_headers"
  | "bad_timestamp"
  | "stale"
  | "bad_version"
  | "mismatch";

export type SlackSignatureVerdict = { ok: true } | { ok: false; reason: SlackSignatureFailure };

/**
 * Slack's v0 signature, over the raw request bytes.
 *
 * Bytes, not a decoded string: a body re-encoded on its way through a JSON
 * parser is a different body, and would fail against a signature Slack
 * computed over what it actually sent.
 */
export function signSlackRequest(
  signingSecret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), rawBody]);
  return `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

export function verifySlackSignature(args: {
  signingSecret: string | null | undefined;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  /** ms epoch, injectable so the replay window is testable. */
  now?: number;
}): SlackSignatureVerdict {
  const secret = trimmed(args.signingSecret);
  // No secret means the operator never set this route up. Answering anything
  // but 401 would leave an unauthenticated inbound path open on a Connection
  // whose owner believes they are using Socket Mode.
  if (!secret) return { ok: false, reason: "no_secret" };

  const timestamp = trimmed(args.timestamp);
  const signature = trimmed(args.signature);
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  // The window is the whole reason the timestamp is signed: without it a
  // captured delivery stays valid forever.
  const nowSeconds = Math.floor((args.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: "stale" };
  }
  if (!signature.startsWith("v0=")) return { ok: false, reason: "bad_version" };
  if (!constantTimeEqual(signature, signSlackRequest(secret, timestamp, args.rawBody))) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

const slackWebhookBodySchema = z
  .object({
    type: z.string().max(64).nullish(),
    challenge: z.string().max(4000).nullish(),
    event: z.unknown().optional(),
  })
  .passthrough();

/** Header names arrive lowercased from Node, but nothing guarantees the caller did. */
function pickHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** `ws` hands over a Buffer, a fragment list, or an ArrayBuffer. All three are bytes. */
function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Socket Mode
 * ------------------------------------------------------------------ */

const socketEnvelopeSchema = z
  .object({
    type: z.string().max(64).nullish(),
    envelope_id: z.string().max(200).nullish(),
    payload: z.unknown().optional(),
  })
  .passthrough();

const eventCallbackSchema = z
  .object({
    type: z.string().max(64).nullish(),
    event: z.unknown().optional(),
  })
  .passthrough();

function logSlackError(connectionId: string | undefined, label: string, err: unknown): void {
  const tag = connectionId ? `[slack ${connectionId}]` : "[slack]";
  // eslint-disable-next-line no-console
  console.error(`${tag} ${label}:`, err instanceof Error ? err.message : err);
}

/**
 * The Connection's own credentials. `run()` is handed an id and nothing else.
 *
 * The imports are deferred rather than static, and that is not a style
 * choice. `services/integrations.ts` reaches the adapter registry, the
 * registry imports this module, and an ES module cycle entered from *this*
 * side evaluates `adapters.ts` while `slackChatSurface` is still in its
 * temporal dead zone: `ReferenceError: Cannot access 'slackChatSurface'
 * before initialization`, at import time, for anything that loads this file
 * before the registry. Moving the edge to call time also keeps the database
 * out of this module's import graph, which is why every rule above can be
 * tested without one.
 */
async function loadSlackConnection(
  connectionId: string,
): Promise<{ companyId: string; config: SlackConfig } | null> {
  const [{ AppDataSource }, { IntegrationConnection }, { decryptConnectionConfig }] =
    await Promise.all([
      import("../../db/datasource.js"),
      import("../../db/entities/IntegrationConnection.js"),
      import("../integrations.js"),
    ]);
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  if (!conn || conn.provider !== "slack") return null;
  return { companyId: conn.companyId, config: decryptConnectionConfig(conn) as SlackConfig };
}

type SocketPumpArgs = {
  url: string;
  connectionId: string;
  companyId: string;
  botUserId: string | null;
  isCancelled: () => boolean;
  deliver: (turn: InboundChatTurn) => Promise<void>;
  /** Injectable so the loop can be driven by a fake socket in a test. */
  connect?: (url: string) => WebSocket;
  /** ms epoch, injectable so the idle deadline is testable without the wait. */
  now?: () => number;
};

/**
 * One socket, held until Slack, the worker or the idle deadline ends it.
 *
 * Exported for its test. Everything that decides how long a workspace waits on
 * a connection that has stopped answering is decided here, and none of it
 * needs a workspace to exercise.
 */
export function pumpSocketMode(args: SocketPumpArgs): Promise<void> {
  const now = args.now ?? Date.now;
  return new Promise<void>((resolve) => {
    const socket = args.connect ? args.connect(args.url) : new WebSocket(args.url);
    let settled = false;
    let open = false;
    // Deliveries run one behind the other. Slack hands over a burst after a
    // reconnect, and each turn is answered from a transcript the one before
    // it just wrote.
    let queue: Promise<void> = Promise.resolve();
    let lastFrameAt = now();
    let lastPingAt = lastFrameAt;

    const watchdog = setInterval(() => {
      // Cancellation is checked first and acted on at once: `isCancelled` also
      // goes true when this replica loses the scheduler lease, and by then the
      // replica that won it is already dialling. An unwind that waits on a
      // silent socket is two sockets on one workspace.
      if (args.isCancelled()) {
        stop("cancelled");
        return;
      }
      const at = now();
      const idleFor = at - lastFrameAt;
      if (idleFor >= SOCKET_IDLE_TIMEOUT_MS) {
        logSlackError(args.connectionId, "socket idle", `no frame in ${idleFor}ms`);
        stop("dead");
        return;
      }
      if (open && at - lastPingAt >= SOCKET_PING_INTERVAL_MS) {
        lastPingAt = at;
        try {
          socket.ping();
        } catch (err) {
          logSlackError(args.connectionId, "socket ping failed", err);
        }
      }
    }, CANCEL_POLL_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();

    function stop(reason: "cancelled" | "dead" | "ended"): void {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      try {
        // A close handshake on a half-open socket waits for a FIN that is
        // never coming, so the one connection we have already given up on is
        // cut instead of asked.
        if (reason === "dead") socket.terminate();
        else socket.close();
      } catch (err) {
        logSlackError(args.connectionId, `socket ${reason} teardown failed`, err);
      }
      resolve();
    }

    /**
     * Any frame at all, `hello` or a bare ping. What the deadline measures is
     * whether the connection is still carrying bytes, not whether anyone is
     * talking to the AI Employee — a workspace can be quiet for a weekend.
     */
    function markFrame(): void {
      lastFrameAt = now();
    }

    socket.on("open", () => {
      open = true;
      markFrame();
    });
    // `ws` answers Slack's pings with a pong on its own; these listeners are
    // here for the timestamp.
    socket.on("ping", markFrame);
    socket.on("pong", markFrame);

    socket.on("message", (data: RawData) => {
      // Past `stop` the worker is free to dial again, so answering here would
      // be the second replica the lease exists to prevent — and acking would
      // tell Slack a turn was handled that nobody is handling. Slack redelivers
      // it to whoever holds the next socket, which is the right outcome.
      if (settled) return;
      markFrame();
      const envelope = socketEnvelopeSchema.safeParse(parseJsonBody(rawDataToBuffer(data)));
      if (!envelope.success) return;
      const { type, envelope_id: envelopeId, payload } = envelope.data;

      // The ACK goes out before any work at all. Slack redelivers anything
      // unacknowledged after three seconds, and a redelivery we are still
      // thinking about becomes a second answer in the channel.
      if (trimmed(envelopeId)) {
        try {
          socket.send(JSON.stringify({ envelope_id: envelopeId }));
        } catch (err) {
          logSlackError(args.connectionId, "socket ack failed", err);
        }
      }

      // Slack disconnects every socket periodically to rebalance. Returning
      // hands the reconnect to the worker loop, which already owns the lease
      // and the backoff.
      if (type === "disconnect") {
        stop("ended");
        return;
      }
      if (type !== "events_api") return;

      const callback = eventCallbackSchema.safeParse(payload);
      if (!callback.success) return;
      const turn = normalizeSlackEvent({
        connectionId: args.connectionId,
        companyId: args.companyId,
        botUserId: args.botUserId,
        event: callback.data.event,
      });
      if (!turn) return;
      queue = queue
        .then(() => args.deliver(turn))
        .catch((err) => logSlackError(args.connectionId, "deliver failed", err));
    });

    socket.on("error", (err) => {
      logSlackError(args.connectionId, "socket error", err);
      stop("ended");
    });
    socket.on("close", () => stop("ended"));
  });
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const slackChatSurface: ChatSurfaceAdapter = {
  provider: "slack",
  transport: "socket",
  textLimit: SLACK_TEXT_LIMIT,
  requiresPublicUrl: false,

  async send({ config, replyTo, text }) {
    const cfg = config as SlackConfig;
    const botToken = trimmed(cfg.botToken);
    // Say so here rather than letting Slack answer `not_authed`, which reads
    // like a revoked token and sends the operator looking in the wrong place.
    if (!botToken) throw new Error("Slack connection has no bot token.");
    const channel = trimmed(replyTo.channel);
    if (!channel) throw new Error("Slack reply target carries no channel.");
    const threadTs = trimmed(replyTo.thread_ts);
    await slackFetch("chat.postMessage", botToken, {
      channel,
      text: toSlackMrkdwn(text),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  },

  /**
   * Socket Mode.
   *
   * Exactly one process may hold a workspace's socket — two would answer one
   * question twice — and that exclusivity is the scheduler lease in
   * `workers.ts`, not this function's business: the lease is held by the time
   * `run` is called, and returning gives it back. So every exit here is a
   * plain return, including Slack's own periodic `disconnect`: the worker
   * loop reconnects, and the Connection is re-read on the way through, which
   * is how a rotated token takes effect without a restart.
   */
  async run({ connectionId, isCancelled, deliver }) {
    const loaded = await loadSlackConnection(connectionId);
    if (!loaded) return;
    const appToken = trimmed(loaded.config.appToken);
    // No app-level token means the operator wired the Events API to a public
    // URL instead. There is no socket to hold open, and returning leaves the
    // webhook half as the only inbound path — which is what they asked for.
    if (!appToken) return;
    if (isCancelled()) return;

    const opened = await slackFetch<{ url?: string }>("apps.connections.open", appToken);
    const url = trimmed(opened.url);
    if (!url) throw new Error("Slack apps.connections.open returned no socket URL.");
    if (isCancelled()) return;

    await pumpSocketMode({
      url,
      connectionId,
      companyId: loaded.companyId,
      botUserId: trimmed(loaded.config.botUserId) || null,
      isCancelled,
      deliver,
    });
  },

  webhook: {
    async verifyAndNormalize({
      connectionId,
      companyId,
      config,
      rawBody,
      headers,
    }): Promise<ChatSurfaceWebhookResult> {
      const cfg = config as SlackConfig;
      const verdict = verifySlackSignature({
        signingSecret: cfg.signingSecret,
        rawBody,
        timestamp: pickHeader(headers, "x-slack-request-timestamp"),
        signature: pickHeader(headers, "x-slack-signature"),
      });
      if (!verdict.ok) return { kind: "reject", status: 401 };

      const parsed = slackWebhookBodySchema.safeParse(parseJsonBody(rawBody));
      // Signed, so it really did come from Slack. A body we cannot read is
      // still answered 200: a retry would only bring the same bytes back.
      if (!parsed.success) return { kind: "turns", turns: [] };

      if (parsed.data.type === "url_verification") {
        return {
          kind: "respond",
          response: {
            status: 200,
            body: trimmed(parsed.data.challenge),
            contentType: "text/plain; charset=utf-8",
          },
        };
      }
      if (parsed.data.type !== "event_callback") return { kind: "turns", turns: [] };

      const turn = normalizeSlackEvent({
        connectionId,
        companyId,
        botUserId: cfg.botUserId ?? null,
        event: parsed.data.event,
      });
      return { kind: "turns", turns: turn ? [turn] : [] };
    },
  },
};
