import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppDataSource } from "../../../db/datasource.js";
import { McpServer } from "../../../db/entities/McpServer.js";
import { AIEmployee } from "../../../db/entities/AIEmployee.js";
import { Company } from "../../../db/entities/Company.js";
import { Routine } from "../../../db/entities/Routine.js";
import { config } from "../../../../config.js";
import { createBrowserSession } from "../../browserSessions.js";
import { pushCurrentPolicyToAgent, resolveMemberBrowserForSpawn } from "../../memberBrowsers.js";
import { migrateLegacyBrowserStorage } from "../../browserStorage.js";
import { purgeLegacyCodeRepoSshFiles } from "../../codeRepoSshFiles.js";
import { employeeDir } from "../../paths.js";
import { assertSafeOutboundUrl } from "../../../lib/outboundUrl.js";
import type { McpServerSpec, McpToolGuard } from "./mcpBridge.js";

/**
 * Resolves the *out-of-process* MCP tool sources for an employee: the built-in
 * `browser` server (a stdio child driving the App-owned Chromium) and any
 * company-configured stdio/HTTP servers. The in-process `genosyn` tools live in
 * ./genosyn.ts; the built-in coding tools in ./coding.ts.
 *
 * This is the surviving remnant of the old `services/mcp.ts`: we do not
 * materialize provider-owned MCP config files. Even the narrow OpenAI
 * subscription app-server path receives this same App-owned registry through
 * dynamic tools. We still need to know which servers to connect to and mint
 * the browser live-view session.
 */

/** Absolute path to the built-in `browser` MCP stdio binary (dev + prod). */
export const BROWSER_MCP_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "mcp-browser",
  "index.mjs",
);

/** Reserved server names — companies can't shadow our built-ins from the UI. */
const RESERVED_SERVER_NAMES = new Set(["genosyn", "browser"]);

// ---------- browser ----------

export type BrowserConfig = {
  enabled: boolean;
  allowedHosts: string;
  approvalRequired: boolean;
  sessionId: string | null;
  sessionToken: string | null;
  /** Set when this spawn drives a Member's own computer instead of App Chromium. */
  memberBrowserId: string | null;
  memberBrowserName: string | null;
};

const BROWSER_DISABLED: BrowserConfig = {
  enabled: false,
  allowedHosts: "",
  approvalRequired: false,
  sessionId: null,
  sessionToken: null,
  memberBrowserId: null,
  memberBrowserName: null,
};

/**
 * Resolve browser config for an employee, honoring an optional routine
 * override, and (when enabled) mint a live-view {@link BrowserSession} so humans
 * can watch or take over. Stamps the run/conversation onto the session.
 */
export async function loadBrowserConfig(
  employeeId: string,
  options: { routineId?: string; conversationId?: string; runId?: string },
): Promise<BrowserConfig> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!employee) return BROWSER_DISABLED;
  // This runs before the coding registry is assembled. An upgrade therefore
  // removes the legacy workspace-visible cookie file before host file tools or
  // bubblewrapped bash can observe the employee workspace.
  await migrateLegacyBrowserStorage(employee.companyId, employee.id);
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: employee.companyId });
  if (company) purgeLegacyCodeRepoSshFiles(employeeDir(company.slug, employee.slug));
  if (config.security.multiTenant && !config.agent.browserEnabledInMultiTenant) {
    return BROWSER_DISABLED;
  }

  let enabled = employee.browserEnabled;
  if (options.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: options.routineId });
    if (routine && routine.browserEnabledOverride !== null) {
      enabled = routine.browserEnabledOverride;
    }
  }

  if (!enabled) {
    return {
      enabled: false,
      allowedHosts: employee.browserAllowedHosts ?? "",
      approvalRequired: employee.browserApprovalRequired,
      sessionId: null,
      sessionToken: null,
      memberBrowserId: null,
      memberBrowserName: null,
    };
  }

  // Which browser this spawn drives, from the human's choice on the Routine or
  // the Conversation. Never from anything the model said: picking whose
  // signed-in browser an employee may drive is a delegation of authority, so
  // it is a human act recorded on a row, not a tool call.
  const memberBrowser = await resolveMemberBrowserForSpawn({
    employeeId: employee.id,
    companyId: employee.companyId,
    conversationId: options.conversationId ?? null,
    routineId: options.routineId ?? null,
  });

  const session = await createBrowserSession({
    companyId: employee.companyId,
    employeeId: employee.id,
    conversationId: options.conversationId ?? null,
    runId: options.runId ?? null,
    memberBrowserId: memberBrowser?.id ?? null,
  });

  if (memberBrowser) {
    // Refresh the agent's local copy of the host policy while we know it is
    // current. The agent enforces it a second time on the laptop, so a
    // compromised App still cannot drive the browser off the list. It is also
    // pushed on connect and on edit — this is belt and braces.
    await pushCurrentPolicyToAgent(memberBrowser.id);
  }

  return {
    enabled: true,
    allowedHosts: employee.browserAllowedHosts ?? "",
    approvalRequired: employee.browserApprovalRequired || Boolean(memberBrowser?.approvalRequired),
    sessionId: session.id,
    sessionToken: session.mcpToken,
    memberBrowserId: memberBrowser?.id ?? null,
    memberBrowserName: memberBrowser?.name ?? null,
  };
}

