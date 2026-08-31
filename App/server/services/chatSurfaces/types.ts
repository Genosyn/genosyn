import type { IntegrationConfig } from "../../integrations/types.js";

/**
 * Shared types for **external chat surfaces** — the places a human talks to an
 * AI Employee without opening Genosyn.
 *
 * An adapter's whole job is translation. Everything that decides *what the
 * employee is allowed to do* — identity, authority, conversation mapping,
 * replay window, Standdown gating — lives in `inbound.ts` and is identical on
 * every surface. An adapter that wanted to make one of those decisions for
 * itself would be the bug this split exists to prevent.
 *
 * Transports differ, and that difference is the product constraint worth
 * naming: Telegram long-polls and Slack holds a Socket Mode WebSocket, so both
 * work from a laptop behind NAT. Microsoft Teams and WhatsApp are webhook-only
 * and need a publicly reachable HTTPS URL, which is why their catalog entries
 * disable themselves when `instance.publicUrl` is not set.
 */
export type ChatSurfaceProviderId = "telegram" | "slack" | "microsoft-teams" | "whatsapp";

export const CHAT_SURFACE_PROVIDER_IDS: ChatSurfaceProviderId[] = [
  "telegram",
  "slack",
  "microsoft-teams",
  "whatsapp",
];

export function isChatSurfaceProvider(provider: string): provider is ChatSurfaceProviderId {
  return (CHAT_SURFACE_PROVIDER_IDS as string[]).includes(provider);
}

/**
 * One inbound message, normalized. Adapters produce these; `inbound.ts`
 * consumes them and never learns which surface it came from beyond
 * `provider`.
 */
export type InboundChatTurn = {
  provider: ChatSurfaceProviderId;
  connectionId: string;
  companyId: string;
  /**
   * Stable id of the upstream thread — persisted as
   * `Conversation.externalKey`. A Slack threaded reply keys on
   * `channel:thread_ts` so it is its own transcript rather than a merged
   * blob; a DM keys on the channel alone.
   */
  externalKey: string;
  /** Stable id of the sender — matched against `ExternalChatIdentity`. */
  externalUserId: string;
  /** Best-effort display name. Never used for authorization. */
  externalUserLabel: string | null;
  /** Best-effort thread title, used only when naming a new Conversation. */
  threadTitle: string | null;
  /** Plain message text. Adapters strip their own bot mention. */
  text: string;
  /**
   * True in a shared channel / group, false in a 1:1 DM. Group threads never
   * adopt an owner, because a transcript many people can read must not become
   * one Member's private history.
   */
  group: boolean;
  /** Provider message id, when it has one. Used to suppress replays. */
  externalMessageId: string | null;
  /** Opaque routing handed straight back to {@link ChatSurfaceAdapter.send}. */
  replyTo: ChatSurfaceReplyTarget;
};

/** Whatever the adapter needs to answer in the right place. */
export type ChatSurfaceReplyTarget = Record<string, unknown>;

export type ChatSurfaceSendArgs = {
  connectionId: string;
  config: IntegrationConfig;
  replyTo: ChatSurfaceReplyTarget;
  text: string;
};

export type ChatSurfaceAdapter = {
  provider: ChatSurfaceProviderId;
  /**
   * `poll` and `socket` hold an outbound connection per Connection row and are
   * driven by `workers.ts`; `webhook` adapters are driven by inbound HTTP and
   * start nothing.
   */
  transport: "poll" | "socket" | "webhook";
  /** Hard cap on one outbound message, before the truncation notice. */
  textLimit: number;
  /**
   * True when the transport cannot work without `instance.publicUrl`. The
   * catalog renders this as a disabled card rather than letting an operator
   * connect a bot that will never receive anything.
   */
  requiresPublicUrl: boolean;
  /** Deliver one reply. Errors are logged and swallowed by the caller. */
  send(args: ChatSurfaceSendArgs): Promise<void>;
  /**
   * Long-running transports implement this. Returns when the loop ends;
   * must return promptly once `isCancelled()` flips.
   */
  run?(args: ChatSurfaceRunArgs): Promise<void>;
  /**
   * Inbound-over-HTTP transports implement this. Slack implements *both*:
   * Socket Mode when the app-level token is present, the Events API when the
   * operator would rather point Slack at a public URL.
   */
  webhook?: ChatSurfaceWebhook;
};

/**
 * The HTTP half of a surface. The route is deliberately generic — it hands
 * over raw bytes, headers and query, and takes back either normalized turns
 * or a verbatim response — because every platform disagrees about how to
 * prove a request came from it, and none of that belongs in a route file.
 */
export type ChatSurfaceWebhook = {
  /**
   * Answer a platform's GET verification handshake (WhatsApp's
   * `hub.challenge`). Return null when the query is not a handshake.
   */
  verifyHandshake?(args: {
    config: IntegrationConfig;
    query: Record<string, unknown>;
  }): ChatSurfaceWebhookResponse | null;
  /**
   * Authenticate the delivery and normalize it. **Must** verify the
   * platform's signature over `rawBody` before trusting a single field:
   * these routes are mounted before the session middleware, so the signature
   * is the only credential there is.
   */
  verifyAndNormalize(args: {
    connectionId: string;
    companyId: string;
    config: IntegrationConfig;
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
    query: Record<string, unknown>;
  }): Promise<ChatSurfaceWebhookResult>;
};

export type ChatSurfaceWebhookResponse = {
  status: number;
  body: string;
  contentType?: string;
};

export type ChatSurfaceWebhookResult =
  /** Verified. Deliver these (possibly zero) turns and 200. */
  | { kind: "turns"; turns: InboundChatTurn[] }
  /** Verified, but the platform wants a specific body back (Slack's
   *  `url_verification` challenge). */
  | { kind: "respond"; response: ChatSurfaceWebhookResponse }
  /** Not verified. The route answers with this status and nothing else. */
  | { kind: "reject"; status: number };

export type ChatSurfaceRunArgs = {
  connectionId: string;
  isCancelled: () => boolean;
  /** Hand a normalized turn to the shared inbound core. */
  deliver: (turn: InboundChatTurn) => Promise<void>;
};

/** Trim a reply to the surface's cap without cutting mid-notice. */
export function truncateForSurface(text: string, limit: number): string {
  const safe = (text || "").trim() || "(no reply)";
  if (safe.length <= limit) return safe;
  const suffix = "\n\n…(truncated)";
  return `${safe.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}
