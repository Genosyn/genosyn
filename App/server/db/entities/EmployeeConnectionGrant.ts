import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Grants an AI employee access to one IntegrationConnection. Many-to-many
 * between `AIEmployee` and `IntegrationConnection`, enforced unique on the
 * pair so a duplicate grant is a no-op rather than a duplicate row.
 *
 * One grant = access to every tool the connection's provider exposes; we
 * deliberately do not do per-tool scopes in MVP (see ROADMAP). Revoking is
 * a row delete — subsequent spawns of the employee will not see the tools.
 */
@Entity("employee_connection_grants")
@Index(["employeeId"])
@Index(["connectionId"])
@Index(["employeeId", "connectionId"], { unique: true })
export class EmployeeConnectionGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  connectionId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
