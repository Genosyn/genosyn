import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, normalizeServiceOrigin } from "../src/config.js";

const minimal = { CONNECT_PUBLIC_URL: "https://connect.example.com" };

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail("expected the configuration to be refused");
}

test("a public URL alone starts a service that offers nothing and seals with a key of its own", () => {
  const config = loadConfig(minimal);
  assert.equal(config.publicUrl, "https://connect.example.com");
  assert.equal(config.port, 8473);
  assert.equal(config.listenHost, "0.0.0.0");
  assert.equal(config.trustedProxyHops, 0);
  assert.equal(config.accessLog, true);
  assert.equal(config.google, null);
  assert.deepEqual(config.links, { privacy: null, terms: null });
  // One replica needs no configured key: each process generates its own.
  assert.equal(config.secretIsEphemeral, true);
  assert.ok(config.secret.length >= 32);
  assert.notEqual(loadConfig(minimal).secret, config.secret);
  assert.deepEqual(Object.keys(config).sort(), [
    "accessLog",
    "google",
    "links",
    "listenHost",
    "port",
    "publicUrl",
    "secret",
    "secretIsEphemeral",
    "trustedProxyHops",
  ]);
});

test("the public URL must be an HTTPS origin, or HTTP on loopback for development", () => {
  for (const [value, expected] of [
    ["https://connect.example.com/", "https://connect.example.com"],
    ["https://connect.example.com:8443", "https://connect.example.com:8443"],
    ["http://localhost:8473", "http://localhost:8473"],
    ["http://127.0.0.1:8473", "http://127.0.0.1:8473"],
    ["http://[::1]:8473", "http://[::1]:8473"],
    ["http://connect.example.com", null],
    ["https://connect.example.com/path", null],
    ["https://connect.example.com/?q=1", null],
    ["https://connect.example.com/#x", null],
    ["https://user:pass@connect.example.com", null],
    ["ftp://connect.example.com", null],
    ["connect.example.com", null],
  ] as const) {
    assert.equal(normalizeServiceOrigin(value), expected, value);
  }
  assert.match(problems({})[0], /CONNECT_PUBLIC_URL is required/);
  assert.match(problems({ CONNECT_PUBLIC_URL: "http://connect.example.com" })[0], /HTTPS origin/);
});

test("Google needs both client values and only known scope groups", () => {
  const google = loadConfig({
    ...minimal,
    CONNECT_GOOGLE_CLIENT_ID: " client.apps.googleusercontent.com ",
    CONNECT_GOOGLE_CLIENT_SECRET: "secret",
  }).google;
  assert.deepEqual(google, {
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "secret",
    scopeGroups: ["gmail"],
  });
  assert.deepEqual(
    loadConfig({
      ...minimal,
      CONNECT_GOOGLE_CLIENT_ID: "id",
      CONNECT_GOOGLE_CLIENT_SECRET: "secret",
      CONNECT_GOOGLE_SCOPE_GROUPS: " Gmail, calendar ,,calendar,search-console ",
    }).google?.scopeGroups,
    ["gmail", "calendar", "search-console"],
  );
  assert.match(
    problems({ ...minimal, CONNECT_GOOGLE_CLIENT_ID: "id" })[0],
    /both CONNECT_GOOGLE_CLIENT_ID and CONNECT_GOOGLE_CLIENT_SECRET/,
  );
  assert.match(
    problems({ ...minimal, CONNECT_GOOGLE_CLIENT_SECRET: "secret" })[0],
    /both CONNECT_GOOGLE_CLIENT_ID/,
  );
  const unknown = problems({
    ...minimal,
    CONNECT_GOOGLE_CLIENT_ID: "id",
    CONNECT_GOOGLE_CLIENT_SECRET: "secret",
    CONNECT_GOOGLE_SCOPE_GROUPS: "gmail,everything",
  })[0];
  assert.match(unknown, /unknown groups \(everything\)/);
  assert.match(unknown, /Known groups: gmail, calendar, drive/);
  assert.match(
    problems({
      ...minimal,
      CONNECT_GOOGLE_CLIENT_ID: "id",
      CONNECT_GOOGLE_CLIENT_SECRET: "secret",
      CONNECT_GOOGLE_SCOPE_GROUPS: " , ",
    })[0],
    /at least one group/,
  );
});

