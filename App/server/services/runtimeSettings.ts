import { In } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import {
  GLOBAL_SMTP_SETTING_KEY,
  updateGlobalSmtpOverride,
} from "./globalEmailTransport.js";

/**
 * Operational settings an operator changes while the app is running.
 *
 * Most of these groups used to live in `config.ts`, which meant editing a file
 * and restarting a container to change how often mail syncs or whether the web
 * tools are on. `config.ts` is now only the things that must be settled before
 * the process can safely accept a request — secrets, database coordinates, and
 * the fail-closed security posture. Everything here is edited at
 * **Admin → Runtime** and stored as one JSON `AppSetting` row per group.
 *
 * `network` is the one group that did not move: its `config.security`
 * counterpart stays in the file and keeps working, because the outbound policy
 * is installed before the database is open. The two lists are unioned where the
 * question is asked — see `privateHostAllowed()` in `lib/outboundUrl.ts`.
 *
 * ## Read pattern
 *
 * Every consumer is a hot path: a per-tool-call web check, a per-turn tool
 * registry build, a per-tick mail heartbeat. So the getters are **synchronous**
 * and read a module-level cache, refreshed from the database every 30s by a
 * single shared timer started in {@link bootRuntimeSettings}. This is the
 * `services/publicUrl.ts` pattern, and the 30s refresh is what makes a change
 * saved on one replica reach the others without a restart. A getter hands back
 * the cached group itself rather than a copy — treat it as read-only.
 *
 * ## Tolerance
 *
 * A row is a plain JSON blob that a human can hand-edit and an older build can
 * have written. Parsing is per field: a value of the wrong type or outside its
 * bounds falls back to that field's default (and warns once — the refresh loop
 * would otherwise repeat the same complaint twice a minute), a missing field
 * falls back silently, and a row that is not JSON at all is treated as absent.
 * A bad row must never stop the server or a Run.
 */

export const RUNTIME_SETTING_KEYS = {
  web: "runtime.web",
  mail: "runtime.mail",
  meetings: "runtime.meetings",
  browser: "runtime.browser",
  agent: "runtime.agent",
  containment: "runtime.containment",
  network: "runtime.network",
} as const;

export type RuntimeSettingsGroup = keyof typeof RUNTIME_SETTING_KEYS;

export const RUNTIME_SETTINGS_GROUPS = Object.keys(
  RUNTIME_SETTING_KEYS,
) as RuntimeSettingsGroup[];

/** Open-web tools (`search_web`, `fetch_web_page`, `download_web_file`). */
export type RuntimeWebSettings = {
  /** Master switch. false makes the tools refuse with an explanation rather
   *  than disappear, so an employee can tell the human why. */
  enabled: boolean;
  /** "duckduckgo" reads the no-JavaScript HTML endpoint and needs no API key;
   *  "disabled" turns search off and leaves fetch and download working. */
  searchProvider: "duckduckgo" | "disabled";
  maxSearchResults: number;
  /** Bytes a page fetch or download may pull. */
  maxDocumentBytes: number;
  /** Characters of extracted page text handed to the model per fetch. */
  maxTextChars: number;
};

/** Gmail mailbox sync tuning (M25). */
export type RuntimeMailSettings = {
  /** How often an up-to-date mailbox re-checks for new mail, in seconds. */
  syncIntervalSec: number;
  /** Per backfill pass: stop after this many threads or this many seconds. */
  backfillThreadsPerPass: number;
  backfillPassSeconds: number;
  /** Only-recent cap for the first import. 0 imports the whole mailbox. */
  backfillDays: number;
};

/** Calendar mirror + meeting transcription (M42/M44). */
export type RuntimeMeetingsSettings = {
  /** false leaves connected calendars in place and stops the sync heartbeat. */
  enabled: boolean;
  syncIntervalSeconds: number;
  /** The model name sent to `/v1/audio/transcriptions`. */
  transcriptionModel: string;
  maxRecordingBytes: number;
};

/** The browser an AI Employee drives inside Genosyn's own container. */
export type RuntimeBrowserSettings = {
  /** Absolute path to the Chrome/Chromium binary. Empty means autodetect. */
  executablePath: string;
  /** "auto" runs headed whenever a display is available. */
  headless: "auto" | boolean;
  /** Locale and IANA timezone reported to sites. Empty inherits Chrome's. */
  locale: string;
  timezone: string;
  /** Type and click the way a person does. Leave on for anti-bot defenses. */
  humanize: boolean;
};

