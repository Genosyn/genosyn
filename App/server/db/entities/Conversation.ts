import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A persisted chat thread between a human and an AI employee. One employee
 * has many conversations; each conversation has many {@link ConversationMessage}
 * rows in chronological order.
 *
 * `title` is derived from the first user message on first send — NULL until
 * then so empty-and-abandoned conversations render as "New conversation".
 */
@Entity("conversations")
export class Conversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  /**
   * Set when a human archives the thread from the sidebar. Archived
   * conversations are hidden from the default list but kept intact so
   * they can be restored without data loss.
   */
  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
