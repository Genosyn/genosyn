import type { AgentTool } from "../types.js";
import { codingTools, type CodingToolContext } from "./coding.js";
import { loadGenosynTools } from "./genosyn.js";
import { connectMcpServer, type BridgedServer } from "./mcpBridge.js";
import {
  browserServerSpec,
  loadBrowserConfig,
  loadUserServerSpecs,
  type BrowserConfig,
} from "./mcpSources.js";

/**
 * Assemble the full tool list an employee's agent can call this turn:
 *
 *   1. the built-in coding toolset (bash + file editing), in-process;
 *   2. the built-in `genosyn` tools (routines, todos, journal, memory, bases,
 *      attachments, integrations), in-process over loopback with `genosynToken`;
 *   3. the built-in `browser` tools (when enabled), bridged from a stdio child;
 *   4. every company-configured MCP server, bridged over stdio/HTTP.
 *
 * Returns the merged tools plus a `close()` that tears down the bridged
 * connections — the caller MUST call it once the turn finishes.
 */
export async function gatherEmployeeTools(params: {
  employeeId: string;
  genosynToken: string;
  cwd: string;
  /** Env for the bash tool (company secrets + materialized repo vars). */
  toolEnv: Record<string, string>;
  bashTimeoutMs: number;
  routineId?: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
}): Promise<{ tools: AgentTool[]; browser: BrowserConfig; close: () => Promise<void> }> {
  const codingCtx: CodingToolContext = {
    cwd: params.cwd,
    env: params.toolEnv,
    bashTimeoutMs: params.bashTimeoutMs,
    signal: params.signal,
  };

  // 1 + 2: in-process tools (no teardown needed).
  const [genosyn, browser, userServers] = await Promise.all([
    loadGenosynTools(params.genosynToken, params.signal),
    loadBrowserConfig(params.employeeId, {
      routineId: params.routineId,
      conversationId: params.conversationId,
      runId: params.runId,
    }),
    loadUserServerSpecs(params.employeeId),
  ]);

  const tools: AgentTool[] = [...codingTools(codingCtx), ...genosyn];
  const bridged: BridgedServer[] = [];

  // 3: browser server (bridged stdio child) when enabled.
  if (browser.enabled) {
    const b = await connectMcpServer(
      "browser",
      browserServerSpec(browser, params.genosynToken),
      "", // keep native browser_* names (referenced in prompts)
      params.signal,
    );
    bridged.push(b);
    tools.push(...b.tools);
  }

  // 4: company-configured MCP servers, each namespaced by server name.
  const connections = await Promise.all(
    userServers.map((s) => connectMcpServer(s.name, s.spec, s.name, params.signal)),
  );
  for (const c of connections) {
    bridged.push(c);
    tools.push(...c.tools);
  }

  // Provider APIs reject duplicate or over-length tool names with a 400 that
  // fails the whole turn — dedup across every source (coding/genosyn/browser/
  // user, plus integration labels) so that can never happen.
  dedupeToolNames(tools);

  return {
    tools,
    browser,
    close: async () => {
      await Promise.all(bridged.map((b) => b.close()));
    },
  };
}

/**
 * Make every tool's model-facing name unique and ≤64 chars. Renaming only the
 * exposed `name` is safe: each tool dispatches inside its own `run` closure,
 * which captured the real target when it was built.
 */
function dedupeToolNames(tools: AgentTool[]): void {
  const seen = new Set<string>();
  for (const t of tools) {
    let name = t.name.slice(0, 64) || "tool";
    if (seen.has(name)) {
      let n = 2;
      let candidate = withSuffix(name, n);
      while (seen.has(candidate)) candidate = withSuffix(name, ++n);
      name = candidate;
    }
    t.name = name;
    seen.add(name);
  }
}

function withSuffix(name: string, n: number): string {
  const suffix = `_${n}`;
  return name.slice(0, 64 - suffix.length) + suffix;
}
