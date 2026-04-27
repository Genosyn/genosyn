import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A Note is a Notion-style markdown page scoped to a Company. Both human
 * Members and AI Employees can read and write notes — the company-wide
 * shared knowledge surface, distinct from per-employee Journal entries
 * (one-line diary) and per-employee Memory items (durable injected facts).
 *
 * Notes form a hierarchy: each row optionally points at a `parentId` that
 * references another Note in the same company, mirroring Notion's nested
 * pages. `archivedAt` is a soft-delete timestamp so accidental deletes are
 * recoverable from the trash view.
 *
 * Author bookkeeping is split into two columns per side: `createdById`
 * holds the human User who created the note, `createdByEmployeeId` holds
 * the AI Employee. Exactly one is non-null. Same pattern for last edits.
 */
@Entity("notes")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "parentId"])
export class Note {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  /**
   * Optional emoji or short string shown next to the title in the sidebar.
   * Notion-style page icon — kept loosely-typed so emoji and short labels
   * both work without a separate enum.
   */
  @Column({ type: "varchar", default: "" })
  icon!: string;

  /** Parent Note id for nested pages. Null = top-level note. */
  @Column({ type: "varchar", nullable: true })
  parentId!: string | null;

  /** Sort order within siblings (parent or top-level). Lower = earlier. */
  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  lastEditedById!: string | null;

  @Column({ type: "varchar", nullable: true })
  lastEditedByEmployeeId!: string | null;

  /** Soft-delete marker. Non-null = note is in the trash. */
  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
