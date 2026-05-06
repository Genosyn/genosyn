import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppDataSource } from "../db/datasource.js";
import { McpServer } from "../db/entities/McpServer.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Company, type BrowserBackend } from "../db/entities/Company.js";
import type { Provider } from "../db/entities/AIModel.js";
import { config } from "../../config.js";
import { decryptSecret } from "../lib/secret.js";
import { employeeCodexDir, openclawConfigPath } from "./paths.js";

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
 *   - openclaw    → `mcp.servers.<name>` block inside the openclaw.json
 *                   pointed at by OPENCLAW_CONFIG_PATH. The file holds
 *                   non-MCP config (model defaults, gateway, channels) too,
 *                   so we read-merge-write — preserving everything outside
 *                   `mcp.servers` and overlaying our managed servers on
 *                   top. If the file is absent, a minimal one is written
 *                   with just the `mcp` block so OpenClaw still finds the
 *                   tools (other sections fall back to its built-in defaults).
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
  /** Per-tool approval policy. Each key takes "allow" | "ask" | "deny";
   * we default everything to "allow" so AI employees aren't blocked on
   * approval prompts during autonomous routine runs. */
  permission?: {
    bash?: "allow" | "ask" | "deny";
    edit?: "allow" | "ask" | "deny";
    webfetch?: "allow" | "ask" | "deny";
  };
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
 * Absolute path to the built-in `browser` MCP stdio binary. Same dev/prod
 * resolution as `GENOSYN_MCP_BIN`. Stamped in only when the employee's
 * `browserEnabled` flag is true so a stock install never wires Chromium
 * tools into a model that doesn't need them.
 */
const BROWSER_MCP_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp-browser",
  "index.mjs",
);

/** Reserved server names — operators can't shadow our built-ins from the UI. */
const RESERVED_SERVER_NAMES = new Set(["genosyn", "browser"]);

/**
 * Resolved browser configuration for one materialize pass. Combines:
 *
 *   * The employee's settings (`browserEnabled`, `browserAllowedHosts`,
 *     `browserApprovalRequired`).
 *   * The optional routine override (`browserEnabledOverride`), applied on
 *     top of the employee setting.
 *   * The company's backend choice (`local` / `browserbase`) plus
 *     decrypted Browserbase credentials.
 *
 * Stamped into each provider's MCP config when `enabled` is true. The
 * mcp-browser child process reads the env vars produced by
 * {@link browserEnvFor} and acts on them at tool-call time.
 */
type BrowserConfig = {
  enabled: boolean;
  allowedHosts: string;
  approvalRequired: boolean;
  backend: BrowserBackend;
  browserbaseApiKey: string | null;
  browserbaseProjectId: string | null;
};

const BROWSER_CONFIG_DISABLED: BrowserConfig = {
  enabled: false,
  allowedHosts: "",
  approvalRequired: false,
  backend: "local",
  browserbaseApiKey: null,
  browserbaseProjectId: null,
};

/**
 * Load the resolved browser config for an employee, factoring in an
 * optional routine override and the company's backend choice. A failed
 * Browserbase decrypt is treated as "no key" — the materializer logs
 * nothing and the MCP child will fall back to local; this is preferred
 * over throwing because browser disablement should never block an
 * unrelated provider spawn.
 */
async function loadBrowserConfig(
  employeeId: string,
  options: { routineId?: string },
): Promise<BrowserConfig> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
  });
  if (!employee) return BROWSER_CONFIG_DISABLED;

  let enabled = employee.browserEnabled;
  if (options.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: options.routineId,
    });
    if (routine && routine.browserEnabledOverride !== null) {
      enabled = routine.browserEnabledOverride;
    }
  }

  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: employee.companyId,
  });

  let browserbaseApiKey: string | null = null;
  if (company?.browserbaseApiKeyEnc) {
    try {
      browserbaseApiKey = decryptSecret(company.browserbaseApiKeyEnc);
    } catch {
      browserbaseApiKey = null;
    }
  }

  return {
    enabled,
    allowedHosts: employee.browserAllowedHosts ?? "",
    approvalRequired: employee.browserApprovalRequired,
    backend: company?.browserBackend ?? "local",
    browserbaseApiKey,
    browserbaseProjectId: company?.browserbaseProjectId ?? null,
  };
}

/**
 * Build the env block stamped into the `browser` MCP server entry. Only
 * non-empty values are included — keeps the materialized configs tidy when
 * everything is at defaults. The genosyn token + API base are included
 * whenever a token is available so the MCP child can call back to queue
 * approvals from `browser_submit`.
 */
