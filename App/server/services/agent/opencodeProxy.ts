import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { SELF_HOSTED_RESPONSE_WAIT_MS, type OpenCodeModel } from "./opencodeConfig.js";
import {
  classifyKeyRefusal,
  surfacedRefusal,
  type ApiKeyFailover,
  type ApiKeyRing,
  type KeyRefusal,
} from "./apiKeyRing.js";
import type { ModelOutage } from "./types.js";
import { endpointAnswers } from "../modelAvailability.js";
import { outboundAgent } from "../outboundNetworkPolicy.js";
import { listServedModels, type ServedModel } from "../servedModels.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * How long one forwarded request waits for a self-hosted model server that has
 * stopped answering. OpenCode abandons a request that has no response headers
 * after SELF_HOSTED_RESPONSE_WAIT_MS, so the wait ends first, with a 503 asking
 * for an immediate retry; the retry waits again. With OpenCode's five retries,
 * a work turn rides out an outage of about 25 minutes.
 */
export const OUTAGE_HOLD_MS = 4 * 60_000;
/** How often a held request asks whether the server answers again. */
export const OUTAGE_PROBE_MS = 5_000;
/** Statuses a gateway in front of a stopped model server answers with. */
const OUTAGE_STATUSES = new Set([502, 503, 504]);

/**
 * Send one request to a self-hosted model server, waiting while the server is
 * down. A refused or broken connection, or a gateway error while the server's
 * model list does not answer either, holds the request: the server is asked
 * again every few seconds and the request is sent again once it answers. Any
 * other response — including an error from a server that still answers —
 * returns at once, because waiting would not change it. Returns null when the
 * server has not answered within `holdMs`.
 */
export async function sendThroughOutage(args: {
  send: () => Promise<Response>;
  answers: () => Promise<boolean>;
  signal: AbortSignal;
  holdMs?: number;
  probeMs?: number;
  onWait?: () => void;
}): Promise<Response | null> {
  const holdMs = args.holdMs ?? OUTAGE_HOLD_MS;
  const probeMs = args.probeMs ?? OUTAGE_PROBE_MS;
  const started = Date.now();
  for (;;) {
    let response: Response | null = null;
    try {
      response = await args.send();
    } catch (error) {
      if (args.signal.aborted) throw error;
    }
    if (response && !OUTAGE_STATUSES.has(response.status)) return response;
    if (response && (await args.answers())) return response;
    await response?.body?.cancel().catch(() => {});
    args.onWait?.();
    for (;;) {
      if (Date.now() - started >= holdMs) return null;
      await sleep(probeMs, undefined, { signal: args.signal });
      if (await args.answers()) break;
    }
  }
}

/** The one model a server serves, when it is not `current`; null otherwise. */
async function soleOtherServedModel(
  baseURL: string,
  apiKey: string,
  current: string,
): Promise<ServedModel | null> {
  try {
    const served = await listServedModels(baseURL, apiKey);
    return served.length === 1 && served[0].id !== current ? served[0] : null;
  } catch {
    return null;
  }
}

/** The request body with its model replaced; unreadable bodies are sent as they are. */
function withModel(body: Buffer<ArrayBuffer>, id: string): Buffer<ArrayBuffer> {
  try {
    return Buffer.from(JSON.stringify({ ...(JSON.parse(body.toString()) as object), model: id }));
  } catch {
    return body;
  }
}

/**
 * A Claude request that ends on the user's turn, or null when it already does.
 * On a turn's last allowed step OpenCode appends its "maximum steps reached"
 * instruction as an assistant message, which Claude reads as a prefill to
 * continue. Claude Opus 4.6, Sonnet 4.6 and every later model reject a prefill
 * with a 400, so each turn that reached its step limit failed on them — the
 * connection test, which allows two steps, on every connect. A text-only
 * trailing assistant message is sent as a user message instead, which every
 * Claude model accepts. One with tool calls is left alone: only an assistant
 * may make those.
 */
export function endOnUserTurn(request: Record<string, unknown>): Record<string, unknown> | null {
  const messages = request.messages;
  if (!Array.isArray(messages)) return null;
  const last = messages.at(-1) as { role?: unknown; content?: unknown } | undefined;
  if (last?.role !== "assistant") return null;
  const textOnly =
    typeof last.content === "string" ||
    (Array.isArray(last.content) &&
      last.content.length > 0 &&
      last.content.every((block) => (block as { type?: unknown } | null)?.type === "text"));
  if (!textOnly) return null;
  return { ...request, messages: [...messages.slice(0, -1), { ...last, role: "user" }] };
}

/** What one request sent on an AI Model's API keys came back with. */
export type KeyRingOutcome =
  /** An answer to stream on, its body still unread. */
  | { kind: "response"; response: Response }
  /** An error to send on as it is, already read. */
  | { kind: "error"; status: number; headers: Headers; body: string };

