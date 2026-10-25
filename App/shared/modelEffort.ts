/** Portable effort values; each AI Model exposes only the levels it supports. */
export const MODEL_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ModelEffort = (typeof MODEL_EFFORT_VALUES)[number];

/** How each effort reads in the product, wherever a Member picks or sees one. */
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
