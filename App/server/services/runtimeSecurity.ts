import { config } from "../../config.js";
import { getEffectiveGlobalSmtp } from "./globalEmailTransport.js";
import { getPublicUrl, isPublicUrlConfigured } from "./publicUrl.js";
import { getEffectiveInstanceSecrets, isStrongInstanceSecret } from "../lib/instanceSecrets.js";
import { noteRetiredExecutionMode } from "./agent/codingAvailability.js";

/**
 * Settle the coding execution mode once, before validation reads it and
 * before any tool registry, Run, or repository clone does.
 *
 * Bubblewrap isolation was removed. A configuration that still selects it — an
 * old config.ts, or a Kubernetes overlay rendered by an older chart — asked
 * for confined commands, so it gets no commands rather than host execution it
 * never chose. This can only ever narrow: host execution stays the operator's
 * explicit choice.
 */
export function resolveCodingExecutionMode(): void {
  const codingTools = config.agent.codingTools as { executionMode: string };
  const selected = codingTools.executionMode;
  if (selected === "host" || selected === "disabled") return;

  codingTools.executionMode = "disabled";
  noteRetiredExecutionMode(
    `the operator configuration selects the unsupported "${selected}" execution mode. Set config.agent.codingTools.executionMode to "host" to run commands.`,
  );
  // eslint-disable-next-line no-console
  console.warn(
    `[security] command execution is disabled: config.agent.codingTools.executionMode "${selected}" is not supported. Bubblewrap isolation was removed; set it to "host" to run commands on the host, or "disabled" to keep them off.`,
  );
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
  // There is no command sandbox. A shared install that let AI Employees run
  // commands would give one tenant's employee the App's authority over every
  // other tenant's data.
  if (config.agent.codingTools.enabled && config.agent.codingTools.executionMode !== "disabled") {
    problems.push('config.agent.codingTools.executionMode must be "disabled"');
  }
  if (config.agent.browserEnabledInMultiTenant) {
    problems.push("the in-process browser must be disabled");
  }
  // Member browsers are not validated here any more: the switch moved to an
  // operator-editable runtime setting, so a boot-time check could only be
  // stale. The invariant instead lives where the answer is derived —
  // `memberBrowsersEnabled()` in `services/memberBrowsers.ts` returns false in
  // multi-tenant mode no matter what the setting says. A tenant leaving a
  // bearer-authenticated channel into a personal computer standing against
  // shared infrastructure is a boundary that has to hold per call, not per boot.
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

/**
 * Validate database-backed dependencies after migrations have run.
 *
 * A shared multi-tenant install genuinely needs system SMTP: without it nobody
 * can verify an address or recover an account by email. This used to throw. It
 * no longer can — SMTP is configured at Admin → Email transport, and a fresh
 * shared install has no row and no admin yet, so refusing to boot would lock the
 * operator out of the only screen that fixes it. The chicken-and-egg is broken
 * the way the rest of bootstrap is: the server comes up, `services/email.ts`
 * prints the verification and reset links to the console, the predeclared
 * bootstrap master admin reads its link out of the pod log, signs in, and saves
 * a transport. The warning below is loud so nobody mistakes that for a working
 * deployment; Admin → Instance Health carries the same state as a warning card.
 */
export async function validateRuntimeDependencies(): Promise<void> {
  if (!config.security.multiTenant) return;
  const smtp = await getEffectiveGlobalSmtp();
  if (smtp.configured) return;
  // eslint-disable-next-line no-console
  console.warn(
    [
      "",
      "  ┌──────────────────────────────────────────────────────────────────┐",
      "  │  MULTI-TENANT INSTALL WITHOUT SYSTEM SMTP                        │",
      "  └──────────────────────────────────────────────────────────────────┘",
      "  No global SMTP transport is configured, so this install cannot send",
      "  email verification or password reset messages to anyone.",
      "",
      "  Until it is configured:",
      "    - every system email is skipped and its full body, including the",
      "      link, is printed to this log;",
      "    - the bootstrap master admin can copy its verification link from",
      "      here to claim the first account.",
      "",
      "  Fix it at Admin → Email transport as soon as you can sign in.",
      "",
    ].join("\n"),
  );
}
