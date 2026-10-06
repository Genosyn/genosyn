import type {
  ResourceAccessLevel,
  ResourceLibraryAccessLevel,
  ResourceLibraryAccessRow,
} from "./api";

/**
 * Resources → AI access, the logic behind the page and the Share modal.
 *
 * The library level is a ceiling over each Resource's Share settings: read +
 * write (the default) leaves them in charge, read only caps every one of them
 * at View only without changing what they say. Kept pure so it can be tested
 * without a browser, and so the page and the modal cannot disagree about it.
 */

export type ResourceLibraryLevelMeta = {
  value: ResourceLibraryAccessLevel;
  label: string;
  tagline: string;
  hint: string;
};

/** Narrowest first, the order the page lays them out in. */
export const RESOURCE_LIBRARY_LEVELS: ResourceLibraryLevelMeta[] = [
  {
    value: "read",
    label: "Read only",
    tagline: "Study the library",
    hint: "List, search, read, and export every Resource shared with it. Files, edits, and deletes nothing — whatever a Resource's Share settings say.",
  },
  {
    value: "write",
    label: "Read + write",
    tagline: "Study and curate",
    hint: "Everything in Read only, plus file new Resources and edit or delete them as each Resource's Share settings allow. An employee keeps full control of what it files.",
  },
];

/** What an employee nobody has configured holds. */
export const DEFAULT_RESOURCE_LIBRARY_LEVEL: ResourceLibraryAccessLevel = "write";

export function resourceLibraryLevelLabel(level: ResourceLibraryAccessLevel): string {
  return RESOURCE_LIBRARY_LEVELS.find((meta) => meta.value === level)?.label ?? "Read only";
}

/**
 * The per-Resource level that applies once the ceiling is in place. Mirrors the
 * MCP seam on the server: under read only, nothing above View only survives.
 */
export function effectiveResourceAccess(
  library: ResourceLibraryAccessLevel,
  grant: ResourceAccessLevel,
): ResourceAccessLevel {
  return library === "write" ? grant : "read";
}

/**
 * True when a Share grant says more than the employee can currently do — an
 * edit or delete grant held by an employee set to read only. The grant is kept
 * and applies again once the employee is back at read + write. An unknown
 * library level (the list has not loaded) never reports a pause.
 */
export function isShareGrantPaused(
  library: ResourceLibraryAccessLevel | undefined,
  grant: ResourceAccessLevel,
): boolean {
  if (library === undefined) return false;
  return effectiveResourceAccess(library, grant) !== grant;
}

/** Employee id → library level, for looking employees up from the Share modal. */
export function resourceLibraryLevelsById(
  rows: ResourceLibraryAccessRow[],
): Map<string, ResourceLibraryAccessLevel> {
  return new Map(rows.map((row) => [row.employee.id, row.accessLevel]));
}

/**
 * The list with one employee moved to `level`, for an optimistic update. The
 * same array comes back when nothing would change, so a click on the level an
 * employee already holds re-renders nothing.
 */
export function withResourceLibraryAccess(
  rows: ResourceLibraryAccessRow[],
  employeeId: string,
  level: ResourceLibraryAccessLevel,
): ResourceLibraryAccessRow[] {
  const index = rows.findIndex((row) => row.employee.id === employeeId);
  if (index < 0 || rows[index].accessLevel === level) return rows;
  const next = [...rows];
  next[index] = { ...rows[index], accessLevel: level, isDefault: false };
  return next;
}

/** Put the server's copy of one row back into the list. Unknown rows are ignored. */
export function replaceResourceLibraryRow(
  rows: ResourceLibraryAccessRow[],
  row: ResourceLibraryAccessRow,
): ResourceLibraryAccessRow[] {
  const index = rows.findIndex((item) => item.employee.id === row.employee.id);
  if (index < 0) return rows;
  const next = [...rows];
  next[index] = row;
  return next;
}

/** The header count: how many of the roster are narrowed to read only. */
export function summarizeResourceLibraryAccess(rows: ResourceLibraryAccessRow[]): string {
  const readOnly = rows.filter((row) => row.accessLevel === "read").length;
  if (rows.length === 0) return "";
  if (readOnly === 0) return rows.length === 1 ? "Read + write" : `All ${rows.length} read + write`;
  return `${readOnly} of ${rows.length} read only`;
}
