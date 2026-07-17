import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppDataSource } from "../../../db/datasource.js";
import { McpServer } from "../../../db/entities/McpServer.js";
import { AIEmployee } from "../../../db/entities/AIEmployee.js";
import { Routine } from "../../../db/entities/Routine.js";
import { BrowserSession } from "../../../db/entities/BrowserSession.js";
import { config } from "../../../../config.js";
import { createBrowserSession } from "../../browserSessions.js";
import type { McpServerSpec, McpToolGuard } from "./mcpBridge.js";

/**
 * Resolves the *out-of-process* MCP tool sources for an employee: the built-in
 * `browser` server (a stdio child driving the App-owned Chromium) and any
 * company-configured stdio/HTTP servers. The in-process `genosyn` tools live in
 * ./genosyn.ts; the built-in coding tools in ./coding.ts.
 *
 * This is the surviving remnant of the old `services/mcp.ts`: we no longer
 * materialize per-CLI config files (there is no CLI), but we still need to know
 * which servers to connect to and mint the browser live-view session.
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
};

const BROWSER_DISABLED: BrowserConfig = {
  enabled: false,
  allowedHosts: "",
  approvalRequired: false,
  sessionId: null,
  sessionToken: null,
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
    };
  }

  const session = await createBrowserSession({
    companyId: employee.companyId,
    employeeId: employee.id,
    conversationId: options.conversationId ?? null,
    runId: null,
  });

  if (options.runId) {
    const repo = AppDataSource.getRepository(BrowserSession);
    const row = await repo.findOneBy({ id: session.id });
    if (row) {
      row.runId = options.runId;
      await repo.save(row);
    }
  }

  return {
    enabled: true,
    allowedHosts: employee.browserAllowedHosts ?? "",
    approvalRequired: employee.browserApprovalRequired,
    sessionId: session.id,
    sessionToken: session.mcpToken,
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
    env.GENOSYN_BROWSER_SESSION_TOKEN = cfg.sessionToken;
  }
  const allowed = cfg.allowedHosts.trim();
  if (allowed) env.GENOSYN_BROWSER_ALLOWED_HOSTS = allowed;
  return env;
}

/** The stdio spec for spawning the browser MCP child. */
export function browserServerSpec(
  cfg: BrowserConfig,
  token: string | undefined,
): McpServerSpec {
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
    return {
      transport: "stdio",
      command: s.command,
      args: parseJsonArray(s.argsJson) ?? [],
      env: parseJsonRecord(s.envJson) ?? {},
    };
  }
  return null;
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
    const patterns = (parseJsonArray(s.guardedToolsJson) ?? []).filter(
      (p) => p.trim().length > 0,
    );
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