/**
 * Send one model request on an AI Model's API keys in turn (see
 * `apiKeyRing.ts`). When the provider refuses the key itself, the key rests
 * and the very same request goes out on the next key; any other answer —
 * success, or an error about the request or the service — ends it there.
 *
 * Nothing reaches the caller until the outcome is settled: a success comes
 * back with its body unread, for the caller to stream, so a request only ever
 * moves to another key before the first byte of a reply has been sent on.
 * When every key is refused, the outcome is the provider's own refusal that
 * {@link surfacedRefusal} picks.
 */
export async function sendOnKeyRing(args: {
  ring: ApiKeyRing;
  send: (apiKey: string) => Promise<Response>;
  onFailover?: (change: ApiKeyFailover, refusedKeyId: string) => void;
}): Promise<KeyRingOutcome> {
  const order = args.ring.attemptOrder();
  const refused: Array<{ refusal: KeyRefusal; status: number; headers: Headers; body: string }> =
    [];
  for (const [index, key] of order.entries()) {
    const response = await args.send(key.apiKey);
    if (response.status < 400) {
      // Health is saved in the background; the reply streams on at once.
      void args.ring.succeeded(key);
      return { kind: "response", response };
    }
    const body = await response.text();
    const refusal = classifyKeyRefusal({
      status: response.status,
      body,
      headers: response.headers,
    });
    if (!refusal)
      return { kind: "error", status: response.status, headers: response.headers, body };
    void args.ring.refused(key, refusal);
    refused.push({ refusal, status: response.status, headers: response.headers, body });
    const next = order[index + 1];
    if (next)
      args.onFailover?.(
        { from: key.preview, to: next.preview, status: response.status, kind: refusal.kind },
        key.id,
      );
  }
  const surfaced = surfacedRefusal(refused);
  return { kind: "error", status: surfaced.status, headers: surfaced.headers, body: surfaced.body };
}

