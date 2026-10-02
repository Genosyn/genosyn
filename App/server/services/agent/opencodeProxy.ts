import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenCodeModel } from "./opencodeConfig.js";
import type { ModelOutage } from "./types.js";
import { endpointAnswers } from "../modelAvailability.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * How long one forwarded request waits for a self-hosted model server that has
 * stopped answering. OpenCode abandons a request that has no response headers
 * after five minutes, so the wait ends first, with a 503 asking for an
 * immediate retry; the retry waits again. With OpenCode's five retries, a
 * work turn rides out an outage of about 25 minutes.
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

/**
 * Forward provider wire traffic without exposing the real API key to native
 * coding commands. OpenCode still owns the provider SDK and complete model
 * loop; this endpoint only authenticates and forwards bytes for one turn.
 *
 * With `holdOutages`, a request to a self-hosted (custom) endpoint waits while
 * that server is down instead of failing: a model server restarting for an
 * upgrade or after a crash would otherwise end every Run working on it.
 */
export async function serveOpenCodeModel(
  model: OpenCodeModel,
  signal?: AbortSignal,
  options: {
    holdOutages?: boolean;
    onOutage?: (outage: ModelOutage) => void;
    holdMs?: number;
    probeMs?: number;
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
      let requestedModel: unknown;
      try {
        requestedModel = (JSON.parse(body.toString()) as { model?: unknown }).model;
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
        headers["x-api-key"] = model.apiKey;
        headers["anthropic-version"] =
          typeof req.headers["anthropic-version"] === "string"
            ? req.headers["anthropic-version"]
            : "2023-06-01";
        if (typeof req.headers["anthropic-beta"] === "string")
          headers["anthropic-beta"] = req.headers["anthropic-beta"];
      } else if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
      const send = () =>
        fetch(`${upstreamBase}${endpoint}`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });
      const response = holdOutages
        ? await sendThroughOutage({
            send,
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
      const responseHeaders: Record<string, string> = {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      };
      for (const name of ["retry-after", "retry-after-ms"]) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
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
    model: { ...model, apiKey: token, baseURL: `http://127.0.0.1:${address.port}` },
    async close() {
      for (const controller of controllers) controller.abort();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
