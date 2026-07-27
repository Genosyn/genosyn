import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A reusable Follow-up queue definition.
 *
 * Views are company-wide so Members and AI Employees work from the same
 * triage definitions. The creator is retained for provenance, but does not
 * make the view private.
 */
@Entity("revenue_follow_up_views")
@Index(["companyId", "sortOrder", "name"])
export class RevenueFollowUpView {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "text", default: "{}" })
  filtersJson!: string;

  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
