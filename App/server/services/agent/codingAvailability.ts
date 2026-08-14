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
      reason: "Command execution is disabled on this Genosyn installation.",
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
