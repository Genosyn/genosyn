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
