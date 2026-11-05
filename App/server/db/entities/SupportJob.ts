import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { SupportJobKind, SupportJobStatus } from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One piece of Support's background work: bring an email in, work a ticket, send
 * the one automatic email it may send. Rows rather than timers, so a restart
 * loses nothing and every replica can serve the queue; a job is claimed by a
 * conditional update from `queued` to `running`, which exactly one process wins.
 */
@Entity("support_jobs")
@Index(["status", "runAfter"])
@Index(["companyId", "kind", "targetId"])
@Index(["ticketId", "kind"])
export class SupportJob {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: SupportJobKind;

  /** What the job is about: a mail message, an inbox, a ticket or the company. */
  @Column({ type: "varchar" })
  targetId!: string;

  /** The ticket it touches, when it touches one, so the ticket can show how it went. */
  @Column({ type: "varchar", nullable: true })
  ticketId!: string | null;

  @Column({ type: "varchar", default: "queued" })
  status!: SupportJobStatus;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: dateTimeColumnType })
  runAfter!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  startedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  /** The Member who asked for it. Asking is what lets a held draft be asked for again. */
  @Column({ type: "varchar", nullable: true })
  requestedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "text", default: "" })
  error!: string;
}
