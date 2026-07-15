// Cron helpers for Routines.
//
// Not to be confused with `lib/schedule.ts`, which is the recurring-invoice
// picker: it round-trips a small set of canonical shapes it emits itself and
// silently falls back to a monthly default on anything else. Routines accept
// any expression `node-cron` validates — ranges, steps, six-field
// second-granularity — so they need a real cron parser, not that model.

import cronstrue from "cronstrue";

/**
 * Plain-English rendering of a cron expression, e.g. "At 09:00 AM, Monday
 * through Friday". Falls back to the raw expression when cronstrue can't
 * parse it, so the field always shows the user *something* they typed rather
 * than an error.
 */
export function cronHuman(expr: string): string {
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}

/**
 * Whether cronstrue understands an expression. The server validates with
 * `node-cron` on save; this is only for live feedback while typing.
 */
export function cronIsReadable(expr: string): boolean {
  try {
    cronstrue.toString(expr);
    return true;
  } catch {
    return false;
  }
}

/** One-click schedules for the new-routine form. */
export const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every weekday 9am", expr: "0 9 * * 1-5" },
  { label: "Every Monday 9am", expr: "0 9 * * 1" },
  { label: "Every day 8am", expr: "0 8 * * *" },
];

/** The schedule a fresh routine starts on. */
export const DEFAULT_CRON = "0 9 * * 1-5";
