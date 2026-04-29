import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type HandoffStatus =
  | "pending"
  | "completed"
  | "declined"
  | "cancelled";

/**
 * A Handoff is one AI Employee delegating a piece of work to another. It
 * survives across chat turns and routine runs — the receiver can read its
 * inbox at the start of any spawn and act, instead of relying on a real-
 * time DM that might be missed.
 *
 * Status workflow:
 *
 *     pending ──complete──▶ completed
 *           ╲──decline───▶ declined
 *           ╲──cancel────▶ cancelled (sender retracts)
 *
 * `resolutionNote` carries the receiver's write-up when completed/declined,
 * or the sender's reason when cancelled. `dueAt` is an optional soft
 * deadline; nothing enforces it today, but the inbox UI sorts/highlights
 * by it.
 */
@Entity("handoffs")
@Index(["companyId", "status"])
@Index(["toEmployeeId", "status"])
@Index(["fromEmployeeId"])
export class Handoff {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Denormalized for company-scoped listings without a join. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  fromEmployeeId!: string;

  @Column({ type: "varchar" })
  toEmployeeId!: string;

  @Column({ type: "varchar" })
  title!: string;

  /** Markdown brief: what to do, context, links. */
  @Column({ type: "text", default: "" })
  body!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: HandoffStatus;

  /** Receiver's write-up on completion / decline reason / sender's cancel reason. */
  @Column({ type: "text", nullable: true })
  resolutionNote!: string | null;

  @Column({ type: "datetime", nullable: true })
  dueAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
