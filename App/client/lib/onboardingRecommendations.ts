import type {
  Employee,
  OnboardingIntegrationConnection,
  OnboardingRoutineRecommendation,
} from "./api";

export const MAX_ONBOARDING_ROUTINE_SELECTION = 5;

export function defaultOnboardingRoutineIds(routines: OnboardingRoutineRecommendation[]): string[] {
  return routines
    .filter((routine) => routine.status === "suggested")
    .slice(0, MAX_ONBOARDING_ROUTINE_SELECTION)
    .map((routine) => routine.id);
}

export function healthyGrantedConnection(
  connections: OnboardingIntegrationConnection[],
): OnboardingIntegrationConnection | undefined {
  return connections.find((connection) => connection.status === "connected" && connection.granted);
}

export function healthyUngrantedConnection(
  connections: OnboardingIntegrationConnection[],
): OnboardingIntegrationConnection | undefined {
  return connections.find((connection) => connection.status === "connected" && !connection.granted);
}

/** Never redirect an explicit onboarding URL to a different AI Employee. */
export function selectOnboardingEmployee(
  employees: readonly Employee[],
  requestedId: string | null,
): Employee | null {
  if (requestedId) return employees.find((employee) => employee.id === requestedId) ?? null;
  return employees[0] ?? null;
}

/** Keep a Member's unsaved context while unrelated launch-plan data refreshes. */
export function refreshedContextDraft(args: {
  serverValue: string;
  currentDraft: string;
  dirty: boolean;
  reset: boolean;
}): string {
  return args.reset || !args.dirty ? args.serverValue : args.currentDraft;
}