/** Agent runtime knobs that are not part of the boot security posture. */
export type RuntimeAgentSettings = {
  /** "web" marks a turn tainted once it ingests web content; "off" disables
   *  the escalation entirely (M53). */
  taintPolicy: "web" | "off";
  /** Member browsers: a Chrome a human connected from their own computer.
   *  Multi-tenant installs force this off in `services/memberBrowsers.ts`. */
  memberBrowsersEnabled: boolean;
  /** Show the model a working set and let it reach the rest through
   *  `find_tools` / `call_tool`, instead of every schema on every step (M30). */
  toolDiscovery: { enabled: boolean; minCatalogueSize: number };
};

/**
 * Containment (M58) — the knobs on the circuit breaker that stands a Routine
 * down after it has failed for long enough that the next slot is certain to
 * fail too. Operational rather than boot-critical: an operator raising the
 * threshold during an incident must not have to edit a file and restart a
 * container, which is exactly what AGENTS.md §5 exists to prevent.
 */
export type RuntimeContainmentSettings = {
  /**
   * Consecutive bad Runs on one Routine before the runner places a
   * `breaker`-sourced Standdown on it. 0 disables the breaker entirely, which
   * restores the pre-M58 behaviour of a broken Routine firing forever.
   */
  routineBreakerThreshold: number;
  /**
   * How stale a completed Run's missing outcome verdict has to be before the
   * re-grade sweep picks it up, in minutes. Long enough that the normal
   * in-line check is never raced; short enough that a restart inside the
   * verdict window is repaired the same hour.
   */
  regradeAfterMinutes: number;
  /** Runs re-graded per heartbeat pass. Each one is a model turn. */
  regradePerPass: number;
};

/**
 * Outbound network — the hosts Genosyn may reach even though they resolve to a
 * loopback, private, or otherwise non-public address.
 *
 * The escape hatch itself is not new; being able to change it without a restart
 * is. `config.security.outboundPrivateHostAllowlist` is still read and still
 * authoritative, because `installOutboundNetworkPolicy()` runs before the
 * database is open and this cache is still on its defaults in that window. This
 * list is unioned with it rather than replacing it, and a multi-tenant install
 * ignores this half entirely — both in `privateHostAllowed()`.
 */
export type RuntimeNetworkSettings = {
  /** Exact hostnames or IP literals, stored normalized and deduped. */
  privateHostAllowlist: string[];
};

export type RuntimeSettings = {
  web: RuntimeWebSettings;
  mail: RuntimeMailSettings;
  meetings: RuntimeMeetingsSettings;
  browser: RuntimeBrowserSettings;
  agent: RuntimeAgentSettings;
  containment: RuntimeContainmentSettings;
  network: RuntimeNetworkSettings;
};

/** Whether each group is currently backed by a stored row (vs. the default). */
export type RuntimeSettingsOverridden = Record<RuntimeSettingsGroup, boolean>;

export type RuntimeSettingsSnapshot = RuntimeSettings & {
  overridden: RuntimeSettingsOverridden;
};

const REFRESH_INTERVAL_MS = 30_000;

/**
 * The shipped defaults, character for character the values `config.ts` carried
 * before this module existed. Anything that changes here changes what a fresh
 * install does, so treat it the way you would treat a default in the file.
 */
export const RUNTIME_SETTINGS_DEFAULTS: Readonly<RuntimeSettings> = Object.freeze({
  web: {
    enabled: true,
    searchProvider: "duckduckgo",
    maxSearchResults: 8,
    maxDocumentBytes: 10 * 1024 * 1024,
    maxTextChars: 20_000,
  },
  mail: {
    syncIntervalSec: 60,
    backfillThreadsPerPass: 200,
    backfillPassSeconds: 25,
    backfillDays: 0,
  },
  meetings: {
    enabled: true,
    syncIntervalSeconds: 300,
    transcriptionModel: "whisper-1",
    maxRecordingBytes: 25 * 1024 * 1024,
  },
  browser: {
    executablePath: "",
    headless: "auto",
    locale: "",
    timezone: "",
    humanize: true,
  },
  agent: {
    taintPolicy: "web",
    memberBrowsersEnabled: true,
    toolDiscovery: { enabled: true, minCatalogueSize: 40 },
  },
  containment: {
    routineBreakerThreshold: 5,
    regradeAfterMinutes: 10,
    regradePerPass: 10,
  },
  network: {
    privateHostAllowlist: [],
  },
} satisfies RuntimeSettings);

