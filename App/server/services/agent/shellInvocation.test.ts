import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildShellInvocation } from "./shellInvocation.js";

/**
 * The one place that decides what a shell child receives.
 *
 * Three callers share it — the employee `bash` tool, a Repository work
 * session's `repository_run_command`, and a Routine's `command` Check — and the
 * differences between them are exactly what these tests pin, because a silent
 * drift in either direction is a security change nobody would notice reading a
 * diff.
 */

const BASE = {
  cwd: "/srv/workspace",
  command: "npm test",
  env: { SECRET: "s3cret" },
};

describe("construction", () => {
  test("runs a login shell by default, keeping the bash tool's behaviour", () => {
    const invocation = buildShellInvocation(BASE);
    assert.equal(invocation.executable, "bash");
    assert.deepEqual(invocation.args, ["-lc", "npm test"]);
  });

  test("runs a plain shell when the caller refuses a profile", () => {
    const invocation = buildShellInvocation({ ...BASE, login: false });
    assert.deepEqual(invocation.args, ["-c", "npm test"]);
  });

  test("hands the caller's environment to the child, with runner-owned values winning", () => {
    const invocation = buildShellInvocation({
      ...BASE,
      env: { SECRET: "s3cret", HOME: "/etc", LANG: "xx" },
    });
    assert.equal(invocation.env.SECRET, "s3cret");
    assert.equal(invocation.env.HOME, "/srv/workspace");
    assert.equal(invocation.env.LANG, "C.UTF-8");
  });

  test("points HOME where the caller asks, so caches stay out of a worktree", () => {
    const invocation = buildShellInvocation({ ...BASE, home: "/tmp/session-home" });
    assert.equal(invocation.env.HOME, "/tmp/session-home");
  });

  test("inherits nothing from the App's own environment", () => {
    const invocation = buildShellInvocation(BASE);
    assert.deepEqual(Object.keys(invocation.env).sort(), ["HOME", "LANG", "PATH", "SECRET"]);
  });
});

describe("what it refuses to build at all", () => {
  test("an environment name that is not a shell variable", () => {
    const cases: Record<string, string>[] = [{ "BAD-NAME": "x" }, { GOOD: "has\0nul" }];
    for (const env of cases) {
      assert.throws(
        () => buildShellInvocation({ ...BASE, env }),
        /invalid shell environment/i,
        JSON.stringify(env),
      );
    }
  });
});
