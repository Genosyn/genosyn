import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  GLOBAL_SMTP_SETTING_KEY,
  getEffectiveGlobalSmtp,
  resetGlobalSmtpCacheForTests,
} from "./globalEmailTransport.js";
import {
  RUNTIME_SETTINGS_DEFAULTS,
  RUNTIME_SETTING_KEYS,
  getAgentSettings,
  getBrowserSettings,
  getMailSettings,
  getMeetingsSettings,
  getNetworkSettings,
  getRuntimeSettingsSnapshot,
  getWebSettings,
  importLegacyConfigOverrides,
  overrideRuntimeSettingsForTests,
  parseNetworkSettings,
  reloadRuntimeSettings,
  resetRuntimeSettingsCacheForTests,
  resetRuntimeSettingsGroup,
  saveRuntimeSettingsGroup,
  type LegacyRuntimeConfig,
} from "./runtimeSettings.js";

/**
 * The runtime settings service.
 *
 * Three things are load-bearing here and each is covered on its own terms.
 *
 * 1. **Defaults are the old `config.ts` values.** An install that never opens
 *    Admin → Runtime must behave exactly as it did before the file was slimmed.
 * 2. **A bad row can never take the server down.** These rows are hand-editable
 *    and can be written by an older build, so parsing is per field with a
 *    fallback, and a row that is not JSON at all is treated as absent.
 * 3. **The legacy import is the upgrade contract.** An install whose `config.ts`
 *    (or Kubernetes ConfigMap) is still the old shape keeps its behavior — and,
 *    just as importantly, an operator's saved value is never clobbered by a
 *    stale file on the next restart.
 */

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  resetRuntimeSettingsCacheForTests();
  resetGlobalSmtpCacheForTests();
});

/** Write a row directly, the way a hand edit or an older build would. */
async function writeRow(key: string, value: string): Promise<void> {
  const repo = AppDataSource.getRepository(AppSetting);
  await repo.save(repo.create({ key, value }));
}

async function readRow(key: string): Promise<string | null> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({ key });
  return row?.value ?? null;
}

/**
 * Add legacy keys to the real config object for the duration of one test, the
 * way an old-shape ConfigMap overlay or an un-migrated source install would.
 * Returns a restore function.
 */
function withLegacyConfig(legacy: LegacyRuntimeConfig): () => void {
  const mutable = config as unknown as Record<string, unknown>;
  const agent = mutable.agent as Record<string, unknown>;
  const addedTop: string[] = [];
  const addedAgent: string[] = [];
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "agent") continue;
    mutable[key] = value;
    addedTop.push(key);
  }
  for (const [key, value] of Object.entries(legacy.agent ?? {})) {
    agent[key] = value;
    addedAgent.push(key);
  }
  return () => {
    for (const key of addedTop) delete mutable[key];
    for (const key of addedAgent) delete agent[key];
  };
}

describe("defaults", () => {
  test("an install with no rows behaves exactly as the old config.ts did", async () => {
    await reloadRuntimeSettings();

    assert.deepEqual(getWebSettings(), {
      enabled: true,
      searchProvider: "duckduckgo",
      maxSearchResults: 8,
      maxDocumentBytes: 10 * 1024 * 1024,
      maxTextChars: 20_000,
    });
    assert.deepEqual(getMailSettings(), {
      syncIntervalSec: 60,
      backfillThreadsPerPass: 200,
      backfillPassSeconds: 25,
      backfillDays: 0,
    });
    assert.deepEqual(getMeetingsSettings(), {
      enabled: true,
      syncIntervalSeconds: 300,
      transcriptionModel: "whisper-1",
      maxRecordingBytes: 25 * 1024 * 1024,
    });
    assert.deepEqual(getBrowserSettings(), {
      executablePath: "",
      headless: "auto",
      locale: "",
      timezone: "",
      humanize: true,
    });
    assert.deepEqual(getAgentSettings(), {
      taintPolicy: "web",
      memberBrowsersEnabled: true,
      toolDiscovery: { enabled: true, minCatalogueSize: 40 },
    });
  });

  test("the snapshot reports every group as not overridden", async () => {
    const snapshot = await getRuntimeSettingsSnapshot();
    assert.deepEqual(snapshot.overridden, {
      web: false,
      mail: false,
      meetings: false,
      browser: false,
      agent: false,
      containment: false,
      network: false,
    });
  });

  test("the shipped defaults are a clone, not the object a getter hands out", async () => {
    await reloadRuntimeSettings();
    const web = getWebSettings();
    web.enabled = false;

    // A caller that scribbles on the group it was handed cannot reach the
    // shipped defaults, so the next refresh still restores the real value.
    assert.equal(RUNTIME_SETTINGS_DEFAULTS.web.enabled, true);
    await reloadRuntimeSettings();
    assert.equal(getWebSettings().enabled, true);
  });
});

