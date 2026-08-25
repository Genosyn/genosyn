import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSandboxShellInvocation } from "./sandboxShell.js";

/**
 * The one place that decides what a shell child can reach.
 *
 * Two callers share it — the employee `bash` tool and a Repository work
 * session's `repository_run_command` — and the differences between them are
 * exactly what these tests pin, because a silent drift in either direction is
 * a security change nobody would notice reading a diff.
 */

const BASE = {
  workspaceRoot: "/srv/workspace",
  cwd: "/srv/workspace",
  command: "npm test",
  env: { SECRET: "s3cret" },
};

function valuesAfter(args: string[], flag: string, count: number): string[] {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args.slice(index, index + count + 1);
}

describe("host-mode construction", () => {
  test("runs a login shell by default, keeping the bash tool's behaviour", () => {
    const invocation = buildSandboxShellInvocation(BASE, "host");
    assert.equal(invocation.executable, "bash");
    assert.deepEqual(invocation.args, ["-lc", "npm test"]);
    assert.equal(invocation.isolated, false);
  });

  test("runs a plain shell when the caller refuses a profile", () => {
    const invocation = buildSandboxShellInvocation({ ...BASE, login: false }, "host");
    assert.deepEqual(invocation.args, ["-c", "npm test"]);
  });

  test("hands the caller's environment to the child, with runner-owned values winning", () => {
    const invocation = buildSandboxShellInvocation(
      { ...BASE, env: { SECRET: "s3cret", HOME: "/etc", LANG: "xx" } },
      "host",
    );
    assert.equal(invocation.env.SECRET, "s3cret");
    assert.equal(invocation.env.HOME, "/srv/workspace");
    assert.equal(invocation.env.LANG, "C.UTF-8");
  });
});

describe("bubblewrap construction", () => {
  test("wraps the same shell invocation behind the namespace boundary", () => {
    const invocation = buildSandboxShellInvocation({ ...BASE, login: false }, "bubblewrap");
    assert.equal(invocation.isolated, true);
    const separator = invocation.args.indexOf("--");
    assert.deepEqual(invocation.args.slice(separator), ["--", "bash", "-c", "npm test"]);
  });

  test("gives the launcher no secrets, and the child HOME inside the sandbox", () => {
    const invocation = buildSandboxShellInvocation(BASE, "bubblewrap");
    // Everything the child gets travels as `--setenv` triples; the bwrap
    // process itself sees only PATH, so an LD_PRELOAD-shaped value cannot act
    // before bwrap clears its child environment.
    assert.deepEqual(Object.keys(invocation.env), ["PATH"]);
    assert.deepEqual(valuesAfter(invocation.args, "--setenv", 2), ["--setenv", "SECRET", "s3cret"]);
    const home = invocation.args.indexOf("HOME");
    assert.equal(invocation.args[home + 1], "/workspace");
  });

  test("passes read-only overlays through, on top of the workspace bind", () => {
    const invocation = buildSandboxShellInvocation(
      { ...BASE, readOnlyPaths: ["/srv/workspace/.git"] },
      "bubblewrap",
    );
    // Searched after the workspace bind on purpose: the static `/lib`-style
    // overlays come earlier, and only a bind applied *after* `/workspace`
    // survives it.
    const bind = invocation.args.indexOf("--bind");
    const readOnly = invocation.args.indexOf("--ro-bind-try", bind);
    assert.notEqual(readOnly, -1, "the overlay is missing");
    assert.deepEqual(invocation.args.slice(readOnly, readOnly + 3), [
      "--ro-bind-try",
      "/srv/workspace/.git",
      "/workspace/.git",
    ]);
  });
});

describe("what it refuses to build at all", () => {
  test("an environment name that is not a shell variable", () => {
    const cases: Record<string, string>[] = [{ "BAD-NAME": "x" }, { GOOD: "has\0nul" }];
    for (const env of cases) {
      assert.throws(
        () => buildSandboxShellInvocation({ ...BASE, env }, "bubblewrap"),
        /invalid shell environment/i,
        JSON.stringify(env),
      );
    }
  });

  test("a working directory outside the workspace", () => {
    assert.throws(
      () => buildSandboxShellInvocation({ ...BASE, cwd: "/srv/elsewhere" }, "bubblewrap"),
      /must stay inside the workspace/i,
    );
  });
});
