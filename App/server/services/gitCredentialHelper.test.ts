import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertSafeCredentialToken,
  assertSafeGitRemoteUrl,
  configureEnvCredentialHelper,
  httpsCredentialScope,
  inlineEnvCredentialHelper,
} from "./gitCredentialHelper.js";

const exec = promisify(execFile);
const REMOTE_URL = "https://git.example:8443/acme/private-repo.git";

test("accepts only credential-free Git remote URL forms", () => {
  for (const url of [
    "http://git.example/acme/repo.git",
    "https://git.example:8443/acme/repo.git",
    "ssh://git@git.example/acme/repo.git",
    "ssh://git.example/acme/repo.git",
    "git@git.example:acme/repo.git",
    "deploy-user@[2001:db8::1]:/srv/repo.git",
  ]) {
    assert.doesNotThrow(() => assertSafeGitRemoteUrl(url), url);
  }

  for (const url of [
    "https://user@git.example/acme/repo.git",
    "https://user:plain-text-secret@git.example/acme/repo.git",
    "ssh://git:plain-text-secret@git.example/acme/repo.git",
    "ssh://@git.example/acme/repo.git",
    "ssh://git@@git.example/acme/repo.git",
    "https://git.example/acme/repo.git?token=plain-text-secret",
    "https://git.example/acme/repo.git?",
    "ssh://git@git.example/acme/repo.git#branch",
    "ssh://git@git.example/acme/repo.git#",
    "git@git.example:acme/repo.git?option=1",
    "file:///tmp/repo.git",
    "git://git.example/acme/repo.git",
    "https:git.example/acme/repo.git",
    "git@git.example",
    "git@@git.example:acme/repo.git",
    "git@..:acme/repo.git",
    "git@-git.example:acme/repo.git",
    "git@[::::]:acme/repo.git",
    "https://",
    "https://../acme/repo.git",
    "ssh://git@bad-.example/acme/repo.git",
    "https://git.example/acme/repo git",
    "https://git.example\\acme\\repo.git",
    "https://git.example/acme/repo.git\nignored",
    "https://git.example/acme/repo.git\0ignored",
  ]) {
    assert.throws(
      () => assertSafeGitRemoteUrl(url),
      (error: Error) => {
        assert.doesNotMatch(error.message, /plain-text-secret/);
        return true;
      },
      url,
    );
  }
});

test("rejects environment variable names that could inject shell code", () => {
  assert.throws(
    () => inlineEnvCredentialHelper("git", "GENOSYN_TOKEN; echo unsafe", REMOTE_URL),
    /Invalid credential environment variable/,
  );
  assert.throws(() => assertSafeCredentialToken("token\r\nInjected: value"), /line break/);
  assert.doesNotThrow(() => assertSafeCredentialToken("normal-token_value.123"));
});

test("validates and normalizes an exact HTTPS credential scope", () => {
  assert.deepEqual(httpsCredentialScope("https://GitHub.COM:8443/acme/repo.git"), {
    protocol: "https",
    host: "github.com:8443",
    path: "acme/repo.git",
  });
  assert.deepEqual(httpsCredentialScope("https://GitHub.COM:443/acme/repo.git/"), {
    protocol: "https",
    host: "github.com",
    path: "acme/repo.git",
  });
  assert.throws(
    () => inlineEnvCredentialHelper("bad\nusername", "GENOSYN_REPO_TOKEN_1", REMOTE_URL),
    /Invalid Git credential username/,
  );
  for (const url of [
    "http://github.com/acme/repo.git",
    "https://token@github.com/acme/repo.git",
    "https://github.com/",
    "https://github.com/acme/repo.git?redirect=1",
    "https://github.com/acme/repo%2Egit",
  ]) {
    assert.throws(() => httpsCredentialScope(url), /Git credential/);
  }
});

test("credential helper survives a workspace path remap and reads the turn token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-git-credential-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const original = path.join(root, "host-workspace", "repo");
  fs.mkdirSync(original, { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: original });

  const envKey = "GENOSYN_TEST_REPO_TOKEN";
  await configureEnvCredentialHelper(
    (args) => exec("git", args, { cwd: original }),
    "owner's-account",
    envKey,
    REMOTE_URL,
  );

  const { stdout: configured } = await exec(
    "git",
    ["config", "--local", "--get-all", "credential.helper"],
    { cwd: original },
  );
  const configuredHelpers = configured.trimEnd().split("\n");
  assert.equal(configuredHelpers[0], "");
  assert.match(configuredHelpers[1] ?? "", /GENOSYN_TEST_REPO_TOKEN/);
  assert.doesNotMatch(configured, /turn-only-secret/);
  const { stdout: useHttpPath } = await exec(
    "git",
    ["config", "--local", "--get", "credential.useHttpPath"],
    { cwd: original },
  );
  assert.equal(useHttpPath.trim(), "true");

  // Bubblewrap exposes the same checkout at a different absolute path.
  const remounted = path.join(root, "workspace");
  fs.renameSync(path.dirname(original), remounted);
  const repo = path.join(remounted, "repo");
  const isolatedHome = path.join(root, "home");
  fs.mkdirSync(isolatedHome);

  const result = spawnSync("git", ["credential", "fill"], {
    cwd: repo,
    encoding: "utf8",
    input: "protocol=https\nhost=git.example:8443\npath=acme/private-repo.git\n\n",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      [envKey]: "turn-only-secret",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /username=owner's-account/);
  assert.match(result.stdout, /password=turn-only-secret/);

  for (const input of [
    "protocol=https\nhost=evil.example\npath=acme/private-repo.git\n\n",
    "protocol=https\nhost=git.example:8443\npath=acme/another-repo.git\n\n",
    "protocol=http\nhost=git.example:8443\npath=acme/private-repo.git\n\n",
  ]) {
    const denied = spawnSync("git", ["credential", "fill"], {
      cwd: repo,
      encoding: "utf8",
      input,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        [envKey]: "turn-only-secret",
      },
    });
    assert.notEqual(denied.status, 0);
    assert.doesNotMatch(`${denied.stdout}\n${denied.stderr}`, /turn-only-secret/);
  }
});
