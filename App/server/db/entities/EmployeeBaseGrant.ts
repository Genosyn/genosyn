import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Grants an AI employee access to one Base. Many-to-many between `AIEmployee`
 * and `Base`, enforced unique on the pair so a duplicate grant is a no-op
 * rather than a duplicate row.
 *
 * One grant = full read/write on every table in the base; we deliberately do
 * not do per-table or per-field scopes in MVP. Revoking is a row delete —
 * subsequent spawns of the employee won't see the base-access MCP tools.
 */
@Entity("employee_base_grants")
@Index(["employeeId"])
@Index(["baseId"])
@Index(["employeeId", "baseId"], { unique: true })
export class EmployeeBaseGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  baseId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
