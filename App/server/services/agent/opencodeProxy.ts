import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { OpenCodeModel } from "./opencodeConfig.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * Forward provider wire traffic without exposing the real API key to native
 * coding commands. OpenCode still owns the provider SDK and complete model
 * loop; this endpoint only authenticates and forwards bytes for one turn.
 */
export async function serveOpenCodeModel(
  model: OpenCodeModel,
  signal?: AbortSignal,
): Promise<{
  model: OpenCodeModel;
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
  const controllers = new Set<AbortController>();
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
      const response = await fetch(`${upstreamBase}${endpoint}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
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
