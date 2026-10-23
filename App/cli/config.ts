import fs from "node:fs";
import path from "node:path";

import { CliError, usageError } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * Where `genosyn-api` keeps who it talks to, and how a run decides.
 *
 * A **profile** is one install, one company and one API key — the three
 * belong together, because a key works only for the company it was minted
 * in. Profiles live in `~/.genosyn/genosyn-api.json` (beside the operator
 * CLI's and the browser bridge's state), readable by the owner alone: the
 * file is written mode 0600 into a 0700 directory, atomically, and a file
 * found readable by others is tightened before it is used.
 *
 * Programs rarely want a file at all, so the environment wins over it:
 * `GENOSYN_URL`, `GENOSYN_API_KEY`, `GENOSYN_COMPANY` and `GENOSYN_PROFILE`
 * override the profile, and flags (`--url`, `--company`, `--profile`)
 * override the environment. A saved key is only ever sent to the install it
 * was saved for: pointing `GENOSYN_URL` somewhere else without also giving
 * that address a key is refused rather than leaking the key to it.
 */

export type Profile = {
  /** The install's address: origin plus any path prefix, no trailing slash. */
  url: string;
  companyId: string;
  apiKey?: string;
  companyName?: string;
  companySlug?: string;
  memberEmail?: string;
  keyName?: string;
  keyPrefix?: string;
  savedAt?: string;
};

export type ConfigFile = {
  version: 1;
  currentProfile?: string;
  profiles: Record<string, Profile>;
};

export const CONFIG_FILE_NAME = "genosyn-api.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The config file's path: `GENOSYN_CONFIG`, else `~/.genosyn/genosyn-api.json`. */
export function configPath(io: Pick<CliIo, "env" | "homedir" | "cwd">): string {
  const override = io.env.GENOSYN_CONFIG?.trim();
  if (override) return path.resolve(io.cwd, override);
  return path.join(io.homedir, ".genosyn", CONFIG_FILE_NAME);
}

/** Where cached API descriptions go: `GENOSYN_CACHE_DIR`, else `cache/` beside the config. */
export function cacheDir(io: Pick<CliIo, "env" | "homedir" | "cwd">): string {
  const override = io.env.GENOSYN_CACHE_DIR?.trim();
  if (override) return path.resolve(io.cwd, override);
  return path.join(path.dirname(configPath(io)), "cache");
}

export function emptyConfig(): ConfigFile {
  return { version: 1, profiles: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keep only well-formed profiles; an unknown field or a broken entry never stops the CLI. */
function normalizeConfig(raw: unknown): ConfigFile {
  const config = emptyConfig();
  if (!isRecord(raw)) return config;
  if (typeof raw.currentProfile === "string") config.currentProfile = raw.currentProfile;
  if (!isRecord(raw.profiles)) return config;
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.companyId !== "string") {
      continue;
    }
    const profile: Profile = { url: value.url, companyId: value.companyId };
    for (const key of [
      "apiKey",
      "companyName",
      "companySlug",
      "memberEmail",
      "keyName",
      "keyPrefix",
      "savedAt",
    ] as const) {
      if (typeof value[key] === "string") profile[key] = value[key] as string;
    }
    config.profiles[name] = profile;
  }
  return config;
}

export type LoadedConfig = {
  config: ConfigFile;
  path: string;
  exists: boolean;
  /** Notes for stderr, such as a permissions fix that could not be applied. */
  warnings: string[];
};

/** Read the config, tightening a file others can read. A missing file is an empty config. */
export function loadConfig(io: Pick<CliIo, "env" | "homedir" | "cwd" | "platform">): LoadedConfig {
  const file = configPath(io);
  const warnings: string[] = [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: emptyConfig(), path: file, exists: false, warnings };
    }
    throw new CliError("usage", `Can't read ${file}: ${(error as Error).message}`);
  }
  if (io.platform !== "win32") {
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          warnings.push(
            `${file} is readable by other users and could not be fixed; run chmod 600 on it.`,
          );
        }
      }
    } catch {
      // The file vanished between read and stat; nothing to tighten.
    }
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new CliError(
      "usage",
      `${file} is not valid JSON.`,
      { hint: "Fix it, or delete it and run `genosyn-api login` again." },
    );
  }
  return { config: normalizeConfig(parsed), path: file, exists: true, warnings };
}

