import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A Notebook is a top-level grouping for Notes inside a Company. Every Note
 * lives in exactly one Notebook — the notebook is the unit you'd put on a
 * shelf. Notebooks themselves do **not** nest; the hierarchy lives on the
 * Note tree (`Note.parentId`) inside a notebook.
 *
 * Each company is seeded with one "General" notebook on create / on the
 * Notebooks migration. The default notebook can be renamed but the company
 * always keeps at least one — deleting a notebook with notes inside is
 * rejected so we never orphan pages.
 */
@Entity("notebooks")
@Index(["companyId", "slug"], { unique: true })
export class Notebook {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Emoji or short string shown next to the notebook in the sidebar. */
  @Column({ type: "varchar", default: "" })
  icon!: string;

  /** Sort order among sibling notebooks in the same company. Lower = earlier. */
  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
