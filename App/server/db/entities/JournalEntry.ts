import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Kinds of events that land in an employee's journal:
 *  - `run`: a Routine finished (one entry per terminal status — ok/failed/
 *    skipped/timeout). The `runId` and `routineId` point back at the source.
 *  - `note`: a free-form human note (from the Journal UI).
 *  - `system`: lifecycle beats — hired, model connected, model disconnected.
 *
 * We keep the taxonomy small on purpose. A journal is meant to be scanned
 * quickly; clever subcategories make it noisier, not clearer.
 */
export type JournalKind = "run" | "note" | "system";

@Entity("journal_entries")
export class JournalEntry {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  kind!: JournalKind;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  /** When kind === "run", the source Run's id. Null otherwise. */
  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  /** When kind === "run", the source Routine's id. Null otherwise. */
  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  /** For `note` entries, the user who wrote it. Null for run/system. */
  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