function browserEnvFor(
  cfg: BrowserConfig,
  token: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (token) {
    env.GENOSYN_MCP_API = internalApiBase();
    env.GENOSYN_MCP_TOKEN = token;
  }
  const allowed = cfg.allowedHosts.trim();
  if (allowed) env.GENOSYN_BROWSER_ALLOWED_HOSTS = allowed;
  if (cfg.approvalRequired) env.GENOSYN_BROWSER_APPROVAL_REQUIRED = "1";
  if (cfg.backend === "browserbase") {
    env.GENOSYN_BROWSER_BACKEND = "browserbase";
    if (cfg.browserbaseApiKey) {
      env.GENOSYN_BROWSERBASE_API_KEY = cfg.browserbaseApiKey;
    }
    if (cfg.browserbaseProjectId) {
      env.GENOSYN_BROWSERBASE_PROJECT_ID = cfg.browserbaseProjectId;
    }
  }
  return env;
}

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
    // Reserved names ("genosyn", "browser") map to built-in stdio binaries
    // we always stamp in ourselves; drop any user rows that try to shadow
    // them rather than letting the UI win silently.
    if (RESERVED_SERVER_NAMES.has(s.name)) continue;
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
    /**
     * Optional routine being materialized for. When set, the routine's
     * `browserEnabledOverride` is applied on top of the employee's
     * `browserEnabled` flag (see {@link loadBrowserConfig}).
     */
    routineId?: string;
  } = {},
): Promise<McpInvocationExtras> {
  const provider = options.provider ?? "claude-code";
  const userServers = await loadUserServers(employeeId);
  const browser = await loadBrowserConfig(employeeId, {
    routineId: options.routineId,
  });
  const empty: McpInvocationExtras = { extraArgs: [], extraEnv: {} };

  switch (provider) {
    case "claude-code":
      writeClaudeConfig(cwd, userServers, options.genosynToken, browser);
      return empty;
    case "codex": {
      if (!options.companySlug || !options.employeeSlug) {
        // Without slugs we can't locate the employee's CODEX_HOME, so fall
        // back to the claude-shaped `.mcp.json` which codex also ignores —
        // same end result as before the multi-provider work.
        writeClaudeConfig(cwd, userServers, options.genosynToken, browser);
        return empty;
      }
      writeCodexConfig(
        employeeCodexDir(options.companySlug, options.employeeSlug),
        userServers,
        options.genosynToken,
        browser,
      );
      return empty;
    }
    case "opencode":
      writeOpencodeConfig(cwd, userServers, options.genosynToken, browser);
      return empty;
    case "goose":
      return buildGooseExtras(userServers, options.genosynToken, browser);
    case "openclaw": {
      if (!options.companySlug || !options.employeeSlug) {
        // Without slugs we can't locate the employee's openclaw.json, so
        // skip materialization rather than write to the wrong path.
        return empty;
      }
      writeOpenclawConfig(
        openclawConfigPath(options.companySlug, options.employeeSlug),
        userServers,
        options.genosynToken,
        browser,
      );
      return empty;
    }
  }
}

// ---------- writers ----------

