import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildBubblewrapCommandArgs, type BubblewrapCommandOptions } from "./bubblewrap.js";

function options(overrides: Partial<BubblewrapCommandOptions> = {}): BubblewrapCommandOptions {
  return {
    workspaceRoot: "/srv/genosyn/employee",
    cwd: "/srv/genosyn/employee",
    executable: "bash",
    args: ["-lc", "pwd"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/workspace",
      LANG: "C.UTF-8",
    },
    ...overrides,
  };
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

describe("bubblewrap cwd confinement", () => {
  test("maps the workspace root and a nested cwd onto /workspace", () => {
    const root = buildBubblewrapCommandArgs(options());
    assert.equal(valueAfter(root, "--chdir"), "/workspace");

    const nested = buildBubblewrapCommandArgs(
      options({ cwd: "/srv/genosyn/employee/code-repos/acme/app" }),
    );
    assert.equal(valueAfter(nested, "--chdir"), "/workspace/code-repos/acme/app");
  });

  test("rejects parent escapes, absolute siblings, and prefix collisions", () => {
    for (const cwd of [
      "/srv/genosyn/employee/../outside",
      "/srv/genosyn/other",
      "/srv/genosyn/employee-other/repo",
    ]) {
      assert.throws(
        () => buildBubblewrapCommandArgs(options({ cwd })),
        /working directory must stay inside the workspace/i,
        cwd,
      );
    }
  });
});

describe("bubblewrap isolation posture", () => {
  test("creates private namespaces and exposes only the writable workspace", () => {
    const args = buildBubblewrapCommandArgs(options());
    for (const flag of [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--proc",
      "--dev",
      "--tmpfs",
      "--clearenv",
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(args.includes("--unshare-cgroup"), false);
    assert.equal(args.filter((arg) => arg === "--unshare-cgroup-try").length, 1);

    const bind = args.indexOf("--bind");
    assert.deepEqual(args.slice(bind, bind + 3), ["--bind", "/srv/genosyn/employee", "/workspace"]);
    assert.deepEqual(args.slice(args.indexOf("--proc"), args.indexOf("--proc") + 2), [
      "--proc",
      "/proc",
    ]);
    assert.deepEqual(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 2), [
      "--tmpfs",
      "/tmp",
    ]);
    assert.equal(args.includes("--unshare-net"), false);
  });

  test("unshares the network only when requested", () => {
    const connected = buildBubblewrapCommandArgs(options({ unshareNetwork: false }));
    const disconnected = buildBubblewrapCommandArgs(options({ unshareNetwork: true }));
    assert.equal(connected.includes("--unshare-net"), false);
    assert.equal(disconnected.filter((arg) => arg === "--unshare-net").length, 1);
    assert.ok(disconnected.indexOf("--unshare-net") < disconnected.indexOf("--"));
  });

  test("clears the inherited environment and preserves explicit values verbatim", () => {
    const env = {
      SAFE_NAME: "value with spaces; $(not executed)",
      EMPTY_VALUE: "",
    };
    const args = buildBubblewrapCommandArgs(options({ env }));
    const clear = args.indexOf("--clearenv");
    const firstSet = args.indexOf("--setenv");
    assert.ok(clear >= 0 && clear < firstSet);
    assert.deepEqual(args.slice(firstSet, firstSet + 6), [
      "--setenv",
      "SAFE_NAME",
      env.SAFE_NAME,
      "--setenv",
      "EMPTY_VALUE",
      "",
    ]);
  });

  test("rejects invalid environment names and NUL values", () => {
    assert.throws(
      () => buildBubblewrapCommandArgs(options({ env: { "BAD-NAME": "value" } })),
      /invalid bubblewrap environment entry/i,
    );
    assert.throws(
      () => buildBubblewrapCommandArgs(options({ env: { GOOD_NAME: "bad\0value" } })),
      /invalid bubblewrap environment entry/i,
    );
  });

  test("preserves the executable and arguments as an uninterpreted tail", () => {
    const executable = "/usr/bin/tool with spaces";
    const commandArgs = ["", "argument with spaces", "$(touch nope)", "--flag=value"];
    const args = buildBubblewrapCommandArgs(
      options({
        executable,
        args: commandArgs,
        workspaceRoot: "/srv/work space",
        cwd: "/srv/work space",
      }),
    );
    const separator = args.indexOf("--");
    assert.deepEqual(args.slice(separator), ["--", executable, ...commandArgs]);
    const bind = args.indexOf("--bind");
    assert.deepEqual(args.slice(bind, bind + 3), ["--bind", "/srv/work space", "/workspace"]);
  });
});
