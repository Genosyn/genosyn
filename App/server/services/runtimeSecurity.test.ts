import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { config } from "../../config.js";
import { secureSessionCookies, validateRuntimeSecurity } from "./runtimeSecurity.js";

type MutableConfig = {
  agent: {
    browserEnabledInMultiTenant: boolean;
    codingTools: {
      allowNetwork: boolean;
      allowUnsafeHostExecution: boolean;
      executionMode: "host" | "bubblewrap" | "disabled";
    };
    maxConcurrentRunsPerCompany: number;
  };
  db: {
    driver: "sqlite" | "postgres";
    postgresUrl: string;
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

beforeEach(() => {
  original = structuredClone(mutable);
});

afterEach(() => {
  mutable.agent.browserEnabledInMultiTenant = original.agent.browserEnabledInMultiTenant;
  mutable.agent.codingTools.allowNetwork = original.agent.codingTools.allowNetwork;
  mutable.agent.codingTools.allowUnsafeHostExecution =
    original.agent.codingTools.allowUnsafeHostExecution;
  mutable.agent.codingTools.executionMode = original.agent.codingTools.executionMode;
  mutable.agent.maxConcurrentRunsPerCompany = original.agent.maxConcurrentRunsPerCompany;
  mutable.db.driver = original.db.driver;
  mutable.db.postgresUrl = original.db.postgresUrl;
  mutable.security.bootstrapMasterAdminEmail = original.security.bootstrapMasterAdminEmail;
  mutable.security.encryptionSecret = original.security.encryptionSecret;
  mutable.security.multiTenant = original.security.multiTenant;
  mutable.security.outboundPrivateHostAllowlist = original.security.outboundPrivateHostAllowlist;
  mutable.security.secureCookies = original.security.secureCookies;
  mutable.security.sessionMaxAgeDays = original.security.sessionMaxAgeDays;
  mutable.security.trustedProxyHops = original.security.trustedProxyHops;
  mutable.sessionSecret = original.sessionSecret;
});

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
  assert.equal(config.agent.codingTools.executionMode, "disabled");
  assert.equal(config.agent.codingTools.allowUnsafeHostExecution, false);
  assert.equal(config.agent.codingTools.allowNetwork, false);
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
