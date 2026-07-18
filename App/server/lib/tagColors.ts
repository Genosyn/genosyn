import { randomInt } from "node:crypto";

/** Curated tag colors shared by API validation and server-side defaults. */
export const TAG_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export function randomTagColor(): TagColor {
  return TAG_COLORS[randomInt(TAG_COLORS.length)];
}
