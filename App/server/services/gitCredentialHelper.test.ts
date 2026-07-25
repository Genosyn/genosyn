import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { configureEnvCredentialHelper, inlineEnvCredentialHelper } from "./gitCredentialHelper.js";

const exec = promisify(execFile);

test("rejects environment variable names that could inject shell code", () => {
  assert.throws(
    () => inlineEnvCredentialHelper("git", "GENOSYN_TOKEN; echo unsafe"),
    /Invalid credential environment variable/,
  );
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

  // Bubblewrap exposes the same checkout at a different absolute path.
  const remounted = path.join(root, "workspace");
  fs.renameSync(path.dirname(original), remounted);
  const repo = path.join(remounted, "repo");
  const isolatedHome = path.join(root, "home");
  fs.mkdirSync(isolatedHome);

  const result = spawnSync("git", ["credential", "fill"], {
    cwd: repo,
    encoding: "utf8",
    input: "protocol=https\nhost=github.com\n\n",
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
});
