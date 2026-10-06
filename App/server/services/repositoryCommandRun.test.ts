import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import {
  MAX_SESSION_COMMAND_OUTPUT,
  isCommandRefusal,
  runWorkSessionCommand,
  workSessionCommandAvailability,
} from "./repositoryCommandRun.js";

/**
 * Running a command for a Repository work session.
 *
 * Commands run on the host, so these tests spawn real shells. Everything on
 * the path is the real code: the gate, the allowlist, the spawn, the timeout,
 * the output ceiling.
 */

const mutableCodingConfig = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const original = { ...mutableCodingConfig };

before(() => {
  mutableCodingConfig.enabled = true;
  mutableCodingConfig.executionMode = "host";
  mutableCodingConfig.allowUnsafeHostExecution = true;
});

after(() => {
  Object.assign(mutableCodingConfig, original);
});

async function worktree(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-session-"));
  // A real session worktree's `.git` is a pointer file; keep one so the paths
  // these tests resolve look like production.
  await fs.writeFile(path.join(directory, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A command that leaves evidence if it runs, for tests proving it did not. */
async function sentinel(
  t: { after: (fn: () => void | Promise<void>) => void },
): Promise<{ command: string; ran: () => Promise<boolean> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-spawn-sentinel-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "spawned");
  return {
    command: `touch ${JSON.stringify(file)}`,
    ran: () => fs.stat(file).then(
      () => true,
      () => false,
    ),
  };
}

const OPEN_REPO = { commandMode: "all" as const, allowedCommands: "" };
const LISTED_REPO = { commandMode: "allowlist" as const, allowedCommands: "" };

describe("whether a session may run commands at all", () => {
  test("yes on a host install whose repository allows them", () => {
    assert.deepEqual(workSessionCommandAvailability({ commandMode: "allowlist" }), {
      available: true,
    });
  });

  test("no when the repository says no", () => {
    const decision = workSessionCommandAvailability({ commandMode: "off" });
    assert.equal(decision.available, false);
    assert.match(decision.available ? "" : decision.reason, /does not let AI employees run/);
  });

  test("no when the install cannot execute commands at all", () => {
    mutableCodingConfig.executionMode = "disabled";
    try {
      assert.equal(workSessionCommandAvailability({ commandMode: "all" }).available, false);
    } finally {
      mutableCodingConfig.executionMode = "host";
    }
  });
});

describe("running one", () => {
  test("returns what the command printed and its exit code", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "echo hello; echo trouble >&2",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.match(result.output, /hello/);
    assert.match(result.output, /trouble/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  });

  test("a failing command reports its exit code rather than an error", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "echo nope; exit 3",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /nope/);
  });

  test("runs in the session worktree", async (t) => {
    const directory = await worktree(t);
    await fs.writeFile(path.join(directory, "marker.txt"), "here");
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "ls",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.match(result.output, /marker\.txt/);
    assert.equal(result.cwd, ".");
  });

  test("executes a guide's lint command in each package under the default allowed list", async (t) => {
    const directory = await worktree(t);
    for (const cwd of ["App", "packages/Home site"]) {
      const packageDirectory = path.join(directory, cwd);
      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.writeFile(path.join(packageDirectory, "marker.txt"), `checked ${cwd}`);
      await fs.writeFile(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({
          name: "guide-command-fixture",
          scripts: {
            lint: "node -e \"process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))\"",
          },
        }),
      );
      const result = await runWorkSessionCommand({
        repo: LISTED_REPO,
        directory,
        cwd,
        command: "npm run lint",
      });
      assert.ok(!isCommandRefusal(result));
      if (isCommandRefusal(result)) return;
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, new RegExp(`checked ${cwd}`));
      assert.equal(result.cwd, cwd);
    }
  });

  test("an explicit root directory preserves the default command behavior", async (t) => {
    const directory = await worktree(t);
    for (const cwd of [".", ""]) {
      const result = await runWorkSessionCommand({
        repo: LISTED_REPO,
        directory,
        cwd,
        command: "pwd",
      });
      assert.ok(!isCommandRefusal(result));
      if (isCommandRefusal(result)) return;
      assert.equal(result.exitCode, 0);
      assert.equal(await fs.realpath(result.output.trim()), await fs.realpath(directory));
      assert.equal(result.cwd, ".");
    }
  });

  test("reports the resolved directory for an alias inside the worktree", async (t) => {
    const directory = await worktree(t);
    await fs.mkdir(path.join(directory, "App"));
    await fs.writeFile(path.join(directory, "App", "marker.txt"), "from App");
    await fs.symlink("App", path.join(directory, "app-alias"));
    const result = await runWorkSessionCommand({
      repo: LISTED_REPO,
      directory,
      cwd: "app-alias",
      command: "cat marker.txt",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "from App");
    assert.equal(result.cwd, "App");
  });

  test("a failed check retains its package directory in the evidence", async (t) => {
    const directory = await worktree(t);
    await fs.mkdir(path.join(directory, "App"));
    const result = await runWorkSessionCommand({
      repo: LISTED_REPO,
      directory,
      cwd: "App/",
      command: "false",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.exitCode, 1);
    assert.equal(result.cwd, "App");
  });

  test("stops a command that runs too long, and keeps what it printed", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "echo starting; sleep 30",
      timeoutMs: 700,
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.timedOut, true);
    assert.match(result.output, /was stopped after/);
    assert.match(result.output, /starting/);
  });

  test("stops when the work session is cancelled", async (t) => {
    const directory = await worktree(t);
    const controller = new AbortController();
    const pending = runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "sleep 30",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.aborted, true);
  });

  test("does not start a login shell, which would run a profile the employee wrote", async (t) => {
    const directory = await worktree(t);
    // The worktree is what the employee writes through `repository_write_file`.
    // `bash -lc` would source a profile it had just written on every command —
    // running code that never appeared in the command and never met the
    // repository's list.
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "shopt -q login_shell && echo login || echo plain",
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.output.trim(), "plain");
  });

  test("does not corrupt a multi-byte character that lands on the head ceiling", async (t) => {
    const directory = await worktree(t);
    // Well over the 16 KB head of a 3-byte character (24 KB), and under the
    // 48 KB total, so one of them straddles the internal head/tail split while
    // nothing is dropped. The output must decode as if it had never been split.
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: `node -e 'process.stdout.write("\u4f60".repeat(8000))'`,
      timeoutMs: 60_000,
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.truncated, false);
    assert.equal(result.output, "\u4f60".repeat(8000));
  });

  test("keeps both ends of very long output and says what it dropped", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      // Bracket a lot of noise, so the assertion proves both ends survived.
      command: `echo FIRSTLINE; for i in $(seq 1 40000); do echo "filler line $i padded out a bit"; done; echo LASTLINE`,
      timeoutMs: 60_000,
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.truncated, true);
    assert.match(result.output, /FIRSTLINE/);
    assert.match(result.output, /LASTLINE/);
    assert.match(result.output, /bytes of output omitted/);
    assert.ok(
      Buffer.byteLength(result.output) < MAX_SESSION_COMMAND_OUTPUT + 1024,
      "output should stay near the ceiling",
    );
  });
});

