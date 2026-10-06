import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { registryResultNotice, type ToolRegistry } from "./tools/toolRegistry.js";
import type { StreamCallbacks, ToolResult } from "./types.js";

/** OpenCode adds genosyn_ to MCP names; OpenAI's complete name limit is 64. */
export function openCodeToolNames(names: Iterable<string>): Map<string, string> {
  const mapped = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    let wire = name;
    let salt = 0;
    while (wire.length > 56 || used.has(wire)) {
      const hash = createHash("sha256").update(`${name}:${salt++}`).digest("hex").slice(0, 12);
      wire = `${name.slice(0, 43)}_${hash}`;
    }
    used.add(wire);
    mapped.set(name, wire);
  }
  return mapped;
}

/** A disposable, authenticated MCP endpoint over the already-authorized registry. */
export async function serveOpenCodeTools(args: {
  registry: ToolRegistry;
  callbacks?: StreamCallbacks;
  signal?: AbortSignal;
  beforeCall?: (wireName: string) => Promise<void>;
}): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const wireNames = openCodeToolNames(args.registry.all.keys());
  const originalNames = new Map([...wireNames].map(([original, wire]) => [wire, original]));
  const active = new Set<Server>();
  // Stateless HTTP uses a fresh Server for every POST, including cancellation
  // notifications. Keep request identity at the endpoint boundary so a timeout
  // can cancel the original queued call instead of an unrelated new Server.
  const requests = new Map<RequestId, AbortController>();
  let pending = Promise.resolve();
  let closed = false;
  const http = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = new Server({ name: "genosyn", version: "1" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: args.registry.resident.map((tool) => ({
        name: wireNames.get(tool.name)!,
        description: `${tool.description}${wireNames.get(tool.name) !== tool.name ? ` Genosyn tool name: ${tool.name}.` : ""}`,
        inputSchema: { ...tool.inputSchema, type: "object" as const },
        annotations: { readOnlyHint: tool.readOnly ?? false },
      })),
    }));
    server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
      if (params.requestId !== undefined) requests.get(params.requestId)?.abort();
    });
    server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => {
      const tool = args.registry.resolve(originalNames.get(params.name) ?? params.name);
      if (!tool) throw new Error(`Unknown Genosyn tool: ${params.name}`);
      if (requests.has(extra.requestId)) throw new Error("Duplicate Genosyn tool request.");
      const input = params.arguments ?? {};
      // Scheduling comes from the actual registry target, never logging prose
      // supplied by describeCall. Deferred calls preserve the same policy.
      const target = tool.name === "call_tool" && typeof input.name === "string"
        ? args.registry.resolve(input.name.trim())
        : tool;
      const controller = new AbortController();
      requests.set(extra.requestId, controller);
      const requestSignal = AbortSignal.any([
        controller.signal,
        extra.signal,
      ]);
      const executionSignal = args.signal
        ? AbortSignal.any([requestSignal, args.signal])
        : requestSignal;
      // Consume each streamed observation even when its request is canceled
      // while queued. Otherwise a stale gate credit could authorize the next
      // call with the same name before that call's own event arrives.
      const ready = Promise.resolve().then(() => args.beforeCall?.(params.name));
      void ready.catch(() => {});
      // Company tools retain their ordered side effects even when OpenCode
      // issues several MCP requests concurrently. Delegation waits join earlier
      // writes but do not hold the lane: their workers already have independent
      // registries, and the parent must be able to recover their saved results.
      const execution = pending.then(async () => {
        if (closed || args.signal?.aborted) throw new Error("The Genosyn turn has ended.");
        await whileRequestActive(ready, executionSignal);
        if (closed || args.signal?.aborted) throw new Error("The Genosyn turn has ended.");
        requestSignal.throwIfAborted();
        let described = { name: tool.name, input };
        try {
          described = tool.describeCall?.(input) ?? described;
        } catch {
          // Logging metadata must not prevent the authorized tool call.
        }
        const callId = randomUUID();
        args.callbacks?.onToolUse?.(described.name, described.input, callId);
        let result: ToolResult;
        try {
          result = await tool.run(input);
        } catch (error) {
          result = {
            content: error instanceof Error ? error.message : "The tool failed.",
            isError: true,
          };
        }
        args.callbacks?.onToolResult?.(described.name, result, callId);
        const notice = registryResultNotice(args.registry);
        return {
          isError: result.isError,
          content: [
            { type: "text" as const, text: result.content },
            ...(result.images ?? []).map((img) => ({
              type: "image" as const,
              mimeType: img.mimeType,
              data: img.data,
            })),
            ...(notice ? [{ type: "text" as const, text: notice }] : []),
          ],
        };
      });
      if (target?.executionLane !== "delegation")
        pending = execution.then(
          () => {},
          () => {},
        );
      // Cancellation stops waiting, not an already-started side effect. Keep
      // the ordered lane occupied until that operation really settles, while
      // preventing every canceled queued operation from starting afterward.
      return whileRequestActive(execution, requestSignal).finally(() => {
        if (requests.get(extra.requestId) === controller) requests.delete(extra.requestId);
      });
    });
    res.once("close", () => {
      active.delete(server);
      void server.close().catch(() => {});
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
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
    throw new Error("Could not start the Genosyn tool endpoint.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    async close() {
      closed = true;
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      await Promise.allSettled([...active].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function whileRequestActive<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("The Genosyn tool request was canceled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
