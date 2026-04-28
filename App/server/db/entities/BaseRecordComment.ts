import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A single message on a Base record's discussion thread. Authors are either a
 * human Member (`authorUserId`) or an AI Employee (`authorEmployeeId`) — exactly
 * one is set. Mirrors {@link TodoComment} so humans and AI employees share one
 * stream regardless of who's behind the keyboard.
 */
@Entity("base_record_comments")
export class BaseRecordComment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  recordId!: string;

  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  authorEmployeeId!: string | null;

  @Column({ type: "text", default: "" })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
