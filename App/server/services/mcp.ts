import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppDataSource } from "../db/datasource.js";
import { McpServer } from "../db/entities/McpServer.js";
import type { Provider } from "../db/entities/AIModel.js";
import { config } from "../../config.js";
import { employeeCodexDir } from "./paths.js";

/**
 * Each provider CLI has its own way of declaring MCP servers. We centralize
 * the materialization here so the runner / chat seam just says "write the
 * config for this provider, employee, cwd" and this module picks the right
 * shape:
 *
 *   - claude-code → `.mcp.json` at cwd (standard Claude Code schema)
 *   - codex       → `$CODEX_HOME/config.toml` with `[mcp_servers.<name>]`
 *   - opencode    → `opencode.json` at cwd with `mcp.<name>` entries
 *   - goose       → no config file; servers passed as runtime CLI flags
 *                   (`--with-extension`, `--with-streamable-http-extension`)
 *                   so we don't fight with what `goose configure` writes
 *                   into the same `config.yaml`. The MCP env vars hitch a
 *                   ride on the goose parent process so the stdio child
 *                   inherits them.
 *
 * Every provider gets the built-in `genosyn` server (read/write access to
 * Genosyn's own Routines / Todos / Journal / ...) merged with whatever the
 * user configured per-employee in the McpServer DB table. The mapping from
 * the DB schema to each provider's JSON/TOML shape is provider-specific.
 */

// ---------- Claude Code ----------

