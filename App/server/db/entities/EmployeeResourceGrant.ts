import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { NoteAccessLevel } from "./EmployeeNoteGrant.js";

/**
 * Grants an AI employee access to a Resource. Reuses the
 * `NoteAccessLevel` (`read` | `write`) vocabulary so the share UI is
 * symmetric with notes. `write` gates the MCP `update_resource` /
 * `delete_resource` tools; `create_resource` auto-grants `write` to the
 * author so it can keep curating its own page without a human round-trip.
 *
 * Humans (members) bypass this table; it only governs what AI employees
 * see and can edit through their MCP surface.
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
  accessLevel!: NoteAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
