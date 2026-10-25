import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { DataRoomJobKind, DataRoomJobStatus } from "../../../shared/dataRooms.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One piece of AI work waiting for, or done by, a data room's AI Employee:
 * brief a document, draft an answer, review readiness, read the activity.
 *
 * A row, not a timer, so a restart loses nothing and every replica can serve
 * the queue: a job is claimed with a conditional update from `queued` to
 * `running`, which exactly one process wins (`services/dataRooms/queue.ts`).
 * Results land on the row the job is about; this keeps only how it went.
 */
@Entity("data_room_jobs")
@Index(["status", "runAfter"])
@Index(["roomId", "kind", "targetId"])
@Index(["companyId"])
export class DataRoomJob {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  roomId!: string;

  @Column({ type: "varchar" })
  kind!: DataRoomJobKind;

  /** The document, question or room the job is about. */
  @Column({ type: "varchar" })
  targetId!: string;

  @Column({ type: "varchar", default: "queued" })
  status!: DataRoomJobStatus;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: dateTimeColumnType })
  runAfter!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  startedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "text", default: "" })
  error!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
