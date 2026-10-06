import fs from "node:fs";
import { DEFAULT_GOOGLE_SCOPE_GROUPS, GOOGLE_SCOPE_GROUPS } from "./providers/google.js";
import { randomToken } from "./secrets.js";

/**
 * Boot configuration, read once from the environment.
 *
 * Connect is a separate container from the App, configured the way containers
 * usually are. Secrets may come from a file instead (`<NAME>_FILE`), which is
 * how Docker and Kubernetes secrets are normally mounted. Every problem is
 * reported at once and the process refuses to start: a sign-in service with a
 * half-applied configuration is worse than one that is plainly down.
 */
export type ConnectConfig = {
  port: number;
  listenHost: string;
  /** The exact origin people see in the address bar; callbacks are built from it. */
  publicUrl: string;
  /**
   * Seals the context a sign-in carries through the browser. Every replica
   * must share it, or a sign-in started on one cannot finish on another.
   */
  secret: string;
  /** True when none was configured and this process made up its own. */
  secretIsEphemeral: boolean;
  trustedProxyHops: number;
  accessLog: boolean;
  links: { privacy: string | null; terms: string | null };
  google: { clientId: string; clientSecret: string; scopeGroups: string[] } | null;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Genosyn Connect is not configured correctly:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An HTTPS origin; plain HTTP only on loopback, for development. */
export function normalizeServiceOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      return null;
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function httpsLink(value: string | undefined): string | null | undefined {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectConfig {
  const problems: string[] = [];

  function secretValue(name: string): string | undefined {
    const direct = env[name];
    const file = env[`${name}_FILE`];
    if (direct && file) {
      problems.push(`Set ${name} or ${name}_FILE, not both.`);
      return undefined;
    }
    if (!file) return direct?.trim() || undefined;
    try {
      return fs.readFileSync(file, "utf8").trim() || undefined;
    } catch {
      problems.push(`${name}_FILE could not be read.`);
      return undefined;
    }
  }

  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}.`);
      return fallback;
    }
    return value;
  }

  const port = integer("PORT", 8473, 1, 65_535);
  const trustedProxyHops = integer("CONNECT_TRUSTED_PROXY_HOPS", 0, 0, 10);
  const listenHost = env.CONNECT_LISTEN_HOST?.trim() || "0.0.0.0";

  const publicUrl = env.CONNECT_PUBLIC_URL ? normalizeServiceOrigin(env.CONNECT_PUBLIC_URL) : null;
  if (!env.CONNECT_PUBLIC_URL?.trim()) {
    problems.push(
      "CONNECT_PUBLIC_URL is required: the HTTPS origin people reach this service at, such as https://connect.example.com.",
    );
  } else if (!publicUrl) {
    problems.push(
      "CONNECT_PUBLIC_URL must be an HTTPS origin with no path, query, fragment or credentials. HTTP is allowed only on localhost.",
    );
  }

  if (env.CONNECT_DATABASE_URL || env.CONNECT_DATABASE_URL_FILE) {
    problems.push(
      "CONNECT_DATABASE_URL is no longer used: Genosyn Connect keeps no state. Remove it; several replicas need only the same CONNECT_SECRET.",
    );
  }

  let secret = secretValue("CONNECT_SECRET");
  let secretIsEphemeral = false;
  if (secret && secret.length < 32) {
    problems.push("CONNECT_SECRET must be at least 32 characters.");
  } else if (!secret) {
    // One process can make up its own key: a sign-in lives ten minutes, and a
    // restart only means the few open at that moment start again.
    secret = randomToken(32);
    secretIsEphemeral = true;
  }

  const accessLogValue = env.CONNECT_ACCESS_LOG?.trim().toLowerCase();
  if (accessLogValue && !["true", "false", "1", "0"].includes(accessLogValue)) {
    problems.push("CONNECT_ACCESS_LOG must be true or false.");
  }

  const privacy = httpsLink(env.CONNECT_PRIVACY_URL);
  const terms = httpsLink(env.CONNECT_TERMS_URL);
  if (privacy === undefined) problems.push("CONNECT_PRIVACY_URL must be an https:// URL.");
  if (terms === undefined) problems.push("CONNECT_TERMS_URL must be an https:// URL.");

  const googleClientId = env.CONNECT_GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = secretValue("CONNECT_GOOGLE_CLIENT_SECRET");
  let google: ConnectConfig["google"] = null;
  if (googleClientId || googleClientSecret) {
    if (!googleClientId || !googleClientSecret) {
      problems.push(
        "Set both CONNECT_GOOGLE_CLIENT_ID and CONNECT_GOOGLE_CLIENT_SECRET, or neither.",
      );
    } else {
      const known = new Set(GOOGLE_SCOPE_GROUPS.map((group) => group.key));
      const requested = (env.CONNECT_GOOGLE_SCOPE_GROUPS ?? DEFAULT_GOOGLE_SCOPE_GROUPS.join(","))
        .split(",")
        .map((key) => key.trim().toLowerCase())
        .filter(Boolean);
      const unknown = requested.filter((key) => !known.has(key));
      if (unknown.length > 0) {
        problems.push(
          `CONNECT_GOOGLE_SCOPE_GROUPS has unknown groups (${unknown.join(", ")}). Known groups: ${[...known].join(", ")}.`,
        );
      } else if (requested.length === 0) {
        problems.push("CONNECT_GOOGLE_SCOPE_GROUPS must name at least one group.");
      }
      google = {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        scopeGroups: [...new Set(requested)],
      };
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    port,
    listenHost,
    publicUrl: publicUrl!,
    secret: secret!,
    secretIsEphemeral,
    trustedProxyHops,
    accessLog: accessLogValue !== "false" && accessLogValue !== "0",
    links: { privacy: privacy ?? null, terms: terms ?? null },
    google,
  };
}
