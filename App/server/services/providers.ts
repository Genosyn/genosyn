import fs from "node:fs";
import type { AIModel, Provider } from "../db/entities/AIModel.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import {
  claudeCredsPath,
  codexCredsPath,
  employeeClaudeDir,
  employeeCodexDir,
  employeeOpencodeDir,
  opencodeCredsPath,
} from "./paths.js";

/**
 * Per-provider integration facts. Centralised here so the route layer, the
 * runner seam and the UI one-liner all agree on the same env var name,
 * credentials path and login command.
 *
 * Claude Code is the only provider with a production-ready headless CLI in
 * this milestone; codex and opencode are wired end-to-end with the same
 * shape (subscription login + API key), and degrade gracefully when the CLI
 * binary isn't installed.
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
  /** Shell command the operator runs to log in (scoped via configDirEnv). */
  loginCommand: string;
  /** Absolute path to the employee's per-provider config dir. */
  configDir(companySlug: string, employeeSlug: string): string;
  /** Absolute path to the creds file the provider drops on successful login. */
  credsPath(companySlug: string, employeeSlug: string): string;
};

/**
 * A Model is "connected" if credentials are actually usable:
 *  - subscription: creds file exists on disk at the provider's config dir
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
  try {
    return fs.existsSync(PROVIDERS[m.provider].credsPath(co.slug, emp.slug));
  } catch {
    return false;
  }
}

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  "claude-code": {
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    configDirEnv: "CLAUDE_CONFIG_DIR",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    loginCommand: "claude login",
    configDir: employeeClaudeDir,
    credsPath: claudeCredsPath,
  },
  codex: {
    label: "Codex",
    defaultModel: "gpt-5-codex",
    configDirEnv: "CODEX_HOME",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsApiKey: true,
    loginCommand: "codex login",
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
    loginCommand: "opencode auth login",
    configDir: employeeOpencodeDir,
    credsPath: opencodeCredsPath,
  },
};
