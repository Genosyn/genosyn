import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWorkspaceGitMetadataContained,
  buildWorkspaceGitInvocation,
} from "./workspaceGit.js";

test("bubblewrapped Git receives private namespaces and an explicit environment", () => {
  const invocation = buildWorkspaceGitInvocation(
    {
      workspaceRoot: "/srv/employee",
      cwd: "/srv/employee/repositories/app",
      args: ["fetch", "https://github.com/example/app.git"],
      extraEnv: { GENOSYN_REPO_TOKEN_123: "repo-token" },
      credentialHelper: "!trusted-helper",
    },
    "bubblewrap",
    "/usr/bin/bwrap",
  );

  assert.equal(invocation.executable, "/usr/bin/bwrap");
  assert.equal(invocation.isolated, true);
  assert.deepEqual(invocation.env, { PATH: "/usr/local/bin:/usr/bin:/bin" });
  assert.ok(invocation.args.includes("--unshare-pid"));
  assert.ok(invocation.args.includes("--clearenv"));
  assert.ok(invocation.args.includes("/tmp"));
  assert.ok(invocation.args.includes("/workspace"));
  assert.ok(invocation.args.includes("/etc/passwd"));
  assert.ok(invocation.args.includes("/etc/group"));
  assert.ok(invocation.args.includes("GENOSYN_REPO_TOKEN_123"));
  assert.ok(invocation.args.includes("protocol.ext.allow"));
  assert.ok(invocation.args.includes("credential.helper"));
  assert.deepEqual(invocation.args.slice(-3), [
    "git",
    "fetch",
    "https://github.com/example/app.git",
  ]);
});

test("workspace Git never inherits arbitrary App or Codex environment variables", () => {
  const invocation = buildWorkspaceGitInvocation(
    {
      workspaceRoot: "/srv/employee",
      cwd: "/srv/employee",
      args: ["status"],
    },
    "host",
    "/usr/bin/bwrap",
    true,
  );

  assert.equal(invocation.isolated, false);
  assert.equal("CODEX_ACCESS_TOKEN" in invocation.env, false);
  assert.equal("DATABASE_URL" in invocation.env, false);
  assert.equal(invocation.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(invocation.env.GIT_SSH_COMMAND, "/bin/false");
});

test("command-scoped credential helpers receive the HTTPS repository path", () => {
  const invocation = buildWorkspaceGitInvocation(
    {
      workspaceRoot: "/srv/employee",
      cwd: "/srv/employee",
      args: ["fetch", "https://github.com/acme/repo.git"],
      credentialHelper: "!trusted-helper",
    },
    "host",
    "/usr/bin/bwrap",
    true,
  );
  const count = Number(invocation.env.GIT_CONFIG_COUNT);
  const config = new Map(
    Array.from({ length: count }, (_value, index) => [
      invocation.env[`GIT_CONFIG_KEY_${index}`],
      invocation.env[`GIT_CONFIG_VALUE_${index}`],
    ]),
  );
  assert.equal(config.get("credential.useHttpPath"), "true");
});

test("workspace Git rejects unsafe environment entries and disabled execution", () => {
  assert.throws(
    () =>
      buildWorkspaceGitInvocation(
        {
          workspaceRoot: "/srv/employee",
          cwd: "/srv/employee",
          args: ["status"],
          extraEnv: { CODEX_ACCESS_TOKEN: "must-not-pass" },
        },
        "bubblewrap",
      ),
    /not allowed/,
  );
  assert.throws(
    () =>
      buildWorkspaceGitInvocation(
        {
          workspaceRoot: "/srv/employee",
          cwd: "/srv/employee",
          args: ["status"],
          extraEnv: { GENOSYN_REPO_TOKEN_1: "token\nInjected: value" },
        },
        "host",
        "/usr/bin/bwrap",
        true,
      ),
    /Invalid Git token environment value/,
  );
  assert.throws(
    () =>
      buildWorkspaceGitInvocation(
        {
          workspaceRoot: "/srv/employee",
          cwd: "/srv/employee",
          args: ["status"],
        },
        "disabled",
      ),
    /disabled/,
  );
});

test("workspace Git host execution requires the separate unsafe-host acknowledgement", () => {
  const options = {
    workspaceRoot: "/srv/employee",
    cwd: "/srv/employee",
    args: ["status"],
  };

  assert.throws(
    () => buildWorkspaceGitInvocation(options, "host", "/usr/bin/bwrap", false),
    /explicitly acknowledge host execution/i,
  );

  const acknowledged = buildWorkspaceGitInvocation(options, "host", "/usr/bin/bwrap", true);
  assert.equal(acknowledged.executable, "git");
  assert.equal(acknowledged.isolated, false);
});

test("workspace Git rejects gitdir and commondir pointers outside the employee workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-git-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const checkout = path.join(workspace, "repo");
  const outsideGit = path.join(root, "outside.git");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  fs.mkdirSync(outsideGit);

  fs.writeFileSync(
    path.join(checkout, ".git", "commondir"),
    path.relative(path.join(checkout, ".git"), outsideGit),
  );
  assert.throws(
    () => assertWorkspaceGitMetadataContained(workspace, checkout),
    /common directory escapes/,
  );

  fs.rmSync(path.join(checkout, ".git"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${outsideGit}\n`);
  assert.throws(
    () => assertWorkspaceGitMetadataContained(workspace, checkout),
    /Git directory escapes/,
  );
});
