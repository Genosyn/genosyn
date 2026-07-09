import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appVersion } from "../../../lib/version.js";
import type { AgentTool, ToolResult, ToolResultImage } from "../types.js";

/**
 * MCP client bridge.
 *
 * The harnesses used to be the MCP *client* — they read a config file we wrote
 * and connected to each server. Now Genosyn is the client: for every MCP server
 * an employee has (the built-in `browser` server, and any company-configured
 * stdio/HTTP servers) we open a connection, list its tools, and surface them to
 * the model as {@link AgentTool}s. Tool calls are forwarded to the server and
 * its result text handed back to the loop.
 *
 * The built-in `genosyn` server is NOT bridged here — it runs fully in-process
 * (see ./genosyn.ts). Only servers that are genuinely separate processes/hosts
 * go through this bridge.
 */

export type McpServerSpec =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export type BridgedServer = {
  /** The tools this server exposes, ready to hand to the model. */
  tools: AgentTool[];
  /** Tear down the connection (and the child process, for stdio). */
  close: () => Promise<void>;
};

/**
 * Connect to one MCP server and expose its tools. `namePrefix` is prepended to
 * every tool name (with `__`) to avoid collisions between servers; pass an empty
 * string to keep native names (used for the browser server, whose `browser_*`
 * names are referenced directly in prompts).
 *
 * Failures are swallowed into an empty tool set — a broken user server must not
 * take down the whole turn — with the reason logged to stderr.
 */
export async function connectMcpServer(
  label: string,
  spec: McpServerSpec,
  namePrefix: string,
  signal?: AbortSignal,
): Promise<BridgedServer> {
  const client = new Client({ name: "genosyn", version: appVersion() });

  try {
    if (spec.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        // MCP's stdio transport uses a restricted default env; merge the parent
        // env so the child (e.g. the browser server) sees GENOSYN_* + PATH.
        env: mergeEnv(spec.env),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: spec.headers ? { headers: spec.headers } : undefined,
      });
      await client.connect(transport);
    }
  } catch (err) {
    process.stderr.write(
      `[agent] MCP server "${label}" failed to connect: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    try {
      await client.close();
    } catch {
      // already down
    }
    return { tools: [], close: async () => {} };
  }

  let listed: Awaited<ReturnType<Client["listTools"]>>;
  try {
    listed = await client.listTools();
  } catch (err) {
    process.stderr.write(
      `[agent] MCP server "${label}" tools/list failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return { tools: [], close: async () => {} };
  }

  const tools: AgentTool[] = (listed.tools ?? []).map((t) => {
    return {
      name: exposedToolName(namePrefix, t.name),
      description: t.description ?? `${label} tool`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      run: (input) => callBridged(client, t.name, input, signal),
    };
  });

  return {
    tools,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best-effort teardown
      }
    },
  };
}

async function callBridged(
  client: Client,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const res = await client.callTool(
      { name: toolName, arguments: input },
      undefined,
      signal ? { signal } : undefined,
    );
    const { text, images } = splitContent(res.content);
    return {
      content: text,
      isError: res.isError === true,
      ...(images.length > 0 ? { images } : {}),
    };
  } catch (err) {
    return {
      content: `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

/**
 * Split an MCP tool result's content array into text (for the model to read)
 * and images (e.g. a browser screenshot) so the caller can attach the pixels to
 * the tool result rather than dropping them.
 */
function splitContent(content: unknown): { text: string; images: ToolResultImage[] } {
  const parts: string[] = [];
  const images: ToolResultImage[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; data?: string; mimeType?: string };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "image" && typeof b.data === "string") {
        images.push({
          mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
          data: b.data,
        });
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  return { text: parts.join("\n"), images };
}

/**
 * Namespace a bridged tool name within the 1–64 char `[A-Za-z0-9_-]` budget both
 * provider APIs enforce. The prefix is capped so the tool's own name always
 * survives — a long server name must not truncate every tool down to one
 * identical string. A final dedup pass in gatherEmployeeTools resolves any
 * residual clashes.
 */
function exposedToolName(prefix: string, toolName: string): string {
  const tool = sanitizeChars(toolName);
  if (!prefix) return tool.slice(0, 64) || "tool";
  const p = sanitizeChars(prefix).slice(0, 24);
  return `${p}__${tool}`.slice(0, 64);
}

function sanitizeChars(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  Object.assign(out, extra);
  return out;
}
