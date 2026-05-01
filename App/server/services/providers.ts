import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AIModel, Provider } from "../db/entities/AIModel.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import {
  claudeCredsPath,
  codexCredsPath,
  employeeClaudeDir,
  employeeCodexDir,
  employeeGooseDir,
  employeeOpenclawDir,
  employeeOpencodeDir,
  gooseCredsPath,
  openclawCredsPath,
  opencodeCredsPath,
} from "./paths.js";

/**
 * Per-provider integration facts. Centralised here so the route layer, the
 * runner seam and the UI one-liner all agree on the same env var name,
 * credentials path and login command.
 *
 * Claude Code is the only provider with a production-ready headless CLI in
 * this milestone; codex, opencode and goose are wired end-to-end with the
 * same shape (subscription login + optional API key), and degrade gracefully
 * when the CLI binary isn't installed.
 */
export type ProviderSpec = {
  /** Human label. */
  label: string;
  /** Default model name shown when the user first picks this provider. */
  defaultModel: string;
  /** Env var the CLI reads to locate its per-user config directory. */
  configDirEnv: string;
  /** Env var for pay-as-you-go API key, if this provider supports apikey mode. */
  apiKeyEnv: string | null;
  /** Does this provider support the "Use an API key" flow at all? */
  supportsApiKey: boolean;
  /**
   * Does this provider support a "Sign in with subscription" flow? Mirrors
   * `supportsApiKey` for providers (like openclaw) whose primary auth model
   * is API-key-only and have no first-class `<cli> login` subcommand.
   */
  supportsSubscription: boolean;
  /**
   * Shell command the operator runs to log in (scoped via configDirEnv).
   * `null` for providers without a subscription flow (see
   * `supportsSubscription`).
   */
  loginCommand: string | null;
  /**
   * argv form of the login command, used when we spawn it under a pty for
   * the in-browser sign-in flow. Must be the same effective command as
   * `loginCommand` (which is the human-readable shell version shown to
   * operators who prefer to run it themselves). `null` when
   * `supportsSubscription` is false.
   */
  loginArgv: { cmd: string; args: string[] } | null;
  /** Binary name to look up on PATH to decide if the CLI is installed. */
  binName: string;
  /**
   * argv form of an installer that places `binName` on PATH. Run as a
   * background pty session from the in-app installer surface. Goose ships a
   * shell pipeline; everyone else is `npm install -g <pkg>`.
   */
  installArgv: { cmd: string; args: string[] };
  /** Absolute path to the employee's per-provider config dir. */
  configDir(companySlug: string, employeeSlug: string): string;
  /** Absolute path to the creds file the provider drops on successful login. */
  credsPath(companySlug: string, employeeSlug: string): string;
};

/**
 * True if a subscription login has landed in the provider's config dir.
 *
 * Claude Code's on-disk footprint varies by platform: on Linux it drops
 * `.credentials.json` next to `.claude.json`; on macOS it writes the OAuth
 * token to the Keychain under a service like `Claude Code-credentials-<hash>`
 * and never creates `.credentials.json`. What it *does* write on every
 * platform is `.claude.json` with a populated `oauthAccount` — so we treat
 * that (or the legacy `.credentials.json`) as the canonical signal.
 *
 * Codex, opencode and goose write their creds files directly, so the simple
 * file check still holds for them.
 */