describe("refusing one", () => {
  for (const cwd of [
    "../outside",
    "App/../Home",
    "./App",
    "App//nested",
    ".git",
    "App/\0bad",
    "/tmp",
    "C:\\workspace",
  ]) {
    test(`refuses an invalid working directory ${JSON.stringify(cwd)} without spawning`, async (t) => {
      const directory = await worktree(t);
      const spawned = await sentinel(t);
      const result = await runWorkSessionCommand({
        repo: OPEN_REPO,
        directory,
        cwd,
        command: spawned.command,
      });
      assert.ok(isCommandRefusal(result));
      assert.equal(await spawned.ran(), false);
    });
  }

  for (const cwd of ["missing", "marker.txt", "marker.txt/child"]) {
    test(`refuses a missing or non-directory working directory ${cwd}`, async (t) => {
      const directory = await worktree(t);
      await fs.writeFile(path.join(directory, "marker.txt"), "a file");
      const spawned = await sentinel(t);
      const result = await runWorkSessionCommand({
        repo: OPEN_REPO,
        directory,
        cwd,
        command: spawned.command,
      });
      assert.ok(isCommandRefusal(result));
      assert.match(isCommandRefusal(result) ? result.refused : "", /existing directory/);
      assert.equal(await spawned.ran(), false);
    });
  }

  test("refuses a directory symlink outside the worktree without spawning", async (t) => {
    const directory = await worktree(t);
    const outside = await worktree(t);
    await fs.symlink(outside, path.join(directory, "outside"));
    const spawned = await sentinel(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      cwd: "outside",
      command: spawned.command,
    });
    assert.ok(isCommandRefusal(result));
    assert.match(isCommandRefusal(result) ? result.refused : "", /escapes the repository/);
    assert.equal(await spawned.ran(), false);
  });

  test("refuses a directory alias into managed Git metadata", async (t) => {
    const directory = await worktree(t);
    await fs.mkdir(path.join(directory, "nested", ".git"), { recursive: true });
    await fs.symlink("nested/.git", path.join(directory, "git-alias"));
    const spawned = await sentinel(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      cwd: "git-alias",
      command: spawned.command,
    });
    assert.ok(isCommandRefusal(result));
    assert.match(isCommandRefusal(result) ? result.refused : "", /\.git directory is managed/);
    assert.equal(await spawned.ran(), false);
  });

  test("a package directory does not broaden the repository's allowed commands", async (t) => {
    const directory = await worktree(t);
    await fs.mkdir(path.join(directory, "App"));
    const result = await runWorkSessionCommand({
      repo: { commandMode: "allowlist", allowedCommands: "npm run lint" },
      directory,
      cwd: "App",
      command: "touch should-not-run.txt",
    });
    assert.ok(isCommandRefusal(result));
    assert.match(isCommandRefusal(result) ? result.refused : "", /not on this repository's list/);
    await assert.rejects(fs.stat(path.join(directory, "App", "should-not-run.txt")));
  });

  test("a command the repository's list does not cover never spawns", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: LISTED_REPO,
      directory,
      command: "curl https://example.com",
    });
    assert.ok(isCommandRefusal(result));
    assert.match(isCommandRefusal(result) ? result.refused : "", /not on this repository's list/);
  });

  test("the allowed half of a chained command does not run either", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: LISTED_REPO,
      directory,
      command: "touch ran.txt && curl https://example.com",
    });
    assert.ok(isCommandRefusal(result));
    await assert.rejects(() => fs.stat(path.join(directory, "ran.txt")));
  });

  test("a repository with commands off refuses even an obviously safe one", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: { commandMode: "off", allowedCommands: "" },
      directory,
      command: "echo hi",
    });
    assert.ok(isCommandRefusal(result));
  });
});

