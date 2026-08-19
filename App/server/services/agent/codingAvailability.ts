import { config } from "../../../config.js";

export type CodingExecutionMode = "host" | "bubblewrap" | "disabled";

export type CodingRuntimeSettings = {
  enabled: boolean;
  executionMode: CodingExecutionMode;
  allowUnsafeHostExecution: boolean;
};

export type CodingRuntimeAvailability =
  | { available: true; reason: null }
  | { available: false; reason: string };

let sandboxFallbackReason: string | null = null;

/**
 * Why boot dropped the shipped `bubblewrap` default, if it did. Command
 * execution is on out of the box, so "disabled" is usually something the host
 * decided rather than the operator — and a Member reading the Repository page
 * deserves the actual cause, not a flat statement of policy. Set once by
 * {@link resolveCodingExecutionMode}; an operator who chose `disabled`
 * themselves leaves it null and keeps the plain message.
 */
export function noteCodingSandboxFallback(reason: string | null): void {
  sandboxFallbackReason = reason;
}

/**
 * The one thing the person reading this can do about it.
 *
 * A cause with no remedy attached is where this message used to stop, and the
 * most common cause by far is one an operator would never guess: a container
 * gets no user namespaces and no private `/proc` under a stock Docker profile,
 * so the sandbox cannot start no matter how the host kernel is configured.
 * Name the two options and the command that applies them.
 */
export function codingSandboxRemediation(reason: string): string {
  if (reason.startsWith("no bubblewrap executable")) {
    return "Install bubblewrap on the host (Debian/Ubuntu: `apt-get install bubblewrap`), or run the standard Docker image, which ships it.";
  }
  return "Under Docker, the container has to be created with `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` — `genosyn upgrade` recreates it that way. On a bare Linux host, allow unprivileged user namespaces.";
}

/**
 * One fail-closed availability decision for every coding execution seam.
 *
 * Host mode is deliberately a two-part opt-in: selecting `host` alone does
 * not authorize a child process with the App user's filesystem and network
 * access. Callers must not duplicate this policy, because repository Git and
 * the shell need to agree about whether host execution is allowed.
 */
export function codingRuntimeAvailability(
  settings: CodingRuntimeSettings = config.agent.codingTools,
): CodingRuntimeAvailability {
  if (!settings.enabled || settings.executionMode === "disabled") {
    return {
      available: false,
      reason: sandboxFallbackReason
        ? `Command execution is disabled: the coding sandbox could not start (${sandboxFallbackReason}). Genosyn runs commands only behind bubblewrap, which needs Linux unprivileged user namespaces. ${codingSandboxRemediation(sandboxFallbackReason)}`
        : "Command execution is disabled on this Genosyn installation.",
    };
  }
  if (settings.executionMode === "host" && !settings.allowUnsafeHostExecution) {
    return {
      available: false,
      reason:
        "Unsafe host command execution is disabled. Use Bubblewrap isolation or explicitly acknowledge host execution in the operator configuration.",
    };
  }
  return { available: true, reason: null };
}

export function requireCodingRuntime(
  settings: CodingRuntimeSettings = config.agent.codingTools,
): void {
  const availability = codingRuntimeAvailability(settings);
  if (!availability.available) throw new Error(availability.reason);
}
