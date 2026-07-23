import type { AgentTool } from "../types.js";
import { codingTools, type CodingToolContext } from "./coding.js";
import { deadToolNames } from "./grantDead.js";
import { loadGenosynTools } from "./genosyn.js";
import { connectMcpServer, type BridgedServer } from "./mcpBridge.js";
import { DISCOVERY_TOOL_NAMES, discoveryTools } from "./discovery.js";
import { domainOf } from "./toolIndex.js";
import { buildRegistry, type ToolRegistry } from "./toolRegistry.js";
import {
  browserServerSpec,
  loadBrowserConfig,
  loadUserServerSpecs,
  type BrowserConfig,
} from "./mcpSources.js";
import { config } from "../../../../config.js";

/**
 * Assemble the tools an employee's agent can reach this turn, and split them
 * into what the model is shown and what it has to look up.
 *
 * Sources, in order:
 *   1. the built-in coding toolset (bash + file editing), in-process;
 *   2. the built-in `genosyn` tools, in-process over loopback with `genosynToken`;
 *   3. the built-in `browser` tools (when enabled), bridged from a stdio child;
 *   4. every company-configured MCP server, bridged over stdio/HTTP.
 *
 * Returns a {@link ToolRegistry} plus a `close()` that tears down the bridged
 * connections — the caller MUST call it once the turn finishes, because the
 * registry holds references to those closures.
 */

/**
 * The working set: genosyn tools sent to the model on every request.
 *
 * This list is a judgement about *consequence*, not frequency. Three rules
 * decided it, and each is preventing a specific failure:
 *
 * - **Every write tool stays.** `toolsBriefing()` exists because models like to
 *   *say* they scheduled a routine without calling anything. Deferring
 *   `create_routine` behind a lookup makes narrating strictly cheaper than
 *   doing, which is the one behaviour that briefing is there to counter.
 * - **`update_routine` stays because `create_routine` does.** Both briefings
 *   spend their strongest sentence on "never create a duplicate to change one".
 *   Making the create free and the update a lookup away engineers exactly that
 *   duplicate.
 * - **`send_chat_attachment` stays** for the same shape of reason: if sending
 *   the file costs a round-trip and describing it does not, the model
 *   describes it.
 *
 * Coding and browser tools are resident too, but for a different reason — see
 * where they are added below.
 */
export const RESIDENT_GENOSYN_TOOLS = [
  // writes — deferring these makes narrating cheaper than doing
  "create_routine",
  "update_routine",
  "delete_routine",
  "create_project",
  "create_todo",
  "update_todo",
  "add_journal_entry",
  // orientation — small, and the model needs them to know what it is
  "get_self",
  "list_employees",
  "list_routines",
  // always hot
  "memory",
  "send_chat_attachment",
];