function writeClaudeConfig(
  cwd: string,
  userServers: NormalizedServer[],
  token: string | undefined,
  browser: BrowserConfig,
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

  if (browser.enabled) {
    const env = browserEnvFor(browser, token);
    file.mcpServers.browser = {
      command: process.execPath,
      args: [BROWSER_MCP_BIN],
      ...(Object.keys(env).length > 0 ? { env } : {}),
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
  } else {
    fs.writeFileSync(target, JSON.stringify(file, null, 2), "utf8");
  }

  // Project-level Claude Code settings: pre-approve everything we registered
  // so AI employees aren't blocked on per-tool consent prompts during
  // autonomous routine runs. Genosyn is the trust boundary — if you didn't
  // want a server's tools available, you wouldn't have wired the server at
  // the company level.
  writeClaudeSettingsLocal(cwd, Object.keys(file.mcpServers));
}

/**
 * Write `<cwd>/.claude/settings.local.json` with a permissive allow list
 * covering every MCP server we registered plus the standard developer tool
 * surface (Bash, Read, Write, Edit, …). Without this, Claude Code prompts
 * the operator for approval the first time the AI employee invokes any tool
 * — fine in interactive `chat`, fatal in headless routine runs which run
 * with no human in the loop.
 *
 * The file is `settings.local.json` (gitignored by Claude Code's defaults),
 * not `settings.json`, so it stays a runtime artifact and never lands in
 * any repo the AI employee might be working in.
 */
function writeClaudeSettingsLocal(cwd: string, mcpServerNames: string[]): void {
  const dir = path.join(cwd, ".claude");
  const target = path.join(dir, "settings.local.json");

  // Allow every MCP server we registered. The `mcp__<server>` form grants
  // every tool that server exposes — we list it twice (with and without
  // the trailing wildcard) because some Claude Code releases match the
  // bare form, others match the wildcard explicitly.
  const mcpAllow: string[] = [];
  for (const name of mcpServerNames) {
    mcpAllow.push(`mcp__${name}`);
    mcpAllow.push(`mcp__${name}__*`);
  }

  // The standard agent toolset. AI employees need these to be useful;
  // gating them behind per-call prompts breaks autonomous operation.
  const builtinAllow = [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "Task",
  ];

  const settings = {
    permissions: {
      allow: [...mcpAllow, ...builtinAllow],
    },
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // The settings file is a UX nicety; if we can't write it the spawn
    // still works, the operator just sees approval prompts. Swallow.
  }
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
  browser: BrowserConfig,
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

  if (browser.enabled) {
    blocks.push(
      serializeCodexServer("browser", {
        command: process.execPath,
        args: [BROWSER_MCP_BIN],
        env: browserEnvFor(browser, token),
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
  browser: BrowserConfig,
): void {
  const target = path.join(cwd, "opencode.json");
  const file: OpenCodeConfigFile = {
    $schema: "https://opencode.ai/config.json",
    mcp: {},
    // Default everything to "allow" so AI employees aren't blocked on per-tool
    // consent prompts during autonomous routine runs. Genosyn is the trust
    // boundary — the employee is sandboxed in its own cwd and only sees the
    // MCP servers we wired.
    permission: {
      bash: "allow",
      edit: "allow",
      webfetch: "allow",
    },
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

  if (browser.enabled) {
    const env = browserEnvFor(browser, token);
    const entry: {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled: boolean;
    } = {
      type: "local",
      command: [process.execPath, BROWSER_MCP_BIN],
      enabled: true,
    };
    if (Object.keys(env).length > 0) entry.environment = env;
    file.mcp!.browser = entry;
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

  // Drop the empty `mcp` block when nothing is wired so the file stays
  // tidy. We still write the file because the `permission` block is the
  // whole point — without it, opencode prompts the operator on every
  // bash / edit / webfetch tool call.
  if (Object.keys(file.mcp!).length === 0) {
    delete file.mcp;
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
  browser: BrowserConfig,
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

  if (browser.enabled) {
    extraArgs.push(
      "--with-extension",
      gooseStdioCommand(process.execPath, [BROWSER_MCP_BIN]),
    );
    // Goose doesn't accept per-extension env, so the browser env vars ride
    // along on the parent process; the extension subprocess inherits them.
    // Keys collide with genosyn's only on namespaces that don't overlap
    // (`GENOSYN_BROWSER_*` vs `GENOSYN_MCP_*`).
    for (const [k, v] of Object.entries(browserEnvFor(browser, token))) {
      if (!(k in extraEnv)) extraEnv[k] = v;
    }
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

// ---------- openclaw ----------

/**
 * One MCP server entry inside `mcp.servers` in openclaw.json. OpenClaw
 * accepts either a stdio entry (command + args) or a remote one (url +
 * transport). Stdio is implicit when `command` is set; remote defaults to
 * SSE unless `transport: "streamable-http"` is given.
 */
type OpenclawMcpEntry =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      url: string;
      transport?: "sse" | "streamable-http";
      headers?: Record<string, string>;
    };

/**
 * Materialize the `mcp.servers` block inside openclaw.json. Unlike the
 * other providers, this file holds non-MCP config (model defaults, gateway
 * settings, channels) the operator may set via `openclaw onboard` or hand-
 * edit, so we read-merge-write — preserving everything outside `mcp.servers`
 * and overlaying our managed entries on top. If no servers and no token are
 * present and the file doesn't exist, we leave the filesystem untouched.
 */
function writeOpenclawConfig(
  configPath: string,
  userServers: NormalizedServer[],
  token: string | undefined,
  browser: BrowserConfig,
): void {
  const servers: Record<string, OpenclawMcpEntry> = {};

  if (token) {
    servers.genosyn = {
      command: process.execPath,
      args: [GENOSYN_MCP_BIN],
      env: {
        GENOSYN_MCP_API: internalApiBase(),
        GENOSYN_MCP_TOKEN: token,
      },
    };
  }

  if (browser.enabled) {
    const env = browserEnvFor(browser, token);
    const entry: OpenclawMcpEntry = {
      command: process.execPath,
      args: [BROWSER_MCP_BIN],
    };
    if (Object.keys(env).length > 0) (entry as { env?: Record<string, string> }).env = env;
    servers.browser = entry;
  }

  for (const s of userServers) {
    if (s.transport === "http") {
      servers[s.name] = { url: s.url, transport: "streamable-http" };
    } else {
      const entry: OpenclawMcpEntry = { command: s.command };
      if (s.args.length > 0) entry.args = s.args;
      if (Object.keys(s.env).length > 0) entry.env = s.env;
      servers[s.name] = entry;
    }
  }

  // Read-merge-write so we don't trample operator-set keys (models, gateway,
  // channels). A malformed JSON on disk is treated as empty — better than
  // refusing to spawn the agent.
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  } else if (Object.keys(servers).length === 0) {
    // Nothing to add and no file to update — leave the filesystem alone.
    return;
  }

  const mcpBlock = (
    typeof existing.mcp === "object" && existing.mcp !== null && !Array.isArray(existing.mcp)
      ? { ...(existing.mcp as Record<string, unknown>) }
      : {}
  );
  if (Object.keys(servers).length > 0) {
    mcpBlock.servers = servers;
  } else {
    delete mcpBlock.servers;
  }
  existing.mcp = mcpBlock;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf8");
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