function internalApiBase(): string {
  return `http://127.0.0.1:${config.port}/api/internal/mcp`;
}
function internalHttpBase(): string {
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Env block for the browser MCP child. Carries the genosyn callback token (so
 * the browser tools can queue approvals) and the live-view session bearer.
 */
export function browserEnvFor(
  cfg: BrowserConfig,
  token: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (token) {
    env.GENOSYN_MCP_API = internalApiBase();
    env.GENOSYN_MCP_TOKEN = token;
  }
  if (cfg.approvalRequired) env.GENOSYN_BROWSER_APPROVAL_REQUIRED = "1";
  if (cfg.sessionId && cfg.sessionToken) {
    env.GENOSYN_BROWSER_API = `${internalHttpBase()}/api/internal/browser/sessions/${cfg.sessionId}`;
    env.GENOSYN_BROWSER_SESSION_ID = cfg.sessionId;
    env.GENOSYN_BROWSER_SESSION_TOKEN = cfg.sessionToken;
  }
  // The allow list is enforced server-side in browserRpc on every /open —
  // the child never needs it.
  return env;
}

/** The stdio spec for spawning the browser MCP child. */
export function browserServerSpec(cfg: BrowserConfig, token: string | undefined): McpServerSpec {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [BROWSER_MCP_BIN],
    env: browserEnvFor(cfg, token),
  };
}

// ---------- user-configured servers ----------

/**
 * Runnable transport spec for one McpServer row, or null when the row's
 * transport config is incomplete. Shared by the per-turn tool assembly and
 * the approval replay path (`services/approvals.ts`), which reconnects to
 * the same server to execute an approved guarded call.
 */
export function specForMcpServerRow(s: McpServer): McpServerSpec | null {
  if (s.transport === "http" && s.url) {
    return { transport: "http", url: s.url };
  }
  if (s.transport === "stdio" && s.command) {
    if (
      !userStdioMcpAvailableFor({
        multiTenant: config.security.multiTenant,
        codingToolsExecutionMode: config.agent.codingTools.executionMode,
      })
    ) {
      return null;
    }
    return {
      transport: "stdio",
      command: s.command,
      args: parseJsonArray(s.argsJson) ?? [],
      env: parseJsonRecord(s.envJson) ?? {},
    };
  }
  return null;
}

export function userStdioMcpAvailableFor(options: {
  multiTenant: boolean;
  codingToolsExecutionMode: "host" | "bubblewrap" | "disabled";
}): boolean {
  // An arbitrary same-UID child can inspect sibling /proc entries and private
  // temp directories. Both safe modes therefore omit user stdio servers for
  // every turn—not only the subscription turn that holds the credential.
  // `disabled` is the no-coding/repository/user-stdio subscription posture;
  // `bubblewrap` is the isolated-shell posture. Selecting `host` opts out of
  // subscription auth and is the only trusted self-hosted mode where arbitrary
  // stdio children can run beside the App process.
  return !options.multiTenant && options.codingToolsExecutionMode === "host";
}

export async function loadUserServerSpecs(
  employeeId: string,
): Promise<Array<{ name: string; spec: McpServerSpec; guard?: McpToolGuard }>> {
  const [rows, employee] = await Promise.all([
    AppDataSource.getRepository(McpServer).find({
      where: { employeeId, enabled: true },
    }),
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId }),
  ]);
  const companyId = employee?.companyId;
  const out: Array<{ name: string; spec: McpServerSpec; guard?: McpToolGuard }> = [];
  for (const s of rows) {
    if (RESERVED_SERVER_NAMES.has(s.name)) continue;
    const spec = specForMcpServerRow(s);
    if (!spec) continue;
    if (spec.transport === "http") {
      try {
        await assertSafeOutboundUrl(spec.url);
      } catch {
        continue;
      }
    }
    const patterns = (parseJsonArray(s.guardedToolsJson) ?? []).filter((p) => p.trim().length > 0);
    // Guarded tools queue an Approval instead of executing. The import is
    // dynamic because approvals.ts reaches (via the runner) back into this
    // module — a static import would close the cycle at module-init time.
    const guard: McpToolGuard | undefined =
      patterns.length > 0 && companyId
        ? {
            patterns,
            onGuarded: async (toolName, input) => {
              const { createMcpToolApproval } = await import("../../approvals.js");
              const approval = await createMcpToolApproval({
                companyId,
                employeeId,
                mcpServerId: s.id,
                serverName: s.name,
                toolName,
                toolArgs: input,
              });
              return {
                content: `Approval pending — "${toolName}" on MCP server "${s.name}" is guarded, so a human must approve it first. Approval id: ${approval.id}. The call runs automatically once approved; do not retry it yourself.`,
                isError: true,
              };
            },
          }
        : undefined;
    out.push({ name: s.name, spec, guard });
  }
  return out;
}

function parseJsonArray(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  } catch {
    // fall through
  }
  return null;
}

function parseJsonRecord(s: string | null): Record<string, string> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string") out[k] = val;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return null;
}