export async function gatherEmployeeTools(params: {
  employeeId: string;
  genosynToken: string;
  cwd: string;
  /** Runtime-local tools (for example bounded parallel delegation). */
  localTools?: AgentTool[];
  /** Env for the bash tool (company secrets + materialized repo vars). */
  toolEnv: Record<string, string>;
  bashTimeoutMs: number;
  /** Model-facing names a Skill's declared toolset asked to keep resident. */
  skillToolset?: string[];
  routineId?: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  /** Called when a Soul, Skill or brief reached for a retired family name. */
  onDeprecatedFamily?: (family: string, target: string) => void;
}): Promise<{ registry: ToolRegistry; browser: BrowserConfig; close: () => Promise<void> }> {
  const codingCtx: CodingToolContext = {
    cwd: params.cwd,
    env: params.toolEnv,
    bashTimeoutMs: params.bashTimeoutMs,
    signal: params.signal,
  };

  // 1 + 2: in-process tools (no teardown needed).
  const [genosyn, browser, userServers] = await Promise.all([
    loadGenosynTools(params.genosynToken, params.signal, params.onDeprecatedFamily),
    loadBrowserConfig(params.employeeId, {
      routineId: params.routineId,
      conversationId: params.conversationId,
      runId: params.runId,
    }),
    loadUserServerSpecs(params.employeeId),
  ]);

  const codingEnabled =
    config.agent.codingTools.enabled && config.agent.codingTools.executionMode !== "disabled";
  const coding = codingEnabled ? codingTools(codingCtx) : [];

  const tools: AgentTool[] = [...(params.localTools ?? []), ...coding, ...genosyn.tools];
  const bridged: BridgedServer[] = [];

  // 3: browser server (bridged stdio child) when enabled.
  const browserNames = new Set<string>();
  if (browser.enabled) {
    const b = await connectMcpServer(
      "browser",
      browserServerSpec(browser, params.genosynToken),
      "", // keep native browser_* names (referenced in prompts)
      params.signal,
    );
    bridged.push(b);
    for (const t of b.tools) browserNames.add(t.name);
    tools.push(...b.tools);
  }

  // 4: company-configured MCP servers, each namespaced by server name.
  // A server's guarded tools (McpServer.guardedToolsJson patterns) queue an
  // Approval instead of executing — the guard closure was bound in
  // loadUserServerSpecs.
  const connections = await Promise.all(
    userServers.map((s) => connectMcpServer(s.name, s.spec, s.name, params.signal, s.guard)),
  );
  for (const c of connections) {
    bridged.push(c);
    tools.push(...c.tools);
  }

  // Provider APIs reject duplicate or over-length tool names with a 400 that
  // fails the whole turn — dedup across every source (coding/genosyn/browser/
  // user, plus integration labels) so that can never happen. The discovery
  // names are reserved: a user MCP server exposing `find_tools` would otherwise
  // push ours to `find_tools_2` and turn every briefing sentence into a lie.
  dedupeToolNames(tools, DISCOVERY_TOOL_NAMES);

  // Ordering only, and it still runs on the whole array: if `trimToProviderCap`
  // ever has to cut, it should cut the tools that could only have returned 403.
  const grantDead = await deadToolNames(params.employeeId);
  sinkGrantDeadTools(tools, grantDead);

  const close = async () => {
    await Promise.all(bridged.map((b) => b.close()));
  };

  const resolveAny = (name: string): AgentTool | undefined =>
    tools.find((t) => t.name === name) ?? genosyn.aliases.find((a) => a.name === name);

  // The revert path is one branch rather than a flag threaded through the
  // partition: everything resident is exactly the behaviour that shipped before
  // deferral existed, which is the only kind of revert worth having.
  const discovery = config.agent.toolDiscovery;
  if (!discovery.enabled || tools.length < discovery.minCatalogueSize) {
    return {
      registry: buildRegistry({
        resident: tools,
        deferred: [],
        aliases: genosyn.aliases,
        domains: [],
        fromSkills: [],
      }),
      browser,
      close,
    };
  }

  const wanted = new Set([
    ...RESIDENT_GENOSYN_TOOLS,
    // Coding tools stay resident because of *argument shape*, not frequency:
    // `write_file.content` and `edit_file.old_string` are large free-form
    // strings, and re-escaping a 20k-char file body inside `call_tool`'s
    // `args_json` is where models drop escapes.
    ...coding.map((t) => t.name),
    // Delegation is the parent's only way to fan work out, and a worker that
    // never got delegated is indistinguishable from one that failed.
    ...(params.localTools ?? []).map((t) => t.name),
    // Browser stays whole when enabled: it is a snapshot-per-action loop where
    // an extra dispatch hop would land on every click, its names are referenced
    // literally in the UI and docs, and it does not grow with the product.
    ...browserNames,
  ]);

  const requestedBySkills = (params.skillToolset ?? []).filter((n) => !wanted.has(n));
  for (const n of requestedBySkills) wanted.add(n);

  const resident: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const t of tools) {
    if (wanted.has(t.name)) resident.push(t);
    else deferred.push(t);
  }

  // Discovery is built last because it closes over the deferred set, and goes
  // first in the resident list because it is the door to everything behind it.
  const meta = discoveryTools({ searchable: deferred, resolve: resolveAny, grantDead });
  resident.unshift(...meta);

  const domains = [...new Set(deferred.map((t) => domainOf(t.name) ?? "connected services"))];

  return {
    registry: buildRegistry({
      resident,
      deferred,
      aliases: genosyn.aliases,
      domains,
      // Only report the ones that actually landed — a Skill naming a tool this
      // employee doesn't have should not appear in the log as if it did.
      fromSkills: requestedBySkills.filter((n) => resident.some((t) => t.name === n)),
    }),
    browser,
    close,
  };
}

/**
 * Move the tools this employee holds no grant for to the back of the list, in
 * place, keeping everything else in its existing relative order.
 *
 * Ordering only — nothing is dropped. See `grantDead.ts` for why this must
 * never become a filter.
 */
function sinkGrantDeadTools(tools: AgentTool[], dead: Set<string>): void {
  if (dead.size === 0) return;
  // Stable partition: Array#sort is stable in Node, but comparing booleans is
  // easy to get subtly wrong, so split and rejoin instead.
  const live = tools.filter((t) => !dead.has(t.name));
  const sunk = tools.filter((t) => dead.has(t.name));
  tools.length = 0;
  tools.push(...live, ...sunk);
}

/**
 * Make every tool's model-facing name unique and ≤64 chars. Renaming only the
 * exposed `name` is safe: each tool dispatches inside its own `run` closure,
 * which captured the real target when it was built.
 *
 * `reserved` names are pre-claimed so nothing can take them — they belong to
 * tools this module adds *after* deduping.
 */
function dedupeToolNames(tools: AgentTool[], reserved: string[] = []): void {
  const seen = new Set<string>(reserved);
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