/** A fresh, mutable copy of one group's defaults. */
export function defaultRuntimeSettingsGroup<G extends RuntimeSettingsGroup>(
  group: G,
): RuntimeSettings[G] {
  return structuredClone(RUNTIME_SETTINGS_DEFAULTS[group]) as RuntimeSettings[G];
}

/** A fresh, mutable copy of every default. */
export function defaultRuntimeSettings(): RuntimeSettings {
  return structuredClone(RUNTIME_SETTINGS_DEFAULTS) as RuntimeSettings;
}

// ───────────────────────────── tolerant parse ─────────────────────────────

const warned = new Set<string>();

function warnOnce(id: string, message: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  // eslint-disable-next-line no-console
  console.warn(`[runtimeSettings] ${message}`);
}

function forgetWarnings(group: RuntimeSettingsGroup): void {
  for (const id of [...warned]) {
    if (id === group || id.startsWith(`${group}.`)) warned.delete(id);
  }
}

function boolField(
  raw: Record<string, unknown>,
  group: RuntimeSettingsGroup,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnOnce(`${group}.${key}`, `${group}.${key} is not a boolean; using ${fallback}`);
  return fallback;
}

function stringField(
  raw: Record<string, unknown>,
  group: RuntimeSettingsGroup,
  key: string,
  fallback: string,
  maxLength = 500,
): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length <= maxLength) return value;
  warnOnce(`${group}.${key}`, `${group}.${key} is not a usable string; using the default`);
  return fallback;
}

function intField(
  raw: Record<string, unknown>,
  group: RuntimeSettingsGroup,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  warnOnce(
    `${group}.${key}`,
    `${group}.${key} must be an integer between ${min} and ${max}; using ${fallback}`,
  );
  return fallback;
}

function choiceField<T extends string>(
  raw: Record<string, unknown>,
  group: RuntimeSettingsGroup,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) {
    return value as T;
  }
  warnOnce(
    `${group}.${key}`,
    `${group}.${key} must be one of ${choices.join(", ")}; using ${fallback}`,
  );
  return fallback;
}

/** `headless` is the one tri-state: "auto" or an explicit boolean. */
function headlessField(raw: Record<string, unknown>, fallback: "auto" | boolean): "auto" | boolean {
  const value = raw.headless;
  if (value === undefined) return fallback;
  if (value === "auto" || typeof value === "boolean") return value;
  warnOnce("browser.headless", 'browser.headless must be "auto", true, or false; using "auto"');
  return fallback;
}

/**
 * The one list field, and the only one whose bad values are dropped rather than
 * taking the whole field back to its default.
 *
 * Entries are normalized the way `privateHostAllowed()` normalizes the
 * hostname it is asked about — trimmed, lowercased, trailing dot removed — so a
 * row hand-edited to `GIT.Internal.` still matches the lookup. A single junk
 * line then loses one host rather than the list: an operator who pasted one bad
 * entry should not discover it by way of every self-hosted Forgejo in the
 * install going unreachable at once. A value that is not an array at all is a
 * different thing — nothing in it is salvageable — and falls back like any
 * other field.
 */
