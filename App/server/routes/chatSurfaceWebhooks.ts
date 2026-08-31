import express, { Router, type Response } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { getChatSurfaceAdapter } from "../services/chatSurfaces/adapters.js";
import { handleInboundTurn, logSurfaceError } from "../services/chatSurfaces/inbound.js";
import {
  isChatSurfaceProvider,
  type ChatSurfaceAdapter,
  type ChatSurfaceProviderId,
  type ChatSurfaceWebhook,
  type ChatSurfaceWebhookResponse,
  type ChatSurfaceWebhookResult,
  type InboundChatTurn,
} from "../services/chatSurfaces/types.js";
import { decryptConnectionConfig } from "../services/integrations.js";

/**
 * Inbound HTTP for the webhook-shaped chat surfaces (M59) — Microsoft Teams,
 * WhatsApp, and Slack when an operator points the Events API here instead of
 * running Socket Mode.
 *
 * Mounted at `/api/chat-surfaces/webhook` BEFORE `express.json()` and before
 * the session / trusted-origin middleware, for exactly the reasons the Stripe
 * receiver is: signature verification needs the byte-for-byte body, and none
 * of these callers sends a cookie or an Origin. The platform's signature is
 * the only credential there is, which is why `verifyAndNormalize` — not this
 * file — is where a delivery becomes trusted.
 *
 * This router deliberately knows nothing about any platform. It resolves a
 * Connection, hands the adapter raw bytes, and does one of three things with
 * what comes back. Everything a platform disagrees about (how it signs, how it
 * proves a handshake, what a retry looks like) lives in the adapter;
 * everything about what an AI Employee may then do lives in
 * `services/chatSurfaces/inbound.ts`.
 *
 * **Nothing here logs a raw body or a header value.** Both carry the shared
 * secret's output and, on some surfaces, the message text itself.
 */
export const chatSurfaceWebhooksRouter = Router();

/**
 * Raw bytes for every method, not just JSON. Meta posts `application/json`,
 * Azure Bot Service posts `application/json; charset=utf-8`, and a
 * misconfigured proxy will happily rewrite either — a signature computed over
 * re-serialized JSON is a signature over a different document, so the parser
 * must never touch the body.
 */
chatSurfaceWebhooksRouter.use(express.raw({ type: "*/*", limit: "1mb" }));

/**
 * The mount point, exported so the URL an operator pastes into Slack, Meta, or
 * Azure is built from the same string the route is registered under. Two
 * copies of this path would drift, and the failure would be a bot that
 * silently receives nothing.
 */
export const CHAT_SURFACE_WEBHOOK_MOUNT = "/api/chat-surfaces/webhook";

/** Absolute delivery URL for one Connection, given the instance's public URL. */
export function chatSurfaceWebhookUrl(
  publicUrl: string,
  provider: string,
  connectionId: string,
): string {
  const origin = publicUrl.replace(/\/+$/, "");
  return `${origin}${CHAT_SURFACE_WEBHOOK_MOUNT}/${encodeURIComponent(provider)}/${encodeURIComponent(connectionId)}`;
}

/**
 * The only two path segments this surface takes. `provider` is checked against
 * the registry's own list (`CHAT_SURFACE_PROVIDER_IDS`, via the type guard) so
 * a typo cannot reach a lookup, and `connectionId` must be a uuid so a probe
 * cannot walk ids.
 */
export const chatSurfaceWebhookParamsSchema = z
  .object({
    provider: z.string().refine(isChatSurfaceProvider),
    connectionId: z.string().uuid(),
  })
  .strict();

export type ChatSurfaceWebhookTarget<C extends { provider: string }> = {
  connection: C;
  adapter: ChatSurfaceAdapter;
  webhook: ChatSurfaceWebhook;
};

/**
 * Decide whether this URL addresses a real delivery endpoint.
 *
 * Every way of failing returns the same `null`, and the route turns all of
 * them into a bare 404: an unknown provider, a connection that does not exist,
 * a connection belonging to a different provider, and a surface with no HTTP
 * half must be indistinguishable from outside. Anything else lets an
 * unauthenticated caller enumerate which Connection ids this installation
 * holds, which is the one thing an endpoint with no session can leak for free.
 */
export function resolveWebhookTarget<C extends { provider: string }>(args: {
  provider: ChatSurfaceProviderId;
  connection: C | null;
  adapter: ChatSurfaceAdapter | null;
}): ChatSurfaceWebhookTarget<C> | null {
  const { provider, connection, adapter } = args;
  if (!connection || connection.provider !== provider) return null;
  if (!adapter || !adapter.webhook) return null;
  return { connection, adapter, webhook: adapter.webhook };
}

export type ShapedWebhookResult = {
  response: ChatSurfaceWebhookResponse;
  /** Delivered after the response is written, never before it. */
  turns: InboundChatTurn[];
};