export function isSubscriptionConnected(
  provider: Provider,
  companySlug: string,
  employeeSlug: string,
): boolean {
  const spec = PROVIDERS[provider];
  // Providers without a subscription flow (api-key-only) can never be
  // "subscription connected". Defensive — the UI and routes should never
  // ask, but this keeps the predicate honest if they do.
  if (!spec.supportsSubscription) return false;
  try {
    if (fs.existsSync(spec.credsPath(companySlug, employeeSlug))) return true;
  } catch {
    // fall through
  }
  if (provider === "claude-code") {
    try {
      const p = path.join(spec.configDir(companySlug, employeeSlug), ".claude.json");
      if (!fs.existsSync(p)) return false;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown } };
      return typeof parsed.oauthAccount?.accountUuid === "string";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * A Model is "connected" if credentials are actually usable:
 *  - subscription: provider's on-disk login signal is present
 *  - apikey:      an encrypted key is present in configJson
 */
export function isModelConnected(m: AIModel, co: Company, emp: AIEmployee): boolean {
  if (m.authMode === "apikey") {
    let cfg: Record<string, unknown> = {};
    try {
      const v = JSON.parse(m.configJson || "{}");
      if (v && typeof v === "object") cfg = v as Record<string, unknown>;
    } catch {
      // fall through
    }
    return typeof cfg.apiKeyEncrypted === "string" && (cfg.apiKeyEncrypted as string).length > 0;
  }
  return isSubscriptionConnected(m.provider, co.slug, emp.slug);
}

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  "claude-code": {
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    configDirEnv: "CLAUDE_CONFIG_DIR",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    supportsSubscription: true,
    // `claude auth login` is the OAuth-only path. The legacy alias `claude
    // login` boots the full TUI first — theme picker, syntax-theme demo,
    // workspace-trust dialog — before getting to OAuth. None of that is
    // useful to a per-employee web flow, so we go straight to the auth
    // subcommand. Output becomes a single line ("Opening browser to sign
    // in… / If the browser didn't open, visit: <URL>") which is exactly
    // what the in-browser wizard surfaces.
    loginCommand: "claude auth login",
    loginArgv: { cmd: "claude", args: ["auth", "login"] },
    binName: "claude",
    installArgv: { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
    configDir: employeeClaudeDir,
    credsPath: claudeCredsPath,
  },
  codex: {
    label: "Codex",
    defaultModel: "gpt-5-codex",
    configDirEnv: "CODEX_HOME",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsApiKey: true,
    supportsSubscription: true,
    loginCommand: "codex login",
    loginArgv: { cmd: "codex", args: ["login"] },
    binName: "codex",
    installArgv: { cmd: "npm", args: ["install", "-g", "@openai/codex"] },
    configDir: employeeCodexDir,
    credsPath: codexCredsPath,
  },
  opencode: {
    label: "OpenCode",
    defaultModel: "anthropic/claude-opus-4-6",
    // opencode reads XDG_DATA_HOME (plus XDG_CONFIG_HOME) to locate its auth
    // store. Pointing XDG_DATA_HOME at the employee dir keeps each employee's
    // auth fully isolated.
    configDirEnv: "XDG_DATA_HOME",
    // opencode is a router — it calls whichever underlying provider the model
    // string names. API keys belong with the CLI's auth store, not a single
    // env var, so we disable the apikey flow here.
    apiKeyEnv: null,
    supportsApiKey: false,
    supportsSubscription: true,
    loginCommand: "opencode auth login",
    loginArgv: { cmd: "opencode", args: ["auth", "login"] },
    binName: "opencode",
    installArgv: { cmd: "npm", args: ["install", "-g", "opencode-ai"] },
    configDir: employeeOpencodeDir,
    credsPath: opencodeCredsPath,
  },
  goose: {
    label: "Goose",
    // Format mirrors opencode's `<provider>/<model>` so the runner can split
    // it into GOOSE_PROVIDER + GOOSE_MODEL on each spawn.
    defaultModel: "anthropic/claude-opus-4-6",
    // goose reads XDG_CONFIG_HOME to locate `goose/config.yaml`, where its
    // provider auth + selected model live. Pointing it at the employee dir
    // keeps each employee's signed-in session isolated.
    configDirEnv: "XDG_CONFIG_HOME",
    // goose is a router — it calls whichever underlying provider the model
    // string names. API keys live in goose's own config store, not a single
    // env var, so we disable the apikey flow.
    apiKeyEnv: null,
    supportsApiKey: false,
    supportsSubscription: true,
    // GOOSE_DISABLE_KEYRING=1 keeps goose from stashing creds in the host's
    // OS keychain — without it, every employee would share whatever the host
    // has logged in. The login command in the UI is composed as
    // `<configDirEnv>=<dir> <loginCommand>`, so the disable flag stamps in
    // here.
    loginCommand: "GOOSE_DISABLE_KEYRING=1 goose configure",
    // The pty spawner sets GOOSE_DISABLE_KEYRING in the env map, so the argv
    // is just the bare command — env vars don't belong in argv when execing
    // directly (no shell to interpret them).
    loginArgv: { cmd: "goose", args: ["configure"] },
    binName: "goose",
    // Goose ships a shell installer; piping curl into bash is the documented
    // path. We invoke through `bash -lc` so PATH-based redirects work and the
    // installer can write to /usr/local/bin (or ~/.local/bin if unprivileged).
    installArgv: {
      cmd: "bash",
      args: [
        "-lc",
        "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
      ],
    },
    configDir: employeeGooseDir,
    credsPath: gooseCredsPath,
  },
  openclaw: {
    label: "OpenClaw",
    // OpenClaw is a router (calls underlying providers via plugins). Format
    // mirrors opencode + goose so a single AIModel.model edit reroutes the
    // brain without touching this spec.
    defaultModel: "anthropic/claude-opus-4-7",
    // OPENCLAW_CONFIG_PATH points at the openclaw.json file (not a directory,
    // unlike CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_*_HOME). The runner sets
    // OPENCLAW_STATE_DIR alongside it so per-agent auth profiles also land
    // inside the employee's `.openclaw/`.
    configDirEnv: "OPENCLAW_CONFIG_PATH",
    // The default model routes through Anthropic, so the user pastes an
    // Anthropic key. Operators who flip the model to a different router
    // target can still paste the corresponding key here — OpenClaw resolves
    // it when the matching provider is selected at runtime.
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    // OpenClaw has no first-class `<cli> login` subcommand — auth profiles
    // are written directly to <state_dir>/agents/<id>/agent/auth-profiles.json.
    // The OAuth convenience flow exists but isn't scriptable enough for the
    // pty-driven wizard yet, so v1 ships api-key-only.
    supportsSubscription: false,
    loginCommand: null,
    loginArgv: null,
    binName: "openclaw",
    installArgv: { cmd: "npm", args: ["install", "-g", "openclaw"] },
    configDir: employeeOpenclawDir,
    credsPath: openclawCredsPath,
  },
};

/**
 * True if the provider's CLI binary resolves on PATH. Used by the installer
 * surface and the runner to decide whether to offer / require an install.
 *
 * Implementation note: we shell out to `which` rather than walk PATH ourselves
 * because the CLIs may live in arch-specific bins (`/usr/local/bin`,
 * `~/.local/bin`, `~/.npm-global/bin`, …) that vary across hosts. Letting the
 * shell resolve it matches whatever the spawn() will actually find.
 */
export function isCliInstalled(provider: Provider): boolean {
  const spec = PROVIDERS[provider];
  try {
    // `which` is universally present on the platforms we support (alpine,
    // debian, macOS). stdout is harmless; we just key off the exit code.
    const r = spawnSync("which", [spec.binName], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Split an AIModel.model field of the shape `<provider>/<model>` into its
 * two halves for goose's GOOSE_PROVIDER + GOOSE_MODEL env vars. If there's
 * no slash, the whole string is treated as the model name and the provider
 * stays whatever `goose configure` chose.
 */
export function splitGooseModel(s: string): { provider: string | null; model: string | null } {
  const trimmed = s.trim();
  if (!trimmed) return { provider: null, model: null };
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: null, model: trimmed };
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return {
    provider: provider.length > 0 ? provider : null,
    model: model.length > 0 ? model : null,
  };
}