function hostListField(
  raw: Record<string, unknown>,
  group: RuntimeSettingsGroup,
  key: string,
  fallback: readonly string[],
  maxEntries = 100,
  maxLength = 253,
): string[] {
  const value = raw[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    warnOnce(`${group}.${key}`, `${group}.${key} is not an array; using the default`);
    return [...fallback];
  }
  const hosts: string[] = [];
  let dropped = 0;
  for (const entry of value) {
    if (typeof entry !== "string") {
      dropped += 1;
      continue;
    }
    const host = normalizeAllowlistHost(entry);
    // A blank line is how a textarea ends, not a mistake worth reporting.
    if (!host) continue;
    if (host.length > maxLength || hosts.length >= maxEntries) {
      dropped += 1;
      continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (dropped > 0) {
    warnOnce(
      `${group}.${key}`,
      `${group}.${key} dropped ${dropped} unusable ${dropped === 1 ? "entry" : "entries"}; a host must be a string of at most ${maxLength} characters, and the list stops at ${maxEntries}`,
    );
  }
  return hosts;
}

/** Trim, lowercase, drop a trailing dot — the form a host is compared in. */
function normalizeAllowlistHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseWebSettings(raw: unknown): RuntimeWebSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.web;
  return {
    enabled: boolField(o, "web", "enabled", d.enabled),
    searchProvider: choiceField(o, "web", "searchProvider", ["duckduckgo", "disabled"] as const, d.searchProvider),
    maxSearchResults: intField(o, "web", "maxSearchResults", d.maxSearchResults, 1, 50),
    maxDocumentBytes: intField(
      o,
      "web",
      "maxDocumentBytes",
      d.maxDocumentBytes,
      1024,
      200 * 1024 * 1024,
    ),
    maxTextChars: intField(o, "web", "maxTextChars", d.maxTextChars, 500, 1_000_000),
  };
}

export function parseMailSettings(raw: unknown): RuntimeMailSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.mail;
  return {
    syncIntervalSec: intField(o, "mail", "syncIntervalSec", d.syncIntervalSec, 10, 86_400),
    backfillThreadsPerPass: intField(
      o,
      "mail",
      "backfillThreadsPerPass",
      d.backfillThreadsPerPass,
      1,
      5_000,
    ),
    backfillPassSeconds: intField(o, "mail", "backfillPassSeconds", d.backfillPassSeconds, 1, 600),
    backfillDays: intField(o, "mail", "backfillDays", d.backfillDays, 0, 36_500),
  };
}

export function parseMeetingsSettings(raw: unknown): RuntimeMeetingsSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.meetings;
  return {
    enabled: boolField(o, "meetings", "enabled", d.enabled),
    syncIntervalSeconds: intField(
      o,
      "meetings",
      "syncIntervalSeconds",
      d.syncIntervalSeconds,
      60,
      86_400,
    ),
    transcriptionModel:
      stringField(o, "meetings", "transcriptionModel", d.transcriptionModel, 200).trim() ||
      d.transcriptionModel,
    maxRecordingBytes: intField(
      o,
      "meetings",
      "maxRecordingBytes",
      d.maxRecordingBytes,
      1024,
      100 * 1024 * 1024,
    ),
  };
}

export function parseBrowserSettings(raw: unknown): RuntimeBrowserSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.browser;
  return {
    executablePath: stringField(o, "browser", "executablePath", d.executablePath, 1024),
    headless: headlessField(o, d.headless),
    locale: stringField(o, "browser", "locale", d.locale, 64),
    timezone: stringField(o, "browser", "timezone", d.timezone, 64),
    humanize: boolField(o, "browser", "humanize", d.humanize),
  };
}

/**
 * `toolDiscovery` is the one nested object. Its two fields are read from the
 * inner record but warn under `agent.toolDiscovery.*` ids, so a corrupt nested
 * value is as findable in the log as a top-level one.
 */
function parseToolDiscovery(raw: unknown): RuntimeAgentSettings["toolDiscovery"] {
  const d = RUNTIME_SETTINGS_DEFAULTS.agent.toolDiscovery;
  if (raw === undefined) return { ...d };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnOnce("agent.toolDiscovery", "agent.toolDiscovery is not an object; using defaults");
    return { ...d };
  }
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled;
  const minCatalogueSize = t.minCatalogueSize;
  let resolvedEnabled = d.enabled;
  if (typeof enabled === "boolean") {
    resolvedEnabled = enabled;
  } else if (enabled !== undefined) {
    warnOnce(
      "agent.toolDiscovery.enabled",
      `agent.toolDiscovery.enabled is not a boolean; using ${d.enabled}`,
    );
  }
  let resolvedMin = d.minCatalogueSize;
  if (
    typeof minCatalogueSize === "number" &&
    Number.isInteger(minCatalogueSize) &&
    minCatalogueSize >= 0 &&
    minCatalogueSize <= 10_000
  ) {
    resolvedMin = minCatalogueSize;
  } else if (minCatalogueSize !== undefined) {
    warnOnce(
      "agent.toolDiscovery.minCatalogueSize",
      `agent.toolDiscovery.minCatalogueSize must be an integer between 0 and 10000; using ${d.minCatalogueSize}`,
    );
  }
  return { enabled: resolvedEnabled, minCatalogueSize: resolvedMin };
}

