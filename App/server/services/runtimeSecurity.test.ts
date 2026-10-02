import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { config } from "../../config.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { codingRuntimeAvailability, noteRetiredExecutionMode } from "./agent/codingAvailability.js";
import { resetGlobalSmtpCacheForTests, updateGlobalSmtpOverride } from "./globalEmailTransport.js";
import {
  resolveCodingExecutionMode,
  secureSessionCookies,
  validateRuntimeDependencies,
  validateRuntimeSecurity,
} from "./runtimeSecurity.js";

type MutableConfig = {
  dataDir: string;
  agent: {
    browserEnabledInMultiTenant: boolean;
    codingTools: {
      allowUnsafeHostExecution: boolean;
      // Wider than the config type on purpose: an old config.ts or chart
      // overlay can still carry a mode this build no longer has.
      executionMode: string;
    };
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
  mutable.agent.codingTools.allowUnsafeHostExecution =
    original.agent.codingTools.allowUnsafeHostExecution;
  mutable.agent.codingTools.executionMode = original.agent.codingTools.executionMode;
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
  noteRetiredExecutionMode(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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

/** Every shared-hosting requirement except the one a test is about. */
function validSharedHosting(): void {
  mutable.security.multiTenant = true;
  mutable.security.secureCookies = true;
  mutable.security.bootstrapMasterAdminEmail = "ops@example.com";
  mutable.security.outboundPrivateHostAllowlist = [];
  mutable.agent.browserEnabledInMultiTenant = false;
  mutable.db.driver = "postgres";
  mutable.db.postgresUrl = "postgresql://genosyn:secret@db.example.com:5432/genosyn";
  mutable.sessionSecret = "s".repeat(24) + "-shared-session-secret";
  mutable.security.encryptionSecret = "e".repeat(24) + "-shared-encryption-secret";
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
  mutable.security.sessionMaxAgeDays = 31;
  assert.throws(validateRuntimeSecurity, /sessionMaxAgeDays must be between 1 and 30/);
});

test("self-hosted defaults remain bootable", () => {
  mutable.security.multiTenant = false;
  assert.doesNotThrow(validateRuntimeSecurity);
  assert.equal(config.agent.codingTools.executionMode, "host");
  assert.equal(config.agent.codingTools.allowUnsafeHostExecution, true);
});

test("host and disabled are settled modes that resolve silently", () => {
  for (const mode of ["host", "disabled"]) {
    mutable.agent.codingTools.executionMode = mode;
    const warnings = captureWarnings(resolveCodingExecutionMode);
    assert.equal(config.agent.codingTools.executionMode, mode);
    assert.deepEqual(warnings, []);
  }
});

test("a configuration that still selects bubblewrap boots with commands disabled", () => {
  mutable.security.multiTenant = false;
  mutable.agent.codingTools.executionMode = "bubblewrap";

  const warnings = captureWarnings(resolveCodingExecutionMode);
  assert.equal(config.agent.codingTools.executionMode, "disabled");
  assert.match(warnings.join("\n"), /"bubblewrap" is not supported/);
  assert.match(warnings.join("\n"), /set it to "host"/);
  assert.doesNotThrow(validateRuntimeSecurity);

  // A Member reading the Repository page sees why, not a bare policy line.
  const availability = codingRuntimeAvailability();
  assert.equal(availability.available, false);
  if (availability.available) assert.fail("expected command execution to stay off");
  assert.match(availability.reason, /unsupported "bubblewrap" execution mode/);
});

test("a retired mode never widens to host execution", () => {
  // The operator asked for confined commands. Host execution is a separate,
  // explicit choice the narrowing must not make on their behalf.
  mutable.agent.codingTools.executionMode = "bubblewrap";
  mutable.agent.codingTools.allowUnsafeHostExecution = true;
  captureWarnings(resolveCodingExecutionMode);
  assert.notEqual(config.agent.codingTools.executionMode, "host");
  assert.equal(codingRuntimeAvailability().available, false);
});

test("shared hosting refuses command execution, since nothing confines it", () => {
  validSharedHosting();
  mutable.agent.codingTools.executionMode = "host";
  assert.throws(validateRuntimeSecurity, /executionMode must be "disabled"/);

  mutable.agent.codingTools.executionMode = "disabled";
  assert.doesNotThrow(validateRuntimeSecurity);

  // A shared install whose old config still says bubblewrap is narrowed to
  // disabled before validation, so it boots with commands off.
  mutable.agent.codingTools.executionMode = "bubblewrap";
  captureWarnings(resolveCodingExecutionMode);
  assert.doesNotThrow(validateRuntimeSecurity);
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
      'config.agent.codingTools.executionMode must be "disabled"',
      "the in-process browser must be disabled",
      "config.security.bootstrapMasterAdminEmail is required",
      "config.security.outboundPrivateHostAllowlist must be empty",
    ]) {
      assert.match(error.message, new RegExp(expected.replace(/[.]/g, "\\.")));
    }
    return true;
  });
});

/**
 * A fresh multi-tenant install has no SMTP row and no admin yet. It used to
 * refuse to boot, which locked the operator out of the only screen that could
 * fix it. It now warns, loudly, and comes up.
 */
test("multi-tenant boots without SMTP and warns instead of throwing", async () => {
  await initTestDb();
  await resetTestDb();
  resetGlobalSmtpCacheForTests();
  mutable.security.multiTenant = true;

  const warnings: string[] = [];
  const originalWarn = console.warn;
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await validateRuntimeDependencies();
  } finally {
    // eslint-disable-next-line no-console
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MULTI-TENANT INSTALL WITHOUT SYSTEM SMTP/);
  // Actionable: it says where to fix it and what happens until then.
  assert.match(warnings[0], /Admin → Email transport/);
  assert.match(warnings[0], /printed to this log/);
});

test("a configured transport boots multi-tenant silently", async () => {
  await initTestDb();
  await resetTestDb();
  resetGlobalSmtpCacheForTests();
  mutable.security.multiTenant = true;
  await updateGlobalSmtpOverride({
    host: "smtp.acme.test",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    from: "no-reply@acme.test",
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await validateRuntimeDependencies();
  } finally {
    // eslint-disable-next-line no-console
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
  await closeTestDb();
});
