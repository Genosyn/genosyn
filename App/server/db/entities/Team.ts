import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A Team groups AI Employees inside a Company. Think "Engineering",
 * "Revenue", "Ops". Soft-deletable via `archivedAt` so historical
 * Handoffs / Journal references still resolve.
 *
 * Membership is one-to-many today: an `AIEmployee` belongs to at most one
 * Team via `AIEmployee.teamId`. If we ever need cross-team employees we'll
 * add a join table; not worth the complexity for V1.
 */
@Entity("teams")
@Index(["companyId", "slug"], { unique: true })
export class Team {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
