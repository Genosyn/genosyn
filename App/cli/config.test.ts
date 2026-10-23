import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  cacheDir,
  configPath,
  emptyConfig,
  isInsecureRemote,
  loadConfig,
  maskKey,
  parseBaseUrl,
  requireApiKey,
  requireBaseUrl,
  requireCompany,
  resolveConnection,
  sameInstall,
  saveConfig,
  selectProfile,
  type ConfigFile,
} from "./config.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { tempDir } from "./test/support.js";

const COMPANY = "11111111-2222-4333-8444-555555555555";
const OTHER_COMPANY = "99999999-2222-4333-8444-555555555555";
const posix = process.platform !== "win32";

function ioFor(dir: string, env: Record<string, string | undefined> = {}) {
  return { env, homedir: dir, cwd: dir, platform: process.platform };
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function config(profiles: ConfigFile["profiles"], currentProfile?: string): ConfigFile {
  return { version: 1, currentProfile, profiles };
}

describe("where the config lives", () => {
  test("defaults to ~/.genosyn/genosyn-api.json with the cache beside it", () => {
    const io = ioFor("/home/ada");
    assert.equal(configPath(io), path.join("/home/ada", ".genosyn", "genosyn-api.json"));
    assert.equal(cacheDir(io), path.join("/home/ada", ".genosyn", "cache"));
  });

  test("GENOSYN_CONFIG and GENOSYN_CACHE_DIR override, relative to the working directory", () => {
    const io = ioFor("/work", { GENOSYN_CONFIG: "conf/cli.json" });
    assert.equal(configPath(io), path.resolve("/work", "conf/cli.json"));
    assert.equal(cacheDir(io), path.resolve("/work", "conf", "cache"));
    const both = ioFor("/work", { GENOSYN_CONFIG: "/etc/g.json", GENOSYN_CACHE_DIR: "/var/cache/g" });
    assert.equal(cacheDir(both), "/var/cache/g");
  });
});

describe("reading and writing the config", () => {
  test("a missing file is an empty config", (t) => {
    const dir = tempDir(t);
    const loaded = loadConfig(ioFor(dir));
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.config, emptyConfig());
  });

  test("writes mode 0600 into a new 0700 directory, atomically", { skip: !posix }, (t) => {
    const dir = tempDir(t);
    const io = ioFor(dir);
    const file = saveConfig(io, config({ acme: { url: "https://g.test", companyId: COMPANY, apiKey: "gen_x" } }, "acme"));
    assert.equal(file, path.join(dir, ".genosyn", "genosyn-api.json"));
    assert.equal(mode(file), 0o600);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["genosyn-api.json"], "no temp files left");
    const loaded = loadConfig(io);
    assert.equal(loaded.config.currentProfile, "acme");
    assert.equal(loaded.config.profiles.acme.apiKey, "gen_x");
  });

  test("keeps 0600 even under a permissive umask", { skip: !posix }, (t) => {
    const dir = tempDir(t);
    const previous = process.umask(0o000);
    try {
      const file = saveConfig(ioFor(dir), emptyConfig());
      assert.equal(mode(file), 0o600);
    } finally {
      process.umask(previous);
    }
  });

  test("tightens a config others can read before using it", { skip: !posix }, (t) => {
    const dir = tempDir(t);
    const io = ioFor(dir, { GENOSYN_CONFIG: path.join(dir, "loose.json") });
    fs.writeFileSync(path.join(dir, "loose.json"), JSON.stringify(emptyConfig()), { mode: 0o644 });
    fs.chmodSync(path.join(dir, "loose.json"), 0o644);
    const loaded = loadConfig(io);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(mode(path.join(dir, "loose.json")), 0o600);
  });

  test("an invalid file is a usage error naming it", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ not json");
    assert.throws(
      () => loadConfig(ioFor(dir, { GENOSYN_CONFIG: file })),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === EXIT_CODES.usage &&
        error.message.includes(file),
    );
  });

  test("drops broken profiles and unknown fields instead of failing", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "c.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        currentProfile: "good",
        extra: true,
        profiles: {
          good: { url: "https://g.test", companyId: COMPANY, apiKey: "gen_x", surprise: 1 },
          noUrl: { companyId: COMPANY },
          wrong: "string",
          badKey: { url: "https://g.test", companyId: COMPANY, apiKey: 42 },
        },
      }),
    );
    const loaded = loadConfig(ioFor(dir, { GENOSYN_CONFIG: file }));
    assert.deepEqual(Object.keys(loaded.config.profiles).sort(), ["badKey", "good"]);
    assert.equal(loaded.config.profiles.badKey.apiKey, undefined);
    assert.equal((loaded.config.profiles.good as Record<string, unknown>).surprise, undefined);
  });

  test("an empty file is an empty config", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "c.json");
    fs.writeFileSync(file, "  \n");
    assert.deepEqual(loadConfig(ioFor(dir, { GENOSYN_CONFIG: file })).config, emptyConfig());
  });
});