export function parseAgentSettings(raw: unknown): RuntimeAgentSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.agent;
  return {
    taintPolicy: choiceField(o, "agent", "taintPolicy", ["web", "off"] as const, d.taintPolicy),
    memberBrowsersEnabled: boolField(o, "agent", "memberBrowsersEnabled", d.memberBrowsersEnabled),
    toolDiscovery: parseToolDiscovery(o.toolDiscovery),
  };
}

export function parseContainmentSettings(raw: unknown): RuntimeContainmentSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.containment;
  return {
    routineBreakerThreshold: intField(
      o,
      "containment",
      "routineBreakerThreshold",
      d.routineBreakerThreshold,
      0,
      1_000,
    ),
    regradeAfterMinutes: intField(
      o,
      "containment",
      "regradeAfterMinutes",
      d.regradeAfterMinutes,
      1,
      10_080,
    ),
    regradePerPass: intField(o, "containment", "regradePerPass", d.regradePerPass, 0, 200),
  };
}

/**
 * Deliberately absent from {@link importLegacyConfigOverrides}: the config list
 * this one widens is not a legacy block, it is live boot configuration that
 * `privateHostAllowed()` still reads. Importing it would copy those hosts into
 * the row, union them with themselves, and then the row-exists check would
 * freeze out every later edit to `config.ts`.
 */
export function parseNetworkSettings(raw: unknown): RuntimeNetworkSettings {
  const o = asRecord(raw);
  const d = RUNTIME_SETTINGS_DEFAULTS.network;
  return {
    privateHostAllowlist: hostListField(
      o,
      "network",
      "privateHostAllowlist",
      d.privateHostAllowlist,
    ),
  };
}

/** One parser per group, so refresh, write, and legacy import share a code path. */
const PARSERS: {
  [G in RuntimeSettingsGroup]: (raw: unknown) => RuntimeSettings[G];
} = {
  web: parseWebSettings,
  mail: parseMailSettings,
  meetings: parseMeetingsSettings,
  browser: parseBrowserSettings,
  agent: parseAgentSettings,
  containment: parseContainmentSettings,
  network: parseNetworkSettings,
};

// ────────────────────────────── the cache ──────────────────────────────────

let cache: RuntimeSettings = defaultRuntimeSettings();
let overridden: RuntimeSettingsOverridden = {
  web: false,
  mail: false,
  meetings: false,
  browser: false,
  agent: false,
  containment: false,
  network: false,
};
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Test-only overlay. Wins over the cache without touching the database. */
type RuntimeSettingsOverrides = {
  [G in RuntimeSettingsGroup]?: Partial<RuntimeSettings[G]>;
};
let testOverrides: RuntimeSettingsOverrides = {};

function effective<G extends RuntimeSettingsGroup>(group: G): RuntimeSettings[G] {
  const override = testOverrides[group];
  if (!override) return cache[group];
  return { ...cache[group], ...override } as RuntimeSettings[G];
}

/** Web tools. Read per tool invocation. */
export function getWebSettings(): RuntimeWebSettings {
  return effective("web");
}

/** Mail sync. Read per heartbeat tick and per backfill pass. */
export function getMailSettings(): RuntimeMailSettings {
  return effective("mail");
}

/** Meetings. Read per heartbeat tick, per upload, and per transcription. */
export function getMeetingsSettings(): RuntimeMeetingsSettings {
  return effective("meetings");
}

/** The container's browser. Read per launch and per input action. */
export function getBrowserSettings(): RuntimeBrowserSettings {
  return effective("browser");
}

/** Agent knobs. Read per turn and per tool call. */
export function getAgentSettings(): RuntimeAgentSettings {
  return effective("agent");
}

/** Containment. Read at every Run finalization and on every heartbeat pass. */
export function getContainmentSettings(): RuntimeContainmentSettings {
  return effective("containment");
}

/**
 * The outbound private-host allowlist. Read from inside the DNS callback in
 * `services/outboundNetworkPolicy.ts`, which is installed on both global HTTP
 * agents and the undici dispatcher — so this must stay synchronous, must never
 * throw, and must never touch the database or the network. It hands back the
 * cached group itself, like every other getter: do not mutate it.
 */
export function getNetworkSettings(): RuntimeNetworkSettings {
  return effective("network");
}

function parseRow(group: RuntimeSettingsGroup, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    warnOnce(group, `${RUNTIME_SETTING_KEYS[group]} is not valid JSON; using defaults`);
    return null;
  }
}

