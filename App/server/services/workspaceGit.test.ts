import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceGitInvocation } from "./workspaceGit.js";

test("bubblewrapped Git receives private namespaces and an explicit environment", () => {
  const invocation = buildWorkspaceGitInvocation(
    {
      workspaceRoot: "/srv/employee",
      cwd: "/srv/employee/code-repos/app",
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
  );

  assert.equal(invocation.isolated, false);
  assert.equal("CODEX_ACCESS_TOKEN" in invocation.env, false);
  assert.equal("DATABASE_URL" in invocation.env, false);
  assert.equal(invocation.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(invocation.env.GIT_SSH_COMMAND, "/bin/false");
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
        },
        "disabled",
      ),
    /disabled/,
  );
});
