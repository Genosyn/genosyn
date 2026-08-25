import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
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
 * The production path is bubblewrap and only bubblewrap, so these tests keep
 * the execution mode set to it and stand a shim in for the `bwrap` binary,
 * which a developer machine will not have. The shim honours the two parts of
 * the invocation these tests are about — `--setenv` and everything after `--`
 * — and ignores the namespace flags, which have their own construction suite
 * in `agent/bubblewrap.test.ts`. Everything else on the path is the real code:
 * the gate, the allowlist, the spawn, the timeout, the output ceiling.
 */

const mutableCodingConfig = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  bubblewrapPath: string;
  allowUnsafeHostExecution: boolean;
};
const original = { ...mutableCodingConfig };

let shimDirectory = "";
let argvLog = "";

before(async () => {
  shimDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-bwrap-shim-"));
  argvLog = path.join(shimDirectory, "argv.log");
  const shim = path.join(shimDirectory, "bwrap");
  await fs.writeFile(
    shim,
    [
      "#!/bin/bash",
      "# Test double for bwrap: record the invocation, apply --setenv, then run",
      "# whatever follows `--`. The recording is how a test can assert on flags",
      "# the sandbox would have applied for real but this shim ignores.",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    --setenv) export "$2"="$3"; shift 3 ;;',
      "    --) shift; break ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  mutableCodingConfig.enabled = true;
  mutableCodingConfig.executionMode = "bubblewrap";
  mutableCodingConfig.bubblewrapPath = shim;
});

after(async () => {
  Object.assign(mutableCodingConfig, original);
  if (shimDirectory) await fs.rm(shimDirectory, { recursive: true, force: true });
});

async function worktree(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-session-"));
  // A real session worktree's `.git` is a pointer file, and the runner asks
  // bubblewrap to bind it read-only. `--ro-bind-try` must not care that the
  // shim ignores it, but the path should exist as it does in production.
  await fs.writeFile(path.join(directory, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const OPEN_REPO = { commandMode: "all" as const, allowedCommands: "" };
const LISTED_REPO = { commandMode: "allowlist" as const, allowedCommands: "" };

describe("whether a session may run commands at all", () => {
  test("yes on a bubblewrap install whose repository allows them", () => {
    assert.deepEqual(workSessionCommandAvailability({ commandMode: "allowlist" }), {
      available: true,
    });
  });

  test("no when the repository says no", () => {
    const decision = workSessionCommandAvailability({ commandMode: "off" });
    assert.equal(decision.available, false);
    assert.match(decision.available ? "" : decision.reason, /does not let AI employees run/);
  });

  test("no in host mode, however the repository is configured", () => {
    mutableCodingConfig.executionMode = "host";
    mutableCodingConfig.allowUnsafeHostExecution = true;
    try {
      const decision = workSessionCommandAvailability({ commandMode: "all" });
      assert.equal(decision.available, false);
      assert.match(decision.available ? "" : decision.reason, /bubblewrap/);
    } finally {
      mutableCodingConfig.executionMode = "bubblewrap";
      mutableCodingConfig.allowUnsafeHostExecution = original.allowUnsafeHostExecution;
    }
  });

  test("no when the install cannot execute commands at all", () => {
    mutableCodingConfig.executionMode = "disabled";
    try {
      assert.equal(workSessionCommandAvailability({ commandMode: "all" }).available, false);
    } finally {
      mutableCodingConfig.executionMode = "bubblewrap";
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

  test("asks for a sandbox rooted at the worktree, with .git read-only", async (t) => {
    const directory = await worktree(t);
    await runWorkSessionCommand({ repo: OPEN_REPO, directory, command: "true" });
    const argv = (await fs.readFile(argvLog, "utf8")).split("\n");
    const bind = argv.indexOf("--bind");
    assert.notEqual(bind, -1);
    assert.deepEqual(argv.slice(bind, bind + 3), ["--bind", directory, "/workspace"]);
    const readOnly = argv.indexOf("--ro-bind-try", bind);
    assert.notEqual(readOnly, -1, "the .git pointer is not bound read-only");
    assert.deepEqual(argv.slice(readOnly, readOnly + 3), [
      "--ro-bind-try",
      path.join(directory, ".git"),
      "/workspace/.git",
    ]);
  });

  test("does not start a login shell, which would run a profile the employee wrote", async (t) => {
    const directory = await worktree(t);
    // `$HOME` inside the sandbox is this worktree, which the employee writes
    // through `repository_write_file`. `bash -lc` would source a
    // `.bash_profile` it had just written on every command — running code that
    // never appeared in the command and never met the repository's list.
    await runWorkSessionCommand({ repo: OPEN_REPO, directory, command: "true" });
    const argv = (await fs.readFile(argvLog, "utf8")).split("\n");
    const separator = argv.indexOf("--");
    assert.notEqual(separator, -1);
    assert.deepEqual(argv.slice(separator + 1, separator + 3), ["bash", "-c"]);
  });

  test("does not corrupt a multi-byte character that lands on the head ceiling", async (t) => {
    const directory = await worktree(t);
    // Well over HEAD_OUTPUT_BYTES of a 3-byte character, so one of them
    // straddles the internal head/tail split. Nothing was dropped, so the
    // output must decode as if it had never been split at all.
    const result = await runWorkSessionCommand({
      repo: OPEN_REPO,
      directory,
      command: `node -e 'process.stdout.write("\u4f60".repeat(20000))'`,
      timeoutMs: 60_000,
    });
    assert.ok(!isCommandRefusal(result));
    if (isCommandRefusal(result)) return;
    assert.equal(result.truncated, false);
    assert.equal(result.output, "\u4f60".repeat(20000));
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
