// The thin `cronstrue` wrapper: is this expression readable, and what does it
// say? Nothing here knows about schedules people can build.
//
// `lib/scheduleBuilder.ts` is what the UI actually asks. This module is what
// it falls back to for the expressions its controls cannot draw — hand-written
// ones from the custom-expression escape hatch, and the ones AI Employees
// write through the MCP tools. Routines accept any expression `node-cron`
// validates, including six-field second granularity, so a fallback that can
// read all of them has to exist.

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

/**
 * The schedule a fresh routine starts on. Left as a range rather than the
 * comma list `scheduleToCron` emits so it reads as one idea in the seed data
 * and in the MCP tool docs; the picker parses both.
 */
export const DEFAULT_CRON = "0 9 * * 1-5";

/**
 * What a fresh Revenue Signal starts on. Hourly, because a Signal is a query
 * looking for accounts that just crossed a line and a daily sweep would find
 * them a day late. Lives here rather than on the Signals page so the same
 * test that proves every shipped schedule opens in the picker can see it.
 */
export const DEFAULT_SIGNAL_CRON = "0 * * * *";