/** Write the config atomically, mode 0600, creating its directory mode 0700. */
export function saveConfig(
  io: Pick<CliIo, "env" | "homedir" | "cwd" | "platform">,
  config: ConfigFile,
): string {
  const file = configPath(io);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  const body = `${JSON.stringify(config, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    if (io.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new CliError("internal", `Can't write ${file}: ${(error as Error).message}`);
  }
  return file;
}

/**
 * Split what someone pasted into the install's address and, when present,
 * the company: the Base URL Settings → API keys shows
 * (`https://host/api/companies/<id>`) carries both. Anything from `/api` on
 * is dropped, so `/api/docs` or a whole operation URL works too.
 */
export function parseBaseUrl(input: string): { baseUrl: string; companyId?: string } {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw usageError(
      `"${trimmed}" is not a URL.`,
      "Use your install's address, like https://genosyn.example.com, or the Base URL from Settings → API keys.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usageError(`"${trimmed}" is not an http(s) URL.`);
  }
  if (url.username || url.password) {
    throw usageError("Leave credentials out of the URL; the CLI sends the API key itself.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const apiAt = segments.indexOf("api");
  let companyId: string | undefined;
  let prefix = segments;
  if (apiAt !== -1) {
    prefix = segments.slice(0, apiAt);
    if (segments[apiAt + 1] === "companies" && segments[apiAt + 2]) {
      const candidate = decodeURIComponent(segments[apiAt + 2]);
      if (isUuid(candidate)) companyId = candidate.toLowerCase();
    }
  }
  const pathPrefix = prefix.length ? `/${prefix.join("/")}` : "";
  return { baseUrl: `${url.protocol}//${url.host}${pathPrefix}`, companyId };
}

/** Whether two base URLs name the same install (scheme, host, port and prefix). */
export function sameInstall(a: string, b: string): boolean {
  try {
    return parseBaseUrl(a).baseUrl.toLowerCase() === parseBaseUrl(b).baseUrl.toLowerCase();
  } catch {
    return false;
  }
}

/** A key reduced to what is safe to show: `gen_` and its first characters. */
export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return `${key.slice(0, Math.min(12, Math.max(4, key.length - 4)))}…`;
}

/** Whether `url` sends its traffic in the clear to another machine. */
export function isInsecureRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !(
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

export type ConnectionFlags = {
  profile?: string;
  url?: string;
  company?: string;
};

export type Source = "flag" | "env" | "profile";

export type Connection = {
  profileName?: string;
  profile?: Profile;
  baseUrl?: string;
  companyId?: string;
  apiKey?: string;
  sources: { url?: Source; company?: Source; apiKey?: Source; profile?: Source };
  /** Set when a saved key was withheld because the address points elsewhere. */
  withheldKeyFor?: string;
};

/** Which profile a run uses: `--profile`, `GENOSYN_PROFILE`, the current one, or the only one. */
export function selectProfile(
  config: ConfigFile,
  flags: ConnectionFlags,
  env: CliIo["env"],
): { name?: string; profile?: Profile; source?: Source } {
  const explicit = flags.profile ?? env.GENOSYN_PROFILE?.trim();
  if (explicit) {
    const profile = config.profiles[explicit];
    if (!profile) {
      const known = Object.keys(config.profiles);
      throw usageError(
        `No profile named "${explicit}".`,
        known.length
          ? `Profiles: ${known.join(", ")}.`
          : "Run `genosyn-api login` to create one.",
      );
    }
    return { name: explicit, profile, source: flags.profile ? "flag" : "env" };
  }
  const current = config.currentProfile;
  if (current && config.profiles[current]) {
    return { name: current, profile: config.profiles[current], source: "profile" };
  }
  const names = Object.keys(config.profiles);
  if (names.length === 1) return { name: names[0], profile: config.profiles[names[0]], source: "profile" };
  return {};
}

/** Decide the address, company and key for this run. Flags beat the environment beat the profile. */
export function resolveConnection(
  config: ConfigFile,
  flags: ConnectionFlags,
  env: CliIo["env"],
): Connection {
  const selected = selectProfile(config, flags, env);
  const profile = selected.profile;
  const connection: Connection = { sources: {} };
  if (selected.name) {
    connection.profileName = selected.name;
    connection.profile = profile;
    connection.sources.profile = selected.source;
  }

  const envUrl = env.GENOSYN_URL?.trim() || undefined;
  const flagParsed = flags.url ? parseBaseUrl(flags.url) : undefined;
  const envParsed = envUrl ? parseBaseUrl(envUrl) : undefined;
  if (flagParsed) {
    connection.baseUrl = flagParsed.baseUrl;
    connection.sources.url = "flag";
  } else if (envParsed) {
    connection.baseUrl = envParsed.baseUrl;
    connection.sources.url = "env";
  } else if (profile) {
    connection.baseUrl = profile.url;
    connection.sources.url = "profile";
  }
  const profileApplies =
    !!profile && !!connection.baseUrl && sameInstall(connection.baseUrl, profile.url);

  const envCompany = env.GENOSYN_COMPANY?.trim() || undefined;
  const companyCandidates: Array<[string | undefined, Source]> = [
    [flags.company, "flag"],
    [flagParsed?.companyId, "flag"],
    [envCompany, "env"],
    [envParsed?.companyId, "env"],
    [profileApplies ? profile?.companyId : undefined, "profile"],
  ];
  for (const [value, source] of companyCandidates) {
    if (!value) continue;
    if (!isUuid(value)) {
      throw usageError(
        `"${value}" is not a company id.`,
        "A company id is a UUID; Settings → API keys shows it in the Base URL.",
      );
    }
    connection.companyId = value.toLowerCase();
    connection.sources.company = source;
    break;
  }

  const envKey = env.GENOSYN_API_KEY?.trim() || undefined;
  if (envKey) {
    connection.apiKey = envKey;
    connection.sources.apiKey = "env";
  } else if (profile?.apiKey) {
    if (profileApplies) {
      connection.apiKey = profile.apiKey;
      connection.sources.apiKey = "profile";
    } else if (connection.baseUrl) {
      connection.withheldKeyFor = connection.baseUrl;
    }
  }
  return connection;
}

/** The address, or the error that tells a person how to give one. */
export function requireBaseUrl(connection: Connection): string {
  if (connection.baseUrl) return connection.baseUrl;
  throw new CliError("auth", "Not logged in: no Genosyn address.", {
    hint: "Run `genosyn-api login`, or set GENOSYN_URL to the Base URL from Settings → API keys.",
  });
}

export function requireCompany(connection: Connection): string {
  if (connection.companyId) return connection.companyId;
  throw new CliError("auth", "No company: the CLI doesn't know which company to act in.", {
    hint: "Use the Base URL from Settings → API keys (it ends in /api/companies/<id>), or set GENOSYN_COMPANY.",
  });
}

export function requireApiKey(connection: Connection): string {
  if (connection.apiKey) return connection.apiKey;
  if (connection.withheldKeyFor) {
    throw new CliError(
      "auth",
      `No API key for ${connection.withheldKeyFor}; the saved key belongs to ${connection.profile?.url}.`,
      { hint: "Set GENOSYN_API_KEY for that address, or run `genosyn-api login` to it." },
    );
  }
  throw new CliError("auth", "Not logged in: no API key.", {
    hint: "Run `genosyn-api login`, or set GENOSYN_API_KEY to a key from Settings → API keys.",
  });
}
