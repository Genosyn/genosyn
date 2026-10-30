/**
 * Portable thinking levels; each AI Model exposes only the levels it supports.
 * The product calls one a **thinking level** — how hard the AI Model thinks
 * before it answers — and `none` reads as "Off". The values stay the wire
 * names the runtimes take (`reasoning.effort`, `output_config.effort`, Codex's
 * `effort`), so code keeps calling the field `effort`.
 */
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

/** How each level reads in the product, wherever a Member picks or sees one. */
export const MODEL_EFFORT_LABELS: Record<ModelEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