/**
 * Turn an adapter's verdict into an HTTP answer plus the work to do afterwards.
 *
 * Split out from the handler because the status a platform sees is the whole
 * retry contract: Slack redelivers an event it does not see acknowledged
 * within three seconds, and Meta retries anything that is not a 2xx. Getting
 * this wrong does not produce one bad reply, it produces a redelivery storm of
 * the same message.
 */
export function shapeWebhookResult(result: ChatSurfaceWebhookResult): ShapedWebhookResult {
  switch (result.kind) {
    case "respond":
      return { response: result.response, turns: [] };
    case "turns":
      return { response: { status: 200, body: "" }, turns: result.turns };
    case "reject":
      return {
        // A rejection that answered 2xx would tell the platform its delivery
        // landed. Floor it at 400 so a wrong status in an adapter degrades to
        // "refused" rather than to "silently dropped".
        response: { status: result.status >= 400 ? result.status : 400, body: "" },
        turns: [],
      };
    default:
      // A verdict this file does not recognise is not an acknowledgement.
      return { response: { status: 500, body: "" }, turns: [] };
  }
}

/**
 * Headers in the shape the adapter contract asks for.
 *
 * Two things this does that a cast would not. A header sent twice reaches Node
 * as an array; a signature is computed over exactly one value, so a duplicated
 * one is dropped rather than joined or first-won — verification then fails,
 * which is the correct answer to a request that cannot say what it signed. And
 * the result has a null prototype, because a delivery is free to name a header
 * `__proto__` and assigning that key onto an object literal would reach the
 * prototype setter instead of the map.
 */
export function normalizeWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

function writeResponse(res: Response, response: ChatSurfaceWebhookResponse): void {
  res.status(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  res.type(response.contentType ?? "text/plain");
  res.send(response.body);
}

async function loadTarget(
  provider: ChatSurfaceProviderId,
  connectionId: string,
): Promise<ChatSurfaceWebhookTarget<IntegrationConnection> | null> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  return resolveWebhookTarget({
    provider,
    connection,
    adapter: getChatSurfaceAdapter(provider),
  });
}

/**
 * The platform's ownership handshake — WhatsApp's `hub.challenge` today.
 *
 * A surface with no handshake answers 404 rather than an empty 200, because an
 * operator pasting this URL into the wrong console should be told it is the
 * wrong URL.
 */
chatSurfaceWebhooksRouter.get("/:provider/:connectionId", async (req, res, next) => {
  // Parsed here rather than through `validateParams` because a malformed path
  // has to look like a missing one: the middleware's 400 with zod issues would
  // answer a question this endpoint refuses to answer.
  const params = chatSurfaceWebhookParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(404).end();
  try {
    const target = await loadTarget(params.data.provider, params.data.connectionId);
    if (!target) return res.status(404).end();
    const response = target.webhook.verifyHandshake?.({
      config: decryptConnectionConfig(target.connection),
      query: req.query,
    });
    if (!response) return res.status(404).end();
    writeResponse(res, response);
  } catch (err) {
    next(err);
  }
});

chatSurfaceWebhooksRouter.post("/:provider/:connectionId", async (req, res, next) => {
  const params = chatSurfaceWebhookParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(404).end();
  const { provider, connectionId } = params.data;
  try {
    const target = await loadTarget(provider, connectionId);
    if (!target) return res.status(404).end();

    // A body the parser did not hand back as bytes is a body no signature can
    // be computed over. Pass the empty buffer and let verification refuse it,
    // rather than inventing a status here.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await target.webhook.verifyAndNormalize({
      connectionId,
      companyId: target.connection.companyId,
      config: decryptConnectionConfig(target.connection),
      rawBody,
      headers: normalizeWebhookHeaders(req.headers),
      query: req.query,
    });

    const { response, turns } = shapeWebhookResult(result);
    writeResponse(res, response);

    // Answer first, work second. A model turn takes seconds and Slack gives
    // the endpoint three of them before redelivering, so holding the response
    // open until the AI Employee has replied would turn one message into
    // several. The reply reaches the human over the platform's own send API,
    // not over this response.
    if (turns.length === 0) return;
    // One at a time, not Promise.all. A single WhatsApp delivery routinely
    // carries several messages from the same person, which means the same
    // Conversation: run concurrently, both turns race to create it, one loses
    // on the unique index, and that person's second question is silently
    // dropped. Sequential also keeps the transcript in the order it was sent,
    // which is the order the AI Employee should read it in.
    void (async () => {
      for (const turn of turns) {
        try {
          await handleInboundTurn(turn);
        } catch (err) {
          // Swallowed on purpose: the platform already has its 200, so a
          // throw here can only become an unhandled rejection. Nothing about
          // the delivery is logged beyond the ids.
          logSurfaceError(provider, connectionId, "inbound turn failed", err);
        }
      }
    })();
  } catch (err) {
    next(err);
  }
});