test("a configured secret must be of real length, and a database is refused: nothing is stored", () => {
  assert.match(problems({ ...minimal, CONNECT_SECRET: "too-short" })[0], /at least 32 characters/);
  const config = loadConfig({ ...minimal, CONNECT_SECRET: ` ${"x".repeat(32)} ` });
  assert.equal(config.secret, "x".repeat(32));
  assert.equal(config.secretIsEphemeral, false);
  for (const name of ["CONNECT_DATABASE_URL", "CONNECT_DATABASE_URL_FILE"]) {
    const refused = problems({ ...minimal, [name]: "postgres://connect@db/connect" });
    assert.equal(refused.length, 1, name);
    assert.match(
      refused[0],
      /CONNECT_DATABASE_URL is no longer used: Genosyn Connect keeps no state/,
    );
    assert.match(refused[0], /same CONNECT_SECRET/);
  }
});

test("secrets can come from mounted files, but not from a file and a value at once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-config-"));
  try {
    const secretFile = path.join(dir, "secret");
    const googleFile = path.join(dir, "google");
    fs.writeFileSync(secretFile, `${"f".repeat(40)}\n`);
    fs.writeFileSync(googleFile, "file-secret\n");
    const config = loadConfig({
      ...minimal,
      CONNECT_SECRET_FILE: secretFile,
      CONNECT_GOOGLE_CLIENT_ID: "id",
      CONNECT_GOOGLE_CLIENT_SECRET_FILE: googleFile,
    });
    assert.equal(config.secret, "f".repeat(40));
    assert.equal(config.secretIsEphemeral, false);
    assert.equal(config.google?.clientSecret, "file-secret");
    assert.match(
      problems({ ...minimal, CONNECT_SECRET: "x".repeat(32), CONNECT_SECRET_FILE: secretFile })[0],
      /CONNECT_SECRET or CONNECT_SECRET_FILE, not both/,
    );
    assert.match(
      problems({ ...minimal, CONNECT_SECRET_FILE: path.join(dir, "missing") })[0],
      /CONNECT_SECRET_FILE could not be read/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("numbers, switches and links are validated, and every problem is reported together", () => {
  const config = loadConfig({
    ...minimal,
    PORT: "9000",
    CONNECT_LISTEN_HOST: "127.0.0.1",
    CONNECT_TRUSTED_PROXY_HOPS: "2",
    CONNECT_ACCESS_LOG: "false",
    CONNECT_PRIVACY_URL: "https://genosyn.com/privacy",
    CONNECT_TERMS_URL: "https://genosyn.com/terms",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.trustedProxyHops, 2);
  assert.equal(config.accessLog, false);
  assert.deepEqual(config.links, {
    privacy: "https://genosyn.com/privacy",
    terms: "https://genosyn.com/terms",
  });

  const all = problems({
    PORT: "80.5",
    CONNECT_TRUSTED_PROXY_HOPS: "11",
    CONNECT_ACCESS_LOG: "maybe",
    CONNECT_PRIVACY_URL: "http://genosyn.com/privacy",
    CONNECT_TERMS_URL: "javascript:alert(1)",
  });
  assert.equal(all.length, 6);
  assert.match(all.join("\n"), /PORT must be a whole number from 1 to 65535/);
  assert.match(all.join("\n"), /CONNECT_TRUSTED_PROXY_HOPS must be a whole number from 0 to 10/);
  assert.match(all.join("\n"), /CONNECT_ACCESS_LOG must be true or false/);
  assert.match(all.join("\n"), /CONNECT_PRIVACY_URL must be an https:\/\/ URL/);
  assert.match(all.join("\n"), /CONNECT_TERMS_URL must be an https:\/\/ URL/);
  const error = (() => {
    try {
      loadConfig({});
    } catch (caught) {
      return caught as Error;
    }
  })();
  assert.match(error!.message, /^Genosyn Connect is not configured correctly:\n- /);
});
