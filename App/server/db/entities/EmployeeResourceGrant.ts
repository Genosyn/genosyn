import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Three escalating capabilities — humans toggle these from the share modal
 * to decide what an AI employee can do with a Resource through its MCP
 * tools:
 *   - `read`   → list / search / get only
 *   - `edit`   → read + create / update content (title, summary, tags, body)
 *   - `delete` → read + edit + permanent delete
 *
 * The order matters: `RESOURCE_ACCESS_RANK` below encodes it so a single
 * comparison in `hasResourceAccess` covers "needs at least edit" without a
 * cascade of equality checks.
 *
 * Resources use a richer vocabulary than notes (which stick to read/write)
 * because the team often wants AI employees that can keep a page tidy
 * (re-summarize, re-tag) without authority to remove the row entirely.
 */
export type ResourceAccessLevel = "read" | "edit" | "delete";

export const RESOURCE_ACCESS_LEVELS: ResourceAccessLevel[] = [
  "read",
  "edit",
  "delete",
];

export const RESOURCE_ACCESS_RANK: Record<ResourceAccessLevel, number> = {
  read: 0,
  edit: 1,
  delete: 2,
};

/**
 * Grants an AI employee access to a Resource. The level decides which MCP
 * tools succeed. Authors of `create_resource` auto-receive `delete` (full
 * control of their own row); teammates default to `read` and humans
 * promote them via the share modal.
 *
 * Humans (members) bypass this table entirely; it only governs the AI
 * surface.
 */
@Entity("employee_resource_grants")
@Index(["employeeId"])
@Index(["resourceId"])
@Index(["employeeId", "resourceId"], { unique: true })
export class EmployeeResourceGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  resourceId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: ResourceAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
