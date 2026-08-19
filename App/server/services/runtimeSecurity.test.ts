import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { config } from "../../config.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import {
  bubblewrapProbeError,
  resetBubblewrapProbeCacheForTests,
  resolveCodingExecutionMode,
  secureSessionCookies,
  validateRuntimeSecurity,
} from "./runtimeSecurity.js";

type MutableConfig = {
  dataDir: string;
  agent: {
    browserEnabledInMultiTenant: boolean;
    codingTools: {
      allowNetwork: boolean;
      allowUnsafeHostExecution: boolean;
      bubblewrapPath: string;
      executionMode: "host" | "bubblewrap" | "disabled";
    };
    maxConcurrentRunsPerCompany: number;
  };
  db: {
    driver: "sqlite" | "postgres";
    postgresUrl: string;
    sqlitePath: string;
  };
  security: {
    bootstrapMasterAdminEmail: string;
    encryptionSecret: string;
    multiTenant: boolean;
    outboundPrivateHostAllowlist: string[];
    secureCookies: "auto" | boolean;
    sessionMaxAgeDays: number;
    trustedProxyHops: number;
  };
  sessionSecret: string;
};

const mutable = config as unknown as MutableConfig;
let original: MutableConfig;
let tempDir = "";

beforeEach(() => {
  original = structuredClone(mutable);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-runtime-security-"));
  mutable.dataDir = tempDir;
  mutable.db.sqlitePath = path.join(tempDir, "app.sqlite");
  resetInstanceSecretsCacheForTests();
});

