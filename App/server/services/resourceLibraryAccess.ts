import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  DEFAULT_RESOURCE_LIBRARY_ACCESS,
  EmployeeResourceLibraryGrant,
  RESOURCE_LIBRARY_ACCESS_LEVELS,
  RESOURCE_LIBRARY_ACCESS_RANK,
  type ResourceLibraryAccessLevel,
} from "../db/entities/EmployeeResourceLibraryGrant.js";

/**
 * Resources → AI access: which AI Employees may write to the Resources library.
 *
 * Every employee reads and writes Resources by default; an owner or admin can
 * narrow one to read only. The level is a ceiling over the per-Resource Grants
 * in `EmployeeResourceGrant` (the Share settings on each Resource) — see the
 * entity for why it never deletes or rewrites them.
 *
 * Enforcement lives at the MCP seam (`routes/mcpInternal.ts`), which calls
 * {@link getResourceLibraryAccess} before every write tool in
 * {@link RESOURCE_WRITE_TOOLS}. The same answer feeds `grantDead.ts`, so
 * `find_tools` marks those tools dead for a read-only employee, and
 * {@link composeResourceLibraryContext}, so its prompt says so before it tries.
 */

/**
 * Every MCP tool that writes to the library. A read-only employee is refused
 * each one; the read tools (`list_resources`, `search_resources`,
 * `get_resource`, `export_resource`) answer only to per-Resource Grants and are
 * never affected by this setting.
 */
export const RESOURCE_WRITE_TOOLS = [
  "create_resource",
  "update_resource",
  "delete_resource",
] as const;

/**
 * The 403 a read-only employee gets from a write tool. It names the setting and
 * where it lives, because the per-Resource remedy ("ask a human to promote you
 * in the share modal") cannot help here and the model would otherwise ask for
 * exactly that.
 */
export const RESOURCE_READ_ONLY_ERROR =
  'No grant: this needs "write" access to Resources; yours is "read" (read only), so you cannot create, edit, or delete Resources. You can still list, search, read, and export the Resources shared with you. Ask an owner or admin to change it under Resources → AI access, or ask a Member to make this change.';

export class ResourceLibraryAccessNotFoundError extends Error {}

/**
 * The level a stored value grants.
 *
 * No row means the default (`write`). A value this build does not recognize
 * fails closed to `read`: a newer level left behind by a rollback must never
 * widen what an employee can do. Compared by membership rather than by indexing
 * the rank map, so a value like `"toString"` cannot resolve to something truthy.
 */
export function effectiveResourceLibraryAccess(
  stored: string | null | undefined,
): ResourceLibraryAccessLevel {
  if (stored === null || stored === undefined) return DEFAULT_RESOURCE_LIBRARY_ACCESS;
  return (RESOURCE_LIBRARY_ACCESS_LEVELS as string[]).includes(stored)
    ? (stored as ResourceLibraryAccessLevel)
    : "read";
}

/** True when this level lets an employee create, edit, or delete Resources at all. */
export function canWriteResourceLibrary(level: ResourceLibraryAccessLevel): boolean {
  return RESOURCE_LIBRARY_ACCESS_RANK[level] >= RESOURCE_LIBRARY_ACCESS_RANK.write;
}

/** One employee's effective library level. Keyed by employee alone — the row is unique on it. */
export async function getResourceLibraryAccess(
  employeeId: string,
): Promise<ResourceLibraryAccessLevel> {
  const row = await AppDataSource.getRepository(EmployeeResourceLibraryGrant).findOneBy({
    employeeId,
  });
  return effectiveResourceLibraryAccess(row?.accessLevel);
}

export type ResourceLibraryAccessChange = {
  employee: AIEmployee;
  /** The effective level before the call. */
  previous: ResourceLibraryAccessLevel;
  accessLevel: ResourceLibraryAccessLevel;
  /** False when nothing was written — the caller audits only real changes. */
  changed: boolean;
};

/**
 * Set one employee's library level.
 *
 * Idempotent. Asking for the level an employee already holds writes nothing,
 * and that includes asking for `write` on an employee with no row: absence
 * already means `write`, so a second representation of the default would only
 * be noise. Any other request upserts the row, which also replaces a stored
 * value this build does not recognize.
 *
 * Throws {@link ResourceLibraryAccessNotFoundError} when the employee is not in
 * this company — an employee of another company is answered exactly like an
 * id that does not exist.
 */
