import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWorkspaceGitMetadataContained,
  buildWorkspaceGitInvocation,
  redactSecrets,
} from "./workspaceGit.js";

const credentialNames = [
  "GENOSYN_GH_TOKEN_CONNECTION",
  "GENOSYN_REPO_TOKEN_CONNECTION",
  "GENOSYN_FORGE_TOKEN_01234567_89AB_4CDE_8F01_23456789ABCD",
];

for (const mode of ["host", "disabled"] as const) {
  for (const name of credentialNames) {
    test(`${mode} Git accepts and redacts the server-held ${name} credential`, () => {
      const token = "fixture-only-forge-credential";
      const invocation = buildWorkspaceGitInvocation(
        {
          workspaceRoot: "/srv/employee",
          cwd: "/srv/employee",
          args: ["fetch", "https://github.com/acme/repo.git"],
          extraEnv: { [name]: token },
          serverOwned: true,
        },
        mode,
        true,
      );
      assert.equal(invocation.env[name], token);
      assert.equal(invocation.args.includes(token), false);
      assert.ok(invocation.secrets.includes(token));
      assert.equal(
        redactSecrets(`fatal: ${token} rejected; detail=${token}`, invocation.secrets),
        "fatal: «redacted» rejected; detail=«redacted»",
      );
    });
  }
}

test("allowing forge credentials does not admit arbitrary environment names or malformed suffixes", () => {
  for (const name of [
    "GENOSYN_FORGE_TOKEN_",
    "GENOSYN_FORGE_TOKEN_lowercase",
    "GENOSYN_FORGE_TOKEN_A-B",
    "GENOSYN_FORGE_TOKEN_A=VALUE",
    "GENOSYN_FORGE_TOKEN_A\nPATH",
    "GENOSYN_FORGE_TOKEN_A;COMMAND",
    "GENOSYN_FORGED_TOKEN_CONNECTION",
    "GENOSYN_OTHER_TOKEN_CONNECTION",
    "GENOSYN_FORGE_TOKEN",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_VALUE_0",
    "GIT_ASKPASS",
    "PATH",
    "CODEX_ACCESS_TOKEN",
  ]) {
    assert.throws(
      () =>
        buildWorkspaceGitInvocation(
          {
            workspaceRoot: "/srv/employee",
            cwd: "/srv/employee",
            args: ["fetch"],
            extraEnv: { [name]: "fixture-secret-never-echoed" },
            serverOwned: true,
          },
          "host",
        ),
      (error: Error) => {
        assert.match(error.message, /Git environment variable is not allowed/);
        assert.doesNotMatch(error.message, /fixture-secret-never-echoed/);
        return true;
      },
      name,
    );
  }
});

for (const name of credentialNames) {
  test(`${name} rejects credential line breaks and NUL without disclosing the value`, () => {
    for (const character of ["\0", "\r", "\n", "\r\n"]) {
      assert.throws(
        () =>
          buildWorkspaceGitInvocation(
            {
              workspaceRoot: "/srv/employee",
              cwd: "/srv/employee",
              args: ["fetch"],
              extraEnv: { [name]: `fixture-secret${character}injected-value` },
              serverOwned: true,
            },
            "host",
          ),
        (error: Error) => {
          assert.match(error.message, /Invalid Git (?:token )?environment value/);
          assert.doesNotMatch(error.message, /fixture-secret|injected-value/);
          return true;
        },
      );
    }
  });
}

test("workspace Git never inherits arbitrary App or Codex environment variables", () => {
  const invocation = buildWorkspaceGitInvocation(
    {
      workspaceRoot: "/srv/employee",
      cwd: "/srv/employee",
      args: ["status"],
    },
    "host",
    true,
  );

  assert.equal(invocation.executable, "git");
  assert.equal("CODEX_ACCESS_TOKEN" in invocation.env, false);
  assert.equal("DATABASE_URL" in invocation.env, false);
  assert.equal(invocation.env.HOME, "/srv/employee");
  assert.equal(invocation.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(invocation.env.GIT_SSH_COMMAND, "/bin/false");
  // The command-scoped hardening rides in the environment, not in argv.
  const keys = Array.from(
    { length: Number(invocation.env.GIT_CONFIG_COUNT) },
    (_value, index) => invocation.env[`GIT_CONFIG_KEY_${index}`],
  );
  for (const key of ["core.hooksPath", "protocol.ext.allow", "protocol.file.allow"]) {
    assert.ok(keys.includes(key), key);
  }
  assert.deepEqual(invocation.args, ["status"]);
});

test("macOS Git can use Homebrew while Linux keeps the trusted path", () => {
  for (const [platform, mode] of [
    ["darwin", "host"],
    ["darwin", "disabled"],
    ["linux", "host"],
    ["linux", "disabled"],
  ] as const) {
    const invocation = buildWorkspaceGitInvocation(
      {
        workspaceRoot: "/srv/workspace",
        cwd: "/srv/workspace",
        args: ["status"],
        serverOwned: true,
      },
      mode,
      true,
      platform,
    );
    const basePath = "/usr/local/bin:/usr/bin:/bin";
    assert.equal(
      invocation.env.PATH,
      platform === "darwin" ? `/opt/homebrew/bin:${basePath}` : basePath,
    );
  }
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
        "host",
        true,
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
    () => buildWorkspaceGitInvocation(options, "host", false),
    /allowUnsafeHostExecution/,
  );

  const acknowledged = buildWorkspaceGitInvocation(options, "host", true);
  assert.equal(acknowledged.executable, "git");
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
