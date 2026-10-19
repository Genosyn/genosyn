import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A company-scoped folder for filing {@link Resource} rows — the Resources
 * library's files-and-folders tree. Folders nest, and a Resource lives in at
 * most one of them (`Resource.folderId`; null = unfiled).
 *
 * The same shape and rules as {@link RoutineFolder}, kept as its own table
 * because the two trees file different things for different people: a
 * Member organising the company's reading has nothing to do with how the
 * schedule is filed. Tags still group Resources across folders.
 */
@Entity("resource_folders")
@Index(["companyId"])
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "parentId"])
export class ResourceFolder {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /**
   * Stable URL handle — the Resources page opens a folder at `?folder=<slug>`.
   * Unique per company rather than per parent, so a rename or a move never
   * breaks a bookmark.
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