export async function setResourceLibraryAccess(
  companyId: string,
  employeeId: string,
  accessLevel: ResourceLibraryAccessLevel,
): Promise<ResourceLibraryAccessChange> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new ResourceLibraryAccessNotFoundError("AI Employee not found");

  const repo = AppDataSource.getRepository(EmployeeResourceLibraryGrant);
  const row = await repo.findOneBy({ employeeId: employee.id });
  const previous = effectiveResourceLibraryAccess(row?.accessLevel);
  const stored = row ? row.accessLevel : DEFAULT_RESOURCE_LIBRARY_ACCESS;
  if (stored === accessLevel) return { employee, previous, accessLevel, changed: false };

  if (row) {
    row.accessLevel = accessLevel;
    // Keep the denormalized companyId honest, as the Finance grant does.
    row.companyId = companyId;
    await repo.save(row);
  } else {
    await repo.save(repo.create({ companyId, employeeId: employee.id, accessLevel }));
  }
  return { employee, previous, accessLevel, changed: true };
}

export type ResourceLibraryAccessRow = {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  };
  accessLevel: ResourceLibraryAccessLevel;
  /** True when nobody has set this employee's access, so the default applies. */
  isDefault: boolean;
};

function toRow(employee: AIEmployee, stored: string | undefined): ResourceLibraryAccessRow {
  return {
    employee: {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      avatarKey: employee.avatarKey ?? null,
    },
    accessLevel: effectiveResourceLibraryAccess(stored),
    isDefault: stored === undefined,
  };
}

/**
 * Every AI Employee in the company, alphabetical, with its effective level. An
 * employee nobody has touched is listed at the default — the page shows the
 * whole roster, not only the exceptions.
 *
 * The stored rows are matched through a subquery over the company's employees
 * rather than by the row's own `companyId`, so the list can never disagree with
 * the MCP gate, which keys by employee alone. A subquery rather than an
 * expanded `IN (:...ids)` keeps a large roster clear of SQLite's bound-parameter
 * ceiling, and the `CAST` is for Postgres, where `ai_employees.id` is a uuid
 * and `employeeId` a varchar. Both queries read at most one row per employee.
 */
export async function listResourceLibraryAccess(
  companyId: string,
): Promise<ResourceLibraryAccessRow[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    order: { name: "ASC" },
  });
  if (employees.length === 0) return [];
  const stored = await AppDataSource.getRepository(EmployeeResourceLibraryGrant)
    .createQueryBuilder("l")
    .where((qb) => {
      const ids = qb
        .subQuery()
        .select("CAST(e.id AS text)")
        .from(AIEmployee, "e")
        .where("e.companyId = :companyId")
        .getQuery();
      return `l.employeeId IN ${ids}`;
    })
    .setParameter("companyId", companyId)
    .getMany();
  const levelByEmployee = new Map(stored.map((row) => [row.employeeId, row.accessLevel]));
  return employees.map((employee) => toRow(employee, levelByEmployee.get(employee.id)));
}

/** One employee's row, in the shape the list returns; null when it is not in this company. */
export async function getResourceLibraryAccessRow(
  companyId: string,
  employeeId: string,
): Promise<ResourceLibraryAccessRow | null> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return null;
  const stored = await AppDataSource.getRepository(EmployeeResourceLibraryGrant).findOneBy({
    employeeId: employee.id,
  });
  return toRow(employee, stored?.accessLevel);
}

/**
 * The prompt block for a read-only employee, or "" for everyone else.
 *
 * Read + write is what every employee had before this setting existed, so it
 * adds nothing to the prompt: there is no new capability to explain, and a
 * block for the common case would be paid on every turn of every employee. The
 * restriction is the news. Without it the model meets the 403 only after it
 * has done the work of preparing a Resource, and then tries again.
 */
export async function composeResourceLibraryContext(employeeId: string): Promise<string> {
  const level = await getResourceLibraryAccess(employeeId);
  if (canWriteResourceLibrary(level)) return "";
  return [
    "",
    "## Resources",
    "An owner or admin has set your access to the company's Resources library to **read only** (Resources → AI access). Reading is unaffected: you can still list, search, read, and export the Resources shared with you, and use them wherever your other Grants allow — attaching one to an email, for example.",
    "You cannot file, edit, or delete Resources: `create_resource`, `update_resource`, and `delete_resource` are refused whatever a Resource's own Share settings say. When work calls for one of them, say so plainly and leave that change to a Member instead of retrying.",
  ].join("\n");
}
