import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timeout";

@Entity("runs")
export class Run {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: "datetime" })
  startedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "varchar" })
  status!: RunStatus;

  @Column({ type: "varchar", nullable: true })
  logsPath!: string | null;

  /**
   * CLI exit code when the child closed under its own power. Null for runs
   * that never reached `close` — `skipped` (no CLI invoked) and `timeout`
   * (we SIGKILL'd it). `failed` runs typically have a non-zero code here.
   */
  @Column({ type: "integer", nullable: true })
  exitCode!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
