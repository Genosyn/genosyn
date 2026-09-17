import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./tools/toolRegistry.js";
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
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      // Company tools retain their ordered side effects even when OpenCode
      // issues several MCP requests concurrently. Native coding remains owned
      // by OpenCode; this queue only orders the Genosyn registry boundary.
      const execution = pending.then(async () => {
        if (closed || args.signal?.aborted) throw new Error("The Genosyn turn has ended.");
        await args.beforeCall?.(params.name);
        if (closed || args.signal?.aborted) throw new Error("The Genosyn turn has ended.");
        const tool = args.registry.resolve(originalNames.get(params.name) ?? params.name);
        if (!tool) throw new Error(`Unknown Genosyn tool: ${params.name}`);
        const input = params.arguments ?? {};
        const described = tool.describeCall?.(input) ?? { name: tool.name, input };
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
        return {
          isError: result.isError,
          content: [
            { type: "text" as const, text: result.content },
            ...(result.images ?? []).map((img) => ({
              type: "image" as const,
              mimeType: img.mimeType,
              data: img.data,
            })),
          ],
        };
      });
      pending = execution.then(
        () => {},
        () => {},
      );
      return execution;
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
      await Promise.allSettled([...active].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
