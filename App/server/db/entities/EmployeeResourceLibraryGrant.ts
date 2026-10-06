import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * An AI Employee's access to the whole Resources library, set by owners and
 * admins at **Resources → AI access**:
 *
 *   - `write` → read + write: the employee may file new Resources and edit or
 *               delete the ones its per-Resource Grants allow (the Share
 *               settings on each Resource). This is what every employee had
 *               before the setting existed, and it is still the default.
 *   - `read`  → read only: the employee may list, search, read, and export the
 *               Resources shared with it, and nothing else. `create_resource`,
 *               `update_resource`, and `delete_resource` are refused whatever a
 *               Resource's own Share settings say.
 *
 * ## A ceiling, not a second grant
 *
 * `EmployeeResourceGrant` (one row per employee *and* Resource) still decides
 * what the employee may do with each Resource. This row caps it: an employee set
 * to `read` keeps every per-Resource Grant it holds, but an `edit` or `delete`
 * Grant is held in abeyance until the library is set back to `write`. Nothing is
 * deleted when the setting moves, so switching back restores exactly what the
 * Share settings said before.
 *
 * ## Absence means the default
 *
 * Unlike the Finance / Revenue / Signing grants — where no row means no access,
 * because those surfaces are opt-in — Resources were always readable and
 * writable by AI Employees, and the setting exists to *narrow* that. So an
 * employee with no row holds {@link DEFAULT_RESOURCE_LIBRARY_ACCESS} (`write`):
 * existing installs keep working on upgrade and a new hire needs no row. A
 * stored value that is not a known level fails closed to `read`.
 *
 * One row per employee, like the other company-wide AI-access grants. Humans
 * (Members) bypass this table entirely; it only governs the AI surface.
 */
export type ResourceLibraryAccessLevel = "read" | "write";

export const RESOURCE_LIBRARY_ACCESS_LEVELS: ResourceLibraryAccessLevel[] = ["read", "write"];

export const RESOURCE_LIBRARY_ACCESS_RANK: Record<ResourceLibraryAccessLevel, number> = {
  read: 0,
  write: 1,
};

/** What an employee without a row holds. */
export const DEFAULT_RESOURCE_LIBRARY_ACCESS: ResourceLibraryAccessLevel = "write";

@Entity("employee_resource_library_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeResourceLibraryGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: DEFAULT_RESOURCE_LIBRARY_ACCESS })
  accessLevel!: ResourceLibraryAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
