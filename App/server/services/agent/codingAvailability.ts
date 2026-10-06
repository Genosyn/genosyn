import { config } from "../../../config.js";

export type CodingExecutionMode = "host" | "disabled";

export type CodingRuntimeSettings = {
  enabled: boolean;
  executionMode: CodingExecutionMode;
  allowUnsafeHostExecution: boolean;
};

export type CodingRuntimeAvailability =
  | { available: true; reason: null }
  | { available: false; reason: string };

let retiredModeReason: string | null = null;

/**
 * Why boot disabled command execution on its own, if it did: the operator
 * configuration still selects an execution mode this build no longer has. A
 * Member reading the Repository page should see the actual cause.
 */
export function noteRetiredExecutionMode(reason: string | null): void {
  retiredModeReason = reason;
}

/**
 * One fail-closed availability decision for every coding execution seam.
 *
 * Host execution is enabled in the shipped configuration. Existing operators
 * can retain their explicit opt-out with allowUnsafeHostExecution=false.
 * Repository commands, Checks, and coding tools share this decision.
 */
export function codingRuntimeAvailability(
  settings: CodingRuntimeSettings = config.agent.codingTools,
): CodingRuntimeAvailability {
  if (!settings.enabled || settings.executionMode !== "host") {
    return {
      available: false,
      reason: retiredModeReason
        ? `Command execution is disabled: ${retiredModeReason}`
        : "Command execution is disabled on this Genosyn installation.",
    };
  }
  if (!settings.allowUnsafeHostExecution) {
    return {
      available: false,
      reason:
        "Host command execution is disabled. Set allowUnsafeHostExecution to true in the operator configuration to allow it.",
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
