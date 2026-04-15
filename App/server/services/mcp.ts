import fs from "node:fs";
import path from "node:path";
import { AppDataSource } from "../db/datasource.js";
import { McpServer } from "../db/entities/McpServer.js";

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
 * Write (or delete) `.mcp.json` at the employee's cwd based on their
 * configured MCP servers. Called before every spawn so edits in the UI
 * take effect on the next run without a restart.
 *
 * We write empty files when no servers are configured too — easier to
 * reason about than "sometimes the file exists". Actually, if there are
 * zero servers we remove the file so the CLI doesn't warn about an empty
 * `mcpServers` object.
 */
export async function materializeMcpConfig(
  employeeId: string,
  cwd: string,
): Promise<void> {
  const servers = await AppDataSource.getRepository(McpServer).find({
    where: { employeeId, enabled: true },
  });
  const target = path.join(cwd, ".mcp.json");

  if (servers.length === 0) {
    // Avoid leaving a stale file behind when the last server is removed.
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }

  const file: McpServersFile = { mcpServers: {} };
  for (const s of servers) {
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
