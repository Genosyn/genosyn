import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("routines")
@Index(["employeeId", "slug"], { unique: true })
export class Routine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  cronExpr!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: "datetime", nullable: true })
  lastRunAt!: Date | null;

  /**
   * Per-routine hard timeout in seconds. The runner SIGKILLs the CLI after
   * this long and marks the Run `timeout`. Default 10 min (`600`) covers
   * most substantive routines without letting a wedged process hold a
   * license / API quota indefinitely.
   */
  @Column({ type: "integer", default: 600 })
  timeoutSec!: number;

  /**
   * If true, cron ticks enqueue an {@link Approval} instead of running. A
   * human decides from the Approvals inbox. Manual "Run now" from the UI
   * still runs immediately — a human is already in the loop.
   */
  @Column({ type: "boolean", default: false })
  requiresApproval!: boolean;

  /**
   * Optional HTTP trigger. When enabled, external systems can POST to
   * `/api/webhooks/r/:routineId/:webhookToken` to fire this routine. The
   * token is the only secret; regenerate by toggling off and back on.
   */
  @Column({ type: "boolean", default: false })
  webhookEnabled!: boolean;

  @Column({ type: "varchar", nullable: true })
  webhookToken!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