describe("host commands used by OpenCode work sessions", () => {
  beforeEach(() => {
    mutableCodingConfig.enabled = true;
    mutableCodingConfig.executionMode = "host";
    mutableCodingConfig.allowUnsafeHostExecution = true;
  });
  test("runs an allowed package script in a nested package", async (t) => {
    const directory = await worktree(t);
    const cwd = "packages/company site";
    await fs.mkdir(path.join(directory, cwd), { recursive: true });
    await fs.writeFile(
      path.join(directory, cwd, "package.json"),
      JSON.stringify({
        name: "host-session-fixture",
        scripts: { test: "node -e \"console.log('host package passed')\"" },
      }),
    );
    const result = await runWorkSessionCommand({
      repo: LISTED_REPO,
      directory,
      cwd,
      command: "npm test",
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.cwd, cwd);
    assert.match(result.output, /host package passed/);
  });

  test("captures stdout, stderr, and a failing exit status", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "echo checked; echo failure >&2; exit 7",
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /checked/);
    assert.match(result.output, /failure/);
    assert.equal(result.aborted, false);
    assert.equal(result.timedOut, false);
  });

  test("uses a clean temporary home and removes it after the command", async (t) => {
    const directory = await worktree(t);
    const secretName = "GENOSYN_HOST_COMMAND_PARENT_TEST_SECRET";
    const previousSecret = process.env[secretName];
    const previousBashEnv = process.env.BASH_ENV;
    process.env[secretName] = "must-not-be-inherited";
    process.env.BASH_ENV = path.join(directory, "profile.sh");
    await fs.writeFile(process.env.BASH_ENV, "echo unexpected-profile\n");
    t.after(() => {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      if (previousBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previousBashEnv;
    });
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: `node -e 'console.log(JSON.stringify({ home: process.env.HOME, ci: process.env.CI, secret: process.env.${secretName}, bashEnv: process.env.BASH_ENV })); require("node:fs").writeFileSync(process.env.HOME + "/cache", "temporary")'`,
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.exitCode, 0);
    const reported = JSON.parse(result.output) as {
      home: string;
      ci: string;
      secret?: string;
      bashEnv?: string;
    };
    assert.equal(reported.ci, "1");
    assert.equal(reported.secret, undefined);
    assert.equal(reported.bashEnv, undefined);
    assert.ok(!reported.home.startsWith(directory));
    await assert.rejects(fs.stat(reported.home), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(directory)).sort(), [".git", "profile.sh"]);
  });

  test("preserves the Repository command list and command-off setting", async (t) => {
    const directory = await worktree(t);
    for (const repo of [
      { commandMode: "allowlist" as const, allowedCommands: "npm test" },
      { commandMode: "off" as const, allowedCommands: "" },
    ]) {
      const result = await runWorkSessionCommand({ repo, directory, command: "touch forbidden" });
      assert.ok(isCommandRefusal(result));
      await assert.rejects(fs.stat(path.join(directory, "forbidden")), { code: "ENOENT" });
    }
  });

  test("preserves an explicit install opt-out", async (t) => {
    const directory = await worktree(t);
    mutableCodingConfig.allowUnsafeHostExecution = false;
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "touch forbidden",
    });
    assert.ok(isCommandRefusal(result));
    await assert.rejects(fs.stat(path.join(directory, "forbidden")), { code: "ENOENT" });
  });

  test("rejects a working directory outside the session and managed Git metadata", async (t) => {
    const directory = await worktree(t);
    for (const cwd of ["../", "/tmp", ".git"]) {
      const result = await runWorkSessionCommand({
        repo: OPEN_REPO,
        directory,
        cwd,
        command: "true",
      });
      assert.ok(isCommandRefusal(result));
    }
  });

  test("timeout stops the process and retains its evidence", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "echo started; sleep 30",
      timeoutMs: 700,
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /started/);
  });

  test("cancellation stops a running host command", async (t) => {
    const directory = await worktree(t);
    const controller = new AbortController();
    const pending = runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "sleep 30",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.aborted, true);
    assert.equal(result.exitCode, null);
  });

  test("an already cancelled session does not launch its command", async (t) => {
    const directory = await worktree(t);
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "touch forbidden",
      signal: controller.signal,
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.aborted, true);
    await assert.rejects(fs.stat(path.join(directory, "forbidden")), { code: "ENOENT" });
  });

  test("background descendants are stopped as soon as the shell exits", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: "sleep 30 & echo finished",
      timeoutMs: 2_000,
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false, "a background process must not keep the command open");
    assert.match(result.output, /finished/);
  });

  test("large host output keeps its beginning and failure summary", async (t) => {
    const directory = await worktree(t);
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: `node -e 'process.stdout.write("FIRST\\n" + "x".repeat(200000) + "\\nFAILURE SUMMARY")'`,
    });
    assert.ok(!isCommandRefusal(result));
    assert.equal(result.truncated, true);
    assert.match(result.output, /^FIRST/);
    assert.match(result.output, /FAILURE SUMMARY$/);
    assert.ok(Buffer.byteLength(result.output) < MAX_SESSION_COMMAND_OUTPUT + 1024);
  });
});
