import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppDataSource } from "../db/datasource.js";
import { McpServer } from "../db/entities/McpServer.js";
import { config } from "../../config.js";

/**
 * Shape of Claude Code's `.mcp.json` — also recognized by most MCP-aware
 * CLIs. Writing this at the employee's workspace root lets the CLI pick up
 * tools without provider-specific plumbing.
 */
type McpServersFile = {
  mcpServers: Record<
    string,
    | {
        command: string;
        args?: string[];
        env?: Record<string, string>;
      }
    | {
        type: "http";
        url: string;
      }
  >;
};

/**
 * Absolute path to the built-in `genosyn` MCP stdio binary. The file lives at
 * `server/mcp-genosyn/index.mjs` in dev and `dist/server/mcp-genosyn/index.mjs`
 * in prod — so resolving relative to this file's own URL lands on the right
 * one in both. The post-build script (`build:server`) copies the `.mjs`
 * across so the prod path actually exists.
 */
const GENOSYN_MCP_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp-genosyn",
  "index.mjs",
);

/**
 * Loopback URL for the internal MCP API. We deliberately bypass
 * `config.publicUrl` (which may be an external hostname in prod) and dial
 * the Express process directly over 127.0.0.1 — the MCP binary always runs
 * on the same host as the server.
 */
function internalApiBase(): string {
  return `http://127.0.0.1:${config.port}/api/internal/mcp`;
}

/**
 * Write `.mcp.json` at the employee's cwd so the provider CLI picks up both
 * the built-in Genosyn tools and any external MCP servers the user has
 * configured. Called before every spawn so edits in the UI take effect on
 * the next run without a restart.
 *
 * `genosynToken` is the short-lived Bearer credential issued by
 * {@link issueMcpToken}. When present, we stamp in a `genosyn` entry that
 * lets the employee call Genosyn's own API (Routines, Todos, Journal, ...).
 * Callers that don't want tool access (e.g., future read-only previews) can
 * omit the token and the `genosyn` entry is left out.
 */
export async function materializeMcpConfig(
  employeeId: string,
  cwd: string,
  options: { genosynToken?: string } = {},
): Promise<void> {
  const servers = await AppDataSource.getRepository(McpServer).find({
    where: { employeeId, enabled: true },
  });
  const target = path.join(cwd, ".mcp.json");

  const file: McpServersFile = { mcpServers: {} };

  if (options.genosynToken) {
    file.mcpServers.genosyn = {
      command: process.execPath,
      args: [GENOSYN_MCP_BIN],
      env: {
        GENOSYN_MCP_API: internalApiBase(),
        GENOSYN_MCP_TOKEN: options.genosynToken,
      },
    };
  }

  for (const s of servers) {
    // "genosyn" is reserved for the built-in entry so users can't
    // accidentally shadow it from the UI.
    if (s.name === "genosyn") continue;
    if (s.transport === "http" && s.url) {
      file.mcpServers[s.name] = { type: "http", url: s.url };
    } else if (s.transport === "stdio" && s.command) {
      const args = parseJsonArray(s.argsJson) ?? [];
      const env = parseJsonRecord(s.envJson);
      file.mcpServers[s.name] = {
        command: s.command,
        ...(args.length > 0 ? { args } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }

  // Avoid leaving a stale file behind when every entry has been removed.
  if (Object.keys(file.mcpServers).length === 0) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }

  fs.writeFileSync(target, JSON.stringify(file, null, 2), "utf8");
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
