import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import {
  persistRepositoryKnownHosts,
  purgeLegacyRepositorySshFiles,
  readRepositoryKnownHosts,
} from "./repositorySshFiles.js";
import { employeeRepositoryKnownHostsFile } from "./paths.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-code-repo-state-"));
  mutableConfig.dataDir = path.join(root, "data");
});

beforeEach(() => {
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
});

after(() => {
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("private Repository SSH state", () => {
  test("stores only known_hosts outside the model-visible workspace with private modes", () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    persistRepositoryKnownHosts("company", "employee", "github.com ssh-ed25519 AAAA\n");

    const file = employeeRepositoryKnownHostsFile("company", "employee");
    assert.equal(readRepositoryKnownHosts("company", "employee"), "github.com ssh-ed25519 AAAA\n");
    assert.equal(file.startsWith(workspace), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["employee.known_hosts"]);
  });

  test("rejects symlinked or hard-linked private known-host files", () => {
    const file = employeeRepositoryKnownHostsFile("company", "employee");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outside = path.join(root, "outside-known-hosts");
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, file);
    assert.throws(() => persistRepositoryKnownHosts("company", "employee", "replacement\n"));
    assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");

    fs.unlinkSync(file);
    fs.writeFileSync(file, "original\n");
    fs.linkSync(file, path.join(root, "known-hosts-alias"));
    assert.throws(() => readRepositoryKnownHosts("company", "employee"), /private regular file/);
  });
});

describe("legacy workspace SSH cleanup", () => {
  test("removes legacy keys and symlinks without following them", () => {
    const workspace = path.join(root, "workspace-cleanup");
    const legacy = path.join(workspace, "repositories", ".ssh");
    const outside = path.join(root, "outside-key");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "repo-id"), "PRIVATE_KEY\n", { mode: 0o600 });
    fs.writeFileSync(path.join(legacy, "known_hosts"), "host key\n", { mode: 0o600 });
    fs.writeFileSync(outside, "outside-must-not-change\n");
    fs.symlinkSync(outside, path.join(legacy, "outside-link"));

    purgeLegacyRepositorySshFiles(workspace);

    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside-must-not-change\n");
  });

  test("fails closed when a legacy private key has another hardlink", () => {
    const workspace = path.join(root, "workspace-hardlink");
    const legacy = path.join(workspace, "repositories", ".ssh");
    fs.mkdirSync(legacy, { recursive: true });
    const key = path.join(legacy, "repo-id");
    fs.writeFileSync(key, "PRIVATE_KEY\n", { mode: 0o600 });
    fs.linkSync(key, path.join(workspace, "key-alias.txt"));

    assert.throws(() => purgeLegacyRepositorySshFiles(workspace), /unsafe hard link/);
    assert.equal(fs.readFileSync(path.join(workspace, "key-alias.txt"), "utf8"), "PRIVATE_KEY\n");
  });

  test("never follows a symlinked code-repos parent", () => {
    const workspace = path.join(root, "workspace-parent-link");
    const outside = path.join(root, "outside-code-repos");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(outside, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".ssh", "repo-id"), "OUTSIDE_KEY\n");
    fs.symlinkSync(outside, path.join(workspace, "repositories"));

    assert.throws(() => purgeLegacyRepositorySshFiles(workspace), /not a private directory/);
    assert.equal(fs.readFileSync(path.join(outside, ".ssh", "repo-id"), "utf8"), "OUTSIDE_KEY\n");
  });
});
