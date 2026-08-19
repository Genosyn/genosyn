import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptLegacyCheckout,
  findGithubRepoCredential,
  testRepositoryConnection,
} from "./repositories.js";
import type { Repository } from "../db/entities/Repository.js";
import type { GithubRepoCredential } from "./repoSync.js";
import { config } from "../../config.js";

const credential: GithubRepoCredential = {
  connectionId: "connection-1",
  owner: "Acme",
  name: "Web",
  envKey: "GENOSYN_GH_TOKEN_CONNECTION_1",
  token: "turn-only-token",
};

test("matches an allowlisted GitHub credential to an HTTPS Repository", () => {
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/web.git", [credential]),
    credential,
  );
  assert.equal(findGithubRepoCredential("https://GITHUB.com/ACME/WEB", [credential]), credential);
});

test("does not reuse GitHub credentials for another host or an SSH remote", () => {
  assert.equal(findGithubRepoCredential("https://gitlab.com/acme/web.git", [credential]), null);
  assert.equal(findGithubRepoCredential("git@github.com:acme/web.git", [credential]), null);
});

test("uses the sole granted GitHub Connection as the Repository credential", () => {
  const soleConnection = { ...credential, owner: null, name: null };
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/other.git", [soleConnection]),
    soleConnection,
  );
});

test("requires an allowlist match to disambiguate multiple GitHub Connections", () => {
  const otherConnection: GithubRepoCredential = {
    ...credential,
    connectionId: "connection-2",
    owner: null,
    name: null,
    envKey: "GENOSYN_GH_TOKEN_CONNECTION_2",
  };
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/other.git", [credential, otherConnection]),
    null,
  );
  assert.equal(
    findGithubRepoCredential("https://github.com/acme/web.git", [otherConnection, credential]),
    credential,
  );
});

/**
 * The panel a Member reads when a repository will not sync. It runs one
 * `ls-remote` in a directory the server just created, so it is not the
 * command-execution surface the coding-runtime gate guards — and an install
 * whose sandbox could not start still clones, fetches and pushes the
 * server-owned checkout. Leaving the diagnostic gated meant the heavier
 * credentialed operation ran while the question "is this URL and token right?"
 * answered with a paragraph about bubblewrap.
 */
test("connection testing survives an install with no usable sandbox", async () => {
  const codingTools = config.agent.codingTools as { executionMode: string };
  const original = codingTools.executionMode;
  codingTools.executionMode = "disabled";
  try {
    const result = await testRepositoryConnection({
      authMode: "none",
      // RFC 6761 reserves .invalid, so this fails in DNS rather than reaching
      // anything — the point is which error comes back.
      gitUrl: "https://genosyn.invalid/acme/repo.git",
    } as Repository);

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /Command execution is disabled/);
  } finally {
    codingTools.executionMode = original;
  }
});

test("connection testing rejects a credential-bearing legacy URL before network access", async () => {
  const result = await testRepositoryConnection({
    authMode: "none",
    gitUrl: "https://legacy-user:legacy-secret@example.invalid/acme/repo.git",
  } as Repository);

  assert.equal(result.ok, false);
  assert.match(result.message, /plain http\(s\)/);
  assert.doesNotMatch(result.message, /legacy-user|legacy-secret/);
});

/**
 * Employee checkouts moved from `code-repos/<slug>` to `repositories/<slug>`
 * with the Code → Repository rename. An install that upgraded mid-flight must
 * keep whatever the employee had not committed; re-cloning beside the old
 * directory would silently throw that away.
 */
describe("adopting a pre-rename checkout", () => {
  function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-legacy-checkout-"));
  }

  test("moves an old checkout to the new path", () => {
    const cwd = workspace();
    const legacy = path.join(cwd, "code-repos", "web");
    fs.mkdirSync(path.join(legacy, ".git"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "uncommitted.txt"), "work in progress");

    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.existsSync(path.join(target, ".git")), true);
    assert.equal(fs.readFileSync(path.join(target, "uncommitted.txt"), "utf8"), "work in progress");
    assert.equal(fs.existsSync(legacy), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("leaves an existing new checkout alone", () => {
    const cwd = workspace();
    const legacy = path.join(cwd, "code-repos", "web");
    fs.mkdirSync(path.join(legacy, ".git"), { recursive: true });
    const target = path.join(cwd, "repositories", "web");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, "current.txt"), "keep me");

    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.readFileSync(path.join(target, "current.txt"), "utf8"), "keep me");
    assert.equal(fs.existsSync(legacy), true, "the old directory is left for the operator");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores a legacy path that is not a checkout", () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "code-repos", "web"), { recursive: true });
    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("refuses to follow a symlinked legacy checkout", () => {
    const cwd = workspace();
    const outside = path.join(cwd, "elsewhere");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "code-repos"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, "code-repos", "web"));

    const target = path.join(cwd, "repositories", "web");
    adoptLegacyCheckout(cwd, "web", target);

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(outside, ".git")), true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("does nothing when there is no legacy checkout at all", () => {
    const cwd = workspace();
    const target = path.join(cwd, "repositories", "web");
    assert.doesNotThrow(() => adoptLegacyCheckout(cwd, "web", target));
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
