import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistCodeRepoKnownHosts,
  persistCodeRepoSshKey,
  readCodeRepoKnownHosts,
} from "./codeRepoSshFiles.js";

test("SSH key persistence replaces a final symlink without truncating its target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-ssh-final-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const sshDirectory = path.join(workspace, "code-repos", ".ssh");
  const outside = path.join(root, "outside-key");
  fs.mkdirSync(sshDirectory, { recursive: true });
  fs.writeFileSync(outside, "outside-must-not-change\n");
  fs.symlinkSync(outside, path.join(sshDirectory, "repo-id"));

  const keyPath = persistCodeRepoSshKey(workspace, "repo-id", "private-key");

  assert.equal(fs.readFileSync(outside, "utf8"), "outside-must-not-change\n");
  assert.equal(fs.lstatSync(keyPath).isFile(), true);
  assert.equal(fs.readFileSync(keyPath, "utf8"), "private-key\n");
});

test("a symlinked SSH directory cannot redirect reads or writes outside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-ssh-parent-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const codeRepos = path.join(workspace, "code-repos");
  const outside = path.join(root, "outside");
  fs.mkdirSync(codeRepos, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "repo-id"), "outside-key\n");
  fs.writeFileSync(path.join(outside, "known_hosts"), "outside-known-host\n");
  fs.symlinkSync(outside, path.join(codeRepos, ".ssh"));
  const outsideEntries = fs.readdirSync(outside).sort();

  assert.throws(() => readCodeRepoKnownHosts(workspace));
  assert.throws(() => persistCodeRepoSshKey(workspace, "repo-id", "replacement-key"));
  assert.throws(() => persistCodeRepoKnownHosts(workspace, "replacement-known-host\n"));

  assert.equal(fs.readFileSync(path.join(outside, "repo-id"), "utf8"), "outside-key\n");
  assert.equal(fs.readFileSync(path.join(outside, "known_hosts"), "utf8"), "outside-known-host\n");
  assert.deepEqual(fs.readdirSync(outside).sort(), outsideEntries);
});
