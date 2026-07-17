import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { config } from "../../config.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";

/**
 * The install-wide "global" email transport — the SMTP server that system-level
 * sends (password resets, invites, welcomes) fall back to when a company has no
 * `EmailProvider` row of its own.
 *
 * Historically this lived *only* in the static `config.ts` SMTP block, which
 * meant editing a file + restarting to change it. This service adds a
 * database-backed override (stored as a single JSON `AppSetting` row, the same
 * mechanism the Web Push VAPID keypair uses) so operators can configure it from
 * Admin → Email transport without touching the filesystem.
 *
 * Resolution order for the *effective* transport:
 *   1. The DB override (Admin → Email transport), if its host is set.
 *   2. The `config.ts` SMTP block, if its host is set.
 *   3. None — sends log to the console.
 *
 * The stored password is encrypted at rest with the same key that protects
 * every other secret (see `lib/secret.ts`). It is only ever decrypted into
 * memory to build a transport; it is never returned to the client.
 */

export const GLOBAL_SMTP_SETTING_KEY = "smtp.global";

export type GlobalSmtpSource = "database" | "config" | "none";

/** Fully-resolved, ready-to-send settings. The password is in the clear and
 *  must never leave the server process. */
export type ResolvedGlobalSmtp = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  from: string;
};

export type EffectiveGlobalSmtp = {
  /** True when a usable SMTP host is resolved (from DB or config). */
  configured: boolean;
  source: GlobalSmtpSource;
  settings: ResolvedGlobalSmtp;
};

/** Non-secret view returned to the admin client. */
export type GlobalSmtpDescriptor = {
  configured: boolean;
  source: GlobalSmtpSource;
  /** True when a DB override row exists (so the "Reset" action is offered). */
  overrideActive: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  fromName: string;
  from: string;
  /** Whether a password is currently in effect (never the value itself). */
  hasPassword: boolean;
  /** What the `config.ts` fallback provides, so the UI can describe a reset. */
  configFallback: {
    configured: boolean;
    host: string;
    fromName: string;
    from: string;
  };
};

/** Payload the admin form submits for save / test. */
export type GlobalSmtpInput = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Blank means "keep the password currently in effect". */
  pass: string;
  /** Omitted by older API clients; blank explicitly sends without a name. */
  fromName?: string;
  from: string;
};

/** Shape persisted in the `AppSetting` value column (JSON). */
type StoredGlobalSmtp = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Encrypted; empty string when no password is set. */
  encryptedPass: string;
  fromName: string;
  from: string;
};

// In-process cache of the resolved transport. Invalidated whenever the override
// is written or cleared; config.ts is static within a process so a restart is
// the only other way the resolution can change.
let effectiveCache: EffectiveGlobalSmtp | null = null;

function invalidateCache(): void {
  effectiveCache = null;
}

/**
 * Older installs stored the display name and address together in `from`.
 * Split that shape on read so adding the dedicated From name field is a
 * backwards-compatible settings change rather than a migration.
 */
function splitSender(
  rawFrom: string,
  explicitName = "",
): { fromName: string; from: string } {
  const trimmed = rawFrom.trim();
  const match = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
  if (!match) return { fromName: explicitName.trim(), from: trimmed };
  return {
    fromName: explicitName.trim() || match[1].trim().replace(/^"|"$/g, ""),
    from: match[2].trim(),
  };
}

function configSender(): { fromName: string; from: string } {
  return splitSender(config.smtp.from, config.smtp.fromName);
}

/** Human-readable RFC-style sender used in Email Logs. */
export function formatGlobalSmtpSender(settings: ResolvedGlobalSmtp): string {
  return settings.fromName
    ? `${settings.fromName} <${settings.from}>`
    : settings.from;
}

