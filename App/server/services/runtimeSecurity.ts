import { config } from "../../config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getEffectiveGlobalSmtp } from "./globalEmailTransport.js";
import { getPublicUrl, isPublicUrlConfigured } from "./publicUrl.js";
import { buildBubblewrapCommandArgs } from "./agent/bubblewrap.js";
import { getEffectiveInstanceSecrets, isStrongInstanceSecret } from "../lib/instanceSecrets.js";

const BUBBLEWRAP_PROBE_MARKER = ".genosyn-bubblewrap-probe";
const BUBBLEWRAP_PROBE_VALUE = "genosyn-bubblewrap-probe-v1";

let bubblewrapProbeCache: {
  path: string;
  unshareNetwork: boolean;
  error: string | null;
} | null = null;

export function bubblewrapProbeError(): string | null {
  const unshareNetwork = !config.agent.codingTools.allowNetwork;
  if (
    bubblewrapProbeCache?.path === config.agent.codingTools.bubblewrapPath &&
    bubblewrapProbeCache.unshareNetwork === unshareNetwork
  ) {
    return bubblewrapProbeCache.error;
  }
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-bwrap-probe-"));
  const markerPath = path.join(probeRoot, BUBBLEWRAP_PROBE_MARKER);
  try {
    const result = spawnSync(
      config.agent.codingTools.bubblewrapPath,
      buildBubblewrapCommandArgs({
        workspaceRoot: probeRoot,
        cwd: probeRoot,
        executable: "/bin/sh",
        args: [
          "-c",
          `printf '%s' '${BUBBLEWRAP_PROBE_VALUE}' > /workspace/${BUBBLEWRAP_PROBE_MARKER}`,
        ],
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/workspace",
          LANG: "C.UTF-8",
        },
        unshareNetwork,
      }),
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    let error: string | null;
    if (result.error || result.status !== 0) {
      error = (result.stderr || result.error?.message || `exit status ${result.status}`).trim();
    } else if (
      !fs.existsSync(markerPath) ||
      fs.readFileSync(markerPath, "utf8") !== BUBBLEWRAP_PROBE_VALUE
    ) {
      error = "bubblewrap exited without running the isolated probe command";
    } else {
      error = null;
    }
    bubblewrapProbeCache = {
      path: config.agent.codingTools.bubblewrapPath,
      unshareNetwork,
      error,
    };
    return error;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

/** Test-only seam for deterministic fake-executable probe coverage. */
export function resetBubblewrapProbeCacheForTests(): void {
  bubblewrapProbeCache = null;
}

export function secureSessionCookies(): boolean {
  if (config.security.secureCookies !== "auto") {
    return config.security.secureCookies;
  }
  return config.security.multiTenant || getPublicUrl().startsWith("https://");
}

/**
 * Fail closed when an operator opts into shared multi-tenancy without the
 * boundaries Genosyn relies on. Self-hosted placeholders resolve to managed
 * per-install secrets; an explicitly configured weak secret fails closed.
 * Other relaxed self-host settings still produce actionable warnings.
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
  const effectiveSecrets = config.security.multiTenant ? null : getEffectiveInstanceSecrets();
  const sessionSecret = config.security.multiTenant
    ? String(config.sessionSecret)
    : effectiveSecrets!.sessionSecret;
  const encryptionSecret = config.security.multiTenant
    ? String(config.security.encryptionSecret)
    : effectiveSecrets!.encryptionSecret;
  const secretProblems: string[] = [];
  if (config.db.driver !== "postgres") problems.push("config.db.driver must be postgres");
  if (!config.db.postgresUrl.trim()) problems.push("config.db.postgresUrl is required");
  if (!secureSessionCookies()) problems.push("Secure session cookies must be enabled");
  if (!isStrongInstanceSecret(sessionSecret)) {
    secretProblems.push("config.sessionSecret must be a unique secret of at least 32 characters");
  }
  if (!isStrongInstanceSecret(encryptionSecret)) {
    secretProblems.push(
      "config.security.encryptionSecret must be a unique secret of at least 32 characters",
    );
  }
  if (encryptionSecret === sessionSecret) {
    secretProblems.push("the session and encryption secrets must be different");
  }
  problems.push(...secretProblems);
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

  if (!config.security.multiTenant && secretProblems.length > 0) {
    throw new Error(`Unsafe self-hosted secret configuration:\n- ${secretProblems.join("\n- ")}`);
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
    if (
      config.agent.codingTools.executionMode === "host" &&
      config.agent.codingTools.allowUnsafeHostExecution
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "[security] AI coding tools have explicit unsafe host execution access; use Bubblewrap or disable coding tools before adding untrusted Members or another company",
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
