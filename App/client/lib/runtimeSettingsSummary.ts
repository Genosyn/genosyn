import type { RuntimeSettings, RuntimeSettingsGroup } from "./api";

/**
 * What Admin → Runtime says about a section it keeps collapsed.
 *
 * Each section is one line until opened, so that line has to say whether
 * anything inside was changed from the shipped values: "Defaults", or "3
 * customized". The snapshot the server sends holds the current values and a
 * flag for "a row is stored", but not the defaults — so the defaults are
 * mirrored here, and `server/client/runtimeSettingsSummary.test.ts` fails the
 * moment `RUNTIME_SETTINGS_DEFAULTS` on the server and this copy disagree.
 * Change them together.
 */
export const RUNTIME_DEFAULTS: Readonly<RuntimeSettings> = {
  web: {
    enabled: true,
    searchProvider: "duckduckgo",
    searxngUrl: "",
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
  oauth: {
    hostedSignInEnabled: true,
    hostedSignInUrl: "https://connect.genosyn.com",
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
    recordingRetentionDays: 7,
  },
  agent: {
    maxConcurrentTurnsPerCompany: 8,
    taintPolicy: "web",
    memberBrowsersEnabled: true,
    toolDiscovery: { enabled: true, minCatalogueSize: 40 },
  },
  containment: {
    regradeAfterMinutes: 10,
    regradePerPass: 10,
  },
  network: {
    privateHostAllowlist: [],
  },
  banking: {
    syncEnabled: true,
    syncIntervalMinutes: 30,
  },
  emailVerification: {
    enabled: true,
    smtpProbe: true,
    probeFromAddress: "",
    probeTimeoutMs: 7_000,
    maxCandidates: 12,
  },
};

/** Read a dotted path (`toolDiscovery.enabled`) out of a settings group. */
export function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

/** Structural equality for the values a group holds: scalars, lists and one nested object. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

/**
 * Which of `paths` hold something other than the shipped default, in the order
 * given. A group that has never been saved is all defaults, so this is empty.
 */
export function customizedPaths(
  group: RuntimeSettingsGroup,
  value: unknown,
  paths: readonly string[],
): string[] {
  return paths.filter(
    (path) => !sameValue(readPath(value, path), readPath(RUNTIME_DEFAULTS[group], path)),
  );
}

/** The one-line summary of a collapsed section: "Defaults" or "3 customized". */
export function describeCustomized(count: number): string {
  return count === 0 ? "Defaults" : `${count} customized`;
}