type ClaudeMcpFile = {
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

// ---------- opencode ----------

type OpenCodeConfigFile = {
  $schema?: string;
  mcp?: Record<
    string,
    | {
        type: "local";
        command: string[];
        environment?: Record<string, string>;
        enabled?: boolean;
      }
    | {
        type: "remote";
        url: string;
        enabled?: boolean;
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

/** Normalized view of a user-configured MCP server ready for serialization. */
type NormalizedServer =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
    };

/** Load + normalize user-configured servers for an employee. */
async function loadUserServers(employeeId: string): Promise<NormalizedServer[]> {
  const rows = await AppDataSource.getRepository(McpServer).find({
    where: { employeeId, enabled: true },
  });
  const out: NormalizedServer[] = [];
  for (const s of rows) {
    // "genosyn" is reserved for the built-in entry so users can't
    // accidentally shadow it from the UI.
    if (s.name === "genosyn") continue;
    if (s.transport === "http" && s.url) {
      out.push({ name: s.name, transport: "http", url: s.url });
    } else if (s.transport === "stdio" && s.command) {
      const args = parseJsonArray(s.argsJson) ?? [];
      const env = parseJsonRecord(s.envJson) ?? {};
      out.push({
        name: s.name,
        transport: "stdio",
        command: s.command,
        args,
        env,
      });
    }
  }
  return out;
}

/**
 * Returned by {@link materializeMcpConfig}. Most providers materialize a
 * config file and have nothing to add to the CLI invocation, so they return
 * empty arrays. Goose is the exception — it has no file to write, but does
 * need extra `--with-extension` flags and inherited env on the spawn.
 */
export type McpInvocationExtras = {
  /** Extra CLI args to append to the provider invocation. */
  extraArgs: string[];
  /** Extra env vars to merge onto the provider spawn so MCP children inherit them. */
  extraEnv: Record<string, string>;
};

/**
 * Materialize the correct MCP config file(s) for the provider we're about
 * to spawn. Called before every chat turn / routine run so edits in the UI
 * take effect on the next invocation without a restart.
 *
 * `genosynToken` is the short-lived Bearer credential issued by
 * {@link issueMcpToken}. When present, the built-in `genosyn` server is
 * stamped into the provider's config so the employee can call Genosyn's own
 * API (Routines, Todos, Journal, ...). Callers that don't want tool access
 * (e.g., future read-only previews) can omit the token.
 *
 * Returns any CLI args / env additions the caller must apply (only goose
 * uses these today; other providers return empty values).
 */
export async function materializeMcpConfig(
  employeeId: string,
  cwd: string,
  options: {
    genosynToken?: string;
    provider?: Provider;
    companySlug?: string;
    employeeSlug?: string;
  } = {},
): Promise<McpInvocationExtras> {
  const provider = options.provider ?? "claude-code";
  const userServers = await loadUserServers(employeeId);
  const empty: McpInvocationExtras = { extraArgs: [], extraEnv: {} };

  switch (provider) {
    case "claude-code":
      writeClaudeConfig(cwd, userServers, options.genosynToken);
      return empty;
    case "codex": {
      if (!options.companySlug || !options.employeeSlug) {
        // Without slugs we can't locate the employee's CODEX_HOME, so fall
        // back to the claude-shaped `.mcp.json` which codex also ignores —
        // same end result as before the multi-provider work.
        writeClaudeConfig(cwd, userServers, options.genosynToken);
        return empty;
      }
      writeCodexConfig(
        employeeCodexDir(options.companySlug, options.employeeSlug),
        userServers,
        options.genosynToken,
      );
      return empty;
    }
    case "opencode":
      writeOpencodeConfig(cwd, userServers, options.genosynToken);
      return empty;
    case "goose":
      return buildGooseExtras(userServers, options.genosynToken);
  }
}

// ---------- writers ----------

function writeClaudeConfig(
  cwd: string,
  userServers: NormalizedServer[],
  token: string | undefined,
): void {
  const target = path.join(cwd, ".mcp.json");
  const file: ClaudeMcpFile = { mcpServers: {} };

  if (token) {
    file.mcpServers.genosyn = {
      command: process.execPath,
      args: [GENOSYN_MCP_BIN],
      env: {
        GENOSYN_MCP_API: internalApiBase(),
        GENOSYN_MCP_TOKEN: token,
      },
    };
  }

  for (const s of userServers) {
    if (s.transport === "http") {
      file.mcpServers[s.name] = { type: "http", url: s.url };
    } else {
      file.mcpServers[s.name] = {
        command: s.command,
        ...(s.args.length > 0 ? { args: s.args } : {}),
        ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      };
    }
  }

  if (Object.keys(file.mcpServers).length === 0) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }

  fs.writeFileSync(target, JSON.stringify(file, null, 2), "utf8");
}

/**
 * Write `$CODEX_HOME/config.toml` with a `[mcp_servers.<name>]` block per
 * server. Codex's TOML schema only supports stdio servers — HTTP-transport
 * MCP servers configured in the UI are skipped for this provider, with a
 * warning in the file so the operator can spot the mismatch.
 */
function writeCodexConfig(
  codexHome: string,
  userServers: NormalizedServer[],
  token: string | undefined,
): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const target = path.join(codexHome, "config.toml");

  const blocks: string[] = [];

  if (token) {
    blocks.push(
      serializeCodexServer("genosyn", {
        command: process.execPath,
        args: [GENOSYN_MCP_BIN],
        env: {
          GENOSYN_MCP_API: internalApiBase(),
          GENOSYN_MCP_TOKEN: token,
        },
      }),
    );
  }

  const skipped: string[] = [];
  for (const s of userServers) {
    if (s.transport === "http") {
      skipped.push(s.name);
      continue;
    }
    blocks.push(
      serializeCodexServer(s.name, {
        command: s.command,
        args: s.args,
        env: s.env,
      }),
    );
  }

  if (blocks.length === 0) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }

  const header = [
    "# Auto-generated by Genosyn — do not edit by hand.",
    "# Written before every Codex spawn; changes are overwritten.",
    ...(skipped.length > 0
      ? [
          `# Skipped HTTP-transport MCP servers (codex does not support them): ${skipped.join(", ")}`,
        ]
      : []),
    "",
  ].join("\n");

  fs.writeFileSync(target, header + blocks.join("\n") + "\n", "utf8");
}

function serializeCodexServer(
  name: string,
  spec: { command: string; args: string[]; env: Record<string, string> },
): string {
  const lines = [`[mcp_servers.${escapeTomlKey(name)}]`];
  lines.push(`command = ${tomlString(spec.command)}`);
  if (spec.args.length > 0) {
    lines.push(`args = [${spec.args.map(tomlString).join(", ")}]`);
  }
  if (Object.keys(spec.env).length > 0) {
    lines.push(`env = { ${Object.entries(spec.env)
      .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
      .join(", ")} }`);
  }
  return lines.join("\n") + "\n";
}