async function readStoredOverride(): Promise<StoredGlobalSmtp | null> {
  const repo = AppDataSource.getRepository(AppSetting);
  const row = await repo.findOneBy({ key: GLOBAL_SMTP_SETTING_KEY });
  if (!row?.value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Corrupt row — treat as absent rather than throwing on every send.
    // eslint-disable-next-line no-console
    console.warn("[email] global SMTP override is not valid JSON; ignoring it");
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const sender = splitSender(
    typeof o.from === "string" ? o.from : "",
    typeof o.fromName === "string" ? o.fromName : "",
  );
  return {
    host: typeof o.host === "string" ? o.host : "",
    port: typeof o.port === "number" ? o.port : Number(o.port) || 587,
    secure: Boolean(o.secure),
    user: typeof o.user === "string" ? o.user : "",
    encryptedPass: typeof o.encryptedPass === "string" ? o.encryptedPass : "",
    fromName: sender.fromName,
    from: sender.from,
  };
}

function decryptStoredPass(encryptedPass: string): string {
  if (!encryptedPass) return "";
  try {
    return decryptSecret(encryptedPass);
  } catch {
    // A rotated sessionSecret invalidates stored secrets. Degrade to no auth
    // rather than crashing the send path; the admin page still shows the host.
    // eslint-disable-next-line no-console
    console.warn(
      "[email] could not decrypt the stored global SMTP password (was sessionSecret rotated?) — sending without auth",
    );
    return "";
  }
}

/**
 * Resolve the effective global SMTP transport, preferring the DB override over
 * the `config.ts` block. Cached in-process; the cache is cleared on any write.
 */
export async function getEffectiveGlobalSmtp(): Promise<EffectiveGlobalSmtp> {
  if (effectiveCache) return effectiveCache;

  const override = await readStoredOverride();
  const fallbackSender = configSender();
  if (override && override.host) {
    effectiveCache = {
      configured: true,
      source: "database",
      settings: {
        host: override.host,
        port: override.port,
        secure: override.secure,
        user: override.user,
        pass: decryptStoredPass(override.encryptedPass),
        fromName: override.fromName,
        from: override.from || fallbackSender.from,
      },
    };
    return effectiveCache;
  }

  if (config.smtp.host) {
    effectiveCache = {
      configured: true,
      source: "config",
      settings: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        user: config.smtp.user,
        pass: config.smtp.pass,
        fromName: fallbackSender.fromName,
        from: fallbackSender.from,
      },
    };
    return effectiveCache;
  }

  effectiveCache = {
    configured: false,
    source: "none",
    settings: {
      host: "",
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: "",
      pass: "",
      fromName: fallbackSender.fromName,
      from: fallbackSender.from,
    },
  };
  return effectiveCache;
}

/** Non-secret summary for the admin GET endpoint. */
export async function describeGlobalSmtp(): Promise<GlobalSmtpDescriptor> {
  const [override, eff] = await Promise.all([
    readStoredOverride(),
    getEffectiveGlobalSmtp(),
  ]);
  return {
    configured: eff.configured,
    source: eff.source,
    overrideActive: Boolean(override && override.host),
    host: eff.settings.host,
    port: eff.settings.port,
    secure: eff.settings.secure,
    user: eff.settings.user,
    fromName: eff.settings.fromName,
    from: eff.settings.from,
    hasPassword: Boolean(eff.settings.pass),
    configFallback: {
      configured: Boolean(config.smtp.host),
      host: config.smtp.host,
      fromName: configSender().fromName,
      from: configSender().from,
    },
  };
}

/**
 * Merge a form payload into a fully-resolved settings object. A blank password
 * field means "keep whatever password is currently in effect" (whether that
 * came from a previous DB override or from `config.ts`), so operators can edit
 * the host or port without re-typing the secret.
 */
export async function resolveGlobalSmtpDraft(
  input: GlobalSmtpInput,
): Promise<ResolvedGlobalSmtp> {
  const current = await getEffectiveGlobalSmtp();
  const pass = input.pass !== "" ? input.pass : current.settings.pass;
  const fallbackSender = configSender();
  const sender = splitSender(
    input.from,
    input.fromName === undefined ? current.settings.fromName : input.fromName,
  );
  return {
    host: input.host.trim(),
    port: input.port,
    secure: input.secure,
    user: input.user.trim(),
    pass,
    fromName: sender.fromName,
    from: sender.from || fallbackSender.from,
  };
}

/** Persist (or replace) the DB override and invalidate the transport cache. */
export async function updateGlobalSmtpOverride(
  input: GlobalSmtpInput,
): Promise<void> {
  const resolved = await resolveGlobalSmtpDraft(input);
  if (!resolved.host) {
    throw new Error("SMTP host is required");
  }
  const stored: StoredGlobalSmtp = {
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    user: resolved.user,
    encryptedPass: resolved.pass ? encryptSecret(resolved.pass) : "",
    fromName: resolved.fromName,
    from: input.from.trim(),
  };
  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key: GLOBAL_SMTP_SETTING_KEY });
  const value = JSON.stringify(stored);
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key: GLOBAL_SMTP_SETTING_KEY, value }));
  }
  invalidateCache();
}

/** Remove the DB override, reverting to the `config.ts` block (or console). */
export async function clearGlobalSmtpOverride(): Promise<void> {
  const repo = AppDataSource.getRepository(AppSetting);
  await repo.delete({ key: GLOBAL_SMTP_SETTING_KEY });
  invalidateCache();
}
