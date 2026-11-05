import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { TodoLinkKind } from "../../../shared/todoLinks.js";

/**
 * A Todo's link to another record in the company: the email thread it came
 * from, the Customer it is about, the Run that filed it. It reads both ways —
 * the Todo says where it came from, and the record lists the work it started.
 *
 * `targetId` is deliberately not a foreign key. Records live in many tables,
 * and a link must outlast its target: a thread can leave the mailbox mirror and
 * the Todo should still say which email it came from, which is why `label`
 * keeps a copy of the target's name as it was when linked. A link whose target
 * is gone is shown without anywhere to go.
 *
 * Whether someone may read the target is settled per reader, in
 * `services/todoLinks.ts`, on every read: a link grants nothing. The label is
 * hidden from a reader who could not open the record itself.
 *
 * At most one link on a Todo is its source (`isSource`). That is kept by
 * `services/todoLinks.ts` rather than an index, because a partial index on a
 * boolean is written differently on SQLite and Postgres.
 */
@Entity("todo_links")
@Index(["todoId", "kind", "targetId"], { unique: true })
// The way back: from a record to the Todos linked to it.
@Index(["companyId", "kind", "targetId"])
export class TodoLink {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  todoId!: string;

  @Column({ type: "varchar" })
  kind!: TodoLinkKind;

  @Column({ type: "varchar" })
  targetId!: string;

  @Column({ type: "boolean", default: false })
  isSource!: boolean;

  /** The target's name when it was linked. For an email, words a stranger chose. */
  @Column({ type: "varchar", default: "" })
  label!: string;

  /** The Member who linked it. Both creators are null when the server linked it itself. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  /** The AI Employee who linked it, or in whose turn the server linked it. */
  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