/**
 * TOML basic-string serializer. Values are wrapped in `"..."` with the
 * escape sequences that TOML requires: backslash, quote, and the low-ASCII
 * control set. We intentionally do not emit literal strings because
 * env values can reasonably contain single quotes.
 */
function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function escapeTomlKey(name: string): string {
  // Keys that are pure alphanumeric+underscore don't need quoting; otherwise
  // quote them defensively so names like "some.server" don't collapse into
  // nested tables.
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return tomlString(name);
}

/**
 * Write `opencode.json` at the cwd so `opencode run` sees the MCP servers.
 * opencode distinguishes local (stdio) from remote (HTTP) transports; both
 * supported. Command is emitted as an array — opencode's schema does not use
 * a bare string.
 */
function writeOpencodeConfig(
  cwd: string,
  userServers: NormalizedServer[],
  token: string | undefined,
): void {
  const target = path.join(cwd, "opencode.json");
  const file: OpenCodeConfigFile = {
    $schema: "https://opencode.ai/config.json",
    mcp: {},
  };

  if (token) {
    file.mcp!.genosyn = {
      type: "local",
      command: [process.execPath, GENOSYN_MCP_BIN],
      environment: {
        GENOSYN_MCP_API: internalApiBase(),
        GENOSYN_MCP_TOKEN: token,
      },
      enabled: true,
    };
  }

  for (const s of userServers) {
    if (s.transport === "http") {
      file.mcp![s.name] = { type: "remote", url: s.url, enabled: true };
    } else {
      // opencode's spec asks for the full argv as a single array; merging
      // command + args into one list is the canonical form.
      const entry: {
        type: "local";
        command: string[];
        environment?: Record<string, string>;
        enabled: boolean;
      } = {
        type: "local",
        command: [s.command, ...s.args],
        enabled: true,
      };
      if (Object.keys(s.env).length > 0) entry.environment = s.env;
      file.mcp![s.name] = entry;
    }
  }

  if (Object.keys(file.mcp!).length === 0) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }

  fs.writeFileSync(target, JSON.stringify(file, null, 2), "utf8");
}

// ---------- goose ----------

/**
 * Build goose's runtime MCP flags. goose accepts extensions via three CLI
 * flags rather than a config file we can safely overwrite:
 *
 *   --with-extension "<command>"            stdio extension
 *   --with-streamable-http-extension <url>  streamable HTTP transport
 *   --with-remote-extension <url>           legacy SSE transport
 *
 * We default HTTP-transport user servers to streamable HTTP — that's the
 * current MCP spec; SSE is being phased out. If a user has SSE-only servers
 * they can switch the flag manually in a follow-up.
 *
 * stdio servers' env vars need to live on the goose parent process so the
 * extension subprocess inherits them. We collect those into `extraEnv`,
 * which the runner / chat seam merges onto its spawn.
 */
function buildGooseExtras(
  userServers: NormalizedServer[],
  token: string | undefined,
): McpInvocationExtras {
  const extraArgs: string[] = [];
  const extraEnv: Record<string, string> = {};

  if (token) {
    extraArgs.push(
      "--with-extension",
      gooseStdioCommand(process.execPath, [GENOSYN_MCP_BIN]),
    );
    extraEnv.GENOSYN_MCP_API = internalApiBase();
    extraEnv.GENOSYN_MCP_TOKEN = token;
  }

  for (const s of userServers) {
    if (s.transport === "http") {
      extraArgs.push("--with-streamable-http-extension", s.url);
    } else {
      extraArgs.push("--with-extension", gooseStdioCommand(s.command, s.args));
      for (const [k, v] of Object.entries(s.env)) {
        // Last writer wins on collisions — same fate as overlapping env keys
        // in any other provider's config materialization.
        extraEnv[k] = v;
      }
    }
  }

  return { extraArgs, extraEnv };
}

/**
 * Serialize a stdio command + args list as a single string suitable for
 * goose's `--with-extension` flag. goose splits on whitespace, so any token
 * containing a space (or other shell metacharacter) gets wrapped in single
 * quotes with embedded `'` escaped. Pure-ASCII paths and args round-trip
 * unchanged.
 */
function gooseStdioCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuoteIfNeeded).join(" ");
}

function shellQuoteIfNeeded(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./@:=+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------- parsing helpers ----------

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
