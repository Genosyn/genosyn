import { config } from "../../config.js";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getEffectiveGlobalSmtp } from "./globalEmailTransport.js";
import {
  getPublicUrl,
  isPublicUrlConfigured,
} from "./publicUrl.js";

const PLACEHOLDERS = new Set(["change-me-in-production", "change-me-in-production-too"]);

function strongSecret(value: string): boolean {
  return value.length >= 32 && !PLACEHOLDERS.has(value);
}

function bubblewrapProbeError(): string | null {
  const result = spawnSync(
    config.agent.codingTools.bubblewrapPath,
    [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/usr",
      "/usr",
      "--",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (!result.error && result.status === 0) return null;
  return (result.stderr || result.error?.message || `exit status ${result.status}`).trim();
}

export function secureSessionCookies(): boolean {
  if (config.security.secureCookies !== "auto") {
    return config.security.secureCookies;
  }
  return config.security.multiTenant || getPublicUrl().startsWith("https://");
}

/**
 * Fail closed when an operator opts into shared multi-tenancy without the
 * boundaries Genosyn relies on. Self-hosted mode remains backwards-compatible,
 * but prints actionable warnings for weak production settings.
 */
export function validateRuntimeSecurity(): void {
  if (!Number.isInteger(config.security.trustedProxyHops) || config.security.trustedProxyHops < 0) {
    throw new Error("config.security.trustedProxyHops must be a non-negative integer");
  }
  if (config.agent.maxConcurrentRunsPerCompany < 1) {
    throw new Error("config.agent.maxConcurrentRunsPerCompany must be at least 1");
  }
  if (config.security.sessionMaxAgeDays < 1 || config.security.sessionMaxAgeDays > 30) {
    throw new Error("config.security.sessionMaxAgeDays must be between 1 and 30");
  }

  const problems: string[] = [];
  if (config.db.driver !== "postgres") problems.push("config.db.driver must be postgres");
  if (!config.db.postgresUrl.trim()) problems.push("config.db.postgresUrl is required");
  if (!secureSessionCookies()) problems.push("Secure session cookies must be enabled");
  if (!strongSecret(config.sessionSecret)) {
    problems.push("config.sessionSecret must be a unique secret of at least 32 characters");
  }
  if (!strongSecret(config.security.encryptionSecret)) {
    problems.push(
      "config.security.encryptionSecret must be a unique secret of at least 32 characters",
    );
  }
  if (String(config.security.encryptionSecret) === String(config.sessionSecret)) {
    problems.push("the session and encryption secrets must be different");
  }
  if (config.agent.codingTools.executionMode !== "bubblewrap") {
    problems.push("config.agent.codingTools.executionMode must be bubblewrap");
  }
  if (
    config.agent.codingTools.executionMode === "bubblewrap" &&
    !fs.existsSync(config.agent.codingTools.bubblewrapPath)
  ) {
    problems.push("the configured bubblewrap executable does not exist");
  } else if (
    config.security.multiTenant &&
    config.agent.codingTools.executionMode === "bubblewrap"
  ) {
    const probeError = bubblewrapProbeError();
    if (probeError) {
      problems.push(
        `bubblewrap cannot create the required namespaces (${probeError}); enable unprivileged user namespaces in the container runtime`,
      );
    }
  }
  if (config.agent.codingTools.allowNetwork) {
    problems.push("network access inside the coding sandbox must be disabled");
  }
  if (config.agent.browserEnabledInMultiTenant) {
    problems.push("the in-process browser must be disabled");
  }
  if (!config.security.bootstrapMasterAdminEmail.trim()) {
    problems.push("config.security.bootstrapMasterAdminEmail is required");
  }
  if (config.security.outboundPrivateHostAllowlist.length > 0) {
    problems.push("config.security.outboundPrivateHostAllowlist must be empty");
  }

  if (config.security.multiTenant && problems.length > 0) {
    throw new Error(`Unsafe multi-tenant configuration:\n- ${problems.join("\n- ")}`);
  }

  if (process.env.NODE_ENV === "production" && !config.security.multiTenant) {
    const warnings = problems.filter(
      (problem) =>
        problem.includes("secret") || problem.includes("https") || problem.includes("cookies"),
    );
    if (warnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[security] self-hosted production is using relaxed settings:\n- ${warnings.join("\n- ")}`,
      );
    }
  }

  if (process.env.NODE_ENV === "production" && !isPublicUrlConfigured()) {
    // The request-origin guard keeps login safe and the first successful
    // master-admin sign-in captures the browser origin automatically. Warn so
    // operators still know to review the persisted value in Admin → General.
    // eslint-disable-next-line no-console
    console.warn(
      `[security] public URL is not configured; using ${getPublicUrl()} until a master admin signs in`,
    );
  }
}

/** Validate database-backed dependencies after migrations have run. */
export async function validateRuntimeDependencies(): Promise<void> {
  if (!config.security.multiTenant) return;
  const smtp = await getEffectiveGlobalSmtp();
  if (!smtp.configured) {
    throw new Error(
      "Unsafe multi-tenant configuration: system SMTP is required for email verification and account recovery",
    );
  }
}