describe("parseBaseUrl", () => {
  test("splits the Base URL from Settings → API keys into address and company", () => {
    assert.deepEqual(parseBaseUrl(`https://genosyn.example.com/api/companies/${COMPANY}`), {
      baseUrl: "https://genosyn.example.com",
      companyId: COMPANY,
    });
  });

  test("keeps a path prefix and port, drops /api and below", () => {
    assert.deepEqual(parseBaseUrl(`http://host:8471/genosyn/api/companies/${COMPANY.toUpperCase()}/me?x=1`), {
      baseUrl: "http://host:8471/genosyn",
      companyId: COMPANY,
    });
    assert.deepEqual(parseBaseUrl("https://g.example.com/api/docs"), {
      baseUrl: "https://g.example.com",
      companyId: undefined,
    });
    assert.deepEqual(parseBaseUrl("  https://g.example.com///  "), {
      baseUrl: "https://g.example.com",
      companyId: undefined,
    });
  });

  test("ignores a company segment that is not a UUID", () => {
    assert.equal(parseBaseUrl("https://g.test/api/companies/acme").companyId, undefined);
  });

  test("refuses what is not an http(s) URL, or carries credentials", () => {
    for (const input of ["genosyn.example.com", "ftp://g.test", "https://user:pw@g.test"]) {
      assert.throws(
        () => parseBaseUrl(input),
        (error: unknown) => error instanceof CliError && error.kind === "usage",
        input,
      );
    }
  });
});

describe("small helpers", () => {
  test("sameInstall compares scheme, host, port and prefix, ignoring case", () => {
    assert.ok(sameInstall("https://G.test", "https://g.test/"));
    assert.ok(sameInstall("https://g.test/api/companies/x", "https://g.test"));
    assert.ok(!sameInstall("https://g.test", "http://g.test"));
    assert.ok(!sameInstall("https://g.test", "https://g.test:8443"));
    assert.ok(!sameInstall("https://g.test/a", "https://g.test/b"));
    assert.ok(!sameInstall("nonsense", "https://g.test"));
  });

  test("maskKey shows only gen_ and the first characters", () => {
    const key = "gen_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    assert.equal(maskKey(key), "gen_AbCdEfGh…");
    assert.equal(maskKey(undefined), undefined);
    assert.ok(!maskKey("gen_short")?.includes("short"));
  });

  test("isInsecureRemote flags plain http to another machine only", () => {
    assert.ok(isInsecureRemote("http://genosyn.example.com"));
    assert.ok(isInsecureRemote("http://192.168.1.20:8471"));
    assert.ok(!isInsecureRemote("https://genosyn.example.com"));
    assert.ok(!isInsecureRemote("http://localhost:8471"));
    assert.ok(!isInsecureRemote("http://127.0.0.1:8471"));
    assert.ok(!isInsecureRemote("http://[::1]:8471"));
    assert.ok(!isInsecureRemote("http://app.localhost"));
  });
});

describe("choosing a profile", () => {
  const profiles = {
    acme: { url: "https://acme.test", companyId: COMPANY, apiKey: "gen_acme" },
    beta: { url: "https://beta.test", companyId: OTHER_COMPANY, apiKey: "gen_beta" },
  };

  test("--profile beats GENOSYN_PROFILE beats the current one", () => {
    const file = config(profiles, "acme");
    assert.equal(selectProfile(file, { profile: "beta" }, { GENOSYN_PROFILE: "acme" }).name, "beta");
    assert.equal(selectProfile(file, {}, { GENOSYN_PROFILE: "beta" }).name, "beta");
    assert.equal(selectProfile(file, {}, {}).name, "acme");
  });

  test("the only profile is used when none is current", () => {
    assert.equal(selectProfile(config({ acme: profiles.acme }), {}, {}).name, "acme");
    assert.equal(selectProfile(config(profiles), {}, {}).name, undefined);
  });

  test("a named profile that doesn't exist is a usage error listing the others", () => {
    assert.throws(
      () => selectProfile(config(profiles), { profile: "gamma" }, {}),
      (error: unknown) => error instanceof CliError && error.kind === "usage" && /acme, beta/.test(error.hint ?? ""),
    );
  });
});

