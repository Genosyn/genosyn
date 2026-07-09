import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appVersion } from "../../../lib/version.js";
import type { AgentTool, ToolResult } from "../types.js";

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
    const exposedName = namePrefix ? `${namePrefix}__${t.name}` : t.name;
    return {
      name: sanitizeToolName(exposedName),
      description: t.description ?? `${label} tool`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      run: (input) => callBridged(client, t.name, input),
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
): Promise<ToolResult> {
  try {
    const res = await client.callTool({ name: toolName, arguments: input });
    return { content: flattenContent(res.content), isError: res.isError === true };
  } catch (err) {
    return {
      content: `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

/** Flatten an MCP tool result's content array down to text for the model. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image") {
      parts.push("[image omitted]");
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n") || "(no output)";
}

/** Tool names must match `^[a-zA-Z0-9_-]{1,64}$` for both provider APIs. */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  Object.assign(out, extra);
  return out;
}
