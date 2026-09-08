import type { ModelEffort, WorkSessionModel } from "@/lib/api";

export const MODEL_EFFORT_LABELS: Record<ModelEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

export type WorkSessionModelOverride = { employeeId: string; modelId: string };

/** Reconcile an employee-scoped choice against the latest connected models. */
export function resolveWorkSessionModelId({
  employeeId,
  models,
  override,
}: {
  employeeId: string;
  models: WorkSessionModel[];
  override: WorkSessionModelOverride | null;
}): string | null {
  const connected = models.filter((model) => model.status === "connected");
  const overrideId = override?.employeeId === employeeId ? override.modelId : null;
  return (
    connected.find((model) => model.id === overrideId)?.id ??
    connected.find((model) => model.isActive)?.id ??
    connected[0]?.id ??
    null
  );
}