describe("resolveConnection", () => {
  const acme = { url: "https://acme.test", companyId: COMPANY, apiKey: "gen_acme" };

  test("uses the profile when nothing overrides it", () => {
    const connection = resolveConnection(config({ acme }, "acme"), {}, {});
    assert.equal(connection.baseUrl, "https://acme.test");
    assert.equal(connection.companyId, COMPANY);
    assert.equal(connection.apiKey, "gen_acme");
    assert.deepEqual(connection.sources, { profile: "profile", url: "profile", company: "profile", apiKey: "profile" });
  });

  test("environment variables beat the profile", () => {
    const connection = resolveConnection(config({ acme }, "acme"), {}, {
      GENOSYN_API_KEY: "gen_env",
      GENOSYN_COMPANY: OTHER_COMPANY,
    });
    assert.equal(connection.apiKey, "gen_env");
    assert.equal(connection.companyId, OTHER_COMPANY);
    assert.equal(connection.sources.apiKey, "env");
    assert.equal(connection.sources.company, "env");
  });

  test("flags beat the environment", () => {
    const connection = resolveConnection(
      config({ acme }, "acme"),
      { url: `https://flag.test/api/companies/${OTHER_COMPANY}`, company: undefined },
      { GENOSYN_URL: `https://env.test/api/companies/${COMPANY}`, GENOSYN_API_KEY: "gen_env" },
    );
    assert.equal(connection.baseUrl, "https://flag.test");
    assert.equal(connection.companyId, OTHER_COMPANY);
    assert.equal(connection.sources.url, "flag");
  });

  test("--company beats the company inside --url and GENOSYN_URL", () => {
    const connection = resolveConnection(
      emptyConfig(),
      { url: `https://g.test/api/companies/${COMPANY}`, company: OTHER_COMPANY },
      { GENOSYN_URL: `https://g.test/api/companies/${COMPANY}` },
    );
    assert.equal(connection.companyId, OTHER_COMPANY);
  });

  test("works from the environment alone, with no config at all", () => {
    const connection = resolveConnection(emptyConfig(), {}, {
      GENOSYN_URL: `https://g.test/api/companies/${COMPANY}`,
      GENOSYN_API_KEY: " gen_env ",
    });
    assert.equal(connection.baseUrl, "https://g.test");
    assert.equal(connection.companyId, COMPANY);
    assert.equal(connection.apiKey, "gen_env");
    assert.equal(connection.profileName, undefined);
  });

  test("never sends a saved key to an address the profile isn't for", () => {
    const connection = resolveConnection(config({ acme }, "acme"), {}, {
      GENOSYN_URL: "https://elsewhere.test",
    });
    assert.equal(connection.baseUrl, "https://elsewhere.test");
    assert.equal(connection.apiKey, undefined);
    assert.equal(connection.companyId, undefined, "the profile's company is for another install too");
    assert.equal(connection.withheldKeyFor, "https://elsewhere.test");
    assert.throws(
      () => requireApiKey(connection),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === EXIT_CODES.auth &&
        /saved key belongs to https:\/\/acme\.test/.test(error.message),
    );
  });

  test("a different spelling of the same install still gets its key", () => {
    const connection = resolveConnection(config({ acme }, "acme"), { url: "https://ACME.test/" }, {});
    assert.equal(connection.apiKey, "gen_acme");
  });

  test("a company that is not a UUID is a usage error", () => {
    assert.throws(
      () => resolveConnection(emptyConfig(), { company: "acme" }, { GENOSYN_URL: "https://g.test" }),
      (error: unknown) => error instanceof CliError && error.kind === "usage",
    );
  });

  test("the require helpers fail with exit code 3 and say how to log in", () => {
    const empty = resolveConnection(emptyConfig(), {}, {});
    for (const check of [requireBaseUrl, requireCompany, requireApiKey]) {
      assert.throws(
        () => check(empty),
        (error: unknown) =>
          error instanceof CliError && error.exitCode === EXIT_CODES.auth && /login|GENOSYN_/.test(error.hint ?? ""),
      );
    }
  });
});
