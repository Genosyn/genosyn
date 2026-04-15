import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type RunStatus = "running" | "completed" | "failed" | "skipped";

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

  @CreateDateColumn()
  createdAt!: Date;
}
