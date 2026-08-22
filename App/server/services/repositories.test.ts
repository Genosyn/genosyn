import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  adoptLegacyCheckout,
  encryptRepoSecret,
  fastForwardEmployeeDefaultBranch,
  findGithubRepoCredential,
  testRepositoryConnection,
} from "./repositories.js";
import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
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

describe("testing a Repository connection", () => {
  const githubConnection = { id: "github-connection" } as IntegrationConnection;
  const remote = {
    companyId: "company-1",
    authMode: "none",
    gitUrl: "https://github.com/acme/private.git",
  } as Repository;

  test("reuses the pinned-or-sole GitHub Connection for a credential-free remote", async () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedHelper: string | undefined;

    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({
        kind: "one",
        connection: githubConnection,
      }),
      resolveConnectionToken: async (connection) => {
        assert.equal(connection, githubConnection);
        return { token: "connection-token", login: "acme" };
      },
      runGit: async (_workspaceRoot, _cwd, args, extraEnv, credentialHelper) => {
        assert.deepEqual(args, ["ls-remote", "--symref", remote.gitUrl, "HEAD"]);
        capturedEnv = extraEnv;
        capturedHelper = credentialHelper;
        return { stdout: "ref: refs/heads/trunk\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.deepEqual(result, {
      ok: true,
      message: "Repository is reachable.",
      defaultBranch: "trunk",
    });
    assert.equal(capturedEnv?.GENOSYN_REPO_TOKEN_CONNECTION_TEST, "connection-token");
    assert.match(capturedHelper ?? "", /GENOSYN_REPO_TOKEN_CONNECTION_TEST/);
    assert.doesNotMatch(capturedHelper ?? "", /connection-token/);
  });

  test("keeps testing anonymously when no GitHub Connection exists", async () => {
    let resolvedToken = false;
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      resolveConnectionToken: async () => {
        resolvedToken = true;
        return { token: "unused", login: "unused" };
      },
      runGit: async (_workspaceRoot, _cwd, _args, extraEnv, credentialHelper) => {
        assert.deepEqual(extraEnv, {});
        assert.equal(credentialHelper, undefined);
        return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.defaultBranch, "main");
    assert.equal(resolvedToken, false);
  });

  test("explains an ambiguous private GitHub remote without exposing askpass plumbing", async () => {
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({
        kind: "ambiguous",
        connections: [githubConnection, { id: "other" } as IntegrationConnection],
      }),
      runGit: async () => {
        throw new Error(
          "git ls-remote failed: error: unable to read askpass response from '/bin/false' | " +
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        );
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /more than one GitHub Connection/i);
    assert.doesNotMatch(result.message, /askpass|\/bin\/false|terminal prompts/i);
  });

  test("explains missing authentication without exposing askpass plumbing", async () => {
    const result = await testRepositoryConnection(remote, {
      resolveConnectionForRemote: async () => ({ kind: "none" }),
      runGit: async () => {
        throw new Error("git ls-remote failed: fatal: unable to get password from user");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /requires sign-in/i);
    assert.match(result.message, /Settings → Integrations/);
    assert.doesNotMatch(result.message, /askpass|\/bin\/false|unable to get password/i);
  });

  test("keeps a stored HTTPS token ahead of any GitHub Connection", async () => {
    const token = "stored-repository-token";
    let resolvedConnection = false;
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "https",
        httpsUsername: "repository-user",
        encryptedToken: encryptRepoSecret(token, remote.companyId),
      } as Repository,
      {
        resolveConnectionForRemote: async () => {
          resolvedConnection = true;
          return { kind: "one", connection: githubConnection };
        },
        runGit: async (_workspaceRoot, _cwd, _args, extraEnv, credentialHelper) => {
          assert.equal(extraEnv?.GENOSYN_REPO_TOKEN_CONNECTION_TEST, token);
          assert.match(credentialHelper ?? "", /repository-user/);
          return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(resolvedConnection, false);
  });

  test("keeps the stored SSH key path for SSH repositories", async () => {
    const privateKey = "-----BEGIN TEST KEY-----\nprivate material\n-----END TEST KEY-----";
    let resolvedConnection = false;
    const result = await testRepositoryConnection(
      {
        ...remote,
        authMode: "ssh",
        gitUrl: "git@github.com:acme/private.git",
        encryptedSshKey: encryptRepoSecret(privateKey, remote.companyId),
      } as Repository,
      {
        resolveConnectionForRemote: async () => {
          resolvedConnection = true;
          return { kind: "one", connection: githubConnection };
        },
        runGit: async (_workspaceRoot, cwd, _args, extraEnv, credentialHelper) => {
          assert.equal(fs.readFileSync(path.join(cwd, "key"), "utf8"), `${privateKey}\n`);
          assert.match(extraEnv?.GIT_SSH_COMMAND ?? "", /ssh -i/);
          assert.equal(credentialHelper, undefined);
          return { stdout: "ref: refs/heads/main\tHEAD\n012345\tHEAD\n" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(resolvedConnection, false);
  });
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

// ─────────── the trunk an employee checkout works from ──────────────────

/**
 * The employee's own checkout is model-writable and holds whatever an employee
 * left uncommitted between turns, so the sync that refreshes it is fetch-only.
 * That kept the tree safe and also kept it *still*: refs moved, the working
 * tree never did, and an employee asked to change a file could be reading code
 * from whenever it first cloned.
 *
 * {@link fastForwardEmployeeDefaultBranch} closes that gap under conditions
 * where closing it cannot cost anything. Most of these tests assert it does
 * nothing — that is the valuable half.
 */
describe("bringing an employee checkout's trunk up to date", () => {
  const codingTools = config.agent.codingTools as {
    enabled: boolean;
    executionMode: "host" | "bubblewrap" | "disabled";
    allowUnsafeHostExecution: boolean;
  };
  const originalCodingTools = { ...codingTools };

  // The materializer runs Git over a model-writable tree, which is gated on a
  // coding runtime. Make the host access these fixtures need explicit.
  before(() => {
    codingTools.enabled = true;
    codingTools.executionMode = "host";
    codingTools.allowUnsafeHostExecution = true;
  });

  after(() => {
    Object.assign(codingTools, originalCodingTools);
  });

  const exec = promisify(execFile);
  const roots: string[] = [];

  after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (args: string[], cwd: string) =>
    exec("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });

  function repositoryRow(overrides: Partial<Repository> = {}): Repository {
    return { defaultBranch: "main", ...overrides } as Repository;
  }

  /**
   * A workspace holding an employee checkout whose `origin` is one commit
   * ahead — exactly the state a fetch-only sync leaves behind.
   */
  async function behindCheckout(): Promise<{
    workspaceRoot: string;
    repoPath: string;
    upstream: string;
    head: () => Promise<string>;
  }> {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-employee-sync-"));
    roots.push(workspaceRoot);
    const origin = path.join(workspaceRoot, "origin.git");
    const seed = path.join(workspaceRoot, "seed");
    const repoPath = path.join(workspaceRoot, "repositories", "web");

    fs.mkdirSync(seed, { recursive: true });
    await git(["init", "--quiet", "--bare", "--initial-branch=main", origin], workspaceRoot);
    await git(["init", "--quiet", "--initial-branch=main"], seed);
    await git(["remote", "add", "origin", origin], seed);
    fs.writeFileSync(path.join(seed, "app.ts"), "export const version = 1;\n");
    await git(["add", "-A"], seed);
    await git(["commit", "--quiet", "-m", "First"], seed);
    await git(["push", "--quiet", "origin", "main"], seed);

    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    await git(["clone", "--quiet", origin, repoPath], workspaceRoot);

    // A colleague ships something after the employee's clone.
    fs.writeFileSync(path.join(seed, "app.ts"), "export const version = 2;\n");
    await git(["add", "-A"], seed);
    await git(["commit", "--quiet", "-m", "Second"], seed);
    await git(["push", "--quiet", "origin", "main"], seed);
    const { stdout } = await git(["rev-parse", "HEAD"], seed);

    // The fetch the materializer already did before this function is reached.
    await git(["fetch", "--quiet", "origin"], repoPath);

    return {
      workspaceRoot,
      repoPath,
      upstream: stdout.trim(),
      head: async () => (await git(["rev-parse", "HEAD"], repoPath)).stdout.trim(),
    };
  }

  test("advances a clean checkout sitting on the default branch", async () => {
    const fixture = await behindCheckout();
    assert.notEqual(await fixture.head(), fixture.upstream, "the fixture must start behind");

    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());

    assert.equal(await fixture.head(), fixture.upstream);
    assert.equal(
      fs.readFileSync(path.join(fixture.repoPath, "app.ts"), "utf8"),
      "export const version = 2;\n",
      "the working tree, not just the ref",
    );
  });

  test("leaves an uncommitted change alone, however stale that makes the tree", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    fs.writeFileSync(path.join(fixture.repoPath, "app.ts"), "export const version = 99;\n");

    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());

    assert.equal(await fixture.head(), stale);
    assert.equal(
      fs.readFileSync(path.join(fixture.repoPath, "app.ts"), "utf8"),
      "export const version = 99;\n",
      "an employee's work in progress is not this function's to discard",
    );
  });

  test("leaves an untracked file's tree alone too", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    fs.writeFileSync(path.join(fixture.repoPath, "scratch.md"), "half an idea\n");

    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());

    assert.equal(await fixture.head(), stale, "an untracked file is still work in progress");
    assert.equal(fs.existsSync(path.join(fixture.repoPath, "scratch.md")), true);
  });

  test("leaves a checkout the employee moved to another branch alone", async () => {
    const fixture = await behindCheckout();
    await git(["switch", "--quiet", "--create", "feature/thing"], fixture.repoPath);
    const stale = await fixture.head();

    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());

    assert.equal(await fixture.head(), stale);
    const { stdout } = await git(["symbolic-ref", "--short", "HEAD"], fixture.repoPath);
    assert.equal(stdout.trim(), "feature/thing", "switching branches under an employee is worse");
  });

  test("leaves a diverged trunk alone rather than resolving it", async () => {
    const fixture = await behindCheckout();
    fs.writeFileSync(path.join(fixture.repoPath, "local.ts"), "export const mine = 1;\n");
    await git(["add", "-A"], fixture.repoPath);
    await git(["commit", "--quiet", "-m", "Employee commit"], fixture.repoPath);
    const local = await fixture.head();

    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());

    assert.equal(await fixture.head(), local, "--ff-only refuses, and that refusal is the point");
  });

  test("does nothing when the remote has no such branch", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow({ defaultBranch: "release-2019" }),
    );
    assert.equal(await fixture.head(), stale);
  });

  test("does nothing when the repository row has no default branch", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await fastForwardEmployeeDefaultBranch(
      fixture.workspaceRoot,
      fixture.repoPath,
      repositoryRow({ defaultBranch: "" }),
    );
    assert.equal(await fixture.head(), stale);
  });

  test("never lets a stored branch name reach Git as an option", async () => {
    const fixture = await behindCheckout();
    const stale = await fixture.head();
    await assert.doesNotReject(() =>
      fastForwardEmployeeDefaultBranch(
        fixture.workspaceRoot,
        fixture.repoPath,
        repositoryRow({ defaultBranch: "--upload-pack=touch /tmp/genosyn-pwned" }),
      ),
    );
    assert.equal(await fixture.head(), stale);
    assert.equal(fs.existsSync("/tmp/genosyn-pwned"), false);
  });

  test("is a no-op on a checkout that is already current", async () => {
    const fixture = await behindCheckout();
    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());
    const current = await fixture.head();
    await fastForwardEmployeeDefaultBranch(fixture.workspaceRoot, fixture.repoPath, repositoryRow());
    assert.equal(await fixture.head(), current);
  });
});