describe("tolerant parse", () => {
  test("a row that is not JSON is ignored rather than thrown", async () => {
    await writeRow(RUNTIME_SETTING_KEYS.web, "{not json at all");

    await reloadRuntimeSettings();

    assert.deepEqual(getWebSettings(), RUNTIME_SETTINGS_DEFAULTS.web);
  });

  test("a JSON scalar where an object belongs falls back to defaults", async () => {
    await writeRow(RUNTIME_SETTING_KEYS.mail, "42");

    await reloadRuntimeSettings();

    assert.deepEqual(getMailSettings(), RUNTIME_SETTINGS_DEFAULTS.mail);
  });

  test("a partial row keeps its own values and defaults the rest", async () => {
    await writeRow(RUNTIME_SETTING_KEYS.mail, JSON.stringify({ syncIntervalSec: 900 }));

    await reloadRuntimeSettings();

    assert.deepEqual(getMailSettings(), {
      syncIntervalSec: 900,
      backfillThreadsPerPass: 200,
      backfillPassSeconds: 25,
      backfillDays: 0,
    });
  });

  test("a corrupt field falls back on its own without losing its neighbours", async () => {
    await writeRow(
      RUNTIME_SETTING_KEYS.web,
      JSON.stringify({
        enabled: "yes please",
        searchProvider: "bing",
        maxSearchResults: 3,
        maxDocumentBytes: -1,
        maxTextChars: 1.5,
      }),
    );

    await reloadRuntimeSettings();

    assert.deepEqual(getWebSettings(), {
      // Every bad value fell back; the one usable field survived.
      enabled: true,
      searchProvider: "duckduckgo",
      maxSearchResults: 3,
      maxDocumentBytes: 10 * 1024 * 1024,
      maxTextChars: 20_000,
    });
  });

  test("headless accepts auto and an explicit boolean, and nothing else", async () => {
    await writeRow(RUNTIME_SETTING_KEYS.browser, JSON.stringify({ headless: true }));
    await reloadRuntimeSettings();
    assert.equal(getBrowserSettings().headless, true);

    await AppDataSource.getRepository(AppSetting).delete({ key: RUNTIME_SETTING_KEYS.browser });
    await writeRow(RUNTIME_SETTING_KEYS.browser, JSON.stringify({ headless: "sometimes" }));
    await reloadRuntimeSettings();
    assert.equal(getBrowserSettings().headless, "auto");
  });

  test("a corrupt nested toolDiscovery does not take the agent group with it", async () => {
    await writeRow(
      RUNTIME_SETTING_KEYS.agent,
      JSON.stringify({ taintPolicy: "off", toolDiscovery: "on" }),
    );

    await reloadRuntimeSettings();

    assert.deepEqual(getAgentSettings(), {
      taintPolicy: "off",
      memberBrowsersEnabled: true,
      toolDiscovery: { enabled: true, minCatalogueSize: 40 },
    });
  });

  test("a bad row warns once rather than on every refresh", async () => {
    await writeRow(RUNTIME_SETTING_KEYS.web, JSON.stringify({ maxSearchResults: "eight" }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await reloadRuntimeSettings();
      await reloadRuntimeSettings();
      await reloadRuntimeSettings();
    } finally {
      // eslint-disable-next-line no-console
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /web\.maxSearchResults/);
  });
});

/**
 * The outbound private-host allowlist. Its parser is the only one that reads a
 * list, and the list is a security boundary: an entry here exempts a host from
 * the public-address check, so what the parser keeps and what it drops is worth
 * pinning entry by entry.
 */
describe("the network group", () => {
  test("a fresh install allows nothing beyond what config.ts already allowed", async () => {
    await reloadRuntimeSettings();

    assert.deepEqual(getNetworkSettings(), { privateHostAllowlist: [] });
  });

  test("a row round-trips through the cache", async () => {
    await writeRow(
      RUNTIME_SETTING_KEYS.network,
      JSON.stringify({ privateHostAllowlist: ["git.internal", "10.0.0.5"] }),
    );

    await reloadRuntimeSettings();

    assert.deepEqual(getNetworkSettings().privateHostAllowlist, ["git.internal", "10.0.0.5"]);
    assert.equal((await getRuntimeSettingsSnapshot()).overridden.network, true);
  });

  test("a value that is not a list at all falls back to the default", () => {
    assert.deepEqual(parseNetworkSettings({ privateHostAllowlist: "git.internal" }), {
      privateHostAllowlist: [],
    });
    assert.deepEqual(parseNetworkSettings({ privateHostAllowlist: 42 }), {
      privateHostAllowlist: [],
    });
    // A missing key is not a bad value; it is simply the default.
    assert.deepEqual(parseNetworkSettings({}), { privateHostAllowlist: [] });
    assert.deepEqual(parseNetworkSettings(null), { privateHostAllowlist: [] });
  });

  test("one unusable entry costs that entry, not the whole list", () => {
    const parsed = parseNetworkSettings({
      privateHostAllowlist: [
        "git.internal",
        42,
        null,
        { host: "sneaky.internal" },
        "",
        "   ",
        `${"a".repeat(254)}.internal`,
        "ollama.lan",
      ],
    });

    // Losing one pasted line is recoverable; losing the list would take every
    // self-hosted host in the install offline at once.
    assert.deepEqual(parsed.privateHostAllowlist, ["git.internal", "ollama.lan"]);
  });

  test("entries are normalized the way a hostname is normalized before matching", () => {
    const parsed = parseNetworkSettings({
      privateHostAllowlist: ["  GIT.Internal.  ", "git.internal", "GIT.INTERNAL", "ollama.lan."],
    });

    assert.deepEqual(parsed.privateHostAllowlist, ["git.internal", "ollama.lan"]);
  });

  test("the list is capped, and the entries past the cap are dropped", () => {
    const hosts = Array.from({ length: 150 }, (_value, index) => `host-${index}.internal`);

    const parsed = parseNetworkSettings({ privateHostAllowlist: hosts });

    assert.equal(parsed.privateHostAllowlist.length, 100);
    assert.equal(parsed.privateHostAllowlist[0], "host-0.internal");
    assert.equal(parsed.privateHostAllowlist[99], "host-99.internal");
  });

  test("a bad list warns once rather than on every refresh", async () => {
    await writeRow(
      RUNTIME_SETTING_KEYS.network,
      JSON.stringify({ privateHostAllowlist: "git.internal" }),
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await reloadRuntimeSettings();
      await reloadRuntimeSettings();
    } finally {
      // eslint-disable-next-line no-console
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /network\.privateHostAllowlist/);
    assert.deepEqual(getNetworkSettings().privateHostAllowlist, []);
  });

  test("a save normalizes on the way in, so the stored row is already matchable", async () => {
    const saved = await saveRuntimeSettingsGroup("network", {
      privateHostAllowlist: ["GIT.Internal.", "git.internal", " ollama.lan "],
    });

    assert.deepEqual(saved.privateHostAllowlist, ["git.internal", "ollama.lan"]);
    const stored = JSON.parse((await readRow(RUNTIME_SETTING_KEYS.network))!);
    assert.deepEqual(stored.privateHostAllowlist, ["git.internal", "ollama.lan"]);
    assert.deepEqual(getNetworkSettings().privateHostAllowlist, ["git.internal", "ollama.lan"]);
  });
});

describe("writing a group", () => {
  test("a save persists, normalizes, and updates this replica's cache at once", async () => {
    const saved = await saveRuntimeSettingsGroup("meetings", {
      enabled: false,
      syncIntervalSeconds: 120,
      transcriptionModel: "  whisper-large-v3  ",
      maxRecordingBytes: 5 * 1024 * 1024,
    });

    // Normalized on the way in, so the stored row is inside its bounds no
    // matter who wrote it.
    assert.equal(saved.transcriptionModel, "whisper-large-v3");
    // No refresh needed: the operator who saved sees the new behavior now.
    assert.equal(getMeetingsSettings().enabled, false);
    assert.equal(getMeetingsSettings().syncIntervalSeconds, 120);

    const stored = JSON.parse((await readRow(RUNTIME_SETTING_KEYS.meetings))!);
    assert.equal(stored.transcriptionModel, "whisper-large-v3");

    // And it survives a cold read on another replica.
    resetRuntimeSettingsCacheForTests();
    await reloadRuntimeSettings();
    assert.equal(getMeetingsSettings().enabled, false);
  });

  test("saving twice replaces the row rather than adding a second one", async () => {
    await saveRuntimeSettingsGroup("agent", {
      taintPolicy: "off",
      memberBrowsersEnabled: false,
      toolDiscovery: { enabled: false, minCatalogueSize: 10 },
    });
    await saveRuntimeSettingsGroup("agent", {
      taintPolicy: "web",
      memberBrowsersEnabled: false,
      toolDiscovery: { enabled: true, minCatalogueSize: 25 },
    });

    const rows = await AppDataSource.getRepository(AppSetting).find({
      where: { key: RUNTIME_SETTING_KEYS.agent },
    });
    assert.equal(rows.length, 1);
    assert.equal(getAgentSettings().taintPolicy, "web");
    assert.equal(getAgentSettings().toolDiscovery.minCatalogueSize, 25);
  });

  test("a reset drops the row and returns the group to the shipped defaults", async () => {
    await saveRuntimeSettingsGroup("web", {
      enabled: false,
      searchProvider: "disabled",
      maxSearchResults: 1,
      maxDocumentBytes: 2048,
      maxTextChars: 600,
    });
    assert.equal((await getRuntimeSettingsSnapshot()).overridden.web, true);

    await resetRuntimeSettingsGroup("web");

    assert.equal(await readRow(RUNTIME_SETTING_KEYS.web), null);
    assert.deepEqual(getWebSettings(), RUNTIME_SETTINGS_DEFAULTS.web);
    const snapshot = await getRuntimeSettingsSnapshot();
    assert.equal(snapshot.overridden.web, false);
    assert.deepEqual(snapshot.web, RUNTIME_SETTINGS_DEFAULTS.web);
  });

  test("one group's row does not disturb another's", async () => {
    await saveRuntimeSettingsGroup("browser", {
      executablePath: "/opt/chrome",
      headless: true,
      locale: "en-GB",
      timezone: "Europe/London",
      humanize: false,
    });

    await reloadRuntimeSettings();

    assert.equal(getBrowserSettings().executablePath, "/opt/chrome");
    assert.deepEqual(getWebSettings(), RUNTIME_SETTINGS_DEFAULTS.web);
    assert.deepEqual(getMailSettings(), RUNTIME_SETTINGS_DEFAULTS.mail);
  });
});

describe("test overrides", () => {
  test("an override wins over the cache and accumulates until cleared", async () => {
    await saveRuntimeSettingsGroup("web", {
      ...RUNTIME_SETTINGS_DEFAULTS.web,
      maxSearchResults: 5,
    });

    overrideRuntimeSettingsForTests({ web: { enabled: false } });
    assert.equal(getWebSettings().enabled, false);
    // Untouched fields still come from the stored row.
    assert.equal(getWebSettings().maxSearchResults, 5);

    overrideRuntimeSettingsForTests({ web: { searchProvider: "disabled" } });
    assert.equal(getWebSettings().enabled, false);
    assert.equal(getWebSettings().searchProvider, "disabled");

    overrideRuntimeSettingsForTests(null);
    assert.equal(getWebSettings().enabled, true);
    assert.equal(getWebSettings().searchProvider, "duckduckgo");
  });
});

describe("legacy config import", () => {
  test("no legacy keys means no writes at all", async () => {
    await importLegacyConfigOverrides();

    const rows = await AppDataSource.getRepository(AppSetting).find();
    assert.deepEqual(rows, []);
  });

  test("an old-shape overlay is carried into rows so behavior survives the upgrade", async () => {
    const restore = withLegacyConfig({
      web: { enabled: false, searchProvider: "disabled", maxSearchResults: 3 },
      mail: { syncIntervalSec: 600, backfillDays: 365 },
      meetings: { enabled: false, transcriptionModel: "whisper-large-v3" },
      browser: { executablePath: "/usr/bin/chromium", humanize: false },
      agent: {
        taintPolicy: "off",
        memberBrowsersEnabled: false,
        toolDiscovery: { enabled: false, minCatalogueSize: 5 },
      },
    });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    await reloadRuntimeSettings();

    assert.equal(getWebSettings().enabled, false);
    assert.equal(getWebSettings().searchProvider, "disabled");
    assert.equal(getWebSettings().maxSearchResults, 3);
    // Fields the overlay did not carry still take the shipped default.
    assert.equal(getWebSettings().maxTextChars, 20_000);

    assert.equal(getMailSettings().syncIntervalSec, 600);
    assert.equal(getMailSettings().backfillDays, 365);
    assert.equal(getMeetingsSettings().enabled, false);
    assert.equal(getMeetingsSettings().transcriptionModel, "whisper-large-v3");
    assert.equal(getBrowserSettings().executablePath, "/usr/bin/chromium");
    assert.equal(getBrowserSettings().humanize, false);
    assert.deepEqual(getAgentSettings(), {
      taintPolicy: "off",
      memberBrowsersEnabled: false,
      toolDiscovery: { enabled: false, minCatalogueSize: 5 },
    });
  });

  test("an existing row is never clobbered by a stale file", async () => {
    await saveRuntimeSettingsGroup("web", {
      ...RUNTIME_SETTINGS_DEFAULTS.web,
      maxSearchResults: 20,
    });

    const restore = withLegacyConfig({ web: { enabled: false, maxSearchResults: 3 } });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    await reloadRuntimeSettings();

    // The operator's saved value wins. Otherwise a ConfigMap nobody has
    // cleaned up would re-assert itself on every pod restart.
    assert.equal(getWebSettings().maxSearchResults, 20);
    assert.equal(getWebSettings().enabled, true);
  });

  test("importing twice is a no-op the second time", async () => {
    const restore = withLegacyConfig({ mail: { syncIntervalSec: 600 } });
    try {
      await importLegacyConfigOverrides();
      await saveRuntimeSettingsGroup("mail", {
        ...RUNTIME_SETTINGS_DEFAULTS.mail,
        syncIntervalSec: 30,
      });
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    await reloadRuntimeSettings();
    assert.equal(getMailSettings().syncIntervalSec, 30);
  });

  test("the agent group imports only when a retired key is still present", async () => {
    // `agent` survives in config.ts for codingTools, so its mere presence must
    // not be read as "there is something to import".
    await importLegacyConfigOverrides();
    assert.equal(await readRow(RUNTIME_SETTING_KEYS.agent), null);

    const restore = withLegacyConfig({ agent: { taintPolicy: "off" } });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    await reloadRuntimeSettings();
    assert.equal(getAgentSettings().taintPolicy, "off");
    // The two keys the overlay did not carry keep their defaults.
    assert.equal(getAgentSettings().memberBrowsersEnabled, true);
    assert.equal(getAgentSettings().toolDiscovery.enabled, true);
  });

  test("the network group is never imported, whatever config.ts allows", async () => {
    // `privateHostAllowed()` unions the two lists, so there is nothing to
    // carry over: importing would copy the config hosts into the row, union
    // them with themselves, and then the row-exists check would freeze out
    // every later edit to `config.ts`.
    const previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "git.internal");
    try {
      await importLegacyConfigOverrides();
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
    }

    assert.equal(await readRow(RUNTIME_SETTING_KEYS.network), null);
    await reloadRuntimeSettings();
    assert.deepEqual(getNetworkSettings().privateHostAllowlist, []);
    assert.equal((await getRuntimeSettingsSnapshot()).overridden.network, false);
  });

  test("a corrupt legacy value is normalized rather than imported as-is", async () => {
    const restore = withLegacyConfig({
      meetings: { enabled: "yes", syncIntervalSeconds: 1, transcriptionModel: "" },
    });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    await reloadRuntimeSettings();

    assert.deepEqual(getMeetingsSettings(), RUNTIME_SETTINGS_DEFAULTS.meetings);
  });

  test("a legacy SMTP block lands in the encrypted transport row", async () => {
    const restore = withLegacyConfig({
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "postbox",
        pass: "hunter2",
        fromName: "Acme",
        from: "no-reply@acme.test",
      },
    });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    const stored = JSON.parse((await readRow(GLOBAL_SMTP_SETTING_KEY))!);
    assert.equal(stored.host, "smtp.example.com");
    // The password is encrypted at rest, never stored in the clear.
    assert.notEqual(stored.encryptedPass, "hunter2");
    assert.ok(stored.encryptedPass.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "pass"), false);

    resetGlobalSmtpCacheForTests();
    const eff = await getEffectiveGlobalSmtp();
    assert.equal(eff.configured, true);
    assert.equal(eff.source, "database");
    assert.equal(eff.settings.host, "smtp.example.com");
    assert.equal(eff.settings.port, 465);
    assert.equal(eff.settings.secure, true);
    assert.equal(eff.settings.pass, "hunter2");
    assert.equal(eff.settings.fromName, "Acme");
    assert.equal(eff.settings.from, "no-reply@acme.test");
  });

  test("an empty legacy SMTP host still means disabled, and imports nothing", async () => {
    const restore = withLegacyConfig({
      smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "x@y.test" },
    });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    assert.equal(await readRow(GLOBAL_SMTP_SETTING_KEY), null);
    resetGlobalSmtpCacheForTests();
    assert.equal((await getEffectiveGlobalSmtp()).configured, false);
  });

  test("an existing transport row wins over a legacy SMTP block", async () => {
    await writeRow(
      GLOBAL_SMTP_SETTING_KEY,
      JSON.stringify({
        host: "smtp.saved.test",
        port: 587,
        secure: false,
        user: "",
        encryptedPass: "",
        fromName: "Saved",
        from: "saved@acme.test",
      }),
    );

    const restore = withLegacyConfig({
      smtp: { host: "smtp.stale.test", port: 25, secure: false, user: "", pass: "", from: "" },
    });
    try {
      await importLegacyConfigOverrides();
    } finally {
      restore();
    }

    resetGlobalSmtpCacheForTests();
    assert.equal((await getEffectiveGlobalSmtp()).settings.host, "smtp.saved.test");
  });
});
