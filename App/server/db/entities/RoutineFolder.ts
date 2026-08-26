import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A company-scoped folder for filing {@link Routine} rows. Folders nest, and a
 * routine lives in at most one of them (`Routine.folderId`; null = unfiled).
 *
 * Tags (M27) already group routines *across* axes — one routine can be
 * "finance" and "weekly" at once — and they stay the right tool for that. A
 * folder answers the other question a long routine list provokes: "where does
 * this one live?" It is exclusive and navigable, so the sidebar can show a
 * shrinking tree instead of a flat list of eighty schedules.
 *
 * Company-scoped rather than employee-scoped on purpose. A routine belongs to
 * an AI employee, but the reason to file one under "Month-end close" has
 * nothing to do with who runs it — folders would be useless for exactly the
 * cross-employee grouping people reach for them to do.
 */
@Entity("routine_folders")
@Index(["companyId"])
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "parentId"])
export class RoutineFolder {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /**
   * Stable URL handle — the Routines list filters on `?folder=<slug>`. Unique
   * per company rather than per parent, so a rename never moves a bookmark and
   * a second "Weekly" under a different parent lands on `weekly-2`.
   */
  @Column({ type: "varchar" })
  slug!: string;

  /** Parent folder id for nesting. Null = top-level. */
  @Column({ type: "varchar", nullable: true })
  parentId!: string | null;

  /** Sort order among siblings under the same parent. Lower = earlier. */
  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
