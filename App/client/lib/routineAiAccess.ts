import type { RoutineAccessLevel, RoutineAccessRow } from "./api";

/**
 * Routines → AI access, the logic behind the page.
 *
 * Every AI Employee reads Routines and Runs, and its Routines keep running,
 * whichever level it holds. The level decides only whether it may change
 * Routines through its tools: read + write (the default) may, read + run may
 * not — and no AI Employee may change a read + run employee's Routines. Kept
 * pure so it can be tested without a browser.
 */

export type RoutineAccessLevelMeta = {
  value: RoutineAccessLevel;
  label: string;
  tagline: string;
  hint: string;
};

/** Narrowest first, the order the page lays them out in. */
export const ROUTINE_ACCESS_LEVELS: RoutineAccessLevelMeta[] = [
  {
    value: "run",
    label: "Read + run",
    tagline: "Run Routines as written",
    hint: "Reads every Routine and its Runs, and its own Routines keep running on their schedules and Triggers. Creates, edits, pauses, re-files, and deletes nothing — and no AI employee can change its Routines for it. It can still suggest a brief change for a human to apply.",
  },
  {
    value: "write",
    label: "Read + write",
    tagline: "Run and maintain Routines",
    hint: "Everything in Read + run, plus create, edit, re-schedule, pause, re-file, and delete Routines — its own, and those of teammates who also hold Read + write.",
  },
];

/** What an employee nobody has configured holds. */
export const DEFAULT_ROUTINE_ACCESS_LEVEL: RoutineAccessLevel = "write";

/** The label for a level. Anything unrecognized reads as the narrower one, as the server treats it. */
export function routineAccessLevelLabel(level: RoutineAccessLevel): string {
  return ROUTINE_ACCESS_LEVELS.find((meta) => meta.value === level)?.label ?? "Read + run";
}

/** Whether a viewer may change levels. Only owners and admins; anyone else sees the page read-only. */
export function canManageRoutineAccess(role: "owner" | "admin" | "member" | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The list with one employee moved to `level`, for an optimistic update. The
 * same array comes back when nothing would change, so a click on the level an
 * employee already holds re-renders nothing.
 */
export function withRoutineAccess(
  rows: RoutineAccessRow[],
  employeeId: string,
  level: RoutineAccessLevel,
): RoutineAccessRow[] {
  const index = rows.findIndex((row) => row.employee.id === employeeId);
  if (index < 0 || rows[index].accessLevel === level) return rows;
  const next = [...rows];
  next[index] = { ...rows[index], accessLevel: level, isDefault: false };
  return next;
}

/** Put the server's copy of one row back into the list. Unknown rows are ignored. */
export function replaceRoutineAccessRow(
  rows: RoutineAccessRow[],
  row: RoutineAccessRow,
): RoutineAccessRow[] {
  const index = rows.findIndex((item) => item.employee.id === row.employee.id);
  if (index < 0) return rows;
  const next = [...rows];
  next[index] = row;
  return next;
}

/** The header count: how many of the roster are held at read + run. */
export function summarizeRoutineAccess(rows: RoutineAccessRow[]): string {
  const runOnly = rows.filter((row) => row.accessLevel === "run").length;
  if (rows.length === 0) return "";
  if (runOnly === 0) return rows.length === 1 ? "Read + write" : `All ${rows.length} read + write`;
  return `${runOnly} of ${rows.length} read + run`;
}