async function refreshRuntimeSettings(): Promise<void> {
  const rows = await AppDataSource.getRepository(AppSetting).find({
    where: { key: In(Object.values(RUNTIME_SETTING_KEYS)) },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const next = defaultRuntimeSettings();
  const nextOverridden: RuntimeSettingsOverridden = {
    web: false,
    mail: false,
    meetings: false,
    browser: false,
    agent: false,
    containment: false,
    network: false,
  };
  for (const group of RUNTIME_SETTINGS_GROUPS) {
    const raw = byKey.get(RUNTIME_SETTING_KEYS[group]);
    if (raw === undefined || raw === "") continue;
    const parsed = parseRow(group, raw);
    if (parsed === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[group] = PARSERS[group](parsed);
    nextOverridden[group] = true;
  }
  cache = next;
  overridden = nextOverridden;
}

/**
 * Load before Express is constructed, then keep horizontally-scaled pods fresh.
 * Mirrors `bootPublicUrl()`; the timer is unref'd so it never holds the process
 * open, and a transient database failure keeps the last known-good values.
 */
export async function bootRuntimeSettings(): Promise<void> {
  await refreshRuntimeSettings();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshRuntimeSettings().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[runtimeSettings] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/** Effective values plus which groups are backed by a stored row. */
export async function getRuntimeSettingsSnapshot(): Promise<RuntimeSettingsSnapshot> {
  await refreshRuntimeSettings();
  return {
    web: effective("web"),
    mail: effective("mail"),
    meetings: effective("meetings"),
    browser: effective("browser"),
    agent: effective("agent"),
    containment: effective("containment"),
    network: effective("network"),
    overridden: { ...overridden },
  };
}

/**
 * Replace one group wholesale and update this replica's cache immediately, so
 * the operator who saved sees the new behavior without waiting for a refresh.
 * The value is round-tripped through the group's parser, which is what keeps a
 * stored row inside its documented bounds no matter who wrote it.
 */
export async function saveRuntimeSettingsGroup<G extends RuntimeSettingsGroup>(
  group: G,
  value: RuntimeSettings[G],
): Promise<RuntimeSettings[G]> {
  const normalized = PARSERS[group](value);
  await AppDataSource.getRepository(AppSetting).upsert(
    { key: RUNTIME_SETTING_KEYS[group], value: JSON.stringify(normalized) },
    ["key"],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cache as any)[group] = normalized;
  overridden[group] = true;
  forgetWarnings(group);
  return normalized;
}

/** Drop the stored row so the group falls back to the shipped defaults. */
export async function resetRuntimeSettingsGroup<G extends RuntimeSettingsGroup>(
  group: G,
): Promise<RuntimeSettings[G]> {
  await AppDataSource.getRepository(AppSetting).delete({ key: RUNTIME_SETTING_KEYS[group] });
  const defaults = defaultRuntimeSettingsGroup(group);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cache as any)[group] = defaults;
  overridden[group] = false;
  forgetWarnings(group);
  return defaults;
}

// ───────────────────────────── test seams ──────────────────────────────────

/**
 * Force fields on for a test without a database round-trip. Successive calls
 * accumulate; pass `null` to drop every override.
 */
export function overrideRuntimeSettingsForTests(patch: RuntimeSettingsOverrides | null): void {
  if (patch === null) {
    testOverrides = {};
    return;
  }
  for (const group of RUNTIME_SETTINGS_GROUPS) {
    const value = patch[group];
    if (!value) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (testOverrides as any)[group] = { ...(testOverrides[group] ?? {}), ...value };
  }
}

/** Drop the cache back to defaults, forget warnings, and clear overrides. */
export function resetRuntimeSettingsCacheForTests(): void {
  cache = defaultRuntimeSettings();
  overridden = {
    web: false,
    mail: false,
    meetings: false,
    browser: false,
    agent: false,
    containment: false,
    network: false,
  };
  testOverrides = {};
  warned.clear();
}

/** Re-read every group from the database ahead of the 30s timer. For tests. */
export async function reloadRuntimeSettings(): Promise<void> {
  await refreshRuntimeSettings();
}

// ──────────────────────── legacy config compatibility ──────────────────────

/**
 * The shape `config.ts` used to have.
 *
 * A Kubernetes install overrides configuration by mounting a ConfigMap-rendered
 * `config.js` over the compiled one, and a source install may simply have an
 * edited file. Either can still be the *old* shape after an upgrade, carrying
 * the operational blocks this module replaced. Nothing enumerates config keys,
 * so those stale keys are inert — which is exactly the problem: an install that
 * had turned the web tools off, or pointed transcription at a local whisper,
 * would silently come back up with the shipped defaults.
 */
export type LegacyRuntimeConfig = {
  smtp?: {
    host?: unknown;
    port?: unknown;
    secure?: unknown;
    user?: unknown;
    pass?: unknown;
    fromName?: unknown;
    from?: unknown;
  };
  web?: unknown;
  mail?: unknown;
  meetings?: unknown;
  browser?: unknown;
  agent?: {
    taintPolicy?: unknown;
    memberBrowsersEnabled?: unknown;
    toolDiscovery?: unknown;
  };
};

/** The legacy `agent.*` keys this module took over. */
const LEGACY_AGENT_KEYS = ["taintPolicy", "memberBrowsersEnabled", "toolDiscovery"] as const;

async function settingRowExists(key: string): Promise<boolean> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({ key });
  return Boolean(row?.value);
}

/**
 * Carry an old-shape config into the database, once, at boot.
 *
 * The contract is deliberately conservative in one direction only: a group is
 * imported when the config object still carries that key **and** no row exists
 * yet. A row that is already there is never touched — the operator's saved
 * value always wins over a stale file, which is what makes the upgrade
 * idempotent and what keeps a ConfigMap nobody has cleaned up from re-asserting
 * itself on every pod restart.
 *
 * Runs after `initDb()` (it writes rows) and after the instance secrets are
 * bound to the database (the SMTP password is encrypted on the way in).
 */
export async function importLegacyConfigOverrides(): Promise<void> {
  const legacy = config as unknown as LegacyRuntimeConfig;

  for (const group of RUNTIME_SETTINGS_GROUPS) {
    const raw =
      group === "agent"
        ? legacyAgentBlock(legacy)
        : (legacy as unknown as Record<string, unknown>)[group];
    if (raw === undefined) continue;
    if (await settingRowExists(RUNTIME_SETTING_KEYS[group])) continue;
    const value = PARSERS[group](raw);
    await AppDataSource.getRepository(AppSetting).upsert(
      { key: RUNTIME_SETTING_KEYS[group], value: JSON.stringify(value) },
      ["key"],
    );
    // eslint-disable-next-line no-console
    console.log(
      `[runtimeSettings] imported the legacy config.${group} block into ${RUNTIME_SETTING_KEYS[group]} — edit it at Admin → Runtime and drop the block from config.ts`,
    );
  }

  await importLegacySmtp(legacy);
}

/**
 * `agent` survives in `config.ts` (it still carries `codingTools` and
 * `browserEnabledInMultiTenant`), so "the key is present" is not the test here.
 * Import only when one of the three keys this module took over is still there.
 */
function legacyAgentBlock(legacy: LegacyRuntimeConfig): Record<string, unknown> | undefined {
  const agent = legacy.agent;
  if (!agent || typeof agent !== "object") return undefined;
  const present = LEGACY_AGENT_KEYS.filter((key) => agent[key] !== undefined);
  if (present.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of present) out[key] = agent[key];
  return out;
}

/**
 * SMTP has its own row, its own encryption, and its own resolver, so it is
 * imported through the existing write path rather than as a sixth group. An
 * empty host meant "disabled" in the file and still does, so it imports
 * nothing.
 */
async function importLegacySmtp(legacy: LegacyRuntimeConfig): Promise<void> {
  const smtp = legacy.smtp;
  if (!smtp || typeof smtp !== "object") return;
  const host = typeof smtp.host === "string" ? smtp.host.trim() : "";
  if (!host) return;
  if (await settingRowExists(GLOBAL_SMTP_SETTING_KEY)) return;
  await updateGlobalSmtpOverride({
    host,
    port: typeof smtp.port === "number" ? smtp.port : 587,
    secure: Boolean(smtp.secure),
    user: typeof smtp.user === "string" ? smtp.user : "",
    pass: typeof smtp.pass === "string" ? smtp.pass : "",
    fromName: typeof smtp.fromName === "string" ? smtp.fromName : "",
    from: typeof smtp.from === "string" ? smtp.from : "",
  });
  // eslint-disable-next-line no-console
  console.log(
    `[runtimeSettings] imported the legacy config.smtp block into ${GLOBAL_SMTP_SETTING_KEY} — edit it at Admin → Email transport and drop the block from config.ts`,
  );
}