afterEach(() => {
  mutable.dataDir = original.dataDir;
  mutable.agent.browserEnabledInMultiTenant = original.agent.browserEnabledInMultiTenant;
  mutable.agent.codingTools.allowNetwork = original.agent.codingTools.allowNetwork;
  mutable.agent.codingTools.allowUnsafeHostExecution =
    original.agent.codingTools.allowUnsafeHostExecution;
  mutable.agent.codingTools.bubblewrapPath = original.agent.codingTools.bubblewrapPath;
  mutable.agent.codingTools.executionMode = original.agent.codingTools.executionMode;
  mutable.agent.maxConcurrentRunsPerCompany = original.agent.maxConcurrentRunsPerCompany;
  mutable.db.driver = original.db.driver;
  mutable.db.postgresUrl = original.db.postgresUrl;
  mutable.db.sqlitePath = original.db.sqlitePath;
  mutable.security.bootstrapMasterAdminEmail = original.security.bootstrapMasterAdminEmail;
  mutable.security.encryptionSecret = original.security.encryptionSecret;
  mutable.security.multiTenant = original.security.multiTenant;
  mutable.security.outboundPrivateHostAllowlist = original.security.outboundPrivateHostAllowlist;
  mutable.security.secureCookies = original.security.secureCookies;
  mutable.security.sessionMaxAgeDays = original.security.sessionMaxAgeDays;
  mutable.security.trustedProxyHops = original.security.trustedProxyHops;
  mutable.sessionSecret = original.sessionSecret;
  resetInstanceSecretsCacheForTests();
  resetBubblewrapProbeCacheForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fakeBubblewrap(name: string, body: string): string {
  const executable = path.join(tempDir, name);
  fs.writeFileSync(executable, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  return executable;
}

/** A stand-in that satisfies the probe by writing its marker into the bind. */
function workingFakeBubblewrap(name: string): string {
  return fakeBubblewrap(
    name,
    `workspace=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--bind' ]; then
    workspace="$2"
    shift 3
  else
    shift
  fi
done
[ -n "$workspace" ]
printf '%s' 'genosyn-bubblewrap-probe-v1' > "$workspace/.genosyn-bubblewrap-probe"`,
  );
}

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("explicit cookie settings override automatic detection", () => {
  mutable.security.secureCookies = true;
  assert.equal(secureSessionCookies(), true);

  mutable.security.secureCookies = false;
  assert.equal(secureSessionCookies(), false);
});

test("multi-tenant mode always enables automatic secure cookies", () => {
  mutable.security.secureCookies = "auto";
  mutable.security.multiTenant = true;
  assert.equal(secureSessionCookies(), true);
});

test("stock deployments trust the standard ingress hop", () => {
  assert.equal(config.security.trustedProxyHops, 1);
});

test("numeric runtime invariants fail before boot", () => {
  mutable.security.trustedProxyHops = -1;
  assert.throws(validateRuntimeSecurity, /trustedProxyHops must be a non-negative integer/);

  mutable.security.trustedProxyHops = 0;
  mutable.agent.maxConcurrentRunsPerCompany = 0;
  assert.throws(validateRuntimeSecurity, /maxConcurrentRunsPerCompany must be at least 1/);

  mutable.agent.maxConcurrentRunsPerCompany = 1;
  mutable.security.sessionMaxAgeDays = 31;
  assert.throws(validateRuntimeSecurity, /sessionMaxAgeDays must be between 1 and 30/);
});

test("self-hosted defaults remain bootable", () => {
  mutable.security.multiTenant = false;
  assert.doesNotThrow(validateRuntimeSecurity);
  assert.equal(config.agent.codingTools.executionMode, "bubblewrap");
  assert.equal(config.agent.codingTools.allowUnsafeHostExecution, false);
  assert.equal(config.agent.codingTools.allowNetwork, false);
});

test("a self-hosted install with a working sandbox keeps command execution on", () => {
  mutable.security.multiTenant = false;
  mutable.agent.codingTools.executionMode = "bubblewrap";
  mutable.agent.codingTools.bubblewrapPath = workingFakeBubblewrap("resolve-working-bwrap");
  resetBubblewrapProbeCacheForTests();

  resolveCodingExecutionMode();
  assert.equal(config.agent.codingTools.executionMode, "bubblewrap");
});

test("a self-hosted install without a usable sandbox falls back to disabled", () => {
  mutable.security.multiTenant = false;
  mutable.agent.codingTools.executionMode = "bubblewrap";
  mutable.agent.codingTools.bubblewrapPath = path.join(tempDir, "absent-bwrap");
  resetBubblewrapProbeCacheForTests();

  const warnings = captureWarnings(resolveCodingExecutionMode);
  assert.equal(config.agent.codingTools.executionMode, "disabled");
  assert.match(warnings.join("\n"), /no bubblewrap executable at .*absent-bwrap/);

  // Present but unable to enter a namespace is the container-runtime case, and
  // it has to reach the same place as a missing executable.
  mutable.agent.codingTools.executionMode = "bubblewrap";
  mutable.agent.codingTools.bubblewrapPath = fakeBubblewrap(
    "denied-bwrap",
    `printf "%s" "user namespaces denied" >&2
exit 17`,
  );
  resetBubblewrapProbeCacheForTests();

  const denied = captureWarnings(resolveCodingExecutionMode);
  assert.equal(config.agent.codingTools.executionMode, "disabled");
  assert.match(denied.join("\n"), /user namespaces denied/);
});

test("the sandbox fallback never reaches for host execution or overrides an operator", () => {
  mutable.security.multiTenant = false;
  mutable.agent.codingTools.bubblewrapPath = path.join(tempDir, "absent-bwrap");
  resetBubblewrapProbeCacheForTests();

  // An acknowledged host install is the operator's decision, not a default to
  // resolve — and a broken sandbox must never be an argument for host mode.
  mutable.agent.codingTools.executionMode = "host";
  mutable.agent.codingTools.allowUnsafeHostExecution = true;
  resolveCodingExecutionMode();
  assert.equal(config.agent.codingTools.executionMode, "host");
});

test("multi-tenant boots keep failing closed instead of silently degrading", () => {
  mutable.security.multiTenant = true;
  mutable.agent.codingTools.executionMode = "bubblewrap";
  mutable.agent.codingTools.bubblewrapPath = path.join(tempDir, "absent-bwrap");
  resetBubblewrapProbeCacheForTests();

  resolveCodingExecutionMode();
  assert.equal(config.agent.codingTools.executionMode, "bubblewrap");
  assert.throws(validateRuntimeSecurity, /bubblewrap executable does not exist/);
});

test("bubblewrap probe verifies execution, diagnostics, and missing binaries", () => {
  mutable.agent.codingTools.bubblewrapPath = fakeBubblewrap("ignored-bwrap", "exit 0");
  resetBubblewrapProbeCacheForTests();
  assert.match(bubblewrapProbeError() ?? "", /without running the isolated probe command/);

  const failureLog = path.join(tempDir, "failed-probe-count.log");
  mutable.agent.codingTools.bubblewrapPath = fakeBubblewrap(
    "failing-bwrap",
    `printf 'x' >> "${failureLog}"
printf "%s" "user namespaces denied" >&2
exit 17`,
  );
  resetBubblewrapProbeCacheForTests();
  assert.equal(bubblewrapProbeError(), "user namespaces denied");
  assert.equal(bubblewrapProbeError(), "user namespaces denied");
  assert.equal(fs.readFileSync(failureLog, "utf8"), "x", "failed probes should be cached too");

  mutable.agent.codingTools.bubblewrapPath = path.join(tempDir, "missing-bwrap");
  resetBubblewrapProbeCacheForTests();
  assert.match(bubblewrapProbeError() ?? "", /ENOENT|no such file/i);
});

test("bubblewrap probe follows the runtime network posture and caches that exact shape", () => {
  const invocationLog = path.join(tempDir, "bubblewrap-invocations.log");
  mutable.agent.codingTools.bubblewrapPath = fakeBubblewrap(
    "working-bwrap",
    `printf '%s\\n' "$*" >> "${invocationLog}"
workspace=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--bind' ]; then
    workspace="$2"
    shift 3
  else
    shift
  fi
done
[ -n "$workspace" ]
printf '%s' 'genosyn-bubblewrap-probe-v1' > "$workspace/.genosyn-bubblewrap-probe"`,
  );

  mutable.agent.codingTools.allowNetwork = false;
  resetBubblewrapProbeCacheForTests();
  assert.equal(bubblewrapProbeError(), null);
  assert.equal(bubblewrapProbeError(), null);
  let invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 1, "same probe shape should use the cached result");
  assert.match(invocations[0], /--unshare-net/);
  const boundRoot = invocations[0].match(/--bind ([^ ]+) \/workspace/)?.[1];
  assert.ok(boundRoot);
  assert.equal(fs.existsSync(boundRoot), false, "probe workspaces must be removed after use");

  mutable.agent.codingTools.allowNetwork = true;
  assert.equal(bubblewrapProbeError(), null);
  invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 2, "network-policy changes must invalidate the probe cache");
  assert.doesNotMatch(invocations[1], /--unshare-net/);
});

test("self-hosted explicit weak secrets fail instead of bypassing managed defaults", () => {
  mutable.security.multiTenant = false;
  mutable.sessionSecret = "explicit-but-short";
  mutable.security.encryptionSecret = "also-explicit-but-short";
  assert.throws(validateRuntimeSecurity, /Unsafe self-hosted secret configuration/);
});

test("unsafe shared hosting reports every actionable boundary at once", () => {
  mutable.security.multiTenant = true;
  mutable.security.secureCookies = false;
  mutable.security.bootstrapMasterAdminEmail = "";
  mutable.security.outboundPrivateHostAllowlist = ["localhost"];
  mutable.agent.browserEnabledInMultiTenant = true;
  mutable.agent.codingTools.allowNetwork = true;
  mutable.agent.codingTools.executionMode = "host";
  mutable.db.driver = "sqlite";
  mutable.db.postgresUrl = "";
  mutable.sessionSecret = "short";
  mutable.security.encryptionSecret = "short";

  assert.throws(validateRuntimeSecurity, (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const expected of [
      "config.db.driver must be postgres",
      "config.db.postgresUrl is required",
      "Secure session cookies must be enabled",
      "config.sessionSecret must be a unique secret",
      "config.security.encryptionSecret must be a unique secret",
      "the session and encryption secrets must be different",
      "config.agent.codingTools.executionMode must be bubblewrap",
      "network access inside the coding sandbox must be disabled",
      "the in-process browser must be disabled",
      "config.security.bootstrapMasterAdminEmail is required",
      "config.security.outboundPrivateHostAllowlist must be empty",
    ]) {
      assert.match(error.message, new RegExp(expected.replace(/[.]/g, "\\.")));
    }
    return true;
  });
});