/** The headers of a provider's answer that OpenCode is told about. */
function forwardedHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {
    "Content-Type": headers.get("content-type") ?? "application/json",
  };
  for (const name of ["retry-after", "retry-after-ms"]) {
    const value = headers.get(name);
    if (value) forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Forward provider wire traffic without exposing the real API key to native
 * coding commands. OpenCode still owns the provider SDK and complete model
 * loop; this endpoint only authenticates and forwards bytes for one turn.
 *
 * An API-key AI Model's requests go out on its key ring: a key the provider
 * refuses — invalid, forbidden, out of credit, rate-limited — hands the same
 * request to the next key before anything reaches OpenCode (see
 * `sendOnKeyRing`). `onKeyFailover` hears each such move once per key and
 * turn, by preview; every key is redacted from what the provider says back.
 *
 * With `holdOutages`, a request to a self-hosted (custom) endpoint waits while
 * that server is down instead of failing: a model server restarting for an
 * upgrade or after a crash would otherwise end every Run working on it.
 *
 * A custom endpoint that answers 404 for the model, while serving exactly one
 * other model, has been restarted with that model; every turn moves to it
 * rather than failing on the old id (see `services/servedModels.ts`).
 *
 * A Claude request that would end on an assistant message is sent ending on
 * the user's turn instead (see `endOnUserTurn`).
 */
export async function serveOpenCodeModel(
  model: OpenCodeModel,
  signal?: AbortSignal,
  options: {
    holdOutages?: boolean;
    onOutage?: (outage: ModelOutage) => void;
    onServedModelChange?: (change: { from: string; to: ServedModel }) => void;
    onKeyFailover?: (change: ApiKeyFailover) => void;
    holdMs?: number;
    probeMs?: number;
    /** Tests only: overrides SELF_HOSTED_RESPONSE_WAIT_MS. */
    responseWaitMs?: number;
  } = {},
): Promise<{
  model: OpenCodeModel;
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
  const controllers = new Set<AbortController>();
  const holdOutages = options.holdOutages === true && model.provider === "custom";
  // OpenCode sends one model request at a time, and a held request is retried
  // as a new one, so the outage is tracked across requests.
  let outageSince: number | null = null;
  // The model the server serves now, once it no longer serves `model.id`.
  let servedId: string | null = null;
  // Each refused key is reported once a turn, however many requests it fails.
  const reportedFailovers = new Set<string>();
  const reportFailover = (change: ApiKeyFailover, refusedKeyId: string) => {
    if (reportedFailovers.has(refusedKeyId)) return;
    reportedFailovers.add(refusedKeyId);
    options.onKeyFailover?.(change);
  };
  // A self-hosted server may take longer than undici's five minutes to start
  // answering (see SELF_HOSTED_RESPONSE_WAIT_MS); hosted APIs keep the default.
  const dispatcher =
    model.provider === "custom"
      ? outboundAgent({
          pipelining: 0,
          headersTimeout: options.responseWaitMs ?? SELF_HOSTED_RESPONSE_WAIT_MS,
          bodyTimeout: options.responseWaitMs ?? SELF_HOSTED_RESPONSE_WAIT_MS,
        })
      : undefined;
  const upstreamBase =
    model.baseURL ??
    (model.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
  const endpoint =
    model.provider === "anthropic"
      ? "/messages"
      : model.provider === "openai"
        ? "/responses"
        : "/chat/completions";
  const http = createServer((req, res) => {
    const suppliedKey =
      model.provider === "anthropic"
        ? req.headers["x-api-key"]
        : req.headers.authorization?.replace(/^Bearer /, "");
    const supplied = Buffer.from(typeof suppliedKey === "string" ? suppliedKey : "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== endpoint) {
      res.writeHead(404).end();
      return;
    }
    if (signal?.aborted) {
      res.writeHead(409).end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    res.once("close", abort);
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_REQUEST_BYTES) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      let request: Record<string, unknown>;
      let requestedModel: unknown;
      try {
        request = JSON.parse(body.toString()) as Record<string, unknown>;
        requestedModel = request.model;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (requestedModel !== model.id) {
        res.writeHead(403).end();
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.provider === "anthropic") {
        headers["anthropic-version"] =
          typeof req.headers["anthropic-version"] === "string"
            ? req.headers["anthropic-version"]
            : "2023-06-01";
        if (typeof req.headers["anthropic-beta"] === "string")
          headers["anthropic-beta"] = req.headers["anthropic-beta"];
      }
      const withKey = (apiKey: string): Record<string, string> =>
        model.provider === "anthropic"
          ? { ...headers, "x-api-key": apiKey }
          : apiKey
            ? { ...headers, Authorization: `Bearer ${apiKey}` }
            : headers;
      const userTurn = model.provider === "anthropic" ? endOnUserTurn(request) : null;
      const sent = userTurn ? Buffer.from(JSON.stringify(userTurn)) : body;
      let outgoing = servedId ? withModel(sent, servedId) : sent;
      const send = (apiKey = model.apiKey) => {
        const init = {
          method: "POST",
          headers: withKey(apiKey),
          body: outgoing,
          signal: controller.signal,
          redirect: "manual" as const,
          ...(dispatcher ? { dispatcher } : {}),
        };
        return fetch(`${upstreamBase}${endpoint}`, init);
      };
      let response: Response | null;
      if (model.keys) {
        const ring = model.keys;
        const outcome = await sendOnKeyRing({ ring, send, onFailover: reportFailover });
        if (outcome.kind === "error") {
          // OpenCode keeps an error's body to report what the provider said, and
          // a provider may quote the key it was sent. Every key stays in Genosyn.
          res
            .writeHead(outcome.status, forwardedHeaders(outcome.headers))
            .end(ring.redact(outcome.body));
          return;
        }
        response = outcome.response;
      } else {
        response = holdOutages
          ? await sendThroughOutage({
              send: () => send(),
              answers: () => endpointAnswers(upstreamBase, model.apiKey),
              signal: controller.signal,
              holdMs: options.holdMs,
              probeMs: options.probeMs,
              onWait: () => {
                if (outageSince !== null) return;
                outageSince = Date.now();
                options.onOutage?.({ state: "waiting", waitedMs: 0 });
              },
            })
          : await send();
        if (!response) {
          res
            .writeHead(503, { "Content-Type": "application/json", "retry-after-ms": "1000" })
            .end(JSON.stringify({ error: { message: "The AI Model's server is not answering." } }));
          return;
        }
        if (outageSince !== null) {
          options.onOutage?.({ state: "answered", waitedMs: Date.now() - outageSince });
          outageSince = null;
        }
        if (model.provider === "custom" && response.status === 404) {
          const sent = servedId ?? model.id;
          const next = await soleOtherServedModel(upstreamBase, model.apiKey, sent);
          if (next) {
            await response.body?.cancel().catch(() => {});
            servedId = next.id;
            outgoing = withModel(body, next.id);
            options.onServedModelChange?.({ from: sent, to: next });
            response = await send();
          }
        }
      }
      const responseHeaders = forwardedHeaders(response.headers);
      if (response.status >= 400 && model.apiKey.length >= 8) {
        // OpenCode keeps an error's body to report what the provider said, and
        // a provider may quote the key it was sent. The key stays in Genosyn.
        // A self-hosted server's placeholder such as "EMPTY" is no secret, and
        // replacing it everywhere would garble what the server said.
        const text = await response.text();
        res
          .writeHead(response.status, responseHeaders)
          .end(text.split(model.apiKey).join("[redacted]"));
        return;
      }
      res.writeHead(response.status, responseHeaders);
      if (!response.body) {
        res.end();
        return;
      }
      const readable = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      readable.on("error", () => res.destroy());
      readable.pipe(res);
      await new Promise<void>((resolve) => res.once("close", resolve));
    })()
      .catch(() => {
        if (!res.headersSent)
          res
            .writeHead(502, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({ error: { message: "The AI Model endpoint could not be reached." } }),
            );
        else res.destroy();
      })
      .finally(() => {
        controllers.delete(controller);
        signal?.removeEventListener("abort", abort);
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the AI Model forwarding endpoint.");
  return {
    // Built field by field: the key ring, with every real key, stays here.
    model: {
      id: model.id,
      provider: model.provider,
      apiKey: token,
      baseURL: `http://127.0.0.1:${address.port}`,
      contextWindow: model.contextWindow,
    },
    async close() {
      for (const controller of controllers) controller.abort();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await dispatcher?.destroy().catch(() => {});
    },
  };
}
